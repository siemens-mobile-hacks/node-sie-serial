import createDebug from 'debug';
import { sprintf } from "sprintf-js";
import { hexdump } from "./utils.js";
import {
	ioProgressTracker,
	ioReadMemory,
	IoReadResult,
	IoReadWriteOptions,
	IoReadWriteProgress,
	ioWriteMemory,
	IoWriteResult
} from "./io.js";
import { BaseSerialProtocol } from "./BaseSerialProtocol.js";

const debug = createDebug('dwd');
const debugTrx = createDebug('dwd:trx');

const RAND1 = 5500; // (rand() % 60000) + 5500
const RAND2 = 5500; // (rand() % 60000) + 5500
const RAND3 = 5500; // (rand() % 60000) + 5500
const RAND4 = 0; // rand()
const MAX_MEMORY_READ_CHUNK = 230;
const MAX_MEMORY_WRITE_CHUNK = 226;

enum FrameType {
	NO_RESP = 0x00,
	CONNECT1_REQ = 0x58,
	CONNECT1_RESP = 0x57,
	CONNECT2_REQ = 0x59,
	CONNECT2_RESP = 0x56,
	READ_MEMORY_REQ = 0x76,
	READ_MEMORY_RESP = 0x77,
	WRITE_MEMORY_REQ = 0x78,
	WRITE_MEMORY_RESP = 0x79,
	SW_RESET_REQ = 0xAD,
	GET_SW_VERSION_REQ = 0x54,
	GET_SW_VERSION_RESP = 0x55,
}

export type DWDKeys = {
	key1: Buffer;
	key2: number;
	key3: Buffer;
	key4: number;
};

export type BruteforceKey1Options = {
	onProgress?: (progress: IoReadWriteProgress) => void;
	progressInterval?: number;
	signal?: AbortSignal | null;
};

export type BruteforceKey2Options = {
	onProgress?: (progress: IoReadWriteProgress) => void;
	onKeyFound?: (key2: number) => void;
	progressInterval?: number;
	timeout?: number;
	signal?: AbortSignal | null;
	from?: number;
	to?: number;
};

export type DWDMemoryRegion = {
	addr: number;
	size: number;
	name: string;
};

const FRAME_SIZE = {
	[FrameType.NO_RESP]: -1,
	[FrameType.CONNECT1_REQ]: 10,
	[FrameType.CONNECT1_RESP]: 10,
	[FrameType.CONNECT2_REQ]: 8,
	[FrameType.CONNECT2_RESP]: 0,
	[FrameType.READ_MEMORY_REQ]: 8,
	[FrameType.READ_MEMORY_RESP]: 0,
	[FrameType.WRITE_MEMORY_REQ]: 8,
	[FrameType.WRITE_MEMORY_RESP]: 4,
	[FrameType.SW_RESET_REQ]: 2,
	[FrameType.GET_SW_VERSION_REQ]: 2,
	[FrameType.GET_SW_VERSION_RESP]: 0,
};

export const DWD_KEYS: Record<string, DWDKeys> = {
	"auto": {
		key1: Buffer.from("00000000000000000000000000000000", "hex"),
		key2: 0x0000,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	},
	"service": { // service key for all APOXI
		key1: Buffer.from("F806A5AF18EE7E1C1E737C6CC0F95236", "hex"),
		key2: 0x7C6C,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	},
	"lg": {
		key1: Buffer.from("70C469DA2C399DB11E26AB61F0B25204", "hex"),
		key2: 0x62B5,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	},
	"panasonic": {
		key1: Buffer.from("A3F9A49C5DE37D922511958D56CE51F2", "hex"),
		key2: 0x17D2,
		key3: Buffer.from("00000000000000000000000000000000", "hex"),
		key4: 0x0000,
	}
};

export class DWDError extends Error {
	constructor(message: string, ...args: any[]) {
		const errorMessage = sprintf(message, args);
		debug(errorMessage);
		super(errorMessage);
	}
}

export class DWDTimeoutError extends DWDError {

}

export class DWD extends BaseSerialProtocol {
	private keys: DWDKeys = DWD_KEYS["auto"];

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
		if (this.keys === DWD_KEYS["auto"]) {
			let lastError: unknown | undefined;
			for (const keyName in DWD_KEYS) {
				if (keyName == "auto")
					continue;
				debug(`Trying key: ${keyName}`);
				try {
					this.setKeys(keyName);
					await this.connect();
					debug(`Key found: ${keyName}`);
					return;
				} catch (e) {
					debug(`Bad key: ${keyName}`);
					lastError = e;
				}
			}
			this.setKeys("auto");
			throw lastError;
		}

