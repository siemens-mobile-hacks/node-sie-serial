import { crc16 } from './crc16.js';
import { AtChannel } from './AtChannel.js';
import { BfcChannel } from './BfcChannel.js';
import { sprintf } from 'sprintf-js';

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

const SERIAL_BAUDRATES = [921600, 460800, 115200];

export class BFC {
	verbose = false;
	paused = true;
	channels = {};
	authCache = {};
	frameReceivers = {};
	
	constructor(port) {
		this.port = port;
		this.serialDataCallback = (data) => this._handleSerialData(data);
		this.buffer = Buffer.alloc(0);
		this.atc = new AtChannel(port);
		this.channel = this.openChannel(); // system channel
	}
	
	setVerbose(flag) {
		this.verbose = flag;
		this.atc.setVerbose(flag);
	}
	
	async connect(baudratesList = false) {
		let response;
		
		baudratesList ||= SERIAL_BAUDRATES;
		
		for (let baudrate of baudratesList.reverse()) {
			this.verbose && console.log(`[BFC] Baudrate: ${baudrate}.`);
			await serialPortAsyncUpdate(this.port, { baudRate: baudrate });
			
			// Check if we already in BFC
			this._resume();
			if (!await this.channel.ping(300)) {
				// Ensure if AT mode works
				this._pause();
				if (await this.atc.handshake()) {
					this.verbose && console.log(`[BFC] Switching from AT to BFC...`);
					
					// Enter BFC mode
					response = await this.atc.sendCommandNumeric("AT^SQWE=1");
					if (response.success) {
						this._resume();
						
						// Wait for BFC is ready
						await new Promise((resolve) => setTimeout(resolve, 300));
						
						if (await this.channel.ping()) {
							// Okay, we in BFC
							this.verbose && console.log(`[BFC] Switched to BFC mode!`);
							return true;
						} else {
							this.verbose && console.log(`[BFC] Switching to BFC failed! (ping)`);
						}
					} else {
						this.verbose && console.log(`[BFC] Switching to BFC failed! (AT)`);
					}
				} else {
					this.verbose && console.log(`[BFC] AT handshake failed, phone is not connected?`);
				}
			} else {
				this.verbose && console.log(`[BFC] Already in BFC mode!`);
				return true;
			}
			
			this._pause();
		}
		
		return false;
	}
	
	async disconnect() {
		if (!this.paused) {
			if (await this.channel.ping()) {
				await this.channel.sendAT("AT^SQWE=2\r");
				await serialPortAsyncUpdate(this.port, { baudRate: 115200 });
				await new Promise((resolve) => setTimeout(resolve, 300));
			}
			this._pause();
			return await this.atc.handshake(3);
		}
		return true;
	}
	
	openChannel(CustomBfcChannel = false) {
		let channelId = -1;
		for (let i = 1; i < 0xFF; i++) {
			if (!this.channels[i]) {
				channelId = i;
				break;
			}
		}
		
		if (channelId < 0)
			throw new Error(`No free channels.`);
		
		if (CustomBfcChannel) {
			this.channels[channelId] = new CustomBfcChannel(this, channelId);
		} else {
			this.channels[channelId] = new BfcChannel(this, channelId);
		}
		
		return this.channels[channelId];
	}
	
	closeChannel(channel) {
		delete this.channels[channel.id];
	}
	
	async setSpeed(baudrate) {
		let prevBaudRate = this.port.baudRate;
		
		if (await this.channel.setPhoneBaudrate(baudrate)) {
			await new Promise((resolve) => setTimeout(resolve, 100));
			await serialPortAsyncUpdate(this.port, { baudRate: baudrate });
			
			for (let i = 0; i < 10; i++) {
				if (await this.channel.ping())
					return true;
			}
			
			await serialPortAsyncUpdate(this.port, { baudRate: prevBaudRate });
			await new Promise((resolve) => setTimeout(resolve, 100));
			
			throw new Error(`BFC failed to set baudrate.`);
		} else {
			throw new Error(`BFC baudrate ${baudrate} rejected by phone.`);
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
			if (pktStart === false)
				continue;
			
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
		
		if (this.verbose) {
			let crc = (frameFlags & BFC_FRAME_FLAGS.CRC) != 0 ? 1 : 0;
			let ack = (frameFlags & BFC_FRAME_FLAGS.ACK) != 0 ? 1 : 0;
			console.log(`[BFC]`, sprintf(`RX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X]`, src, dst, crc, ack, frameType), payload.toString('hex'));
		}
		
		if ((frameFlags & BFC_FRAME_FLAGS.CRC) && !checkPacketChecksum(pkt)) {
			this._handleReceiverResponse(src, dst, new Error(`Invalid CRC!`));
			return;
		}
		
		if ((frameFlags & BFC_FRAME_FLAGS.ACK)) {
			// Auto ACK
			await this.sendAck(src, dst);
		}
		
		let receiver = this.frameReceivers[dst];
		if (receiver && receiver.parser) {
			let frame = { src, dst, data: payload, type: frameType, flags: frameFlags };
			receiver.parser(frame, (response) => this._handleReceiverResponse(src, dst, response));
		} else {
			this._handleReceiverResponse(src, dst, payload);
		}
	}
	
	async _createReceiver(src, dst, timeout, parser) {
		while (this.frameReceivers[dst])
			await this.frameReceivers[dst].promise;
		
		let timeoutId = setTimeout(() => this._handleReceiverResponse(src, dst, new Error(`BFC command timeout.`)), timeout);
		
		let promise = new Promise((resolve, reject) => {
			this.frameReceivers[dst] = { src, dst, resolve, reject,  parser, timeoutId };
		});
		this.frameReceivers[dst].promise = promise;
		
		return this.frameReceivers[dst];
	}
	
	_handleReceiverResponse(src, dst, response) {
		let receiver = this.frameReceivers[dst];
		if (!receiver || receiver.src != src) {
			console.error(`[BFC] unexpected frame`, sprintf(`from %02X to %02X:`, src, dst), response.toString('hex'));
			return;
		}
		
		delete this.frameReceivers[dst];
		
		clearTimeout(receiver.timeoutId);
		
		if ((response instanceof Error)) {
			receiver.reject(response);
		} else {
			receiver.resolve(response);
		}
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
			this.authCache[dst] = await this.sendAuth(src, dst);
		
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
		
		if (this.verbose) {
			let crc = (frameFlags & BFC_FRAME_FLAGS.CRC) != 0 ? 1 : 0;
			let ack = (frameFlags & BFC_FRAME_FLAGS.ACK) != 0 ? 1 : 0;
			console.log(`[BFC]`, sprintf(`TX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X]`, +src, +dst, crc, ack, frameType), payload.toString('hex'));
		}
		
		await serialPortAsyncWrite(this.port, pkt);
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
