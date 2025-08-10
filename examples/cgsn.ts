import { parseArgs } from 'node:util';
import { CGSN } from "../src/index.js";
import { openPort } from "./utils.js";

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
	console.log(`USAGE: csgn.js --port /dev/ttyUSB0`);
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

console.log(await cgsn.getMemoryRegions());

await cgsn.readMemory(0xA0000000, 1024, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});

await cgsn.writeMemory(0x82000, Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]));
console.log(await cgsn.readMemory(0x82000, 8));

await cgsn.disconnect();
await port.close();
