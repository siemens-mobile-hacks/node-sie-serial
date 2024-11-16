import { CGSN, portOpen } from "@sie-js/serial";
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

let port = await portOpen(new SerialPort({ path: argv.values.port, baudRate: 115200 }));
let cgsn = new CGSN(port);

if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudrate();

let response = await readMmuTable(cgsn);
decodeMMU(response.table);

await cgsn.disconnect();
cgsn.destroy();
port.close();

async function readMmuTable(cgsn) {
	// Read 1st level descriptors
	let response = await cgsn.readMemory(0x0008C000, 16 * 1024);
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
	for (let row of table) {
		if (row == null)
			continue;

		switch (row.type) {
			case 1:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain, row.AP));
			break;

			case 2:
				console.log(
					sprintf("%s   %08X -> %08X D[%X] AP[%X] %s%s",
					types[row.type], row.addr, row.phys, row.domain, row.AP, (row.C ? "C" : "-"), (row.B ? "B" : "-"))
				);
			break;

			case 3:
				console.log(sprintf("%s   %08X -> %08X D[%X] AP[%X]", types[row.type], row.addr, row.phys, row.domain, row.AP));
			break;
		}
	}
}
