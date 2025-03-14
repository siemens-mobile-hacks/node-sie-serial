import createDebug from 'debug';
import { AtChannel } from "./AtChannel.js";
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { sprintf } from 'sprintf-js';
import { retryAsync } from "./utils.js";

const debug = createDebug('cgsn');

const SERIAL_BAUD_RATES = [115200, 460800, 921600];

/*
 * AT+CGSN:A0000000,00000008
 * Read data from memory address A0000000 Length 8 Bytes (If Size is not specified then read 256 bytes)
 *
 * AT+CGSN@A08E8DE4,0000001A,00004225
 * Call address A08E8DE4, R0 = 0000001A, R1 = 00004225 (R0-R7 Can be given)
 * Out is the R0-R12 Registers Dump and CPSR
 *
 * AT+CGSN*A80B180011223344....
 * Write Data to RAM. address A80B1800
 * Max Size 128 bytes per command
 *
 * AT+CGSN%A0000000A0000004A0000008....
 * Query addresses. Return values for each address in one line.
*/

export type CgsnBaseResponse<Payload = {}> =
	| ({ success: true; error?: string } & Payload)
	| ({ success: false; error: string } & Partial<Payload>);

export type CgsnRegisters = {
	r0: number;
	r1: number;
	r2: number;
	r3: number;
	r4: number;
	r5: number;
	r6: number;
	r7: number;
	r8: number;
	r9: number;
	r10: number;
	r11: number;
	r12: number;
	cpsr: number;
};

export type CgsnExecuteResponse = CgsnBaseResponse<{
	regs: CgsnRegisters
}>;

export type CgsnQueryResponse = CgsnBaseResponse<{
	values: number[]
}>;

export type CgsnReadResponse = CgsnBaseResponse<{
	canceled: boolean;
	buffer: Buffer;
}>;

export type CgsnWriteResponse = CgsnBaseResponse<{
	canceled: boolean;
	written: number;
}>;

export type CgsnReadWriteOptions = {
	onProgress?: (cursor: number, total: number, elapsed: number) => void;
	chunkSize?: number;
	progressInterval?: number;
	signal?: AbortSignal | null;
};

export class CGSN {
	private readonly port: AsyncSerialPort;
	private readonly atc: AtChannel;
	private connectionType: string = "";
	private isConnected = false;

	constructor(port: AsyncSerialPort) {
		this.port = port;
		this.atc = new AtChannel(port);
	}

	async connect(testBaudRates?: number[]) {
		if (this.isConnected)
			await this.disconnect();

		this.atc.start();
		testBaudRates ||= SERIAL_BAUD_RATES;
		for (const baudRate of testBaudRates) {
			await this.port.update({ baudRate: baudRate });
			if (await this.tryHandshake()) {
				this.isConnected = true;
				if (!await this.checkCgsnPatch()) {
					this.isConnected = false;
					debug(`CGSN patch not found!`);
					return false;
				}

				this.connectionType = await this.getCurrentConnectionType();
				debug(`connectionType=${this.connectionType}`);

				if (this.connectionType == 'BLUE') {
					debug(`Switching to GIPSY`);
					await this.atc.sendCommand("AT^SQWE = 2"); // GIPSY
				} else {
					debug(`Switching to RCCP`);
					await this.atc.sendCommand("AT^SQWE = 0"); // RCCP
				}

				for (let i = 0; i < 3; i++) {
					if (await this.atc.handshake()) {
						this.isConnected = true;
						return true;
					}
				}

				debug(`Phone is lost after mode switching...`);

				this.isConnected = false;
				return false;
			}
		}
		return false;
	}

	private async checkCgsnPatch() {
		const response = await this.readMemory(0xA000003C, 4);
		return response.success && response.buffer.equals(Buffer.from("CJKT"));

	}

	private async tryHandshake() {
		debug(`Probing AT handshake at ${this.port.baudRate}...`);
		if (await this.atc.handshake()) {
			debug("Phone is found!");
			return true;
		} else {
			debug(`Phone is not found.`);
			return false;
		}
	}

