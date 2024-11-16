import createDebug from 'debug';
import { crc16 } from './crc16.js';
import { AtChannel } from './AtChannel.js';
import { sprintf } from 'sprintf-js';
import { AsyncSerialPort } from './AsyncSerialPort.js';

const debug = createDebug('bfc');

export const DEFAULT_CHANNEL_ID = 0x01;

export const BFC_FRAME_FLAGS = {
	ACK:	1 << 4,
	CRC:	1 << 5,
};

export const BFC_FRAME_TYPES = {
	SIGNLE:		0,
	MULTIPLE:	1,
	ACK:		2,
	STATUS:		4,
};

export const BFC_HWI = {
	RFChipSet:			1,
	HwDetection:		2,
	SWPlatform:			3,
	PAType:				4,
	LEDType:			5,
	LayoutType:			6,
	BandType:			7,
	StepUpType:			8,
	BluetoothType:		9,
};

export const BFC_SWI = {
	DB_Name:					1,
	Baseline_Version:			2,
	Baseline_Release:			3,
	Project_Name:				4,
	SW_Builder:					5,
	Link_Time_Stamp:			6,
	Reconfigure_Time_Stamp:		7,
};

// All possible baudrates for BFC
// 115200 - USB
// 230400 - USART SG
// 921600 - USART NSG
const SERIAL_BAUDRATES = [115200, 230400, 921600];

const BFC_MODE = {
	NONE:	0,
	AT:		1,
	BFC:	2,
};

export class BFC {
	mode = BFC_MODE.NONE;
	channels = {};
	authCache = {};
	frameReceivers = {};
	connectionError = null;

	constructor(port = null) {
		if (!(port instanceof AsyncSerialPort))
			throw new Error(`Port is not AsyncSerialPort!`);
		this.port = port;
		this.serialDataCallback = (data) => this._handleSerialData(data);
		this.serialCloseCallback = () => this._handleSerialClose();
		this.buffer = Buffer.alloc(0);
		this.atc = new AtChannel(port);
	}

	_setConnectionError(err) {
		if (err != null)
			debug(`ERROR: ${err}`);
		this.connectionError = err;
	}

	getConnectionError() {
		return this.connectionError;
	}

	_setMode(mode) {
		if (this.mode == mode)
			return;
		this.mode = mode;

		switch (mode) {
			case BFC_MODE.NONE:
				debug(`Mode: NONE`);
				this.port.off('data', this.serialDataCallback);
				this.port.off('close', this.serialCloseCallback);
				this.atc.stop();
				this.buffer = Buffer.alloc(0);
			break;

			case BFC_MODE.AT:
				debug(`Mode: AT`);
				this.port.off('data', this.serialDataCallback);
				this.port.off('close', this.serialCloseCallback);
				this.atc.start();
				this.buffer = Buffer.alloc(0);
			break;

			case BFC_MODE.BFC:
				debug(`Mode: BFC`);
				this.port.on('data', this.serialDataCallback);
				this.port.on('close', this.serialCloseCallback);
				this.atc.stop();
			break;
		}
	}

	async _findOpenedBfc() {
		this._setMode(BFC_MODE.BFC);
		for (let baudRate of SERIAL_BAUDRATES) {
			debug(`Probing BFC at baudrate: ${baudRate}`);
			await this.port.update({ baudRate });
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			if (await this.ping(300)) {
				await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for BFC is ready
				debug(`Phone is already in BFC mode!`);
				return baudRate;
			}
		}
		this._setMode(BFC_MODE.NONE);
		return false;
	}

