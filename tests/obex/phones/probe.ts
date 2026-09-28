// Measures how a phone behaves and returns it as a database entry. It drives the
// wire itself rather than through the OBEX client, so it can do what the client
// never does: jump a BFB sequence number, send a request without the connection id.
//
// Phones and cables differ in how fast they answer. So every answer gets a window
// sized to what the probe has measured so far, a command without an answer is
// followed by a wait for the line to go quiet, and no answer is ever taken for a
// later command's.
//
// On a phone it writes only probe.bin into one folder, and deletes it again: the
// folder given as dir, or else the first of WRITABLE_DIR_CANDIDATES the listings
// show that gives an upload back. It never asks for the IMEI and keeps no file
// contents.

import { setTimeout as delay } from 'node:timers/promises';
import { AsyncSerialPort } from '../../../src/AsyncSerialPort.js';
import { BfbChannel } from '../../../src/BFB.js';
import { BFC } from '../../../src/BFC.js';
import { forgetsFolderAfterPut, isObexResponseCode, OBEX_TARGET_FLEXMEM, ObexDirEntry, ObexHeaderId, ObexPacketWriter, parseFolderListing, parseObexHeaders } from '../../../src/OBEX.js';
import { ACK, BFB_SPEEDS, encodeBfbPacket, HELLO, LEAVE } from '../../../src/ObexBfbLink.js';
import { BfbBehavior, hex, ObexBehavior, PhoneEntry, RawBehavior, SCHEMA_VERSION } from './entry.js';

const AT_SPEEDS = [115200, 57600, 19200, 230400, 9600, 38400];
const PROBE_FILE = 'probe.bin';
const MISSING_FILE = 'probe-missing.bin';
const FINAL_LINE = /\r\n(OK|ERROR|\+CM[ES] ERROR[^\r]*)\r\n/;
const FINAL_RESULT = /^(OK|ERROR|\+CM[ES] ERROR)/;
// The silence the +++ escape needs on both sides
const ESCAPE_GUARD_MS = 1000;
// Tries of ATQ0 V1 E0 per speed: a phone may lose the first command after a switch
const AT_TRIES = 2;

export type ProbeOptions = {
	// a folder the file checks may write into, e.g. /Data/Misc
	dir?: string;
	id?: string;
	source?: PhoneEntry['source'];
	notes?: string;
};

const isSuccess = (value: number) => (value & 0x70) == 0x20;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// How fast the phone answers, as measured so far, and the windows that follow from it
class Timing {
	private readonly samples: number[] = [];

	add(ms: number): void {
		this.samples.push(ms);
	}

	get median(): number | null {
		if (!this.samples.length)
			return null;
		const sorted = [...this.samples].sort((a, b) => a - b);
		return sorted[Math.floor(sorted.length / 2)];
	}

	private get slowest(): number {
		return Math.max(0, ...this.samples);
	}

	// For ATQ0 V1 E0 at a speed that may not answer at all: long enough for a slow
	// cable before anything is known, then three times the slowest answer seen
	probeWindow(): number {
		return this.samples.length ? clamp(3 * this.slowest + 500, 1000, 5000) : 1500;
	}

	// For a command the phone is known to answer, finished early by the answer
	commandWindow(): number {
		return Math.max(3000, 3 * this.slowest + 1000);
	}

	// The silence that rules out a late answer still being on its way
	quiet(): number {
		return this.samples.length ? clamp(this.slowest + 300, 300, 2000) : 1000;
	}

	// Added to the fixed windows of the OBEX and BFB steps
	slack(): number {
		return this.slowest;
	}
}

// The wire with every byte and step logged as evidence
class Wire {
	private readonly started = Date.now();
	readonly evidence: Record<string, string[]> = {};
	private lines: string[] = [];
	// What the last line received, while it may still grow
	private lastRx: { line: string; at: number; data: Buffer } | undefined;

	constructor(readonly port: AsyncSerialPort) {}

	step(name: string): void {
		this.lines = this.evidence[name] ??= [];
	}

	note(text: string): void {
		this.lines.push(`+${Date.now() - this.started} -- ${text}`);
	}

	// A long transfer keeps its head and tail, where the headers and the CRC are. What
	// arrives within the same millisecond is one line: a USB cable may hand the bytes
	// over one by one.
	private log(direction: string, data: Buffer): void {
		const at = Date.now() - this.started;
		const last = this.lastRx;
		if (direction == 'RX' && last?.at == at && this.lines[this.lines.length - 1] === last.line) {
			this.lines.pop();
			data = Buffer.concat([last.data, data]);
		}
		const text = data.toString('latin1');
		const shown = /^[\x20-\x7e\r\n]*$/.test(text) ? JSON.stringify(text) : data.toString('hex');
		const cut = shown.length > 400 ? `${shown.slice(0, 200)}…(${data.length} bytes)…${shown.slice(-100)}` : shown;
		const line = `+${at} ${direction} ${cut}`;
		this.lines.push(line);
		this.lastRx = direction == 'RX' ? { line, at, data } : undefined;
	}

	async write(data: Buffer | string): Promise<void> {
		const bytes = Buffer.from(data);
		this.log('TX', bytes);
		await this.port.write(bytes);
	}

	async baud(speed: number): Promise<void> {
		this.note(`baud rate ${speed}`);
		await this.port.update({ baudRate: speed });
	}

