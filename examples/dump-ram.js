import fs from 'fs';
import { CGSN, serialWaitForOpen } from "@sie-js/serial";
import { SerialPort } from 'serialport';
import { parseArgs } from 'node:util';
import { sprintf } from 'sprintf-js';

const { values: argv } = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyUSB0"
		},
		addr: {
			type: "string"
		},
		size: {
			type: "string"
		},
		out: {
			type: "string"
		},
		baudrate: {
			type: "string",
			default: "0"
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

let badParams = !argv.size || !argv.addr || !argv.out;
if (badParams || argv.help || argv.usage) {
	console.log(`USAGE: csgn.js --port /dev/ttyUSB0 --addr 0xA8000000 --size 0x1000000 --out /tmp/ram.bin`);
	process.exit(0);
}

let addr = parseInt(argv.addr, 16);
let size = parseInt(argv.size, 16);

console.log(sprintf("Addr: 0x%08X", addr));
console.log(sprintf("Size: 0x%08X (%d Mb)", size, size / 1024 / 1024));

if (isNaN(addr) || isNaN(size)) {
	console.log(`Invalid address or size.`);
	process.exit(1);
}

let port = await serialWaitForOpen(new SerialPort({ path: argv.port, baudRate: 115200 }));
let cgsn = new CGSN(port);

if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudrate(parseInt(argv.baudrate));

let result = await cgsn.readMemory(addr, size, {
	onProgress(cursor, total, elapsed) {
		let speed = cursor / (elapsed / 1000) || 0;
		let estimated = speed ? Math.round((total - cursor) / speed) : 0;
		console.log(`read: ${Math.round(cursor / total * 100)}% | ${Math.round(elapsed / 1000)} s | speed: ${Math.round(speed / 1024)} kB/s | estimated time: ${estimated}`);
	}
});

fs.writeFileSync(argv.out, result.buffer);

await cgsn.disconnect();
cgsn.destroy();
port.close();
