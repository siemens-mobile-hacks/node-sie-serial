// A phone that behaves the way a database entry (db/*.json) says: an AT interpreter,
// BFC mode on a service cable, raw OBEX after AT^SQWE=3 or BFB frames after
// AT^SBFB=1, and a FlexMem server with the entry's folders, response codes and file
// semantics. openFakePhonePort() puts it behind the real SerialPortStream, where it
// sees the baud rate the client sets and answers only at the entry's speeds.

import { SerialPortStream } from '@serialport/stream';
import { BindingInterface, BindingPortInterface, OpenOptions, PortStatus, UpdateOptions } from '@serialport/bindings-interface';
import { AsyncSerialPort } from '../../../src/AsyncSerialPort.js';
import { BfbChannel, BfbCoreOpcode } from '../../../src/BFB.js';
import { BfcFrameFlags, BfcFrameTypes } from '../../../src/BFC.js';
import { crc16 } from '../../../src/crc16.js';
import { ObexHeaderId, parseObexHeaders } from '../../../src/OBEX.js';
import { ACK_PAYLOAD, encodeBfbPacket } from '../../../src/ObexBfbLink.js';
import { obexHeader, obexPacket } from '../packets.js';
import { PhoneEntry } from './entry.js';

const CONNECTION_ID = 0x100;

const code = (value: string | null | undefined, fallback: number) => value ? parseInt(value, 16) : fallback;
const isSuccess = (value: number) => (value & 0x7F) == 0x10 || (value & 0x7F) == 0x20;

function ucs2(buf: Buffer | undefined): string {
	return buf ? Buffer.from(buf).swap16().toString('utf16le').replace(/\0+$/, '') : '';
}