	// Whatever arrives within ms, or until done() says the answer is complete
	async read(ms: number, done?: (data: Buffer) => boolean): Promise<Buffer> {
		const deadline = Date.now() + ms;
		const stream = this.port.getParentPort();
		let data = Buffer.alloc(0);
		while (Date.now() < deadline && !done?.(data)) {
			const first = await this.port.read(1, Math.max(1, deadline - Date.now()));
			if (!first?.length)
				break;
			const rest = stream.readableLength ? await this.port.read(stream.readableLength, 1) : undefined;
			const chunk = Buffer.concat([first, rest ?? Buffer.alloc(0)]);
			this.log('RX', chunk);
			data = Buffer.concat([data, chunk]);
		}
		return data;
	}

	// Reads until the line has been quiet for quietMs, for maxMs at most: a phone that
	// keeps resending would otherwise hold the probe forever
	async drain(quietMs: number, maxMs = 10000): Promise<void> {
		const deadline = Date.now() + maxMs;
		while (Date.now() < deadline && (await this.read(Math.min(quietMs, Math.max(1, deadline - Date.now())))).length) {}
	}
}

// The state of one probe run, and its steps
class Probe {
	readonly timing = new Timing();
	readonly problems: string[] = [];
	// What AT+CGMM or BFC answered, for the quirks the client keys on the model
	model: string | null = null;

	constructor(readonly wire: Wire) {}

	// What the probe could not tell, with the step it belongs to
	problem(step: string, text: string): void {
		this.wire.note(`PROBLEM: ${text}`);
		this.problems.push(`${step}: ${text}`);
	}

	// A step that throws is recorded as a problem, with the bytes it exchanged in the
	// evidence, and the probe goes on with what does not depend on it
	async step<T>(name: string, fn: () => Promise<T>, fallback: T): Promise<T> {
		this.wire.step(name);
		try {
			return await fn();
		} catch (e) {
			this.problem(name, `failed: ${(e as Error).message}`);
			return fallback;
		}
	}
}

type AtAnswer = { result: string; lines: string[]; echo: boolean };

// One AT command and its final result line. An echo of the command is set apart,
// and a command left without an answer is followed by a wait for the line to go
// quiet, so that its late answer is not taken for the next command's.
async function at(p: Probe, cmd: string, ms = p.timing.commandWindow()): Promise<AtAnswer> {
	const sent = Date.now();
	await p.wire.write(`${cmd}\r`);
	const text = (await p.wire.read(ms, (data) => FINAL_LINE.test(data.toString('latin1')))).toString('latin1');
	const lines = text.split(/[\r\n]+/).map((line) => line.replace(/[^\x20-\x7e]/g, '').trim()).filter(Boolean);
	const echo = lines.includes(cmd);
	const answer = lines.filter((line) => line != cmd);
	const final = [...answer].reverse().find((line) => FINAL_RESULT.test(line));
	if (!final) {
		p.wire.note(`no answer to ${cmd} within ${ms} ms, waiting for the line to go quiet`);
		await p.wire.drain(p.timing.quiet());
		return { result: 'TIMEOUT', lines: answer, echo };
	}
	const latency = Date.now() - sent;
	p.timing.add(latency);
	p.wire.note(`${cmd}: ${final} after ${latency} ms${echo ? ', echoed' : ''}`);
	return { result: final, lines: answer.filter((line) => line != final), echo };
}

// The speeds the AT interpreter answers at, and whether the first answer was echoed
async function atSpeeds(p: Probe): Promise<{ speeds: number[]; echo: boolean | null }> {
	const speeds: number[] = [];
	let echo: boolean | null = null;
	for (const speed of AT_SPEEDS) {
		await p.wire.baud(speed);
		// what the switch itself left on the line
		await p.wire.drain(200);
		for (let i = 0; i < AT_TRIES; i++) {
			const answer = await at(p, 'ATQ0 V1 E0', p.timing.probeWindow());
			if (answer.result == 'OK') {
				speeds.push(speed);
				echo ??= answer.echo;
				break;
			}
		}
	}
	return { speeds, echo };
}

function request(opcode: number, build: (writer: ObexPacketWriter) => void, id?: number): Buffer {
	const writer = new ObexPacketWriter(opcode);
	build(writer);
	if (id !== undefined)
		writer.appendUint32Header(ObexHeaderId.CONNECTION_ID, id);
	return writer.toBuffer();
}

const connectRequest = () => request(0x80, (w) => {
	w.appendByte(0x10);
	w.appendByte(0x00);
	w.appendUint16(0x4006);
	w.appendHeader(ObexHeaderId.TARGET, OBEX_TARGET_FLEXMEM);
});
const setpathRoot = (id?: number) => request(0x85, (w) => { w.appendByte(0x02); w.appendByte(0x00); w.appendHeader(ObexHeaderId.NAME, Buffer.alloc(0)); }, id);
const setpathDown = (name: string, id?: number) => request(0x85, (w) => { w.appendByte(0x02); w.appendByte(0x00); w.appendUnicodeStringHeader(ObexHeaderId.NAME, name); }, id);
const listingRequest = (id?: number) => request(0x83, (w) => w.appendStringHeader(ObexHeaderId.TYPE, 'x-obex/folder-listing'), id);
const getName = (name: string, id?: number) => request(0x83, (w) => w.appendUnicodeStringHeader(ObexHeaderId.NAME, name), id);
const getNext = (id?: number) => request(0x83, () => {}, id);
const deleteName = (name: string, id?: number) => request(0x82, (w) => w.appendUnicodeStringHeader(ObexHeaderId.NAME, name), id);
const infoRequest = (type: number, id?: number) => request(0x83, (w) => w.appendHeader(ObexHeaderId.APP_PARAMS, Buffer.from([0x32, 0x01, type])), id);

