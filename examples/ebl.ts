import { parseArgs } from 'node:util';
import { EBL } from '@sie-js/serial';
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
	console.log(`USAGE: ebl.js --port /dev/ttyUSB0`);
	process.exit(0);
}

const port = await openPort(argv.values.port, 115200);
await port.open();

const ebl = new EBL(port);
await ebl.connect();
const info = ebl.getInfo();
console.log(info);

switch (info.mode) {
	case 0xCC:
		console.log("Detected secure mode bootloader! (CC)");
		break;
	case 0xBB:
		console.log("Detected default mode bootloader! (BB)");
		break;
	default:
		console.log("Unknown bootloader mode!!!!");
		break;
}

// const flashInfo = await ebl.getFlashInfo();
// console.log(flashInfo);

// await ebl.selectFlashDriver(flashInfo);

await ebl.setAddress(0xA0000000);

const buffer = await ebl.readFlash(0x800);
console.log(buffer.subarray(0x3C, 0x3C + 4).toString());

await ebl.disconnect();
await port.close();
