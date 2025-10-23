import { parseArgs } from 'node:util';
import { CGSN } from "../src/index.js";
import { openPort } from "./utils.js";
import { sprintf } from 'sprintf-js';

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

const PLL_OSC = await cgsn.readMemory(0xF45000A0, 4);
const PLL_CON1 = await cgsn.readMemory(0xF45000A4, 4);
const PLL_CON2 = await cgsn.readMemory(0xF45000A8, 4);
const PLL_CON3 = await cgsn.readMemory(0xF45000AC, 4);

console.log(sprintf("PLL_OSC: %08X", PLL_OSC.buffer?.readUInt32LE(0)));
console.log(sprintf("PLL_CON1: %08X", PLL_CON1.buffer?.readUInt32LE(0)));
console.log(sprintf("PLL_CON2: %08X", PLL_CON2.buffer?.readUInt32LE(0)));
console.log(sprintf("PLL_CON3: %08X", PLL_CON3.buffer?.readUInt32LE(0)));

await cgsn.writeMemory(0x82000, Buffer.from([0xCA, 0xFE, 0xBA, 0xBE]));
console.log(await cgsn.readMemory(0x82000, 8));

await cgsn.disconnect();
await port.close();