interface Transport {
	// The response packet to one request, undefined when none came
	exchange(request: Buffer, ms?: number): Promise<Buffer | undefined>;
}

// The first whole OBEX response in data, past any bytes left over from the AT phase
function responseIn(data: Buffer): Buffer | undefined {
	for (let i = 0; i + 3 <= data.length; i++) {
		if (!isObexResponseCode(data[i]) || data.readUInt16BE(i + 1) < 3)
			continue;
		const length = data.readUInt16BE(i + 1);
		return data.length >= i + length ? data.subarray(i, i + length) : undefined;
	}
	return undefined;
}

class RawTransport implements Transport {
	constructor(private readonly p: Probe) {}

	async exchange(obex: Buffer, ms = 10000): Promise<Buffer | undefined> {
		await this.p.wire.write(obex);
		const response = responseIn(await this.p.wire.read(ms + this.p.timing.slack(), (data) => !!responseIn(data)));
		if (!response) {
			this.p.wire.note(`no whole OBEX answer within ${ms} ms, waiting for the line to go quiet`);
			await this.p.wire.drain(this.p.timing.quiet());
		}
		return response;
	}
}

type PhonePacket = { marker: number; seq: number; obex: Buffer };
type FrameEvent = { ack?: Buffer; packet?: PhonePacket };

class BfbTransport implements Transport {
	private seq = 0;
	private first = true;
	private buffer = Buffer.alloc(0);
	private packet = Buffer.alloc(0);

	constructor(private readonly p: Probe) {}

	skip(count: number): void {
		this.seq += count;
	}

	async send(obex: Buffer): Promise<number> {
		const seq = this.seq++;
		const marker = this.first ? 0x02 : 0x03;
		this.first = false;
		await this.p.wire.write(encodeBfbPacket(marker, seq, obex));
		return seq;
	}

	async ack(): Promise<void> {
		await this.p.wire.write(ACK);
	}

	// The frames arriving within ms (plus what the phone's measured slowness adds),
	// until done() is satisfied
	async events(ms: number, done?: (events: FrameEvent[]) => boolean): Promise<FrameEvent[]> {
		const events: FrameEvent[] = [];
		const deadline = Date.now() + ms + this.p.timing.slack();
		while (Date.now() < deadline && !done?.(events)) {
			const data = await this.p.wire.read(Math.max(1, Math.min(30, deadline - Date.now())));
			if (!data.length)
				continue;
			this.buffer = Buffer.concat([this.buffer, data]);
			this.parse(events);
		}
		return events;
	}

	async untilPacket(ms = 5000): Promise<FrameEvent[]> {
		const events = await this.events(ms, (e) => e.some((x) => x.packet));
		// an acknowledgement that follows the answer
		return [...events, ...await this.events(300)];
	}

	private parse(events: FrameEvent[]): void {
		while (this.buffer.length >= 3) {
			const [channel, length, check] = this.buffer;
			if ((channel ^ length) != check) {
				this.buffer = this.buffer.subarray(1);
				continue;
			}
			if (this.buffer.length < 3 + length)
				return;
			const frame = Buffer.from(this.buffer.subarray(0, 3 + length));
			const payload = frame.subarray(3);
			this.buffer = this.buffer.subarray(3 + length);
			if (channel != BfbChannel.SERVICE_STREAM)
				continue;
			const startsPacket = payload.length >= 5 && (payload[0] | 1) == 0x03 && (payload[0] ^ payload[1]) == 0xFF;
			if (!this.packet.length && !startsPacket) {
				events.push({ ack: frame });
				continue;
			}
			this.packet = Buffer.concat([this.packet, payload]);
			const size = this.packet.readUInt16BE(3) + 7;
			if (this.packet.length < size)
				continue;
			const data = this.packet;
			events.push({ packet: { marker: data[0], seq: data[2], obex: Buffer.from(data.subarray(5, size - 2)) } });
			this.packet = Buffer.alloc(0);
		}
	}

	async exchange(obex: Buffer, ms = 5000): Promise<Buffer | undefined> {
		await this.send(obex);
		const packet = (await this.events(ms, (e) => e.some((x) => x.packet))).find((x) => x.packet)?.packet;
		if (packet)
			await this.ack();
		else
			this.p.wire.note(`no BFB packet within ${ms} ms`);
		return packet?.obex;
	}
}

// A whole GET; code is -1 when an answer did not come
async function getAll(t: Transport, first: Buffer, id?: number): Promise<{ code: number; body: Buffer; chunks: number[] }> {
	const chunks: number[] = [];
	let body = Buffer.alloc(0);
	let response = await t.exchange(first);
	while (response) {
		const headers = parseObexHeaders(response);
		const part = headers.get(ObexHeaderId.BODY) ?? headers.get(ObexHeaderId.END_OF_BODY);
		if (part) {
			chunks.push(part.length);
			body = Buffer.concat([body, part]);
		}
		if (response[0] != 0x90)
			return { code: response[0], body, chunks };
		response = await t.exchange(getNext(id));
	}
	return { code: -1, body, chunks };
}

