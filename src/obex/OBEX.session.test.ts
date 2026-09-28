// OBEX sessions against the fake phone of the phone database (tests/obex/phones),
// set up per test from a few knobs, with faults injected: lost answers, failed
// writes, a slow or silent AT interpreter, answers of the test's own.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { OBEX, OBEX_TARGET_FLEXMEM, ObexDelays, ObexHeaderId, ObexOpcode, ObexProgress, parseObexHeaders } from './OBEX.js';
import { loadEntry, PhoneEntry } from '../../tests/obex/phones/entry.js';
import { FakePhone, openFakePhonePort } from '../../tests/obex/phones/fakePhone.js';
import { obexPacket } from '../../tests/obex/packets.js';

// The phones answer at once, so the protocol delays only keep their order, and a
// lost answer is given up on quickly
const FAST: Partial<ObexDelays> = { escape: 30, flush: 10, response: 400, abort: 150 };

const ALL_SPEEDS = [115200, 57600, 19200, 230400, 9600, 38400];

// The BFB behaviors of a pre-x55 phone
const S45 = loadEntry(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/obex/phones/db/synthetic-S45v56.json'));

type PhoneOptions = {
	model?: string;
	revision?: string;
	// the final result lines of AT^SQWE=0, AT^SQWE=3 and AT^SBFB=1, OK when unset
	results?: Record<string, string>;
	// a phone before the x55, with OBEX in BFB frames instead of raw OBEX
	bfb?: boolean;
	bfbHello?: boolean;
	// a phone booted in BFC mode on a service cable
	bfc?: boolean;
	// a cable without the +++ escape, like the DCA-540
	noEscape?: boolean;
	atLatencyMs?: number;
	maxPacket?: number;
	getChunk?: number;
	overwrite?: 'append' | 'replace';
	getMissing?: string;
	deleteMissing?: string;
	escapeGuardMs?: number;
};

type TestPhone = FakePhone & { port: AsyncSerialPort };

// A phone whose root holds the folder Sounds and the 12 byte notes.txt
async function fakePhone(options: PhoneOptions = {}): Promise<TestPhone> {
	const entry: PhoneEntry = {
		schema: S45.schema,
		id: 'session',
		source: 'synthetic',
		recorded: { date: '', tool: '' },
		identity: { vendor: 'SIEMENS', model: options.model ?? 'S65', revision: options.revision ?? '43' },
		at: { speeds: ALL_SPEEDS, latencyMs: options.atLatencyMs ?? 0, echo: false, results: options.results ?? (options.bfb ? S45.at.results : {}) },
		bfc: options.bfc ? { speed: 115200 } : null,
		transport: options.bfb ? 'bfb' : 'raw',
		bfb: options.bfb ? { ...S45.bfb!, helloAnswer: options.bfbHello === false ? null : S45.bfb!.helloAnswer, leaveSpeeds: ALL_SPEEDS } : null,
		raw: options.bfb ? null : { escape: options.noEscape ? 'none' : 'plus', escapeSpeeds: ALL_SPEEDS },
		obex: {
			connect: { code: '0xA0', version: '0x10', flags: '0x00', maxPacket: options.maxPacket ?? 0x0806, connectionId: true },
			connectionId: { without: null, with: null },
			codes: { setpathMissing: null, getMissing: options.getMissing ?? null, deleteMissing: options.deleteMissing ?? null, deleteMissingInJava: null, abortIdle: null, disconnect: null },
			rootFolders: ['Sounds'],
			listingPrologue: '<?xml version="1.0"?><folder-listing>',
			writableDir: null,
			getChunk: options.getChunk ?? 1000,
			overwrite: options.overwrite ?? 'replace',
			caseInsensitive: true,
			info: { capacity: true, available: true },
		},
		problems: [],
		evidence: {},
	};
	const { port, phone } = await openFakePhonePort(entry, { escapeGuardMs: options.escapeGuardMs ?? 20 });
	phone.addFile('/notes.txt', Buffer.from('twelve bytes'));
	return Object.assign(phone, { port });
}

// UCS2-BE with the trailing zero the NAME headers carry
function nameOf(request: Buffer): string | undefined {
	const name = parseObexHeaders(request).get(ObexHeaderId.NAME);
	return name && Buffer.from(name).swap16().toString('utf16le').replace(/\0+$/, '');
}

function isDelete(request: Buffer): boolean {
	const headers = parseObexHeaders(request);
	return request[0] == ObexOpcode.PUT_FINAL && headers.has(ObexHeaderId.NAME) && !headers.has(ObexHeaderId.END_OF_BODY);
}

function isUploadBody(request: Buffer): boolean {
	const headers = parseObexHeaders(request);
	return headers.has(ObexHeaderId.BODY) || headers.has(ObexHeaderId.END_OF_BODY);
}

function isListing(request: Buffer): boolean {
	return request[0] == ObexOpcode.GET_FINAL && parseObexHeaders(request).has(ObexHeaderId.TYPE);
}

const count = (phone: FakePhone, opcode: number) => phone.requests.filter((request) => request[0] == opcode).length;
const deletes = (phone: FakePhone) => phone.requests.filter(isDelete).map(nameOf);
const moves = (phone: FakePhone) => phone.requests
	.filter((request) => request[0] == ObexOpcode.PUT_FINAL && parseObexHeaders(request).has(ObexHeaderId.APP_PARAMS))
	.map((request) => parseObexHeaders(request).get(ObexHeaderId.APP_PARAMS));

// The requests after CONNECT with and without the phone's connection id 0x100
function connectionIds(phone: FakePhone): { withId: number; withoutId: number } {
	const has = (request: Buffer) => request.some((byte, i) => byte == ObexHeaderId.CONNECTION_ID && i + 5 <= request.length && request.readUInt32BE(i + 1) == 0x100);
	const requests = phone.requests.filter((request) => request[0] != ObexOpcode.CONNECT && request[0] != ObexOpcode.DISCONNECT);
	return { withId: requests.filter(has).length, withoutId: requests.filter((request) => !has(request)).length };
}

// Where the SETPATH requests among requests went: "/" to the root, ".." up, or
// the name of the folder they entered
function setPathSteps(requests: Buffer[]): string[] {
	return requests.filter((request) => request[0] == ObexOpcode.SETPATH).map((request) => {
		if (request[3] & 0x01)
			return '..';
		const name = parseObexHeaders(request, 5).get(ObexHeaderId.NAME)!;
		return name.length ? Buffer.from(name).swap16().toString('utf16le').replace(/\0+$/, '') : '/';
	});
}

// Bytes that tell their offsets apart
function pattern(size: number, seed = 1): Buffer {
	const data = Buffer.alloc(size);
	for (let i = 0; i < size; i++)
		data[i] = (i * 7 + seed) & 0xFF;
	return data;
}

// Every request that matches is answered with code instead of the phone's answer
function refuse(phone: FakePhone, match: (request: Buffer) => boolean, code: number): void {
	phone.override = (request) => match(request) ? obexPacket(code) : undefined;
}

async function until(condition: () => boolean): Promise<void> {
	while (!condition())
		await delay(5);
}

async function connectAndReadDir(phone: TestPhone) {
	const obex = await connected(phone);
	const entries = await obex.readDir('/');
	await obex.disconnect();
	return { obex, entries };
}

async function connected(phone: TestPhone, options = FAST): Promise<OBEX> {
	const obex = new OBEX(phone.port, options);
	await obex.connect(115200);
	return obex;
}

describe.concurrent('OBEX: AT transport', () => {
	// The listing takes two packets, so that the GET continuing it counts too
	test.each([
		{ model: 'S65', platform: 'SGOLD' },
		{ model: 'S75', platform: 'NewSGOLD' },
	])('an $model phone ($platform) gets its connection id in every request', async ({ model, platform }) => {
		const phone = await fakePhone({ model, getChunk: 100 });
		const { obex, entries } = await connectAndReadDir(phone);

		expect(obex.getPlatform()).toBe(platform);
		expect(obex.getDeviceName()).toBe(`SIEMENS ${model} v43`);
		expect(entries.map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);
		expect(entries[0].isDir).toBe(true);
		expect(entries[1].size).toBe(12);
		expect(connectionIds(phone).withId).toBeGreaterThanOrEqual(2);
		expect(connectionIds(phone).withoutId).toBe(0);
	});

	// A C60 sends a connection id too, but like siefs the client echoes it to SGOLD
	// and NewSGOLD phones only
	test('a legacy phone never gets a connection id echoed', async () => {
		const phone = await fakePhone({ model: 'C60' });
		const { obex, entries } = await connectAndReadDir(phone);

		expect(obex.getPlatform()).toBe('EGOLD');
		expect(entries.length).toBe(2);
		expect(connectionIds(phone).withId).toBe(0);
		// only the DISCONNECT carries the hardcoded id 1, like siefs sends it
		expect(phone.requests.find((p) => p[0] == ObexOpcode.DISCONNECT)?.toString('hex')).toBe('810008cb00000001');
	});

	test('CONNECT offers SiMoCo\'s 0x4006 and keeps it when the phone agrees', async () => {
		const phone = await fakePhone({ maxPacket: 0x4006 });
		const obex = await connected(phone);

		const connect = phone.requests.find((p) => p[0] == ObexOpcode.CONNECT)!;
		expect(connect.readUInt16BE(5)).toBe(0x4006);
		expect(parseObexHeaders(connect, 7).get(ObexHeaderId.TARGET)).toEqual(OBEX_TARGET_FLEXMEM);
		expect(obex.getMaxPacketSize()).toBe(0x4006);
		await obex.disconnect();
	});

	// e.g. the late answer to an earlier ABORT
	test('a CONNECT answer too short to be one is refused', async () => {
		const phone = await fakePhone();
		phone.override = (request) => request[0] == ObexOpcode.CONNECT ? obexPacket(0xA0) : undefined;
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(115200)).rejects.toThrow('Invalid OBEX CONNECT response: a00003.');
		expect(phone.mode).toBe('at');
	});

	test('a speed the port refuses is reported as such when connect() is given it', async () => {
		const phone = await fakePhone();
		phone.refusedBaudRates = [230400];

		await expect(new OBEX(phone.port, FAST).connect(230400)).rejects.toThrow('The serial port refuses 230400 baud.');
	});

	test('a delay passed as undefined keeps its default', async () => {
		const phone = await fakePhone();
		const obex = new OBEX(phone.port, { ...FAST, flush: undefined });

		const connecting = obex.connect(115200).then(() => 'connected');
		expect(await Promise.race([connecting, delay(5000).then(() => 'hanging')])).toBe('connected');
		await obex.disconnect();
	});

	// Without the model the platform is unknown, and an x65 then gets no connection id
	test('a model the phone failed to answer is asked again', async () => {
		const phone = await fakePhone({ model: 'S65' });
		let failed = false;
		phone.atOverride = (cmd) => cmd == 'AT+CGMM' && !failed ? (failed = true, '\r\nERROR\r\n') : undefined;
		const { obex, entries } = await connectAndReadDir(phone);

		expect(obex.getPlatform()).toBe('SGOLD');
		expect(entries.length).toBe(2);
		expect(connectionIds(phone).withoutId).toBe(0);
	});

	test('CONNECT keeps the smaller limit of the phone (the C60 answers 474)', async () => {
		const obex = await connected(await fakePhone({ maxPacket: 474 }));

		expect(obex.getMaxPacketSize()).toBe(474);
		await obex.disconnect();
	});

	// Less leaves an upload no room for its body, and it would never end
	test('CONNECT keeps no less than OBEX\'s minimum of 255', async () => {
		const phone = await fakePhone({ maxPacket: 10 });
		const obex = await connected(phone);
		const data = Buffer.alloc(600, 0x5A);

		expect(obex.getMaxPacketSize()).toBe(255);
		await obex.putFile('/big.bin', data);
		expect(phone.file('/big.bin')).toEqual(data);
		await obex.disconnect();
	});

	test('a phone that answers nothing is reported readably', { timeout: 40000 }, async () => {
		const phone = await fakePhone();
		phone.mode = 'stuck';
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(0)).rejects.toThrow(/Phone not found: .*power cycle/);
		expect(obex.isConnected).toBe(false);
	});

	// Only AT^SQWE=3 switched the wire, and the escape hands it back to the AT
	// interpreter, which the next connect() then finds again
	test('connect() can be retried after the phone refused CONNECT', async () => {
		const phone = await fakePhone();
		refuse(phone, (request) => request[0] == ObexOpcode.CONNECT, 0xC3);
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(115200)).rejects.toThrow('OBEX connect failed: Forbidden.');
		expect(obex.isConnected).toBe(false);
		expect(phone.mode).toBe('at');

		phone.override = undefined;
		await obex.connect(115200);
		expect(obex.isConnected).toBe(true);
		expect((await obex.readDir('/')).length).toBe(2);
		await obex.disconnect();
	});

	// siefs does not check the reset either
	test('a phone that refuses the mode reset still switches to raw OBEX', async () => {
		const phone = await fakePhone({ results: { 'AT^SQWE=0': 'ERROR' } });
		const { entries } = await connectAndReadDir(phone);

		expect(entries.length).toBe(2);
		expect(connectionIds(phone).withoutId).toBe(0);
	});

	test('a phone without FlexMem access is reported readably, and can be tried again', async () => {
		const phone = await fakePhone({ model: 'KE800', results: { 'AT^SQWE=0': 'ERROR', 'AT^SQWE=3': 'ERROR', 'AT^SBFB=1': 'ERROR' } });
		const obex = new OBEX(phone.port, FAST);

		const message = "Can't enter OBEX mode (AT^SQWE=3 and AT^SBFB=1 failed). Maybe the phone doesn't support FlexMem access.";
		await expect(obex.connect(115200)).rejects.toThrow(message);
		await expect(obex.connect(115200)).rejects.toThrow(message);
		expect(obex.isConnected).toBe(false);
	});

	// A busy x65 refuses the raw mode for a while, and would take AT^SBFB=1 without
	// answering in BFB frames afterwards
	test.each<{ refused: string; results: Record<string, string> }>([
		{ refused: 'AT^SQWE=3', results: { 'AT^SQWE=3': 'ERROR' } },
		{ refused: 'AT^SQWE=0 and AT^SQWE=3', results: { 'AT^SQWE=0': 'ERROR', 'AT^SQWE=3': 'ERROR' } },
	])('an x65 that refuses $refused is not switched to BFB', async ({ results }) => {
		const phone = await fakePhone({ results });
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(115200)).rejects.toThrow("Can't enter OBEX mode (AT^SQWE=3): AT command failed.");
		expect(phone.atCommands).not.toContain('AT^SBFB=1');
		expect(phone.mode).toBe('at');
	});

	// A session that ended without the escape, e.g. because the program talking to
	// the phone was killed, leaves a phone that answers neither AT nor BFC
	test('a phone left in OBEX mode is escaped back to its AT interpreter', { timeout: 20000 }, async () => {
		const phone = await fakePhone();
		phone.enterRaw(115200);
		const { obex, entries } = await connectAndReadDir(phone);

		expect(obex.getDeviceName()).toBe('SIEMENS S65 v43');
		expect(entries.length).toBe(2);
		expect(phone.mode).toBe('at');
	});

	// The session of a killed program ran at 57600, and a new process knows nothing
	// of it
	test('a phone left in OBEX mode at another speed than 115200 is escaped at that speed', { timeout: 30000 }, async () => {
		const phone = await fakePhone();
		phone.enterRaw(57600);
		const obex = new OBEX(phone.port, FAST);

		await obex.connect(0);
		expect((await obex.readDir('/')).length).toBe(2);
		await obex.disconnect();
		expect(phone.mode).toBe('at');
	});

	// Text left from the AT phase is skipped until a response code, but an OK must
	// not pass for one: its O is 0x4F
	test('a stray OK in front of the CONNECT response is skipped like a CR LF is', async () => {
		const phone = await fakePhone();
		phone.override = (request) => request[0] == ObexOpcode.CONNECT ?
			Buffer.concat([Buffer.from('\r\nOK\r\n'), obexPacket(0xA0, Buffer.from([0x10, 0x00, 0x08, 0x06]))]) :
			undefined;

		const obex = await connected(phone);
		expect(obex.isConnected).toBe(true);
		await obex.disconnect();
	});

	// A phone answering each probe after the client gave up on it would have every
	// later answer taken for the next command's
	test('a phone that answers AT late gets each answer matched to its own command', { timeout: 20000 }, async () => {
		const phone = await fakePhone({ model: 'S45', revision: '56', bfb: true, atLatencyMs: 250 });
		const obex = await connected(phone);

		expect(obex.getDeviceName()).toBe('SIEMENS S45 v56');
		// AT^SQWE=0 was judged on its own ERROR, not on a late OK, so BFB was tried
		expect(phone.mode).toBe('bfb');
		await obex.disconnect();
	});

	test('an x65 that answers AT late is detected as one and gets its connection id', { timeout: 20000 }, async () => {
		const phone = await fakePhone({ model: 'S65', atLatencyMs: 400 });
		const obex = await connected(phone);

		expect(obex.getPlatform()).toBe('SGOLD');
		expect(obex.getDeviceName()).toBe('SIEMENS S65 v43');
		expect((await obex.readDir('/')).length).toBe(2);
		expect(connectionIds(phone).withoutId).toBe(0);
		await obex.disconnect();
	});
});