function xmlEscape(str: string): string {
	return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// The FlexMem OBEX server: folders, files kept in memory, the entry's codes. Like the
// S75 firmware, a GET while an exchange is open is answered in that exchange's context.
class FlexMem {
	private readonly obex: NonNullable<PhoneEntry['obex']>;
	private readonly dirs = new Map<string, string>();
	private readonly files = new Map<string, { name: string; data: Buffer }>();
	private cwd: string[] = [];
	private upload: string | undefined;
	private download: { data: Buffer; offset: number; file: boolean } | undefined;
	capacity = 0x200000;
	// Like the A56: after an upload or a delete, requests are answered as if in the
	// root folder, and the first body packet of an upload right after one twice. A
	// delete that does not come right after a SETPATH is acknowledged but not done.
	forgetsFolder = false;
	private afterPutFinal = false;
	private afterSetPath = false;
	private doubleContinue = false;
	available = 0x100000;

	constructor(obex: NonNullable<PhoneEntry['obex']>) {
		this.obex = obex;
		this.dirs.set('/', '');
		for (const folder of obex.rootFolders)
			this.addDir(['', folder].join('/'));
		if (obex.writableDir)
			this.addDir(obex.writableDir);
	}

	private key(path: string): string {
		return this.obex.caseInsensitive === false ? path : path.toLowerCase();
	}

	// With the folders on the way
	addDir(path: string): void {
		const parts = path.split('/').filter(Boolean);
		for (let i = 1; i <= parts.length; i++)
			this.dirs.set(this.key('/' + parts.slice(0, i).join('/')), parts[i - 1]);
	}

	addFile(path: string, data: Buffer): void {
		this.addDir(path.split('/').slice(0, -1).join('/'));
		this.files.set(this.key(path), { name: path.split('/').pop()!, data });
	}

	file(path: string): Buffer | undefined {
		return this.files.get(this.key(path))?.data;
	}

	private path(name?: string): string {
		return '/' + [...this.cwd, ...(name !== undefined ? [name] : [])].join('/');
	}

	private inJava(): boolean {
		return this.cwd.length == 1 && this.cwd[0].toLowerCase() == 'java';
	}

	reset(): void {
		this.cwd = [];
		this.upload = undefined;
		this.download = undefined;
	}

	handle(request: Buffer): Buffer {
		const opcode = request[0];
		const offset = opcode == 0x80 ? 7 : opcode == 0x85 ? 5 : 3;
		const headers = parseObexHeaders(request, offset);
		if (opcode != 0x80 && opcode != 0x81) {
			const hasId = headers.get(ObexHeaderId.CONNECTION_ID)?.readUInt32BE(0) == CONNECTION_ID;
			const refusal = code(hasId ? this.obex.connectionId.with : this.obex.connectionId.without, 0xA0);
			if (!isSuccess(refusal))
				return obexPacket(refusal);
		}
		if (opcode != 0x02 && opcode != 0x82)
			this.afterPutFinal = false;
		const afterSetPath = this.afterSetPath;
		this.afterSetPath = opcode == 0x85;
		switch (opcode) {
			case 0x80:
				return this.connect();
			case 0x81:
				this.reset();
				return obexPacket(code(this.obex.codes.disconnect, 0xA0));
			case 0xFF: {
				const busy = this.upload !== undefined || this.download !== undefined;
				this.upload = undefined;
				this.download = undefined;
				return obexPacket(busy ? 0xA0 : code(this.obex.codes.abortIdle, 0xA0));
			}
			case 0x85:
				return this.setPath(request[3], headers);
			case 0x83:
				return this.get(headers);
			case 0x02:
			case 0x82: {
				const answer = this.put(opcode == 0x82, headers, afterSetPath);
				this.afterPutFinal = opcode == 0x82;
				if (this.afterPutFinal && this.forgetsFolder)
					this.cwd = [];
				return answer;
			}
			default:
				return obexPacket(0xD1);
		}
	}

	private connect(): Buffer {
		this.reset();
		const connect = this.obex.connect;
		const fields = Buffer.from([parseInt(connect.version, 16), parseInt(connect.flags, 16), connect.maxPacket >> 8, connect.maxPacket & 0xFF]);
		const id = Buffer.from([ObexHeaderId.CONNECTION_ID, 0, 0, 0, 0]);
		id.writeUInt32BE(CONNECTION_ID, 1);
		return obexPacket(parseInt(connect.code, 16), fields, ...(connect.connectionId ? [id] : []));
	}

	private setPath(flags: number, headers: Map<ObexHeaderId, Buffer>): Buffer {
		if (flags & 0x01) {
			this.cwd.pop();
			return obexPacket(0xA0);
		}
		const name = headers.get(ObexHeaderId.NAME);
		if (!name?.length) {
			this.cwd = [];
			return obexPacket(0xA0);
		}
		const dir = ucs2(name);
		const path = this.path(dir);
		if (!this.dirs.has(this.key(path))) {
			if (flags & 0x02)
				return obexPacket(code(this.obex.codes.setpathMissing, 0xC4));
			this.dirs.set(this.key(path), dir);
		}
		this.cwd.push(this.dirs.get(this.key(path)) ?? dir);
		return obexPacket(0xA0);
	}

	private get(headers: Map<ObexHeaderId, Buffer>): Buffer {
		if (this.upload)
			return obexPacket(0xD0);
		const params = headers.get(ObexHeaderId.APP_PARAMS);
		if (params?.[0] == 0x32 && !this.download) {
			const wanted = params[2] == 0x01 ? this.obex.info.capacity : this.obex.info.available;
			if (!wanted)
				return obexPacket(0xC0);
			const value = Buffer.alloc(4);
			value.writeUInt32BE(params[2] == 0x01 ? this.capacity : this.available);
			return obexPacket(0xA0, obexHeader(ObexHeaderId.APP_PARAMS, Buffer.concat([Buffer.from([0x32, 0x04]), value])));
		}
		if (this.download) {
			// the exchange that is still open goes on
		} else if (headers.has(ObexHeaderId.TYPE)) {
			if (headers.get(ObexHeaderId.TYPE)!.toString('latin1') != 'x-obex/folder-listing\0')
				return obexPacket(0xC6);
			this.download = { data: Buffer.from(this.listing(), 'utf8'), offset: 0, file: false };
		} else if (headers.has(ObexHeaderId.NAME)) {
			const file = this.files.get(this.key(this.path(ucs2(headers.get(ObexHeaderId.NAME)))));
			if (!file)
				return obexPacket(code(this.obex.codes.getMissing, 0xC4));
			this.download = { data: file.data, offset: 0, file: true };
		}
		if (!this.download)
			return obexPacket(0xC0);
		return this.continueDownload(this.download);
	}

	// Like the recorded phones: the first answer tells the length, the data follows in
	// CONTINUE answers, and an empty SUCCESS ends them. A file that fits into one answer
	// comes whole with SUCCESS, as on the EL71 and the S75.
	private continueDownload(download: { data: Buffer; offset: number; file: boolean }): Buffer {
		const { data, offset } = download;
		const length = Buffer.from([ObexHeaderId.LENGTH, 0, 0, 0, 0]);
		length.writeUInt32BE(data.length, 1);
		const headers = offset ? [] : [length];
		const room = this.obex.connect.maxPacket - 11;
		if (offset >= data.length || (!offset && download.file && data.length <= room)) {
			this.download = undefined;
			return obexPacket(0xA0, ...headers, obexHeader(ObexHeaderId.END_OF_BODY, data.subarray(offset)));
		}
		// The recorded size as it is: the SL65 sends 1024 bytes in each answer, and the
		// LENGTH header takes its first one past its own packet size
		const chunk = data.subarray(offset, offset + (this.obex.getChunk ?? room));
		download.offset += chunk.length;
		return obexPacket(0x90, ...headers, obexHeader(ObexHeaderId.BODY, chunk));
	}

	private listing(): string {
		const here = this.key(this.path()).replace(/\/$/, '');
		const children = (map: Map<string, unknown>) => [...map.keys()].filter((path) =>
			path != '/' && path.slice(0, path.lastIndexOf('/')) == here);
		const folders = children(this.dirs).map((path) => `<folder name="${xmlEscape(this.dirs.get(path)!)}" user-perm="RWD"/>`);
		const files = children(this.files).map((path) => {
			const file = this.files.get(path)!;
			return `<file name="${xmlEscape(file.name)}" size="${file.data.length}" user-perm="RWD"/>`;
		});
		return `${this.obex.listingPrologue}${[...folders, ...files].join('')}</folder-listing>`;
	}

	private put(final: boolean, headers: Map<ObexHeaderId, Buffer>, afterSetPath: boolean): Buffer {
		const params = headers.get(ObexHeaderId.APP_PARAMS);
		if (params)
			return this.move(params);
		const body = headers.get(ObexHeaderId.BODY) ?? headers.get(ObexHeaderId.END_OF_BODY);
		const nameHeader = headers.get(ObexHeaderId.NAME);
		if (nameHeader && final && !body) {
			const path = this.key(this.path(ucs2(nameHeader)));
			if (this.forgetsFolder && !afterSetPath && this.files.has(path))
				return obexPacket(0xA0);
			if (this.files.delete(path))
				return obexPacket(0xA0);
			if (this.dirs.has(path) && ![...this.dirs.keys(), ...this.files.keys()].some((p) => p.startsWith(path + '/'))) {
				this.dirs.delete(path);
				return obexPacket(0xA0);
			}
			const missing = this.inJava() ? this.obex.codes.deleteMissingInJava ?? this.obex.codes.deleteMissing : this.obex.codes.deleteMissing;
			return obexPacket(code(missing, 0xC4));
		}
		if (nameHeader) {
			const name = ucs2(nameHeader);
			const path = this.key(this.path(name));
			const existing = this.files.get(path);
			const keep = existing && this.obex.overwrite == 'append';
			this.files.set(path, { name: existing?.name ?? name, data: keep ? existing.data : Buffer.alloc(0) });
			this.upload = path;
			this.doubleContinue = this.forgetsFolder && this.afterPutFinal && !final;
		} else if (body && !final && this.doubleContinue) {
			this.doubleContinue = false;
			const file = this.files.get(this.upload!)!;
			file.data = Buffer.concat([file.data, body]);
			return Buffer.concat([obexPacket(0x90), obexPacket(0x90)]);
		}
		if (body && this.upload) {
			const file = this.files.get(this.upload)!;
			file.data = Buffer.concat([file.data, body]);
		}
		if (final)
			this.upload = undefined;
		return obexPacket(final ? 0xA0 : 0x90);
	}

	// Siemens move: TLVs 0x34 "move", 0x35 source, 0x36 destination, UCS2-BE paths
	private move(params: Buffer): Buffer {
		const tlv: Record<number, Buffer> = {};
		for (let pos = 0; pos + 2 <= params.length; pos += 2 + params[pos + 1])
			tlv[params[pos]] = params.subarray(pos + 2, pos + 2 + params[pos + 1]);
		const from = this.key(Buffer.from(tlv[0x35] ?? []).swap16().toString('utf16le'));
		const to = Buffer.from(tlv[0x36] ?? []).swap16().toString('utf16le');
		const file = this.files.get(from);
		if (file) {
			this.files.delete(from);
			this.files.set(this.key(to), { name: to.split('/').pop()!, data: file.data });
			return obexPacket(0xA0);
		}
		if (!this.dirs.has(from))
			return obexPacket(0xC4);
		// A folder takes what is in it along
		for (const map of [this.dirs, this.files] as Map<string, unknown>[]) {
			for (const [path, value] of [...map]) {
				if (path == from || path.startsWith(from + '/')) {
					map.delete(path);
					map.set(this.key(to) + path.slice(from.length), value);
				}
			}
		}
		this.dirs.set(this.key(to), to.split('/').pop()!);
		return obexPacket(0xA0);
	}
}

export type FakePhoneOptions = {
	// the silence the +++ escape needs on both sides
	escapeGuardMs?: number;
};

// What the phone does after losing an answer: it stays in its mode, falls back to its
// AT interpreter as if it rebooted, or is gone for good
export type AfterLoss = 'stay' | 'reboot' | 'unplug';

export class FakePhone {
	readonly entry: PhoneEntry;
	// stuck: answering nothing until a power cycle
	mode: 'at' | 'raw' | 'bfb' | 'bfc' | 'stuck' = 'at';
	// Every speed the port was switched to
	readonly baudRates: number[] = [];
	private speed = 115200;
	// the UART speed of raw OBEX mode, where other speeds are noise
	rawSpeed = 0;
	output: (data: Buffer) => void = () => {};
	// What the tests look at and inject: every OBEX request and AT command the phone
	// got, the writes, an answer of their own instead of the server's (null: none at all),
	// an AT answer of their own ('' for silence), a delay before every OBEX answer
	readonly requests: Buffer[] = [];
	readonly atCommands: string[] = [];
	readonly bfcAtCommands: string[] = [];
	writes = 0;
	override: ((request: Buffer) => Buffer | null | undefined) | undefined;
	atOverride: ((cmd: string) => string | undefined) | undefined;
	responseDelayMs = 0;
	refusedBaudRates: number[] = [];
	private readonly lostAnswers: AfterLoss[] = [];
	private writeFails = false;
	private atSpeeds: number[];
	private atLine = '';
	private echo: boolean;
	private readonly escapeGuardMs: number;
	private lastInput = 0;
	private readonly server: FlexMem | undefined;
	private frameBuffer = Buffer.alloc(0);
	private bfcBuffer = Buffer.alloc(0);
	private packetBuffer = Buffer.alloc(0);
	private rawBuffer = Buffer.alloc(0);
	private sent = 0;

	constructor(entry: PhoneEntry, options: FakePhoneOptions = {}) {
		this.entry = entry;
		this.atSpeeds = entry.at.speeds;
		this.echo = entry.at.echo ?? false;
		this.escapeGuardMs = options.escapeGuardMs ?? 500;
		this.server = entry.obex ? new FlexMem(entry.obex) : undefined;
		// A phone on a service cable starts in BFC mode
		if (entry.bfc)
			this.mode = 'bfc';
	}

	get baudRate(): number {
		return this.speed;
	}

	set baudRate(speed: number) {
		this.speed = speed;
		this.baudRates.push(speed);
	}

	private send(data: Buffer | string, delayMs = 0): void {
		const bytes = Buffer.from(data);
		if (delayMs)
			setTimeout(() => this.output(bytes), delayMs);
		else
			setImmediate(() => this.output(bytes));
	}

	addFile(path: string, data: Buffer): void {
		this.server!.addFile(path, data);
	}

	addDir(path: string): void {
		this.server!.addDir(path);
	}

	file(path: string): Buffer | undefined {
		return this.server!.file(path);
	}

	set capacity(value: number) {
		this.server!.capacity = value;
	}

	set forgetsFolder(value: boolean) {
		this.server!.forgetsFolder = value;
	}

	set available(value: number) {
		this.server!.available = value;
	}

	// The phone does what the next OBEX request asks, but its answer never arrives
	loseNextAnswer(then: AfterLoss = 'stay'): void {
		this.lostAnswers.push(then);
	}

	// The next write fails like a dropped USB link, which closes the port
	failNextWrite(): void {
		this.writeFails = true;
	}

	private after(loss: AfterLoss): void {
		if (loss == 'reboot')
			this.enterAt(this.atSpeeds);
		else if (loss == 'unplug')
			this.mode = 'stuck';
	}

	// The answer to an OBEX request, undefined when it gets lost
	private obexAnswer(request: Buffer): Buffer | undefined {
		this.requests.push(request);
		const custom = this.override?.(request);
		const answer = custom !== undefined ? custom : this.server?.handle(request) ?? obexPacket(0xD3);
		const lost = this.lostAnswers.shift();
		if (lost) {
			this.after(lost);
			return undefined;
		}
		return answer ?? undefined;
	}

	receive(data: Buffer): void {
		this.writes++;
		if (this.writeFails) {
			this.writeFails = false;
			throw new Error('Write failed.');
		}
		const now = Date.now();
		const quietBefore = now - this.lastInput;
		this.lastInput = now;
		if (this.mode == 'raw' && this.baudRate != this.rawSpeed)
			return;
		if (this.mode == 'raw' && data.toString('latin1') == '+++') {
			// Without the escape, +++ starts an OBEX packet that never ends
			if (this.entry.raw?.escape == 'none') {
				this.mode = 'stuck';
				return;
			}
			if (quietBefore >= this.escapeGuardMs) {
				setTimeout(() => {
					if (this.lastInput == now && this.mode == 'raw')
						this.enterAt(this.entry.raw?.escapeSpeeds);
				}, this.escapeGuardMs);
			}
			return;
		}
		if (this.mode == 'stuck')
			return;
		if (this.mode == 'at')
			this.receiveAt(data);
		else if (this.mode == 'raw')
			this.receiveRaw(data);
		else if (this.mode == 'bfc')
			this.receiveBfc(data);
		else
			this.receiveBfb(data);
	}

	// BFC frames: [dst][src][length, BE][type | flags][xor of the five][payload][CRC if
	// flagged]. The authentication, the software info the OBEX client asks for its
	// name, and the AT tunnel on channel 0x17, at the speed the entry recorded.
	private receiveBfc(data: Buffer): void {
		if (this.baudRate != this.entry.bfc?.speed)
			return;
		this.bfcBuffer = Buffer.concat([this.bfcBuffer, data]);
		while (this.bfcBuffer.length >= 6) {
			const buf = this.bfcBuffer;
			// a frame starts where the xor byte matches, everything before it is noise
			let start = -1;
			for (let i = 0; i + 6 <= buf.length && start < 0; i++) {
				if ((buf[i] ^ buf[i + 1] ^ buf[i + 2] ^ buf[i + 3] ^ buf[i + 4]) == buf[i + 5])
					start = i;
			}
			if (start < 0) {
				this.bfcBuffer = buf.subarray(buf.length - 5);
				return;
			}
			const frameStart = buf.subarray(start);
			const length = 6 + frameStart.readUInt16BE(2) + ((frameStart[4] & BfcFrameFlags.CRC) ? 2 : 0);
			if (frameStart.length < length) {
				this.bfcBuffer = frameStart;
				return;
			}
			this.bfcBuffer = frameStart.subarray(length);
			this.bfcFrame(frameStart.subarray(0, length));
			if (this.mode != 'bfc')
				return;
		}
	}

	private bfcFrame(frame: Buffer): void {
		const [dst, src] = frame;
		const type = frame[4] & 0x0F;
		const payload = frame.subarray(6, 6 + frame.readUInt16BE(2));
		const reply = (replyType: number, replyPayload: Buffer) => {
			const answer = Buffer.alloc(6 + replyPayload.length);
			answer[0] = src;
			answer[1] = dst;
			answer.writeUInt16BE(replyPayload.length, 2);
			answer[4] = replyType;
			answer[5] = answer[0] ^ answer[1] ^ answer[2] ^ answer[3] ^ answer[4];
			replyPayload.copy(answer, 6);
			this.send(answer);
		};
		if (type == BfcFrameTypes.STATUS && payload.length == 2 && payload[0] == 0x80 && payload[1] == 0x11) {
			reply(BfcFrameTypes.STATUS, Buffer.from([0x43, 0x11]));
		} else if (dst == 0x11 && type == BfcFrameTypes.SINGLE) {
			const { vendor, model, revision } = this.entry.identity;
			const info: Record<number, string | null> = { 0x0B: revision, 0x0C: vendor, 0x0D: model };
			const value = info[payload[0]];
			if (value != null)
				reply(BfcFrameTypes.SINGLE, Buffer.concat([payload.subarray(0, 1), Buffer.from(`${value}\0`, 'latin1')]));
		} else if (dst == 0x17 && type == BfcFrameTypes.SINGLE) {
			this.bfcAtCommands.push(payload.toString('latin1'));
			const cmd = payload.toString('latin1').trim().toUpperCase();
			const result = this.entry.at.results[cmd] ?? 'OK';
			if (result != 'TIMEOUT')
				reply(BfcFrameTypes.SINGLE, Buffer.from(`\r\n${result}\r\n`));
			if (cmd == 'AT^SQWE=3' && result != 'ERROR' && this.entry.transport == 'raw')
				this.enterRaw();
		}
	}

	enterRaw(speed = this.baudRate): void {
		this.mode = 'raw';
		this.rawSpeed = speed;
		this.rawBuffer = Buffer.alloc(0);
		this.server?.reset();
	}

	// A cable without the escape refuses to set DTR, like the DCA-540 with EPIPE
	setSignals(): void {
		if (this.entry.raw?.escape == 'none')
			throw new Error('Broken pipe, cannot set');
	}

	// No speeds: the phone answers AT at none until a power cycle
	private enterAt(speeds: number[] | undefined): void {
		this.mode = 'at';
		this.atLine = '';
		if (speeds)
			this.atSpeeds = speeds;
	}

	private receiveAt(data: Buffer): void {
		for (const byte of data) {
			if (byte == 0x0D) {
				// Whatever came before the AT is noise, e.g. the bytes of an escape
				const cmd = this.atLine.slice(Math.max(0, this.atLine.search(/AT/i))).trim();
				this.atLine = '';
				this.command(cmd);
			} else if (byte != 0x0A) {
				this.atLine += String.fromCharCode(byte);
			}
		}
	}

	// An AT answer leaves after the entry's latency, behind the echo of the command
	// while echo is on. One that finds the host switched to another speed than the
	// command came in at arrives as garbage, as on a real line.
	private answerAt(cmd: string, answer: string): void {
		const text = (this.echo ? `${cmd}\r` : '') + answer;
		const echoSetting = /(?:^AT|\s)E([01])(?:\s|$)/i.exec(cmd);
		if (echoSetting)
			this.echo = echoSetting[1] == '1';
		if (!text)
			return;
		const speed = this.baudRate;
		setTimeout(() => {
			if (this.baudRate != speed)
				this.output(Buffer.from([0x00]));
			else
				this.output(Buffer.from(text, 'latin1'));
		}, this.entry.at.latencyMs ?? 0);
	}

	private command(cmd: string): void {
		if (!/^AT/i.test(cmd) || !this.atSpeeds.includes(this.baudRate))
			return;
		this.atCommands.push(cmd);
		const upper = cmd.toUpperCase();
		const custom = this.atOverride?.(upper);
		if (custom !== undefined) {
			this.answerAt(cmd, custom);
			return;
		}
		const identity: Record<string, string | null> = {
			'AT+CGMI': this.entry.identity.vendor,
			'AT+CGMM': this.entry.identity.model,
			'AT+CGMR': this.entry.identity.revision,
		};
		if (upper in identity) {
			const value = identity[upper];
			this.answerAt(cmd, value === null ? '\r\nERROR\r\n' : `\r\n${value}\r\nOK\r\n`);
			return;
		}
		// A phone recorded on a service cable answered these through BFC's AT tunnel,
		// where the switch to OBEX mode cuts off the answer to AT^SQWE=3. Its AT
		// interpreter answers OK like every phone recorded in AT mode.
		const recorded = this.entry.at.results[upper];
		const result = this.entry.bfc && upper == 'AT^SQWE=3' && recorded == 'TIMEOUT' ? 'OK' : recorded ?? 'OK';
		this.answerAt(cmd, result != 'TIMEOUT' ? `\r\n${result}\r\n` : '');
		if (result != 'OK')
			return;
		if (upper == 'AT^SQWE=3' && this.entry.transport == 'raw') {
			this.enterRaw();
		} else if (upper == 'AT^SBFB=1' && this.entry.transport == 'bfb') {
			this.mode = 'bfb';
			this.frameBuffer = Buffer.alloc(0);
			this.packetBuffer = Buffer.alloc(0);
			this.sent = 0;
			this.server?.reset();
		}
	}

	private receiveRaw(data: Buffer): void {
		this.rawBuffer = Buffer.concat([this.rawBuffer, data]);
		while (this.rawBuffer.length >= 3) {
			const length = this.rawBuffer.readUInt16BE(1);
			if (length < 3) {
				this.rawBuffer = this.rawBuffer.subarray(1);
				continue;
			}
			if (this.rawBuffer.length < length)
				return;
			const request = this.rawBuffer.subarray(0, length);
			this.rawBuffer = this.rawBuffer.subarray(length);
			const answer = this.obexAnswer(request);
			if (answer)
				this.send(answer, this.responseDelayMs);
		}
	}

	private receiveBfb(data: Buffer): void {
		this.frameBuffer = Buffer.concat([this.frameBuffer, data]);
		while (this.frameBuffer.length >= 3) {
			const [channel, length, check] = this.frameBuffer;
			if ((channel ^ length) != check) {
				this.frameBuffer = this.frameBuffer.subarray(1);
				continue;
			}
			if (this.frameBuffer.length < 3 + length)
				return;
			const payload = Buffer.from(this.frameBuffer.subarray(3, 3 + length));
			this.frameBuffer = this.frameBuffer.subarray(3 + length);
			this.frame(channel, payload);
		}
	}

	private frame(channel: number, payload: Buffer): void {
		const bfb = this.entry.bfb!;
		if (channel == BfbChannel.CORE && payload.length == 1 && payload[0] == BfbCoreOpcode.PING) {
			if (bfb.helloAnswer && this.baudRate == bfb.helloSpeed)
				this.send(Buffer.from(bfb.helloAnswer, 'hex'));
			return;
		}
		if (channel == BfbChannel.AT) {
			if (/^at\^sbfb=0/i.test(payload.toString('latin1')))
				this.enterAt(bfb.leaveSpeeds);
			return;
		}
		if (channel != BfbChannel.SERVICE_STREAM)
			return;
		// The acknowledgement of the phone's answer
		if (!this.packetBuffer.length && payload.equals(ACK_PAYLOAD))
			return;
		this.packetBuffer = Buffer.concat([this.packetBuffer, payload]);
		if (this.packetBuffer.length >= 2 && ((this.packetBuffer[0] | 1) != 0x03 || (this.packetBuffer[0] ^ this.packetBuffer[1]) != 0xFF)) {
			this.packetBuffer = Buffer.alloc(0);
			return;
		}
		if (this.packetBuffer.length < 5 || this.packetBuffer.length < this.packetBuffer.readUInt16BE(3) + 7)
			return;
		const packet = this.packetBuffer;
		this.packetBuffer = Buffer.alloc(0);
		this.packet(packet);
	}

	private sendAck(): void {
		const ack = this.entry.bfb!.ackFrame;
		if (ack)
			this.send(Buffer.from(ack, 'hex'));
	}

	// A packet with a broken CRC gets no acknowledgement, the host sends it again
	private packet(data: Buffer): void {
		const bfb = this.entry.bfb!;
		const length = data.readUInt16BE(3);
		if (data.readUInt16LE(length + 5) != (crc16(data, 2, length + 3) ^ 0xFFFF))
			return;
		if (data[0] == 0x02)
			this.sent = 0;
		const obex = this.obexAnswer(data.subarray(5, length + 5));
		if (!obex) {
			// Only the answer got lost, the acknowledgement of the request arrives
			if (this.mode == 'bfb')
				this.sendAck();
			return;
		}
		const ackFirst = bfb.ackBeforeResponse !== false;
		if (ackFirst)
			this.sendAck();
		const first = this.sent == 0;
		const marker = code(first ? bfb.firstMarker : bfb.laterMarker, first ? 0x02 : 0x03);
		const seq = bfb.sequence == 'echo' ? data[2] : bfb.sequence == 'constant' ? 0 : this.sent;
		this.sent++;
		this.send(encodeBfbPacket(marker, seq, obex));
		if (!ackFirst)
			this.sendAck();
	}
}

// Whatever sits on the other end of a serial port in a test: it gets what the client
// writes, sends through output(), and learns the baud rate the client sets
export interface SerialDevice {
	receive(data: Buffer): void;
	output: (data: Buffer) => void;
	baudRate: number | undefined;
	// what setting a control line does, e.g. DTR: a device may refuse it
	setSignals?(): void;
	// rates the port refuses, like a legacy Windows COM port anything above 115200
	refusedBaudRates?: number[];
}

// The serial port a device sits on, a binding of its own for SerialPortStream
class DevicePortBinding implements BindingPortInterface {
	readonly openOptions: Required<OpenOptions>;
	isOpen = true;
	private received = Buffer.alloc(0);
	private wake: (() => void) | undefined;

	constructor(private readonly device: SerialDevice, options: OpenOptions) {
		this.openOptions = {
			dataBits: 8, lock: true, stopBits: 1, parity: 'none', rtscts: false,
			xon: false, xoff: false, xany: false, hupcl: true, ...options,
		};
		device.baudRate = options.baudRate;
		device.output = (data) => {
			if (!this.isOpen)
				return;
			this.received = Buffer.concat([this.received, data]);
			this.wake?.();
		};
	}

	async close(): Promise<void> {
		this.isOpen = false;
		this.wake?.();
	}

	async read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }> {
		while (this.isOpen && !this.received.length)
			await new Promise<void>((resolve) => this.wake = resolve);
		this.wake = undefined;
		if (!this.isOpen)
			throw Object.assign(new Error("The fake phone's port is closed"), { canceled: true });
		const bytesRead = Math.min(length, this.received.length);
		this.received.copy(buffer, offset, 0, bytesRead);
		this.received = this.received.subarray(bytesRead);
		return { buffer, bytesRead };
	}

	async write(buffer: Buffer): Promise<void> {
		if (!this.isOpen)
			throw Object.assign(new Error("The fake phone's port is closed"), { canceled: true });
		this.device.receive(Buffer.from(buffer));
	}

	async update(options: UpdateOptions): Promise<void> {
		if (this.device.refusedBaudRates?.includes(options.baudRate))
			throw new Error('Update (SetCommState): The parameter is incorrect.');
		this.device.baudRate = options.baudRate;
	}

	async set(): Promise<void> {
		this.device.setSignals?.();
	}

	async get(): Promise<PortStatus> {
		return { cts: true, dsr: true, dcd: true };
	}

	async getBaudRate(): Promise<{ baudRate: number }> {
		return { baudRate: this.device.baudRate ?? 0 };
	}

	async flush(): Promise<void> {
		this.received = Buffer.alloc(0);
	}

	async drain(): Promise<void> {}
}

// A device behind the real SerialPortStream + AsyncSerialPort, the way the client
// sees a phone on a cable
export async function openDevicePort(device: SerialDevice, name = 'device'): Promise<AsyncSerialPort> {
	const binding: BindingInterface<DevicePortBinding> = {
		list: async () => [],
		open: async (options) => new DevicePortBinding(device, options),
	};
	const port = new AsyncSerialPort(new SerialPortStream({ binding, path: `fake:${name}`, baudRate: 115200, autoOpen: false }));
	await port.open();
	return port;
}

export async function openFakePhonePort(entry: PhoneEntry, options: FakePhoneOptions = {}): Promise<{ port: AsyncSerialPort; phone: FakePhone }> {
	const phone = new FakePhone(entry, options);
	return { port: await openDevicePort(phone, entry.id), phone };
}