		debug("Enabling V24 mode");
		await this.setV24(true);
		debug("Sending handshake #1");
		const { keyRotate } = await this.connect1(this.keys);
		debug(sprintf("Handshake #1 successful, keyRotate=%02X", keyRotate));
		debug("Sending handshake #2");
		await this.connect2(keyRotate, this.keys);
		debug(sprintf("Handshake #2 successful, connected."));
	}

	async disconnect() {
		debug("Disabling V24 mode");
		await this.setV24(false);
	}

	async getSWVersion() {
		const request = this.newRequest(FrameType.GET_SW_VERSION_REQ);
		const response = await this.execCommand(request, FrameType.GET_SW_VERSION_RESP);
		const [sw, power, cpu] = response.subarray(4, -1).toString().split(/\s+/);
		return { sw, power, cpu };
	}

	async getMemoryRegions() {
		const memoryRegions: DWDMemoryRegion[] = [
			{
				name:	"TCM",
				addr:	0xFFFF0000,
				size:	0x00004000,
			}, {
				name:	"SRAM",
				addr:	0x00000000,
				size:	0x00018000,
			}
		];

		const EBU_ID = (await this.readMemory(0xF0000008, 4)).buffer.readUInt32LE(0)
		const EBU_REV = EBU_ID & 0xFF;
		debug(sprintf("EBU_ID=%08X, EBU_REV=%d", EBU_ID, EBU_REV));

		for (let i = 0; i < 4; i++) {
			let ADDRSEL: number = 0;
			let BUSCON: number = 0;

			if (EBU_REV < 8) {
				ADDRSEL = (await this.readMemory(0xF0000080 + i * 8, 4)).buffer.readUInt32LE(0);
				BUSCON = (await this.readMemory(0xF00000C0 + i * 8, 4)).buffer.readUInt32LE(0);
			} else {
				ADDRSEL = (await this.readMemory(0xF0000020 + i * 4, 4)).buffer.readUInt32LE(0);
				BUSCON = (await this.readMemory(0xF0000060 + i * 4, 4)).buffer.readUInt32LE(0);
			}

			const addr = (ADDRSEL & 0xFFFFF000) >>> 0;
			const mask = (ADDRSEL & 0x000000F0) >>> 4;
			const size = (1 << (27 - mask));
			const enabled = (ADDRSEL & 1) !== 0;
			const agen = (BUSCON & 0x70000000) >>> 28;

			debug(sprintf("CS%d: ADDRSEL=%08X, BUSCON=%08X", i, ADDRSEL, BUSCON));

			if (enabled) {
				if (addr >= 0xA0000000 && addr < 0xB0000000) {
					// NOR FLASH always on A0000000
					memoryRegions.push({ name: "FLASH", addr, size });
					debug(sprintf("  NOR FLASH %08X %08X", addr, size));
				} else if (agen == 3 || agen == 4) {
					// AGEN=SDRAM access type 0 or SDRAM access type 1
					memoryRegions.push({ name: "RAM", addr, size });
					debug(sprintf("  RAM %08X %08X", addr, size));
				} else {
					debug(sprintf("  UNKNOWN %08X %08X", addr, size));
				}
			}
		}

		memoryRegions.sort((a, b) => a.addr - b.addr);

		const nameCounter: Record<string, number> = {};
		const merged: DWDMemoryRegion[] = [];
		for (const region of memoryRegions) {
			const last = merged.at(-1);
			if (last && last.addr + last.size === region.addr && region.name == last.name) {
				last.size += region.size;
			} else {
				nameCounter[region.name] = (nameCounter[region.name] ?? 0) + 1;
				if (nameCounter[region.name] > 1)
					region.name += nameCounter[region.name] - 1;
				merged.push({ ...region });
			}
		}

		return merged;
	}

	async readMemory(address: number, length: number, options: IoReadWriteOptions = {}): Promise<IoReadResult> {
		return ioReadMemory({
			debug,
			pageSize: MAX_MEMORY_READ_CHUNK,
			align: 1,
			maxRetries: 3,
			read: this.readMemoryChunk.bind(this)
		}, address, length, options)
	}

	async writeMemory(address: number, buffer: Buffer, options: IoReadWriteOptions = {}): Promise<IoWriteResult> {
		return ioWriteMemory({
			debug,
			align: 1,
			pageSize: MAX_MEMORY_WRITE_CHUNK,
			maxRetries: 3,
			write: this.writeMemoryChunk.bind(this)
		}, address, buffer, options);
	}

	private async readMemoryChunk(addr: number, size: number, buffer: Buffer, bufferOffset: number): Promise<void> {
		const request = this.newRequest(FrameType.READ_MEMORY_REQ);
		request.writeUInt16LE(size, 2);
		request.writeUInt32LE(addr, 4);

		if (size > MAX_MEMORY_READ_CHUNK)
			throw new DWDError("readMemoryChunk: max size is %d, but requested %d!", MAX_MEMORY_READ_CHUNK, size);

		const response = await this.execCommand(request, FrameType.READ_MEMORY_RESP);
		if ((response.length - 4) < size)
			throw new DWDError("readMemoryChunk: requested %d bytes, but received only %d!", size, buffer.length);

		buffer.set(response.subarray(4, 4 + size), bufferOffset);
	}

	private async writeMemoryChunk(address: number, buffer: Buffer): Promise<void> {
		const request = this.newRequest(FrameType.WRITE_MEMORY_REQ, buffer.length);
		request.writeUInt16LE(buffer.length, 2);
		request.writeUInt32LE(address, 4);

		buffer.copy(request, 8);

		if (buffer.length > MAX_MEMORY_WRITE_CHUNK)
			throw new DWDError("writeMemoryChunk: max size is %d, but requested %d!", MAX_MEMORY_READ_CHUNK, buffer.length);

		await this.execCommand(request, FrameType.WRITE_MEMORY_RESP);
	}

	async poweroff(): Promise<void> {
		const request = this.newRequest(FrameType.SW_RESET_REQ);
		await this.execCommand(request, FrameType.NO_RESP);
	}

	async bruteforceKey2(options: BruteforceKey2Options = {}): Promise<number[]> {
		await this.setV24(true);

		const validOptions = {
			progressInterval: 100,
			timeout: 10,
			from: 0x0000,
			to: 0xFFFF,
			...options
		};

		const dummyKeys = {
			key1: Buffer.from("00000000000000000000000000000000", "hex"),
			key2: 0x0000,
			key3: Buffer.from("00000000000000000000000000000000", "hex"),
			key4: 0x0000,
		};

		const progress = ioProgressTracker({
			progressInterval: validOptions.progressInterval,
			onProgress: validOptions.onProgress,
			total: 0xFFFF
		});

		const possibleKeys: number[] = [];
		for (let key2 = validOptions.from; key2 <= validOptions.to; key2++) {
			if (validOptions.signal?.aborted) {
				debug("Bruteforce canceled by user.");
				break;
			}

			progress.report(key2);

			dummyKeys.key2 = key2;
			debug.enabled && debug(sprintf("Trying key2=%04X...", dummyKeys.key2));
			try {
				await this.connect1(dummyKeys, validOptions.timeout, false);
				debug.enabled && debug(sprintf("Key2 found: %04X", key2));
				options.onKeyFound && options.onKeyFound(key2);
				possibleKeys.push(key2);
			} catch (e) { }
		}

		progress.stop();

		return possibleKeys;
	}

	async bruteforceKey1(key2: number, options: BruteforceKey1Options = {}): Promise<DWDKeys | undefined> {
		await this.setV24(true);

		const validOptions = {
			progressInterval: 100,
			...options
		};

		const dummyKeys = {
			key1: Buffer.from("00000000000000000000000000000000", "hex"),
			key2,
			key3: Buffer.from("00000000000000000000000000000000", "hex"),
			key4: 0x0000,
		};
		const foundOffsets: Record<number, boolean> = {};

		const progress = ioProgressTracker({
			progressInterval: validOptions.progressInterval,
			onProgress: validOptions.onProgress,
			total: 16
		});

		while (Object.keys(foundOffsets).length < 16) {
			if (validOptions.signal?.aborted) {
				debug("Bruteforce canceled by user.");
				return undefined;
			}

			const { keyRotate, chk2 } = await this.connect1(dummyKeys, 300, false);
			if (foundOffsets[keyRotate])
				continue;

			const key3 = 0;
			for (let key1 = 0; key1 <= 0xFF; key1++) {
				const newChk2 = ((key1 << 4) ^ ((key3 << 3) ^ 0x7F39)) & 0xFFFF;
				if (chk2 == newChk2) {
					dummyKeys.key1[keyRotate] = key1;
					foundOffsets[keyRotate] = true;
					debug(sprintf("Found key1[%d] = %02X", keyRotate, key1));
					break;
				}
			}

			progress.report(Object.keys(foundOffsets).length);

			if (!foundOffsets[keyRotate]) {
				debug("Invalid key2.");
				return undefined;
			}
		}

		progress.stop();

		debug(sprintf("Found key1=%s, key2=%04X", dummyKeys.key1.toString("hex"), dummyKeys.key2));

		return dummyKeys;
	}

	async setV24(flag: boolean): Promise<void> {
		const cmd = Buffer.from([
			0x41, 0x54, 0x23, flag ? 0xFD : 0xFE,
			0x0D, 0x00, 0x66, 0x8D, 0xED
		]);
		debug.enabled && debug(sprintf(`[TX] %s`, hexdump(cmd)));
		await this.port.write(cmd);
		await this.port.read(32, 20);
	}

	private async connect1(keys: DWDKeys, timeout: number = 100, enableChk2: boolean = true): Promise<{ keyRotate: number, chk1: number, chk2: number }> {
		const request = this.newRequest(FrameType.CONNECT1_REQ);
		request.writeUInt16LE(RAND1 & 0xFFFF, 2);
		request.writeUInt16LE(((keys.key4 ^ keys.key2 ^ RAND1) + RAND2 + 0x4ed5) & 0xFFFF, 4);
		request.writeUInt16LE(RAND2 & 0xFFFF, 6);
		request.writeUInt16LE(RAND3 & 0xFFFF, 8);
		const response = await this.execCommand(request, FrameType.CONNECT1_RESP, timeout);

		const keyRotate = (response.readUInt16LE(6) - RAND2) & 0xF;
		const chk1 = (RAND1 * 8 - RAND2 ^ 0xD427) & 0xFFFF;
		if (chk1 != response.readUInt16LE(4))
			throw new DWDError(sprintf("Handshake #1 failed, chk1: %04X != %04X", chk1, response.readUInt16LE(4)));

		if (enableChk2) {
			const chk2 = ((keys.key1[keyRotate] << 4) ^ ((keys.key3[0xF - keyRotate] << 3) ^ 0x7F39)) & 0xFFFF;
			if (chk2 != response.readUInt16LE(8))
				throw new DWDError(sprintf("Handshake #1 failed, chk2: %04X != %04X", chk2, response.readUInt16LE(8)));
		}

		return {
			keyRotate,
			chk1: response.readUInt16LE(4),
			chk2: response.readUInt16LE(8)
		};
	}

	private async connect2(keyRotate: number, keys: DWDKeys, timeout: number = 100): Promise<void> {
		const request = this.newRequest(FrameType.CONNECT2_REQ);
		request.writeUInt16LE(RAND4, 2);
		request.writeUInt16LE((keys.key1[0xF - keyRotate] ^ keys.key3[keyRotate] << 4 ^ 0x4d33) & 0xFFFF, 4);
		request.writeUInt16LE(RAND4, 6);
		console.log(await this.execCommand(request, FrameType.CONNECT2_RESP, timeout));
	}

	newRequest(frameId: FrameType, payloadLength: number = 0): Buffer {
		const buffer = Buffer.alloc(FRAME_SIZE[frameId as FrameType] + payloadLength);
		buffer.writeUInt16LE(frameId);
		return buffer;
	}

	async execCommand(request: Buffer, responseFrameId: FrameType, timeout: number = 1000): Promise<Buffer> {
		const requestFrameId = request.readUInt16LE(0);
		const expectedRequestLength = FRAME_SIZE[requestFrameId as FrameType];
		if (request.length < expectedRequestLength) {
			throw new DWDError(sprintf("Invalid DWD request frame (%04X) length! (expected: %02X, received: %02X)",
				requestFrameId, expectedRequestLength, request.length));
		}

		debugTrx.enabled && debugTrx(sprintf(`[TX] %s`, hexdump(request)));

		await this.port.write(encapsulateDWDtoAT(request));
		const expectedResponseLength = FRAME_SIZE[responseFrameId];
		if (expectedResponseLength == -1) {
			return Buffer.alloc(0);
		} else if (expectedResponseLength == 0) {
			const frameHeader = await this.port.read(4, timeout);
			if (!frameHeader)
				throw new DWDTimeoutError("DWD command timeout! (header)");

			const receivedResponseFrameId = frameHeader.readUInt16LE(0);
			if (receivedResponseFrameId != responseFrameId) {
				debugTrx.enabled && debugTrx(sprintf(`[RX] %s`, hexdump(frameHeader)));
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame! (expected: %04X, received: %04X)",
					requestFrameId, responseFrameId, receivedResponseFrameId));
			}

			const expectedResponseLength = frameHeader.readUInt16LE(2);
			const frameBody = await this.port.read(expectedResponseLength, timeout);
			if (!frameBody)
				throw new DWDTimeoutError("DWD command (%04X) timeout! (body)", requestFrameId);

			debugTrx.enabled && debugTrx(sprintf(`[RX] %s %s`, hexdump(frameHeader), hexdump(frameBody)));
			if (frameBody.length != expectedResponseLength) {
				throw new DWDError(sprintf("Invalid DWD command (%04X) response frame (%04X) length! (expected: %d, received: %d)",
					requestFrameId, responseFrameId, expectedResponseLength, frameBody.length));
			}

			return Buffer.concat([frameHeader, frameBody]);
		} else {
			const response = await this.port.read(expectedResponseLength, timeout);
			if (!response)
				throw new DWDTimeoutError("DWD command (%04X) timeout! (body)", requestFrameId);
			debugTrx.enabled && debugTrx(sprintf(`[RX] %s`, hexdump(response)));

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
