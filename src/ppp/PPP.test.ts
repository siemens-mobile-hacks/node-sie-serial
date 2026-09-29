import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openPort } from '../../examples/utils.js';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { AtChannel, type AtCommandResponse } from '#src/at/AtChannel.js';
import { delay } from '#src/utils.js';
import { ICMP } from './ICMP.js';
import { PPP, PppProtocol, type PppConnectionInfo, type PppPingResult } from './PPP.js';
import { TCP } from './TCP.js';
import { UDP } from './UDP.js';

const PORT_PATH = process.env.PPP_PORT ?? '/dev/ttyUSB0';
const APN = process.env.PPP_APN ?? 'internet';
const USERNAME = process.env.PPP_USERNAME ?? '';
const PASSWORD = process.env.PPP_PASSWORD ?? '';
const TARGET = process.env.PPP_TARGET ?? '8.8.8.8';
const DNS_TARGET = process.env.PPP_DNS_TARGET ?? '8.8.8.8';
const TCP_TARGET = process.env.PPP_TCP_TARGET ?? '1.1.1.1';
const TCP_PORT = Number(process.env.PPP_TCP_PORT ?? 80);
const DIAL_COMMAND = process.env.PPP_DIAL ?? 'ATDT*99***1#';
const describeHardware = process.env.PPP_HARDWARE == '1' ? describe : describe.skip;

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

		const attachState = await atc.sendCommandNumericOrWithPrefix('AT+CGATT?', '+CGATT:');
		expect(attachState.success).toBe(true);
		originallyAttached = parseAttachState(attachState);
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

				const currentAttach = await atc.sendCommandNumericOrWithPrefix('AT+CGATT?', '+CGATT:');
				expect(currentAttach.success).toBe(true);
				if (parseAttachState(currentAttach))
					expect((await atc.sendCommandNoResponse('AT+CGATT=0', 120000)).success).toBe(true);
				const command = originalContext ?
					`AT+CGDCONT=${originalContext.substring(originalContext.indexOf(':') + 1).trim()}` :
					'AT+CGDCONT=1';
				expect((await atc.sendCommandNoResponse(command)).success).toBe(true);
				const contextAttach = await atc.sendCommandNumericOrWithPrefix('AT+CGATT?', '+CGATT:');
				expect(contextAttach.success).toBe(true);
				if (parseAttachState(contextAttach) != originallyAttached)
					expect((await atc.sendCommandNoResponse(`AT+CGATT=${originallyAttached ? 1 : 0}`, 120000)).success).toBe(true);

				expect(await waitForAttach(atc, originallyAttached, 120000)).toBe(true);
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
		let received = 0;
		const unsubscribe = ppp.onPacket((packet) => {
			if (packet.protocol == PppProtocol.IPV4)
				received++;
		});
		let result: PppPingResult;
		try {
			result = await ppp.ping(TARGET, 10000);
		} finally {
			unsubscribe();
		}
		expect(result.address).toBe(TARGET);
		expect(result.bytes).toBeGreaterThan(0);
		expect(result.time).toBeGreaterThanOrEqual(0);
		expect(received).toBeGreaterThan(0);
	}, 15000);

	test('sends and receives ICMP packets', async () => {
		if (!ppp)
			throw new Error('PPP was not initialized.');
		const result = await new ICMP(ppp).ping(TARGET, 10000);
		expect(result.address).toBe(TARGET);
	}, 15000);

	test('sends and receives UDP datagrams', async () => {
		if (!ppp)
			throw new Error('PPP was not initialized.');
		const udp = new UDP(ppp);
		const query = dnsQuery();
		let timer: NodeJS.Timeout | undefined;
		try {
			const response = new Promise<Buffer>((resolve, reject) => {
				timer = setTimeout(() => reject(new Error('UDP DNS response timed out.')), 10000);
				udp.onMessage((message) => {
					if (message.address == DNS_TARGET && message.port == 53 && message.data.length >= 2 && message.data.readUInt16BE(0) == query.readUInt16BE(0)) {
						clearTimeout(timer);
						resolve(message.data);
					}
				});
			});
			await udp.send(DNS_TARGET, 53, query);
			expect((await response).length).toBeGreaterThan(12);
		} finally {
			clearTimeout(timer);
			udp.close();
		}
	}, 15000);

	test('opens a TCP connection and exchanges data', async () => {
		if (!ppp)
			throw new Error('PPP was not initialized.');
		const tcp = new TCP(ppp);
		try {
			await tcp.connect(TCP_TARGET, TCP_PORT, 15000);
			let timer: NodeJS.Timeout | undefined;
			const response = new Promise<Buffer>((resolve, reject) => {
				const chunks: Buffer[] = [];
				timer = setTimeout(() => reject(new Error('TCP response timed out.')), 15000);
				tcp.onData((data) => {
					chunks.push(data);
					const response = Buffer.concat(chunks);
					if (response.includes('\r\n')) {
						clearTimeout(timer);
						resolve(response);
					}
				});
			});
			try {
				await tcp.send(Buffer.from('GET / HTTP/1.0\r\nHost: one.one.one.one\r\n\r\n'), 15000);
				expect((await response).toString()).toMatch(/^HTTP\/1\.[01] /);
			} finally {
				clearTimeout(timer);
			}
		} finally {
			await tcp.close();
		}
	}, 35000);
});

function dnsQuery(): Buffer {
	const id = Math.floor(Math.random() * 0x10000);
	return Buffer.from([
		id >> 8, id & 0xFF, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00,
		0x00, 0x00, 0x00, 0x00, 7, ...Buffer.from('example'), 3,
		...Buffer.from('com'), 0, 0, 1, 0, 1,
	]);
}

async function waitForAttach(atc: AtChannel, attached: boolean, timeout: number): Promise<boolean> {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		const response = await atc.sendCommandNumericOrWithPrefix('AT+CGATT?', '+CGATT:');
		if (!response.success)
			return false;
		if (parseAttachState(response) == attached)
			return true;
		await delay(500);
	}
	return false;
}

function parseAttachState(response: AtCommandResponse): boolean {
	const line = response.lines[0];
	const value = line?.startsWith('+CGATT:') ? line.substring(7).trim() : line;
	if (value != '0' && value != '1')
		throw new Error(`Invalid AT+CGATT? response: ${line ?? '<empty>'}`);
	return value == '1';
}
