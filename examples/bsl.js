import { loadBootCode } from "@sie-js/serial";
import { AsyncSerialPort } from "@sie-js/serial";
import { parseArgs } from 'node:util';
import { SerialPort } from 'serialport';

const SPECIAL_BOOTS = {
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
		},
		boot: {
			type: "string",
			default: 'ServiceMode'
		}
	}
});

if (argv.values.help || argv.values.usage) {
	console.log(`USAGE: bsl.js --port /dev/ttyUSB0 --boot ServiceMode`);
	process.exit(0);
}

let bootcode;
if ((argv.values.boot in SPECIAL_BOOTS)) {
	console.log(`Using built-in boot ${argv.values.boot}`);
	bootcode = SPECIAL_BOOTS[argv.values.boot];
} else if (argv.values.boot.match(/^[a-f0-9]+$/i)) {
	console.log(`Using HEX boot from cmdline.`);
	bootcode = Buffer.from(SPECIAL_BOOTS[argv.values.boot], "hex");
} else {
	console.log(`Using HEX boot from file ${argv.values.boot}.`);
	bootcode = fs.readFileSync(argv.values.boot);
}

let port = new AsyncSerialPort(new SerialPort({ path: argv.values.port, baudRate: 115200, autoOpen: false }));
await port.open();

let result = await loadBootCode(port, bootcode);
console.log(result);

await port.close();
