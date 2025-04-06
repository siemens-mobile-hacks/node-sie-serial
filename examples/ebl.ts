import { parseArgs } from 'node:util';
import { EBL } from "../src/index.js";
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

const ebl = new EBL(port);
await ebl.connect();

await ebl.disconnect();
await port.close();
