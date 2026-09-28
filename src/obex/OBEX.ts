import createDebug from 'debug';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { AtChannel } from '#src/at/AtChannel.js';
import { BFC } from '#src/bfc/BFC.js';
import { BaseSerialProtocol } from '#src/BaseSerialProtocol.js';
import { ObexBfbLink, BfbTimeouts } from './ObexBfbLink.js';
import { delay, flushInput, readExact, trySetBaudRate } from '#src/utils.js';

const debug = createDebug('obex');
const debugTrx = createDebug('obex:trx');

// Siemens FlexMem OBEX target UUID, the same one used by SiMoCo/siefs
export const OBEX_TARGET_FLEXMEM = Buffer.from([
	0x6b, 0x01, 0xcb, 0x31, 0x41, 0x06, 0x11, 0xd4,
	0x9a, 0x77, 0x00, 0x50, 0xda, 0x3f, 0x47, 0x1f,
]);

export const OBEX_VERSION_1_0 = 0x10;

export enum ObexOpcode {
	PUT = 0x02,
	CONNECT = 0x80,
	DISCONNECT = 0x81,
	PUT_FINAL = 0x82,
	GET_FINAL = 0x83,
	SETPATH = 0x85,
	ABORT = 0xFF,
}

export enum ObexHeaderId {
	NAME = 0x01,
	TYPE = 0x42,
	TARGET = 0x46,
	BODY = 0x48,
	END_OF_BODY = 0x49,
	WHO = 0x4A,
	APP_PARAMS = 0x4C,
	CONNECTION_ID = 0xCB,
	LENGTH = 0xC3,
}

export enum ObexResponse {
	CONTINUE = 0x90,
	SUCCESS = 0xA0,
	NO_CONTENT = 0xA4,
}

const OBEX_ERROR_MESSAGES: Record<number, string> = {
	0x40: 'Bad request',
	0x41: 'Unauthorized',
	0x42: 'Payment required',
	0x43: 'Forbidden',
	0x44: 'Not found',
	0x45: 'Method not allowed',
	0x46: 'Not acceptable',
	0x47: 'Proxy authentication required',
	0x48: 'Request timeout',
	0x49: 'Conflict',
	0x4A: 'Gone',
	0x4B: 'Length required',
	0x4C: 'Precondition failed',
	0x4D: 'Requested entity too large',
	0x4E: 'Request URL too large',
	0x4F: 'Unsupported media type',
	0x50: 'Internal server error',
	0x51: 'Not implemented',
	0x52: 'Bad gateway',
	0x53: 'Service unavailable',
	0x54: 'Gateway timeout',
	0x55: 'HTTP version not supported',
	0x60: 'Database full',
	0x61: 'Database locked',
};

const OBEX_RESPONSE_CODES = new Set<number>([
	0x10,
	0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
	0x30, 0x31, 0x32, 0x33, 0x34, 0x35,
	...Object.keys(OBEX_ERROR_MESSAGES).map(Number),
]);

// OBEX 1.x sets the final bit on every response. Without it, the "O" (0x4F) of
// an OK left from the AT phase would pass for one.
export function isObexResponseCode(byte: number): boolean {
	return (byte & 0x80) != 0 && OBEX_RESPONSE_CODES.has(byte & 0x7F);
}

function isNotFound(code: number): boolean {
	return (code & 0x7F) == 0x44;
}

export function obexResponseName(code: number): string {
	const base = code & 0x7F;
	return OBEX_ERROR_MESSAGES[base] ?? `Unknown response 0x${code.toString(16)}`;
}

// Most cables run at 115200, freshly booted EGOLD phones at 19200, a DCA-510 at 57600
const AT_PROBE_SPEEDS = [115200, 57600, 19200, 230400, 9600, 38400];

// How long AtChannel.handshake() waits for each answer
const AT_PROBE_TIMEOUT = 150;

// SiMoCo's offer. The phone answers its own limit (a C60 474), the smaller one is kept.
const REQUESTED_MAX_PACKET_SIZE = 0x4006;

// The packet size every OBEX peer has to take
const OBEX_MIN_PACKET_SIZE = 255;

const SETPATH_UP = 0x01;
const SETPATH_DONT_CREATE = 0x02;

type ObexResponsePacket = {
	code: number;
	packet: Buffer;
};

export type ObexDirEntry = {
	name: string;
	isDir: boolean;
	size: number;
	mtime?: Date;
	readable: boolean;
	writable: boolean;
	hidden: boolean;
};

export type ObexProgress = {
	percent: number;
	cursor: number;
	total: number;
	speed: number;
};

export type PhonePlatform = 'SGOLD' | 'NewSGOLD' | 'EGOLD' | 'unknown';

export type ObexTransferOptions = {
	// Cancels the transfer between two packets, the phone is told with an ABORT
	signal?: AbortSignal;
};

// Protocol delays and timeouts, in ms
export type ObexDelays = {
	escape: number;      // the silence on both sides of the +++ escape
	flush: number;       // input flush read timeout
	response: number;    // for the answer to a request
	abort: number;       // for the answer to an ABORT or a DISCONNECT
};

const SQWE_RESET_DELAY = 200;
const MODE_SWITCH_DELAY = 300;
const AT_COMMAND_TIMEOUT = 2000;
// For the answer to the ABORT that asks whether the phone is still in OBEX mode
const OBEX_MODE_CHECK_TIMEOUT = 500;

function pathParts(path: string): string[] {
	return path.split(/[\/\\]+/).filter((part) => part && part != '.');
}

function splitPath(path: string): { dir: string[]; name: string } {
	const parts = pathParts(path);
	const name = parts.pop() ?? '';
	return { dir: parts, name };
}

function strToUcs2be(str: string): Buffer {
	return Buffer.from(str, 'utf16le').swap16();
}

// A TLV of the Siemens "move" application parameters, the length is a single byte
function moveParam(tag: number, value: Buffer): Buffer {
	if (value.length > 0xFF)
		throw new Error(`Path is too long for an OBEX move (${value.length} bytes, 255 max).`);
	return Buffer.concat([Buffer.from([tag, value.length]), value]);
}

export class ObexPacketWriter {
	private readonly opcode: number;
	private readonly parts: Buffer[] = [];

	constructor(opcode: number) {
		this.opcode = opcode;
	}

	getOpcode(): number {
		return this.opcode;
	}

	appendByte(value: number): void {
		this.parts.push(Buffer.from([value]));
	}

	appendUint16(value: number): void {
		const buffer = Buffer.alloc(2);
		buffer.writeUInt16BE(value);
		this.parts.push(buffer);
	}

