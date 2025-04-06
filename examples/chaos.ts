import { parseArgs } from 'node:util';
import { ChaosLoader } from "../src/index.js";
import { openPort } from "./utils.js";

const argv = parseArgs({
	options: {
		port: {
			type: "string",
			default: "/dev/ttyUSB0"
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

if (argv.values.help || argv.values.usage) {
	console.log(`USAGE: chaos.js --port /dev/ttyUSB0 --boot ServiceMode`);
	process.exit(0);
}

const port = await openPort(argv.values.port, 115200);
await port.open();

const chaos = new ChaosLoader(port);
await chaos.connect();
await chaos.activate();
await chaos.ping();
await chaos.setSpeed(1625000);
await chaos.ping();

// test reading from flash
console.time("readMemory");
const result = await chaos.readMemory(0xA0000000, 1024 * 1024 * 64, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} kB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
console.timeEnd("readMemory");
console.log(result);

/*
// test writing to ram
await chaos.writeMemory(0xA8000000, Buffer.from([ 0xDE, 0xAD, 0xBE, 0xEE, 0xFF ]));
console.log(await chaos.readMemory(0xA8000000, 8));

// test reading from flash
console.log(await chaos.testMemory(0xA0000010, 8));
console.log(await chaos.readMemory(0xA0000010, 8));
*/

await chaos.disconnect();
await port.close();
