import { parseArgs } from 'node:util';
import { SerialPort } from "serialport";
import { AsyncSerialPort, ChaosLoader } from "../src/index.js";

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

if (argv.values.help || argv.values.usage) {
	console.log(`USAGE: chaos.js --port /dev/ttyUSB0 --boot ServiceMode`);
	process.exit(0);
}

const port = new AsyncSerialPort(new SerialPort({
	path: argv.values.port,
	baudRate: 115200,
	autoOpen: false
}));
await port.open();

const chaos = new ChaosLoader(port);
await chaos.connect();
await chaos.unlock();
await chaos.ping();
await chaos.setSpeed(1625000);
await chaos.ping();

/*
// test writing to ram
await chaos.writeMemory(0xA8000000, Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEE, 0xFF ]));
console.log(await chaos.readMemory(0xA8000000, 8));

// test reading from flash
console.log(await chaos.testMemory(0xA0000010, 8));
console.log(await chaos.readMemory(0xA0000010, 8));
*/

await chaos.disconnect();
await port.close();
