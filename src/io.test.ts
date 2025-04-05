import { describe, expect, test } from 'vitest';
import { alignToFlashRegions, findFlashRegion, IoFlashRegion } from './io.js';

describe('findFlashRegion', () => {
	test('should find the correct region when address is within a region', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 },
			{ addr: 0x2000, size: 0x1000, eraseSize: 0x100 },
			{ addr: 0x3000, size: 0x1000, eraseSize: 0x100 }
		];

		// Test address at the start of a region
		expect(findFlashRegion(0x1000, regions)).toEqual(regions[0]);

		// Test address in the middle of a region
		expect(findFlashRegion(0x1500, regions)).toEqual(regions[0]);

		// Test address at the end of a region
		expect(findFlashRegion(0x1FFF, regions)).toEqual(regions[0]);

		// Test with another region
		expect(findFlashRegion(0x2500, regions)).toEqual(regions[1]);
	});

	test('should return undefined when address is not within any region', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 },
			{ addr: 0x3000, size: 0x1000, eraseSize: 0x100 }
		];

		// Test address before any region
		expect(findFlashRegion(0x0500, regions)).toBeUndefined();

		// Test address between regions
		expect(findFlashRegion(0x2500, regions)).toBeUndefined();

		// Test address after all regions
		expect(findFlashRegion(0x4500, regions)).toBeUndefined();
	});
});

describe('alignToFlashRegions', () => {
	test('should correctly align when address and size are within a single region', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 }
		];

		const result = alignToFlashRegions(0x1200, 0x400, regions);

		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			addr: 0x1000,
			size: 0x1000,
			bufferOffset: 0x200,
			bufferSize: 0x400,
			isPartial: true
		});
	});

	test('should correctly align when address and size span multiple regions', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 },
			{ addr: 0x2000, size: 0x1000, eraseSize: 0x100 },
			{ addr: 0x3000, size: 0x1000, eraseSize: 0x100 }
		];

		// 0x1800 is in the first region, and we want to write 0x1800 bytes,
		// which will span into the third region
		const result = alignToFlashRegions(0x1800, 0x1800, regions);

		expect(result).toHaveLength(2);

		// First chunk (partial, from 0x1800 to end of first region)
		expect(result[0]).toEqual({
			addr: 0x1000,
			size: 0x1000,
			bufferOffset: 0x800,
			bufferSize: 0x800,
			isPartial: true
		});

		// Second chunk (full region)
		expect(result[1]).toEqual({
			addr: 0x2000,
			size: 0x1000,
			bufferOffset: 0x0,
			bufferSize: 0x1000,
			isPartial: false
		});
	});

	test('should throw error when address is out of bounds', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 }
		];

		expect(() => alignToFlashRegions(0x500, 0x100, regions)).toThrow(/out of bounds/);
		expect(() => alignToFlashRegions(0x2500, 0x100, regions)).toThrow(/out of bounds/);
	});

	test('should handle edge case when size is zero', () => {
		const regions: IoFlashRegion[] = [
			{ addr: 0x1000, size: 0x1000, eraseSize: 0x100 }
		];

		const result = alignToFlashRegions(0x1500, 0, regions);

		expect(result).toHaveLength(0);
	});
});
