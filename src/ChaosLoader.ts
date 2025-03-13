import fs from 'fs';
import createDebug from 'debug';
import { AsyncSerialPort } from "./AsyncSerialPort.js";
import { loadBootCode, LoadBootCodeOptions } from "./BSL.js";
import { sprintf } from 'sprintf-js';
import { decodeCString } from './utils.js';

const debug = createDebug("chaos");

const READ_PAGE_TIMEOUT					= 1000;
const READ_PAGE_SIZE_START				= 0x10000; // 64k
const READ_BIG_PAGE_SIZE_MIN			= 0x4000; // 16k
const READ_PAGE_SIZE_MIN				= 0x80; // 128
const READ_PAGE_SIZE_TRY_COUNT			= 5;
const READ_BIG_PAGE_SIZE_TRY_COUNT		= 2;

const WRITE_PAGE_TIMEOUT				= 1000;
const WRITE_PAGE_SIZE_START				= 0x10000; // 64k
const WRITE_BIG_PAGE_SIZE_MIN			= 0x4000; // 16k
const WRITE_PAGE_SIZE_MIN				= 0x80; // 128
const WRITE_PAGE_SIZE_TRY_COUNT			= 5;
const WRITE_BIG_PAGE_SIZE_TRY_COUNT		= 2;

enum RESPONSES {
	HELLO					= 0xA5,
	PONG					= 0x52,
	BAUDRATE_WAIT_FOR_ACK	= 0x68,
	BAUDRATE_CHANGED		= 0x48,
	OK						= 0x4B4F,
	CHECKSUM_ERROR			= 0xBBBB,
}

enum CMD {
	PING				= 0x41, // A
	SET_BAUDRATE		= 0x48, // H
	SET_BAUDRATE_ACK	= 0x41, // A
	GET_INFO			= 0x49, // I
	QUIT				= 0x51, // Q
	TEST				= 0x54, // T
	READ_FLASH			= 0x52, // R
	WRITE_FLASH			= 0x46, // F
	WRITE_RAM			= 0x57, // W
	READ_CFI			= 0x43, // C
	HEARTBEAT			= 0x2E, // .
}

const BAUDRATES: Record<number, number> = {
	57600:		0,
	115200:		1,
	230400:		2,
	460800:		3,
	614400:		4,
	921600:		5,
	1228800:	6,
	1500000:	8,
	1600000:	7,
	1625000:	7,
	3250000:	9,
};

export type ChaosFlashRegion = {
	addr: number;
	size: number;
	eraseSize: number;
};

export type ChaosPhoneInfo = {
	model: string;
	vendor: string;
	imei: string;
	reserved0: Buffer;
	flashBase: number;
	reserved1: Buffer;
	flashVID: number;
	flashPID: number;
	flashSize: number;
	writeBufferSize: number;
	flashRegionsNum: number;
	regions: ChaosFlashRegion[];
};

export type ChaosReadWriteOptions = {
	onProgress?: (progress: ChaosReadWriteProgress) => void;
	chunkSize?: number;
	progressInterval?: number;
	signal?: AbortSignal | null;
};

export type ChaosReadWriteProgress = {
	pageAddr?: number;
	pageSize?: number;
	cursor: number;
	total: number;
	elapsed: number;
};

export type ChaosWriteResult = {
	canceled: boolean;
	written: number;
};

export type ChaosReadResult = {
	canceled: boolean;
	buffer: Buffer;
};

export class ChaosLoaderError extends Error {
	constructor(error: string) {
		super(error)
		debug(`[ChaosLoaderError] ${error}`)
	}
}

export class ChaosLoader {
	private readonly port: AsyncSerialPort<any>;
	private isConnected = false;
	private heartbeatTimer?: NodeJS.Timeout;
	private phoneInfo?: ChaosPhoneInfo;
	private lastGoodPageSize: number = 0;

	static getSupportedBaudrates(): number[] {
		return Object.keys(BAUDRATES).map(parseInt);
	}

