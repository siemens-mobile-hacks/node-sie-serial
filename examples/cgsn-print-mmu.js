import { CGSN, serialWaitForOpen } from "@sie-js/serial";
import { SerialPort } from 'serialport';
import { parseArgs } from 'node:util';
import { sprintf } from "sprintf-js";

const argv = parseArgs({
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

let port = await serialWaitForOpen(new SerialPort({ path: argv.values.port, baudRate: 115200 }));
let cgsn = new CGSN(port);

if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudrate();
await getRamAndFlashSizes(cgsn);

let memories = {
	RAM:		[0xA8],
};

let response = await readMmuTable(cgsn);
for (let row of response.table) {
	if (row == null)
		continue;

	if (row.table) {
		let endAddr = row.addr;
		for (let subRow of row.table) {
			if (subRow != null)
				endAddr = subRow.addr + subRow.size;
		}
		console.log(sprintf("%08X %d", row.addr, endAddr - row.addr));
	} else {
		console.log(sprintf("%08X 1M", row.addr));
	}
}

await cgsn.disconnect();
cgsn.destroy();
port.close();

async function getRamAndFlashSizes(cgsn) {
	const EBU_BASE = 0xF0000000;
	const EBU_ADDRSEL = (n) => EBU_BASE + 0x80 + ((n) * 0x8);
	const EBU_ADDRSEL_BASE = 0xFFFFF000;
	const EBU_ADDRSEL_BASE_SHIFT = 12;

	const EBU_ADDRSEL_MASK = 0x000000F0;
	const EBU_ADDRSEL_MASK_SHIFT = 4;

	const EBU_ADDRSEL_ALTSEG = 0x00000F00;
	const EBU_ADDRSEL_ALTSEG_SHIFT = 8;

	const EBU_ADDRSEL_REGENAB = (1 << 0);
	const EBU_ADDRSEL_ALTENAB = (1 << 1);

	let regions = [];
	for (let i = 0; i < 7; i++) {
		let response = await cgsn.readMemory(EBU_ADDRSEL(i), 4);
		if (!response.success)
			return response;

		let value = response.buffer.readUInt32LE(0);

		let enabled = (value & EBU_ADDRSEL_REGENAB) != 0;
		let base = (value & EBU_ADDRSEL_BASE) >>> EBU_ADDRSEL_BASE_SHIFT;
		let mask = (value & EBU_ADDRSEL_MASK) >>> EBU_ADDRSEL_MASK_SHIFT;
		let addr = (base << 12) >>> 0;
		let size = (1 << (27 - mask)) >>> 0;

		if (enabled) {
			regions.push({ addr, size, name: sprintf("%08X", addr) });
		}
	}

	regions.sort((a, b) => a.addr - b.addr);

	let lastRegion;
	let newRegions = {};
	for (let r of regions) {
		if (lastRegion && (lastRegion.addr == r.addr)) {
			if (r.size > lastRegion.size)
				lastRegion.size = r.size;
		} else if (!lastRegion || (lastRegion.addr + lastRegion.size) != r.addr) {
			lastRegion = { ...r };

			let name = sprintf("UNK_%08X", r.addr);
			if (r.addr == 0xA0000000)
				name = 'FLASH';
			if (r.addr == 0xA8000000)
				name = 'RAM';

			newRegions[name] = lastRegion;
		} else {
			lastRegion.size += r.size;
		}
	}

	return newRegions;
}

async function readMmuTable(cgsn) {
	// Read 1st level descriptors
	let response = await cgsn.readMemory(0x00080000 + (16 * 1024*4), 16 * 1024);
	if (!response.success)
		return response;

	let mmuTable = [];
	for (let i = 0; i < 4096; i++) {
		let value = response.buffer.readUInt32LE(i * 4);
		let addr = i * 1024 * 1024;
		let size = 1024 * 1024;
		let type = value & 0b11;

		switch (type) {
			case 1: // Coarse
			{
				let phys = (value & 0xFFFFFC00) >>> 0;
				let domain = (value >>> 5) & 0b1111;
				let AP = (value >> 10) & 0b11;
				mmuTable[i] = { type, addr, size, phys, domain, AP };
			}
			break;

			case 2: // Section
			{
				let phys = (value & 0xFFF00000) >>> 0;
				let domain = (value >>> 5) & 0b1111;
				let C = value & (1 << 3) != 0;
				let B = value & (1 << 2) != 0;
				let AP = (value >> 10) & 0b11;
				mmuTable[i] = { type, addr, size, phys, domain, AP, C, B };
			}
			break;

			case 3: // Fine
			{
				let phys = (value & 0xFFFFF000) >>> 0;
				let domain = (value >>> 5) & 0b1111;
				mmuTable[i] = { type, addr, size, phys, domain };
			}
			break;
		}
	}

	// Read 2nd level descriptors
	for (let row of mmuTable) {
		if (row == null)
			continue;

		if (row.type == 1 || row.type == 3) {
			let subTableSize = (row.type == 3 ? 1024 * 4 : 256 * 4);
			let subTableCnt = subTableSize / 4;
			let subTableEntrySize = (1024 * 1024) / subTableCnt;

			response = await cgsn.readMemory(row.phys, subTableSize);
			if (!response.success)
				return response;

			let subTable = [];
			for (let i = 0; i < subTableCnt; i++) {
				let value = response.buffer.readUInt32LE(i * 4);
				let type = value & 0b11;
				let addr = row.addr + i * subTableEntrySize;

				switch (type) {
					case 1:
					{
						let phys = (value & 0xFFFF0000) >>> 0;
						let C = value & (1 << 3) != 0;
						let B = value & (1 << 2) != 0;
						let AP = (value >> 4) & 0xFF;
						subTable[i] = { addr, type, phys, C, B, AP, size: 64 * 1024 };
					}
					break;

					case 2:
					{
						let phys = (value & 0xFFFFF000) >>> 0;
						let C = value & (1 << 3) != 0;
						let B = value & (1 << 2) != 0;
						let AP = (value >> 4) & 0xFF;
						subTable[i] = { addr, type, phys, C, B, AP, size: 4 * 1024 };
					}
					break;

					case 3:
					{
						let phys = (value & 0xFFFFFC00) >>> 0;
						let C = value & (1 << 3) != 0;
						let B = value & (1 << 2) != 0;
						let AP = (value >> 4) & 0b11;
						subTable[i] = { addr, type, phys, C, B, AP, size: 4 * 1024 };
					}
					break;
				}
			}
			row.table = subTable;
		}
	}

	return { success: true, table: mmuTable };
}

function decodeMMU(table) {
	let types = [
		'[Fault]  ',
		'[Coarse] ',
		'[Section]',
		'[Fine]   ',
	];
	for (let i = 0; i < 4096; i++) {
		let value = table.readUInt32LE(i * 4);
		let addr = i * 1024 * 1024;
		let type = value & 0b11;

		if (type == 0)
			continue;

		switch (type) {
			case 2:
			{
				let physAddr = value & 0xFFF00000;
				let domain = (value >>> 5) & 0b1111;
				let C = value & (1 << 3);
				let B = value & (1 << 2);
				let AP = (value >> 10) & 0b11;
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X] %s%s", types[type], addr, physAddr, domain, AP, (C ? "C" : "-"), (B ? "B" : "-")));
			}
			break;
			case 1:
			{
				let physAddr = value & 0xFFFFFF00;
				let domain = (value >>> 5) & 0b1111;
				let AP = (value >> 10) & 0b11;
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[type], addr, physAddr, domain, AP));
			}
			break;
		}
	}
}
