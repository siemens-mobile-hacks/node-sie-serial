import { parseArgs } from 'node:util';
import { AsyncSerialPort, AtChannel } from "../src/index.js";
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
	console.log(`USAGE: atc.js --port /dev/ttyUSB0`);
	process.exit(0);
}

const port = new AsyncSerialPort(new SerialPort({
	path: argv.port,
	baudRate: 115200,
	autoOpen: false
}));
await port.open();

const atc = new AtChannel(port);
atc.start();

console.log(await atc.handshake());
console.log(await atc.sendCommandNumeric("AT+CGSN"));

atc.stop();
await port.close();
