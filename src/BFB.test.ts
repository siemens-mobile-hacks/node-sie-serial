import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { openPort } from '../examples/utils.js';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import {
	BFB,
	BFB_BAUD_RATES,
	BFB_MAX_PAYLOAD_SIZE,
	BfbChannel,
	BfbCommandTimeoutError,
	BfbCoreOpcode,
	BfbDisplayDiagnosticSelector,
	BfbHardwareOpcode,
	BfbRemoteError,
	BfbRfMeasurementCommand,
	BfbSecurityMode,
	BfbUnsupportedCommandError,
	encodeBfbFrame,
} from './BFB.js';

const PORT_PATH = process.env.BFB_PORT ?? '/dev/ttyUSB0';
const RAM_START = 0x00000000;
const RAM_SIZE = 0x00200000;
const RAM_PAGE_SIZE = 0x00004000;
const TEST_PATTERN = Buffer.from('BFB RAM WRITE OK', 'ascii');
const EXEC_CODE_TARGET_ADDRESS = 0x0000FFCA;
const EXEC_CODE_TARGET_MASK = 1 << 2;
const CPU_RESOURCE_LEVEL_ADDRESS = 0x00003D0A;
const DISPLAY_CONTRAST_BLOCK_ID = 0x138F;

const describeHardware = process.env.BFB_HARDWARE == '1' ? describe.sequential : describe.skip;
const testUnsafeAction = (action: string) => process.env.BFB_UNSAFE_HARDWARE == action ? test : test.skip;
const testDestructiveAction = (action: string) => {
	return process.env.BFB_DESTRUCTIVE_HARDWARE == action ? test : test.skip;
};
const testSessionAction = (action: string) => process.env.BFB_SESSION_HARDWARE == action ? test : test.skip;

test('enforces the DLL BFB payload bounds', () => {
	expect(encodeBfbFrame(BfbChannel.CORE, Buffer.alloc(0))).toEqual(Buffer.from([BfbChannel.CORE, 0, BfbChannel.CORE]));
	expect(encodeBfbFrame(BfbChannel.CORE, Buffer.alloc(BFB_MAX_PAYLOAD_SIZE))).toHaveLength(3 + BFB_MAX_PAYLOAD_SIZE);
	expect(() => encodeBfbFrame(BfbChannel.CORE, Buffer.alloc(BFB_MAX_PAYLOAD_SIZE + 1))).toThrow('range 0..32');
});

test('names unsupported commands by channel and opcode', () => {
	const error = new BfbUnsupportedCommandError(BfbChannel.HARDWARE, BfbHardwareOpcode.GET_HARDWARE_DATA);
	expect(error.message).toContain('GET_HARDWARE_DATA');
});

