import createDebug from 'debug';
import { crc16 } from './crc16.js';
import { AtChannel } from './AtChannel.js';
import { sprintf } from 'sprintf-js';

let debug = createDebug('bfc');

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

// All possible baudrates for BFC
// 115200 - USB
// 230400 - USART SG
// 921600 - USART NSG
const SERIAL_BAUDRATES = [115200, 230400, 921600];

export class BFC {
	paused = true;
	channels = {};
	authCache = {};
	frameReceivers = {};

	constructor(port) {
		this.port = port;
		this.serialDataCallback = (data) => this._handleSerialData(data);
		this.buffer = Buffer.alloc(0);
		this.atc = new AtChannel(port);
	}

	async _findOpenedBfcSpeed() {
		this._resume();
		for (let baudRate of SERIAL_BAUDRATES) {
			debug(`Probing BFC at baudrate: ${baudRate}`);
			await serialPortAsyncUpdate(this.port, { baudRate });
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BFC_FRAME_TYPES.STATUS, 0, [0x80, 0x11]);
			if (await this.ping(300)) {
				await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for BFC is ready
				debug(`Phone is already in BFC mode!`);
				return baudRate;
			}
		}
		return false;
	}

	async _trySwitchFromAtToBfc() {
		let response;

		this._pause();
		debug(`Probing AT handshake...`);
		if (await this.atc.handshake()) {
			// AT^SIFS - current interface USB, WIRE, BLUE, IRDA
			response = await this.atc.sendCommand("AT^SIFS", "^SIFS", 3000);
			if (response.success && response.lines.length > 0 && response.lines[0].match(/BLUE/)) {
				debug(`Bluetooth is not supported for BFC.`);
				this._pause();
				return [false, false];
			}

			debug(`Phone in AT mode, switching from AT to BFC...`);
			response = await this.atc.sendCommandNumeric("AT^SQWE=1");
			if (response.success) {
				this._resume();
				await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for BFC is ready
				if (await this.ping()) {
					debug(`Succesfully switched to BFC mode!`);
					return [true, true];
				} else {
					debug(`Switching to BFC failed! (ping)`);
				}
			} else {
				debug(`Switching to BFC failed! (AT)`);
			}
		} else {
			debug(`AT handshake failed, maybe phone in BFC mode.`);
		}
		this._pause();
		return [false, true];
	}

	async connect() {
		await serialPortAsyncUpdate(this.port, { baudRate: 115200 });

		let [success, allowNextTry] = await this._trySwitchFromAtToBfc();
		if (success)
			return true;

		if (allowNextTry) {
			if (await this._findOpenedBfcSpeed())
				return true;
		}

		debug(`Phone is not connected.`);

		return false;
	}

	async disconnect() {
		if (!this.paused) {
			if (await this.ping()) {
				await this.sendAT("AT^SQWE=2\r", 250);
				await serialPortAsyncUpdate(this.port, { baudRate: 115200 });
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			this._pause();
			return await this.atc.handshake();
		}
		return true;
	}

	_resume() {
		this.paused = false;
		this.port.on('data', this.serialDataCallback);
		this.atc.stop();
	}

	_pause() {
		this.paused = true;
		this.port.off('data', this.serialDataCallback);
		this.buffer = Buffer.alloc(0);
		this.atc.start();
	}

	_handleSerialData(data) {
		this.buffer = Buffer.concat([this.buffer, data]);

		while (this.buffer.length >= 6) {
			let pktStart = findPacketStartInBuffer(this.buffer);
			if (pktStart === false) {
				this.buffer = this.buffer.slice(this.buffer.length - 5); // trim noise
				continue;
			}

			if (pktStart > 0) { // trim noise
				this.buffer = this.buffer.slice(pktStart);
				pktStart = 0;
			}

			let pktLen = calcTotalPacketSize(this.buffer);
			if (this.buffer.length < pktLen)
				break;

			let pkt = this.buffer.slice(0, pktLen);
			this.buffer = this.buffer.slice(pktLen);

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
			receiver.parser(frame, (response) => this._handleReceiverResponse(src, dst, response));
		} else {
			this._handleReceiverResponse(src, dst, payload);
		}
	}

	async _createReceiver(src, dst, timeout, parser) {
		while (this.frameReceivers[dst]) {
			await this.frameReceivers[dst].promise;
		}

		let timeoutId = setTimeout(() => this._handleReceiverResponse(src, dst, new Error(`BFC command timeout.`)), timeout);

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
		options = {
			type: BFC_FRAME_TYPES.SIGNLE,
			crc: true,
			ack: false,
			auth: true,
			parser: false,
			timeout: 0,
			...options || {}
		};

		options.timeout ||= 60000;

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

		await serialPortAsyncWrite(this.port, pkt);
	}

	/*
	 * BFC API
	 * */
	async setBestBaudrate() {
		let prevBaudRate = this.port.baudRate;

		if (prevBaudRate > 115200)
			return true;

		let foundBestBaudrate;
		for (let baudrate of SERIAL_BAUDRATES.reverse()) {
			debug(`Probing new baudrate: ${baudrate}`);
			if (await this.setPhoneBaudrate(baudrate)) {
				foundBestBaudrate = baudrate;
				break;
			}
		}

		if (foundBestBaudrate) {
			await new Promise((resolve) => setTimeout(resolve, 300));
			await serialPortAsyncUpdate(this.port, { baudRate: foundBestBaudrate });

			for (let i = 0; i < 3; i++) {
				debug(`ping...`);
				if (await this.ping(1000)) {
					debug(`Success, new baudrate: ${foundBestBaudrate}`);
					return true;
				}
			}

			await serialPortAsyncUpdate(this.port, { baudRate: prevBaudRate });
			await new Promise((resolve) => setTimeout(resolve, 100));

			debug(`Failed to set new baudrate.`);
			throw new Error(`BFC failed to set baudrate.`);
		} else {
			debug(`Failed to set new baudrate.`);
			throw new Error(`BFC baudrate ${baudrate} rejected by phone.`);
		}

		return true;
	}

	async ping(timeout = 10000) {
		try {
			return await this.sendAuth(DEFAULT_CHANNEL_ID, 0x02, timeout);
		} catch (e) { }
		return false;
	}

	async setPhoneBaudrate(baudrate) {
		let payload = Buffer.concat([ Buffer.from([0x02]), Buffer.from(baudrate.toString()) ]);
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x01, payload);
		if (response[0] == 0x02 && response[1] == 0xEE)
			return false;
		return true;
	}

	async getDisplayCount() {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x06]);
		return response[1];
	}

	async getDisplayInfo(displayId) {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x07, displayId]);
		return {
			subcmd:		response.readUInt8(0),
			width:		response.readUInt16LE(1),
			height:		response.readUInt16LE(3),
			clientId:	response.readUInt8(5),
		};
	}

	async getDisplayBufferInfo(clientId) {
		let response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x09, clientId]);
		return {
			subcmd:		response.readUInt8(0),
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
			4:		'rgb565',
			5:		'rgb888',
			9:		'rgb8888',
		};

		let mode2bpp = {
			'rgb565':	2,
			'rgb888':	3,
			'rgb8888':	4,
		};

		let rgbMode = modes[displayBufferInfo.type];
		if (!rgbMode)
			throw new Error(`Unknown display buffer type=${displayBufferInfo.type}`);

		let start = Date.now();
		let cursor = 0;
		let buffer = Buffer.alloc(mode2bpp[rgbMode] * displayInfo.width * displayInfo.height);
		while (cursor < buffer.length) {
			options.onProgress && options.onProgress(cursor, buffer.length, Date.now() - start);
			let chunkSize = Math.min(buffer.length - cursor, 63 * 256);
			await this.readMemory(displayBufferInfo.addr + cursor, chunkSize, buffer, cursor);
			cursor += chunkSize;
		}
		options.onProgress && options.onProgress(buffer.length, buffer.length, Date.now() - start);

		return { mode: rgbMode, width: displayInfo.width, height: displayInfo.height, data: buffer };
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

	async readMemory(address, length, buffer, bufferOffset = 0) {
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
				let ack = frame.data.readUInt16BE(0);
				if (ack != 0x100)
					resolve(new Error(`readMemory(): invalid ACK (0x${ack.toString(16)})`));
			} else if (frame.type == BFC_FRAME_TYPES.SIGNLE) {
				buffer.set(frame.data, bufferOffset + offset);
				offset += frame.data.length;
			} else if (frame.type == BFC_FRAME_TYPES.MULTIPLE) {
				buffer.set(frame.data.slice(1), bufferOffset + offset);
				offset += frame.data.length - 1;
			} else {
				throw new Error(`Unknown frame received: ${JSON.stringify(frame)}`);
			}

			if (offset == length)
				resolve(true);

			frameId++;
		};
		return await this.exec(DEFAULT_CHANNEL_ID, 0x06, cmd, { parser });
	}
}

async function serialPortAsyncWrite(port, data) {
	return new Promise((resolve, reject) => {
		port.write(data);
		port.drain((err) => {
			if (err) {
				reject(err);
			} else {
				resolve(true);
			}
		});
	});
}

async function serialPortAsyncUpdate(port, settings) {
	return new Promise((resolve, reject) => {
		port.update(settings, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(true);
			}
		});
	});
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
