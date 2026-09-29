import { parseArgs } from 'node:util';
import { AtChannel, delay, type PPP } from '@sie-js/serial';
import { openPort } from './utils.js';

const { values: argv } = parseArgs({
	options: {
		port: {
			type: 'string',
			default: '/dev/ttyUSB0',
		},
		apn: {
			type: 'string',
			default: 'internet',
		},
		username: {
			type: 'string',
			default: '',
		},
		password: {
			type: 'string',
			default: '',
		},
		target: {
			type: 'string',
			default: '8.8.8.8',
		},
		dial: {
			type: 'string',
			default: 'ATDT*99***1#',
		},
		help: {
			type: 'boolean',
			short: 'h',
			default: false,
		},
	},
});

if (argv.help) {
	console.log('USAGE: ppp.ts [--port /dev/ttyUSB0] [--apn internet] [--username name] [--password secret] [--target 8.8.8.8] [--dial command]');
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();
const atc = new AtChannel(port);
atc.start();
let ppp: PPP | undefined;

try {
	if (!await atc.handshake())
		throw new Error('AT handshake failed.');

	const context = await atc.sendCommandNoResponse(`AT+CGDCONT=1,"IP","${argv.apn}"`);
	if (!context.success)
		throw new Error(`Unable to configure PDP context: ${context.status}`);

	console.log(`Dialing APN ${argv.apn}...`);
	ppp = await atc.connectPPP(argv.dial, 180000);
	const connection = await ppp.connect({
		username: argv.username,
		password: argv.password,
		timeout: 60000,
	});
	console.log('PPP connected:', connection);

	let replies = 0;
	for (let index = 0; index < 4; index++) {
		try {
			const result = await ppp.ping(argv.target, 10000);
			console.log(`${result.bytes} bytes from ${result.address}: time=${result.time} ms ttl=${result.ttl}`);
			replies++;
		} catch (error) {
			console.error(error instanceof Error ? error.message : error);
		}
		if (index < 3)
			await delay(1000);
	}
	if (replies == 0)
		throw new Error(`No ping replies received from ${argv.target}.`);
} finally {
	try {
		await ppp?.disconnect();
	} finally {
		atc.stop();
		if (port.isOpen)
			await port.close();
	}
}
