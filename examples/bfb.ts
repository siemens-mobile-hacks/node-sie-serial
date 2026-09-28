import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { BFB, delay } from '@sie-js/serial';
import { openPort } from './utils.js';

const { values: argv } = parseArgs({
	options: {
		port: {
			type: 'string',
			default: '/dev/ttyUSB0',
		},
		help: {
			type: 'boolean',
			short: 'h',
			default: false,
		},
		usage: {
			type: 'boolean',
			default: false,
		},
	},
});

if (argv.help || argv.usage) {
	console.log('USAGE: bfb.js --port /dev/ttyUSB0');
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
const bfb = new BFB(port);

async function printValue(name: string, callback: () => Promise<unknown>): Promise<void> {
	try {
		console.log(name, await callback());
	} catch (error) {
		console.error(name, error instanceof Error ? error.message : error);
	}
}

port.on('error', (error) => console.error('Port error', error));
port.on('close', () => console.error('Port close'));

try {
	await port.open();
	console.log('Connecting...');
	await bfb.connect();
	await bfb.setBestBaudrate(0);
	console.log('BFB connected at', port.baudRate);
	await printValue('PING', () => bfb.ping());
	await printValue('DEBUGGER', () => bfb.getDebuggerName());
	await printValue('MODEL', () => bfb.getPhoneModel());
	await printValue('FW', () => bfb.getFirmwareVersion());
	await printValue('LANGUAGE', () => bfb.getLanguageGroup());
	await printValue('IMEI', () => bfb.getIMEI());
	await printValue('HWID', async () => (await bfb.getHardwareId()).toString(16).padStart(4, '0').toUpperCase());
	await printValue('ESN', async () => (await bfb.getFlashSerialNumber()).toString(16).padStart(8, '0').toUpperCase());
	await printValue('DISPLAY TYPE', () => bfb.getDisplayType());
	await printValue('DISPLAY SIZE', () => bfb.getDisplaySize());
	await printValue('DISPLAY BUFFER', async () => {
		const address = await bfb.getDisplayBufferAddress();
		return `0x${address.toString(16).padStart(8, '0').toUpperCase()}`;
	});
	await printValue('SCREENSHOT', async () => {
		const screenshot = await bfb.getDisplayBuffer();
		await writeFile('screen.data', screenshot.buffer);
		return {
			type: screenshot.type,
			width: screenshot.width,
			height: screenshot.height,
			bpp: screenshot.bpp,
			bytes: screenshot.buffer.length,
		};
	});
	await printValue('GPRS BLER', () => bfb.getGprsBlerCounters());
	await printValue('AFC', () => bfb.readAfc());
	await printValue('MOBILE MODE', () => bfb.getMobileMode());
	await printValue('BATTERY', () => bfb.getBatteryVoltage());
	await printValue('DSP FW', () => bfb.getDspFirmwareVersion());
	await printValue('POWER ASIC', () => bfb.getPowerAsicProject());
	await printValue('FLAGS', () => bfb.getFlagStatus());
	await printValue('SECURITY MODE', () => bfb.getSecurityModeName());
	await printValue('MEMORY REGIONS', () => bfb.getMemoryRegions());
	for (let selector = 0; selector <= 9; selector++)
		await printValue(`HARDWARE INFO ${selector}`, () => bfb.getHardwareInfo(selector));
	await printValue('EELITE MAX BLOCK', () => bfb.getEepMaxBlockId('eelite'));
	await printValue('EELITE SPACE', () => bfb.getEepSpaceInfo('eelite'));
	await printValue('EELITE BLOCK 1', async () => {
		const info = await bfb.getEepBlockInfo(1);
		const prefix = await bfb.readEepBlock(1, 0, Math.min(info.size, 16));
		return { ...info, bytesRead: prefix.length };
	});
	await printValue('EEFULL MAX BLOCK', () => bfb.getEepMaxBlockId('eefull'));
	await printValue('EEFULL SPACE', () => bfb.getEepSpaceInfo('eefull'));
	let displayRedirected = false;
	let keypadRedirected = false;
	try {
		await bfb.redirectDisplay((event) => console.log('DISPLAY EVENT', event));
		displayRedirected = true;
		await bfb.redirectKeypad((data) => console.log('KEYPAD EVENT', data.toString('hex')));
		keypadRedirected = true;
		console.log('Waiting 5 seconds for display and keypad events...');
		await delay(5000);
	} finally {
		try {
			if (keypadRedirected)
				await bfb.restoreKeypad();
		} finally {
			if (displayRedirected)
				await bfb.restoreDisplay();
		}
	}
} finally {
	await bfb.disconnect();
	await port.close();
}
