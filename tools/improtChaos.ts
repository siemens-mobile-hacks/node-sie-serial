import fs from "node:fs";
import { sprintf } from "sprintf-js";

const buffer = fs.readFileSync("../../pmb887x-dev/boot/chaos_x85.bin");
const lines: string[] = [];

for (let i = 0; i < buffer.length; i += 16) {
	const chunk = buffer.subarray(i, i + 16);
	let line: string[] = [];
	for (const byte of chunk)
		line.push(sprintf("0x%02X", byte));
	lines.push("\t" + line.join(", ") + ",");
}

let output = "export const CHAOS_BOOT_CODE = Buffer.from([\n";
output += lines.join("\n") + "\n";
output += "]);\n";

fs.writeFileSync("src/chaos.bin.ts", output);
