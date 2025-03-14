import createDebug from 'debug';
import { crc16 } from './crc16.js';
import { AtChannel, AtCommandResponse } from './AtChannel.js';
import { sprintf } from 'sprintf-js';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { decodeCString, usePromiseWithResolvers } from './utils.js';

const debug = createDebug('bfc');

export const DEFAULT_CHANNEL_ID = 0x01;

export enum BfcFrameFlags {
	NONE	= 0,
	ACK		= 1 << 4,
	CRC		= 1 << 5,
}

export enum BfcFrameTypes {
	SINGLE		= 0,
	MULTIPLE	= 1,
	ACK			= 2,
	STATUS		= 4,
}

export enum BfcHardwareInfo {
	RFChipSet			= 1,
	HwDetection			= 2,
	SWPlatform			= 3,
	PAType				= 4,
	LEDType				= 5,
	LayoutType			= 6,
	BandType			= 7,
	StepUpType			= 8,
	BluetoothType		= 9,
}

export enum BfcSoftwareInfo {
	DB_Name						= 1,
	Baseline_Version			= 2,
	Baseline_Release			= 3,
	Project_Name				= 4,
	SW_Builder					= 5,
	Link_Time_Stamp				= 6,
	Reconfigure_Time_Stamp		= 7,
}

// All possible baudrates for BFC
// 115200 - USB
// 230400 - USART SG
// 921600 - USART NSG
const SERIAL_BAUDRATES = [115200, 230400, 921600];

enum BfcTransportMode {
	NONE,
	AT,
	BFC,
}

export type BfcFrame = {
	src: number;
	dst: number;
	data: Buffer;
	type: BfcFrameTypes;
	flags: BfcFrameFlags;
};

export type BfcReceiver = {
	src: number;
	dst: number;
	timeout: number;
	parser: (frame: BfcFrame, done: (resolve: any | Error) => void) => void;
	promise: Promise<Buffer>;
	resolve: (response: any) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
};

export type BfcApiExecOptions<T> = {
	type?: BfcFrameTypes;
	crc?: boolean;
	ack?: boolean;
	auth?: boolean;
	parser?: (frame: BfcFrame, resolve: (response: T | Error) => void) => void;
	timeout?: number;
};

export type BfcDisplayInfo = {
	width: number;
	height: number;
	clientId: number;
};

export type BfcDisplayBufferInfo = {
	clientId: number;
	width: number;
	height: number;
	x: number;
	y: number;
	addr: number;
	type: number;
};

export type BfcDisplayBufferData = BfcReadResult & {
	mode: string;
	width: number;
	height: number;
};

export type BfcReadWriteProgress = {
	cursor: number;
	total: number;
	elapsed: number;
}

export type BfcReadWriteOptions = {
	onProgress?: (progress: BfcReadWriteProgress) => void;
	progressInterval?: number;
	signal?: AbortSignal | null;
};

export type BfcWriteResult = {
	canceled: boolean;
	written: number;
};

export type BfcReadResult = {
	buffer: Buffer;
	canceled: boolean;
};

export class BFC {
	private mode = BfcTransportMode.NONE;
	private authCache: Record<number, boolean> = {};
	private frameReceivers: Record<number, BfcReceiver> = {};
	private buffer = Buffer.alloc(0);
	private readonly handleSerialDataCallback = this.handleSerialData.bind(this);
	private readonly handleSerialCloseCallback = this.handleSerialClose.bind(this);
	private readonly atc: AtChannel;
	private readonly port: AsyncSerialPort;

	constructor(port: AsyncSerialPort) {
		this.port = port;
		this.atc = new AtChannel(port);
	}