	appendHeader(headerId: ObexHeaderId, value: Buffer): void {
		const header = Buffer.alloc(3);
		header[0] = headerId;
		header.writeUInt16BE(value.length + 3, 1);
		this.parts.push(header, value);
	}

	appendUint32Header(headerId: ObexHeaderId, value: number): void {
		const header = Buffer.alloc(5);
		header[0] = headerId;
		header.writeUInt32BE(value, 1);
		this.parts.push(header);
	}

	appendStringHeader(headerId: ObexHeaderId, str: string): void {
		this.appendHeader(headerId, Buffer.concat([Buffer.from(str, 'latin1'), Buffer.from([0x00])]));
	}

	appendUnicodeStringHeader(headerId: ObexHeaderId, str: string): void {
		this.appendHeader(headerId, Buffer.concat([strToUcs2be(str), Buffer.from([0x00, 0x00])]));
	}

	toBuffer(): Buffer {
		const packet = Buffer.concat([Buffer.from([this.opcode, 0, 0]), ...this.parts]);
		packet.writeUInt16BE(packet.length, 1);
		return packet;
	}
}

// The headers of a packet, which start at offset 3 except in CONNECT (7)
export function parseObexHeaders(packet: Buffer, offset = 3): Map<ObexHeaderId, Buffer> {
	const result = new Map<ObexHeaderId, Buffer>();
	const totalLen = Math.min((packet[1] << 8) | packet[2], packet.length);
	let pos = offset;
	while (pos < totalLen) {
		const headerId = packet[pos] as ObexHeaderId;
		switch (headerId & 0xC0) {
			case 0x00:
			case 0x40: {
				if (pos + 3 > totalLen)
					return result;
				const headerLen = (packet[pos + 1] << 8) | packet[pos + 2];
				if (headerLen < 3 || pos + headerLen > totalLen)
					return result;
				result.set(headerId, packet.subarray(pos + 3, pos + headerLen));
				pos += headerLen;
				break;
			}
			case 0x80: {
				if (pos + 2 > totalLen)
					return result;
				result.set(headerId, packet.subarray(pos + 1, pos + 2));
				pos += 2;
				break;
			}
			case 0xC0: {
				if (pos + 5 > totalLen)
					return result;
				result.set(headerId, packet.subarray(pos + 1, pos + 5));
				pos += 5;
				break;
			}
		}
	}
	return result;
}

function decodeCharacterReference(reference: string, code: number): string {
	return code <= 0x10FFFF ? String.fromCodePoint(code) : reference;
}

const XML_ENTITIES: Record<string, string> = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// In a single pass, so that a decoded & never starts another reference
function decodeXmlEntities(str: string): string {
	return str.replace(/&(?:#[xX]([0-9a-fA-F]+)|#(\d+)|(lt|gt|quot|apos|amp));/g, (reference, hex, dec, name) => {
		if (hex !== undefined)
			return decodeCharacterReference(reference, parseInt(hex, 16));
		if (dec !== undefined)
			return decodeCharacterReference(reference, +dec);
		return XML_ENTITIES[name];
	});
}

// Siemens phones quote with " and write local times, the rest of XML is read too
export function parseFolderListing(xml: string): ObexDirEntry[] {
	const entries: ObexDirEntry[] = [];
	const tagRegex = /<(file|folder)(?=[\s/>])((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
	let tag: RegExpExecArray | null;
	while ((tag = tagRegex.exec(xml)) !== null) {
		const isDir = tag[1].toLowerCase() == 'folder';
		const attrs: Record<string, string> = {};
		const attrRegex = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
		let attr: RegExpExecArray | null;
		while ((attr = attrRegex.exec(tag[2])) !== null)
			attrs[attr[1].toLowerCase()] = decodeXmlEntities(attr[2] ?? attr[3]);
		if (!attrs['name'])
			continue;

		// YYYYMMDDTHHMMSS in local time, or in UTC with a trailing Z
		let mtime: Date | undefined;
		const timeMatch = attrs['modified']?.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/i);
		if (timeMatch) {
			const [year, month, day, hours, minutes, seconds] = timeMatch.slice(1, 7).map(Number);
			mtime = timeMatch[7] ?
				new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds)) :
				new Date(year, month - 1, day, hours, minutes, seconds);
		}

		const userPerms = attrs['user-perm'] ?? 'RWD';
		const readable = /r/i.test(userPerms);
		entries.push({
			name: attrs['name'],
			isDir,
			size: attrs['size'] ? +attrs['size'] : 0,
			mtime,
			readable,
			writable: /w/i.test(userPerms),
			// The "telecom" tree, and folders a phone hides by denying reads, e.g.
			// PersistentData with user-perm="WD"
			hidden: attrs['hidden']?.toLowerCase() == 'true'
				|| (isDir && (!readable || attrs['name'].toLowerCase() == 'telecom')),
		});
	}
	return entries;
}

// PMB8875 (SGOLD) and PMB8876 (NewSGOLD) phones as the pmb887x-emu board files
// list them, and the S66, whose firmware names its platform M_c65plat. Every
// other Siemens phone counts as EGOLD.
const SGOLD_MODELS = /^(C65|CX65|M65|S65|S66|SL65|SK65|CX70|C72|C75|CX75|M75|ME75|CF75)(F|C)?$/i;
const NEW_SGOLD_MODELS = /^(S75|SL75|E71|EL71|M72|CL61|C81|M81|S68)(F|C)?$/i;

// After an upload or a delete, an A56 answers what follows as if in the root folder,
// and the first body packet of an upload that comes right after one of them twice.
// A folder entered again in between avoids both. It also keeps a file whose delete
// does not come right after entering the folder. The A55 and C55 are its siblings.
const FORGETS_FOLDER_MODELS = /^(A55|A56|C55)$/i;

export function forgetsFolderAfterPut(model: string | undefined): boolean {
	return FORGETS_FOLDER_MODELS.test(model?.trim() ?? '');
}

export function detectPhonePlatform(model: string | undefined): PhonePlatform {
	if (!model)
		return 'unknown';
	const name = model.trim();
	if (SGOLD_MODELS.test(name))
		return 'SGOLD';
	if (NEW_SGOLD_MODELS.test(name))
		return 'NewSGOLD';
	return 'EGOLD';
}

// "SIEMENS S65 v43" from what AT+CGMI, AT+CGMM and AT+CGMR, or BFC, answered
function deviceName(vendor?: string, model?: string, version?: string): string | undefined {
	const name = [vendor, model].filter(Boolean).join(' ');
	const number = version?.match(/^\s*(\d+)/)?.[1];
	return name && number ? `${name} v${number}` : name || undefined;
}

