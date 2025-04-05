import fs from 'fs';
import { parseArgs } from 'node:util';
import { loadBootCode } from "../src/index.js";
import { openPort } from "./utils.js";

const SPECIAL_BOOTS: Record<string, Buffer> = {
	BurninMode: Buffer.from(
		"F104A0E3201090E5FF10C1E3A51081E3" +
		"201080E51EFF2FE10401080000000000" +
		"00000000000000005349454D454E535F" +
		"424F4F54434F44450100070000000000" +
		"00000000000000000000000000000000" +
		"01040580830003",
		"hex"
	),
	ServiceMode: Buffer.from(
		"F104A0E3201090E5FF10C1E3A51081E3" +
		"201080E51EFF2FE10401080000000000" +
		"00000000000000005349454D454E535F" +
		"424F4F54434F44450100070000000000" +
		"00000000000000000000000000000000" +
		"010405008B008B",
		"hex"
	),
	NormalMode: Buffer.from(
		"F104A0E3201090E5FF10C1E3A51081E3" +
		"201080E51EFF2FE10401080000000000" +
		"00000000000000005349454D454E535F" +
		"424F4F54434F44450100070000000000" +
		"00000000000000000000000000000000" +
		"01040500890089",
		"hex"
	),
};

const { values: argv } = parseArgs({
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
		},
		boot: {
			type: "string",
			default: 'ServiceMode'
		}
	}
});

if (argv.help || argv.usage) {
	console.log(`USAGE: bsl.js --port /dev/ttyUSB0 --boot ServiceMode`);
	process.exit(0);
}

let bootCode: Buffer;
if ((argv.boot in SPECIAL_BOOTS)) {
	console.log(`Using built-in boot ${argv.boot}`);
	bootCode = SPECIAL_BOOTS[argv.boot];
} else if (argv.boot.match(/^[a-f0-9]+$/i)) {
	console.log(`Using HEX boot from cmdline.`);
	bootCode = Buffer.from(argv.boot, "hex");
} else {
	console.log(`Using HEX boot from file ${argv.boot}.`);
	bootCode = fs.readFileSync(argv.boot);
}

const port = await openPort(argv.port, 115200);
await port.open();

const result = await loadBootCode(port, bootCode);
console.log(result);

while (true) {
	const byte = await port.readByte(10);
	if (byte == -1)
		continue;
	if (byte == 0)
		break;
	process.stdout.write(Buffer.from([byte]));
}

await port.close();
