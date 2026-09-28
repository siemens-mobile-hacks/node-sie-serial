import createDebug from 'debug';
import { AtChannel } from '#src/at/AtChannel.js';
import { sprintf } from 'sprintf-js';
import { ioReadMemory, IoReadResult, IoReadWriteOptions, ioWriteMemory, IoWriteResult } from '#src/io.js';
import { BaseSerialProtocol } from '#src/BaseSerialProtocol.js';
import type { BfcDisplayBufferType } from '#src/bfc/BFC.js';
import { decodeCString, delay, usePromiseWithResolvers } from '#src/utils.js';

const debug = createDebug('bfb');
const debugTrx = createDebug('bfb:trx');

export const BFB_MAX_PAYLOAD_SIZE = 32;
export const BFB_MAX_MEMORY_READ_CHUNK = 31;
export const BFB_MAX_MEMORY_WRITE_CHUNK = 25;

const BFB_EEP_READ_CHUNK = 30;
const BFB_EEP_WRITE_CHUNK = 20;
const BFB_EEP_MAX_WRITE_CHUNK = BFB_MAX_PAYLOAD_SIZE - 6;
const BFB_PING_ATTEMPTS = 10;

const C166_ADDRESS_SPACE_SIZE = 0x01000000;
const C166_ADDRSEL1_ADDRESS = 0xFE18;
const C166_BUSCON1_ADDRESS = 0xFF14;
const C166_BUS_WINDOW_COUNT = 4;
const C166_BUSACT = 1 << 10;

export enum BfbChannel {
	CONFIGURATION	= 0x01,
	CORE			= 0x02,
	HARDWARE		= 0x05,
	AT				= 0x06,
	GBS				= 0x07,
	SECURITY		= 0x0B,
	INFO			= 0x0E,
	EEPROM			= 0x14,
	SERVICE_STREAM	= 0x16,
}

export enum BfbCoreOpcode {
	WRITE_MEMORY_BLOCK	= 0x01,
	READ_MEMORY			= 0x02,
	PING				= 0x14,
	WRITE_MEMORY_BYTE	= 0x30,
	WRITE_MEMORY_WORD	= 0x31,
	GET_DEBUGGER_NAME	= 0x42,
	EXEC_CODE			= 0x75,
}

export enum BfbConfigurationOpcode {
	POWER_SAVING = 0x11,
	POWER_SAVING_ACK = 0x12,
	POWER_SAVING_REJECTED = 0x13,
	SET_BAUD_RATE = 0xC0,
	BAUD_RATE_ACK = 0xCC,
	BAUD_RATE_REJECTED = 0xCF,
}

export enum BfbHardwareOpcode {
	PRESS_KEY = 0x06,
	GET_DISPLAY_BUFFER_ADDRESS = 0x07,
	UPDATE_DISPLAY = 0x08,
	REDIRECT_KEYPAD = 0x0A,
	RESTORE_KEYPAD = 0x0B,
	KEYPAD_EVENT = 0x0C,
	REDIRECT_DISPLAY = 0x0D,
	RESTORE_DISPLAY = 0x0E,
	DISPLAY_EVENT = 0x0F,
	SET_DISPLAY_CONTRAST = 0x10,
	PLAY_TONE = 0x11,
	STOP_TONE = 0x12,
	BOOT_DSP = 0x13,
	GET_DISPLAY_TYPE = 0x14,
	GET_SENSOR_ADDRESSES = 0x16,
	SET_ENVIRONMENT_TEMPERATURE = 0x17,
	ACTIVATE_NF_CONTROL = 0x18,
	CONFIGURE_NF_CONTROL = 0x19,
	DEACTIVATE_NF_CONTROL = 0x1A,
	GET_HARDWARE_ID = 0x21,
	GET_FLASH_SERIAL_NUMBER = 0x23,
	GET_HARDWARE_INFO = 0x24,
	GET_HARDWARE_DATA = 0x25,
	SEND_DSP_COMMAND = 0x30,
	SET_RX_TX_CHANNEL = 0x31,
	SET_MONITOR_CHANNEL = 0x32,
	SET_RAMP_BID = 0x33,
	SET_POWER_MODE = 0x34,
	GET_POWER_VALUES = 0x35,
	SET_TX_PWM = 0x36,
	SET_PA_COMPENSATION = 0x37,
	SET_NF_SCALING = 0x38,
	SIMULATE_CHIP_CARD = 0x39,
	GET_AUDIO_GAIN_SHADOW = 0x3A,
	GET_FIRMWARE_INFORMATION = 0x3B,
	GET_NORMAL_MODE_RX_LEVEL = 0x3C,
	SWITCH_SMI_TO_NORMAL = 0x3D,
	SWITCH_SPEECH_OFF = 0x3E,
	GET_MOBILE_MODE = 0x3F,
	SWITCH_OFF_DISPLAY = 0x40,
	PLAY_OV_TONE = 0x41,
	SET_TIMING_SCENARIO = 0x42,
	SET_KEY_VALUE_RAMP = 0x43,
	CONTROL_LIGHT = 0x46,
	DISPLAY_DRIVER_DIAGNOSTIC = 0x47,
	GET_IQ_VALUES = 0x4A,
	SET_VIBRA = 0x4B,
	GET_POWER_ASIC_PROJECT = 0x4F,
	NO_OP = 0x50,
	SET_POWER_MANAGEMENT = 0x51,
	CLICK_SCHALKE_KEY = 0x52,
	GET_DSP_FIRMWARE_VERSION = 0x53,
	RF_MEASUREMENT = 0x54,
	TEST_LUMBERG = 0x55,
	AUDIO_DIAGNOSTICS = 0x56,
	UPDATE_UI_STATE = 0x60,
	SET_RESOURCE_VALUE = 0x61,
	SET_CPU_SPEED = 0x62,
	RESET_GPRS_BLER_COUNTERS = 0x70,
	GET_GPRS_BLER_COUNTERS = 0x71,
	SET_BLUETOOTH_MAPPER = 0x72,
	SET_RX_TX_BAND_CHANNEL = 0x73,
	SET_MONITOR_BAND_CHANNEL = 0x74,
	AFC = 0x77,
	GENERATE_DISPLAY_PATTERN = 0x78,
	AMC_ADVANCED = 0x81,
}

export enum BfbInfoOpcode {
	GET_BATTERY_VOLTAGE = 0x02,
	GET_FIRMWARE_VERSION = 0x03,
	POWER_OFF = 0x04,
	GET_FLAG_STATUS = 0x05,
	GET_MODEL_INFORMATION = 0x07,
	GET_LANGUAGE_INFORMATION = 0x09,
	GET_IMEI = 0x0A,
	INFORMATION_ELEMENT = 0x0B,
	BOOT_PIN_SETTINGS = 0x0C,
	ENTER_SOFTWARE_UPDATE = 0x20,
}

export enum BfbEepOpcode {
	CREATE_EELITE_BLOCK = 0x01,
	WRITE_EELITE_BLOCK = 0x02,
	FINISH_EELITE_BLOCK = 0x03,
	READ_EELITE_BLOCK = 0x04,
	GET_EELITE_BLOCK_INFO = 0x05,
	GET_EELITE_MAX_BLOCK_ID = 0x06,
	DELETE_EELITE_BLOCK = 0x07,
	GET_EELITE_SPACE_INFO = 0x08,
	CREATE_EEFULL_BLOCK = 0x11,
	WRITE_EEFULL_BLOCK = 0x12,
	FINISH_EEFULL_BLOCK = 0x13,
	READ_EEFULL_BLOCK = 0x14,
	GET_EEFULL_BLOCK_INFO = 0x15,
	GET_EEFULL_MAX_BLOCK_ID = 0x16,
	DELETE_EEFULL_BLOCK = 0x17,
	GET_EEFULL_SPACE_INFO = 0x18,
	WRITE_EEFULL_RANGE = 0x1A,
	GARBAGE_COLLECT_EEFULL = 0x1B,
	DELETE_INSTANCE = 0x51,
	FREEZE_SECURITY_DATA = 0x52,
}

export enum BfbGbsOpcode {
	ALLOCATE = 0x01,
	FREE = 0x02,
}

export enum BfbAtOpcode {
	REMOTE_CONTROL = 0xF0,
}

export enum BfbSecurityMode {
	REPAIR		= 0,
	DEVELOPER	= 1,
	FACTORY		= 2,
	CUSTOMER	= 3,
}

export type BfbEepStorage = 'eelite' | 'eefull';

type BfbFrame = {
	channel: number;
	data: Buffer;
};

type BfbFrameReceiver = {
	channel: number;
	opcode: number;
	resolve: (frame: BfbFrame) => void;
	reject: (error: Error) => void;
	timeoutId: NodeJS.Timeout;
};

type BfbFrameHandler = {
	channel: number;
	opcode: number;
	handle: (frame: BfbFrame) => void;
};

type BfbEepExecOptions = {
	timeout?: number;
	allowWait?: boolean;
	refreshTimeoutOnWait?: boolean;
	responseLength?: number;
};

export type BfbApiExecOptions = {
	timeout?: number;
	expectedChannel?: number;
	expectedOpcode?: number;
	responseLength?: number;
	minResponseLength?: number;
};

export type BfbEepBlockInfo = {
	id: number;
	size: number;
	version: number;
};

export type BfbEepSpaceInfo = {
	freeBlocks: number;
	freeAddressSpace: number;
	freeDataSpace: number;
};

export type BfbMemoryRegion = {
	addr: number;
	size: number;
	name: string;
};

export type BfbGprsBlerCounters = {
	counterA: number;
	counterB: number;
};

export type BfbDisplayEvent = {
	left: number;
	top: number;
	right: number;
	bottom: number;
	bufferAddress?: number;
	bytesPerPixel?: number;
};

