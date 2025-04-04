import { describe, expect, test } from 'vitest';
import { encapsulateDWDtoAT } from "./DWD.js";

describe('escapeBytes', () => {
	test('should correctly escape provided examples', () => {
		const examples = [
			{
				input: "76 00 1E 00 0D 0C 00 A0",
				output: "41 54 23 01 12 76 00 1E 00 0C 0C 00 A0 0D",
			},
			{
				input: "76 00 1E 00 0C 0D 00 A0",
				output: "41 54 23 01 13 76 00 1E 00 0C 0C 00 A0 0D",
			},
			{
				input: "76 00 1E 00 0D 00 00 A0",
				output: "41 54 23 01 12 76 00 1E 00 0C 00 00 A0 0D",
			},
			{
				input: "76 00 1E 00 0C 0C 0D A0",
				output: "41 54 23 01 14 76 00 1E 00 0C 0C 0C A0 0D",
			},
			{
				input: "76 00 1E 00 0D 0D 0C A0",
				output: "41 54 23 02 12 13 76 00 1E 00 0C 0C 0C A0 0D",
			},
			{
				input: "76 00 1E 00 0C 00 0D A0",
				output: "41 54 23 01 14 76 00 1E 00 0C 00 0C A0 0D",
			},
		];
		examples.forEach(({ input, output }) => {
			const inputBuffer = Buffer.from(input.replace(/\s+/g, ""), "hex");
			const outputBuffer = Buffer.from(output.replace(/\s+/g, ""), "hex");
			expect(encapsulateDWDtoAT(inputBuffer)).toEqual(outputBuffer);
		});
	});
});