describe.concurrent('OBEX: BFC transport', { timeout: 20000 }, () => {
	test('a phone booted in BFC mode switches to OBEX through the AT tunnel', async () => {
		const phone = await fakePhone({ model: 'SL65', revision: '50', bfc: true, getChunk: 100 });
		const obex = new OBEX(phone.port, FAST);
		await obex.connect(0);

		expect(obex.getPlatform()).toBe('SGOLD');
		expect(obex.getDeviceName()).toBe('SIEMENS SL65 v50');
		// CR terminated, like the BFC library sends AT commands itself
		expect(phone.bfcAtCommands).toContain('AT^SQWE=0\r');
		expect(phone.bfcAtCommands).toContain('AT^SQWE=3\r');

		const entries = await obex.readDir('/');
		expect(entries.map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);
		expect(connectionIds(phone).withId).toBeGreaterThanOrEqual(2);
		expect(connectionIds(phone).withoutId).toBe(0);
		await obex.disconnect();
	});

	// Switched to BFC from AT, the phone would not come back to AT after the session
	test('a phone whose AT interpreter answers only after the AT probes is not switched to BFC', async () => {
		const phone = await fakePhone();
		// Silent until the port leaves 38400, the last speed the AT probes try
		const probed = () => phone.baudRates.slice(0, -1).includes(38400) && phone.baudRate != 38400;
		phone.atOverride = () => probed() ? undefined : '';
		const obex = new OBEX(phone.port, FAST);
		await obex.connect(0);

		// found only after looking for BFC, which tries 921600
		expect(phone.baudRates).toContain(921600);
		expect(phone.atCommands).not.toContain('AT^SQWE=1');
		expect(phone.mode).toBe('raw');
		await obex.disconnect();
	});

	test('a tunneled AT^SQWE=3 answered with ERROR is reported as such', async () => {
		const phone = await fakePhone({ bfc: true, results: { 'AT^SQWE=3': 'ERROR' } });
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(0)).rejects.toThrow("Can't enter OBEX mode (AT^SQWE=3): ERROR.");
		expect(phone.mode).toBe('bfc');
		expect(phone.requests).toEqual([]);
	});

	// Like the SL65 on a service cable: the escape takes it to its AT interpreter
	test('the session ends with the escape, and the next connect() finds the phone in AT mode', async () => {
		const phone = await fakePhone({ model: 'SL65', revision: '50', bfc: true });
		const first = new OBEX(phone.port, FAST);
		await first.connect(0);
		await first.disconnect();
		expect(phone.mode).toBe('at');

		const second = new OBEX(phone.port, FAST);
		await second.connect(0);
		expect(second.getDeviceName()).toBe('SIEMENS SL65 v50');
		expect((await second.readDir('/')).length).toBe(2);
		await second.disconnect();
	});

	// Legacy Windows COM ports reject rates above 115200
	test('a speed the port refuses is skipped instead of failing connect()', async () => {
		const phone = await fakePhone({ bfc: true });
		phone.refusedBaudRates = [230400, 921600];
		const obex = new OBEX(phone.port, FAST);

		await obex.connect(0);
		expect((await obex.readDir('/')).length).toBe(2);
		await obex.disconnect();
	});
});