	async _trySwitchFromAtToBfc() {
		await this.port.update({ baudRate: 115200 });

		debug(`Probing AT handshake...`);
		this._setMode(BFC_MODE.AT);

		let response;
		if (await this.atc.handshake()) {
			// AT^SIFS - current interface USB, WIRE, BLUE, IRDA
			response = await this.atc.sendCommand("AT^SIFS", "^SIFS", 750);
			if (response.success && response.lines.length > 0 && response.lines[0].match(/BLUE/)) {
				this._setMode(BFC_MODE.NONE);
				throw new Error(`Bluetooth is not supported for BFC.`);
			}

			debug(`Phone in AT mode, switching from AT to BFC...`);
			response = await this.atc.sendCommandNumeric("AT^SQWE=1");
			if (response.success) {
				this._setMode(BFC_MODE.BFC);
				await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for BFC is ready
				if (await this.ping()) {
					debug(`Succesfully switched to BFC mode!`);
					return true;
				} else {
					this._setMode(BFC_MODE.NONE);
					throw new Error(`Switching to BFC failed! (ping)`);
				}
			} else {
				this._setMode(BFC_MODE.NONE);
				throw new Error(`Switching to BFC failed! (AT^SQWE=1)`);
			}
		} else {
			debug(`AT handshake failed, maybe phone in BFC mode?`);
			this._setMode(BFC_MODE.AT);
			return false;
		}
	}

	async connect() {
		if (this.mode == BFC_MODE.BFC)
			throw new Error(`BFC already connected.`);

		if (!this.port?.isOpen())
			throw new Error(`Serial port closed.`);

		if (await this._trySwitchFromAtToBfc())
			return true;

		if (await this._findOpenedBfc())
			return true;

		throw new Error(`Phone not found.`);
	}

	async disconnect() {
		if (this.mode != BFC_MODE.BFC)
			return true;
		if (this.mode == BFC_MODE.BFC && this.port?.isOpen()) {
			if (await this.ping()) {
				try {
					await this.sendAT("AT^SQWE = 0\r", 250);
					await this.port.update({ baudRate: 115200 });
					await new Promise((resolve) => setTimeout(resolve, 300));
				} catch (e) {
					debug(`disconnect error: ${e.message}`);
				}
			}
		}
		this._handleSerialClose();
		return true;
	}

	destroy() {
		if (this.mode != BFC_MODE.NONE)
			throw new Error(`Can't destroy when BFC in use!`);

		if (this.atc) {
			this.atc.stop();
			this.atc.destroy();
			this.atc = null;
		}

		this.port = null;
	}

	_handleSerialClose() {
		for (let dst in this.frameReceivers) {
			let receiver = this.frameReceivers;
			this._handleReceiverResponse(receiver.src, dst, new Error(`BFC connection closed.`));
		}
		this._setMode(BFC_MODE.NONE);
	}

	_handleSerialData(data) {
		this.buffer = Buffer.concat([this.buffer, data]);

		while (this.buffer.length >= 6) {
			let pktStart = findPacketStartInBuffer(this.buffer);
			if (pktStart === false) {
				this.buffer = this.buffer.subarray(this.buffer.length - 5); // trim noise
				continue;
			}

			if (pktStart > 0) { // trim noise
				this.buffer = this.buffer.subarray(pktStart);
				pktStart = 0;
			}

			let pktLen = calcTotalPacketSize(this.buffer);
			if (this.buffer.length < pktLen)
				break;

			let pkt = this.buffer.subarray(0, pktLen);
			this.buffer = this.buffer.subarray(pktLen);

			this._handleBfcPacket(pkt);
		}
	}