// The serial link failed, as opposed to an OBEX error response
class ObexLinkError extends Error {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}

// disconnect() ended the session under a running operation
class ObexDisconnectedError extends Error {
	constructor() {
		super('OBEX was disconnected during the operation.');
	}
}

function throwIfDisconnected(signal: AbortSignal): void {
	if (signal.aborted)
		throw new ObexDisconnectedError();
}

interface ObexLink {
	// Whether close() takes the phone back to a mode the probes of connect() reach
	readonly returnsToAt: boolean;
	send(packet: Buffer, signal: AbortSignal): Promise<void>;
	receive(timeout: number, signal: AbortSignal): Promise<Buffer>;
	// Hands the phone back to the mode it was switched from
	close(): Promise<void>;
}

// Leaves raw OBEX mode the way siefs does: a bare DISCONNECT, then the +++ escape
// with a second of silence on both sides. An AT command inside the second after
// it would cancel the escape.
async function escapeToAt(port: AsyncSerialPort, delays: ObexDelays): Promise<void> {
	await flushInput(port, delays.flush);
	await port.write(Buffer.from([ObexOpcode.DISCONNECT, 0x00, 0x03]));
	await flushInput(port, delays.flush);
	await delay(delays.escape);
	await port.write('+++');
	await delay(delays.escape);
	await flushInput(port, delays.flush);
}

// OBEX packets as they are on the wire, after AT^SQWE=3 or its BFC tunneled twin
class RawObexLink implements ObexLink {
	private readonly port: AsyncSerialPort;
	private readonly delays: ObexDelays;
	// Without the +++ escape the phone stays in OBEX mode
	readonly returnsToAt: boolean;

	constructor(port: AsyncSerialPort, delays: ObexDelays, returnsToAt: boolean) {
		this.port = port;
		this.delays = delays;
		this.returnsToAt = returnsToAt;
	}

	async send(packet: Buffer, signal: AbortSignal): Promise<void> {
		throwIfDisconnected(signal);
		await this.port.write(packet);
	}

	async receive(timeout: number, signal: AbortSignal): Promise<Buffer> {
		const deadline = Date.now() + timeout;

		// Skip garbage left from the AT phase until a response opcode is found
		let opcode = -1;
		while (Date.now() < deadline) {
			throwIfDisconnected(signal);
			const byte = await this.port.readByte(Math.max(1, Math.min(deadline - Date.now(), 250)));
			if (byte == -1)
				continue;
			if (isObexResponseCode(byte)) {
				opcode = byte;
				break;
			}
			debug(`Skipping garbage byte: 0x${byte.toString(16).padStart(2, '0')}`);
		}
		if (opcode == -1)
			throw new Error('OBEX response timeout.');

		const lenBytes = await readExact(this.port, 2, deadline, signal);
		const totalLen = lenBytes.readUInt16BE(0);
		if (totalLen < 3)
			throw new Error(`Invalid OBEX packet length: ${totalLen}.`);
		const rest = await readExact(this.port, totalLen - 3, deadline, signal);
		return Buffer.concat([Buffer.from([opcode]), lenBytes, rest]);
	}

	async close(): Promise<void> {
		if (this.returnsToAt && this.port.isOpen)
			await escapeToAt(this.port, this.delays);
	}
}

/**
 * OBEX client for the Siemens FlexMem file system. It switches the serial link
 * to raw OBEX with AT^SQWE=3 like SiMoCo and siefs, to BFB frames with AT^SBFB=1
 * on phones before the x55, or through BFC on a service cable.
 */
export class OBEX extends BaseSerialProtocol {
	private readonly atc: AtChannel = new AtChannel(this.port);
	private readonly delays: ObexDelays;
	private readonly bfbTimeouts: BfbTimeouts;
	private escapeWorks: boolean | undefined;
	// Set while the phone is in OBEX mode
	private link: ObexLink | undefined;
	// The speed the phone last answered AT commands at, and the one its last OBEX
	// session ran at
	private atSpeed = 0;
	private obexSpeed = 0;
	private connected = false;
	// From connect() to disconnect(), across reconnects. Aborting it stops what is
	// still in flight at its next step.
	private lifetime = new AbortController();
	private maxPacketSize = REQUESTED_MAX_PACKET_SIZE;
	private deviceName: string | undefined;
	private phoneModel: string | undefined;
	// Undefined once a move() of a directory on the way to it made it unknown
	private currentPath: string[] | undefined = [];
	private connectionId: number | undefined;
	private aborting = false;
	private operationQueue: Promise<void> = Promise.resolve();

	// Shorter delays are for a simulated phone that answers at once
	constructor(port: AsyncSerialPort, delays: Partial<ObexDelays> = {}) {
		super(port);
		this.delays = {
			escape: delays.escape ?? 1000,
			flush: delays.flush ?? 200,
			response: delays.response ?? 15000,
			abort: delays.abort ?? 3000,
		};
		this.bfbTimeouts = { hello: 1000, ack: 3000, flush: this.delays.flush };
	}

	// OBEX is a strict request/response protocol, serialize all operations
	private enqueue<T>(task: () => Promise<T>): Promise<T> {
		const result = this.operationQueue.then(task, task);
		// Only the settling is waited for, a downloaded file is not kept alive
		this.operationQueue = result.then(() => {}, () => {});
		return result;
	}

	// When the link itself fails, the handshake is redone, and the operation runs
	// again if canRetry() says a second run can't repeat what the first one may
	// already have done on the phone
	private async enqueueRecovering<T>(task: () => Promise<T>, canRetry: () => boolean = () => true): Promise<T> {
		return this.enqueue(async () => {
			if (!this.isConnected)
				throw new Error('OBEX is not connected.');
			const signal = this.lifetime.signal;
			try {
				return await task();
			} catch (e) {
				throwIfDisconnected(signal);
				if (!(e instanceof ObexLinkError))
					throw e;
				debug(`Session looks dead (${e.message}), rehandshaking...`);
				try {
					await this.rehandshake(signal);
				} catch (rehandshakeError) {
					throwIfDisconnected(signal);
					throw new Error(`${e.message} Reconnecting failed: ${(rehandshakeError as Error).message}`, { cause: rehandshakeError });
				}
				if (!canRetry())
					throw e;
				try {
					return await task();
				} catch (retryError) {
					throwIfDisconnected(signal);
					// Late answers of both attempts may still be on their way, and every
					// later request would read an earlier one's: the session ends here
					if (retryError instanceof ObexLinkError)
						await this.drop();
					throw retryError;
				}
			}
		});
	}