// Phones before the x55 generation (S45, ME45, SL45...) answer ERROR to AT^SQWE and
// wrap OBEX in BFB frames instead
describe.concurrent('OBEX: BFB transport', () => {
	test('a phone without raw OBEX mode is reached in BFB frames', async () => {
		// OBEX's minimum packet size, so that an upload takes several packets of several frames
		const phone = await fakePhone({ model: 'S45', revision: '56', bfb: true, maxPacket: 255 });
		const obex = await connected(phone);

		expect(obex.getPlatform()).toBe('EGOLD');
		expect(obex.getDeviceName()).toBe('SIEMENS S45 v56');
		expect(phone.mode).toBe('bfb');
		expect((await obex.readDir('/')).map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);

		const data = Buffer.alloc(600, 0x42);
		await obex.putFile('/big.bin', data);
		expect(phone.file('/big.bin')).toEqual(data);
		expect(phone.requests.filter(isUploadBody).length).toBe(3);

		// at^sbfb=0 takes the phone back to its AT interpreter
		await obex.disconnect();
		expect(phone.mode).toBe('at');
		expect(obex.isConnected).toBe(false);
	});

	// A phone still in BFB mode answers neither AT nor BFC, so the broken session
	// has to leave BFB before the handshake can be redone
	test('a broken session is redone after leaving BFB mode', { timeout: 20000 }, async () => {
		const phone = await fakePhone({ model: 'S45', bfb: true });
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		phone.loseNextAnswer();
		expect((await obex.readDir('/')).length).toBe(2);
		expect(phone.atCommands.slice(at)).toContain('AT^SBFB=1');
		expect(phone.mode).toBe('bfb');
		await obex.disconnect();
	});

	// A program that used BFB was killed without disconnect()
	test('a phone left in BFB mode is handed back to its AT interpreter by the next connect()', { timeout: 40000 }, async () => {
		const phone = await fakePhone({ model: 'S45', revision: '56', bfb: true });
		await connected(phone);
		expect(phone.mode).toBe('bfb');

		const obex = new OBEX(phone.port, FAST);
		await obex.connect(0);
		expect(obex.isConnected).toBe(true);
		expect((await obex.readDir('/')).length).toBe(2);
		await obex.disconnect();
		expect(phone.mode).toBe('at');
	});

	// The phone took AT^SBFB=1, the client can't tell at which speed it now waits
	test('a phone that does not answer the BFB hello is taken out of BFB mode again', { timeout: 20000 }, async () => {
		const phone = await fakePhone({ model: 'S45', bfb: true, bfbHello: false });
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.connect(115200)).rejects.toThrow('The phone does not answer in BFB mode.');
		expect(phone.mode).toBe('at');
	});
});