export enum BfbDisplayRedirectMode {
	RECT = 0x00,
	RECT_WITH_ADDRESS = 0x01,
	NO_CALLBACK = 0x02,
	RAW_RECT = 0x10,
	RAW_RECT_WITH_ADDRESS = 0x11,
	RAW_NO_CALLBACK = 0x12,
}

export enum BfbDisplayPattern {
	SOLID			= 0x00,
	GRID			= 0x01,
	CHECKERBOARD	= 0x02,
	GRADIENT		= 0x03,
	COLOR_BARS		= 0x04,
	VALUE_GRID		= 0x64,
}

export enum BfbDisplayDiagnosticSelector {
	GET_BYTES_PER_PIXEL			= 0x02,
	ADJUST_CONTRAST				= 0x03,
	COMMIT_CALIBRATION			= 0x04,
	PULSE_CONTROL_PIN			= 0x05,
	GET_CALIBRATION_STATE		= 0x06,
	STEP_CALIBRATION_FORWARD	= 0x07,
	STEP_CALIBRATION_BACKWARD	= 0x08,
	GET_ZERO_STATE				= 0x09,
	SET_BYTES_PER_PIXEL			= 0x10,
	ENABLE_OPTION_15				= 0x15,
	ENABLE_OPTION_17				= 0x17,
	DISABLE_OPTION_17			= 0x18,
	GET_CONTROLLER_MARKER		= 0x40,
	GET_CONTROLLER_STATE_A		= 0x41,
	GET_CONTROLLER_STATE_B		= 0x42,
	GET_CONTROLLER_STATE_C		= 0x43,
	DISABLE_OPTION_15			= 0x44,
	SET_INTERNAL_FLAG			= 0x45,
	PULSE_CONTROL_PIN_ALT		= 0x46,
	CALL_CONTROLLER_CALLBACK	= 0x47,
	REINITIALIZE_CONTROLLER		= 0x48,
	RESET_TIMING_STATISTICS		= 0x79,
}

export enum BfbRfMeasurementCommand {
	GET_CHANNEL_VALUES	= 0x00,
	GET_CHANNEL_MAP		= 0x01,
	SET_CHANNEL_MAP		= 0x02,
	RUN_CHANNEL			= 0x03,
	GET_AVERAGED_VALUES	= 0x05,
}

export type BfbDisplayState = {
	x: number;
	y: number;
	width: number;
	height: number;
	bufferAddress: number;
	bytesPerPixel: number;
};

export type BfbDisplaySize = {
	width: number;
	height: number;
};

export type BfbDisplayBufferType = Extract<BfcDisplayBufferType, 'rgb332' | 'argb4444'> | 'wb';

export type BfbDisplayBufferData = IoReadResult & {
	type: BfbDisplayBufferType;
	bpp: number;
	x: number;
	y: number;
	width: number;
	height: number;
	bufferAddress: number;
};

export type BfbSensorData = {
	voltages: [number, number, number];
	temperatures: [number, number, number];
};

export type BfbSensorAddresses = {
	raw: number;
	calibrated: number;
};

export type BfbInformationElementList = {
	count: number;
	elements: number[];
};

export type BfbSecurityStringResponse = {
	response: Buffer;
	delay?: number;
};

enum BfbTransportMode {
	NONE,
	AT,
	BFB,
}

export const BFB_BAUD_RATES: Record<number, number> = {
	57600: 57600,
	115200: 115200,
	230400: 230000,
	460800: 460000,
};

const BFB_RESPONSE_LENGTHS: Partial<Record<number, Record<number, number>>> = {
	[BfbChannel.HARDWARE]: {
		[BfbHardwareOpcode.GET_DISPLAY_BUFFER_ADDRESS]: 5,
		[BfbHardwareOpcode.DISPLAY_EVENT]: 11,
		[BfbHardwareOpcode.GET_SENSOR_ADDRESSES]: 9,
		[BfbHardwareOpcode.GET_HARDWARE_ID]: 3,
		[BfbHardwareOpcode.GET_FLASH_SERIAL_NUMBER]: 5,
		[BfbHardwareOpcode.GET_HARDWARE_INFO]: 3,
		[BfbHardwareOpcode.GET_AUDIO_GAIN_SHADOW]: 3,
		[BfbHardwareOpcode.GET_NORMAL_MODE_RX_LEVEL]: 3,
		[BfbHardwareOpcode.NO_OP]: 1,
		[BfbHardwareOpcode.SET_RESOURCE_VALUE]: 1,
		[BfbHardwareOpcode.GET_GPRS_BLER_COUNTERS]: 5,
	},
	[BfbChannel.GBS]: {
		[BfbGbsOpcode.ALLOCATE]: 5,
	},
};

const BFB_EEP_STATUS: Record<number, string> = {
	0x30: 'EEPROM returned status OK without echoing the requested opcode.',
	0x31: 'EEPROM is not initialized.',
	0x32: 'EEPROM block does not exist.',
	0x33: 'EEPROM block id is not locked.',
	0x34: 'EEPROM response block id mismatch.',
	0x35: 'EEPROM has no free data space.',
	0x36: 'EEPROM block is too small.',
	0x37: 'EEPROM block is in use.',
	0x20: 'EEPROM transmission error.',
};

export class BfbRemoteError extends Error {
	readonly status: number;

	constructor(status: number, message?: string) {
		super(message ?? sprintf('BFB remote error: 0x%02X', status));
		this.name = 'BfbRemoteError';
		this.status = status;
	}
}

export class BfbUnsupportedCommandError extends Error {
	readonly channel: number;
	readonly opcode: number;

	constructor(channel: number, opcode: number) {
		const command = getBfbOpcodeName(channel, opcode) ?? 'command';
		super(sprintf(
			'BFB %s is unsupported in the current phone mode (%02X/%02X returned no data).',
			command,
			channel,
			opcode,
		));
		this.name = 'BfbUnsupportedCommandError';
		this.channel = channel;
		this.opcode = opcode;
	}
}

export class BfbCommandTimeoutError extends Error {
	readonly channel: number;
	readonly opcode: number;

	constructor(channel: number, opcode: number) {
		super(sprintf('BFB command %02X/%02X timeout.', channel, opcode));
		this.name = 'BfbCommandTimeoutError';
		this.channel = channel;
		this.opcode = opcode;
	}
}

export class BFB extends BaseSerialProtocol {
	private mode = BfbTransportMode.NONE;
	private buffer = Buffer.alloc(0);
	private frames: BfbFrame[] = [];
	private frameQueueChannel?: number;
	private frameReceiver?: BfbFrameReceiver;
	private readonly frameHandlers = new Map<string, BfbFrameHandler>();
	private readonly handleSerialDataCallback = this.handleSerialData.bind(this);
	private readonly handleSerialCloseCallback = this.handleSerialClose.bind(this);
	private readonly atc = new AtChannel(this.port);

	private setTransportMode(mode: BfbTransportMode): void {
		if (this.mode == mode)
			return;

		this.mode = mode;
		switch (mode) {
			case BfbTransportMode.NONE:
				debug('Mode: NONE');
				this.port.off('data', this.handleSerialDataCallback);
				this.port.off('close', this.handleSerialCloseCallback);
				this.atc.stop();
				this.buffer = Buffer.alloc(0);
				this.frames = [];
				this.frameQueueChannel = undefined;
				this.frameHandlers.clear();
			break;

			case BfbTransportMode.AT:
				debug('Mode: AT');
				this.port.off('data', this.handleSerialDataCallback);
				this.port.off('close', this.handleSerialCloseCallback);
				this.atc.start();
				this.buffer = Buffer.alloc(0);
				this.frames = [];
				this.frameQueueChannel = undefined;
			break;

			case BfbTransportMode.BFB:
				debug('Mode: BFB');
				this.atc.stop();
				this.port.on('data', this.handleSerialDataCallback);
				this.port.on('close', this.handleSerialCloseCallback);
			break;
		}
	}

	private async findOpenedBfb(): Promise<number> {
		this.setTransportMode(BfbTransportMode.BFB);
		for (const baudRate of Object.keys(BFB_BAUD_RATES).map(Number).sort((a, b) => b - a)) {
			debug(`Probing BFB at baudrate: ${baudRate}`);
			await this.port.update({ baudRate });
			if (await this.pingMobile(350)) {
				debug(`Phone is already in BFB mode!`);
				return baudRate;
			}
		}
		this.setTransportMode(BfbTransportMode.NONE);
		return 0;
	}

	private async trySwitchFromAtToBfb(): Promise<boolean> {
		await this.port.update({ baudRate: 115200 });
		debug('Probing AT handshake at 115200...');
		this.setTransportMode(BfbTransportMode.AT);

		if (await this.atc.handshake()) {
			debug('Phone in AT mode, switching from AT to BFB...');
			const response = await this.atc.sendCommandNumeric('AT^SQWE=1', 1000);
			if (response.success) {
				this.setTransportMode(BfbTransportMode.BFB);
				await delay(300); // Wait for BFB is ready
				await this.port.update({ baudRate: 57600 });
				if (!await this.pingMobile())
					throw new Error('Switching to BFB failed! (ping at 57600)');
				debug('Successfully switched to BFB mode!');
				return true;
			} else {
				this.setTransportMode(BfbTransportMode.NONE);
				throw new Error('Switching to BFB failed! (AT^SQWE=1)');
			}
		} else {
			debug('AT handshake failed, maybe phone in BFB mode?');
			return false;
		}
	}

