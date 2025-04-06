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

dwd.setKeys("panasonic");
await dwd.connect();

const result = await dwd.readMemory(0x00000000, 96 * 1024, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
fs.writeFileSync("/tmp/sram.bin", result.buffer);
await dwd.disconnect();

await port.close();
