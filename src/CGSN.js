import createDebug from 'debug';
import { AtChannel } from "./AtChannel.js";
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { sprintf } from 'sprintf-js';

const debug = createDebug('cgsn');

const SERIAL_BAUDRATES = [115200, 460800, 921600];

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

export class CGSN {
	port;
	atc;
	serialMode;
	connectionType;
	isConnected = false;

	constructor(port = null) {
		if (!(port instanceof AsyncSerialPort))
			throw new Error(`Port is not AsyncSerialPort!`);
		this.port = port;
		this.atc = new AtChannel(port);
	}

	async connect(testBaudrates = null) {
		if (this.isConnected)
			await this.disconnect();

		this.atc.start();
		testBaudrates ||= SERIAL_BAUDRATES;
		for (let baudrate of testBaudrates) {
			await this.port.update({ baudRate: baudrate });
			if (await this._tryHandshake(3)) {
				this.isConnected = true;
				if (!await this._checkCgsnPatch()) {
					this.isConnected = false;
					debug(`CGSN patch not found!`);
					return false;
				}

				this.connectionType = await this._getCurrentConnectionType();
				debug(`connectionType=${this.connectionType}`);

				if (this.connectionType == 'BLUE') {
					debug(`Switching to GIPSY`);
					await this.atc.sendCommand("AT^SQWE = 2"); // GIPSY
				} else {
					debug(`Switching to RCCP`);
					await this.atc.sendCommand("AT^SQWE = 0"); // RCCP
				}

				for (let i = 0; i < 3; i++) {
					if (this.atc.handshake()) {
						this.isConnected = true;
						return true;
					}
				}

				debug(`Phone is lost after mode swtiching...`);

				this.isConnected = false;
				return false;
			}
		}
		return false;
	}

	async _checkCgsnPatch() {
		let response = await this.readMemory(0xA000003C, 4);
		if (response.success && response.buffer.equals(Buffer.from("CJKT")))
			return true;
		return false;
	}

	async _tryHandshake() {
		debug(`Probing AT handshake at ${this.port.getBaudrate()}...`);
		if (await this.atc.handshake()) {
			debug("Phone is found!");
			return true;
		} else {
			debug(`Phone is not found.`);
			return false;
		}
	}

	async _getCurrentSerialMode() {
		let response;
		for (let i = 0; i < 3; i++) {
			// AT^SQWE - current interface 2 - GIPSY, 0 - RCCP
			response = await this.atc.sendCommand("AT^SQWE?", "^SQWE", 750);
			if (response.success)
				break;
		}
		if (!response.success)
			return "UNKNOWN";
		return response.lines[0].replace(/^\^SQWE:/, '').trim();
	}

	async _getCurrentConnectionType() {
		let response;
		for (let i = 0; i < 3; i++) {
			// AT^SIFS - current interface USB, WIRE, BLUE, IRDA
			response = await this.atc.sendCommand("AT^SIFS", "^SIFS", 750);
			if (response.success)
				break;
		}
		if (!response.success)
			return "UNKNOWN";
		return response.lines[0].replace(/^\^SIFS:/, '').trim();
	}

	getAtChannel() {
		return this.atc;
	}

	getPort() {
		return this.port;
	}

	getBaudrate() {
		return this.port.getBaudrate();
	}

	async getMaxBaudrate(limitBaudrate = 0) {
		if (!this.isConnected)
			return false;

		if (this.connectionType == "USB" || this.connectionType == "BLUE") {
			// Useless for USB or Bluetooth
			return this.port.getBaudrate();
		}

		let response;
		for (let i = 0; i < 3; i++) {
			response = await this.atc.sendCommand("AT+IPR=?", "+IPR");
			if (response.success)
				break;
		}

		let m;
		if (!response.success) {
			debug(`Can't get available baudrates: ${response.status}`);
			return false;
		}

		if (!(m = response.lines[0].match(/\(([0-9,]+)\)/))) {
			debug(`Invalid baudrates list: ${response.lines[0]}`);
			return false;
		}

		let availableBaudrates = m[1].split(/\s*,\s*/).map((v) => parseInt(v));
		if (!limitBaudrate && Math.max(...availableBaudrates) < 921600) {
			debug(`SGOLD quirks - limit baudrate to 115200.`);
			limitBaudrate = 115200;
		}

		availableBaudrates = availableBaudrates.filter((v) => !limitBaudrate || v <= limitBaudrate);
		if (!availableBaudrates.length) {
			debug(`No appropriate baudrate found [limitBaudrate=${limitBaudrate}, availableBaudrates=${availableBaudrates}].`);
			return false;
		}

		return Math.max(...availableBaudrates);
	}

	async setBaudrate(baudrate) {
		if (!this.isConnected)
			return false;

		let prevBaudRate = this.port.getBaudrate();
		if (prevBaudRate == baudrate)
			return true;

		debug(`Switch phone to the new baudrate ${baudrate}`);
		let response = await this.atc.sendCommand(`AT+IPR=${baudrate}`);
		if (!response.success) {
			debug(`Baudrate ${baudrate} rejected by phone.`);
			return false;
		}

		await this.port.update({ baudRate: baudrate });

		debug(`Checking new baudrate....`);
		for (let i = 0; i < 3; i++) {
			if (await this.atc.handshake()) {
				debug(`Baudrate changed!`);
				return true;
			}
		}

		debug(`Phone is not accessible with new baudrate ${baudrate}!`);
		return false;
	}