	async connect(): Promise<void> {
		if (this.mode == BfbTransportMode.BFB)
			throw new Error('BFB already connected.');
		if (!this.port.isOpen)
			throw new Error('Serial port closed.');
		await this.port.setSignals({ dtr: true });

		try {
			if (await this.trySwitchFromAtToBfb())
				return;

			if (await this.findOpenedBfb())
				return;
		} catch (error) {
			this.setTransportMode(BfbTransportMode.NONE);
			throw error;
		}

		this.setTransportMode(BfbTransportMode.NONE);
		throw new Error('Phone not found.');
	}

	async disconnect(): Promise<void> {
		if (this.mode != BfbTransportMode.BFB)
			return;
		this.handleSerialClose();
	}

	private handleSerialClose(): void {
		if (this.frameReceiver) {
			const receiver = this.frameReceiver;
			this.frameReceiver = undefined;
			clearTimeout(receiver.timeoutId);
			receiver.reject(new Error('BFB connection closed.'));
		}
		this.setTransportMode(BfbTransportMode.NONE);
	}

	private handleSerialData(data: Buffer): void {
		this.buffer = Buffer.concat([this.buffer, data]);
		while (this.buffer.length >= 3) {
			const channel = this.buffer[0];
			const length = this.buffer[1];
			if (this.buffer[2] != (channel ^ length) || length > BFB_MAX_PAYLOAD_SIZE) {
				this.buffer = this.buffer.subarray(1);
				continue;
			}
			if (this.buffer.length < 3 + length)
				break;
			const frame = { channel, data: Buffer.from(this.buffer.subarray(3, 3 + length)) };
			this.buffer = this.buffer.subarray(3 + length);
			try {
				this.handleBfbFrame(frame);
			} catch (error) {
				debug('BFB event callback failed: %O', error);
			}
		}
	}

	private handleBfbFrame(frame: BfbFrame): void {
		if (debugTrx.enabled)
			debugTrx(sprintf('RX CH=%02X %s', frame.channel, frame.data.toString('hex')));

		const receiver = this.frameReceiver;
		if (receiver && this.frameMatches(frame, receiver.channel, receiver.opcode)) {
			this.frameReceiver = undefined;
			clearTimeout(receiver.timeoutId);
			receiver.resolve(frame);
			return;
		}
		if (frame.channel == this.frameQueueChannel) {
			this.frames.push(frame);
			return;
		}
		for (const handler of this.frameHandlers.values()) {
			if (this.frameMatches(frame, handler.channel, handler.opcode)) {
				handler.handle(frame);
				return;
			}
		}
		debug(sprintf('Ignored BFB frame CH=%02X %s', frame.channel, frame.data.toString('hex')));
	}

	private registerFrameHandler(id: string, handler: BfbFrameHandler): void {
		this.frameHandlers.set(id, handler);
	}

	private unregisterFrameHandler(id: string): void {
		this.frameHandlers.delete(id);
	}

	private frameMatches(frame: BfbFrame, channel: number, opcode: number): boolean {
		return (channel == 0 || frame.channel == channel) && (opcode == 0 || frame.data[0] == opcode);
	}

	private async receiveBfbFrame(
		channel: number,
		opcode: number,
		deadline: number,
		send?: () => Promise<void>,
	): Promise<BfbFrame> {
		const index = this.frames.findIndex((frame) => this.frameMatches(frame, channel, opcode));
		if (index >= 0)
			return this.frames.splice(index, 1)[0];

		const timeout = deadline - Date.now();
		if (timeout <= 0)
			throw new BfbCommandTimeoutError(channel, opcode);

		const { promise, resolve, reject } = usePromiseWithResolvers<BfbFrame>();
		const receiver: BfbFrameReceiver = {
			channel,
			opcode,
			resolve,
			reject,
			timeoutId: setTimeout(() => {
				this.frameReceiver = undefined;
				reject(new BfbCommandTimeoutError(channel, opcode));
			}, timeout),
		};
		this.frameReceiver = receiver;
		if (!send)
			return promise;
		try {
			const [frame] = await Promise.all([promise, send()]);
			return frame;
		} catch (error) {
			if (this.frameReceiver == receiver) {
				this.frameReceiver = undefined;
				clearTimeout(receiver.timeoutId);
			}
			throw error;
		}
	}

	private async withFrameQueue<T>(channel: number, action: () => Promise<T>): Promise<T> {
		this.frameQueueChannel = channel;
		this.frames = [];
		try {
			return await action();
		} finally {
			this.frameQueueChannel = undefined;
			for (const frame of this.frames)
				debug(sprintf('Ignored BFB frame CH=%02X %s', frame.channel, frame.data.toString('hex')));
			this.frames = [];
		}
	}

	async exec(channel: number, payload: Buffer | number[], options: BfbApiExecOptions = {}): Promise<Buffer> {
		if (this.mode != BfbTransportMode.BFB)
			throw new Error('BFB is not connected.');

		const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
		const validOptions = {
			timeout: 5000,
			expectedChannel: channel,
			expectedOpcode: data[0] ?? 0,
			...options,
		};
		const frame = await this.receiveBfbFrame(
			validOptions.expectedChannel,
			validOptions.expectedOpcode,
			Date.now() + validOptions.timeout,
			() => this.sendFrame(channel, data),
		);
		const expectedLength = validOptions.responseLength ?? BFB_RESPONSE_LENGTHS[channel]?.[data[0] ?? 0];
		const requiredLength = Math.max(expectedLength ?? 0, validOptions.minResponseLength ?? 0);
		if (requiredLength > 1 && frame.data.length == 1 && frame.data[0] == data[0])
			throw new BfbUnsupportedCommandError(channel, data[0]);
		if (expectedLength !== undefined && frame.data.length != expectedLength)
			throw new Error(`Invalid BFB response length: ${frame.data.length}, expected ${expectedLength}.`);
		if (validOptions.minResponseLength !== undefined && frame.data.length < validOptions.minResponseLength) {
			throw new Error(
				`Invalid BFB response length: ${frame.data.length}, expected at least ${validOptions.minResponseLength}.`,
			);
		}
		return frame.data;
	}

	private async pingMobile(timeout = 1000): Promise<boolean> {
		for (let attempt = 0; attempt < BFB_PING_ATTEMPTS; attempt++) {
			if (await this.ping(timeout))
				return true;
		}
		return false;
	}

	async sendFrame(channel: number, payload: Buffer | number[]): Promise<void> {
		if (this.mode != BfbTransportMode.BFB)
			throw new Error('BFB is not connected.');

		const frame = encodeBfbFrame(channel, payload);
		if (debugTrx.enabled) {
			const data = frame.subarray(3);
			debugTrx(sprintf('TX CH=%02X %s', channel, data.toString('hex')));
		}
		await this.port.write(frame);
	}

	// ----------------------------------------------------------------------------------
	// BFB API
	// ----------------------------------------------------------------------------------

	async ping(timeout = 1000): Promise<boolean> {
		try {
			const response = await this.exec(BfbChannel.CORE, [BfbCoreOpcode.PING], { timeout });
			return response.length == 2 && response[0] == BfbCoreOpcode.PING && response[1] == 0xAA;
		} catch (error) {
			return false;
		}
	}

	async getDebuggerName(): Promise<string> {
		return this.withFrameQueue(BfbChannel.CORE, async () => {
			await this.sendFrame(BfbChannel.CORE, [BfbCoreOpcode.GET_DEBUGGER_NAME]);
			const deadline = Date.now() + 5000;
			const chunks: Buffer[] = [];
			let expectedOpcode: number = BfbCoreOpcode.GET_DEBUGGER_NAME;
			while (true) {
				const frame = await this.receiveBfbFrame(BfbChannel.CORE, expectedOpcode, deadline);
				if (expectedOpcode && frame.data.length < 2)
					throw new Error('Invalid BFB debugger name response.');
				chunks.push(expectedOpcode ? frame.data.subarray(1) : frame.data);
				expectedOpcode = 0;
				if (frame.data.length < BFB_MAX_PAYLOAD_SIZE)
					return decodeCString(Buffer.concat(chunks));
			}
		});
	}

	async setPhoneBaudrate(baudRate: number): Promise<boolean> {
		const previousBaudRate = this.port.baudRate;
		const bfbBaudrateCode = BFB_BAUD_RATES[baudRate];
		if (bfbBaudrateCode === undefined)
			throw new Error(`Unsupported BFB baudrate: ${baudRate}.`);

		if (baudRate == previousBaudRate)
			return true;

		let acknowledged = false;
		try {
			const payload = Buffer.concat([
				Buffer.from([BfbConfigurationOpcode.SET_BAUD_RATE]),
				Buffer.from(bfbBaudrateCode.toString(), 'ascii'),
			]);
			const request = Buffer.concat([payload, computeBfbBaudCrc(payload)]);
			const response = await this.exec(BfbChannel.CONFIGURATION, request, {
				expectedOpcode: 0,
			});
			if (response[0] == BfbConfigurationOpcode.BAUD_RATE_ACK) {
				acknowledged = response.subarray(1).equals(request.subarray(1));
				if (!acknowledged)
					debug(`Invalid baudrate acknowledgement: ${response.toString('hex')}`);
			} else if (response[0] != BfbConfigurationOpcode.BAUD_RATE_REJECTED) {
				throw new Error(sprintf('Unexpected baud response opcode: 0x%02X', response[0] ?? 0));
			}
		} catch (error) {
			debug(`Baudrate acknowledgement failed: ${error}`);
		}

		if (acknowledged) {
			await this.port.update({ baudRate });
			await delay(75);
			if (await this.ping())
				return true;
		}

		await this.port.update({ baudRate: previousBaudRate });
		await delay(75);
		if (await this.ping())
			return false;

		await this.port.update({ baudRate });
		await delay(75);
		if (await this.ping())
			return true;

		await this.port.update({ baudRate: previousBaudRate });
		return false;
	}