	constructor(port: AsyncSerialPort<any>) {
		this.port = port;
	}

	async connect(options: LoadBootCodeOptions = {}): Promise<void> {
		const bootCode = fs.readFileSync("../pmb887x-dev/boot/chaos_x85.bin");
		const bootStatus = await loadBootCode(this.port, bootCode, options);
		if (!bootStatus.success)
			throw new ChaosLoaderError(bootStatus.error);

		debug("Waiting response from chaos loader...");

		const ack = await this.port.readByte(1000);
		if (ack == -1) {
			throw new ChaosLoaderError("Timeout, chaos is not responding.");
		} else if (ack != RESPONSES.HELLO) {
			throw new ChaosLoaderError(sprintf("Invalid chaos ACK: %02X", ack));
		}

		debug("Chaos loader is OK");
		this.startHeartbeatTimer();
	}

	private startHeartbeatTimer(): void {
		if (!this.heartbeatTimer)
			this.heartbeatTimer = setInterval(() => this.heartbeat(), 250);
	}

	private stopHeartbeatTimer(): void {
		if (this.heartbeatTimer) {
			clearInterval(this.heartbeatTimer);
			this.heartbeatTimer = undefined;
		}
	}

	private async heartbeat(): Promise<void> {
		await this.port.write(Buffer.from([CMD.HEARTBEAT]));
	}

	async unlock(): Promise<void> {
		if (!await this.ping())
			throw new ChaosLoaderError(`ERROR: Can't unlock chaos loader!`);

		await this.port.write(Buffer.from([CMD.GET_INFO]));

		const response = await this.port.read(128, 1000);
		if (!response)
			throw new ChaosLoaderError(`ERROR: Can't get phone info! (timeout)`);
		if (response.length != 128)
			throw new ChaosLoaderError(`ERROR: Can't get phone info! (invalid response, ${response.length} != 128)`);

		const info: Partial<ChaosPhoneInfo> = {};
		let offset = 0;

		info.model = decodeCString(response.subarray(offset, offset + 16));
		offset += 16;

		info.vendor = decodeCString(response.subarray(offset, offset + 16));
		offset += 16;

		info.imei = decodeCString(response.subarray(offset, offset + 16));
		offset += 16;

		info.reserved0 = response.subarray(offset, offset + 16);
		offset += 16;

		info.flashBase = response.readUInt32LE(offset);
		offset += 4;

		info.reserved1 = response.subarray(offset, offset + 12);
		offset += 12;

		info.flashVID = response.readUInt16LE(offset);
		offset += 2;

		info.flashPID = response.readUInt16LE(offset);
		offset += 2;

		info.flashSize = response.readUInt8(offset);
		offset += 1;

		info.writeBufferSize = response.readUInt16LE(offset);
		offset += 2;

		info.flashRegionsNum = response.readUInt8(offset);
		offset += 1;

		info.regions = [];

		let totalFlashSize = 0;
		for (let i = 0; i < info.flashRegionsNum; i++) {
			const count = response.readUInt16LE(offset) + 1;
			offset += 2;

			const size = response.readUInt16LE(offset) * 256;
			offset += 2;

			totalFlashSize += count * size;

			info.regions.push({
				addr: info.flashBase + totalFlashSize,
				size: count * size,
				eraseSize: size
			});
		}

		debug(`Phone: ${info.vendor} ${info.model} (${info.imei})`);
		debug(sprintf(`Flash: %04X:%04X (%dM)`, info.flashVID, info.flashPID, totalFlashSize / 1024 / 1024));
		let i = 0;
		for (const region of info.regions) {
			debug(sprintf("  REGION #%d: %08X-%08X [%d x %dk]", i, region.addr, region.addr + region.size, region.size / region.eraseSize, region.eraseSize / 1024));
			i++;
		}

		this.phoneInfo = info as ChaosPhoneInfo;
	}