	async _handleBfcPacket(pkt) {
		let dst = pkt[0];
		let src = pkt[1];
		let payloadLen = pkt.readUInt16BE(2);
		let frameType = pkt[4] & 0x0F;
		let frameFlags = pkt[4] & 0xF0;
		let payload = pkt.slice(6, 6 + payloadLen);
		let crc = (frameFlags & BFC_FRAME_FLAGS.CRC) != 0 ? 1 : 0;
		let ack = (frameFlags & BFC_FRAME_FLAGS.ACK) != 0 ? 1 : 0;
		let receiver = this.frameReceivers[dst];
		let ignored = !receiver || receiver.src != src;

		debug(sprintf(`RX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X] %s%s`, src, dst, crc, ack, frameType, payload.toString('hex'), ignored ? ` (ignored)` : ``));

		if ((frameFlags & BFC_FRAME_FLAGS.CRC) && !checkPacketChecksum(pkt)) {
			this._handleReceiverResponse(src, dst, new Error(`Invalid CRC!`));
			return;
		}

		if ((frameFlags & BFC_FRAME_FLAGS.ACK)) {
			// Auto ACK
			await this.sendAck(src, dst);
		}

		if (receiver && receiver.parser) {
			let frame = { src, dst, data: payload, type: frameType, flags: frameFlags };
			try {
				receiver.parser(frame, (response) => this._handleReceiverResponse(src, dst, response));
			} catch (error) {
				this._handleReceiverResponse(src, dst, error);
			}
		} else {
			this._handleReceiverResponse(src, dst, payload);
		}
	}

	async _createReceiver(src, dst, timeout, parser) {
		while (this.frameReceivers[dst]) {
			await this.frameReceivers[dst].promise;
		}

		let timeoutId = setTimeout(() => this._handleReceiverResponse(src, dst, new Error(`BFC command ${src.toString(16)}:${dst.toString(16)} timeout.`)), timeout);

		let promise = new Promise((resolve, reject) => {
			this.frameReceivers[dst] = { src, dst, resolve, reject,  parser, timeoutId };
		});
		this.frameReceivers[dst].promise = promise;

		return this.frameReceivers[dst];
	}

	_handleReceiverResponse(src, dst, response) {
		let receiver = this.frameReceivers[dst];
		if (!receiver || receiver.src != src)
			return false;

		delete this.frameReceivers[dst];

		clearTimeout(receiver.timeoutId);

		if ((response instanceof Error)) {
			receiver.reject(response);
		} else {
			receiver.resolve(response);
		}

		return true;
	}

	async exec(src, dst, payload, options) {
		if (this.mode != BFC_MODE.BFC)
			throw new Error(`BFC is not connected.`);

		options = {
			type: BFC_FRAME_TYPES.SIGNLE,
			crc: true,
			ack: false,
			auth: true,
			parser: false,
			timeout: 0,
			...options || {}
		};

		options.timeout ||= 5000;

		if (options.auth && !this.authCache[dst])
			this.authCache[dst] = await this.sendAuth(src, dst, options.timeout);

		let { promise } = await this._createReceiver(dst, src, options.timeout, options.parser);

		let frameFlags = 0;
		if (options.crc)
			frameFlags |= BFC_FRAME_FLAGS.CRC;
		if (options.ack)
			frameFlags |= BFC_FRAME_FLAGS.ACK;

		try {
			await this.sendFrame(src, dst, options.type, frameFlags, payload);
		} catch (err) {
			this._handleReceiverResponse(dst, src, err);
		}

		return await promise;
	}

	async sendAuth(src, dst, timeout = 0) {
		let response = await this.exec(src, dst, [0x80, 0x11], { type: BFC_FRAME_TYPES.STATUS, crc: false, auth: false, timeout });
		return response[0] == 0x43 && response[1] == 0x11;
	}

	async sendAck(src, dst) {
		await this.sendFrame(src, dst, BFC_FRAME_TYPES.ACK, BFC_FRAME_FLAGS.CRC, [0x15, 1]);
	}