	private async rehandshake(signal: AbortSignal): Promise<void> {
		this.connected = false;
		// Without the escape the phone stays in OBEX mode, where AT probes would start
		// a packet that never ends
		const inObexMode = this.link?.returnsToAt === false;
		await this.close();
		throwIfDisconnected(signal);
		if (!inObexMode)
			await this.open(0, signal);
		else if (!await this.reopenObexMode(0, signal))
			throw new Error('The phone does not answer in OBEX mode.');
	}

	// For a session whose answers can no longer be told apart
	private async drop(): Promise<void> {
		debug(`Giving up the session`);
		this.connected = false;
		await this.close();
	}

	get isConnected(): boolean {
		return this.connected && !this.lifetime.signal.aborted;
	}

	getMaxPacketSize(): number {
		return this.maxPacketSize;
	}

	getDeviceName(): string | undefined {
		return this.deviceName;
	}

	getPlatform(): PhonePlatform {
		return detectPhonePlatform(this.phoneModel);
	}

	private async request(packet: ObexPacketWriter, timeout = this.delays.response): Promise<ObexResponsePacket> {
		const link = this.link;
		const signal = this.lifetime.signal;
		if (!link)
			throw new ObexLinkError('OBEX link is closed.');
		// After a disconnect() nothing more goes on the wire, not even an ABORT,
		// which would land in the escape
		throwIfDisconnected(signal);
		if (this.connectionId !== undefined && packet.getOpcode() != ObexOpcode.CONNECT)
			packet.appendUint32Header(ObexHeaderId.CONNECTION_ID, this.connectionId);
		const data = packet.toBuffer();
		debugTrx(`TX ${data.toString('hex')}`);
		try {
			await link.send(data, signal);
		} catch (e) {
			throwIfDisconnected(signal);
			// Aborting would fail the same way
			throw new ObexLinkError(e);
		}
		let response: Buffer;
		try {
			response = await link.receive(timeout, signal);
		} catch (e) {
			throwIfDisconnected(signal);
			await this.abortExchange().catch(() => {});
			throw new ObexLinkError(e);
		}
		// What arrived after a disconnect() may be the answer to its DISCONNECT
		throwIfDisconnected(signal);
		debugTrx(`RX ${response.toString('hex')}`);
		if (packet.getOpcode() == ObexOpcode.PUT_FINAL && forgetsFolderAfterPut(this.phoneModel))
			this.currentPath = undefined;
		return { code: response[0], packet: response };
	}

	private ensureSuccess(response: ObexResponsePacket, operation: string): void {
		if (response.code != ObexResponse.SUCCESS)
			throw new Error(`OBEX ${operation} failed: ${obexResponseName(response.code)}.`);
	}

	private async abortExchange(): Promise<void> {
		if (this.aborting)
			return;
		this.aborting = true;
		try {
			this.ensureSuccess(await this.request(new ObexPacketWriter(ObexOpcode.ABORT), this.delays.abort), 'abort');
		} finally {
			this.aborting = false;
		}
	}

	// When the progress callback throws or the signal fires, an ABORT ends the
	// exchange first: the phone would answer the next request in this one's context
	private async betweenPackets(signal: AbortSignal | undefined, callback?: () => void): Promise<void> {
		try {
			callback?.();
			signal?.throwIfAborted();
		} catch (e) {
			try {
				await this.abortExchange();
			} catch (abortError) {
				debug(`Can't abort the exchange (${(abortError as Error).message})`);
				if (!(abortError instanceof ObexDisconnectedError))
					await this.drop();
			}
			throw e;
		}
	}

	// At baudRate, or at the usual speeds starting with the last one that answered.
	// The AT channel keeps running when one answers.
	private async findAtSpeed(baudRate: number, signal: AbortSignal): Promise<number> {
		const speeds = baudRate ? [baudRate] : [...new Set([this.atSpeed, ...AT_PROBE_SPEEDS].filter(Boolean))];
		this.atc.start();
		for (const [i, speed] of speeds.entries()) {
			throwIfDisconnected(signal);
			debug(`Probing AT handshake at ${speed} baud...`);
			if (!await trySetBaudRate(this.port, speed)) {
				if (baudRate)
					throw new Error(`The serial port refuses ${baudRate} baud.`);
				debug(`The port refuses ${speed} baud`);
				continue;
			}
			// A freshly booted EGOLD phone may take a moment to bring its AT
			// interpreter up, so try harder on the first two speeds
			if (await this.atHandshake(i < 2 ? 5 : 3))
				return speed;
		}
		this.atc.stop();
		return 0;
	}

	private async atHandshake(tries: number): Promise<boolean> {
		if (await this.atc.handshake(1))
			return true;
		if (!await this.atc.handshake(tries - 1))
			return false;
		// A phone slower than the probe timeout answers every probe, and this OK may
		// be the answer to an earlier one
		await this.drainAt();
		return true;
	}

	// Late answers arriving meanwhile are dropped as unsolicited lines, instead of
	// being taken for the next command's
	private async drainAt(): Promise<void> {
		const quiet = 3 * AT_PROBE_TIMEOUT;
		const deadline = Date.now() + 10 * quiet;
		let last = Date.now();
		const onData = () => last = Date.now();
		this.port.on('data', onData);
		try {
			while (Date.now() - last < quiet && Date.now() < deadline)
				await delay(quiet - (Date.now() - last));
		} finally {
			this.port.off('data', onData);
		}
	}

	private async readAtDeviceName(): Promise<string | undefined> {
		const send = async (cmd: string, tries = 1): Promise<string | undefined> => {
			for (let i = 0; i < tries; i++) {
				const response = await this.atc.sendCommandNoPrefix(cmd, AT_COMMAND_TIMEOUT);
				if (response.success)
					return response.lines[0];
				if (response.status == 'TIMEOUT')
					await this.drainAt();
			}
			return undefined;
		};
		const vendor = await send('AT+CGMI');
		// Asked twice: a phone now and then loses a command, and the model decides
		// whether the connection id is echoed
		const model = await send('AT+CGMM', 2);
		if (model)
			this.phoneModel = model;
		return deviceName(vendor, model, await send('AT+CGMR'));
	}

	private async readBfcDeviceName(bfc: BFC): Promise<string | undefined> {
		try {
			const vendor = await bfc.getVendorName();
			const model = await bfc.getProductName();
			if (model)
				this.phoneModel = model;
			return deviceName(vendor, model, await bfc.getSwVersion());
		} catch (e) {
			debug(`Can't read phone info via BFC: ${e}`);
			return undefined;
		}
	}

