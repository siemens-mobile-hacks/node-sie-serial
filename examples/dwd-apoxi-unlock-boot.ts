import { DWD } from "../src/index.js";
import fs from "fs";
import { openPort } from "./utils.js";
import { parseArgs } from "node:util";
import { sprintf } from "sprintf-js";

const PATCHER_ADDR = 0xB0FC0000;
const TCM_START = 0xFFFF0000;
const PATCHER_END = PATCHER_ADDR + 1024 * 2;

const PRAM_IRQ_HANDLER = TCM_START + 0x38;
const PARAM_OLD_IRQ_HANDLER = PATCHER_END - 4;
const PARAM_RESPONSE_CODE = PATCHER_END - 8;
const PARAM_RESPONSE_FLASH_ID = PATCHER_END - 12;
const BOOT_MODE = 0xA000000C;

const EBU_ADDRSEL1 = 0xF0000088;

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

if (ramAddr != 0xB0000000 && ramSize < 16 * 1024 * 1024)
	throw new Error("Ram addr or size is not supported.\n");

const bootMode = (await dwd.readMemory(BOOT_MODE, 4)).buffer.readUInt32LE(0);
console.log(sprintf("Boot mode: %08X", bootMode));

if (bootMode == 0xFFFFFFFF) {
	console.log("Phone already patched!");
	process.exit(0);
}

const oldIrqHandler = (await dwd.readMemory(PRAM_IRQ_HANDLER, 4)).buffer.readUInt32LE(0);
console.log(sprintf("Old SWI handler: %08X", oldIrqHandler))

const code = fs.readFileSync(import.meta.dirname + "/data/apoxi-unlock.bin");
await dwd.writeMemory(PATCHER_ADDR, code);
await dwd.writeMemory(PARAM_OLD_IRQ_HANDLER, uint32(oldIrqHandler));

const check = await dwd.readMemory(PATCHER_ADDR, code.length);
if (check.buffer.toString("hex") != code.toString("hex")) {
	console.log(check.buffer.toString("hex"));
	console.log(code.toString("hex"));
	throw new Error("Payload corrupted!!!");
}

await dwd.writeMemory(PRAM_IRQ_HANDLER, uint32(PATCHER_ADDR));

const responseCode = (await dwd.readMemory(PARAM_RESPONSE_CODE, 4)).buffer.readUInt32LE(0);
const responseFlashId = (await dwd.readMemory(PARAM_RESPONSE_FLASH_ID, 4)).buffer.readUInt32LE(0);

console.log(sprintf("Code: %08X (%s)", responseCode, responseCode == 0 ? "SUCCESS" : "ERROR"));
console.log(sprintf("FlashID: %08X", responseFlashId));

if (responseCode == 0) {
	console.log("Boot patched, now reboot phone.");
}

await port.close();

function uint32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value);
	return buffer;
}
