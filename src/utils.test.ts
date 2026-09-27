import { expect, test } from 'vitest';
import { decodeCString } from './utils.js';

test('decodeCString stops at the first NUL', () => {
	expect(decodeCString(Buffer.from([0, 65]))).toBe('');
	expect(decodeCString(Buffer.from('abc\0tail'))).toBe('abc');
	expect(decodeCString(Buffer.from('abc'))).toBe('abc');
});