	// baudRate pins the AT probe to one speed, 0 probes all the usual cable speeds
	async connect(baudRate: number = 0): Promise<void> {
		// Queued, so that an operation a disconnect() cut short has ended before the
		// new session starts
		return this.enqueue(async () => {
			if (this.link)
				throw new Error('OBEX already connected.');
			if (!this.port?.isOpen)
				throw new Error('Serial port closed.');
			this.lifetime = new AbortController();
			const signal = this.lifetime.signal;
			if (!await this.reopenObexMode(baudRate, signal))
				await this.open(baudRate, signal);
		});
	}

	// Whether the +++ escape takes the phone back to its AT interpreter. An x65 on a
	// DCA-540 USB cable takes +++ for the start of an OBEX packet and answers nothing
	// until a power cycle, and the cable refuses to set DTR. Without the escape the
	// phone stays in OBEX mode between sessions, and the next connect() goes on in it.
	private async escapes(): Promise<boolean> {
		if (this.escapeWorks === undefined) {
			try {
				await this.port.setSignals({ dtr: true });
				this.escapeWorks = true;
			} catch (e) {
				this.escapeWorks = false;
				debug(`The cable refuses to set DTR (${(e as Error).message}), so it gets no +++ escape`);
			}
		}
		return this.escapeWorks;
	}

	// An ABORT is noise to an AT interpreter, but a phone left in OBEX mode answers
	// it, where AT probes would start a long packet. With the escape the phone is
	// escaped for a full handshake, without it the session goes on in OBEX mode.
	private async reopenObexMode(baudRate: number, signal: AbortSignal): Promise<boolean> {
		const speed = baudRate || this.obexSpeed;
		if (speed && !await trySetBaudRate(this.port, speed))
			return false;
		const escapes = await this.escapes();
		const link = new RawObexLink(this.port, this.delays, escapes);
		await flushInput(this.port, this.delays.flush);
		await this.port.write(Buffer.from([ObexOpcode.ABORT, 0x00, 0x03]));
		try {
			await link.receive(OBEX_MODE_CHECK_TIMEOUT, signal);
		} catch {
			throwIfDisconnected(signal);
			return false;
		}
		if (escapes) {
			debug(`The phone is still in OBEX mode, escaping...`);
			await escapeToAt(this.port, this.delays);
			return false;
		}
		debug(`The phone is still in OBEX mode, connecting in it`);
		this.link = link;
		this.obexSpeed = this.port.baudRate;
		try {
			await this.obexConnect();
		} catch (e) {
			await this.close();
			throwIfDisconnected(signal);
			throw e;
		}
		return true;
	}

	private async open(baudRate: number, signal: AbortSignal): Promise<void> {
		try {
			this.link = await this.openLink(baudRate, signal);
			this.obexSpeed = this.port.baudRate;
			throwIfDisconnected(signal);
			debug(`Detected platform: ${this.getPlatform()}`);
			await this.obexConnect();
		} catch (e) {
			// Hand the phone back to its AT interpreter if the link was already
			// switched, so that the next connect() finds it again
			await this.close();
			throwIfDisconnected(signal);
			throw e;
		}
	}

	private async openLink(baudRate: number, signal: AbortSignal): Promise<ObexLink> {
		try {
			let atSpeed = await this.findAtSpeed(baudRate, signal);
			if (!atSpeed) {
				// No AT at any speed: likely a phone in BFC mode on a service cable
				debug(`No AT response, trying BFC...`);
				const link = await this.openLinkViaBfc(signal);
				if (link)
					return link;
				// ...or a phone still in OBEX mode, left there by a session that
				// ended without handing it back
				atSpeed = await this.recoverFromObexMode(baudRate, signal);
				if (!atSpeed) {
					throw new Error('Phone not found: no answer to AT at any speed, nor to BFC. ' +
						'A phone that an interrupted session left in OBEX mode may need a power cycle.');
				}
			}
			debug(`Phone found in AT mode at ${atSpeed} baud.`);
			this.atSpeed = atSpeed;
			return await this.openLinkViaAt(signal);
		} finally {
			this.atc.stop();
		}
	}

	// The escape of disconnect() at every speed the session may have run at, each
	// followed by an AT probe at that speed, then the BFB leave frame. In this
	// order: the BFB frame would read as the start of a long packet to a phone in
	// raw OBEX mode, and swallow its DISCONNECT.
	private async recoverFromObexMode(baudRate: number, signal: AbortSignal): Promise<number> {
		// Without the escape, a phone in OBEX mode was found by reopenObexMode() or not at
		// all: the escape and the BFB frame would only get it stuck
		if (!await this.escapes())
			return 0;
		const speeds = baudRate ? [baudRate] : [...new Set([this.obexSpeed, this.atSpeed, ...AT_PROBE_SPEEDS].filter(Boolean))];
		for (const speed of speeds) {
			throwIfDisconnected(signal);
			debug(`No BFC either, escaping at ${speed} baud in case the phone is still in raw OBEX mode...`);
			if (!await trySetBaudRate(this.port, speed))
				continue;
			await escapeToAt(this.port, this.delays);
			const atSpeed = await this.findAtSpeed(speed, signal);
			if (atSpeed)
				return atSpeed;
		}
		throwIfDisconnected(signal);
		debug(`Leaving BFB mode in case the phone is still in it...`);
		await ObexBfbLink.leave(this.port, this.bfbTimeouts);
		return this.findAtSpeed(baudRate, signal);
	}

	// Phones before the x55 have no AT^SQWE, answer the reset with ERROR and wrap
	// OBEX in BFB frames instead
	private async openLinkViaAt(signal: AbortSignal): Promise<ObexLink> {
		this.deviceName = await this.readAtDeviceName();
		throwIfDisconnected(signal);
		const platform = this.getPlatform();
		// An SGOLD or NewSGOLD model knows it even while it refuses it
		const knowsSqwe = (await this.atc.sendCommandNumeric('AT^SQWE=0')).success || platform == 'SGOLD' || platform == 'NewSGOLD';
		await delay(SQWE_RESET_DELAY);
		throwIfDisconnected(signal);
		if ((await this.atc.sendCommandNumeric('AT^SQWE=3')).success) {
			this.atc.stop();
			await delay(MODE_SWITCH_DELAY);
			return new RawObexLink(this.port, this.delays, await this.escapes());
		}
		// A phone that knows AT^SQWE is not one of those: an x65 accepts AT^SBFB=1
		// too, and then does not answer in BFB frames
		if (knowsSqwe)
			throw new Error("Can't enter OBEX mode (AT^SQWE=3): AT command failed. Maybe the phone doesn't support FlexMem access.");
		debug('No AT^SQWE, trying BFB...');
		if (!(await this.atc.sendCommandNumeric('AT^SBFB=1')).success)
			throw new Error("Can't enter OBEX mode (AT^SQWE=3 and AT^SBFB=1 failed). Maybe the phone doesn't support FlexMem access.");
		this.atc.stop();
		await delay(MODE_SWITCH_DELAY);
		try {
			return await ObexBfbLink.open(this.port, this.bfbTimeouts);
		} catch (e) {
			// The phone took AT^SBFB=1, so it may be in BFB mode at a speed the hello
			// was not answered at
			await ObexBfbLink.leave(this.port, this.bfbTimeouts).catch(() => {});
			throw e;
		}
	}