// A whole upload, answered with the last response code or -1
async function putAll(t: Transport, name: string, data: Buffer, maxPacket: number, id?: number): Promise<number> {
	let response = await t.exchange(request(0x02, (w) => w.appendUnicodeStringHeader(ObexHeaderId.NAME, name), id));
	if (response?.[0] != 0x90)
		return response?.[0] ?? -1;
	const room = maxPacket - 6 - (id !== undefined ? 5 : 0);
	for (let offset = 0; ;) {
		const chunk = data.subarray(offset, offset + room);
		offset += chunk.length;
		const last = offset >= data.length;
		response = await t.exchange(request(last ? 0x82 : 0x02, (w) => w.appendHeader(last ? ObexHeaderId.END_OF_BODY : ObexHeaderId.BODY, chunk), id));
		if (!response)
			return -1;
		if (last || response[0] != 0x90)
			return response[0];
	}
}

const codeName = (code: number) => code < 0 ? 'no answer' : hex(code);

async function codeOf(t: Transport, obex: Buffer): Promise<string | null> {
	const response = await t.exchange(obex);
	return response ? hex(response[0]) : null;
}

// Enters a folder from the root, one SETPATH per level
async function enter(p: Probe, t: Transport, dir: string, id?: number): Promise<boolean> {
	await t.exchange(setpathRoot(id));
	for (const part of dir.split('/').filter(Boolean)) {
		const response = await t.exchange(setpathDown(part, id));
		if (!response || !isSuccess(response[0])) {
			p.wire.note(`can't enter ${part}: ${response ? hex(response[0]) : 'no answer'}`);
			return false;
		}
	}
	return true;
}

// Where the file checks and the e2e suite write when given no folder: x65 and x75
// phones have /Data/Misc and the CX70 /Data/System/tmp, while the EGOLD phones have
// no Data folder, a C60 and a CF62 have /tmp, an M56 /Misc, an A56 only media
// folders. Not /Inbox: the A56 keeps what is deleted there, and after a few
// deletes it stops answering until a power cycle.
export const WRITABLE_DIR_CANDIDATES = ['/Data/Misc', '/Data/System/tmp', '/tmp', '/Misc', '/Bitmap'];

// The candidates the listings show, in the order of WRITABLE_DIR_CANDIDATES and spelled
// the way the phone lists them. Only folders a listing shows are entered, no path is
// tried on a guess. Their permissions don't count: the M56 grants write access in
// group-perm alone, so an upload decides.
export async function findListedDirs(list: (dir: string) => Promise<ObexDirEntry[]>): Promise<string[]> {
	const listings = new Map<string, Promise<ObexDirEntry[]>>();
	const listOnce = (dir: string) => {
		if (!listings.has(dir))
			listings.set(dir, list(dir));
		return listings.get(dir)!;
	};
	const found: string[] = [];
	for (const candidate of WRITABLE_DIR_CANDIDATES) {
		let dir = '';
		let folder: ObexDirEntry | undefined;
		for (const name of candidate.split('/').filter(Boolean)) {
			folder = (await listOnce(dir || '/')).find((entry) => entry.isDir && entry.name.toLowerCase() == name.toLowerCase());
			if (!folder)
				break;
			dir = `${dir}/${folder.name}`;
		}
		if (folder)
			found.push(dir);
	}
	return found;
}