	async sendFrame(src, dst, frameType, frameFlags, payload) {
		if (this.mode != BFC_MODE.BFC)
			throw new Error(`BFC is not connected.`);

		if (!Buffer.isBuffer(payload))
			payload = Buffer.from(payload);

		let pktLen = ((frameFlags & BFC_FRAME_FLAGS.CRC) ? 8 : 6) + payload.length;
		let pkt = Buffer.alloc(pktLen);

		let offset = 0;
		offset = pkt.writeUInt8(dst, offset);
		offset = pkt.writeUInt8(src, offset);
		offset = pkt.writeUInt16BE(payload.length, offset);
		offset = pkt.writeUInt8(frameType | frameFlags, offset);
		offset = pkt.writeUInt8(pkt[0] ^ pkt[1] ^ pkt[2] ^ pkt[3] ^ pkt[4], offset);
		offset += payload.copy(pkt, offset);

		if ((frameFlags & BFC_FRAME_FLAGS.CRC)) {
			let crc = crc16(pkt, 0, payload.length + 6);
			offset = pkt.writeUInt16BE(crc, offset);
		}

		let crc = (frameFlags & BFC_FRAME_FLAGS.CRC) != 0 ? 1 : 0;
		let ack = (frameFlags & BFC_FRAME_FLAGS.ACK) != 0 ? 1 : 0;
		debug(sprintf(`TX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X] %s`, +src, +dst, crc, ack, frameType, payload.toString('hex')));

		await this.port.write(pkt);
	}

	// ----------------------------------------------------------------------------------
	// BFC API
	// ----------------------------------------------------------------------------------

	async ping(timeout = 10000) {
		try {
			return await this.sendAuth(DEFAULT_CHANNEL_ID, 0x02, timeout);
		} catch (e) {
			return false;
		}
	}