	// Undefined when no phone answers BFC
	private async openLinkViaBfc(signal: AbortSignal): Promise<ObexLink | undefined> {
		const bfc = new BFC(this.port);
		try {
			// A phone that answers AT only now missed the AT probes, and switched to BFC
			// from AT it can't be brought back to AT
			await bfc.connect({ switchFromAt: false });
		} catch (e) {
			// A speed the port refuses fails connect() with the frame parser attached
			bfc.detach();
			debug(`No BFC either: ${(e as Error).message}`);
			return undefined;
		}
		try {
			throwIfDisconnected(signal);
			this.deviceName = await this.readBfcDeviceName(bfc);
			// CR terminated, like the BFC library itself sends AT commands
			const err = await bfc.sendAT('AT^SQWE=0\r', 2000).then(
				(response) => response.match(/\r\nOK\r\n/) ? '' : `AT^SQWE=0 failed: ${response.trim()}`,
				(e) => `AT^SQWE=0 failed: ${(e as Error).message}`);
			if (err)
				throw new Error(`Can't reset phone mode: ${err}`);
			await delay(SQWE_RESET_DELAY);
			throwIfDisconnected(signal);
			// The phone may switch the wire to OBEX without answering first, so a
			// timeout counts as switched, an ERROR does not
			const refused = await bfc.sendAT('AT^SQWE=3\r', 1000).then(
				(response) => response.match(/\r\nOK\r\n/) ? '' : response.trim(),
				(e) => /timeout/i.test((e as Error).message) ? '' : (e as Error).message);
			if (refused)
				throw new Error(`Can't enter OBEX mode (AT^SQWE=3): ${refused}. Maybe the phone doesn't support FlexMem access.`);
			// The wire speaks raw OBEX now
			bfc.detach();
			await delay(MODE_SWITCH_DELAY);
			// The escape takes it to its AT interpreter, not back to BFC
			return new RawObexLink(this.port, this.delays, await this.escapes());
		} catch (e) {
			await bfc.disconnect().catch(() => {});
			throw e;
		}
	}

	private async obexConnect(): Promise<void> {
		// The full offer, not what a previous session negotiated
		this.maxPacketSize = REQUESTED_MAX_PACKET_SIZE;
		const packet = new ObexPacketWriter(ObexOpcode.CONNECT);
		packet.appendByte(OBEX_VERSION_1_0);
		packet.appendByte(0x00); // flags
		packet.appendUint16(this.maxPacketSize);
		packet.appendHeader(ObexHeaderId.TARGET, OBEX_TARGET_FLEXMEM);

		const response = await this.request(packet);
		this.ensureSuccess(response, 'connect');
		// Too short for a CONNECT answer: a late answer to an earlier request
		if (response.packet.length < 7)
			throw new ObexLinkError(`Invalid OBEX CONNECT response: ${response.packet.toString('hex')}.`);

		const negotiated = response.packet.readUInt16BE(5);
		if (negotiated)
			this.maxPacketSize = Math.max(Math.min(this.maxPacketSize, negotiated), OBEX_MIN_PACKET_SIZE);

		// Every recorded phone (tests/obex/phones/db) takes requests with and without
		// the connection id alike. SGOLD/NewSGOLD phones get it back, like in the
		// captured VSOFS sessions, the others do not, like in siefs.
		const connectionId = parseObexHeaders(response.packet, 7).get(ObexHeaderId.CONNECTION_ID);
		const platform = this.getPlatform();
		this.connectionId = (platform == 'SGOLD' || platform == 'NewSGOLD') && connectionId?.length == 4 ?
			connectionId.readUInt32BE(0) :
			undefined;

		this.currentPath = [];
		this.connected = true;
		debug(`OBEX connected, max packet size: ${this.maxPacketSize}` +
			(this.connectionId !== undefined ? `, connection id: ${this.connectionId}` : ''));
	}

	// Ends the session and hands the phone back to the mode it was switched from.
	// Queued operations are not waited for: the one in flight stops at its next
	// step, and those behind it fail.
	async disconnect(): Promise<void> {
		this.lifetime.abort();
		await this.enqueue(() => this.close());
	}

	private async close(): Promise<void> {
		const link = this.link;
		if (!link)
			return;
		if (this.connected) {
			this.connected = false;
			const packet = new ObexPacketWriter(ObexOpcode.DISCONNECT);
			// siefs sends a hardcoded connection id 1 for legacy phones
			packet.appendUint32Header(ObexHeaderId.CONNECTION_ID, this.connectionId ?? 1);
			const data = packet.toBuffer();
			debugTrx(`TX ${data.toString('hex')}`);
			// Not through request(): a disconnect() has aborted the session. And the
			// rest of an interrupted exchange goes first, it would pass for the answer.
			try {
				await flushInput(this.port, this.delays.flush);
				const done = new AbortController();
				await link.send(data, done.signal);
				await link.receive(this.delays.abort, done.signal);
			} catch (e) {
				debug(`OBEX disconnect error: ${e}`);
			}
		}

		try {
			await link.close();
		} catch (e) {
			debug(`Can't leave OBEX mode: ${e}`);
		}
		this.link = undefined;
	}

	// An empty name goes to the root, no name one level up
	private async setPathStep(flags: number, name?: string): Promise<void> {
		const packet = new ObexPacketWriter(ObexOpcode.SETPATH);
		packet.appendByte(flags);
		packet.appendByte(0x00); // constants
		if (name)
			packet.appendUnicodeStringHeader(ObexHeaderId.NAME, name);
		else if (name !== undefined)
			packet.appendHeader(ObexHeaderId.NAME, Buffer.alloc(0));
		this.ensureSuccess(await this.request(packet), name ? `setpath to "${name}"` : 'setpath');
	}

