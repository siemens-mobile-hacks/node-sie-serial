import { CGSN, AsyncSerialPort } from "@sie-js/serial";
import { SerialPortStream } from '@serialport/stream';
import { autoDetect as autoDetectSerialBinding } from "@sie-js/node-serialport-bindings-cpp";
import { parseArgs } from 'node:util';

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
	console.log(`USAGE: csgn.js --port /dev/ttyUSB0`);
	process.exit(0);
}

let port = new AsyncSerialPort(new SerialPortStream({
	path: argv.values.port,
	baudRate: 115200,
	autoOpen: false,
	binding: autoDetectSerialBinding()
}));
await port.open();
let cgsn = new CGSN(port);

if (await cgsn.connect()) {
	console.log('Connected to CGSN!');
} else {
	console.log('Phone not found...');
	process.exit(1);
}

await cgsn.setBestBaudrate();

await cgsn.readMemory(0xA0000000, 1024, {
	onProgress(cursor, total, elapsed) {
		let speed = cursor / (elapsed / 1000) || 0;
		let estimated = speed ? Math.round((total - cursor) / speed) : 0;
		console.log(`read: ${Math.round(cursor / total * 100)}% | ${Math.round(elapsed / 1000)} s | speed: ${Math.round(speed / 1024)} kB/s | estimated time: ${estimated}`);
	}
});

await cgsn.disconnect();
cgsn.destroy();
port.close();