async function probeObex(p: Probe, t: Transport, connect: Buffer | undefined, dir: string | undefined): Promise<ObexBehavior | null> {
	if (!connect || connect.length < 7) {
		p.problem('obex.connect', 'no answer to CONNECT, the OBEX behaviors were not measured');
		return null;
	}
	// Like the client, an A56 enters its folder again after each upload
	const forgetsFolder = forgetsFolderAfterPut(p.model ?? undefined);
	const idHeader = parseObexHeaders(connect, 7).get(ObexHeaderId.CONNECTION_ID);
	const connectionId = idHeader?.length == 4 ? idHeader.readUInt32BE(0) : undefined;
	const maxPacket = connect.readUInt16BE(5);

	// Settles whether the phone refuses requests without the connection id
	let id: number | undefined;
	const idCodes = await p.step('obex.connectionId', async (): Promise<ObexBehavior['connectionId']> => {
		if (connectionId === undefined) {
			p.wire.note('no connection id in the CONNECT answer');
			return { without: null, with: null };
		}
		const without = await getAll(t, listingRequest());
		const withId = await getAll(t, listingRequest(connectionId), connectionId);
		p.wire.note(`a folder listing without the connection id: ${codeName(without.code)}, with it: ${codeName(withId.code)}`);
		if (without.code < 0 || withId.code < 0)
			p.problem('obex.connectionId', 'a listing got no answer, so whether the id is needed is not known');
		// the rest goes the way the phone takes requests
		if (!isSuccess(without.code) && isSuccess(withId.code))
			id = connectionId;
		p.wire.note(`requests go on ${id !== undefined ? 'with' : 'without'} the connection id`);
		return { without: without.code < 0 ? null : hex(without.code), with: withId.code < 0 ? null : hex(withId.code) };
	}, { without: null, with: null });

	const { rootFolders, listingPrologue } = await p.step('obex.listing', async () => {
		await t.exchange(setpathRoot(id));
		const listing = await getAll(t, listingRequest(id), id);
		if (!isSuccess(listing.code))
			p.problem('obex.listing', `the root listing answered ${codeName(listing.code)}`);
		const xml = listing.body.toString('utf8');
		const firstEntry = xml.search(/<(file|folder)[\s/>]/i);
		const folders = parseFolderListing(xml).filter((entry) => entry.isDir).map((entry) => entry.name);
		p.wire.note(`root folders: ${folders.join(', ')}`);
		return {
			rootFolders: folders,
			listingPrologue: firstEntry >= 0 ? xml.slice(0, firstEntry) : xml.replace(/<\/folder-listing>\s*$/, ''),
		};
	}, { rootFolders: [] as string[], listingPrologue: '' });

	// Where the file checks may write: the folder given, or the candidates, of which
	// the file checks take the first that gives an upload back
	const dirs = dir ? [dir] : await p.step('obex.dir', async () => {
		const found = await findListedDirs(async (path) => {
			if (!await enter(p, t, path, id))
				return [];
			const listing = await getAll(t, listingRequest(id), id);
			return isSuccess(listing.code) ? parseFolderListing(listing.body.toString('utf8')) : [];
		});
		p.wire.note(found.length ? `listed: ${found.join(', ')}` :
			`none of ${WRITABLE_DIR_CANDIDATES.join(', ')} is listed, give a folder to write into with --dir`);
		return found;
	}, [] as string[]);

	const codes: ObexBehavior['codes'] = {
		setpathMissing: null,
		getMissing: null,
		deleteMissing: null,
		deleteMissingInJava: null,
		abortIdle: null,
		disconnect: null,
	};
	await p.step('obex.codes', async () => {
		codes.setpathMissing = await codeOf(t, setpathDown('probe-missing-dir', id));
		await t.exchange(setpathRoot(id));
		codes.getMissing = await codeOf(t, getName(MISSING_FILE, id));
		codes.abortIdle = await codeOf(t, request(0xFF, () => {}, id));
		if (dirs.length && await enter(p, t, dirs[0], id))
			codes.deleteMissing = await codeOf(t, deleteName(MISSING_FILE, id));
	}, undefined);

	const files = await p.step('obex.files', async () => {
		const result = {
			writableDir: null as string | null,
			getChunk: null as number | null,
			overwrite: null as ObexBehavior['overwrite'],
			caseInsensitive: null as boolean | null,
		};
		if (!dirs.length) {
			p.problem('obex.files', 'no folder to write into was found, the file checks were skipped: give one with --dir');
			return result;
		}
		// A folder may take uploads without keeping them: the A56's /Bitmap has
		// answered the GET of what was just uploaded with an empty file
		const tried: string[] = [];
		for (const candidate of dirs) {
			if (!await enter(p, t, candidate, id)) {
				tried.push(`${candidate} can't be entered`);
				continue;
			}
			try {
				const first = await putAll(t, PROBE_FILE, Buffer.alloc(3000, 0x41), maxPacket, id);
				if (forgetsFolder)
					await enter(p, t, candidate, id);
				const kept = await getAll(t, getName(PROBE_FILE, id), id);
				p.wire.note(`in ${candidate}, the upload of 3000 bytes answered ${codeName(first)}, ` +
					`${PROBE_FILE} reads back ${codeName(kept.code)} with ${kept.body.length} bytes in packets of ${kept.chunks.join(', ')}`);
				if (!isSuccess(first) || !isSuccess(kept.code) || !kept.body.equals(Buffer.alloc(3000, 0x41))) {
					tried.push(`${candidate} ${isSuccess(first) ? `gives back ${kept.body.length} of the 3000 bytes uploaded` : `refuses the upload with ${codeName(first)}`}`);
					continue;
				}
				result.writableDir = '/' + candidate.split('/').filter(Boolean).join('/');
				result.getChunk = kept.chunks.length > 1 ? kept.chunks[0] : null;
				// An upload over an existing file leaves an A56 confused about its folder
				// until it hangs, and the client deletes first anyway
				let back = kept;
				if (forgetsFolder) {
					p.wire.note('no upload over the file: it confuses this model');
				} else {
					const second = await putAll(t, PROBE_FILE, Buffer.alloc(100, 0x42), maxPacket, id);
					back = await getAll(t, getName(PROBE_FILE, id), id);
					p.wire.note(`the upload of 100 bytes over it answered ${codeName(second)}, ${PROBE_FILE} now reads back ${codeName(back.code)} with ${back.body.length} bytes`);
					if (!isSuccess(second) || !isSuccess(back.code)) {
						p.problem('obex.files', 'the upload over the file or its download failed, overwrite and the case of names are not known');
						return result;
					}
					result.overwrite = back.body.length == 3100 ? 'append' : back.body.length == 100 ? 'replace' : 'other';
				}
				const upper = await getAll(t, getName(PROBE_FILE.toUpperCase(), id), id);
				if (upper.code < 0)
					p.problem('obex.files', `the GET of ${PROBE_FILE.toUpperCase()} got no answer, the case of names is not known`);
				else
					result.caseInsensitive = isSuccess(upper.code) && upper.body.equals(back.body);
				return result;
			} finally {
				// An A56 keeps a file whose delete does not come right after entering the folder
				if (forgetsFolder)
					await enter(p, t, candidate, id);
				p.wire.note(`deleting ${PROBE_FILE}: ${await codeOf(t, deleteName(PROBE_FILE, id))}`);
			}
		}
		p.problem('obex.files', `no folder keeps an uploaded file, the file checks were skipped: ${tried.join('; ')}`);
		return result;
	}, { writableDir: null, getChunk: null, overwrite: null, caseInsensitive: null });

	await p.step('obex.java', async () => {
		const java = rootFolders.find((folder) => folder.toLowerCase() == 'java');
		if (java && await enter(p, t, java, id))
			codes.deleteMissingInJava = await codeOf(t, deleteName(MISSING_FILE, id));
		else
			p.wire.note('no Java folder to try a delete in');
	}, undefined);

	// Asked at the root, then again in the writable folder, in case a phone answers
	// per folder
	const info = await p.step('obex.info', async () => {
		const answered = { capacity: false, available: false };
		const ask = async (where: string, record: boolean) => {
			const values: string[] = [];
			for (const [key, type] of [['capacity', 0x01], ['available', 0x02]] as const) {
				const response = await t.exchange(infoRequest(type, id));
				const params = response && parseObexHeaders(response).get(ObexHeaderId.APP_PARAMS);
				values.push(`${key} ${params?.[0] == 0x32 ? params.subarray(2, 2 + params[1]).reduce((value, byte) => value * 256 + byte, 0) : 'none'}`);
				if (!record)
					continue;
				if (!response)
					p.problem('obex.info', `the ${key} request got no answer`);
				answered[key] = !!response && isSuccess(response[0]) && !!params;
			}
			p.wire.note(`in ${where}: ${values.join(', ')}`);
		};
		await t.exchange(setpathRoot(id));
		await ask('the root', true);
		const infoDir = files.writableDir ?? dirs[0];
		if (infoDir && await enter(p, t, infoDir, id))
			await ask(infoDir, false);
		return answered;
	}, { capacity: false, available: false });

	await p.step('obex.codes', async () => {
		codes.disconnect = await codeOf(t, request(0x81, () => {}, id));
	}, undefined);

	return {
		connect: {
			code: hex(connect[0]),
			version: hex(connect[3]),
			flags: hex(connect[4]),
			maxPacket,
			connectionId: connectionId !== undefined,
		},
		connectionId: idCodes,
		codes,
		rootFolders,
		listingPrologue,
		...files,
		info,
	};
}