	async setBestBaudrate(limitBaudrate = 0) {
		let maxBaudrate = await this.getMaxBaudrate(limitBaudrate);
		if (!maxBaudrate)
			return true;
		return await this.setBaudrate(maxBaudrate);
	}

	async ping() {
		return await this.atc.handshake();
	}

	async execute(address, regs = []) {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };

		let regNames = ['r0', 'r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'r11', 'r12', 'cpsr'];
		let cmd = "AT+CGSN@" + [address, ...regs].map((v) => sprintf('%08X', v)).join(',');
		let response = await this.atc.sendCommandBinaryResponse(cmd, 4 * regNames.length + 1, 5000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary[0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary[0].toString(16)}` };
		let result = {};
		for (let i = 0; i < regNames.length; i++)
			result[regNames[i]] = response.binary.readUInt32LE(1 + i * 4);
		return { success: true, ...result };
	}

	async query(addresses) {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };

		let cmd = "AT+CGSN%" + addresses.map((v) => sprintf('%08X', v)).join('');
		let response = await this.atc.sendCommandBinaryResponse(cmd, 4 * addresses.length + 1, 400);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary[0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary[0].toString(16)}` };
		let values = [];
		for (let i = 0; i < addresses.length; i++)
			values[i] = response.binary.readUInt32LE(1 + i * 4);
		return { success: true, values };
	}

	async readMemory(address, length, options = {}) {
		options = {
			onProgress: null,
			chunkSize: 512,
			progressInterval: 500,
			signal: false,
			...options
		};
		let start = Date.now();
		let cursor = 0;
		let buffer = Buffer.alloc(length);
		let lastProgressCalled = 0;
		let canceled = false;
		while (cursor < buffer.length) {
			if (options.signal?.aborted) {
				canceled = true;
				break;
			}

			if (Date.now() - lastProgressCalled > options.progressInterval && cursor > 0) {
				options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
				lastProgressCalled = Date.now();
			}

			let chunkSize = Math.min(buffer.length - cursor, options.chunkSize);
			let response;
			for (let i = 0; i < 3; i++) {
				response = await this.readMemoryChunk(address + cursor, chunkSize, buffer, cursor);
				if (response.success)
					break;
			}

			if (!response.success)
				return response;

			cursor += chunkSize;
		}

		options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
		return { success: true, buffer, canceled, readed: cursor };
	}

	async writeMemory(address, buffer, options = {}) {
		options = {
			onProgress: null,
			chunkSize: 128,
			progressInterval: 500,
			signal: false,
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
			if (options.signal?.aborted) {
				canceled = true;
				break;
			}

			if (Date.now() - lastProgressCalled > options.progressInterval && cursor > 0) {
				options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
				lastProgressCalled = Date.now();
			}

			let chunkSize = Math.min(buffer.length - cursor, options.chunkSize);
			let response;
			for (let i = 0; i < 3; i++) {
				response = await this.writeMemoryChunk(address + cursor, chunkSize, buffer, cursor);;
				if (response.success)
					break;
			}

			if (!response.success)
				return response;

			cursor += chunkSize;
		}
		options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
		return { success: true, written: cursor, canceled };
	}

	async readMemoryChunk(address, length, buffer, bufferOffset = 0) {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };

		if (length > 512)
			throw new Error(`Maximum length for one memory reading is 512 bytes.`);
		let cmd = sprintf("AT+CGSN:%08X,%08X", address , length);
		let response = await this.atc.sendCommandBinaryResponse(cmd, length + 1, 1000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary[0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary[0].toString(16)}` };
		buffer.set(response.binary.slice(1), bufferOffset);
		return { success: true };
	}

	async writeMemoryChunk(address, length, buffer, bufferOffset = 0) {
		if (!this.isConnected)
			return { success: false, error: 'Not connected!' };

		if (length > 128)
			throw new Error(`Maximum length for one memory writing is 128 bytes.`);
		let hex = buffer.subarray(bufferOffset, bufferOffset + length).toString('hex').toUpperCase();
		let cmd = sprintf("AT+CGSN*%08X%s", address, hex);
		let response = await this.atc.sendCommandBinaryResponse(cmd, 1, 1000);
		if (!response.success)
			return { success: false, error: `AT command failed: ${cmd}` };
		if (response.binary[0] != 0xA1)
			return { success: false, error: `Invalid ACK: 0x${response.binary[0].toString(16)}` };
		return { success: true };
	}

	async disconnect() {
		if (this.isConnected && this.port?.isOpen())
			await this.setBaudrate(115200);
		this.atc.stop();
		this.isConnected = false;
	}

	destroy() {
		if (this.atc) {
			this.atc.stop();
			this.atc = null;
		}
		this.port = null;
	}
}