	async setBestBaudrate(limitBaudrate = 0) {
		let prevBaudRate = this.port.getBaudrate();

		if (prevBaudRate > 115200)
			return true;

		let foundBestBaudrate;
		for (let baudrate of [...SERIAL_BAUDRATES].reverse()) {
			if (limitBaudrate && baudrate > limitBaudrate)
				continue;
			debug(`Probing new baudrate: ${baudrate}`);
			if (await this.setPhoneBaudrate(baudrate)) {
				debug(`Approved by phone.`);
				foundBestBaudrate = baudrate;
				break;
			}
			debug(`Rejected by phone.`);
		}

		if (foundBestBaudrate) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			await this.port.update({ baudRate: foundBestBaudrate });

			for (let i = 0; i < 3; i++) {
				debug(`ping...`);
				if (await this.ping(1000)) {
					debug(`Success, new baudrate: ${foundBestBaudrate}`);
					return true;
				}
			}

			await this.port.update({ baudRate: prevBaudRate });
			await new Promise((resolve) => setTimeout(resolve, 100));

			debug(`Failed to set new baudrate.`);
			return false;
		} else {
			debug(`No suitable baudrate found.`);
			return false;
		}
	}

	async setPhoneBaudrate(baudrate) {
		let payload = Buffer.concat([ Buffer.from([0x02]), Buffer.from(baudrate.toString()) ]);
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x01, payload);
		if (response[0] == 0x02 && response[1] == 0xEE)
			return false;
		return true;
	}

	async getBaseband() {
		const KNOWN_CPUS = {
			0x0101:	["pmb2850", "EGoldV1.2"],
			0x0301:	["pmb2850", "EGold+V1.2"],
			0x0300:	["pmb2850", "EGold+V1.3_M37"],
			0x0200:	["pmb2850", "EGold+V1.3_b"],
			0x0311:	["pmb6850", "EGold+V2.0"],
			0x0312:	["pmb6850", "EGold+V2.1"],
			0x0411:	["pmb7850", "EGold+V3.1"],
			0x0412:	["pmb7850", "EGold+V3.1_R12"],
			0x0414:	["pmb7850", "EGold+V3.1_R18"],
			0x0415:	["pmb7850", "EGold+V3.1_R19"],
			0x0413:	["pmb7850", "EGold+V3.1_R17"],
			0x1A00:	["pmb8875", "SGold Lite V1.0"],
			0x1A01:	["pmb8875", "SGold Lite V1.1"],
			0x1A03:	["pmb8875", "SGold Lite V1.1a"],
			0x1A05:	["pmb8875", "SGold Lite V1.1b"],
			0x1B00:	["pmb8876", "SGold2 V1.0"],
			0x1B10:	["pmb8876", "SGold2 V2.1"],
			0x1B11:	["pmb8876", "SGold2 V2.1b"],
		};
		const UNKNOWN_CPUS = {
			0x1A00:	["pmb8875", "SGold Lite Vx.x"],
			0x1B00:	["pmb8876", "SGold2 Vx.x"],
		};
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x03]);
		let cpuId = Number(BigInt(response[2]) | (BigInt(response[1]) << 8n) | (BigInt(response[4]) << 16n) | (BigInt(response[3]) << 24n));
		return KNOWN_CPUS[cpuId] || UNKNOWN_CPUS[cpuId & 0xFF00];
	}

	async getHwInfo(hwi) {
		let hwi2key = {
			[BFC_HWI.RFChipSet]:		0,
			[BFC_HWI.HwDetection]:		4,
			[BFC_HWI.SWPlatform]:		8,
			[BFC_HWI.PAType]:			1,
			[BFC_HWI.LEDType]:			2,
			[BFC_HWI.LayoutType]:		3,
			[BFC_HWI.BandType]:			5,
			[BFC_HWI.StepUpType]:		6,
			[BFC_HWI.BluetoothType]:	7,
		};
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x02, hwi2key[hwi]]);
		return response[1];
	}

	async getSwInfo(swi) {
		let swi2key = {
			[BFC_SWI.DB_Name]:					0,
			[BFC_SWI.Baseline_Version]:			1,
			[BFC_SWI.Baseline_Release]:			2,
			[BFC_SWI.Project_Name]:				3,
			[BFC_SWI.SW_Builder]:				4,
			[BFC_SWI.Link_Time_Stamp]:			5,
			[BFC_SWI.Reconfigure_Time_Stamp]:	6,
		};
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x06, swi2key[swi]]);
		return decodeCString(response.slice(1));
	}

	async getIMEI() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x05]);
		return decodeCString(response.slice(1));
	}

	async getSwVersion() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0B]);
		return decodeCString(response.slice(1));
	}

	async getLanguageGroup() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0E]);
		return decodeCString(response.slice(1));
	}

	async getTegicGroup() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0F]);
		return decodeCString(response.slice(1));
	}

	async getVendorName() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0C]);
		return decodeCString(response.slice(1));
	}

	async getProductName() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0D]);
		return decodeCString(response.slice(1));
	}

	async getDisplayCount() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x06]);
		return response[1];
	}

	async getDisplayInfo(displayId) {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x07, displayId]);
		return {
			width:		response.readUInt16LE(1),
			height:		response.readUInt16LE(3),
			clientId:	response.readUInt8(5),
		};
	}

	async getDisplayBufferInfo(clientId) {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x09, clientId]);
		return {
			clientId:	response.readUInt8(1),
			width:		response.readUInt16LE(2),
			height:		response.readUInt16LE(4),
			x:			response.readUInt16LE(6),
			y:			response.readUInt16LE(8),
			addr:		response.readUInt32LE(10),
			type:		response.readUInt8(14),
		};
	}

	async getDisplayBuffer(displayId, options = {}) {
		options = {
			onProgress: null,
			...options
		};

		let displayInfo = await this.getDisplayInfo(displayId);
		let displayBufferInfo = await this.getDisplayBufferInfo(displayInfo.clientId);

		let modes = {
			3:		'rgba4444',
			4:		'rgb565',
			5:		'rgb888',
			9:		'rgb8888',
		};

		let mode2bpp = {
			'rgb332':	1,
			'rgba4444':	2,
			'rgb565be':	2,
			'rgb565':	2,
			'rgb888':	3,
			'rgb8888':	4,
		};

		let rgbMode = modes[displayBufferInfo.type];
		if (!rgbMode)
			throw new Error(`Unknown display buffer type=${displayBufferInfo.type}`);

		let buffer = await this.readMemory(displayBufferInfo.addr, mode2bpp[rgbMode] * displayBufferInfo.width * displayBufferInfo.height, {
			onProgress: options.onProgress
		});
		return { mode: rgbMode, width: displayBufferInfo.width, height: displayBufferInfo.height, data: buffer };
	}

	async sendAT(cmd, timeout) {
		let tmp_buffer = "";
		let parser = (frame, resolve) => {
			tmp_buffer += frame.data.toString();
			if (tmp_buffer.match(/\r\n(OK|ERROR|\+CMS ERROR|\+CME ERROR)[^\r\n]*\r\n$/s))
				resolve(tmp_buffer);
		};
		return await this.exec(DEFAULT_CHANNEL_ID, 0x17, cmd, { parser, timeout });
	}

	async readMemory(address, length, options = {}) {
		options = {
			onProgress: null,
			...options
		};
		let start = Date.now();
		let cursor = 0;
		let buffer = Buffer.alloc(length);
		while (cursor < buffer.length) {
			options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
			let chunkSize = Math.min(buffer.length - cursor, 63 * 256);

			for (let i = 0; i < 3; i++) {
				try {
					await this.readMemoryChunk(address + cursor, chunkSize, buffer, cursor);
					break;
				} catch (error) {
					if (i == 2)
						throw error;
				}
			}

			cursor += chunkSize;
		}
		options.onProgress && options.onProgress(buffer.length, buffer.length, Date.now() - start);
		return buffer;
	}

	async readMemoryChunk(address, length, buffer, bufferOffset = 0) {
		let cmd = Buffer.alloc(9);
		cmd.writeUInt8(0x01, 0);
		cmd.writeUInt32LE(address, 1);
		cmd.writeUInt32LE(length, 5);

		if (bufferOffset + length > buffer.length)
			throw new Error(`Target buffer is too small.`);

		if (length > 32 * 1024)
			throw new Error(`Maximum length for memory reading is 32k.`);

		let frameId = 0;
		let offset = 0;

		let parser = (frame, resolve) => {
			if (frameId == 0) {
				let ack = frame.data.readUInt16LE(0);
				if (ack != 1)
					resolve(new Error(`readMemory(): invalid ACK (0x${ack.toString(16)})`));
			} else if (frame.type == BFC_FRAME_TYPES.SIGNLE) {
				buffer.set(frame.data, bufferOffset + offset);
				offset += frame.data.length;
			} else if (frame.type == BFC_FRAME_TYPES.MULTIPLE) {
				buffer.set(frame.data.slice(1), bufferOffset + offset);
				offset += frame.data.length - 1;
			} else {
				resolve(new Error(`Unknown frame received: ${JSON.stringify(frame)}`));
			}

			if (offset == length)
				resolve(true);

			frameId++;
		};
		return await this.exec(DEFAULT_CHANNEL_ID, 0x06, cmd, { parser });
	}
}

function findPacketStartInBuffer(buffer) {
	let i = 0;
	while (buffer.length - i >= 6) {
		let chk = buffer[i + 0] ^ buffer[i + 1] ^ buffer[i + 2] ^ buffer[i + 3] ^ buffer[i + 4];
		if (chk == buffer[i + 5])
			return i;
		i++;
	}
	return false;
}

function checkPacketChecksum(pkt) {
	let payloadLen = pkt.readUInt16BE(2);
	let pktCRC = pkt.readUInt16BE(6 + payloadLen);
	let realCRC = crc16(pkt, 0, payloadLen + 6);
	return pktCRC == realCRC;
}

function calcTotalPacketSize(pkt) {
	let len = pkt.readUInt16BE(2) + 6;
	if ((pkt[4] & BFC_FRAME_FLAGS.CRC))
		len += 2;
	return len;
}

function decodeCString(buffer) {
	let len = 0;
	for (let i = 1; i < buffer.length; i++) {
		if (buffer[i] == 0)
			break;
		len++;
	}
	return buffer.slice(0, len + 1).toString();
}
