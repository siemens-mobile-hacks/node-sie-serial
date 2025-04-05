import { parseArgs } from 'node:util';
import { sprintf } from "sprintf-js";
import { CGSN } from "../src/index.js";
import { openPort } from "./utils.js";

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

const { values: argv } = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyUSB0"
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
	console.log(`USAGE: csgn-print-mmu.js --port /dev/ttyUSB0`);
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();
const cgsn = new CGSN(port);

if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudRate();

const table = await readMmuTable(cgsn);
decodeMMU(table);

await cgsn.disconnect();
await port.close();

async function readMmuTable(cgsn: CGSN) {
	// Read 1st level descriptors
	const response = await cgsn.readMemory(0x0008C000, 16 * 1024);
	if (!response.success)
		throw new Error(response.error);

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

			const response = await cgsn.readMemory(row.phys, subTableSize);
			if (!response.success)
				throw new Error(response.error);

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
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain, row.AP));
			break;

			case 2:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X] %s%s",
					types[row.type], row.addr, row.phys, row.domain, row.AP, (row.C ? "C" : "-"), (row.B ? "B" : "-")));
			break;

			case 3:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain, row.AP));
			break;
		}
	}
}
