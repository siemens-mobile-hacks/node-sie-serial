import { parseArgs } from 'node:util';
import { AsyncSerialPort, CGSN } from "../src/index.js";
import { SerialPort } from "serialport";

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

const port = new AsyncSerialPort(new SerialPort({
	path: argv.port,
	baudRate: 115200,
	autoOpen: false
}));
await port.open();

const cgsn = new CGSN(port);
if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudRate();

await cgsn.readMemory(0xA0000000, 1024, {
	onProgress: (cursor, total, elapsed) => {
		const speed = cursor / (elapsed / 1000) || 0;
		const estimated = speed ? Math.round((total - cursor) / speed) : 0;
		console.log(`read: ${Math.round(cursor / total * 100)}% | ${Math.round(elapsed / 1000)} s | speed: ${Math.round(speed / 1024)} kB/s | estimated time: ${estimated}`);
	}
});

await cgsn.disconnect();
await port.close();