describeHardware('BFB hardware', () => {
	let port: AsyncSerialPort;
	let bfb: BFB;

	beforeAll(async () => {
		port = await openPort(PORT_PATH, 115200);
		bfb = new BFB(port);
		await port.open();
		await bfb.connect();
	}, 30000);

	afterAll(async () => {
		await bfb?.disconnect();
		if (port?.isOpen)
			await port.close();
	});

	test('connects and responds to core commands', async () => {
		expect(BFB_BAUD_RATES[port.baudRate]).toBeDefined();
		expect(await bfb.ping()).toBe(true);
		expect(await bfb.getDebuggerName()).toMatch(/^SIEMENS Mobile Phones Debugger /);
		expect(await bfb.exec(BfbChannel.CORE, [BfbCoreOpcode.PING])).toEqual(Buffer.from([BfbCoreOpcode.PING, 0xAA]));
	});

	test('sends a raw core frame', async () => {
		await bfb.sendFrame(BfbChannel.CORE, [BfbCoreOpcode.PING]);
		expect(await bfb.getDebuggerName()).toMatch(/^SIEMENS Mobile Phones Debugger /);
		expect(await bfb.ping()).toBe(true);
	});

	test('switches baudrate and restores 115200', async () => {
		try {
			expect(await bfb.setPhoneBaudrate(57600)).toBe(true);
			expect(port.baudRate).toBe(57600);
			expect(await bfb.ping()).toBe(true);
			expect(await bfb.setBestBaudrate(115200)).toBe(true);
		} finally {
			if (port.baudRate != 115200)
				expect(await bfb.setPhoneBaudrate(115200)).toBe(true);
		}
		expect(port.baudRate).toBe(115200);
		expect(await bfb.ping()).toBe(true);
	});

	test('switches host baudrate using DLL wire codes', async () => {
		try {
			for (const baudRate of [230400, 460800]) {
				expect(await bfb.setPhoneBaudrate(baudRate)).toBe(true);
				expect(port.baudRate).toBe(baudRate);
				expect(await bfb.ping()).toBe(true);
			}
		} finally {
			if (port.baudRate != 115200)
				expect(await bfb.setPhoneBaudrate(115200)).toBe(true);
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('reads phone information', async () => {
		expect(await bfb.getPhoneModel()).toBe(process.env.BFB_MODEL ?? 'C60');
		expect(await bfb.getFirmwareVersion()).toBeGreaterThan(0);
		expect(await bfb.getLanguageGroup()).not.toBe('');
		expect(await bfb.getIMEI()).toMatch(/^\d{15}$/);
		expect(await bfb.getFlagStatus()).toBeGreaterThanOrEqual(0);
		expect(await bfb.getHardwareId()).toBeGreaterThan(0);
		expect(await bfb.getFlashSerialNumber()).toBeGreaterThan(0);
		expect(await bfb.getDisplayType()).toBeGreaterThan(0);
		expect(await bfb.getDisplayBufferAddress()).toBeGreaterThan(0);
		expect(await bfb.getGprsBlerCounters()).toEqual({ counterA: expect.any(Number), counterB: expect.any(Number) });
		expect(await bfb.readAfc()).toBeGreaterThanOrEqual(0);
		expect(await bfb.getMobileMode()).toBeGreaterThanOrEqual(0);
		expect(await bfb.getDspFirmwareVersion()).toBeGreaterThanOrEqual(0);
		expect(await bfb.getPowerAsicProject()).toBeGreaterThanOrEqual(0);
		expect(await bfb.getBatteryVoltage()).toBeGreaterThan(0);
		const securityMode = await bfb.getSecurityMode();
		expect(securityMode).toBeGreaterThanOrEqual(BfbSecurityMode.REPAIR);
		expect(securityMode).toBeLessThanOrEqual(BfbSecurityMode.CUSTOMER);
		expect(['REPAIR', 'DEVELOPER', 'FACTORY', 'CUSTOMER']).toContain(await bfb.getSecurityModeName());
	});

	test('reads display size', async () => {
		const size = await bfb.getDisplaySize();
		expect(size.width).toBeGreaterThan(0);
		expect(size.height).toBeGreaterThan(0);
	});

	test('reads display buffer', async () => {
		const display = await bfb.getDisplayBuffer();
		expect(display.bufferAddress).toBeGreaterThan(0);
		expect(display.width).toBeGreaterThan(0);
		expect(display.height).toBeGreaterThan(0);
		expect(display.bpp).toBeGreaterThan(0);
		let expectedType = 'wb';
		if (display.bpp == 2) {
			expectedType = 'argb4444';
		} else if (display.bpp == 1 && await bfb.getPhoneModel() == 'S55') {
			expectedType = 'rgb332';
		}
		expect(display.type).toBe(expectedType);
		const expectedSize = display.type == 'wb' ? Math.floor((display.width + 7) / 8) * display.height :
			display.width * display.height * display.bpp;
		expect(display.buffer).toHaveLength(expectedSize);
	});

	test('runs read-only hardware diagnostics', async () => {
		await bfb.noOp();
		const display = await bfb.displayDriverDiagnostic(BfbDisplayDiagnosticSelector.GET_BYTES_PER_PIXEL);
		expect(display).toHaveLength(2);
		expect(display[1]).toBeGreaterThan(0);
		expect(await bfb.rfMeasurement(BfbRfMeasurementCommand.GET_CHANNEL_MAP)).toHaveLength(16);
	});

	test('reads all hardware info selectors', async () => {
		for (let selector = 0; selector <= 9; selector++)
			expect(await bfb.getHardwareInfo(selector)).toBeGreaterThanOrEqual(0);
	});

	const optionalReaders: [string, () => Promise<unknown>][] = [
		['hardware data', () => bfb.getHardwareData(0)],
		['audio gain shadow', () => bfb.getAudioGainShadow()],
		['normal-mode RX level', () => bfb.getNormalModeRxLevel()],
	];
	test.each(optionalReaders)('reads optional %s or reports unsupported', async (_name, callback) => {
		await expectSupportedOrUnsupported(callback);
	});

	const dllOptionalReaders: [string, () => Promise<unknown>][] = [
		['firmware information', () => bfb.getFirmwareInformation()],
		['IQ mean values', () => bfb.getIqMeanValues(1)],
		['IQ drift values', () => bfb.getIqDriftValues()],
		['information element list', () => bfb.getInformationElementList(0)],
		['single information element', async () => ({ value: await bfb.getSingleInformationElement(0) })],
		['boot PIN settings', () => bfb.requestBootPinSetting()],
		['Lumberg state', () => bfb.testLumberg()],
	];
	test.each(dllOptionalReaders)('reads DLL %s or reports unsupported/no response', async (_name, callback) => {
		await expectSupportedOrNoResponse(callback);
		expect(await bfb.ping()).toBe(true);
	}, 10000);

	testUnsafeAction('power-values')('reads DLL power values', async () => {
		expect((await bfb.getPowerValues(1)).length).toBeGreaterThanOrEqual(2);
		expect(await bfb.ping()).toBe(true);
	}, 10000);

	test('reads memory', async () => {
		const result = await bfb.readMemory(0, 64);
		expect(result.buffer).toHaveLength(64);
		expect(result.canceled).toBe(false);
		expect(result.errors).toBe(0);

		const buffer = Buffer.alloc(40, 0xA5);
		await bfb.readMemoryChunk(0, 31, buffer, 4);
		expect(buffer.subarray(0, 4)).toEqual(Buffer.alloc(4, 0xA5));
		expect(buffer.subarray(4, 35)).toEqual(result.buffer.subarray(0, 31));
	});

	test('reads C166 memory regions', async () => {
		const regions = await bfb.getMemoryRegions();
		expect(regions.some((region) => region.name.startsWith('RAM'))).toBe(true);
		expect(regions.some((region) => region.name.startsWith('FLASH'))).toBe(true);
		expect(regions.reduce((size, region) => size + region.size, 0)).toBe(0x01000000);
	});

	test('reads confirmed AMC modes 1-3 with zero selectors', async () => {
		expect(await bfb.amcAdvanced(1, [0, 0])).toEqual(expect.any(Number));
		expect(await bfb.ping()).toBe(true);
		expect(await bfb.amcAdvanced(2, [0, 0])).toEqual(expect.any(Number));
		expect(await bfb.ping()).toBe(true);

		const address = await bfb.amcAdvanced(3, [0, 0]);
		if (address === undefined)
			throw new Error('BFB AMC mode 3 returned no address.');
		const result = await bfb.readMemory(address, 16);
		expect(result.buffer).toHaveLength(16);
		expect(result.canceled).toBe(false);
		expect(result.errors).toBe(0);
		expect(await bfb.ping()).toBe(true);
	});

	test('reads EELITE and EEFULL', async () => {
		const eeliteMaxBlockId = await bfb.getEepMaxBlockId('eelite');
		const eefullMaxBlockId = await bfb.getEepMaxBlockId('eefull');
		expect(eeliteMaxBlockId).toBeGreaterThan(0);
		expect(eefullMaxBlockId).toBeGreaterThan(0);

		const eeliteSpace = await bfb.getEepSpaceInfo('eelite');
		expect(eeliteSpace.freeBlocks).toBeGreaterThan(0);
		expect(eeliteSpace.freeAddressSpace).toBeGreaterThan(0);
		expect(eeliteSpace.freeDataSpace).toBeGreaterThan(0);
		const eefullSpace = await bfb.getEepSpaceInfo('eefull');
		expect(eefullSpace.freeBlocks).toBeGreaterThan(0);
		expect(eefullSpace.freeAddressSpace).toBeGreaterThan(0);
		expect(eefullSpace.freeDataSpace).toBeGreaterThan(0);

		const info = await bfb.getEepBlockInfo(1);
		const data = await bfb.readEepBlock(1, 0, Math.min(info.size, 16));
		expect(data).toHaveLength(Math.min(info.size, 16));

		let chunkedBlockId: number | undefined;
		let chunkedInfo;
		for (let blockId = 5000; blockId <= eefullMaxBlockId; blockId++) {
			try {
				const info = await bfb.getEepBlockInfo(blockId);
				if (info.size > 30) {
					chunkedBlockId = blockId;
					chunkedInfo = info;
					break;
				}
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
			}
		}
		expect(chunkedBlockId).toBeDefined();
		expect(chunkedInfo).toBeDefined();
		if (chunkedBlockId === undefined || chunkedInfo === undefined)
			throw new Error('No readable EEFULL block larger than 30 bytes.');
		expect(chunkedInfo.size).toBeGreaterThan(30);
		const chunkedLength = Math.min(chunkedInfo.size, 61);
		const chunkedData = await bfb.readEepBlock(chunkedBlockId, 0, chunkedLength);
		expect(chunkedData).toHaveLength(chunkedLength);
		expect(await bfb.readEepBlock(chunkedBlockId, 30, chunkedLength - 30))
			.toEqual(chunkedData.subarray(30));
	}, 60000);

	test('reads sensor data through the DLL command or reports no response', async () => {
		await expectSupportedOrNoResponse(async () => {
			const addresses = await bfb.getSensorAddresses();
			expect(addresses.raw).toBeGreaterThanOrEqual(0);
			expect(addresses.calibrated).toBeGreaterThanOrEqual(0);
			expect(await bfb.getRawSensorData()).toHaveLength(14);
			const data = await bfb.getSensorData();
			expect(data.voltages).toHaveLength(3);
			expect(data.temperatures).toHaveLength(3);
			for (const value of [...data.voltages, ...data.temperatures])
				expect(Number.isFinite(value)).toBe(true);
			return true;
		});
		expect(await bfb.ping()).toBe(true);
	}, 10000);

	test('creates, edits and deletes a free EEFULL block', async () => {
		const maxBlockId = await bfb.getEepMaxBlockId('eefull');
		let blockId: number | undefined;
		for (let candidate = maxBlockId; candidate >= 5000; candidate--) {
			try {
				await bfb.getEepBlockInfo(candidate);
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
				blockId = candidate;
				break;
			}
		}
		expect(blockId).toBeDefined();
		if (blockId === undefined)
			throw new Error('No free EEFULL block id.');

		const initial = Buffer.alloc(64);
		for (let index = 0; index < initial.length; index++)
			initial[index] = 0x40 + index;
		const patch = Buffer.alloc(29);
		for (let index = 0; index < patch.length; index++)
			patch[index] = 0xE0 - index;
		const expected = Buffer.from(initial);
		patch.copy(expected, 17);

		try {
			await expect(bfb.getEepBlockInfo(blockId)).rejects.toMatchObject({ status: 0x32 });
			await bfb.createEepBlock(blockId, initial.length, 0x5A);
			for (let offset = 0; offset < initial.length; offset += 26)
				await bfb.writeEepBlockChunk(blockId, offset, initial.subarray(offset, offset + 26));
			await bfb.finishEepBlock(blockId);
			expect(await bfb.getEepBlockInfo(blockId)).toEqual({
				id: blockId,
				size: initial.length,
				version: 0x5A,
			});
			expect(await bfb.readEepBlock(blockId, 0, initial.length)).toEqual(initial);
			expect(await bfb.readEepBlockChunk(blockId, 0, 30)).toEqual(initial.subarray(0, 30));

			await bfb.writeEefullBlockRangeChunk(blockId, 17, patch.subarray(0, 26));
			await bfb.writeEepBlockRange(blockId, 43, patch.subarray(26));
			expect(await bfb.readEepBlock(blockId, 0, expected.length)).toEqual(expected);
		} finally {
			try {
				await bfb.deleteEepBlock(blockId);
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
			}
		}

		await expect(bfb.getEepBlockInfo(blockId)).rejects.toMatchObject({ status: 0x32 });
	}, 60000);

	test('creates, replaces and deletes a free EELITE block', async () => {
		const maxBlockId = await bfb.getEepMaxBlockId('eelite');
		let blockId: number | undefined;
		for (let candidate = maxBlockId; candidate > 0; candidate--) {
			try {
				await bfb.getEepBlockInfo(candidate);
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
				blockId = candidate;
				break;
			}
		}
		expect(blockId).toBeDefined();
		if (blockId === undefined)
			throw new Error('No free EELITE block id.');

		const initial = Buffer.from('BFB EELITE CREATE TEST', 'ascii');
		const replacement = Buffer.from('BFB EELITE REPLACE TEST', 'ascii');
		try {
			await expect(bfb.getEepBlockInfo(blockId)).rejects.toMatchObject({ status: 0x32 });
			await bfb.writeEepBlock(blockId, initial, 1);
			expect(await bfb.readEepBlock(blockId, 0, initial.length)).toEqual(initial);

			await bfb.writeEepBlock(blockId, replacement, 2);
			expect(await bfb.getEepBlockInfo(blockId)).toEqual({
				id: blockId,
				size: replacement.length,
				version: 2,
			});
			expect(await bfb.readEepBlock(blockId, 0, replacement.length)).toEqual(replacement);
		} finally {
			try {
				await bfb.deleteEepBlock(blockId);
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
			}
		}

		await expect(bfb.getEepBlockInfo(blockId)).rejects.toMatchObject({ status: 0x32 });
	}, 60000);

	test('allocates and frees temporary GBS memory', async () => {
		await expectSupportedOrUnsupported(async () => {
			const address = await bfb.allocateGbsMemory(64);
			expect(address).toBeGreaterThan(0);
			try {
				return address;
			} finally {
				await bfb.freeGbsMemory(address);
			}
		});
	});

	test('executes a remote-control AT query', async () => {
		await expectSupportedOrUnsupported(async () => {
			const response = await bfb.sendRemoteControl('AT^SCID\r', 1000);
			expect(response[0]).toBe(0xF0);
			expect(response.subarray(1).toString('ascii')).toContain('^SCID:');
			return response;
		});
	});

	test('covers RAM write commands and restores the page', async () => {
		const address = await findEmptyRamPage(bfb);
		const original = (await bfb.readMemory(address, 0x50)).buffer;
		expect(original.every((value) => value == 0)).toBe(true);
		for (const length of [1, 31, 32, 64])
			expect((await bfb.readMemory(address, length)).buffer).toEqual(original.subarray(0, length));

		let writeAttempted = false;
		try {
			writeAttempted = true;
			await bfb.writeMemory(address, TEST_PATTERN);
			let readback = (await bfb.readMemory(address, TEST_PATTERN.length)).buffer;
			expect(readback).toEqual(TEST_PATTERN);

			const chunkPattern = Buffer.from('WRITE CHUNK', 'ascii');
			await bfb.writeMemoryChunk(address + 0x20, chunkPattern);
			readback = (await bfb.readMemory(address + 0x20, chunkPattern.length)).buffer;
			expect(readback).toEqual(chunkPattern);

			await bfb.writeMemoryByte(address + 0x40, 0xA5);
			expect((await bfb.readMemory(address + 0x40, 1)).buffer[0]).toBe(0xA5);

			await bfb.writeMemoryWord(address + 0x42, 0x5AA5);
			expect((await bfb.readMemory(address + 0x42, 2)).buffer.readUInt16LE(0)).toBe(0x5AA5);

			for (const length of [1, 25, 26, 80]) {
				const pattern = Buffer.alloc(length, 0x40 + length);
				await bfb.writeMemory(address, pattern);
				expect((await bfb.readMemory(address, length)).buffer).toEqual(pattern);
			}
		} finally {
			if (writeAttempted) {
				await bfb.writeMemory(address, original);
				const restored = (await bfb.readMemory(address, original.length)).buffer;
				expect(restored).toEqual(original);
			}
		}
	}, 60000);

	test('executes and reverses the DLL C166 bit-operation sample', async () => {
		const original = (await bfb.readMemory(EXEC_CODE_TARGET_ADDRESS, 2)).buffer.readUInt16LE(0);
		try {
			await bfb.execCode(Buffer.from([0x2E, 0xE5, 0xDB, 0x00])); // bclr 0xFFCA.2; rets
			const changed = (await bfb.readMemory(EXEC_CODE_TARGET_ADDRESS, 2)).buffer.readUInt16LE(0);
			expect(changed & EXEC_CODE_TARGET_MASK).toBe(0);
		} finally {
			if (original & EXEC_CODE_TARGET_MASK)
				await bfb.execCode(Buffer.from([0x2F, 0xE5, 0xDB, 0x00])); // bset 0xFFCA.2; rets
			const restored = (await bfb.readMemory(EXEC_CODE_TARGET_ADDRESS, 2)).buffer.readUInt16LE(0);
			expect(restored & EXEC_CODE_TARGET_MASK).toBe(original & EXEC_CODE_TARGET_MASK);
		}
	});

	test('redirects, reads and restores the keypad around a key event', async () => {
		let redirected = false;
		let pressed = false;
		const events: Buffer[] = [];
		try {
			await bfb.redirectKeypad((data) => events.push(data));
			redirected = true;
			await bfb.pressKey(0x35);
			pressed = true;
			await vi.waitFor(() => expect(events.some((event) => event.includes(0x35))).toBe(true), { timeout: 1000 });
			await bfb.pressKey(0xB5);
			pressed = false;
		} finally {
			if (pressed)
				await bfb.pressKey(0xB5);
			if (redirected)
				await bfb.restoreKeypad();
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('redirects, updates and restores the display', async () => {
		let redirected = false;
		try {
			await bfb.redirectDisplay(() => {});
			redirected = true;
			await bfb.updateDisplay(0, 0, 101, 80);
		} finally {
			if (redirected)
				await bfb.restoreDisplay();
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('writes and restores the display framebuffer', async () => {
		const address = await bfb.getDisplayBufferAddress();
		let redirected = false;
		let original: Buffer | undefined;
		try {
			await bfb.redirectDisplay(() => {});
			redirected = true;
			original = (await bfb.readMemory(address, 32)).buffer;
			const pattern = Buffer.from(original.map((value) => value ^ 0xFF));
			await bfb.writeMemory(address, pattern);
			expect((await bfb.readMemory(address, pattern.length)).buffer).toEqual(pattern);
			await bfb.updateDisplay(0, 0, 101, 80);
		} finally {
			if (original !== undefined) {
				await bfb.writeMemory(address, original);
				expect((await bfb.readMemory(address, original.length)).buffer).toEqual(original);
				await bfb.updateDisplay(0, 0, 101, 80);
			}
			if (redirected)
				await bfb.restoreDisplay();
		}
		expect(await bfb.ping()).toBe(true);
	}, 30000);

	test('sets and restores display contrast', async () => {
		const original = (await bfb.readEepBlock(DISPLAY_CONTRAST_BLOCK_ID, 0, 2))[0];
		const changed = original == 7 ? 6 : 7;
		try {
			await bfb.setDisplayContrast(changed);
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			await bfb.setDisplayContrast(original);
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('generates display patterns and restores normal content', async () => {
		await bfb.generateDisplayPattern(0);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await bfb.ping()).toBe(true);
		await bfb.generateDisplayPattern(1);
		await new Promise((resolve) => setTimeout(resolve, 100));
		await bfb.updateDisplay(0, 0, 101, 80);
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('switch-off-display')('switches off the display (crashes C60 FW27)', async () => {
		await bfb.switchOffDisplay();
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('light-control')('controls a caller-selected light through the DLL payload form', async () => {
		await bfb.controlLight(
			readRequiredNumberEnv('BFB_LIGHT'),
			readRequiredNumberEnv('BFB_LIGHT_VALUE'),
		);
		expect(await bfb.ping()).toBe(true);
	});

	test('plays and stops a short tone', async () => {
		try {
			await bfb.playTone(800, 100);
			await new Promise((resolve) => setTimeout(resolve, 150));
		} finally {
			await bfb.stopTone();
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('starts and stops vibra', async () => {
		try {
			await bfb.setVibra(1);
			await new Promise((resolve) => setTimeout(resolve, 100));
		} finally {
			await bfb.setVibra(0);
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('writes the current AFC value without changing it', async () => {
		const value = await bfb.readAfc();
		await bfb.setAfc(value);
		expect(await bfb.readAfc()).toBe(value);
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('power-saving')('configures power saving when the original mode is unknown', async () => {
		const mode = 0;
		try {
			await bfb.configurePowerSaving(mode);
		} catch (error) {
			if (!(error instanceof BfbRemoteError) || error.status != 0x13)
				throw error;
		}
		expect(await bfb.ping()).toBe(true);
	});

	testDestructiveAction('reset-gprs-bler')('resets GPRS BLER counters', async () => {
		await bfb.resetGprsBlerCounters();
		expect(await bfb.getGprsBlerCounters()).toEqual({ counterA: 0, counterB: 0 });
		expect(await bfb.ping()).toBe(true);
	});

	test('simulates a chip card', async () => {
		await bfb.simulateChipCard();
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('boot-dsp')('boots DSP at a caller-provided address', async () => {
		await bfb.bootDsp(readRequiredNumberEnv('BFB_DSP_ADDRESS'));
		expect(await bfb.ping()).toBe(true);
	});

	test('sets the current environment temperature without changing it', async () => {
		const before = await bfb.getSensorData();
		const temperature = before.temperatures[0];
		const rawTemperature = Math.round((temperature + 273) / 0.1);
		try {
			await bfb.setEnvironmentTemperature(rawTemperature);
			const after = await bfb.getSensorData();
			expect(after.temperatures[0]).toBeCloseTo(temperature, 5);
		} finally {
			await bfb.setEnvironmentTemperature(rawTemperature);
		}
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('nf-control')('changes NF control without a readable original state', async () => {
		try {
			await bfb.setNfControl(true);
			expect(await bfb.ping()).toBe(true);
		} finally {
			await bfb.setNfControl(false);
		}
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('nf-configure')('configures NF control with caller-provided values', async () => {
		await bfb.configureNfControl(
			readRequiredNumberEnv('BFB_NF_A'),
			readRequiredNumberEnv('BFB_NF_B'),
			readRequiredNumberEnv('BFB_NF_C'),
		);
		expect(await bfb.ping()).toBe(true);
	});

	test('sets the current CPU speed without changing its resource level', async () => {
		const resourceLevel = (await bfb.readMemory(CPU_RESOURCE_LEVEL_ADDRESS, 2)).buffer.readUInt16LE(0);
		expect(resourceLevel).toBeGreaterThanOrEqual(2);
		expect(resourceLevel).toBeLessThanOrEqual(5);
		const speed = resourceLevel - 1;
		try {
			expect(await bfb.setCpuSpeed(speed)).toBe(1);
			expect((await bfb.readMemory(CPU_RESOURCE_LEVEL_ADDRESS, 2)).buffer.readUInt16LE(0)).toBe(resourceLevel);
			expect(await bfb.ping()).toBe(true);
		} finally {
			await bfb.setCpuSpeed(speed);
		}
		expect((await bfb.readMemory(CPU_RESOURCE_LEVEL_ADDRESS, 2)).buffer.readUInt16LE(0)).toBe(resourceLevel);
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('smi-normal')('switches SMI to normal mode', async () => {
		await bfb.switchSmiToNormal();
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('bluetooth-mapper')('changes Bluetooth mapper state without a readable original value', async () => {
		try {
			await bfb.activateBluetoothMapper();
		} finally {
			await bfb.setBluetoothMapper(false);
		}
		expect(await bfb.ping()).toBe(true);
	});

	test('receives a display event while another command runs', async () => {
		const address = await bfb.getDisplayBufferAddress();
		const original = (await bfb.readMemory(address, 1)).buffer;
		const events: { left: number; top: number; right: number; bottom: number }[] = [];
		let redirected = false;
		let changed = false;
		try {
			await bfb.redirectDisplay((event) => events.push(event));
			redirected = true;
			await bfb.writeMemory(address, Buffer.from([original[0] ^ 0xFF]));
			changed = true;
			await bfb.updateDisplay(0, 0, 1, 1);
			await bfb.readMemory(address, 1);
			await vi.waitFor(() => expect(events).toContainEqual({ left: 0, top: 0, right: 0, bottom: 0 }), { timeout: 5000 });
		} finally {
			if (changed) {
				await bfb.writeMemory(address, original);
				await bfb.updateDisplay(0, 0, 1, 1);
			}
			if (redirected)
				await bfb.restoreDisplay();
		}
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('amc')('runs a caller-selected AMC transaction', async () => {
		const mode = readRequiredNumberEnv('BFB_AMC_MODE');
		const result = await bfb.amcAdvanced(mode, readRequiredNumberListEnv('BFB_AMC_DATA'));
		if (mode == 8)
			expect(result).toBeUndefined();
		else
			expect(result).toEqual(expect.any(Number));
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('dsp-command')('runs a caller-provided DSP command', async () => {
		expect(await bfb.sendDspCommand(readRequiredNumberListEnv('BFB_DSP_WORDS'))).toBeInstanceOf(Buffer);
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('rf-channel')('sets caller-provided RF channels', async () => {
		const arfcn = readRequiredNumberEnv('BFB_RF_ARFCN');
		const control = readRequiredNumberEnv('BFB_RF_CONTROL');
		const band = readRequiredNumberEnv('BFB_RF_BAND');
		const mode = readRequiredNumberEnv('BFB_RF_MODE');
		await bfb.setRxTxChannel(arfcn, control);
		await bfb.setMonitorChannel(arfcn, control);
		await bfb.setRxTxBandChannel(band, arfcn, control, mode);
		await bfb.setMonitorBandChannel(band, arfcn, control, mode);
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('rf-calibration')('writes caller-provided RF calibration values', async () => {
		await bfb.setPowerMode(readRequiredNumberEnv('BFB_POWER_MODE'));
		await bfb.setTxPwm(readRequiredNumberEnv('BFB_TX_PWM'));
		await bfb.setMc45PrechargeRampValue(readRequiredNumberEnv('BFB_MC45_PRECHARGE'));
		await bfb.setPaCompensation(readRequiredNumberEnv('BFB_PA_COMPENSATION'));
		await bfb.setNfScaling(
			readRequiredNumberEnv('BFB_NF_SCALING_A'),
			readRequiredNumberEnv('BFB_NF_SCALING_B'),
		);
		await bfb.setTimingScenario(readRequiredNumberEnv('BFB_TIMING_SCENARIO'));
		await bfb.setKeyValueRamp(readRequiredNumberEnv('BFB_KEY_VALUE_RAMP'));
		expect(await bfb.ping()).toBe(true);
	});

	testUnsafeAction('audio-control')('runs caller-selected audio and vibra commands', async () => {
		try {
			await bfb.playToneOv(
				readRequiredNumberEnv('BFB_TONE_OV_VALUE'),
				readRequiredNumberEnv('BFB_TONE_OV_OPTION'),
			);
			await bfb.setVibra(readRequiredNumberEnv('BFB_VIBRA_VALUE'));
			await bfb.setPowerManagement(
				readRequiredNumberEnv('BFB_POWER_MANAGEMENT_MODE'),
				readRequiredNumberEnv('BFB_POWER_MANAGEMENT_VALUE'),
			);
			await bfb.clickSchalkeKey(
				readRequiredNumberEnv('BFB_SCHALKE_GROUP'),
				readRequiredNumberEnv('BFB_SCHALKE_KEY'),
				readRequiredNumberEnv('BFB_SCHALKE_OPTION'),
			);
			await bfb.speechOff();
		} finally {
			await bfb.setVibra(0);
			await bfb.stopTone();
		}
		expect(await bfb.ping()).toBe(true);
	});

	testDestructiveAction('ramp-bid')('writes a caller-provided ramp BID', async () => {
		await bfb.setRampBid(readRequiredNumberEnv('BFB_RAMP_BID'));
		expect(await bfb.ping()).toBe(true);
	});

	testDestructiveAction('service-stream')('sends caller-provided raw service-stream forms', async () => {
		const chunk = readRequiredHexEnv('BFB_SERVICE_STREAM_CHUNK');
		await bfb.sendServiceStream(chunk);
		await bfb.sendServiceStreamTerminator(readRequiredHexEnv('BFB_SERVICE_STREAM_TERMINATOR'));
		expect(await bfb.ping()).toBe(true);
	});

	testDestructiveAction('security-string')('sends a caller-provided security string', async () => {
		const value = process.env.BFB_SECURITY_STRING;
		if (value === undefined)
			throw new Error('BFB_SECURITY_STRING is required.');
		expect((await bfb.sendSecurityString(value)).response).toBeInstanceOf(Buffer);
	});

	testDestructiveAction('security-delay')('collects security completion and delay frames', async () => {
		const value = process.env.BFB_SECURITY_DELAY_STRING;
		if (value === undefined)
			throw new Error('BFB_SECURITY_DELAY_STRING is required.');
		const result = await bfb.sendSecurityString(value);
		expect(result.response).toBeInstanceOf(Buffer);
		expect(result.delay).toBeGreaterThanOrEqual(0);
		expect(result.delay).toBeLessThanOrEqual(0xFF);
	});

	testDestructiveAction('freeze-security')('freezes security data for a caller-provided IMEI', async () => {
		const imei = process.env.BFB_FREEZE_IMEI;
		if (imei === undefined)
			throw new Error('BFB_FREEZE_IMEI is required.');
		expect(await bfb.freezeSecurityData(imei)).toEqual(expect.any(Number));
	});

	testDestructiveAction('delete-eep-instance')('deletes a caller-selected EEPROM instance', async () => {
		await bfb.deleteEepInstance(readRequiredNumberEnv('BFB_EEP_INSTANCE'));
	});

	testDestructiveAction('garbage-collect-eefull')('forces EEFULL garbage collection', async () => {
		const maxBlockId = await bfb.getEepMaxBlockId('eefull');
		let blockId: number | undefined;
		let info;
		for (let candidate = 5000; candidate <= maxBlockId; candidate++) {
			try {
				info = await bfb.getEepBlockInfo(candidate);
				blockId = candidate;
				break;
			} catch (error) {
				if (!(error instanceof BfbRemoteError) || error.status != 0x32)
					throw error;
			}
		}
		expect(blockId).toBeDefined();
		expect(info).toBeDefined();
		if (blockId === undefined || info === undefined)
			throw new Error('No existing EEFULL block available for garbage-collection verification.');
		const data = await bfb.readEepBlock(blockId, 0, info.size);
		await bfb.garbageCollectEefull();
		expect(await bfb.getEepBlockInfo(blockId)).toEqual(info);
		expect(await bfb.readEepBlock(blockId, 0, info.size)).toEqual(data);
		expect(await bfb.ping()).toBe(true);
	}, 60000);

	test('disconnects and reconnects without closing the port', async () => {
		await bfb.disconnect();
		await bfb.connect();
		expect(BFB_BAUD_RATES[port.baudRate]).toBeDefined();
		expect(await bfb.ping()).toBe(true);
	}, 30000);

	testSessionAction('power-off')('powers off the phone and ends the session', async () => {
		await bfb.powerOff();
		expect(port.isOpen).toBe(true);
	});

	testSessionAction('software-update')('enters software-update mode and ends the session', async () => {
		await bfb.enterSoftwareUpdate(readRequiredNumberEnv('BFB_SOFTWARE_UPDATE_BAUD_RATE'));
		expect(port.isOpen).toBe(true);
	});

});

async function findEmptyRamPage(bfb: BFB): Promise<number> {
	for (let address = RAM_START + RAM_SIZE - RAM_PAGE_SIZE; address >= RAM_START; address -= RAM_PAGE_SIZE) {
		const sample = (await bfb.readMemory(address, 31)).buffer;
		if (!sample.every((value) => value == 0))
			continue;

		const page = (await bfb.readMemory(address, RAM_PAGE_SIZE)).buffer;
		if (page.every((value) => value == 0))
			return address;
	}

	throw new Error('No empty 16-KiB RAM page found.');
}

async function expectSupportedOrUnsupported(callback: () => Promise<unknown>): Promise<void> {
	try {
		expect(await callback()).toBeDefined();
	} catch (error) {
		if (error instanceof BfbUnsupportedCommandError)
			return;
		throw error;
	}
}

async function expectSupportedOrNoResponse(callback: () => Promise<unknown>): Promise<void> {
	try {
		await callback();
	} catch (error) {
		if (error instanceof BfbUnsupportedCommandError || error instanceof BfbCommandTimeoutError)
			return;
		throw error;
	}
}

function readRequiredNumberEnv(name: string): number {
	const value = process.env[name];
	if (value === undefined)
		throw new Error(`${name} is required.`);
	const number = Number(value);
	if (!Number.isInteger(number))
		throw new Error(`${name} must be an integer.`);
	return number;
}

function readRequiredHexEnv(name: string): Buffer {
	const value = process.env[name];
	if (value === undefined)
		throw new Error(`${name} is required.`);
	if (!value.match(/^(?:[0-9a-fA-F]{2})*$/))
		throw new Error(`${name} must contain an even-length hexadecimal string.`);
	return Buffer.from(value, 'hex');
}

function readRequiredNumberListEnv(name: string): number[] {
	const value = process.env[name];
	if (value === undefined)
		throw new Error(`${name} is required.`);
	if (value == '')
		return [];
	return value.split(',').map((item) => {
		const number = Number(item);
		if (!Number.isInteger(number))
			throw new Error(`${name} must contain comma-separated integers.`);
		return number;
	});
}
