import { describe, expect, test } from 'vitest';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { decodeCString, flushInput } from './utils.js';

test('decodeCString stops at the first NUL', () => {
	expect(decodeCString(Buffer.from([0, 65]))).toBe('');
	expect(decodeCString(Buffer.from('abc\0tail'))).toBe('abc');
	expect(decodeCString(Buffer.from('abc'))).toBe('abc');
});

describe('flushInput', () => {
	// e.g. a BFB phone resending its packet faster than the flush timeout
	test('gives up on a line that never goes quiet', async () => {
		const chatty = { read: async () => Buffer.from([0x55]) } as unknown as AsyncSerialPort;
		const started = Date.now();

		await flushInput(chatty, 50, 200);
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