// EGOLD and SGOLD phones append to an existing file, so putFile() deletes it first
describe.concurrent('OBEX: putFile', () => {
	test('an upload deletes the existing file before any of the body is sent', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);

		await obex.putFile('/notes.txt', Buffer.from('new content'));

		expect(deletes(phone)).toEqual(['notes.txt']);
		const deleteAt = phone.requests.findIndex(isDelete);
		expect(deleteAt).toBeGreaterThanOrEqual(0);
		expect(deleteAt).toBeLessThan(phone.requests.findIndex(isUploadBody));
		expect(phone.file('/notes.txt')?.toString()).toBe('new content');
		await obex.disconnect();
	});

	test('a NewSGOLD phone replaces an existing file by itself, without a delete', async () => {
		const phone = await fakePhone({ model: 'S75' });
		const obex = await connected(phone);

		await obex.putFile('/notes.txt', Buffer.from('new content'));
		expect(deletes(phone)).toEqual([]);
		expect(phone.file('/notes.txt')?.toString()).toBe('new content');
		await obex.disconnect();
	});

	test('an upload takes Not found for a new file', async () => {
		const phone = await fakePhone({ deleteMissing: '0xC4' });
		const obex = await connected(phone);

		await obex.putFile('/brand new.txt', Buffer.from('data'));

		expect(deletes(phone)).toEqual(['brand new.txt']);
		expect(phone.file('/brand new.txt')?.toString()).toBe('data');
		await obex.disconnect();
	});

	// e.g. a read-only file: uploading anyway would append to it
	test('an upload fails instead of appending when the phone refuses to delete an existing file', async () => {
		const phone = await fakePhone();
		refuse(phone, isDelete, 0xC3);
		const obex = await connected(phone);

		await expect(obex.putFile('/notes.txt', Buffer.from('data'))).rejects.toThrow('OBEX delete of existing "notes.txt" failed: Forbidden.');
		expect(phone.requests.some(isUploadBody)).toBe(false);
		await obex.disconnect();
	});

	// The file systems ignore the case of names
	test('an upload fails for an existing file whose name differs in case only', async () => {
		const phone = await fakePhone();
		refuse(phone, isDelete, 0xC3);
		const obex = await connected(phone);

		await expect(obex.putFile('/NOTES.TXT', Buffer.from('data'))).rejects.toThrow('OBEX delete of existing "NOTES.TXT" failed: Forbidden.');
		expect(phone.requests.some(isUploadBody)).toBe(false);
		await obex.disconnect();
	});

	// /Java forbids deletes but allows uploads
	test('an upload goes ahead when the phone refuses to delete a file that is not there', async () => {
		const phone = await fakePhone();
		phone.addDir('/Java/Jam/api');
		refuse(phone, isDelete, 0xC3);
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		await obex.putFile('/Java/Jam/api/Change_timeout_of_IDLE_timer3_REPAIR.vkp', Buffer.from('patch'));

		// the directory listing decided
		expect(phone.requests.some(isListing)).toBe(true);
		expect(phone.file('/Java/Jam/api/Change_timeout_of_IDLE_timer3_REPAIR.vkp')?.toString()).toBe('patch');
		expect(phone.atCommands.slice(at)).toEqual([]);
		await obex.disconnect();
	});

	// After an upload or a delete, the A56 answers as if in the root folder, and an
	// upload right after one gets two answers to its first body packet
	test('an A56 gets its folder entered again after every upload and delete', async () => {
		const phone = await fakePhone({ model: 'A56', maxPacket: 255 });
		phone.forgetsFolder = true;
		phone.addFile('/Sounds/a.bin', Buffer.from('old'));
		const obex = await connected(phone);
		const first = pattern(1000, 1);
		const second = pattern(1000, 2);

		await obex.putFile('/Sounds/a.bin', first);
		await obex.putFile('/Sounds/b.bin', second);
		expect(await obex.getFile('/Sounds/a.bin')).toEqual(first);
		await obex.deleteFile('/Sounds/a.bin');
		await obex.deleteFile('/Sounds/b.bin');
		expect(phone.file('/Sounds/a.bin')).toBeUndefined();
		expect(phone.file('/Sounds/b.bin')).toBeUndefined();
		await obex.disconnect();
	});

	test('other phones keep their folder across uploads', async () => {
		const phone = await fakePhone({ maxPacket: 255 });
		const obex = await connected(phone);
		const before = phone.requests.length;

		await obex.putFile('/Sounds/a.bin', pattern(1000));
		await obex.putFile('/Sounds/b.bin', pattern(1000));
		expect(setPathSteps(phone.requests.slice(before))).toEqual(['Sounds']);
		await obex.disconnect();
	});

	// The delete before an upload would take an empty folder of that name with it
	test('a folder path is refused before anything is sent', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const requests = phone.requests.length;

		await expect(obex.putFile('/Data/Misc/', Buffer.from('x'))).rejects.toThrow('"/Data/Misc/" is a folder path');
		await expect(obex.putFile('/', Buffer.from('x'))).rejects.toThrow('"/" is a folder path');
		expect(phone.requests.length).toBe(requests);
		await obex.disconnect();
	});

	test('the body is split to fit the negotiated packet size', async () => {
		// OBEX's minimum packet size, with a connection id in every packet
		const phone = await fakePhone({ maxPacket: 255 });
		const obex = await connected(phone);
		const data = Buffer.alloc(1000, 0x5A);
		const progress: number[] = [];

		await obex.putFile('/big.bin', data, (e) => progress.push(e.cursor));

		expect(phone.file('/big.bin')).toEqual(data);
		const bodies = phone.requests.filter(isUploadBody);
		// 244 bytes of body fit next to the packet, BODY and connection id headers
		expect(bodies.map((p) => p.length)).toEqual([255, 255, 255, 255, 35]);
		expect(bodies.map((p) => p[0])).toEqual([ObexOpcode.PUT, ObexOpcode.PUT, ObexOpcode.PUT, ObexOpcode.PUT, ObexOpcode.PUT_FINAL]);
		expect(progress[progress.length - 1]).toBe(data.length);
		await obex.disconnect();
	});

	test('a progress callback that throws at the end keeps the complete file', async () => {
		const phone = await fakePhone({ maxPacket: 255 });
		phone.addFile('/keep.bin', Buffer.from('the previous version'));
		const obex = await connected(phone);
		const data = pattern(1000);

		await expect(obex.putFile('/keep.bin', data, (e) => {
			if (e.percent == 100)
				throw new Error('ui');
		})).rejects.toThrow('ui');
		expect(phone.file('/keep.bin')).toEqual(data);
		await obex.disconnect();
	});

	test('an empty file reports the end of its upload', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const progress: ObexProgress[] = [];

		await obex.putFile('/empty.txt', Buffer.alloc(0), (e) => progress.push(e));

		expect(phone.file('/empty.txt')).toEqual(Buffer.alloc(0));
		expect(progress).toEqual([{ percent: 100, cursor: 0, total: 0, speed: 0 }]);
		await obex.disconnect();
	});
});

