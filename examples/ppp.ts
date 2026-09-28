import { parseArgs } from 'node:util';
import { AtChannel, delay, PPP, type AtCommandResponse } from '@sie-js/serial';
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
let atc: AtChannel | undefined;
let ppp: PPP | undefined;
let originalContext: string | undefined;
let contextChanged = false;
let originallyAttached = false;

try {
	await port.open();
	atc = new AtChannel(port);
	atc.start();
	if (!await atc.handshake())
		throw new Error('AT handshake failed.');

	const attachState = await atc.sendCommand('AT+CGATT?', '+CGATT:');
	requireSuccess(attachState, 'AT+CGATT?');
	originallyAttached = attachState.lines[0]?.match(/\+CGATT:\s*1/) != undefined;
	const contexts = await atc.sendCommand('AT+CGDCONT?', '+CGDCONT:');
	requireSuccess(contexts, 'AT+CGDCONT?');
	originalContext = contexts.lines.find((line) => line.match(/^\+CGDCONT:\s*1,/));
	const context = await atc.sendCommandNoResponse(`AT+CGDCONT=1,"IP","${argv.apn}"`);
	if (!context.success)
		throw new Error(`Unable to configure PDP context: ${context.status}`);
	contextChanged = true;

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
		if (ppp) {
			try {
				await ppp.disconnect();
			} catch {
				ppp.stop();
			}
		}

		if (port.isOpen && contextChanged && atc) {
			const commandModeReady = ppp ?
				await atc.exitDataMode() && await atc.handshake(10) :
				await atc.handshake(10);
			if (!commandModeReady)
				throw new Error('Unable to return the modem to AT command mode.');

			if (!originallyAttached)
				requireSuccess(await atc.sendCommandNoResponse('AT+CGATT=0', 120000), 'AT+CGATT=0');
			const command = originalContext ?
				`AT+CGDCONT=${originalContext.substring(originalContext.indexOf(':') + 1).trim()}` :
				'AT+CGDCONT=1';
			requireSuccess(await atc.sendCommandNoResponse(command), command);
			if (originallyAttached)
				requireSuccess(await atc.sendCommandNoResponse('AT+CGATT=1', 120000), 'AT+CGATT=1');

			const restoredAttach = await atc.sendCommand('AT+CGATT?', '+CGATT:');
			requireSuccess(restoredAttach, 'AT+CGATT?');
			if ((restoredAttach.lines[0]?.match(/\+CGATT:\s*1/) != undefined) != originallyAttached)
				throw new Error('Unable to restore the original GPRS attach state.');
			const restoredContexts = await atc.sendCommand('AT+CGDCONT?', '+CGDCONT:');
			requireSuccess(restoredContexts, 'AT+CGDCONT?');
			const restoredContext = restoredContexts.lines.find((line) => line.match(/^\+CGDCONT:\s*1,/));
			if (restoredContext != originalContext)
				throw new Error('Unable to restore the original PDP context.');
		}
	} finally {
		atc?.stop();
		if (port.isOpen)
			await port.close();
	}
}

function requireSuccess(response: AtCommandResponse, command: string) {
	if (!response.success)
		throw new Error(`${command} failed: ${response.status}`);
}
