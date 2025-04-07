import { DWD } from "../src/index.js";
import fs from "fs";
import { openPort } from "./utils.js";
import { parseArgs } from "node:util";
import { sprintf } from "sprintf-js";
import { retryAsyncOnError } from "../src/utils.js";
import { loadELF } from "@sie-js/creampie";

const TCM_START = 0xFFFF0000;
const PRAM_IRQ_HANDLER = TCM_START + 0x38;
const BOOT_MODE = 0xA000000C;

const EBU_ADDRSEL1 = 0xF0000088;

enum PatchResponseCode {
	SUCCESS = 0,
	BOOT_ALREADY_OPEN = -1,
	UNKNOWN_FLASH = -2,
	FLASH_BUSY = -3,
	ERASE_ERROR = -4,
	PROGRAM_ERROR = -5,
	ADDR_NOT_ALIGNED = -6,
	FLASH_REGION_NOT_FOUND = -7,
	FLASH_REGION_TOO_BIG = -8,
	INVALID_FLASH_REGIONS = -9,
	INVALID_FLASH_REGION_COUNT = -10,
	UNSUPPORTED_FLASH = -11,
	FLASH_NOT_FOUND = -12,
	UNKNOWN = -13
}

const { values: argv } = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyACM0"
		},
		key: {
			type: "string",
			default: "panasonic"
		},
		help: {
			type: "boolean",
			short: "h",
			default: false
		},
		usage: {
			type: "boolean",
			default: false
		}
	}
});

if (argv.help || argv.usage) {
	console.log(`USAGE: dwd-apoxi-unlock-boot.js --port /dev/ttyACM0`);
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();

const dwd = new DWD(port);

dwd.setKeys(argv.key);
await dwd.connect();

const addrsel = (await dwd.readMemory(EBU_ADDRSEL1, 4)).buffer.readUInt32LE(0);
const ramSize = (1 << (27 - ((addrsel & 0xF0) >> 4)));
const ramAddr = Number((BigInt(addrsel) & 0xFFFF0000n));

console.log(sprintf("Ram: %08X, %dM", ramAddr, ramSize / 1024 / 1024));
console.log("Searching empty ram block....");

let emptyRamBlock = 0;

for (let i = ramAddr; i < ramAddr + ramSize; i += 256 * 1024) {
	const blockStart = await dwd.readMemory(i, 230);
	if (blockStart.buffer.every((v) => v == 0)) {
		const fullBlock = await dwd.readMemory(i, 256 * 1024);
		if (fullBlock.buffer.every((v) => v == 0)) {
			emptyRamBlock = i;
			break;
		}
	}
}

if (!emptyRamBlock) {
	console.log("Empty RAM block not found!");
	process.exit(1);
}

console.log(sprintf("Found empty ram block: %08X", emptyRamBlock));

const bootMode = (await dwd.readMemory(BOOT_MODE, 4)).buffer.readUInt32LE(0);
console.log(sprintf("Boot mode: %08X", bootMode));

if (bootMode == 0xFFFFFFFF) {
	console.log("Phone already patched!");
	process.exit(1);
}

const oldIrqHandler = (await dwd.readMemory(PRAM_IRQ_HANDLER, 4)).buffer.readUInt32LE(0);
console.log(sprintf("Old SWI handler: %08X", oldIrqHandler))

const elf = loadELF(emptyRamBlock, fs.readFileSync(import.meta.dirname + "/data/apoxi-unlock.elf"));
await dwd.writeMemory(emptyRamBlock, elf.image);
const check = await dwd.readMemory(emptyRamBlock, elf.image.length);
if (check.buffer.toString("hex") != elf.image.toString("hex")) {
	console.log(check.buffer.toString("hex"));
	console.log(elf.image.toString("hex"));
	throw new Error("Payload corrupted!!!");
}

console.log(sprintf("Patcher entry: %08X", elf.entry));

const PATCHER_ADDR = elf.entry;
const PARAM_OLD_IRQ_HANDLER = PATCHER_ADDR + 4;
const PARAM_RESPONSE_CODE = PATCHER_ADDR + 8;
const PARAM_RESPONSE_FLASH_ID = PATCHER_ADDR + 12;

await dwd.writeMemory(PARAM_OLD_IRQ_HANDLER, uint32(oldIrqHandler));
await dwd.writeMemory(PRAM_IRQ_HANDLER, uint32(PATCHER_ADDR));

await retryAsyncOnError(async () => {
	console.log("Waiting for done...");

	const responseCode = (await dwd.readMemory(PARAM_RESPONSE_CODE, 4)).buffer.readInt32LE(0);
	const responseFlashId = (await dwd.readMemory(PARAM_RESPONSE_FLASH_ID, 4)).buffer.readUInt32LE(0);

	console.log(sprintf("Code: %d (%s)", responseCode, PatchResponseCode[responseCode]));
	console.log(sprintf("FlashID: %08X", responseFlashId));

	if (responseCode == 0) {
		console.log("Boot patched, now reboot phone.");
	}

	await new Promise((resolve) => setTimeout(resolve, 1000));
}, { max: 30 });

await port.close();

function uint32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value);
	return buffer;
}