	private async setPath(path: string, create: boolean = false): Promise<void> {
		const parts = pathParts(path);

		if (!this.currentPath) {
			await this.setPathStep(SETPATH_DONT_CREATE, '');
			this.currentPath = [];
		}

		let common = 0;
		while (common < parts.length && common < this.currentPath.length && this.currentPath[common] == parts[common])
			common++;

		if (common == parts.length && this.currentPath.length == parts.length)
			return; // already there

		// Going to the root first is cheaper than walking up more than half the depth
		if (this.currentPath.length - common > this.currentPath.length / 2) {
			await this.setPathStep(SETPATH_DONT_CREATE, '');
			this.currentPath = [];
			common = 0;
		} else {
			while (this.currentPath.length > common) {
				await this.setPathStep(SETPATH_UP | SETPATH_DONT_CREATE);
				this.currentPath.pop();
			}
		}

		for (let i = common; i < parts.length; i++) {
			await this.setPathStep(create ? 0 : SETPATH_DONT_CREATE, parts[i]);
			this.currentPath.push(parts[i]);
		}
	}

	getCurrentPath(): string | undefined {
		return this.currentPath && '/' + this.currentPath.join('/');
	}

	private async getWithBody(packet: ObexPacketWriter, onProgress?: (e: ObexProgress) => void, signal?: AbortSignal): Promise<Buffer> {
		const report = this.createProgressReporter(onProgress);
		const chunks: Buffer[] = [];
		let received = 0;
		let total = 0;
		let first = true;
		while (true) {
			const response = await this.request(packet);
			if (response.code == ObexResponse.NO_CONTENT) {
				report.report(0, 0, true);
				return Buffer.alloc(0);
			}
			if (response.code != ObexResponse.CONTINUE && response.code != ObexResponse.SUCCESS)
				throw new Error(`OBEX GET failed: ${obexResponseName(response.code)}.`);

			const headers = parseObexHeaders(response.packet);
			if (first) {
				const lengthHeader = headers.get(ObexHeaderId.LENGTH);
				if (lengthHeader?.length == 4)
					total = lengthHeader.readUInt32BE(0);
				first = false;
			}

			const body = headers.get(ObexHeaderId.BODY) ?? headers.get(ObexHeaderId.END_OF_BODY);
			if (body?.length) {
				chunks.push(body);
				received += body.length;
			}
			// The exchange is over, what the callback throws needs no ABORT
			if (response.code == ObexResponse.SUCCESS) {
				report.report(received, total, true);
				return Buffer.concat(chunks);
			}
			await this.betweenPackets(signal, body?.length ? () => report.report(received, total) : undefined);

			packet = new ObexPacketWriter(ObexOpcode.GET_FINAL);
		}
	}

	// At most every 200 ms, but the end is always reported, an empty file's too
	private createProgressReporter(onProgress?: (e: ObexProgress) => void) {
		if (!onProgress)
			return { report: (_cursor: number, _total: number, _done?: boolean) => {} };
		let lastTime = Date.now();
		let lastCursor = 0;
		return {
			report(cursor: number, total: number, done = false) {
				const now = Date.now();
				const dt = (now - lastTime) / 1000;
				if (dt < 0.2 && !done)
					return;
				const speed = dt > 0 ? (cursor - lastCursor) / dt : 0;
				lastTime = now;
				lastCursor = cursor;
				onProgress({
					percent: total > 0 ? Math.min(100, (cursor / total) * 100) : done ? 100 : -1,
					cursor,
					total,
					speed,
				});
			}
		};
	}

	async getFile(path: string, onProgress?: (e: ObexProgress) => void, { signal }: ObexTransferOptions = {}): Promise<Buffer> {
		return this.enqueueRecovering(async () => {
			signal?.throwIfAborted();
			debug(`getFile(${path})`);
			const { dir, name } = splitPath(path);
			await this.setPath(dir.join('/'));
			const packet = new ObexPacketWriter(ObexOpcode.GET_FINAL);
			packet.appendUnicodeStringHeader(ObexHeaderId.NAME, name);
			const data = await this.getWithBody(packet, onProgress, signal);
			// An A56 answers the GET of a missing file with an empty one, only the
			// listing tells them apart
			if (!data.length) {
				const listed = await this.findListed(name);
				if (!listed || listed.isDir)
					throw new Error(`OBEX GET failed: ${obexResponseName(0x44)}.`);
			}
			debug(`getFile(${path}) done, ${data.length} bytes`);
			return data;
		});
	}

	// An existing file is replaced. NewSGOLD phones do that themselves, on the others
	// it is deleted first, the way siefs truncates, since they append to it
	async putFile(path: string, data: Uint8Array, onProgress?: (e: ObexProgress) => void, { signal }: ObexTransferOptions = {}): Promise<void> {
		const { dir, name } = splitPath(path);
		// The delete of an existing file would remove an empty folder of that name
		if (!name || /[\/\\]$/.test(path))
			throw new Error(`"${path}" is a folder path, putFile() needs the path of a file.`);
		// Whether a failed attempt may have left part of the file, which a second
		// attempt could only append to
		let leftPartialFile = false;
		return this.enqueueRecovering(async () => {
			signal?.throwIfAborted();
			debug(`putFile(${path}, ${data.byteLength} bytes)`);
			await this.enterForDelete(dir);

			// Whether a retry replaces what a failed attempt left: by itself, or with its
			// own delete when deletes work here
			let replaceable = true;
			if (this.getPlatform() != 'NewSGOLD') {
				const deleted = await this.deleteRequest(name);
				replaceable = deleted.code == ObexResponse.SUCCESS || isNotFound(deleted.code);
				// Back into the folder, on a phone that forgot it
				await this.setPath(dir.join('/'));
				// Folders like /Java refuse deletes but take uploads: a new name is just
				// created, an existing one can't be replaced
				if (!replaceable && await this.findListed(name))
					throw new Error(`OBEX delete of existing "${name}" failed: ${obexResponseName(deleted.code)}.`);
			}

			const buffer = Buffer.from(data);
			// packet overhead: opcode+len (3) + BODY header (3) + CONNECTION_ID header (5)
			const maxBodySize = this.maxPacketSize - 6 - (this.connectionId !== undefined ? 5 : 0);

			leftPartialFile = !replaceable;
			const packet = new ObexPacketWriter(ObexOpcode.PUT);
			packet.appendUnicodeStringHeader(ObexHeaderId.NAME, name);
			const response = await this.request(packet);
			if (response.code != ObexResponse.CONTINUE)
				throw new Error(`OBEX PUT failed: ${obexResponseName(response.code)}.`);

			const report = this.createProgressReporter(onProgress);
			let offset = 0;
			try {
				while (true) {
					const chunk = buffer.subarray(offset, offset + maxBodySize);
					offset += chunk.length;
					const isLast = offset >= buffer.length;

					const bodyPacket = new ObexPacketWriter(isLast ? ObexOpcode.PUT_FINAL : ObexOpcode.PUT);
					bodyPacket.appendHeader(isLast ? ObexHeaderId.END_OF_BODY : ObexHeaderId.BODY, chunk);
					const chunkResponse = await this.request(bodyPacket);
					if (chunkResponse.code != (isLast ? ObexResponse.SUCCESS : ObexResponse.CONTINUE))
						throw new Error(`OBEX PUT failed: ${obexResponseName(chunkResponse.code)}.`);
					if (isLast)
						break;
					await this.betweenPackets(signal, () => report.report(offset, buffer.length));
				}
			} catch (e) {
				// No file of that name was left, so what a cancelled upload leaves is only
				// its own part
				if (!(e instanceof ObexLinkError) && this.isConnected)
					await this.deletePartialFile(dir, name);
				throw e;
			}
			// The exchange is over and the file complete, what the callback throws changes
			// neither
			report.report(offset, buffer.length, true);
			debug(`putFile(${path}) done, ${buffer.length} bytes`);
		}, () => !leftPartialFile);
	}