describe.concurrent('OBEX: getFile and setPath', () => {
	test('a file in several packets is put together in order', async () => {
		const phone = await fakePhone({ getChunk: 400 });
		const data = pattern(3000);
		phone.addFile('/Data/big.bin', data);
		const obex = await connected(phone);

		expect(await obex.getFile('/Data/big.bin')).toEqual(data);
		// and one more for the empty SUCCESS after the data
		expect(count(phone, ObexOpcode.GET_FINAL)).toBe(Math.ceil(3000 / 400) + 1);
		await obex.disconnect();
	});

	test('a missing file is reported with the phone\'s answer', async () => {
		const obex = await connected(await fakePhone());

		await expect(obex.getFile('/missing.bin')).rejects.toThrow('OBEX GET failed: Not found.');
		await obex.disconnect();
	});

	// The A56 answers the GET of a missing file with an empty one
	test('an empty answer is a missing file when the listing does not show it', async () => {
		const phone = await fakePhone({ getMissing: '0xA0' });
		phone.addFile('/empty.txt', Buffer.alloc(0));
		const obex = await connected(phone);

		await expect(obex.getFile('/missing.bin')).rejects.toThrow('OBEX GET failed: Not found.');
		// empty.txt is listed, so its empty answer is an empty file
		expect(await obex.getFile('/empty.txt')).toEqual(Buffer.alloc(0));
		await obex.disconnect();
	});

	test('No content is an empty file', async () => {
		const phone = await fakePhone();
		refuse(phone, (request) => request[0] == ObexOpcode.GET_FINAL && nameOf(request) == 'notes.txt', 0xA4);
		const obex = await connected(phone);

		expect(await obex.getFile('/notes.txt')).toEqual(Buffer.alloc(0));
		await obex.disconnect();
	});

	test('mkdir creates each missing folder on the way', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);

		const before = phone.requests.length;
		await obex.mkdir('/Data/New/Deep');
		const setpaths = phone.requests.slice(before).filter((request) => request[0] == ObexOpcode.SETPATH);
		expect(setPathSteps(setpaths)).toEqual(['Data', 'New', 'Deep']);
		// flags 0x00: create the folder where it is missing
		expect(setpaths.map((request) => request[3])).toEqual([0x00, 0x00, 0x00]);
		expect(obex.getCurrentPath()).toBe('/Data/New/Deep');
		await obex.disconnect();
	});

	test('reading a missing folder fails and creates nothing', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);

		await expect(obex.readDir('/Missing')).rejects.toThrow('OBEX setpath to "Missing" failed: Not found.');
		expect((await obex.readDir('/')).map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);
		await obex.disconnect();
	});

	test('one level up is one SETPATH up', async () => {
		const phone = await fakePhone();
		phone.addDir('/Data/Misc');
		phone.addDir('/Data/Other');
		const obex = await connected(phone);
		await obex.readDir('/Data/Misc');

		const before = phone.requests.length;
		await obex.readDir('/Data/Other');
		expect(setPathSteps(phone.requests.slice(before))).toEqual(['..', 'Other']);
		await obex.disconnect();
	});
});

