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
		addr: {
			type: "string"
		},
		size: {
			type: "string"
		},
		out: {
			type: "string"
		},
		key: {
			type: "string",
			default: "panasonic"
		},
		baudrate: {
			type: "string",
			default: "0"
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

const badParams = !argv.size || !argv.addr || !argv.out;
if (badParams || argv.help || argv.usage) {
	console.log(`USAGE: dwd-apoxi-memory-dump.js --port /dev/ttyACM0 --addr 0xB0000000 --size 0x1000000 --out /tmp/ram.bin`);
	process.exit(0);
}

const addr = parseInt(argv.addr!, 16);
const size = parseInt(argv.size!, 16);

console.log(sprintf("Addr: 0x%08X", addr));
console.log(sprintf("Size: 0x%08X (%d Mb)", size, size / 1024 / 1024));

if (isNaN(addr) || isNaN(size)) {
	console.log(`Invalid address or size.`);
	process.exit(1);
}

const port = await openPort(argv.port, 115200);
await port.open();

const dwd = new DWD(port);

dwd.setKeys(argv.key);
await dwd.connect();

const result = await dwd.readMemory(addr, size, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
fs.writeFileSync(argv.out!, result.buffer);

await dwd.disconnect();
await port.close();