	private async getCurrentConnectionType() {
		const response = await retryAsync(async () => await this.atc.sendCommand("AT^SIFS", "^SIFS", 750), {
			max: 3,
			until: (response) => !response.success
		});
		if (response.success)
			return response.lines[0].replace(/^\^SIFS:/, '').trim();
		return "UNKNOWN";
	}

	private async getAvailableBaudRate(): Promise<number[]> {
		const response = await retryAsync(async () => await this.atc.sendCommand("AT+IPR=?", "+IPR"), {
			max: 3,
			until: (response) => !response.success
		});
		if (response.success) {
			if (!response.success) {
				debug(`Can't get available baudrates: ${response.status}`);
				return [];
			}
			const m = response.lines[0].match(/\(([0-9,]+)\)/);
			if (!m) {
				debug(`Invalid baudrates list: ${response.lines[0]}`);
				return [];
			}
			return  m[1].split(/\s*,\s*/).map((v) => parseInt(v));
		}
		debug(`Can't get available baudrates: ${response.status}`);
		return [];
	}

	getAtChannel() {
		return this.atc;
	}

	getPort() {
		return this.port;
	}

	getBaudRate() {
		return this.port.baudRate;
	}

	private async getMaxBaudRate(limitBaudRate: number = 0): Promise<number> {
		if (!this.isConnected)
			return 0;

		if (this.connectionType == "USB" || this.connectionType == "BLUE") {
			// Useless for USB or Bluetooth
			return this.port.baudRate;
		}

		let availableBaudRates = await this.getAvailableBaudRate();
		if (!limitBaudRate && Math.max(...availableBaudRates) < 921600) {
			debug(`SGOLD quirks - limit baudrate to 115200.`);
			limitBaudRate = 115200;
		}

		availableBaudRates = availableBaudRates.filter((v) => !limitBaudRate || v <= limitBaudRate);
		if (!availableBaudRates.length) {
			debug(`No appropriate baudrate found [limitBaudRate=${limitBaudRate}, availableBaudRates=${availableBaudRates}].`);
			return 0;
		}

		return Math.max(...availableBaudRates);
	}

	async setBaudRate(baudRate: number) {
		if (!this.isConnected)
			return false;

		const prevBaudRate = this.port.baudRate;
		if (prevBaudRate == baudRate)
			return true;

		debug(`Switch phone to the new baudRate ${baudRate}`);
		const response = await this.atc.sendCommand(`AT+IPR=${baudRate}`);
		if (!response.success) {
			debug(`Baudrate ${baudRate} rejected by phone.`);
			return false;
		}

		await this.port.update({ baudRate: baudRate });

		debug(`Checking new baudrate....`);
		for (let i = 0; i < 3; i++) {
			if (await this.atc.handshake()) {
				debug(`Baudrate changed!`);
				return true;
			}
		}

		debug(`Phone is not accessible with new baudrate ${baudRate}!`);
		return false;
	}

	async setBestBaudRate(limitBaudRate = 0) {
		const maxBaudRate = await this.getMaxBaudRate(limitBaudRate);
		if (!maxBaudRate)
			return true;
		return await this.setBaudRate(maxBaudRate);
	}

	async ping() {
		return await this.atc.handshake();
	}

