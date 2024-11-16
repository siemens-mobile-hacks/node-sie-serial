import { BFC, BFC_HWI, BFC_SWI, AsyncSerialPort } from "@sie-js/serial";
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
	console.log(`USAGE: bfc.js --port /dev/ttyUSB0`);
	process.exit(0);
}

let port = new AsyncSerialPort(new SerialPortStream({
	path: argv.values.port,
	baudRate: 115200,
	autoOpen: false,
	binding: autoDetectSerialBinding()
}));
await port.open();
let bus = new BFC(port);

port.on('error', (err) => console.error('Port error', err));
port.on('close', () => console.error('Port close'));

console.log('Connecting...');
await bus.connect();
await bus.setBestBaudrate();

console.log('BASEBAND', await bus.getBaseband());
console.log('VENDOR', await bus.getVendorName());
console.log('PRODUCT', await bus.getProductName());
console.log('SW VERSION', await bus.getSwVersion());
console.log('LANGUAGE', await bus.getLanguageGroup());
console.log('IMEI', await bus.getIMEI());

for (let k in BFC_HWI) {
	console.log('[HwInfo]', k, await bus.getHwInfo(BFC_HWI[k]));
}

for (let k in BFC_SWI) {
	console.log('[SwInfo]', k, await bus.getSwInfo(BFC_SWI[k]));
}

let displaysCnt = await bus.getDisplayCount();
console.log(`Total displays: ${displaysCnt}`);

for (let i = 1; i <= displaysCnt; i++) {
	let info = await bus.getDisplayInfo(i);
	console.log(info);

	let bufferInfo = await bus.getDisplayBufferInfo(info.clientId);
	console.log(bufferInfo);
}

await bus.disconnect();
bus.destroy();
port.close();
