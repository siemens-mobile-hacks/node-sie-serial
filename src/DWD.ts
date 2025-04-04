import createDebug from 'debug';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { sprintf } from "sprintf-js";
import { hexdump, retryAsync } from "./utils.js";
import { ioReadMemory, IoReadResult, IoReadWriteOptions } from "./io.js";

const debug = createDebug('dwd');

const RAND1 = 5500; // (rand() % 60000) + 5500
const RAND2 = 5500; // (rand() % 60000) + 5500
const RAND3 = 5500; // (rand() % 60000) + 5500
const RAND4 = 0; // rand()
const MAX_MEMORY_READ_CHUNK = 230;

enum FrameType {
	NO_RESP = 0x00,
	CONNECT1_REQ = 0x58,
	CONNECT1_RESP = 0x57,
	CONNECT2_REQ = 0x59,
	CONNECT2_RESP = 0x56,
	READ_MEMORY_REQ = 0x76,
	READ_MEMORY_RESP = 0x77,
	SW_RESET_REQ = 0xAD,
}

export type DWDKeys = {
	key1: Buffer;
	key2: number;
	key3: Buffer;
	key4: number;
};

const FRAME_SIZE = {
	[FrameType.NO_RESP]: -1,
	[FrameType.CONNECT1_REQ]: 10,
	[FrameType.CONNECT1_RESP]: 10,
	[FrameType.CONNECT2_REQ]: 8,
	[FrameType.CONNECT2_RESP]: 6,
	[FrameType.READ_MEMORY_REQ]: 8,
	[FrameType.READ_MEMORY_RESP]: 0,
	[FrameType.SW_RESET_REQ]: 2
};

export const DWD_KEYS: Record<string, DWDKeys> = {
	"lg": {
		key1: Buffer.from("70C469DA2C399DB11E26AB61F0B25204", "hex"),
		key2: 0x62B5,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	},
	"panasonic": {
		key1: Buffer.from("F806A5AF18EE7E1C1E737C6CC0F95236", "hex"),
		key2: 0x7C6C,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	}
};

export class DWDError extends Error {
	constructor(message: string, ...args: any[]) {
		const errorMessage = sprintf(message, args);
		debug("ERROR: " + errorMessage);
		super(errorMessage);
	}
}

export class DWD {
	private port: AsyncSerialPort;
	private keys: DWDKeys = DWD_KEYS["panasonic"];

	constructor(port: AsyncSerialPort) {
		this.port = port;
	}

	setKeys(keys: DWDKeys | string) {
		if (typeof keys === "string") {
			if (!DWD_KEYS[keys.toLowerCase()]) {
				throw new DWDError(`Keys for ${keys} not found.`);
			}
			this.keys = DWD_KEYS[keys.toLowerCase()];
		} else {
			this.keys = keys;
		}
	}

	async connect() {
		debug("Enabling V24 mode");
		await this.setV24(true);
		debug("Sending handshake #1");
		const keyRotate = await this.connect1(this.keys);
		debug(sprintf("Handshake #1 successful, keyRotate=%02X", keyRotate));
		debug("Sending handshake #2");
		await this.connect2(keyRotate, this.keys);
		debug(sprintf("Handshake #2 successful, connected."));
	}

	async disconnect() {
		debug("Disabling V24 mode");
		await this.setV24(false);
	}

	async readMemory(address: number, length: number, options: IoReadWriteOptions = {}): Promise<IoReadResult> {
		return ioReadMemory({
			debug,
			chunkSize: MAX_MEMORY_READ_CHUNK,
			readMemoryChunk: async (address: number, length: number, buffer: Buffer, bufferOffset: number) => {
				const error = await retryAsync<unknown>(async () => {
					try {
						await this.readMemoryChunk(address, length, buffer, bufferOffset);
						return undefined;
					} catch (e) {
						return e;
					}
				}, { max: 3, until: (error) => error != null });
				if (error != null)
					throw error;
			}
		}, address, length, options)
	}

	async readMemoryChunk(addr: number, size: number, buffer: Buffer, bufferOffset: number): Promise<void> {
		const request = this.newRequest(FrameType.READ_MEMORY_REQ);
		request.writeUInt16LE(size, 2);
		request.writeUInt32LE(addr, 4);

		if (size > MAX_MEMORY_READ_CHUNK)
			throw new DWDError("readMemory: max size is %d, but requested %d!", MAX_MEMORY_READ_CHUNK, size);

		const response = await this.execCommand(request, FrameType.READ_MEMORY_RESP);
		if ((response.length - 4) < size)
			throw new DWDError("readMemory: requested %d bytes, but received only %d!", size, buffer.length);

		buffer.set(response.subarray(4, 4 + size), bufferOffset);
	}

	async poweroff() {
		const request = this.newRequest(FrameType.SW_RESET_REQ);
		await this.execCommand(request, FrameType.NO_RESP);
	}

	async setV24(flag: boolean) {
		const cmd = Buffer.from([
			0x41, 0x54, 0x23, flag ? 0xFD : 0xFE,
			0x0D, 0x00, 0x66, 0x8D, 0xED
		]);
		debug.enabled && debug(sprintf(`[TX] %s`, hexdump(cmd)));
		await this.port.write(cmd);
		await this.port.read(32, 20);
	}