	async execute(address: number, regs: number[] = []): Promise<CgsnExecuteResponse> {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };
		const regNames: (keyof CgsnRegisters)[] = [
			"r0", "r1", "r2", "r3", "r4", "r5", "r6", "r7",
			"r8", "r9", "r10", "r11", "r12", "cpsr"
		];
		const cmd = "AT+CGSN@" + [address, ...regs].map((v) => sprintf('%08X', v)).join(',');
		const response = await this.atc.sendCommandBinaryResponse(cmd, 4 * regNames.length + 1, 5000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary![0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary![0].toString(16)}` };
		let result: Partial<CgsnRegisters> = {};
		for (let i = 0; i < regNames.length; i++)
			result[regNames[i]] = response.binary!.readUInt32LE(1 + i * 4);
		return { success: true, regs: result as CgsnRegisters };
	}

	async query(addresses: number[]): Promise<CgsnQueryResponse> {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };
		const cmd = "AT+CGSN%" + addresses.map((v) => sprintf('%08X', v)).join('');
		const response = await this.atc.sendCommandBinaryResponse(cmd, 4 * addresses.length + 1, 400);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary![0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary![0].toString(16)}` };
		const values = [];
		for (let i = 0; i < addresses.length; i++)
			values.push(response.binary!.readUInt32LE(1 + i * 4));
		return { success: true, values };
	}

	async readMemory(address: number, length: number, options: CgsnReadWriteOptions = {}): Promise<CgsnReadResponse> {
		const validOptions = {
			chunkSize: 512,
			progressInterval: 500,
			...options
		};
		let start = Date.now();
		let cursor = 0;
		let buffer = Buffer.alloc(length);
		let lastProgressCalled = 0;
		let canceled = false;
		while (cursor < buffer.length) {
			if (validOptions.signal?.aborted) {
				canceled = true;
				break;
			}

			if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && cursor > 0)) {
				validOptions.onProgress && validOptions.onProgress(cursor, buffer.length, Date.now() - start);
				lastProgressCalled = Date.now();
			}

			const chunkSize = Math.min(buffer.length - cursor, validOptions.chunkSize);
			const response = await retryAsync(async () => await this.readMemoryChunk(address + cursor, chunkSize, buffer, cursor), {
				max: 3,
				until: (response) => !response.success
			});
			if (!response.success)
				return response;
			cursor += chunkSize;
		}

		validOptions.onProgress && validOptions.onProgress(cursor, buffer.length, Date.now() - start);
		return { success: true, buffer, canceled };
	}

	async writeMemory(address: number, buffer: Buffer, options: CgsnReadWriteOptions = {}): Promise<CgsnWriteResponse> {
		const validOptions = {
			chunkSize: 128,
			progressInterval: 500,
			...options
		};
		let start = Date.now();
		let cursor = 0;
		let lastProgressCalled = 0;
		let canceled = false;

		if ((address % 4) != 0)
			throw new Error(`Address (${address.toString(16)}) is not aligned to 4!`);

		if ((buffer.length % 4) != 0)
			throw new Error(`Buffer size (${buffer.length}) is not aligned to 4!`);

		while (cursor < buffer.length) {
			if (validOptions.signal?.aborted) {
				canceled = true;
				break;
			}

			if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && cursor > 0)) {
				validOptions.onProgress && validOptions.onProgress(cursor, buffer.length, Date.now() - start);
				lastProgressCalled = Date.now();
			}

			const chunkSize = Math.min(buffer.length - cursor, validOptions.chunkSize);
			const response = await retryAsync(async () => await this.writeMemoryChunk(address + cursor, chunkSize, buffer, cursor), {
				max: 3,
				until: (response) => !response.success
			});
			if (!response.success)
				return response;
			cursor += chunkSize;
		}
		validOptions.onProgress && validOptions.onProgress(cursor, buffer.length, Date.now() - start);
		return { success: true, written: cursor, canceled };
	}

	async readMemoryChunk(address: number, length: number, buffer: Buffer, bufferOffset: number = 0): Promise<CgsnBaseResponse> {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };
		if (length > 512)
			throw new Error(`Maximum length for one memory reading is 512 bytes.`);
		const cmd = sprintf("AT+CGSN:%08X,%08X", address , length);
		const response = await this.atc.sendCommandBinaryResponse(cmd, length + 1, 1000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary![0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary![0].toString(16)}` };
		buffer.set(response.binary!.subarray(1), bufferOffset);
		return { success: true };
	}

	async writeMemoryChunk(address: number, length: number, buffer: Buffer, bufferOffset: number = 0): Promise<CgsnBaseResponse> {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };
		if (length > 128)
			throw new Error(`Maximum length for one memory writing is 128 bytes.`);
		const hex = buffer.subarray(bufferOffset, bufferOffset + length).toString('hex').toUpperCase();
		const cmd = sprintf("AT+CGSN*%08X%s", address, hex);
		const response = await this.atc.sendCommandBinaryResponse(cmd, 1, 1000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary![0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary![0].toString(16)}` };
		return { success: true };
	}

	async disconnect() {
		if (this.isConnected && this.port.isOpen)
			await this.setBaudRate(115200);
		this.atc.stop();
		this.isConnected = false;
	}
}
