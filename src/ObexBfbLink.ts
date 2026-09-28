import createDebug from 'debug';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { BFB_MAX_PAYLOAD_SIZE, BfbChannel, BfbCoreOpcode, encodeBfbFrame } from './BFB.js';
import { crc16 } from './crc16.js';
import { flushInput, readExact, trySetBaudRate } from './utils.js';

const debug = createDebug('obex');

// OBEX over BFB, for phones before the x55 generation (S45, ME45, SL45...), byte
// for byte like siefs and obexftp's libbfb.
//
// An OBEX packet travels in frames of the SERVICE_STREAM channel, which together
// carry
//   [0x02 first packet of the session | 0x03 any later one][~that][sequence]
//   [packet length, BE][packet][CRC-16/X.25 of sequence, length and packet, LE]
// and the receiver acknowledges every complete packet with a frame of its own.

const PACKET_FIRST = 0x02;
const PACKET_NEXT = 0x03;

export const HELLO = encodeBfbFrame(BfbChannel.CORE, [BfbCoreOpcode.PING]);
const HELLO_ANSWER = encodeBfbFrame(BfbChannel.CORE, [BfbCoreOpcode.PING, 0xAA]);
export const ACK_PAYLOAD = Buffer.from([0x01, 0xFE]);
export const ACK = encodeBfbFrame(BfbChannel.SERVICE_STREAM, ACK_PAYLOAD);
export const LEAVE = encodeBfbFrame(BfbChannel.AT, Buffer.from('at^sbfb=0\r', 'latin1'));

// After AT^SBFB=1 the phone speaks BFB at 57600 whatever speed the AT commands ran
// at, siefs also tries the faster ones
export const BFB_SPEEDS = [57600, 115200, 230400];

export type BfbTimeouts = {
	hello: number;       // for the answer to the hello
	ack: number;         // for an acknowledgement, on top of the time the packet takes on the wire
	flush: number;       // input flush read timeout
};

const SEND_ATTEMPTS = 3;

function crcX25(buffer: Buffer, offset: number, length: number): number {
	return crc16(buffer, offset, length) ^ 0xFFFF;
}

// Whether a frame holds the start of a packet: a marker, its complement, the sequence
// number and the length
function startsPacket(frame: Buffer): boolean {
	return frame.length >= 5 && (frame[0] | 1) == PACKET_NEXT && (frame[0] ^ frame[1]) == 0xFF;
}

// The frames that carry one OBEX packet, laid out as above
export function encodeBfbPacket(marker: number, sequence: number, packet: Buffer): Buffer {
	const data = Buffer.alloc(packet.length + 7);
	data[0] = marker;
	data[1] = ~marker & 0xFF;
	data[2] = sequence & 0xFF;
	data.writeUInt16BE(packet.length, 3);
	packet.copy(data, 5);
	data.writeUInt16LE(crcX25(data, 2, packet.length + 3), packet.length + 5);

	const frames: Buffer[] = [];
	for (let offset = 0; offset < data.length; offset += BFB_MAX_PAYLOAD_SIZE)
		frames.push(encodeBfbFrame(BfbChannel.SERVICE_STREAM, data.subarray(offset, offset + BFB_MAX_PAYLOAD_SIZE)));
	return Buffer.concat(frames);
}

export class ObexBfbLink {
	// close() hands the phone back to its AT interpreter
	readonly returnsToAt = true;
	private readonly port: AsyncSerialPort;
	private readonly timeouts: BfbTimeouts;
	// Packets sent so far: the first one of the session is marked as such
	private sent = 0;
	// The sequence number of the last packet received, a repeat of it is a resend
	private lastReceived = -1;
	// The first frame of an answer that send() read in place of the acknowledgement
	private answerFrame: Buffer | undefined;

	private constructor(port: AsyncSerialPort, timeouts: BfbTimeouts) {
		this.port = port;
		this.timeouts = timeouts;
	}