// The caller's progress callback throwing is one way to cancel a transfer, the
// signal the other. The phone answers a GET in the context of an exchange that is
// still open, like the S75 firmware, so a missing ABORT shows.
describe.concurrent('OBEX: cancelling a transfer', () => {
	test('a progress callback that throws ends the download with an ABORT, and the next download gets its own file', async () => {
		const phone = await fakePhone({ getChunk: 100 });
		phone.addFile('/big.bin', pattern(3000));
		phone.addFile('/small.txt', Buffer.from('sixteen bytes!!\n'));
		phone.responseDelayMs = 30;
		const obex = await connected(phone);

		await expect(obex.getFile('/big.bin', () => { throw new Error('stop'); })).rejects.toThrow('stop');
		expect(count(phone, ObexOpcode.ABORT)).toBe(1);
		expect(obex.isConnected).toBe(true);
		expect((await obex.getFile('/small.txt')).toString()).toBe('sixteen bytes!!\n');
		await obex.disconnect();
	});

	test('a signal aborted during a download ends it with an ABORT', async () => {
		const phone = await fakePhone({ getChunk: 100 });
		phone.addFile('/Sounds/big.bin', pattern(3000));
		const obex = await connected(phone);
		const controller = new AbortController();
		phone.responseDelayMs = 5;

		const download = obex.getFile('/Sounds/big.bin', undefined, { signal: controller.signal });
		await until(() => count(phone, ObexOpcode.GET_FINAL) >= 3);
		controller.abort();

		await expect(download).rejects.toThrow(/aborted/i);
		expect(count(phone, ObexOpcode.ABORT)).toBe(1);
		expect((await obex.readDir('/')).length).toBe(2);
		await obex.disconnect();
	});

	test('a signal aborted before the operation started sends nothing', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const requests = phone.requests.length;

		await expect(obex.getFile('/big.bin', undefined, { signal: AbortSignal.abort() })).rejects.toThrow(/aborted/i);
		expect(phone.requests.length).toBe(requests);
		await obex.disconnect();
	});

	test('a progress callback that throws ends the upload with an ABORT and deletes the partial file', async () => {
		const phone = await fakePhone({ maxPacket: 255 });
		phone.capacity = 0x100000;
		phone.responseDelayMs = 30;
		const obex = await connected(phone);

		await expect(obex.putFile('/big.bin', pattern(3000), () => { throw new Error('stop'); })).rejects.toThrow('stop');
		expect(count(phone, ObexOpcode.ABORT)).toBe(1);
		expect(phone.file('/big.bin')).toBeUndefined();
		// with the upload still open, the phone would fail these with Internal server error
		expect((await obex.readDir('/')).length).toBe(2);
		expect(await obex.getCapacity()).toBe(0x100000);
		await obex.disconnect();
	});

	// Like the EGOLD and SGOLD phones
	test('a cancelled upload of a new file is deleted on a phone that answers Forbidden for a missing file', async () => {
		const phone = await fakePhone({ maxPacket: 255, deleteMissing: '0xC3' });
		phone.responseDelayMs = 30;
		const obex = await connected(phone);

		await expect(obex.putFile('/big.bin', pattern(3000), () => { throw new Error('stop'); })).rejects.toThrow('stop');
		expect(phone.file('/big.bin')).toBeUndefined();
		await obex.disconnect();
	});

	// Its answer may still arrive, and would pass for the next request's
	test('a delete of the partial file that gets no answer ends the session', async () => {
		const phone = await fakePhone({ maxPacket: 255 });
		let bodies = 0;
		phone.override = (request) => {
			if (isUploadBody(request) && ++bodies == 2)
				return obexPacket(0xE0);
			if (bodies >= 2 && isDelete(request))
				phone.loseNextAnswer();
			return undefined;
		};
		const obex = await connected(phone);

		await expect(obex.putFile('/big.bin', pattern(1000))).rejects.toThrow('OBEX PUT failed: Database full.');
		expect(obex.isConnected).toBe(false);
		expect(phone.mode).toBe('at');
	});
});

// A dead session is redone with the whole handshake and the operation retried once,
// an error response of the phone is not a reason for that
describe.concurrent('OBEX: session recovery', { timeout: 20000 }, () => {
	test('an operation on a phone that rebooted reconnects and is retried once', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		phone.loseNextAnswer('reboot');
		const entries = await obex.readDir('/');

		expect(entries.map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);
		expect(phone.atCommands.slice(at)).toContain('AT^SQWE=3');
		expect(obex.isConnected).toBe(true);
		await obex.disconnect();
	});

	test('a session whose phone stays in OBEX mode is redone after the escape', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		phone.loseNextAnswer('stay');
		expect((await obex.readDir('/')).length).toBe(2);
		expect(phone.atCommands.slice(at)).toContain('AT^SQWE=3');
		expect(obex.isConnected).toBe(true);
		await obex.disconnect();
	});

	test('a failed reconnect reports both failures, later operations fail right away', { timeout: 40000 }, async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);

		phone.loseNextAnswer('unplug');
		await expect(obex.readDir('/')).rejects.toThrow(/^OBEX response timeout\. Reconnecting failed: Phone not found/);
		expect(obex.isConnected).toBe(false);

		const writes = phone.writes;
		await expect(obex.getCapacity()).rejects.toThrow('OBEX is not connected.');
		expect(phone.writes).toBe(writes);
	});

	// SerialPortStream closes the port on a failed write, and emits the error for the
	// program to listen for, like examples/obex.ts does
	test('a failed write closes the port and is reported', async () => {
		const phone = await fakePhone();
		phone.port.on('error', () => {});
		const obex = await connected(phone);

		phone.failNextWrite();
		await expect(obex.readDir('/')).rejects.toThrow(/^Write failed\. Reconnecting failed: /);
		expect(obex.isConnected).toBe(false);
		expect(phone.port.isOpen).toBe(false);
	});

	// Late answers of both attempts may still arrive, and would be read as the
	// answers to later requests
	test('an operation whose retry fails as well ends the session', async () => {
		const phone = await fakePhone();
		let lostListings = 0;
		phone.override = (request) => {
			if (isListing(request) && lostListings++ < 2)
				phone.loseNextAnswer();
			return undefined;
		};
		const obex = await connected(phone);

		await expect(obex.readDir('/')).rejects.toThrow('OBEX response timeout.');
		expect(obex.isConnected).toBe(false);
		expect(phone.mode).toBe('at');
		await expect(obex.getCapacity()).rejects.toThrow('OBEX is not connected.');

		await obex.connect(115200);
		expect((await obex.readDir('/')).map((e) => e.name)).toEqual(['Sounds', 'notes.txt']);
		await obex.disconnect();
	});

	test('an operation before connect() fails without touching the wire', async () => {
		const phone = await fakePhone();
		const obex = new OBEX(phone.port, FAST);

		await expect(obex.readDir('/')).rejects.toThrow('OBEX is not connected.');
		expect(phone.writes).toBe(0);
	});

	test('an error response mentioning a timeout is no dead session', async () => {
		const phone = await fakePhone();
		refuse(phone, isDelete, 0xC8);
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		await expect(obex.deleteFile('/notes.txt')).rejects.toThrow('OBEX delete "notes.txt" failed: Request timeout.');
		expect(phone.atCommands.slice(at)).toEqual([]);
		await obex.disconnect();
	});

	// A code missing from the table would be skipped as garbage and run into the timeout
	test('Proxy authentication required and Request URL too large are responses too', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		refuse(phone, isDelete, 0xC7);
		await expect(obex.deleteFile('/notes.txt')).rejects.toThrow('OBEX delete "notes.txt" failed: Proxy authentication required.');
		refuse(phone, isDelete, 0xCE);
		await expect(obex.deleteFile('/notes.txt')).rejects.toThrow('OBEX delete "notes.txt" failed: Request URL too large.');
		expect(phone.atCommands.slice(at)).toEqual([]);
		await obex.disconnect();
	});
});