	async setSpeed(baudRate: number): Promise<void> {
		let response: number;

		this.stopHeartbeatTimer();

		if (!(baudRate in BAUDRATES))
			throw new ChaosLoaderError(`Baudrate ${baudRate} is not supported!`);

		debug(`Setting new baudrate: ${baudRate}`);
		const baudrateIndex = BAUDRATES[baudRate];

		// Request new baudrate
		await this.port.write(Buffer.from([CMD.SET_BAUDRATE, baudrateIndex]));
		response = await this.port.readByte(100);
		if (response == -1) {
			throw new ChaosLoaderError(`setSpeed(${baudRate}): response timeout!`);
		} else if (response != RESPONSES.BAUDRATE_WAIT_FOR_ACK) {
			throw new ChaosLoaderError(`setSpeed(${baudRate}): invalid ACK 0x${response.toString(16)}`);
		}

		// Change port baudrate
		await this.port.update({ baudRate: baudRate });

		// Check if new baudrate is working
		await this.port.write(Buffer.from([CMD.SET_BAUDRATE_ACK, baudrateIndex]));
		response = await this.port.readByte(100);
		if (response == -1) {
			throw new ChaosLoaderError(`setSpeed(${baudRate}): response timeout!`);
		} else if (response != RESPONSES.BAUDRATE_CHANGED) {
			throw new ChaosLoaderError(`setSpeed(${baudRate}): invalid ACK 0x${response.toString(16)}`);
		}

		this.startHeartbeatTimer();
	}

	async testMemory(addr: number, size: number): Promise<boolean> {
		this.stopHeartbeatTimer();

		if ((addr % 4) != 0)
			throw new ChaosLoaderError(`Address ${sprintf("%08X", size)} is not aligned by 4.`);

		if ((size % 8) != 0)
			throw new ChaosLoaderError(`Size ${sprintf("%08X", size)} is not aligned by 8.`);

		const cmd = Buffer.alloc(9);
		cmd.writeUInt8(CMD.TEST);
		cmd.writeUInt32BE(addr, 1);
		cmd.writeUInt32BE(size, 5);
		await this.port.write(cmd);

		const response = await this.port.readByte(READ_PAGE_TIMEOUT);
		this.startHeartbeatTimer();

		if (response == -1) {
			throw new ChaosLoaderError(`testMemory(): response timeout!`);
		} else if (response != 0x00 && response != 0xFF) {
			throw new ChaosLoaderError(`testMemory(): invalid response 0x${response.toString(16)}`);
		}

		return response == 0xFF;
	}

	async writeMemory(addr: number, buffer: Buffer, options: ChaosReadWriteOptions = {}): Promise<ChaosWriteResult> {
		const validOptions = {
			progressInterval: 500,
			...options
		};

		this.stopHeartbeatTimer();

		let pageSize = WRITE_PAGE_SIZE_START;
		let bytesWritten = 0;
		let errorsCount = 0;
		let canceled = false;
		let lastProgressCalled = 0;
		const start = Date.now();

		debug(sprintf("Writing memory: %08X-%08X", addr, addr + buffer.length - 1));
		debug(sprintf("Initial page size: 0x%02X", pageSize));

		let writeTryCount = 0;
		while (bytesWritten < buffer.length) {
			const chunkSize = Math.min(pageSize, buffer.length - bytesWritten);
			const pageWriteStart = Date.now();

			if (validOptions.signal?.aborted) {
				canceled = true;
				debug("Writing canceled by user.");
				break;
			}

			if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && bytesWritten > 0)) {
				validOptions.onProgress && validOptions.onProgress({
					pageAddr: addr + bytesWritten,
					pageSize: chunkSize,
					cursor: bytesWritten,
					total: buffer.length,
					elapsed: Date.now() - start
				});
				lastProgressCalled = Date.now();
			}