// The escape of siefs and the OBEX client: DISCONNECT, then +++ with silence on both
// sides. False when the escape was left out: a cable that refuses to set DTR, like
// the DCA-540, is a USB link to an x65 that takes +++ for the start of an OBEX packet
// and answers nothing until a power cycle.
async function escapeRaw(p: Probe): Promise<boolean> {
	await p.wire.drain(p.timing.quiet());
	await p.wire.write(Buffer.from([0x81, 0x00, 0x03]));
	await p.wire.drain(200);
	try {
		await p.wire.port.setSignals({ dtr: true });
	} catch (e) {
		p.wire.note(`the cable refuses to set DTR (${(e as Error).message}), so no +++: the phone stays in OBEX mode, power-cycle it before the next probe`);
		return false;
	}
	await delay(ESCAPE_GUARD_MS);
	await p.wire.write('+++');
	await delay(ESCAPE_GUARD_MS);
	await p.wire.drain(p.timing.quiet());
	return true;
}

// A phone already in BFC mode, and the speed it answered at. BFC's own frames are
// not in the evidence, only what they answered.
async function findBfc(p: Probe): Promise<{ bfc: BFC; speed: number } | undefined> {
	const bfc = new BFC(p.wire.port);
	try {
		await bfc.connect({ switchFromAt: false });
	} catch (e) {
		bfc.detach();
		p.wire.note(`no BFC answer: ${(e as Error).message}`);
		return undefined;
	}
	p.wire.note(`BFC answers at ${p.wire.port.baudRate} baud`);
	return { bfc, speed: p.wire.port.baudRate };
}

async function probeRaw(p: Probe, dir: string | undefined, connect?: Buffer): Promise<{ raw: RawBehavior; obex: ObexBehavior | null }> {
	const t = new RawTransport(p);
	let obex: ObexBehavior | null = null;
	let escaped = false;
	try {
		if (!connect) {
			connect = await p.step('obex.connect', async () => {
				await delay(300);
				return t.exchange(connectRequest());
			}, undefined);
		}
		obex = await probeObex(p, t, connect, dir);
	} finally {
		// The phone goes back to its AT interpreter whatever happened above
		p.wire.step('raw.escape');
		escaped = await escapeRaw(p);
	}
	const escapeSpeeds = escaped ? await p.step('raw.escape', async () => (await atSpeeds(p)).speeds, []) : [];
	return { raw: { escape: escaped ? 'plus' : 'none', escapeSpeeds }, obex };
}

function classifySequence(pairs: { ours: number; theirs: number }[]): BfbBehavior['sequence'] {
	if (pairs.length < 2)
		return 'unknown';
	if (pairs.every((pair) => pair.theirs == pair.ours))
		return 'echo';
	if (pairs.every((pair) => pair.theirs == pairs[0].theirs))
		return 'constant';
	if (pairs.every((pair, i) => i == 0 || pair.theirs == ((pairs[i - 1].theirs + 1) & 0xFF)))
		return 'counter';
	return 'unknown';
}

