import { AtChannel, AsyncSerialPort } from "@sie-js/serial";
import { SerialPort } from 'serialport';
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
	console.log(`USAGE: atc.js --port /dev/ttyUSB0`);
	process.exit(0);
}

let port = new AsyncSerialPort(new SerialPort({ path: argv.values.port, baudRate: 115200, autoOpen: false }));
await port.open();
let atc = new AtChannel(port);
atc.start();

console.log(await atc.handshake());
console.log(await atc.sendCommandNumeric("AT+CGSN"));

atc.stop();
atc.destroy();
await port.close();
