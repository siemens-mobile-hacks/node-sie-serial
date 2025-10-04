import { DWD } from "../src/index.js";
import fs from "fs";
import { openPort } from "./utils.js";
import { parseArgs } from "node:util";
import { sprintf } from "sprintf-js";

const { values: argv } = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyACM0"
		},
		help: {
			type: "boolean",
			short: "h",
			default: false
		},
		usage: {
			type: "boolean",
			default: false
		}
	}
});

if (argv.help || argv.usage) {
	console.log(`USAGE: dwd.js --port /dev/ttyACM0`);
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();

const dwd = new DWD(port);

/*
const possibleKeys = await dwd.bruteforceKey2({
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${speed.toFixed(2)} keys/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
const foundKeys: DWDKeys[] = [];
for (const key2 of possibleKeys) {
	console.log(sprintf("Bruteforce key1 for key2=%04X\n", key2));
	const keys = await dwd.bruteforceKey1(key2);
	if (keys != null)
		foundKeys.push(keys);
}
console.log(foundKeys);
*/

dwd.setKeys("auto");
await dwd.connect();

console.log(await dwd.getSWVersion());

for (let i = 0; i < 64; i++) {
	const r = await dwd.readMemory(0xF0000000 + i * 4, 4);

	console.log(sprintf("%08X %08X", 0xF0000000 + i * 4, r.buffer.readUInt32LE(0)));
}
console.log(await dwd.getMemoryRegions());

/*
const abortController = new AbortController();

setTimeout(() => {
//	abortController.abort();
}, 500);

const result = await dwd.readMemory(0xA0000000, 64 * 1024 * 1024, {
	signal: abortController.signal,
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});

console.log(result);

fs.writeFileSync("/tmp/ff.bin", result.buffer);
*/

await dwd.disconnect();

await port.close();