			if (await this.writeMemoryChunk(addr + bytesWritten, buffer.subarray(bytesWritten, bytesWritten + chunkSize))) {
				bytesWritten += chunkSize;
				writeTryCount = 0;
			} else {
				errorsCount++;

				while (Date.now() - pageWriteStart <= WRITE_PAGE_TIMEOUT)
					await this.heartbeat();

				let phoneIsAlive = false;
				for (let i = 0; i < 16; i++) {
					await this.heartbeat();
					if (await this.ping()) {
						phoneIsAlive = true;
						break;
					}
				}

				this.stopHeartbeatTimer();

				if (!phoneIsAlive)
					throw new ChaosLoaderError("Phone connection is lost!");

				if (buffer.length - bytesWritten > WRITE_PAGE_SIZE_MIN) {
					const maxWriteTries = pageSize >= WRITE_BIG_PAGE_SIZE_MIN ? WRITE_BIG_PAGE_SIZE_TRY_COUNT : WRITE_PAGE_SIZE_TRY_COUNT;
					writeTryCount++;
					if (writeTryCount >= maxWriteTries) {
						writeTryCount = 0;
						if (pageSize > WRITE_PAGE_SIZE_MIN) {
							pageSize = pageSize / 2;
							debug(sprintf("Decreasing page size: 0x%02X", pageSize));
						}
					}
				}
			}
		}

		this.startHeartbeatTimer();

		validOptions.onProgress && validOptions.onProgress({
			cursor: bytesWritten,
			total: buffer.length,
			elapsed: Date.now() - start
		});

		return { written: bytesWritten, canceled };
	}

	async writeMemoryChunk(addr: number, buffer: Buffer): Promise<boolean> {
		debug(sprintf("Writing page %08X-%08X", addr, addr + buffer.length - 1));

		let chk = 0;
		for (let i = 0; i < buffer.length; i++)
			chk ^= buffer[i];

		const cmd = Buffer.alloc(buffer.length + 10);
		cmd.writeUInt8(CMD.WRITE_RAM, 0);
		cmd.writeUInt32BE(addr, 1);
		cmd.writeUInt32BE(buffer.length, 5);
		buffer.copy(cmd, 9);
		cmd.writeUInt8(chk, cmd.length - 1);

		await this.port.write(cmd);

		const response = await this.port.read(2, WRITE_PAGE_TIMEOUT);
		if (!response) {
			debug(`ERROR: memory write timeout!`);
			return false;
		} else if (response.length != 2) {
			debug(`ERROR: received unexpected bytes count (expected: 2, received: ${response.length})`);
			return false;
		}

		const status = response.readUInt16LE(0);
		if (status == RESPONSES.CHECKSUM_ERROR) {
			debug(`ERROR: written data is corrupted`);
			return false;
		} else if (status != RESPONSES.OK) {
			debug(sprintf(`ERROR: invalid response: %04X`, status));
			return false;
		}

		return true;
	}

	async readMemory(addr: number, size: number, options: ChaosReadWriteOptions = {}): Promise<ChaosReadResult> {
		const validOptions = {
			progressInterval: 500,
			...options
		};
		const buffer = Buffer.alloc(size);

		this.stopHeartbeatTimer();

		let pageSize = READ_PAGE_SIZE_START;
		let bytesRead = 0;
		let errorsCount = 0;
		let canceled = false;
		let lastProgressCalled = 0;
		const start = Date.now();

		debug(sprintf("Reading memory: %08X-%08X", addr, addr + size - 1));
		debug(sprintf("Initial page size: 0x%02X", pageSize));

		let readTryCount = 0;
		while (bytesRead < size) {
			const chunkSize = Math.min(pageSize, size - bytesRead);
			const pageReadStart = Date.now();

			if (validOptions.signal?.aborted) {
				canceled = true;
				debug("Reading canceled by user.");
				break;
			}

			if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && bytesRead > 0)) {
				validOptions.onProgress && validOptions.onProgress({
					pageAddr: addr + bytesRead,
					pageSize: chunkSize,
					cursor: bytesRead,
					total: buffer.length,
					elapsed: Date.now() - pageReadStart
				});
				lastProgressCalled = Date.now();
			}

			if (await this.readMemoryChunk(addr + bytesRead, chunkSize, buffer, bytesRead)) {
				bytesRead += chunkSize;
				readTryCount = 0;
			} else {
				errorsCount++;

				while (Date.now() - pageReadStart <= READ_PAGE_TIMEOUT)
					await this.heartbeat();

				let phoneIsAlive = false;
				for (let i = 0; i < 16; i++) {
					await this.heartbeat();
					if (await this.ping()) {
						phoneIsAlive = true;
						break;
					}
				}

				this.stopHeartbeatTimer();

				if (!phoneIsAlive)
					throw new ChaosLoaderError("Phone connection is lost!");

				if (size - bytesRead > READ_PAGE_SIZE_MIN) {
					const maxReadTries = pageSize >= READ_BIG_PAGE_SIZE_MIN ? READ_BIG_PAGE_SIZE_TRY_COUNT : READ_PAGE_SIZE_TRY_COUNT;
					readTryCount++;
					if (readTryCount >= maxReadTries) {
						readTryCount = 0;
						if (pageSize > READ_PAGE_SIZE_MIN) {
							pageSize = pageSize / 2;
							debug(sprintf("Decreasing page size: 0x%02X", pageSize));
						}
					}
				}
			}
		}

		this.startHeartbeatTimer();

		validOptions.onProgress && validOptions.onProgress({
			cursor: bytesRead,
			total: buffer.length,
			elapsed: Date.now() - start
		});

		return { buffer, canceled };
	}

	async readMemoryChunk(addr: number, size: number, buffer: Buffer, bufferOffset: number = 0) {
		debug(sprintf("Reading page %08X-%08X", addr, addr + size - 1));

		const cmd = Buffer.alloc(9);
		cmd.writeUInt8(CMD.READ_FLASH, 0);
		cmd.writeUInt32BE(addr, 1);
		cmd.writeUInt32BE(size, 5);
		await this.port.write(cmd);

		const response = await this.port.read(size + 4, READ_PAGE_TIMEOUT);
		if (!response) {
			debug(`ERROR: flash read timeout!`);
			return false;
		} else if (response.length != size + 4) {
			debug(`ERROR: received unexpected bytes count (expected: ${size + 5}, received: ${response.length})`);
			return false;
		}

		const status = response.readUInt16LE(size);
		const receivedChk = response.readUInt16LE(size + 2);

		if (status != RESPONSES.OK) {
			debug(sprintf(`ERROR: invalid response: %04X`, status));
			return false;
		}

		let chk = 0;
		for (let i = 0; i < size; i++)
			chk ^= response[i];

		if (chk != receivedChk) {
			debug(sprintf(`ERROR: received data is corrupted (CHK %04X != %04X)`, receivedChk, chk));
			return false;
		}

		response.copy(buffer, bufferOffset, 0, size);
		return true;
	}

	getPhoneInfo(): ChaosPhoneInfo {
		if (this.phoneInfo == null)
			throw new Error("Phone is not connected!");
		return this.phoneInfo;
	}

	async ping(): Promise<boolean> {
		this.stopHeartbeatTimer();
		await this.port.write(Buffer.from([CMD.PING]));
		const pingResponse = await this.port.readByte(100);
		if (pingResponse == RESPONSES.PONG) {
			this.startHeartbeatTimer();
			return true;
		} else if (pingResponse == -1) {
			debug("ERROR: ping response timeout.");
		} else {
			debug(sprintf(`ERROR: invalid ping response: %02X`, pingResponse));
		}
		this.startHeartbeatTimer();
		return false;
	}

	async disconnect(): Promise<void> {
		this.stopHeartbeatTimer();
		await this.port.write(Buffer.from([CMD.QUIT]));
	}
}
