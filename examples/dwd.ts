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
dwd.setKeys("panasonic");
await dwd.connect();
const result = await dwd.readMemory(0xA0000000, 64 * 1024 * 1024, {
	onProgress({ total, cursor, elapsed }) {
		const percent = (cursor / total) * 100;
		const speed = cursor / (elapsed / 1000);
		const remaining = (total - cursor) / speed;
		console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s | ETA: ${remaining.toFixed(2)}s`);
	}
});
fs.writeFileSync("/tmp/ff.bin", result.buffer);
await port.close();