async function probeBfb(p: Probe, dir: string | undefined): Promise<{ bfb: BfbBehavior; obex: ObexBehavior | null }> {
	const bfb: BfbBehavior = {
		helloSpeed: null,
		helloAnswer: null,
		ackFrame: null,
		ackBeforeResponse: null,
		firstMarker: null,
		laterMarker: null,
		sequence: 'unknown',
		leaveSpeeds: [],
	};
	let obex: ObexBehavior | null = null;
	try {
		await delay(300 + p.timing.slack());
		await p.step('bfb.hello', async () => {
			hello: for (const speed of BFB_SPEEDS) {
				await p.wire.baud(speed);
				for (let i = 0; i < 2; i++) {
					await p.wire.drain(200);
					await p.wire.write(HELLO);
					const answer = await p.wire.read(1000 + p.timing.slack(), (data) => data.length >= 5);
					if (answer.length) {
						bfb.helloSpeed = speed;
						bfb.helloAnswer = answer.toString('hex');
						break hello;
					}
				}
			}
			if (!bfb.helloSpeed)
				p.problem('bfb.hello', `the hello was answered at none of ${BFB_SPEEDS.join(', ')}, the BFB behaviors were not measured`);
		}, undefined);
		if (!bfb.helloSpeed)
			return { bfb, obex };
		const t = new BfbTransport(p);

		// The phone's first packet, and its acknowledgement of ours
		const pairs: { ours: number; theirs: number }[] = [];
		const connect = await p.step('bfb.connect', async () => {
			const ours = await t.send(connectRequest());
			const connectEvents = await t.untilPacket();
			const answer = connectEvents.find((e) => e.packet);
			const ack = connectEvents.find((e) => e.ack);
			bfb.ackFrame = ack?.ack?.toString('hex') ?? null;
			bfb.ackBeforeResponse = ack && answer ? connectEvents.indexOf(ack) < connectEvents.indexOf(answer) : null;
			if (answer) {
				bfb.firstMarker = hex(answer.packet!.marker);
				pairs.push({ ours, theirs: answer.packet!.seq });
				await t.ack();
			}
			return answer?.packet?.obex;
		}, undefined);

		// A counter, our number echoed, or always the same? A jump in our numbering tells
		// an echo from a counter that happens to run in step with ours
		await p.step('bfb.sequence', async () => {
			for (let i = 0; i < 4; i++) {
				if (i == 3)
					t.skip(5);
				const seq = await t.send(setpathRoot());
				const answer = (await t.untilPacket()).find((e) => e.packet)?.packet;
				if (!answer) {
					p.wire.note(`packet ${seq} got no answer`);
					continue;
				}
				pairs.push({ ours: seq, theirs: answer.seq });
				bfb.laterMarker = hex(answer.marker);
				await t.ack();
			}
			bfb.sequence = classifySequence(pairs);
			p.wire.note(`sequence numbers, ours -> the phone's: ${pairs.map((pair) => `${pair.ours}->${pair.theirs}`).join(' ')}`);
		}, undefined);

		obex = await probeObex(p, t, connect, dir);
	} finally {
		// Back to the AT interpreter whatever happened above: at the speed the hello
		// was answered at, or at every BFB speed when none was
		p.wire.step('bfb.leave');
		for (const speed of bfb.helloSpeed ? [bfb.helloSpeed] : BFB_SPEEDS) {
			await p.wire.baud(speed);
			await p.wire.write(LEAVE);
			await delay(300);
		}
		await p.wire.drain(p.timing.quiet());
	}
	bfb.leaveSpeeds = await p.step('bfb.leave', async () => (await atSpeeds(p)).speeds, []);
	return { bfb, obex };
}

export async function probePhone(port: AsyncSerialPort, options: ProbeOptions = {}): Promise<PhoneEntry> {
	const p = new Probe(new Wire(port));
	const entry: PhoneEntry = {
		schema: SCHEMA_VERSION,
		id: options.id ?? 'unnamed',
		source: options.source ?? 'hardware',
		recorded: { date: new Date().toISOString().slice(0, 10), tool: 'tests/obex/phones/probe.ts', ...(options.notes ? { notes: options.notes } : {}) },
		identity: { vendor: null, model: null, revision: null },
		at: { speeds: [], latencyMs: null, echo: null, results: {} },
		transport: 'unknown',
		bfc: null,
		bfb: null,
		raw: null,
		obex: null,
		problems: p.problems,
		evidence: p.wire.evidence,
	};
	// On some hosts (seen with Node 26 and a USB serial cable) the port becoming
	// readable does not wake the event loop, and a read waiting for the answer only
	// gets it when some timer fires. A timer that fires regularly keeps the answers
	// on time, and the latencies the probe measures true.
	const wake = setInterval(() => {}, 10);
	try {
		await probeModes(p, entry, options);
	} finally {
		clearInterval(wake);
		entry.at.latencyMs = p.timing.median;
	}
	return entry;
}