// What the retry after a dead link may repeat: the first attempt may have done
// its work on the phone with only the answer lost
describe.concurrent('OBEX: retrying after a dead link', { timeout: 20000 }, () => {
	// The answer to the third body packet of an upload gets lost
	function loseThirdBody(phone: FakePhone, deleteResponse?: number): void {
		let bodies = 0;
		phone.override = (request) => {
			if (isUploadBody(request) && ++bodies == 3)
				phone.loseNextAnswer();
			return deleteResponse && isDelete(request) ? obexPacket(deleteResponse) : undefined;
		};
	}

	test('an upload is repeated from its delete, the phone ends up with the data once', async () => {
		const phone = await fakePhone({ maxPacket: 255, overwrite: 'append' });
		loseThirdBody(phone);
		const obex = await connected(phone);
		const data = pattern(1000);

		await obex.putFile('/new.bin', data);
		expect(phone.file('/new.bin')).toEqual(data);
		expect(obex.isConnected).toBe(true);
		await obex.disconnect();
	});

	// The listing now shows the partial file, which can't be deleted either
	test('an upload into a folder that refuses deletes is not repeated', async () => {
		const phone = await fakePhone({ maxPacket: 255, overwrite: 'append' });
		phone.addDir('/Java');
		loseThirdBody(phone, 0xC3);
		const obex = await connected(phone);

		await expect(obex.putFile('/Java/app.jar', pattern(1000))).rejects.toThrow('OBEX response timeout.');
		expect(phone.file('/Java/app.jar')?.length).toBe(3 * 244);
		await obex.disconnect();
	});

	test('a delete whose answer got lost succeeds when the retry finds the file gone', async () => {
		const phone = await fakePhone();
		phone.addFile('/old.txt', Buffer.from('x'));
		const obex = await connected(phone);

		phone.loseNextAnswer();
		await obex.deleteFile('/old.txt');
		expect(phone.file('/old.txt')).toBeUndefined();
		expect(deletes(phone)).toEqual(['old.txt', 'old.txt']);
		await obex.disconnect();
	});

	// The EGOLD and SGOLD phones answer the delete of a missing file with Forbidden
	test('a retried delete answered Forbidden succeeds when the listing no longer shows the file', async () => {
		const phone = await fakePhone({ deleteMissing: '0xC3' });
		phone.addFile('/old.txt', Buffer.from('x'));
		const obex = await connected(phone);

		phone.loseNextAnswer();
		await obex.deleteFile('/old.txt');
		expect(phone.file('/old.txt')).toBeUndefined();
		await obex.disconnect();
	});

	test('a delete of a missing file still fails with Not found', async () => {
		const obex = await connected(await fakePhone());

		await expect(obex.deleteFile('/missing.txt')).rejects.toThrow('OBEX delete "missing.txt" failed: Not found.');
		await obex.disconnect();
	});

	test('a move whose answer got lost is not repeated', async () => {
		const phone = await fakePhone();
		phone.addFile('/a.txt', Buffer.from('x'));
		const obex = await connected(phone);

		phone.loseNextAnswer();
		await expect(obex.move('/a.txt', '/b.txt')).rejects.toThrow('OBEX response timeout.');
		expect(moves(phone).length).toBe(1);
		expect(obex.isConnected).toBe(true);
		await obex.disconnect();
	});
});

// The DCA-540 is a USB link to an x65 itself: the phone takes +++ for OBEX data and
// needs a power cycle afterwards, and the cable refuses to set DTR
describe.concurrent('OBEX: a cable without the +++ escape', { timeout: 20000 }, () => {
	test('the phone stays in OBEX mode, and the next connect() goes on in it', async () => {
		const phone = await fakePhone({ noEscape: true });
		const first = new OBEX(phone.port, FAST);
		await first.connect(0);
		expect((await first.readDir('/')).length).toBe(2);
		await first.disconnect();
		expect(phone.mode).toBe('raw');

		// a new program: it finds the phone in OBEX mode before sending any AT
		const at = phone.atCommands.length;
		const second = new OBEX(phone.port, FAST);
		await second.connect(0);
		expect((await second.readDir('/')).length).toBe(2);
		expect(phone.atCommands.length).toBe(at);
		await second.disconnect();
		expect(phone.mode).toBe('raw');
	});

	test('a session that lost an answer is revived in place', async () => {
		const phone = await fakePhone({ noEscape: true });
		const obex = await connected(phone);

		phone.loseNextAnswer();
		expect((await obex.readDir('/')).length).toBe(2);
		expect(phone.mode).toBe('raw');
		await obex.disconnect();
	});

	// AT probes would start an OBEX packet that never ends
	test('a phone too busy to be revived is left in OBEX mode, where the next connect() finds it', async () => {
		const phone = await fakePhone({ noEscape: true });
		const obex = await connected(phone);
		const at = phone.atCommands.length;

		phone.responseDelayMs = 1500;
		await expect(obex.readDir('/')).rejects.toThrow('OBEX response timeout. Reconnecting failed: The phone does not answer in OBEX mode.');
		phone.responseDelayMs = 0;
		await delay(2000);

		await obex.connect(0);
		expect((await obex.readDir('/')).length).toBe(2);
		expect(phone.atCommands.length).toBe(at);
		await obex.disconnect();
		expect(phone.mode).toBe('raw');
	});
});