	private async deletePartialFile(dir: string[], name: string): Promise<void> {
		try {
			await this.enterForDelete(dir);
			await this.deleteRequest(name);
		} catch (e) {
			debug(`Can't delete the partial "${name}": ${(e as Error).message}`);
			// Its answer may still arrive, and would pass for the next request's
			if (e instanceof ObexLinkError)
				await this.drop();
		}
	}

	// An A56 acknowledges a delete that does not come right after entering the
	// folder, but keeps the file
	private async enterForDelete(dir: string[]): Promise<void> {
		if (forgetsFolderAfterPut(this.phoneModel))
			this.currentPath = undefined;
		await this.setPath(dir.join('/'));
	}

	private async deleteRequest(name: string): Promise<ObexResponsePacket> {
		const packet = new ObexPacketWriter(ObexOpcode.PUT_FINAL);
		packet.appendUnicodeStringHeader(ObexHeaderId.NAME, name);
		return this.request(packet);
	}

	// Delete a file or an empty directory
	async deleteFile(path: string): Promise<void> {
		let requested = false;
		return this.enqueueRecovering(async () => {
			// A retry after the answer to the delete got lost finds the entry gone
			const retry = requested;
			debug(`delete(${path})`);
			const { dir, name } = splitPath(path);
			await this.enterForDelete(dir);
			requested = true;
			const response = await this.deleteRequest(name);
			// Not found, or on the EGOLD and SGOLD phones Forbidden: the listing tells
			// whether the entry is gone
			if (retry && response.code != ObexResponse.SUCCESS && (isNotFound(response.code) || !await this.findListed(name))) {
				debug(`"${name}" is gone, the lost answer was the one to its delete`);
				return;
			}
			this.ensureSuccess(response, `delete "${name}"`);
		});
	}

	// Siemens' move, like siefs' obex_move(): application parameters 0x34 "move",
	// 0x35 source and 0x36 destination, both absolute paths
	async move(src: string, dest: string): Promise<void> {
		return this.enqueueRecovering(async () => {
			debug(`move(${src} -> ${dest})`);
			const params = Buffer.concat([
				moveParam(0x34, Buffer.from('move', 'latin1')),
				moveParam(0x35, strToUcs2be(src)),
				moveParam(0x36, strToUcs2be(dest)),
			]);

			const packet = new ObexPacketWriter(ObexOpcode.PUT_FINAL);
			packet.appendHeader(ObexHeaderId.APP_PARAMS, params);
			const response = await this.request(packet);
			this.ensureSuccess(response, `rename "${src}"`);

			// Moving the current folder or one above it leaves the current path unknown
			const current = this.currentPath;
			if (current && pathParts(src).every((part, i) => current[i]?.toLowerCase() == part.toLowerCase()))
				this.currentPath = undefined;
		// The move may have happened with only its answer lost: a second one would
		// fail with Not found, the caller gets the link error instead
		}, () => false);
	}

	// Create a directory with all missing parents
	async mkdir(path: string): Promise<void> {
		return this.enqueueRecovering(async () => {
			debug(`mkdir(${path})`);
			await this.setPath(path, true);
		});
	}

	// For queued operations, readDir() would wait on the queue
	private async listCurrentDir(): Promise<ObexDirEntry[]> {
		const packet = new ObexPacketWriter(ObexOpcode.GET_FINAL);
		packet.appendStringHeader(ObexHeaderId.TYPE, 'x-obex/folder-listing');
		const body = await this.getWithBody(packet);
		return parseFolderListing(body.toString('utf8'));
	}

	// The file systems ignore the case of names
	private async findListed(name: string): Promise<ObexDirEntry | undefined> {
		return (await this.listCurrentDir()).find((e) => e.name.toLowerCase() == name.toLowerCase());
	}

	async readDir(path: string): Promise<ObexDirEntry[]> {
		return this.enqueueRecovering(async () => {
			debug(`readDir(${path})`);
			await this.setPath(path);
			const result = await this.listCurrentDir();
			debug(`readDir(${path}) done, ${result.length} entries`);
			return result;
		});
	}

	// Siemens specific info request: 0x01 = capacity, 0x02 = free space
	private async getInfo(requestType: number): Promise<number> {
		debug(`getInfo(${requestType == 0x01 ? 'capacity' : 'available'})`);
		const packet = new ObexPacketWriter(ObexOpcode.GET_FINAL);
		packet.appendHeader(ObexHeaderId.APP_PARAMS, Buffer.from([0x32, 0x01, requestType]));
		const response = await this.request(packet);
		this.ensureSuccess(response, 'info request');

		const params = parseObexHeaders(response.packet).get(ObexHeaderId.APP_PARAMS);
		if (params && params.length >= 4 && params[0] == 0x32) {
			// Not a 32-bit shift: that would turn sizes of 2 GiB and more negative
			let value = 0;
			for (const byte of params.subarray(2, 2 + params[1]))
				value = value * 256 + byte;
			return value;
		}
		return 0;
	}

	async getCapacity(): Promise<number> {
		return this.enqueueRecovering(() => this.getInfo(0x01));
	}

	async getAvailable(): Promise<number> {
		return this.enqueueRecovering(() => this.getInfo(0x02));
	}
}
