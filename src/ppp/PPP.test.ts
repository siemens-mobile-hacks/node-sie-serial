import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openPort } from '../../examples/utils.js';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { AtChannel } from '#src/at/AtChannel.js';
import { PPP, type PppConnectionInfo } from './PPP.js';

const PORT_PATH = process.env.PPP_PORT ?? '/dev/ttyUSB0';
const APN = process.env.PPP_APN ?? 'internet';
const USERNAME = process.env.PPP_USERNAME ?? '';
const PASSWORD = process.env.PPP_PASSWORD ?? '';
const TARGET = process.env.PPP_TARGET ?? '8.8.8.8';
const DIAL_COMMAND = process.env.PPP_DIAL ?? 'ATDT*99***1#';
const describeHardware = process.env.PPP_HARDWARE == '1' ? describe.sequential : describe.skip;

describeHardware('PPP hardware', () => {
	let port: AsyncSerialPort;
	let atc: AtChannel;
	let ppp: PPP | undefined;
	let connection: PppConnectionInfo;
	let originalContext: string | undefined;
	let contextChanged = false;
	let originallyAttached = false;

	beforeAll(async () => {
		port = await openPort(PORT_PATH, 115200);
		await port.open();
		atc = new AtChannel(port);
		atc.start();
		expect(await atc.handshake()).toBe(true);

		const attachState = await atc.sendCommand('AT+CGATT?', '+CGATT:');
		expect(attachState.success).toBe(true);
		originallyAttached = attachState.lines[0]?.match(/\+CGATT:\s*1/) != undefined;
		const contexts = await atc.sendCommand('AT+CGDCONT?', '+CGDCONT:');
		expect(contexts.success).toBe(true);
		originalContext = contexts.lines.find((line) => line.match(/^\+CGDCONT:\s*1,/));
		const response = await atc.sendCommandNoResponse(`AT+CGDCONT=1,"IP","${APN}"`);
		expect(response.success).toBe(true);
		contextChanged = true;

		ppp = await atc.connectPPP(DIAL_COMMAND, 180000);
		connection = await ppp.connect({ username: USERNAME, password: PASSWORD, timeout: 60000 });
	}, 310000);

	afterAll(async () => {
		try {
			if (ppp) {
				try {
					await ppp.disconnect();
				} catch {
					ppp.stop();
				}
			}

			if (port?.isOpen && contextChanged) {
				const commandModeReady = ppp ?
					await atc.exitDataMode() && await atc.handshake(10) :
					await atc.handshake(10);
				expect(commandModeReady).toBe(true);

				if (!originallyAttached)
					expect((await atc.sendCommandNoResponse('AT+CGATT=0', 120000)).success).toBe(true);
				const command = originalContext ?
					`AT+CGDCONT=${originalContext.substring(originalContext.indexOf(':') + 1).trim()}` :
					'AT+CGDCONT=1';
				expect((await atc.sendCommandNoResponse(command)).success).toBe(true);
				if (originallyAttached)
					expect((await atc.sendCommandNoResponse('AT+CGATT=1', 120000)).success).toBe(true);

				const restoredAttach = await atc.sendCommand('AT+CGATT?', '+CGATT:');
				expect(restoredAttach.success).toBe(true);
				expect(restoredAttach.lines[0]?.match(/\+CGATT:\s*1/) != undefined).toBe(originallyAttached);
				const restoredContexts = await atc.sendCommand('AT+CGDCONT?', '+CGDCONT:');
				expect(restoredContexts.success).toBe(true);
				expect(restoredContexts.lines.find((line) => line.match(/^\+CGDCONT:\s*1,/))).toBe(originalContext);
			}
		} finally {
			atc?.stop();
			if (port?.isOpen)
				await port.close();
		}
	}, 150000);

	test('negotiates IPv4 and pings the target', async () => {
		expect(connection.localAddress).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
		if (!ppp)
			throw new Error('PPP was not initialized.');
		const result = await ppp.ping(TARGET, 10000);
		expect(result.address).toBe(TARGET);
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.time).toBeGreaterThanOrEqual(0);
	}, 15000);
});