// A phone on a service cable in BFC mode, like an SL65, answers no AT: the OBEX
// client reads its identity through BFC and switches it with AT^SQWE=3 through
// BFC's AT tunnel, and so does the probe. False when BFC does not answer either.
async function probeViaBfc(p: Probe, entry: PhoneEntry, options: ProbeOptions): Promise<boolean> {
	p.wire.step('bfc');
	const found = await findBfc(p);
	if (!found)
		return false;
	const { bfc, speed } = found;
	entry.bfc = { speed };
	await p.step('bfc.identity', async () => {
		const ask = (what: string, request: () => Promise<string>) => request().then((value) => value, (e: Error) => {
			p.problem('bfc.identity', `the ${what} request failed: ${e.message}`);
			return null;
		});
		entry.identity = {
			vendor: await ask('vendor', () => bfc.getVendorName()),
			model: await ask('product', () => bfc.getProductName()),
			revision: await ask('software version', () => bfc.getSwVersion()),
		};
		p.model = entry.identity.model;
		p.wire.note(`identity through BFC: ${JSON.stringify(entry.identity)}`);
	}, undefined);
	const tunnel = async (cmd: string, ms: number): Promise<string> => {
		const result = await bfc.sendAT(`${cmd}\r`, ms).then(
			(answer) => answer.match(/\r\n(OK|ERROR|\+CM[ES] ERROR[^\r]*)\r\n$/)?.[1] ?? answer.trim(),
			(e: Error) => /timeout/i.test(e.message) ? 'TIMEOUT' : `failed: ${e.message}`);
		p.wire.note(`${cmd} through BFC: ${result}`);
		entry.at.results[cmd] = result;
		return result;
	};
	p.wire.step('bfc.mode');
	await tunnel('AT^SQWE=0', 2000);
	await delay(200);
	// Like the client: the phone may switch the wire without answering first
	const sqwe3 = await tunnel('AT^SQWE=3', 1000);
	bfc.detach();
	if (sqwe3.startsWith('failed:')) {
		p.problem('bfc.mode', 'the tunnel failed, so whether the phone has raw OBEX is not known');
	} else if (sqwe3 != 'OK' && sqwe3 != 'TIMEOUT') {
		// It stays in BFC mode, where it was found
		entry.transport = 'none';
	} else {
		entry.transport = 'raw';
		Object.assign(entry, await probeRaw(p, options.dir));
	}
	return true;
}

async function probeModes(p: Probe, entry: PhoneEntry, options: ProbeOptions): Promise<void> {
	const found = await p.step('at.speeds', () => atSpeeds(p), { speeds: [], echo: null });
	entry.at.speeds = found.speeds;
	entry.at.echo = found.echo;
	if (!found.speeds.length) {
		if (await probeViaBfc(p, entry, options))
			return;
		p.problem('at.speeds', 'no AT answer at any speed, nor BFC. The phone may be off, on a cable that does not reach its AT ' +
			'interpreter, or still in OBEX or BFB mode from an interrupted session: power-cycle it and probe again.');
		return;
	}

	await p.step('at.identity', async () => {
		await p.wire.baud(found.speeds[0]);
		await p.wire.drain(200);
		// an autobauding phone locks onto the speed with the first command
		await at(p, 'ATQ0 V1 E0');
		const ask = async (cmd: string) => {
			const answer = await at(p, cmd);
			if (answer.result == 'TIMEOUT')
				p.problem('at.identity', `${cmd} got no answer`);
			return answer.result == 'OK' ? answer.lines[0] ?? '' : null;
		};
		entry.identity = { vendor: await ask('AT+CGMI'), model: await ask('AT+CGMM'), revision: await ask('AT+CGMR') };
		p.model = entry.identity.model;
	}, undefined);

	await p.step('at.mode', async () => {
		const sqwe0 = await at(p, 'AT^SQWE=0');
		entry.at.results['AT^SQWE=0'] = sqwe0.result;
		await delay(200);
		const sqwe3 = await at(p, 'AT^SQWE=3');
		entry.at.results['AT^SQWE=3'] = sqwe3.result;
		let connect: Buffer | undefined;
		if (sqwe3.result == 'TIMEOUT') {
			// Switched without answering? An OBEX CONNECT tells, and the escape takes the
			// phone back if it switched but does not answer that either
			p.wire.note('AT^SQWE=3 got no answer, trying an OBEX CONNECT in case the wire switched anyway');
			connect = await new RawTransport(p).exchange(connectRequest(), 3000);
			if (!connect) {
				await escapeRaw(p);
				await at(p, 'ATQ0 V1 E0');
			}
		}
		if (sqwe3.result == 'OK' || connect) {
			entry.transport = 'raw';
			Object.assign(entry, await probeRaw(p, options.dir, connect));
			return;
		}

		// Like the client, only a phone without AT^SQWE gets AT^SBFB=1: an x65 takes it
		// too, and then does not answer in BFB frames
		p.wire.step('at.mode');
		const sbfb = sqwe0.result == 'OK' ? undefined : (await at(p, 'AT^SBFB=1')).result;
		if (sbfb)
			entry.at.results['AT^SBFB=1'] = sbfb;
		if (sbfb == 'OK' || sbfb == 'TIMEOUT') {
			// A timeout may still have switched: the hello tells
			const { bfb, obex } = await probeBfb(p, options.dir);
			Object.assign(entry, { bfb, obex, transport: bfb.helloSpeed ? 'bfb' : 'unknown' });
			return;
		}
		if (sqwe3.result == 'TIMEOUT')
			p.problem('at.mode', 'AT^SQWE=3 got no answer, so whether the phone has raw OBEX is not known');
		else
			entry.transport = 'none';
	}, undefined);

	// Echo is the phone's state rather than its firmware's: the probe turned it off,
	// and leaves the phone the way it found it
	if (found.echo) {
		const speed = entry.raw?.escapeSpeeds[0] ?? entry.bfb?.leaveSpeeds[0] ?? (entry.transport == 'none' ? found.speeds[0] : undefined);
		if (speed) {
			await p.step('at.restore', async () => {
				await p.wire.baud(speed);
				await p.wire.drain(200);
				await at(p, 'ATE1');
			}, undefined);
		}
	}
}