	static async open(port: AsyncSerialPort, timeouts: BfbTimeouts): Promise<ObexBfbLink> {
		for (const baudRate of BFB_SPEEDS) {
			if (!await trySetBaudRate(port, baudRate)) {
				debug(`The port refuses ${baudRate} baud`);
				continue;
			}
			for (let i = 0; i < 2; i++) {
				await flushInput(port, timeouts.flush);
				await port.write(HELLO);
				if ((await port.read(HELLO_ANSWER.length, timeouts.hello))?.equals(HELLO_ANSWER)) {
					debug(`BFB link at ${baudRate} baud.`);
					return new ObexBfbLink(port, timeouts);
				}
			}
		}
		throw new Error('The phone does not answer in BFB mode.');
	}

	// For a phone in BFB mode at an unknown speed: one the hello missed, or one a
	// killed program left behind
	static async leave(port: AsyncSerialPort, timeouts: BfbTimeouts): Promise<void> {
		for (const baudRate of BFB_SPEEDS) {
			if (!await trySetBaudRate(port, baudRate))
				continue;
			await port.write(LEAVE);
			// Also lets the frame leave the wire before the next speed change
			await flushInput(port, timeouts.flush);
		}
	}

	async send(packet: Buffer, signal?: AbortSignal): Promise<void> {
		const sequence = this.sent++;
		const wire = encodeBfbPacket(sequence == 0 ? PACKET_FIRST : PACKET_NEXT, sequence, packet);
		// The acknowledgement follows the last byte on the wire, and the write
		// returns long before that
		const ackTimeout = this.timeouts.ack + Math.ceil(wire.length * 10 * 1000 / this.port.baudRate);

		for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
			signal?.throwIfAborted();
			// Like siefs, acknowledge again first: the phone may still be resending a
			// packet of its own because our acknowledgement of it got lost
			if (attempt > 0) {
				await flushInput(this.port, this.timeouts.flush);
				await this.port.write(ACK);
			}
			await this.port.write(wire);
			const answer = await this.readDataFrame(Date.now() + ackTimeout, signal).catch(() => undefined);
			if (answer?.equals(ACK_PAYLOAD))
				return;
			// An answer means the packet arrived, and its acknowledgement got lost or comes
			// later. Sending the packet again would have the phone run the request twice.
			if (answer && startsPacket(answer) && answer[2] != this.lastReceived) {
				this.answerFrame = answer;
				return;
			}
			debug(`BFB packet ${sequence} was not acknowledged${answer?.length ? `, got ${answer.toString('hex')}` : ''}`);
		}
		throw new Error('The phone does not acknowledge BFB packets.');
	}

	async receive(timeout: number, signal?: AbortSignal): Promise<Buffer> {
		const deadline = Date.now() + timeout;
		while (true) {
			let data = await this.readDataFrame(deadline, signal);
			// Anything but the start of a packet, e.g. a stray acknowledgement
			if (!startsPacket(data))
				continue;
			const length = data.readUInt16BE(3);
			while (data.length < length + 7)
				data = Buffer.concat([data, await this.readDataFrame(deadline, signal)]);
			if (data.readUInt16LE(length + 5) != crcX25(data, 2, length + 3)) {
				// Not acknowledged, so the phone sends it again
				debug(`BFB packet ${data[2]} has a bad CRC`);
				continue;
			}
			await this.port.write(ACK);
			// A resend of the previous packet whose acknowledgement got lost
			if (data[2] == this.lastReceived)
				continue;
			this.lastReceived = data[2];
			return data.subarray(5, length + 5);
		}
	}

	async close(): Promise<void> {
		if (!this.port.isOpen)
			return;
		await this.port.write(LEAVE);
		await flushInput(this.port, this.timeouts.flush);
	}

	// The payload of the next SERVICE_STREAM frame, skipping frames of other
	// channels and bytes that start no frame
	private async readDataFrame(deadline: number, signal?: AbortSignal): Promise<Buffer> {
		const answerFrame = this.answerFrame;
		if (answerFrame) {
			this.answerFrame = undefined;
			return answerFrame;
		}
		let header = await readExact(this.port, 3, deadline, signal);
		while (true) {
			if ((header[0] ^ header[1]) != header[2] || header[1] > BFB_MAX_PAYLOAD_SIZE) {
				header = Buffer.concat([header.subarray(1), await readExact(this.port, 1, deadline, signal)]);
				continue;
			}
			const payload = await readExact(this.port, header[1], deadline, signal);
			if (header[0] == BfbChannel.SERVICE_STREAM)
				return payload;
			header = await readExact(this.port, 3, deadline, signal);
		}
	}
}
