import fs from 'node:fs';
import { sprintf } from "sprintf-js";

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

const n = 0;
const table = readMmuTable(n * 16 * 1024, fs.readFileSync("/tmp/sram.bin"));
decodeMMU(table);

function readMmuTable(tableAddr: number, buffer: Buffer) {
	// Read 1st level descriptors
	const mmuTable: MMUTableRow[] = [];
	for (let i = 0; i < 4096; i++) {
		const value = buffer.readUInt32LE(tableAddr + i * 4);
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
			const subtableBuffer = buffer.subarray(row.phys, row.phys + subTableSize);

			const subTable: MMUTableRow[] = [];
			for (let i = 0; i < subTableCnt; i++) {
				const value = subtableBuffer.readUInt32LE(i * 4);
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