	private setTransportMode(mode: BfcTransportMode): void {
		if (this.mode == mode)
			return;
		this.mode = mode;

		switch (mode) {
			case BfcTransportMode.NONE:
				debug(`Mode: NONE`);
				this.port.off('data', this.handleSerialDataCallback);
				this.port.off('close', this.handleSerialCloseCallback);
				this.atc.stop();
				this.buffer = Buffer.alloc(0);
			break;

			case BfcTransportMode.AT:
				debug(`Mode: AT`);
				this.port.off('data', this.handleSerialDataCallback);
				this.port.off('close', this.handleSerialCloseCallback);
				this.atc.start();
				this.buffer = Buffer.alloc(0);
			break;

			case BfcTransportMode.BFC:
				debug(`Mode: BFC`);
				this.port.on('data', this.handleSerialDataCallback);
				this.port.on('close', this.handleSerialCloseCallback);
				this.atc.stop();
			break;
		}
	}

	private async findOpenedBfc(): Promise<number> {
		this.setTransportMode(BfcTransportMode.BFC);
		for (const baudRate of SERIAL_BAUDRATES) {
			debug(`Probing BFC at baudrate: ${baudRate}`);
			await this.port.update({ baudRate });
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BfcFrameTypes.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BfcFrameTypes.STATUS, 0, [0x80, 0x11]);
			await this.sendFrame(DEFAULT_CHANNEL_ID, 0x02, BfcFrameTypes.STATUS, 0, [0x80, 0x11]);
			if (await this.ping(300)) {
				await new Promise((resolve) => setTimeout(resolve, 2000)); // Wait for BFC is ready
				debug(`Phone is already in BFC mode!`);
				return baudRate;
			}
		}
		this.setTransportMode(BfcTransportMode.NONE);
		return 0;
	}

	private async trySwitchFromAtToBfc(): Promise<boolean> {
		await this.port.update({ baudRate: 115200 });

		debug(`Probing AT handshake...`);
		this.setTransportMode(BfcTransportMode.AT);

		let response: AtCommandResponse;
		if (await this.atc.handshake()) {
			// AT^SIFS - current interface USB, WIRE, BLUE, IRDA
			response = await this.atc.sendCommand("AT^SIFS", "^SIFS", 750);
			if (response.success && response.lines.length > 0 && response.lines[0].match(/BLUE/)) {
				this.setTransportMode(BfcTransportMode.NONE);
				throw new Error(`Bluetooth is not supported for BFC.`);
			}

			debug(`Phone in AT mode, switching from AT to BFC...`);
			response = await this.atc.sendCommandNumeric("AT^SQWE=1");
			if (response.success) {
				this.setTransportMode(BfcTransportMode.BFC);
				await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for BFC is ready
				if (await this.ping()) {
					debug(`Successfully switched to BFC mode!`);
					return true;
				} else {
					this.setTransportMode(BfcTransportMode.NONE);
					throw new Error(`Switching to BFC failed! (ping)`);
				}
			} else {
				this.setTransportMode(BfcTransportMode.NONE);
				throw new Error(`Switching to BFC failed! (AT^SQWE=1)`);
			}
		} else {
			debug(`AT handshake failed, maybe phone in BFC mode?`);
			this.setTransportMode(BfcTransportMode.AT);
			return false;
		}
	}

	async connect(): Promise<void> {
		if (this.mode == BfcTransportMode.BFC)
			throw new Error(`BFC already connected.`);

		if (!this.port?.isOpen)
			throw new Error(`Serial port closed.`);

		if (await this.trySwitchFromAtToBfc())
			return;

		if (await this.findOpenedBfc())
			return;

		throw new Error(`Phone not found.`);
	}

	async disconnect(): Promise<void> {
		if (this.mode != BfcTransportMode.BFC)
			return;
		if (this.mode == BfcTransportMode.BFC && this.port?.isOpen) {
			if (await this.ping()) {
				try {
					await this.sendAT("AT^SQWE = 0\r", 250);
					await this.port.update({ baudRate: 115200 });
					await new Promise((resolve) => setTimeout(resolve, 300));
				} catch (e) {
					if (e instanceof Error) {
						debug(`disconnect error: ${e.message}`);
					} else {
						debug(`disconnect error: ${e}`);
					}
				}
			}
		}
		this.handleSerialClose();
		return;
	}

	private handleSerialClose(): void {
		for (const dst in this.frameReceivers) {
			const receiver = this.frameReceivers[dst];
			void this.handleReceiverResponse(receiver.src, +dst, new Error(`BFC connection closed.`));
		}
		this.setTransportMode(BfcTransportMode.NONE);
	}

	private handleSerialData(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);

		while (this.buffer.length >= 6) {
			let pktStart = findPacketStartInBuffer(this.buffer);
			if (pktStart == null) {
				this.buffer = this.buffer.subarray(this.buffer.length - 5); // trim noise
				continue;
			}

			if (pktStart > 0) { // trim noise
				this.buffer = this.buffer.subarray(pktStart);
				pktStart = 0;
			}

			const pktLen = calcTotalPacketSize(this.buffer);
			if (this.buffer.length < pktLen)
				break;

			const pkt = this.buffer.subarray(0, pktLen);
			this.buffer = this.buffer.subarray(pktLen);

			void this.handleBfcPacket(pkt);
		}
	}

	private async handleBfcPacket(pkt: Buffer): Promise<void> {
		const dst = pkt[0];
		const src = pkt[1];
		const payloadLen = pkt.readUInt16BE(2);
		const frameType = pkt[4] & 0x0F;
		const frameFlags = pkt[4] & 0xF0;
		const payload = pkt.subarray(6, 6 + payloadLen);
		const crc = (frameFlags & BfcFrameFlags.CRC) != 0 ? 1 : 0;
		const ack = (frameFlags & BfcFrameFlags.ACK) != 0 ? 1 : 0;
		const receiver = this.frameReceivers[dst];
		const ignored = !receiver || receiver.src != src;

		debug(sprintf(`RX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X] %s%s`, src, dst, crc, ack, frameType, payload.toString('hex'), ignored ? ` (ignored)` : ``));

		if ((frameFlags & BfcFrameFlags.CRC) && !checkPacketChecksum(pkt)) {
			void this.handleReceiverResponse(src, dst, new Error(`Invalid CRC!`));
			return;
		}

		if ((frameFlags & BfcFrameFlags.ACK)) {
			// Auto ACK
			await this.sendAck(src, dst);
		}

		if (receiver && receiver.parser) {
			const frame: BfcFrame = { src, dst, data: payload, type: frameType, flags: frameFlags };
			try {
				receiver.parser(frame, (response) => this.handleReceiverResponse(src, dst, response));
			} catch (error) {
				if (error instanceof Error) {
					void this.handleReceiverResponse(src, dst, error);
				} else {
					throw error;
				}
			}
		} else {
			void this.handleReceiverResponse(src, dst, payload);
		}
	}

	private async createReceiver(src: number, dst: number, timeout: number, parser: BfcReceiver["parser"]): Promise<BfcReceiver> {
		while (this.frameReceivers[dst]) {
			await this.frameReceivers[dst].promise;
		}

		const timeoutId = setTimeout(() => {
			this.handleReceiverResponse(src, dst, new Error(`BFC command ${src.toString(16)}:${dst.toString(16)} timeout.`));
		}, timeout);

		const { promise, resolve, reject } = usePromiseWithResolvers<any>();
		this.frameReceivers[dst] = { src, dst, promise, resolve, reject, parser, timeoutId, timeout };
		return this.frameReceivers[dst];
	}

	private handleReceiverResponse(src: number, dst: number, response: any | Error): boolean {
		const receiver = this.frameReceivers[dst];
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

	async exec<T = Buffer>(src: number, dst: number, payload: any, options: BfcApiExecOptions<T> = {}): Promise<T> {
		if (this.mode != BfcTransportMode.BFC)
			throw new Error(`BFC is not connected.`);

		const validOptions = {
			type: BfcFrameTypes.SINGLE,
			crc: true,
			ack: false,
			auth: true,
			timeout: 5000,
			...options || {}
		};

		if (validOptions.auth && !this.authCache[dst])
			this.authCache[dst] = await this.sendAuth(src, dst, validOptions.timeout);

		const { promise } = await this.createReceiver(dst, src, validOptions.timeout, validOptions.parser as BfcReceiver["parser"]);

		let frameFlags = 0;
		if (validOptions.crc)
			frameFlags |= BfcFrameFlags.CRC;
		if (validOptions.ack)
			frameFlags |= BfcFrameFlags.ACK;

		try {
			await this.sendFrame(src, dst, validOptions.type, frameFlags, payload);
		} catch (err) {
			if (err instanceof Error) {
				this.handleReceiverResponse(dst, src, err);
			} else {
				throw err;
			}
		}

		return (await promise) as T;
	}

	async sendAuth(src: number, dst: number, timeout: number = 0): Promise<boolean> {
		const response = await this.exec(src, dst, [0x80, 0x11], { type: BfcFrameTypes.STATUS, crc: false, auth: false, timeout });
		return response[0] == 0x43 && response[1] == 0x11;
	}

	async sendAck(src: number, dst: number): Promise<void> {
		await this.sendFrame(src, dst, BfcFrameTypes.ACK, BfcFrameFlags.CRC, [0x15, 1]);
	}

	async sendFrame(src: number, dst: number, frameType: BfcFrameTypes, frameFlags: BfcFrameFlags, payload: any): Promise<void> {
		if (this.mode != BfcTransportMode.BFC)
			throw new Error(`BFC is not connected.`);

		if (!Buffer.isBuffer(payload))
			payload = Buffer.from(payload);

		const pktLen = ((frameFlags & BfcFrameFlags.CRC) ? 8 : 6) + payload.length;
		const pkt = Buffer.alloc(pktLen);

		let offset = 0;
		offset = pkt.writeUInt8(dst, offset);
		offset = pkt.writeUInt8(src, offset);
		offset = pkt.writeUInt16BE(payload.length, offset);
		offset = pkt.writeUInt8(frameType | frameFlags, offset);
		offset = pkt.writeUInt8(pkt[0] ^ pkt[1] ^ pkt[2] ^ pkt[3] ^ pkt[4], offset);
		offset += payload.copy(pkt, offset);

		if ((frameFlags & BfcFrameFlags.CRC)) {
			const crc = crc16(pkt, 0, payload.length + 6);
			offset = pkt.writeUInt16BE(crc, offset);
		}

		if (offset != pktLen)
			throw new Error(`Invalid packet length!`);

		const crc = (frameFlags & BfcFrameFlags.CRC) != 0 ? 1 : 0;
		const ack = (frameFlags & BfcFrameFlags.ACK) != 0 ? 1 : 0;
		debug(sprintf(`TX %02X >> %02X [CRC:%d, ACK:%d, TYPE:%02X] %s`, +src, +dst, crc, ack, frameType, payload.toString('hex')));

		await this.port.write(pkt);
	}

	// ----------------------------------------------------------------------------------
	// BFC API
	// ----------------------------------------------------------------------------------

	async ping(timeout = 10000): Promise<boolean> {
		try {
			return await this.sendAuth(DEFAULT_CHANNEL_ID, 0x02, timeout);
		} catch (e) {
			return false;
		}
	}

	async setBestBaudrate(limitBaudrate = 0): Promise<boolean> {
		const prevBaudRate = this.port.baudRate;

		if (prevBaudRate > 115200)
			return true;

		let foundBestBaudrate = 0;
		for (const baudrate of [...SERIAL_BAUDRATES].reverse()) {
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

	async setPhoneBaudrate(baudRate: number): Promise<boolean> {
		const payload = Buffer.concat([ Buffer.from([0x02]), Buffer.from(baudRate.toString()) ]);
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x01, payload);
		return !(response[0] == 0x02 && response[1] == 0xEE);
	}

	async getBaseband(): Promise<[string, string] | undefined> {
		const KNOWN_CPUS: Record<number, [string, string]> = {
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
		const UNKNOWN_CPUS: Record<number, [string, string]> = {
			0x1A00:	["pmb8875", "SGold Lite Vx.x"],
			0x1B00:	["pmb8876", "SGold2 Vx.x"],
		};
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x03]);
		const cpuId = Number(BigInt(response[2]) | (BigInt(response[1]) << 8n) | (BigInt(response[4]) << 16n) | (BigInt(response[3]) << 24n));
		return KNOWN_CPUS[cpuId] ?? UNKNOWN_CPUS[cpuId & 0xFF00];
	}

	async getHwInfo(hwi: BfcHardwareInfo): Promise<number> {
		const hwi2key = {
			[BfcHardwareInfo.RFChipSet]:		0,
			[BfcHardwareInfo.HwDetection]:		4,
			[BfcHardwareInfo.SWPlatform]:		8,
			[BfcHardwareInfo.PAType]:			1,
			[BfcHardwareInfo.LEDType]:			2,
			[BfcHardwareInfo.LayoutType]:		3,
			[BfcHardwareInfo.BandType]:			5,
			[BfcHardwareInfo.StepUpType]:		6,
			[BfcHardwareInfo.BluetoothType]:	7,
		};
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x02, hwi2key[hwi]]);
		return response[1];
	}

	async getSwInfo(swi: BfcSoftwareInfo): Promise<string> {
		const swi2key = {
			[BfcSoftwareInfo.DB_Name]:					0,
			[BfcSoftwareInfo.Baseline_Version]:			1,
			[BfcSoftwareInfo.Baseline_Release]:			2,
			[BfcSoftwareInfo.Project_Name]:				3,
			[BfcSoftwareInfo.SW_Builder]:				4,
			[BfcSoftwareInfo.Link_Time_Stamp]:			5,
			[BfcSoftwareInfo.Reconfigure_Time_Stamp]:	6,
		};
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x06, swi2key[swi]]);
		return decodeCString(response.subarray(1));
	}

	async getIMEI(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x05]);
		return decodeCString(response.subarray(1));
	}

	async getSwVersion(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0B]);
		return decodeCString(response.subarray(1));
	}

	async getLanguageGroup(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0E]);
		return decodeCString(response.subarray(1));
	}

	async getTegicGroup(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0F]);
		return decodeCString(response.subarray(1));
	}

	async getVendorName(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0C]);
		return decodeCString(response.subarray(1));
	}

	async getProductName(): Promise<string> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x11, [0x0D]);
		return decodeCString(response.subarray(1));
	}

	async getDisplayCount(): Promise<number> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x06]);
		return response[1];
	}

	async getDisplayInfo(displayId: number): Promise<BfcDisplayInfo> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x07, displayId]);
		return {
			width:		response.readUInt16LE(1),
			height:		response.readUInt16LE(3),
			clientId:	response.readUInt8(5),
		};
	}

	async getDisplayBufferInfo(clientId: number): Promise<BfcDisplayBufferInfo> {
		const response = await this.exec(DEFAULT_CHANNEL_ID, 0x0A, [0x09, clientId]);
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

	async getDisplayBuffer(displayId: number, options: BfcReadWriteOptions = {}): Promise<BfcDisplayBufferData> {
		const displayInfo = await this.getDisplayInfo(displayId);
		const displayBufferInfo = await this.getDisplayBufferInfo(displayInfo.clientId);

		const modes: Record<number, string> = {
			1:		'wb',
			2:		'rgb332',
			3:		'rgba4444',
			4:		'rgb565',
			5:		'rgb888',
			9:		'rgb8888',
		};

		const mode2bpp: Record<string, (w: number, h: number) => number> = {
			'wb':		(w, h) => Math.floor(Math.floor((w + 7) / 8) * h),
			'rgb332':	(w, h) => w * h,
			'rgba4444':	(w, h) => w * h * 2,
			'rgb565be':	(w, h) => w * h * 2,
			'rgb565':	(w, h) => w * h * 2,
			'rgb888':	(w, h) => w * h * 3,
			'rgb8888':	(w, h) => w * h * 4,
		};

		const rgbMode = modes[displayBufferInfo.type];
		if (!rgbMode)
			throw new Error(`Unknown display buffer type=${displayBufferInfo.type}`);

		const bytes = mode2bpp[rgbMode](displayBufferInfo.width, displayBufferInfo.height);
		const response = await this.readMemory(displayBufferInfo.addr, bytes, options);
		return { mode: rgbMode, width: displayBufferInfo.width, height: displayBufferInfo.height, ...response };
	}

	async sendAT(cmd: string, timeout: number): Promise<string> {
		let tmp_buffer = "";
		return await this.exec<string>(DEFAULT_CHANNEL_ID, 0x17, cmd, {
			parser: (frame, resolve) => {
				tmp_buffer += frame.data.toString();
				if (tmp_buffer.match(/\r\n(OK|ERROR|\+CMS ERROR|\+CME ERROR)[^\r\n]*\r\n$/s))
					resolve(tmp_buffer);
			},
			timeout
		});
	}

	async readMemory(address: number, length: number, options: BfcReadWriteOptions = {}): Promise<BfcReadResult> {
		const validOptions = {
			progressInterval: 500,
			...options
		};
		const start = Date.now();
		const buffer = Buffer.alloc(length);
		let cursor = 0;
		let canceled = false;
		let lastProgressCalled = 0;
		while (cursor < buffer.length) {
			if (validOptions.signal?.aborted) {
				canceled = true;
				debug("Reading canceled by user.");
				break;
			}

			if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && cursor > 0)) {
				validOptions.onProgress && validOptions.onProgress({
					cursor,
					total: buffer.length,
					elapsed: Date.now() - start
				});
				lastProgressCalled = Date.now();
			}

			const chunkSize = Math.min(buffer.length - cursor, 63 * 256);
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
		validOptions.onProgress && validOptions.onProgress({
			cursor,
			total: buffer.length,
			elapsed: Date.now() - start
		});
		return { buffer, canceled };
	}

	async readMemoryChunk(address: number, length: number, buffer: Buffer, bufferOffset: number = 0): Promise<boolean> {
		const cmd = Buffer.alloc(9);
		cmd.writeUInt8(0x01, 0);
		cmd.writeUInt32LE(address, 1);
		cmd.writeUInt32LE(length, 5);

		if (bufferOffset + length > buffer.length)
			throw new Error(`Target buffer is too small.`);

		if (length > 32 * 1024)
			throw new Error(`Maximum length for memory reading is 32k.`);

		let frameId = 0;
		let offset = 0;

		return await this.exec<boolean>(DEFAULT_CHANNEL_ID, 0x06, cmd, {
			parser: (frame, resolve) => {
				if (frameId == 0) {
					const ack = frame.data.readUInt16LE(0);
					if (ack != 1)
						resolve(new Error(`readMemory(): invalid ACK (0x${ack.toString(16)})`));
				} else if (frame.type == BfcFrameTypes.SINGLE) {
					buffer.set(frame.data, bufferOffset + offset);
					offset += frame.data.length;
				} else if (frame.type == BfcFrameTypes.MULTIPLE) {
					buffer.set(frame.data.subarray(1), bufferOffset + offset);
					offset += frame.data.length - 1;
				} else {
					resolve(new Error(`Unknown frame received: ${JSON.stringify(frame)}`));
				}

				if (offset == length)
					resolve(true);

				frameId++;
			}
		});
	}
}

function findPacketStartInBuffer(buffer: Buffer): number | undefined {
	let i = 0;
	while (buffer.length - i >= 6) {
		const chk = buffer[i] ^ buffer[i + 1] ^ buffer[i + 2] ^ buffer[i + 3] ^ buffer[i + 4];
		if (chk == buffer[i + 5])
			return i;
		i++;
	}
	return undefined;
}

function checkPacketChecksum(pkt: Buffer): boolean {
	const payloadLen = pkt.readUInt16BE(2);
	const pktCRC = pkt.readUInt16BE(6 + payloadLen);
	const realCRC = crc16(pkt, 0, payloadLen + 6);
	return pktCRC == realCRC;
}

function calcTotalPacketSize(pkt: Buffer): number {
	let len = pkt.readUInt16BE(2) + 6;
	if ((pkt[4] & BfcFrameFlags.CRC))
		len += 2;
	return len;
}
