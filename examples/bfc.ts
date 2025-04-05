import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { BFC, BfcHardwareInfo, BfcSoftwareInfo } from "../src/index.js";
import { openPort } from "./utils.js";

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
		}
	}
});

if (argv.help || argv.usage) {
	console.log(`USAGE: bfc.js --port /dev/ttyUSB0`);
	process.exit(0);
}

const port = await openPort(argv.port, 115200);
await port.open();

const bus = new BFC(port);
port.on('error', (err) => console.error('Port error', err));
port.on('close', () => console.error('Port close'));

console.log('Connecting...');
await bus.connect();
await bus.setBestBaudrate();

console.log('BASEBAND', await bus.getBaseband());
console.log('VENDOR', await bus.getVendorName());
console.log('PRODUCT', await bus.getProductName());
console.log('SW VERSION', await bus.getSwVersion());
console.log('LANGUAGE', await bus.getLanguageGroup());
console.log('IMEI', await bus.getIMEI());

const hwiKeys = [
	BfcHardwareInfo.RFChipSet,
	BfcHardwareInfo.HwDetection,
	BfcHardwareInfo.SWPlatform,
	BfcHardwareInfo.PAType,
	BfcHardwareInfo.LEDType,
	BfcHardwareInfo.LayoutType,
	BfcHardwareInfo.BandType,
	BfcHardwareInfo.StepUpType,
	BfcHardwareInfo.BluetoothType,
];
for (const k of hwiKeys) {
	console.log('[HwInfo]', BfcHardwareInfo[k], await bus.getHwInfo(k));
}

const swiKeys = [
	BfcSoftwareInfo.DB_Name,
	BfcSoftwareInfo.Baseline_Version,
	BfcSoftwareInfo.Baseline_Release,
	BfcSoftwareInfo.Project_Name,
	BfcSoftwareInfo.SW_Builder,
	BfcSoftwareInfo.Link_Time_Stamp,
	BfcSoftwareInfo.Reconfigure_Time_Stamp,
];
for (const k of swiKeys) {
	console.log('[SwInfo]', BfcSoftwareInfo[k], await bus.getSwInfo(k));
}

const displaysCnt = await bus.getDisplayCount();
console.log(`Total displays: ${displaysCnt}`);

for (let i = 1; i <= displaysCnt; i++) {
	const info = await bus.getDisplayInfo(i);
	console.log(info);

	const bufferInfo = await bus.getDisplayBufferInfo(info.clientId);
	console.log(bufferInfo);

	const result = await bus.getDisplayBuffer(i, {
		onProgress({ percent, speed, remaining }) {
			console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
		}
	});
	fs.writeFileSync("screen.data", result.buffer);
}

await bus.disconnect();
await port.close();