describe.concurrent('OBEX: move and info requests', () => {
	test('move sends the Siemens move parameters with both paths', async () => {
		const phone = await fakePhone();
		phone.addFile('/a.txt', Buffer.from('x'));
		const obex = await connected(phone);

		await obex.move('/a.txt', '/b.txt');

		const ucs2 = (str: string) => Buffer.from(str, 'utf16le').swap16();
		expect(moves(phone)).toEqual([Buffer.concat([
			Buffer.from([0x34, 0x04]), Buffer.from('move'),
			Buffer.from([0x35, 0x0C]), ucs2('/a.txt'),
			Buffer.from([0x36, 0x0C]), ucs2('/b.txt'),
		])]);
		expect(phone.file('/b.txt')?.toString()).toBe('x');
		await obex.disconnect();
	});

	// The path lengths are single bytes, a longer path would corrupt the request
	test('move refuses a path that does not fit its length byte', async () => {
		const phone = await fakePhone();
		const obex = await connected(phone);

		await expect(obex.move(`/${'x'.repeat(200)}`, '/b.txt')).rejects.toThrow('Path is too long for an OBEX move (402 bytes, 255 max).');
		expect(moves(phone)).toEqual([]);
		await obex.disconnect();
	});

	// Walking from where the client last was would start at a directory that moved
	test('after moving a directory on the current path, the next setPath starts at the root', async () => {
		const phone = await fakePhone();
		phone.addDir('/Data/Misc/a');
		const obex = await connected(phone);
		await obex.readDir('/Data/Misc/a');

		await obex.move('/data/misc/A', '/Data/Misc/b');
		expect(obex.getCurrentPath()).toBeUndefined();

		const before = phone.requests.length;
		await obex.readDir('/Data/Misc/b');
		expect(setPathSteps(phone.requests.slice(before))).toEqual(['/', 'Data', 'Misc', 'b']);
		expect(obex.getCurrentPath()).toBe('/Data/Misc/b');
		await obex.disconnect();
	});

	test('moving a file keeps the current path', async () => {
		const phone = await fakePhone();
		phone.addFile('/Data/Misc/a.txt', Buffer.from('x'));
		const obex = await connected(phone);
		await obex.readDir('/Data/Misc');

		await obex.move('/Data/Misc/a.txt', '/Data/Misc/b.txt');

		const before = phone.requests.length;
		await obex.readDir('/Data/Misc');
		expect(setPathSteps(phone.requests.slice(before))).toEqual([]);
		expect(obex.getCurrentPath()).toBe('/Data/Misc');
		await obex.disconnect();
	});

	test('a refused capacity request fails', async () => {
		const phone = await fakePhone();
		refuse(phone, (request) => parseObexHeaders(request).has(ObexHeaderId.APP_PARAMS), 0xC0);
		const obex = await connected(phone);

		await expect(obex.getCapacity()).rejects.toThrow('OBEX info request failed: Bad request.');
		await obex.disconnect();
	});

	test('capacity and free space of 2 GiB and more stay positive', async () => {
		const phone = await fakePhone();
		phone.capacity = 0xFFFFFFFF;
		phone.available = 0x80000000;
		const obex = await connected(phone);

		expect(await obex.getCapacity()).toBe(0xFFFFFFFF);
		expect(await obex.getAvailable()).toBe(0x80000000);
		await obex.disconnect();
	});
});

// Does an immediate disconnect() leave the phone usable? The phone answers requests
// in order, and leaves OBEX mode only on "+++" with a guard time of silence on both
// sides, like a Hayes escape: a byte inside the guard cancels it.
describe.concurrent('OBEX: an immediate disconnect() leaves the phone usable', { timeout: 60000 }, () => {
	const DELAYS: Partial<ObexDelays> = { flush: 20, escape: 200, response: 2000, abort: 500 };

	// 1019 body bytes per packet: a 3000 byte file takes three
	const slowPhone = (options: PhoneOptions = {}) => fakePhone({ maxPacket: 0x0406, escapeGuardMs: 150, ...options });
	const bodies = (phone: FakePhone) => phone.requests.filter((request) => request[0] == ObexOpcode.PUT && request[3] == ObexHeaderId.BODY).length;

	test('during a download, which fails instead of resolving with part of the file', async () => {
		const phone = await slowPhone();
		phone.addFile('/big.bin', Buffer.alloc(3000, 0x31));
		const obex = await connected(phone, DELAYS);
		phone.responseDelayMs = 100;
		const download = obex.getFile('/big.bin').then((data) => data.length, (e: Error) => e.message);
		await until(() => count(phone, ObexOpcode.GET_FINAL) >= 2);

		await obex.disconnect();
		expect(await download).toBe('OBEX was disconnected during the operation.');
		await delay(500);
		expect(phone.mode).toBe('at');
		expect(obex.isConnected).toBe(false);
	});

	for (const after of [50, 400]) {
		test(`${after} ms into the rehandshake after a dead link`, async () => {
			// the download's first GET gets a corrupt answer, which starts the rehandshake
			const phone = await slowPhone();
			phone.addFile('/big.bin', Buffer.alloc(3000, 0x31));
			let requests = 0;
			phone.override = () => ++requests == 2 ? Buffer.from([0xA0, 0x00, 0x01]) : undefined;
			const obex = await connected(phone, DELAYS);
			const download = obex.getFile('/big.bin').catch(() => undefined);
			await until(() => phone.requests.some((request) => request.subarray(0, 3).toString('hex') == 'ff0008'));
			await delay(after);

			await obex.disconnect();
			await download;
			await delay(500);
			expect(obex.isConnected).toBe(false);
			expect(phone.mode).toBe('at');
		});
	}

	// The upload's request would time out in the middle of the escape and write its
	// ABORT into the guard time, and the phone would stay in OBEX mode
	test('while a request waits for an answer that never comes, no ABORT follows', async () => {
		const phone = await slowPhone();
		phone.override = (request) => request[0] == ObexOpcode.PUT && request[3] == ObexHeaderId.BODY && bodies(phone) >= 2 ? null : undefined;
		const obex = await connected(phone, DELAYS);
		const upload = obex.putFile('/big.bin', Buffer.alloc(3000)).catch((e: Error) => e.message);
		await until(() => bodies(phone) >= 2);

		await obex.disconnect();
		expect(await upload).toBe('OBEX was disconnected during the operation.');
		// longer than the request's and the ABORT's timeouts
		await delay(3000);
		expect(count(phone, ObexOpcode.ABORT)).toBe(0);
		expect(phone.mode).toBe('at');
	});

	// The old task must not carry on in the new session
	test('an upload cut short and a connect() right after it: the upload stays cancelled', async () => {
		const phone = await slowPhone();
		const obex = await connected(phone, DELAYS);
		phone.responseDelayMs = 50;
		const upload = obex.putFile('/big.bin', Buffer.alloc(8000)).catch((e: Error) => e.message);
		await until(() => bodies(phone) >= 2);

		const disconnecting = obex.disconnect();
		const reconnecting = obex.connect(115200);
		expect(await upload).toBe('OBEX was disconnected during the operation.');
		await disconnecting;
		await reconnecting;
		const sent = bodies(phone);
		await delay(500);

		expect(obex.isConnected).toBe(true);
		expect(bodies(phone)).toBe(sent);
		// the new session works
		expect(await obex.getCapacity()).toBeGreaterThan(0);
		await obex.disconnect();
		await delay(500);
		expect(phone.mode).toBe('at');
	});

	// Each AT command takes 100 ms, so the phone has not answered the command yet
	for (const command of ['AT+CGMM', 'AT^SQWE=3']) {
		test(`at ${command} in connect(), which fails and leaves the phone in AT mode`, async () => {
			const phone = await slowPhone({ atLatencyMs: 100 });
			const obex = new OBEX(phone.port, DELAYS);
			const connecting = obex.connect(115200).then(() => 'connected', (e: Error) => e.message);
			await until(() => phone.atCommands.includes(command));

			await obex.disconnect();
			expect(await connecting).toBe('OBEX was disconnected during the operation.');
			await delay(500);
			expect(obex.isConnected).toBe(false);
			expect(phone.mode).toBe('at');
		});
	}
});