	async setBestBaudrate(limitBaudrate = 0): Promise<boolean> {
		const baudRates = Object.keys(BFB_BAUD_RATES).map(Number)
			.filter((baudRate) => !limitBaudrate || baudRate <= limitBaudrate)
			.sort((a, b) => b - a);
		for (const baudRate of baudRates) {
			debug(`Probing new baudrate: ${baudRate}`);
			if (await this.setPhoneBaudrate(baudRate)) {
				debug(`New baudrate: ${baudRate}`);
				return true;
			}
			if (!await this.ping()) {
				debug(`Phone connection lost!!!`);
				return false;
			}
		}
		return false;
	}

	async configurePowerSaving(mode: number): Promise<void> {
		const response = await this.exec(
			BfbChannel.CONFIGURATION,
			[BfbConfigurationOpcode.POWER_SAVING, mode],
			{ expectedOpcode: 0 },
		);
		if (response[0] == BfbConfigurationOpcode.POWER_SAVING_REJECTED)
			throw new BfbRemoteError(response[0], 'BFB power-saving configuration was rejected.');
		if (response.length != 2)
			throw new Error(`Invalid BFB power-saving response length: ${response.length}.`);
		if (response[0] != BfbConfigurationOpcode.POWER_SAVING_ACK || response[1] != mode) {
			throw new Error(
				`Invalid BFB power-saving response: ${response.toString('hex')}, expected 12${mode.toString(16).padStart(2, '0')}.`,
			);
		}
	}

	async getMemoryRegions(): Promise<BfbMemoryRegion[]> {
		const addrsel = (await this.readMemory(C166_ADDRSEL1_ADDRESS, C166_BUS_WINDOW_COUNT * 2)).buffer;
		const buscon = (await this.readMemory(C166_BUSCON1_ADDRESS, C166_BUS_WINDOW_COUNT * 2)).buffer;
		const windows: BfbMemoryRegion[] = [];

		for (let index = 0; index < C166_BUS_WINDOW_COUNT; index++) {
			const value = addrsel.readUInt16LE(index * 2);
			if ((buscon.readUInt16LE(index * 2) & C166_BUSACT) == 0)
				continue;

			const sizeCode = value & 0xF;
			const size = 0x1000 << sizeCode;
			const addr = (((value & 0xFFF0) << 8) & ~(size - 1)) >>> 0;
			windows.push({ name: 'RAM', addr, size });
		}

		windows.sort((a, b) => a.addr - b.addr);

		const memoryRegions: BfbMemoryRegion[] = [];
		let address = 0;
		for (const region of windows) {
			if (address < region.addr)
				memoryRegions.push({ name: 'FLASH', addr: address, size: region.addr - address });
			if (address < region.addr + region.size) {
				const addr = Math.max(address, region.addr);
				memoryRegions.push({ name: 'RAM', addr, size: region.addr + region.size - addr });
				address = region.addr + region.size;
			}
		}
		if (address < C166_ADDRESS_SPACE_SIZE) {
			memoryRegions.push({ name: 'FLASH', addr: address, size: C166_ADDRESS_SPACE_SIZE - address });
		}
		return memoryRegions;
	}

	async readMemory(address: number, length: number, options: IoReadWriteOptions = {}): Promise<IoReadResult> {
		return ioReadMemory({
			pageSize: BFB_MAX_MEMORY_READ_CHUNK,
			align: 1,
			debug,
			maxRetries: 3,
			read: this.readMemoryChunk.bind(this),
		}, address, length, options);
	}

	async readMemoryChunk(address: number, length: number, buffer: Buffer, bufferOffset = 0): Promise<void> {
		if (!Number.isInteger(length) || length < 1 || length > BFB_MAX_MEMORY_READ_CHUNK)
			throw new Error(`BFB memory read length must be in range 1..${BFB_MAX_MEMORY_READ_CHUNK}.`);
		if (!Number.isInteger(bufferOffset) || bufferOffset < 0 || bufferOffset + length > buffer.length)
			throw new Error('Target buffer is too small for the BFB memory read.');

		const request = Buffer.alloc(7);
		request.writeUInt8(BfbCoreOpcode.READ_MEMORY, 0);
		request.writeUInt32LE(address, 1);
		request.writeUInt16LE(length, 5);
		const response = await this.exec(BfbChannel.CORE, request, { responseLength: length + 1 });
		response.copy(buffer, bufferOffset, 1);
	}

	async writeMemory(address: number, buffer: Buffer, options: IoReadWriteOptions = {}): Promise<IoWriteResult> {
		return ioWriteMemory({
			pageSize: BFB_MAX_MEMORY_WRITE_CHUNK,
			align: 1,
			debug,
			maxRetries: 3,
			write: this.writeMemoryChunk.bind(this),
		}, address, buffer, options);
	}

	async writeMemoryChunk(address: number, buffer: Buffer): Promise<void> {
		if (!buffer.length || buffer.length > BFB_MAX_MEMORY_WRITE_CHUNK)
			throw new Error(`BFB memory write length must be in range 1..${BFB_MAX_MEMORY_WRITE_CHUNK}.`);

		const request = Buffer.alloc(7 + buffer.length);
		request.writeUInt8(BfbCoreOpcode.WRITE_MEMORY_BLOCK, 0);
		request.writeUInt32LE(address, 1);
		request.writeUInt16LE(buffer.length, 5);
		buffer.copy(request, 7);
		await this.exec(BfbChannel.CORE, request);
	}

	async writeMemoryByte(address: number, value: number): Promise<void> {
		const request = Buffer.alloc(6);
		request.writeUInt8(BfbCoreOpcode.WRITE_MEMORY_BYTE, 0);
		request.writeUInt32LE(address, 1);
		request.writeUInt8(value, 5);
		await this.exec(BfbChannel.CORE, request);
	}

	async writeMemoryWord(address: number, value: number): Promise<void> {
		const request = Buffer.alloc(7);
		request.writeUInt8(BfbCoreOpcode.WRITE_MEMORY_WORD, 0);
		request.writeUInt32LE(address, 1);
		request.writeUInt16LE(value, 5);
		await this.exec(BfbChannel.CORE, request);
	}

	async execCode(code: Buffer): Promise<Buffer> {
		if (!code.length || code.length >= BFB_MAX_PAYLOAD_SIZE)
			throw new Error(`BFB executable code length must be in range 1..${BFB_MAX_PAYLOAD_SIZE - 1}.`);
		const response = await this.exec(BfbChannel.CORE, Buffer.concat([
			Buffer.from([BfbCoreOpcode.EXEC_CODE]),
			code,
		]));
		return response.subarray(1);
	}

