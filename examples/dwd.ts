import { DWD } from "../src/index.js";
import fs from "fs";
import { openPort } from "./utils.js";
import { parseArgs } from "node:util";
import { sprintf } from "sprintf-js";

const { values: argv } = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyACM0"
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
	console.log(`USAGE: dwd.js --port /dev/ttyACM0`);
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();

const dwd = new DWD(port);

/*
const possibleKeys = await dwd.bruteforceKey2({
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${speed.toFixed(2)} keys/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
const foundKeys: DWDKeys[] = [];
for (const key2 of possibleKeys) {
	console.log(sprintf("Bruteforce key1 for key2=%04X\n", key2));
	const keys = await dwd.bruteforceKey1(key2);
	if (keys != null)
		foundKeys.push(keys);
}
console.log(foundKeys);
*/

dwd.setKeys("auto");
await dwd.connect();

console.log(await dwd.getSWVersion());
type EBUMemoryRegion = {
	addr: number;
	size: number;
	name: string;
	descr: string;
};

console.log(await getMemoryRegions());

async function getMemoryRegions() {
	const memoryRegions: EBUMemoryRegion[] = [
		{
			name:	"BROM",
			addr:	0x00400000,
			size:	0x00008000,
			descr:	'Built-in 1st stage bootloader firmware.',
		}, {
			name:	"TCM",
			addr:	0xFFFF0000,
			size:	0x00004000,
			descr:	'Built-in memory in the CPU, used for IRQ handlers.',
		}, {
			name:	"SRAM",
			addr:	0x00080000,
			size:	0x00018000,
			descr:	'Built-in memory in the CPU.',
		}
	];
	for (let i = 0; i < 4; i++) {
		const ADDRSEL = (await dwd.readMemory(0xF0000080 + i * 8, 4)).buffer.readUInt32LE(0);

		const addr = (ADDRSEL & 0xFFFFF000) >>> 0;
		const mask = (ADDRSEL & 0x000000F0) >>> 4;
		const size = (1 << (27 - mask));
		const enabled = (ADDRSEL & 1) !== 0;

		if (enabled) {
			if (addr >= 0xA0000000 && addr < 0xB0000000) {
				memoryRegions.push({ addr, size, name: "FLASH", descr: "Flash memory." });
			} else if (addr >= 0xB0000000 && addr < 0xC0000000) {
				memoryRegions.push({ addr, size, name: "RAM", descr: "RAM memory." });
			}
		}
	}

	memoryRegions.sort((a, b) => a.addr - b.addr);

	const merged: EBUMemoryRegion[] = [];
	for (const region of memoryRegions) {
		const last = merged.at(-1);
		if (last && last.addr + last.size === region.addr && region.name == last.name) {
			last.size += region.size;
		} else {
			merged.push({ ...region });
		}
	}

	return merged;
}

/*
const abortController = new AbortController();

setTimeout(() => {
	abortController.abort();
}, 500);

const result = await dwd.readMemory(0x00000000, 96 * 1024, {
	signal: abortController.signal,
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});

console.log(result);

fs.writeFileSync("/tmp/sram.bin", result.buffer);
*/

await dwd.disconnect();

await port.close();