	private async connect1(keys: DWDKeys, timeout: number = 100): Promise<number> {
		const request = this.newRequest(FrameType.CONNECT1_REQ);
		request.writeUInt16LE(RAND1 & 0xFFFF, 2);
		request.writeUInt16LE(((keys.key4 ^ keys.key2 ^ RAND1) + RAND2 + 0x4ed5) & 0xFFFF, 4);
		request.writeUInt16LE(RAND2 & 0xFFFF, 6);
		request.writeUInt16LE(RAND3 & 0xFFFF, 8);
		const response = await this.execCommand(request, FrameType.CONNECT1_RESP, timeout);

		const keyRotate = (response.readUInt16LE(6) - RAND2) & 0xF;
		const chk1 = (RAND1 * 8 - RAND2 ^ 0xd427) & 0xFFFF;
		if (chk1 != response.readUInt16LE(4))
			throw new DWDError(sprintf("Handshake #1 failed, chk1: %04X != %04X", chk1, response.readUInt16LE(4)));

		const chk2 = ((keys.key1[keyRotate] << 4) ^ ((keys.key3[0xF - keyRotate] << 3) ^ 0x7F39)) & 0xFFFF;
		if (chk2 != response.readUInt16LE(8))
			throw new DWDError(sprintf("Handshake #1 failed, chk2: %04X != %04X", chk2, response.readUInt16LE(8)));

		return keyRotate;
	}

	private async connect2(keyRotate: number, keys: DWDKeys, timeout: number = 100): Promise<void> {
		const request = this.newRequest(FrameType.CONNECT2_REQ);
		request.writeUInt16LE(RAND4, 2);
		request.writeUInt16LE((keys.key1[0xF - keyRotate] ^ keys.key3[keyRotate] << 4 ^ 0x4d33) & 0xFFFF, 4);
		request.writeUInt16LE(RAND4, 6);
		await this.execCommand(request, FrameType.CONNECT2_RESP, timeout);
	}

	newRequest(frameId: FrameType, payloadLength: number = 0): Buffer {
		const buffer = Buffer.alloc(FRAME_SIZE[frameId as FrameType] + payloadLength);
		buffer.writeUInt16LE(frameId);
		return buffer;
	}

	async execCommand(request: Buffer, responseFrameId: FrameType, timeout: number = 0): Promise<Buffer> {
		const requestFrameId = request.readUInt16LE(0);
		const expectedRequestLength = FRAME_SIZE[requestFrameId as FrameType];
		if (request.length != expectedRequestLength) {
			throw new DWDError(sprintf("Invalid DWD request frame (%04X) length! (expected: %02X, received: %02X)",
				requestFrameId, expectedRequestLength, request.length));
		}

		debug.enabled && debug(sprintf(`[TX] %s`, hexdump(request)));

		await this.port.write(encapsulateDWDtoAT(request));
		const expectedResponseLength = FRAME_SIZE[responseFrameId];
		if (expectedResponseLength == -1) {
			return Buffer.alloc(0);
		} else if (expectedResponseLength == 0) {
			const frameHeader = await this.port.read(4);
			if (!frameHeader)
				throw new DWDError("DWD command timeout! (header)");
			debug.enabled && debug(sprintf(`[RX] [header] %s`, hexdump(frameHeader)));

			const receivedResponseFrameId = frameHeader.readUInt16LE(0);
			if (receivedResponseFrameId != responseFrameId) {
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame! (expected: %04X, received: %04X)",
					requestFrameId, responseFrameId, receivedResponseFrameId));
			}

			const expectedResponseLength = frameHeader.readUInt16LE(2);
			const frameBody = await this.port.read(expectedResponseLength);
			if (!frameBody)
				throw new DWDError("DWD command (%04X) timeout! (body)", requestFrameId);
			debug.enabled && debug(sprintf(`[RX] [body] %s`, hexdump(frameHeader)));

			if (frameBody.length != expectedResponseLength) {
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame (%04X) length! (expected: %d, received: %d)",
					requestFrameId, responseFrameId, expectedResponseLength, frameBody.length));
			}

			return Buffer.concat([frameHeader, frameBody]);
		} else {
			const response = await this.port.read(expectedResponseLength, timeout);
			if (!response)
				throw new DWDError("DWD command (%04X) timeout! (body)", requestFrameId);
			debug.enabled && debug(sprintf(`[RX] %s`, hexdump(response)));

			const receivedResponseFrameId = response.readUInt16LE(0);
			if (receivedResponseFrameId != responseFrameId) {
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame! (expected: %04X, received: %04X)",
					requestFrameId, responseFrameId, receivedResponseFrameId));
			}

			if (response.length != expectedResponseLength) {
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame (%04X) length! (expected: %d, received: %d)",
					requestFrameId, responseFrameId, expectedResponseLength, response.length));
			}

			return response;
		}
	}
}

export function encapsulateDWDtoAT(input: Buffer): Buffer {
	const positions: number[] = [];
	const escapedData = Buffer.from(input.map((byte, index) => {
		if (byte === 0x0D) {
			positions.push(14 + index);
			return 0x0C;
		}
		return byte;
	}));
	return Buffer.concat([
		Buffer.from("AT#"),
		Buffer.from([positions.length, ...positions]),
		escapedData,
		Buffer.from("\r"),
	]);
}