	async getHardwareId(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_HARDWARE_ID]);
		return response.readUInt16LE(1);
	}

	async getFlashSerialNumber(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_FLASH_SERIAL_NUMBER]);
		return response.readUInt32LE(1);
	}

	async getDisplayType(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_DISPLAY_TYPE], { responseLength: 2 });
		return response[1];
	}

	async getDisplayBufferAddress(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_DISPLAY_BUFFER_ADDRESS]);
		return response.readUInt32LE(1);
	}

	async getDisplayState(): Promise<BfbDisplayState> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.DISPLAY_EVENT]);
		return {
			x: response[1],
			y: response[2],
			width: response[3],
			height: response[4],
			bufferAddress: response.readUInt32LE(5),
			bytesPerPixel: response.readUInt16LE(9),
		};
	}

	async getDisplaySize(timeout = 5000): Promise<BfbDisplaySize> {
		const { promise, resolve } = usePromiseWithResolvers<BfbDisplaySize>();
		const deadline = Date.now() + timeout;
		let acceptEvent = false;
		let candidate: BfbDisplaySize | undefined;
		let confirmations = 0;
		let redirected = false;
		try {
			await this.redirectDisplay((event) => {
				if (!acceptEvent || event.left != 0 || event.top != 0)
					return;
				const size = {
					width: event.right - event.left + 1,
					height: event.bottom - event.top + 1,
				};
				if (candidate?.width == size.width && candidate.height == size.height) {
					confirmations++;
				} else {
					candidate = size;
					confirmations = 1;
				}
				if (confirmations >= 2)
					resolve(size);
			});
			redirected = true;
			acceptEvent = true;
			while (Date.now() < deadline) {
				await this.updateDisplay(0, 0, 0xFFFF, 0xFFFF);
				const remaining = deadline - Date.now();
				const size = await Promise.race([
					promise,
					delay(Math.min(100, Math.max(0, remaining))).then(() => undefined),
				]);
				if (size)
					return size;
			}
			throw new Error('Timed out waiting for BFB display size.');
		} finally {
			if (redirected)
				await this.restoreDisplay();
		}
	}

	async getDisplayBuffer(options: IoReadWriteOptions = {}): Promise<BfbDisplayBufferData> {
		const size = await this.getDisplaySize();
		const width = size.width;
		const height = size.height;
		let bufferAddress: number;
		let bpp: number;
		let type: BfbDisplayBufferType;

		try {
			const state = await this.getDisplayState();
			bufferAddress = state.bufferAddress;
			bpp = state.bytesPerPixel;
			if (bpp == 2) {
				type = 'argb4444';
			} else if (bpp == 1 && await this.getPhoneModel() == 'S55') {
				type = 'rgb332';
			} else {
				type = 'wb';
			}
		} catch (error) {
			if (!(error instanceof BfbUnsupportedCommandError))
				throw error;
			bufferAddress = await this.getDisplayBufferAddress();
			bpp = 1;
			type = await this.getPhoneModel() == 'S55' ? 'rgb332' : 'wb';
		}

		const bufferSize = type == 'wb' ? Math.floor((width + 7) / 8) * height : width * height * bpp;
		const result = await this.readMemory(bufferAddress, bufferSize, options);

		return {
			type,
			bpp,
			x: 0,
			y: 0,
			width,
			height,
			bufferAddress,
			...result,
		};
	}

	async getGprsBlerCounters(): Promise<BfbGprsBlerCounters> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_GPRS_BLER_COUNTERS]);
		return {
			counterA: response.readUInt16LE(1),
			counterB: response.readUInt16LE(3),
		};
	}

	async getHardwareData(selector: number): Promise<Buffer> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GET_HARDWARE_DATA, selector],
			{ minResponseLength: 2 },
		);
		if (response.length >= BFB_MAX_PAYLOAD_SIZE)
			throw new Error(`Invalid BFB hardware data response length: ${response.length}.`);
		if (response[1] != selector)
			throw new Error(`BFB hardware data selector mismatch: ${response[1]} != ${selector}.`);
		if (response.length == 2)
			throw new BfbUnsupportedCommandError(BfbChannel.HARDWARE, BfbHardwareOpcode.GET_HARDWARE_DATA);
		return Buffer.from(response.subarray(2));
	}

	async getPowerValues(count: number): Promise<Buffer> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_POWER_VALUES, count, 0x01], {
			timeout: (count + 0x32) * 5,
			minResponseLength: 3,
		});
		return Buffer.from(response.subarray(1));
	}

	async getFirmwareInformation(): Promise<Buffer> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GET_FIRMWARE_INFORMATION],
			{ minResponseLength: 5 },
		);
		return Buffer.from(response.subarray(1));
	}

	async getIqMeanValues(count: number): Promise<[number, number]> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GET_IQ_VALUES, 0, count],
			{ responseLength: 5 },
		);
		return [response.readUInt16LE(1), response.readUInt16LE(3)];
	}

	async getIqDriftValues(): Promise<number[]> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_IQ_VALUES, 1], { responseLength: 17 });
		return Array.from({ length: 8 }, (_value, index) => response.readUInt16LE(1 + index * 2));
	}

	async amcAdvanced(mode: number, data: number[] = []): Promise<number | undefined> {
		const request = Buffer.from([BfbHardwareOpcode.AMC_ADVANCED, mode, ...data]);
		const extended = mode == 3 || mode == 7;
		let responseLength = 3;
		if (extended)
			responseLength = 5;
		else if (mode == 8)
			responseLength = 1;
		const response = await this.exec(BfbChannel.HARDWARE, request, { responseLength });
		if (mode == 8)
			return undefined;
		const low = response.readUInt16LE(1);
		return extended ? low + response.readUInt16LE(3) * 0x4000 : low;
	}

	async getAudioGainShadow(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_AUDIO_GAIN_SHADOW]);
		return response.readUInt16LE(1);
	}

	async getNormalModeRxLevel(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_NORMAL_MODE_RX_LEVEL]);
		const level = response.readInt16LE(1);
		if (level == -1)
			throw new BfbRemoteError(0xFF, 'BFB normal-mode RX level is unavailable.');
		return level;
	}

	async readAfc(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.AFC, 0x02], { responseLength: 3 });
		return response.readUInt16LE(1);
	}

	async getMobileMode(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_MOBILE_MODE], { responseLength: 3 });
		return response.readUInt16LE(1);
	}

	async getDspFirmwareVersion(): Promise<number> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GET_DSP_FIRMWARE_VERSION],
			{ responseLength: 3 },
		);
		return response.readUInt16LE(1);
	}

	async getPowerAsicProject(): Promise<number> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GET_POWER_ASIC_PROJECT],
			{ responseLength: 2 },
		);
		return response[1];
	}

	async getHardwareInfo(selector: number): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_HARDWARE_INFO, selector]);
		if (response[1] != selector)
			throw new Error(`BFB hardware info selector mismatch: ${response[1]} != ${selector}.`);
		return response[2];
	}

	async getPhoneModel(): Promise<string> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_MODEL_INFORMATION], { minResponseLength: 2 });
		return decodeCString(response.subarray(1));
	}

	async getFirmwareVersion(): Promise<number> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_FIRMWARE_VERSION], { minResponseLength: 2 });
		return response[1];
	}

	async getLanguageGroup(): Promise<string> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_LANGUAGE_INFORMATION], { minResponseLength: 2 });
		return decodeCString(response.subarray(1));
	}

	async getIMEI(): Promise<string> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_IMEI], { minResponseLength: 17 });
		return response.subarray(2, 17).toString('ascii');
	}

	async getFlagStatus(): Promise<number> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_FLAG_STATUS], { responseLength: 2 });
		return response[1];
	}

	async getSecurityMode(): Promise<BfbSecurityMode> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.BOOT_PIN_SETTINGS, 0], { responseLength: 2 });
		const mode = response[1];
		switch (mode) {
			case BfbSecurityMode.REPAIR:
			case BfbSecurityMode.DEVELOPER:
			case BfbSecurityMode.FACTORY:
			case BfbSecurityMode.CUSTOMER:
				return mode;
			default:
				throw new Error(`Invalid BFB security mode: ${mode}.`);
		}
	}

	async getSecurityModeName(): Promise<string> {
		const mode = await this.getSecurityMode();
		return BfbSecurityMode[mode] ?? 'UNKNOWN';
	}

	async getBatteryVoltage(): Promise<number> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.GET_BATTERY_VOLTAGE], { responseLength: 3 });
		return response.readUInt16LE(1);
	}

	async getInformationElementList(id: number): Promise<BfbInformationElementList> {
		const response = await this.exec(
			BfbChannel.INFO,
			createInformationElementRequest(0x0F, id),
			{ minResponseLength: 2 },
		);
		const count = response[1];
		if (response.length != 2 + count * 2) {
			throw new Error(
				`Invalid BFB information element list response length: ${response.length}, expected ${2 + count * 2}.`,
			);
		}
		return {
			count,
			elements: Array.from({ length: count }, (_value, index) => response.readUInt16LE(2 + index * 2)),
		};
	}

	async getSingleInformationElement(id: number): Promise<number | undefined> {
		const response = await this.exec(BfbChannel.INFO, createInformationElementRequest(0, id), { minResponseLength: 2 });
		if (response[1] == 0)
			return undefined;
		if (response.length < 4)
			throw new Error(`Invalid BFB information element response length: ${response.length}.`);
		return response.readUInt16LE(2);
	}

	async requestBootPinSetting(): Promise<number> {
		const response = await this.exec(BfbChannel.INFO, [BfbInfoOpcode.BOOT_PIN_SETTINGS, 0], { minResponseLength: 2 });
		return response[1];
	}

	async sendRemoteControl(command: string, timeout = 5000): Promise<Buffer> {
		const payload = encodeRemoteControlCommand(command);
		return this.withFrameQueue(BfbChannel.AT, async () => {
			await this.sendFrame(BfbChannel.AT, payload);
			const deadline = Date.now() + timeout;
			const chunks: Buffer[] = [];
			while (true) {
				try {
					const frame = await this.receiveBfbFrame(BfbChannel.AT, 0, deadline);
					chunks.push(frame.data);
					const response = Buffer.concat(chunks);
					if (isTerminalAtResponse(response))
						return response;
				} catch (error) {
					if (!(error instanceof BfbCommandTimeoutError))
						throw error;
					if (chunks.length)
						return Buffer.concat(chunks);
					throw new BfbUnsupportedCommandError(BfbChannel.AT, BfbAtOpcode.REMOTE_CONTROL);
				}
			}
		});
	}

	async sendSecurityString(value: string, timeout = 5000): Promise<BfbSecurityStringResponse> {
		const payload = encodeSecurityString(value);
		return this.withFrameQueue(BfbChannel.SECURITY, async () => {
			await this.sendFrame(BfbChannel.SECURITY, payload);
			const deadline = Date.now() + timeout;
			const frame = await this.receiveBfbFrame(BfbChannel.SECURITY, 0, deadline);
			if (frame.data.length != 2 || frame.data[0] != 0x57)
				return { response: Buffer.from(frame.data) };
			const response = await this.receiveBfbFrame(BfbChannel.SECURITY, 0, deadline);
			return {
				response: Buffer.from(response.data),
				delay: frame.data[1],
			};
		});
	}

	async freezeSecurityData(imei: string): Promise<number> {
		if (!imei.match(/^\d{15}$/))
			throw new Error('IMEI must contain exactly 15 decimal digits.');
		const response = await this.execEep(Buffer.concat([
			Buffer.from([BfbEepOpcode.FREEZE_SECURITY_DATA]),
			Buffer.from(imei, 'ascii'),
		]), { responseLength: 3 });
		return response.readUInt16LE(1);
	}

	async simulateChipCard(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SIMULATE_CHIP_CARD]);
	}

	async pressKey(keyCode: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.PRESS_KEY, keyCode]);
	}

	async updateDisplay(x: number, y: number, width: number, height: number): Promise<void> {
		const request = Buffer.alloc(9);
		request.writeUInt8(BfbHardwareOpcode.UPDATE_DISPLAY, 0);
		request.writeUInt16LE(x, 1);
		request.writeUInt16LE(y, 3);
		request.writeUInt16LE(width, 5);
		request.writeUInt16LE(height, 7);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async redirectKeypad(callback: (data: Buffer) => void): Promise<void> {
		this.registerFrameHandler('keypad', {
			channel: BfbChannel.HARDWARE,
			opcode: BfbHardwareOpcode.KEYPAD_EVENT,
			handle: (frame) => {
				callback(Buffer.from(frame.data.subarray(1)));
			},
		});
		try {
			await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.REDIRECT_KEYPAD]);
		} catch (error) {
			this.unregisterFrameHandler('keypad');
			throw error;
		}
	}

	async restoreKeypad(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.RESTORE_KEYPAD]);
		this.unregisterFrameHandler('keypad');
	}

	async redirectDisplay(callback: (event: BfbDisplayEvent) => void, mode?: BfbDisplayRedirectMode): Promise<void> {
		const redirectMode = mode ?? BfbDisplayRedirectMode.RECT;
		this.registerFrameHandler('display', {
			channel: BfbChannel.HARDWARE,
			opcode: BfbHardwareOpcode.DISPLAY_EVENT,
			handle: (frame) => {
				if (frame.data.length != 5 && frame.data.length != 11) {
					debug(`Ignored invalid BFB display event: ${frame.data.toString('hex')}`);
					return;
				}

				const left = frame.data[1];
				const top = frame.data[2];
				let right = frame.data[3];
				let bottom = frame.data[4];
				const rawRect = redirectMode == BfbDisplayRedirectMode.RAW_RECT ||
					redirectMode == BfbDisplayRedirectMode.RAW_RECT_WITH_ADDRESS;
				if (rawRect) {
					right = left + right - 1;
					bottom = top + bottom - 1;
				}
				const event: BfbDisplayEvent = { left, top, right, bottom };
				if (frame.data.length == 11) {
					event.bufferAddress = frame.data.readUInt32LE(5);
					event.bytesPerPixel = frame.data.readUInt16LE(9);
				}
				callback(event);
			},
		});
		try {
			const request: number[] = [BfbHardwareOpcode.REDIRECT_DISPLAY];
			if (mode !== undefined)
				request.push(mode);
			await this.exec(BfbChannel.HARDWARE, request);
		} catch (error) {
			this.unregisterFrameHandler('display');
			throw error;
		}
	}

	async restoreDisplay(): Promise<void> {
		try {
			await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.RESTORE_DISPLAY]);
		} finally {
			this.unregisterFrameHandler('display');
		}
	}

	async playTone(frequency: number, duration: number, option = 0): Promise<void> {
		const request = Buffer.alloc(6);
		request.writeUInt8(BfbHardwareOpcode.PLAY_TONE, 0);
		request.writeUInt16LE(frequency, 1);
		request.writeUInt16LE(duration, 3);
		request.writeUInt8(option, 5);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async stopTone(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.STOP_TONE]);
	}

	async bootDsp(address: number): Promise<void> {
		const request = Buffer.alloc(5);
		request.writeUInt8(BfbHardwareOpcode.BOOT_DSP, 0);
		request.writeUInt32LE(address, 1);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async sendDspCommand(words: number[]): Promise<Buffer> {
		if (words.length > 14)
			throw new Error('BFB DSP command must contain at most 14 words.');
		const request = Buffer.alloc(3 + words.length * 2);
		request.writeUInt8(BfbHardwareOpcode.SEND_DSP_COMMAND, 0);
		request.writeUInt16LE(words.length, 1);
		for (let index = 0; index < words.length; index++) {
			request.writeUInt16LE(words[index], 3 + index * 2);
		}
		const response = await this.exec(BfbChannel.HARDWARE, request);
		return Buffer.from(response.subarray(1));
	}

	async setRxTxChannel(arfcn: number, control: number): Promise<void> {
		await this.setRfChannel(BfbHardwareOpcode.SET_RX_TX_CHANNEL, arfcn, control);
	}

	async setMonitorChannel(arfcn: number, control: number): Promise<void> {
		await this.setRfChannel(BfbHardwareOpcode.SET_MONITOR_CHANNEL, arfcn, control);
	}

	async setRampBid(value: number): Promise<void> {
		const request = Buffer.alloc(6);
		request.writeUInt8(BfbHardwareOpcode.SET_RAMP_BID, 0);
		request.writeUInt32LE(value, 1);
		request.writeUInt8(1, 5);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setPowerMode(mode: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_POWER_MODE, mode, 0x01]);
	}

	async setTxPwm(value: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_TX_PWM, value]);
	}

	async setMc45PrechargeRampValue(value: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_TX_PWM, value, 0]);
	}

	async setPaCompensation(value: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_PA_COMPENSATION, value]);
	}

	async setNfScaling(a: number, b: number): Promise<void> {
		const request = Buffer.alloc(5);
		request.writeUInt8(BfbHardwareOpcode.SET_NF_SCALING, 0);
		request.writeUInt16LE(a, 1);
		request.writeUInt16LE(b, 3);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setEnvironmentTemperature(temperature: number): Promise<void> {
		const request = Buffer.alloc(3);
		request.writeUInt8(BfbHardwareOpcode.SET_ENVIRONMENT_TEMPERATURE, 0);
		request.writeUInt16LE(temperature, 1);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setNfControl(enabled: boolean): Promise<void> {
		const opcode = enabled ?
			BfbHardwareOpcode.ACTIVATE_NF_CONTROL :
			BfbHardwareOpcode.DEACTIVATE_NF_CONTROL;
		await this.exec(BfbChannel.HARDWARE, [opcode]);
	}

	async configureNfControl(a: number, b: number, c: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.CONFIGURE_NF_CONTROL, a, b, c]);
	}

	async setDisplayContrast(contrast: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_DISPLAY_CONTRAST, contrast]);
	}

	async controlLight(channel: number, brightness: number, duration = 0): Promise<void> {
		const request = Buffer.alloc(6);
		request.writeUInt8(BfbHardwareOpcode.CONTROL_LIGHT, 0);
		request.writeUInt8(0, 1);
		request.writeUInt8(channel, 2);
		request.writeUInt8(brightness, 3);
		request.writeUInt16LE(duration, 4);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async displayDriverDiagnostic(selector: number, data: number[] = []): Promise<Buffer> {
		const response = await this.exec(BfbChannel.HARDWARE, [
			BfbHardwareOpcode.DISPLAY_DRIVER_DIAGNOSTIC,
			selector,
			...data,
		]);
		return Buffer.from(response.subarray(1));
	}

	async getSensorAddresses(): Promise<BfbSensorAddresses> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.GET_SENSOR_ADDRESSES]);
		return {
			raw: response.readUInt32LE(1),
			calibrated: response.readUInt32LE(5),
		};
	}

	async getRawSensorData(): Promise<Buffer> {
		const addresses = await this.getSensorAddresses();
		return (await this.readMemory(addresses.raw, 14)).buffer;
	}

	async getSensorData(): Promise<BfbSensorData> {
		const addresses = await this.getSensorAddresses();
		const buffer = (await this.readMemory(addresses.calibrated, 12)).buffer;
		const values = Array.from({ length: 6 }, (_value, index) => buffer.readUInt16LE(index * 2));
		return {
			voltages: [values[0] * 0.001, values[1] * 0.001, values[2] * 0.001],
			temperatures: [values[3] * 0.1 - 273, values[4] * 0.1 - 273, values[5] * 0.1 - 273],
		};
	}

	async switchOffDisplay(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SWITCH_OFF_DISPLAY]);
	}

	async speechOff(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SWITCH_SPEECH_OFF]);
	}

	async playToneOv(value: number, option: number): Promise<void> {
		const request = Buffer.alloc(4);
		request.writeUInt8(BfbHardwareOpcode.PLAY_OV_TONE, 0);
		request.writeUInt16LE(value, 1);
		request.writeUInt8(option, 3);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setTimingScenario(scenario: number): Promise<void> {
		const request = Buffer.alloc(5);
		request.writeUInt8(BfbHardwareOpcode.SET_TIMING_SCENARIO, 0);
		request.writeUInt32LE(scenario, 1);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setKeyValueRamp(value: number): Promise<void> {
		const request = Buffer.alloc(4);
		request.writeUInt8(BfbHardwareOpcode.SET_KEY_VALUE_RAMP, 0);
		request.writeUInt16LE(value, 1);
		request.writeUInt8(1, 3);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async setVibra(value: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_VIBRA, value]);
	}

	async setPowerManagement(mode: number, value: number): Promise<void> {
		const request = Buffer.alloc(4);
		request.writeUInt8(BfbHardwareOpcode.SET_POWER_MANAGEMENT, 0);
		request.writeUInt8(mode, 1);
		request.writeUInt16LE(value, 2);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	async noOp(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.NO_OP]);
	}

	async rfMeasurement(command: number, data: number[] = []): Promise<Buffer> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.RF_MEASUREMENT, command, ...data]);
		return Buffer.from(response.subarray(1));
	}

	async updateUiState(value: number): Promise<void> {
		await this.sendFrame(BfbChannel.HARDWARE, [BfbHardwareOpcode.UPDATE_UI_STATE, value]);
	}

	async setResourceValue(resourceId: number, value: number): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_RESOURCE_VALUE, resourceId, value]);
	}

	async clickSchalkeKey(group: number, key: number, option: number): Promise<void> {
		if (!Number.isInteger(group) || group < 0 || group > 3)
			throw new Error('Schalke key group must be in range 0..3.');
		if (!Number.isInteger(key) || key < 0 || key > 0x1F)
			throw new Error('Schalke key must be in range 0..31.');
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.CLICK_SCHALKE_KEY, group << 5 | key, option]);
	}

	async testLumberg(): Promise<number> {
		const response = await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.TEST_LUMBERG], { minResponseLength: 2 });
		return response[1];
	}

	async setCpuSpeed(speed: number): Promise<number> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.SET_CPU_SPEED, speed],
			{ responseLength: 2 },
		);
		return response[1];
	}

	async switchSmiToNormal(): Promise<void> {
		await this.sendFrame(BfbChannel.HARDWARE, [BfbHardwareOpcode.SWITCH_SMI_TO_NORMAL]);
	}

	async resetGprsBlerCounters(): Promise<void> {
		await this.exec(BfbChannel.HARDWARE, [BfbHardwareOpcode.RESET_GPRS_BLER_COUNTERS]);
	}

	async activateBluetoothMapper(): Promise<void> {
		await this.setBluetoothMapper(true);
	}

	async setBluetoothMapper(enabled: boolean): Promise<void> {
		await this.sendFrame(BfbChannel.HARDWARE, [BfbHardwareOpcode.SET_BLUETOOTH_MAPPER, enabled ? 0x01 : 0x02]);
	}

	async setRxTxBandChannel(band: number, arfcn: number, control: number, mode: number): Promise<void> {
		await this.setRfBandChannel(BfbHardwareOpcode.SET_RX_TX_BAND_CHANNEL, band, arfcn, control, mode);
	}

	async setMonitorBandChannel(band: number, arfcn: number, control: number, mode: number): Promise<void> {
		await this.setRfBandChannel(BfbHardwareOpcode.SET_MONITOR_BAND_CHANNEL, band, arfcn, control, mode);
	}

	async setAfc(value: number): Promise<void> {
		const request = Buffer.alloc(4);
		request.writeUInt8(BfbHardwareOpcode.AFC, 0);
		request.writeUInt8(0, 1);
		request.writeUInt16LE(value, 2);
		const response = await this.exec(BfbChannel.HARDWARE, request, { responseLength: 2 });
		if (response[1] != 0)
			throw new BfbRemoteError(response[1], sprintf('BFB set AFC failed: 0x%02X', response[1]));
	}

	async generateDisplayPattern(pattern: number): Promise<void> {
		const response = await this.exec(
			BfbChannel.HARDWARE,
			[BfbHardwareOpcode.GENERATE_DISPLAY_PATTERN, pattern],
			{ responseLength: 2 },
		);
		if (response[1] != pattern)
			throw new Error(`BFB display pattern echo mismatch: ${response[1]} != ${pattern}.`);
	}

	async allocateGbsMemory(size: number): Promise<number> {
		const request = Buffer.alloc(3);
		request.writeUInt8(BfbGbsOpcode.ALLOCATE, 0);
		request.writeUInt16LE(size, 1);
		const response = await this.exec(BfbChannel.GBS, request);
		return response.readUInt32LE(1);
	}

	async freeGbsMemory(address: number): Promise<void> {
		const request = Buffer.alloc(5);
		request.writeUInt8(BfbGbsOpcode.FREE, 0);
		request.writeUInt32LE(address, 1);
		await this.exec(BfbChannel.GBS, request);
	}

	async powerOff(): Promise<void> {
		await this.execSessionEndingCommand(BfbChannel.INFO, [BfbInfoOpcode.POWER_OFF]);
	}

	async enterSoftwareUpdate(baudRate: number): Promise<void> {
		const request = Buffer.alloc(6);
		request.writeUInt8(BfbInfoOpcode.ENTER_SOFTWARE_UPDATE, 0);
		request.writeUInt8(0, 1);
		request.writeUInt32LE(baudRate, 2);
		await this.sendFrame(BfbChannel.INFO, request);
		await this.disconnect();
	}

	async sendServiceStream(data: Buffer): Promise<void> {
		if (!data.length)
			await this.sendFrame(BfbChannel.SERVICE_STREAM, data);
		for (let offset = 0; offset < data.length; offset += BFB_MAX_PAYLOAD_SIZE)
			await this.sendFrame(BfbChannel.SERVICE_STREAM, data.subarray(offset, offset + BFB_MAX_PAYLOAD_SIZE));
	}

	async sendServiceStreamTerminator(terminator: Buffer): Promise<void> {
		if (terminator.length != 2)
			throw new Error('BFB service-stream terminator must contain exactly two bytes.');
		await this.sendFrame(BfbChannel.SERVICE_STREAM, terminator);
	}

	async getEepBlockInfo(blockId: number): Promise<BfbEepBlockInfo> {
		const storage = getEepStorage(blockId);
		const opcode = storage == 'eefull' ? BfbEepOpcode.GET_EEFULL_BLOCK_INFO : BfbEepOpcode.GET_EELITE_BLOCK_INFO;
		const request = Buffer.alloc(3);
		request.writeUInt8(opcode, 0);
		request.writeUInt16LE(blockId, 1);
		const response = await this.execEep(request, { responseLength: 4 });
		return {
			id: blockId,
			size: response.readUInt16LE(1),
			version: response[3],
		};
	}

	async createEepBlock(blockId: number, size: number, version: number): Promise<void> {
		const storage = getEepStorage(blockId);
		const request = Buffer.alloc(6);
		request.writeUInt8(storage == 'eefull' ? BfbEepOpcode.CREATE_EEFULL_BLOCK : BfbEepOpcode.CREATE_EELITE_BLOCK, 0);
		request.writeUInt16LE(blockId, 1);
		request.writeUInt16LE(size, 3);
		request.writeUInt8(version, 5);
		await this.execEepAck(request, {
			allowWait: true,
			refreshTimeoutOnWait: true,
		});
	}

	async writeEepBlockChunk(blockId: number, offset: number, data: Buffer): Promise<void> {
		const storage = getEepStorage(blockId);
		if (data.length > BFB_EEP_MAX_WRITE_CHUNK)
			throw new Error(`BFB EEPROM write chunk is too large: ${data.length} > ${BFB_EEP_MAX_WRITE_CHUNK}.`);
		const request = Buffer.alloc(5 + data.length);
		request.writeUInt8(storage == 'eefull' ? BfbEepOpcode.WRITE_EEFULL_BLOCK : BfbEepOpcode.WRITE_EELITE_BLOCK, 0);
		request.writeUInt16LE(blockId, 1);
		request.writeUInt16LE(offset, 3);
		data.copy(request, 5);
		await this.execEepAck(request, {
			allowWait: true,
			refreshTimeoutOnWait: true,
		});
	}

	async finishEepBlock(blockId: number): Promise<void> {
		const storage = getEepStorage(blockId);
		const request = Buffer.alloc(3);
		request.writeUInt8(storage == 'eefull' ? BfbEepOpcode.FINISH_EEFULL_BLOCK : BfbEepOpcode.FINISH_EELITE_BLOCK, 0);
		request.writeUInt16LE(blockId, 1);
		await this.execEepAck(request);
	}

	async readEepBlockChunk(blockId: number, offset: number, length: number): Promise<Buffer> {
		const storage = getEepStorage(blockId);
		if (!Number.isInteger(length) || length < 0 || length > BFB_EEP_READ_CHUNK)
			throw new Error(`BFB EEPROM read chunk length must be in range 0..${BFB_EEP_READ_CHUNK}.`);
		const request = Buffer.alloc(7);
		request.writeUInt8(storage == 'eefull' ? BfbEepOpcode.READ_EEFULL_BLOCK : BfbEepOpcode.READ_EELITE_BLOCK, 0);
		request.writeUInt16LE(blockId, 1);
		request.writeUInt16LE(offset, 3);
		request.writeUInt16LE(length, 5);
		const response = await this.execEep(request, { responseLength: length + 1 });
		return Buffer.from(response.subarray(1));
	}

	async readEepBlock(blockId: number, offset = 0, length?: number): Promise<Buffer> {
		const info = await this.getEepBlockInfo(blockId);
		if (!Number.isInteger(offset) || offset < 0 || offset > info.size)
			throw new Error(`Invalid EEPROM block offset: ${offset}.`);
		length ??= info.size - offset;
		if (!Number.isInteger(length) || length < 0 || offset + length > info.size)
			throw new Error(`Invalid EEPROM block range: offset=${offset}, length=${length}, size=${info.size}.`);

		const result = Buffer.alloc(length);
		for (let cursor = 0; cursor < length; cursor += BFB_EEP_READ_CHUNK) {
			const chunkSize = Math.min(length - cursor, BFB_EEP_READ_CHUNK);
			const chunk = await this.readEepBlockChunk(blockId, offset + cursor, chunkSize);
			chunk.copy(result, cursor);
		}
		return result;
	}

	async writeEepBlock(blockId: number, data: Buffer, version = 0): Promise<void> {
		await this.createEepBlock(blockId, data.length, version);

		if (!data.length)
			await this.writeEepBlockChunk(blockId, 0, data);
		for (let offset = 0; offset < data.length; offset += BFB_EEP_WRITE_CHUNK)
			await this.writeEepBlockChunk(blockId, offset, data.subarray(offset, offset + BFB_EEP_WRITE_CHUNK));

		await this.finishEepBlock(blockId);
	}

	async writeEefullBlockRangeChunk(blockId: number, offset: number, data: Buffer): Promise<void> {
		if (data.length > BFB_EEP_MAX_WRITE_CHUNK)
			throw new Error(`BFB EEFULL range-write chunk is too large: ${data.length} > ${BFB_EEP_MAX_WRITE_CHUNK}.`);
		const request = Buffer.alloc(5 + data.length);
		request.writeUInt8(BfbEepOpcode.WRITE_EEFULL_RANGE, 0);
		request.writeUInt16LE(blockId, 1);
		request.writeUInt16LE(offset, 3);
		data.copy(request, 5);
		await this.execEepAck(request, {
			allowWait: true,
			refreshTimeoutOnWait: true,
		});
	}

	async writeEepBlockRange(blockId: number, offset: number, data: Buffer): Promise<void> {

		const info = await this.getEepBlockInfo(blockId);
		if (offset + data.length > info.size)
			throw new Error(`Invalid EEPROM block range: offset=${offset}, length=${data.length}, size=${info.size}.`);

		if (!data.length)
			await this.writeEefullBlockRangeChunk(blockId, offset, data);
		for (let cursor = 0; cursor < data.length; cursor += BFB_EEP_WRITE_CHUNK)
			await this.writeEefullBlockRangeChunk(blockId, offset + cursor, data.subarray(cursor, cursor + BFB_EEP_WRITE_CHUNK));
	}

	async deleteEepBlock(blockId: number): Promise<void> {
		const storage = getEepStorage(blockId);
		const opcode = storage == 'eefull' ?
			BfbEepOpcode.DELETE_EEFULL_BLOCK :
			BfbEepOpcode.DELETE_EELITE_BLOCK;
		const request = Buffer.alloc(3);
		request.writeUInt8(opcode, 0);
		request.writeUInt16LE(blockId, 1);
		await this.execEepAck(request);
	}

	async deleteEepInstance(instance: number): Promise<void> {
		const response = await this.execEep(Buffer.from([BfbEepOpcode.DELETE_INSTANCE, instance]), { responseLength: 2 });
		if (response[1] != instance)
			throw new Error(`BFB EEPROM instance mismatch: ${response[1]} != ${instance}.`);
	}

	async getEepMaxBlockId(storage: BfbEepStorage): Promise<number> {
		const opcode = storage == 'eefull' ? BfbEepOpcode.GET_EEFULL_MAX_BLOCK_ID : BfbEepOpcode.GET_EELITE_MAX_BLOCK_ID;
		const response = await this.execEep(Buffer.from([opcode]), { responseLength: 3 });
		return response.readUInt16LE(1);
	}

	async getEepSpaceInfo(storage: BfbEepStorage): Promise<BfbEepSpaceInfo> {
		const opcode = storage == 'eefull' ? BfbEepOpcode.GET_EEFULL_SPACE_INFO : BfbEepOpcode.GET_EELITE_SPACE_INFO;
		const response = await this.execEep(Buffer.from([opcode]), { responseLength: 13 });
		return {
			freeBlocks: response.readUInt32LE(1),
			freeAddressSpace: response.readUInt32LE(5),
			freeDataSpace: response.readUInt32LE(9),
		};
	}

	async garbageCollectEefull(): Promise<void> {
		await this.execEepAck(Buffer.from([BfbEepOpcode.GARBAGE_COLLECT_EEFULL]), {
			timeout: 6000,
			allowWait: true,
			refreshTimeoutOnWait: true,
		});
	}

	private async execSessionEndingCommand(channel: number, payload: Buffer | number[]): Promise<void> {
		const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
		await this.withFrameQueue(channel, async () => {
			await this.sendFrame(channel, data);
			try {
				await this.receiveBfbFrame(channel, data[0] ?? 0, Date.now() + 1000);
			} catch (error) {
				if (!(error instanceof BfbCommandTimeoutError) && this.mode == BfbTransportMode.BFB)
					throw error;
			} finally {
				this.handleSerialClose();
			}
		});
	}

	private async setRfChannel(opcode: number, arfcn: number, control: number): Promise<void> {
		const request = Buffer.alloc(5);
		request.writeUInt8(opcode, 0);
		request.writeUInt16LE(arfcn, 1);
		request.writeUInt8(control, 3);
		request.writeUInt8(1, 4);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	private async setRfBandChannel(
		opcode: number,
		band: number,
		arfcn: number,
		control: number,
		mode: number,
	): Promise<void> {
		const request = Buffer.alloc(7);
		request.writeUInt8(opcode, 0);
		request.writeUInt8(band, 1);
		request.writeUInt16LE(arfcn, 2);
		request.writeUInt8(control, 4);
		request.writeUInt8(mode, 5);
		request.writeUInt8(1, 6);
		await this.exec(BfbChannel.HARDWARE, request);
	}

	private async execEep(request: Buffer, options: BfbEepExecOptions = {}): Promise<Buffer> {
		const opcode = request[0];
		const validOptions = {
			timeout: 5000,
			allowWait: false,
			refreshTimeoutOnWait: false,
			...options,
		};
		return this.withFrameQueue(BfbChannel.EEPROM, async () => {
			await this.sendFrame(BfbChannel.EEPROM, appendBfbPayloadXor(request));
			let deadline = Date.now() + validOptions.timeout;
			while (true) {
				const frame = await this.receiveBfbFrame(BfbChannel.EEPROM, 0, deadline);
				if (!checkBfbPayloadXor(frame.data))
					throw new Error('Invalid BFB EEPROM payload checksum.');

				const response = frame.data.subarray(0, frame.data.length - 1);
				if (validOptions.allowWait && response.length == 1 && response[0] == 0x50) {
					if (validOptions.refreshTimeoutOnWait)
						deadline = Date.now() + validOptions.timeout;
					continue;
				}
				if (response[0] != opcode) {
					const status = response[0] ?? 0;
					throw new BfbRemoteError(status, BFB_EEP_STATUS[status]);
				}
				if (validOptions.responseLength !== undefined && validOptions.responseLength > 1 && response.length == 1)
					throw new BfbUnsupportedCommandError(BfbChannel.EEPROM, opcode);
				if (validOptions.responseLength !== undefined && response.length != validOptions.responseLength) {
					throw new Error(
						`Invalid BFB EEPROM response length: ${response.length}, expected ${validOptions.responseLength}.`,
					);
				}
				return response;
			}
		});
	}

	private async execEepAck(request: Buffer, options: BfbEepExecOptions = {}): Promise<void> {
		await this.execEep(request, { ...options, responseLength: 1 });
	}

}

