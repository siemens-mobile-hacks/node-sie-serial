import fs from 'fs';
import { parseArgs } from 'node:util';
import { sprintf } from 'sprintf-js';
import { CGSN } from "../src/index.js";
import { openPort } from "./utils.js";

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

const badParams = !argv.size || !argv.addr || !argv.out;
if (badParams || argv.help || argv.usage) {
	console.log(`USAGE: dump-ram.js --port /dev/ttyUSB0 --addr 0xA8000000 --size 0x1000000 --out /tmp/ram.bin`);
	process.exit(0);
}

const addr = parseInt(argv.addr!, 16);
const size = parseInt(argv.size!, 16);

console.log(sprintf("Addr: 0x%08X", addr));
console.log(sprintf("Size: 0x%08X (%d Mb)", size, size / 1024 / 1024));

if (isNaN(addr) || isNaN(size)) {
	console.log(`Invalid address or size.`);
	process.exit(1);
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

await cgsn.setBestBaudRate(parseInt(argv.baudrate));

const result = await cgsn.readMemory(addr, size, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});

if (result.success)
	fs.writeFileSync(argv.out!, result.buffer);

await cgsn.disconnect();
await port.close();
