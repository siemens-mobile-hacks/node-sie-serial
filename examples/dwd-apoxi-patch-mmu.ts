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
await loadPatch(dwd, fs.readFileSync("/home/azq2/dev/sie/pmb887x-emu/bsp/examples/apoxi_patch_mmu/build/app.elf"));
await port.close();

async function loadPatch(dwd: DWD, patchElf: Buffer, minRamBlockSize: number = 256 * 1024) {
	const addrsel = (await dwd.readMemory(EBU_ADDRSEL1, 4)).buffer.readUInt32LE(0);
	const ramSize = (1 << (27 - ((addrsel & 0xF0) >> 4)));
	const ramAddr = Number((BigInt(addrsel) & 0xFFFF0000n));

	const { loadELF } = await import("@sie-js/creampie");

	const bootMode = (await dwd.readMemory(BOOT_MODE, 4)).buffer.readUInt32LE(0);
	console.log(sprintf("Boot mode: %08X", bootMode));

	console.log(sprintf("RAM: %08X, %d MB", ramAddr, ramSize / 1024 / 1024));
	console.log("Searching for an empty RAM block... (this may take a while)");

	let emptyRamBlock = 0;
	for (let i = ramAddr; i < ramAddr + ramSize; i += minRamBlockSize) {
		if ((i % (1024 * 1024)) == 0)
			console.log(sprintf("RAM scan progress: %d MB / %d MB", (i - ramAddr) / 1024 / 1024, ramSize / 1024 / 1024));

		const blockStart = await dwd.readMemory(i, 230);
		if (blockStart.buffer.every((v) => v == 0)) {
			const fullBlock = await dwd.readMemory(i, minRamBlockSize);
			if (fullBlock.buffer.every((v) => v == 0)) {
				emptyRamBlock = i;
				break;
			}
		}
	}

	if (!emptyRamBlock)
		throw new Error("Empty RAM block not found!");

	console.log(sprintf("Found empty RAM block: %08X", emptyRamBlock));

	const elf = loadELF(emptyRamBlock, patchElf);
	for (let i = 0; i < 30; i++) {
		await dwd.writeMemory(emptyRamBlock, elf.image);
		const check = await dwd.readMemory(emptyRamBlock, elf.image.length);
		if (check.buffer.toString("hex") != elf.image.toString("hex")) {
			console.log(check.buffer.toString("hex"));
			console.log(elf.image.toString("hex"));
			throw new Error("Payload is corrupted.");
		}

		console.log(sprintf("Patcher entry: %08X", elf.entry));

		const PATCHER_ADDR = elf.entry;
		const PARAM_OLD_IRQ_HANDLER = PATCHER_ADDR + 4;
		const PARAM_RESPONSE_CODE = PATCHER_ADDR + 8;
		const PARAM_RESPONSE_FLASH_ID = PATCHER_ADDR + 12;

		const oldIrqHandler = (await dwd.readMemory(PRAM_IRQ_HANDLER, 4)).buffer.readUInt32LE(0);
		console.log(sprintf("Old SWI handler: %08X", oldIrqHandler))

		await dwd.writeMemory(PARAM_OLD_IRQ_HANDLER, uint32(oldIrqHandler));

		console.log("Running patcher...");
		try {
			await dwd.writeMemory(PRAM_IRQ_HANDLER, uint32(PATCHER_ADDR));
		} catch (e) {
			// fail is ok
		}

		console.log("Waiting 5 seconds to complete...");
		await new Promise((resolve) => setTimeout(resolve, 5000));

		// Flush
		await dwd.getSerialPort()?.read(1024, 100);

		try {
			const responseCode = (await dwd.readMemory(PARAM_RESPONSE_CODE, 4)).buffer.readInt32LE(0);
			const responseFlashId = (await dwd.readMemory(PARAM_RESPONSE_FLASH_ID, 4)).buffer.readUInt32LE(0);

			console.log(sprintf("Code: %d (%s)", responseCode, PatchResponseCode[responseCode]));
			console.log(sprintf("Flash ID: %08X", responseFlashId));

			if (responseCode == PatchResponseCode.SUCCESS) {
				console.log("Success. Boot mode patched. Please reboot the phone.");
			} else if (responseCode == PatchResponseCode.BOOT_ALREADY_OPEN) {
				console.log("Boot is already open. Unlock is not needed.");
			} else {
				console.log("Unlocking failed!");
			}

			console.log("Clearing RAM block...");
			await dwd.writeMemory(emptyRamBlock, Buffer.alloc(minRamBlockSize).fill(0));

			if (!(responseCode == PatchResponseCode.FLASH_NOT_FOUND || responseCode == PatchResponseCode.FLASH_BUSY))
				break;

			console.log("Retrying...");
		} catch (e) {
			console.log(String(e));
			console.log("An error occurred while waiting for a response from the unlocker. Please remove and reinstall the battery, then try again.");
			break;
		}
	}
}

function uint32(value: number) {
	const buffer = Buffer.alloc(4);
	buffer.writeUInt32LE(value);
	return buffer;
}