export function encodeBfbFrame(channel: number, payload: Buffer | number[]): Buffer {
	if (!Number.isInteger(channel) || channel < 0 || channel > 0xFF)
		throw new Error(`Invalid BFB channel: ${channel}`);

	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	if (data.length > BFB_MAX_PAYLOAD_SIZE)
		throw new Error(`BFB payload length must be in range 0..${BFB_MAX_PAYLOAD_SIZE}.`);

	return Buffer.concat([
		Buffer.from([channel, data.length, channel ^ data.length]),
		data,
	]);
}

export function appendBfbPayloadXor(payload: Buffer | number[]): Buffer {
	const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
	let checksum = 0;
	for (const byte of data)
		checksum ^= byte;
	return Buffer.concat([data, Buffer.from([checksum])]);
}

export function checkBfbPayloadXor(payload: Buffer): boolean {
	if (!payload.length)
		return false;
	let checksum = 0;
	for (const byte of payload)
		checksum ^= byte;
	return checksum == 0;
}

function getBfbOpcodeName(channel: number, opcode: number): string | undefined {
	switch (channel) {
		case BfbChannel.CONFIGURATION: return BfbConfigurationOpcode[opcode];
		case BfbChannel.CORE: return BfbCoreOpcode[opcode];
		case BfbChannel.HARDWARE: return BfbHardwareOpcode[opcode];
		case BfbChannel.AT: return BfbAtOpcode[opcode];
		case BfbChannel.GBS: return BfbGbsOpcode[opcode];
		case BfbChannel.INFO: return BfbInfoOpcode[opcode];
		case BfbChannel.EEPROM: return BfbEepOpcode[opcode];
	}
}

