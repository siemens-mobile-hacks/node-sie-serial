import { AsyncSerialPort, DWD } from "../src/index.js";
import { SerialPort } from "serialport";
import fs from "fs";

const port = new AsyncSerialPort(new SerialPort({
	path: "/dev/ttyACM0",
	baudRate: 115200,
	autoOpen: false
}));
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
const result = await dwd.readMemory(0xA0000000, 64 * 1024 * 1024, {
	onProgress({ percent, speed, remaining }) {
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
fs.writeFileSync("/tmp/ff.bin", result.buffer);
await dwd.disconnect();
await port.close();
