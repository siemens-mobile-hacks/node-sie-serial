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

console.log(sprintf("SCU_ID0=%08X", (await dwd.readMemory(0xF4400000 + 0x06C, 4)).buffer.readUInt32LE(0)));
console.log(sprintf("SCU_ID1=%08X", (await dwd.readMemory(0xF4400000 + 0x070, 4)).buffer.readUInt32LE(0)));
console.log(sprintf("SCU_BOOT_CFG=%08X", (await dwd.readMemory(0xF4400000 + 0x074, 4)).buffer.readUInt32LE(0)));
console.log(sprintf("SCU_MANID=%08X", (await dwd.readMemory(0xF4400000 + 0x05C, 4)).buffer.readUInt32LE(0)));
console.log(sprintf("SCU_CHIPID=%08X", (await dwd.readMemory(0xF4400000 + 0x060, 4)).buffer.readUInt32LE(0)));


// decodeMMU(await readMmuTable(dwd));

// await dwd.readMemory(0x00400000, 4);

/*
console.log(await dwd.getSWVersion());

for (let i = 0; i < 64; i++) {
	const r = await dwd.readMemory(0xF0000000 + i * 4, 4);

	console.log(sprintf("%08X %08X", 0xF0000000 + i * 4, r.buffer.readUInt32LE(0)));
}
console.log(await dwd.getMemoryRegions());
*/
/*
const abortController = new AbortController();

setTimeout(() => {
//	abortController.abort();
}, 500);

const result = await dwd.readMemory(0xA0000000, 64 * 1024 * 1024, {
	signal: abortController.signal,
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});

console.log(result);

fs.writeFileSync("/tmp/ff.bin", result.buffer);
*/

await dwd.disconnect();

await port.close();

type MMUTableRow = {
	type: number;
	addr: number;
	size: number;
	phys: number;
	domain?: number;
	AP?: number;
	C?: boolean;
	B?: boolean;
	table?: MMUTableRow[];
};

async function readMmuTable(dwd: DWD) {
	// Read 1st level descriptors
	const response = await dwd.readMemory(16 * 1024 * 0, 16 * 1024);

	const mmuTable: MMUTableRow[] = [];
	for (let i = 0; i < 4096; i++) {
		const value = response.buffer.readUInt32LE(i * 4);
		const addr = i * 1024 * 1024;
		const size = 1024 * 1024;
		const type = value & 0b11;

		switch (type) {
			case 1: // Coarse
			{
				const phys = (value & 0xFFFFFC00) >>> 0;
				const domain = (value >>> 5) & 0b1111;
				const AP = (value >> 10) & 0b11;
				mmuTable[i] = { type, addr, size, phys, domain, AP };
			}
			break;

			case 2: // Section
			{
				const phys = (value & 0xFFF00000) >>> 0;
				const domain = (value >>> 5) & 0b1111;
				const C = (value & (1 << 3)) != 0;
				const B = (value & (1 << 2)) != 0;
				const AP = (value >> 10) & 0b11;
				mmuTable[i] = { type, addr, size, phys, domain, AP, C, B };
			}
			break;

			case 3: // Fine
			{
				const phys = (value & 0xFFFFF000) >>> 0;
				const domain = (value >>> 5) & 0b1111;
				mmuTable[i] = { type, addr, size, phys, domain };
			}
			break;
		}
	}

	// Read 2nd level descriptors
	for (const row of mmuTable) {
		if (row == null)
			continue;

		if (row.type == 1 || row.type == 3) {
			const subTableSize = (row.type == 3 ? 1024 * 4 : 256 * 4);
			const subTableCnt = subTableSize / 4;
			const subTableEntrySize = (1024 * 1024) / subTableCnt;

			const response = await dwd.readMemory(row.phys, subTableSize);

			const subTable: MMUTableRow[] = [];
			for (let i = 0; i < subTableCnt; i++) {
				const value = response.buffer.readUInt32LE(i * 4);
				const type = value & 0b11;
				const addr = row.addr + i * subTableEntrySize;

				switch (type) {
					case 1:
					{
						const phys = (value & 0xFFFF0000) >>> 0;
						const C = (value & (1 << 3)) != 0;
						const B = (value & (1 << 2)) != 0;
						const AP = (value >> 4) & 0xFF;
						subTable[i] = { addr, type, phys, C, B, AP, size: 64 * 1024 };
					}
					break;

					case 2:
					{
						const phys = (value & 0xFFFFF000) >>> 0;
						const C = (value & (1 << 3)) != 0;
						const B = (value & (1 << 2)) != 0;
						const AP = (value >> 4) & 0xFF;
						subTable[i] = { addr, type, phys, C, B, AP, size: 4 * 1024 };
					}
					break;

					case 3:
					{
						const phys = (value & 0xFFFFFC00) >>> 0;
						const C = (value & (1 << 3)) != 0;
						const B = (value & (1 << 2)) != 0;
						const AP = (value >> 4) & 0b11;
						subTable[i] = { addr, type, phys, C, B, AP, size: 4 * 1024 };
					}
					break;
				}
			}
			row.table = subTable;
		}
	}

	return mmuTable;
}

function decodeMMU(table: MMUTableRow[]) {
	const types: string[] = [
		'[Fault]  ',
		'[Coarse] ',
		'[Section]',
		'[Fine]   ',
	];
	for (const row of table) {
		if (row == null)
			continue;

		switch (row.type) {
			case 1:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain ?? 0, row.AP));
				break;

			case 2:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X] %s%s",
									types[row.type], row.addr, row.phys, row.domain ?? "", row.AP, (row.C ? "C" : "-"), (row.B ? "B" : "-")));
				break;

			case 3:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain ?? 0, row.AP));
				break;
		}

		if (row.table) {
			decodeMMU(row.table);
		}
	}
}