function getEepStorage(blockId: number): BfbEepStorage {
	return blockId >= 5000 ? 'eefull' : 'eelite';
}

function createInformationElementRequest(mode: number, id: number): Buffer {
	const request = Buffer.alloc(4);
	request.writeUInt8(BfbInfoOpcode.INFORMATION_ELEMENT, 0);
	request.writeUInt8(mode, 1);
	request.writeUInt16LE(id, 2);
	return request;
}

function encodeSecurityString(value: string): Buffer {
	const payload = Buffer.from(value, 'ascii');
	if (payload.includes(0))
		throw new Error('BFB security string must not contain a NUL byte.');
	if (payload.length > BFB_MAX_PAYLOAD_SIZE - 1)
		throw new Error(`BFB security string is too long: ${payload.length} > ${BFB_MAX_PAYLOAD_SIZE - 1}.`);
	return payload;
}

function encodeRemoteControlCommand(command: string): Buffer {
	const data = Buffer.from(command, 'ascii');
	if (data.includes(0))
		throw new Error('BFB remote-control command must not contain a NUL byte.');
	if (data.length > BFB_MAX_PAYLOAD_SIZE - 2)
		throw new Error(`BFB remote-control command is too long: ${data.length} > ${BFB_MAX_PAYLOAD_SIZE - 2}.`);
	return Buffer.concat([Buffer.from([BfbAtOpcode.REMOTE_CONTROL]), data, Buffer.from([0])]);
}

function isTerminalAtResponse(response: Buffer): boolean {
	return /\r\n(OK|ERROR|\+CMS ERROR|\+CME ERROR)[^\r\n]*\r\n$/s.test(response.toString('ascii'));
}

function computeBfbBaudCrc(payload: Buffer): Buffer {
	const packed = Buffer.alloc(Math.ceil(payload.length / 2));
	let mergePackedByte = payload.length % 2 != 0;
	let packedOffset = 0;
	for (const byte of payload) {
		if (mergePackedByte) {
			packed[packedOffset] |= byte;
			packedOffset++;
		} else {
			packed[packedOffset] = byte << 4;
		}
		mergePackedByte = !mergePackedByte;
	}

	const crc = Buffer.alloc(3);
	for (let index = 0; index < crc.length; index++)
		crc[index] = ~packed[index];

	for (let index = crc.length; index < packed.length; index++) {
		const tableValue = getBfbBaudCrcTableValue(crc[0]);
		crc[0] = (tableValue >> 16) ^ crc[1];
		crc[1] = (tableValue >> 8) ^ crc[2];
		crc[2] = tableValue ^ packed[index];
	}
	return crc;
}

function getBfbBaudCrcTableValue(index: number): number {
	const table = [
		0x76A7D6,
		0x5745F6,
		0x1581B7,
		0x910934,
		0x221368,
		0x4426D0,
		0x3347FB,
		0xDD85AD,
	];
	let value = 0;
	for (let bit = 0; bit < table.length; bit++) {
		if (index & (1 << bit))
			value ^= table[bit];
	}
	return value;
}
