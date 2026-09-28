import { sprintf } from "sprintf-js";
import { AsyncSerialPort } from "./AsyncSerialPort.js";

const USB_DEVICES: Record<string, string> = {
	"067B:2303": "PL2303",
	"1A86:7523": "CH340",
	"0403:6001": "FT232",
	"10C4:EA60": "СР2102",
	"11F5:0001": "DCA-540",
	"11F5:0002": "DCA-540",
	"11F5:0003": "DCA-540",
	"11F5:0004": "DCA-540",
	"11F5:0005": "DCA-540",
	"11F5:0006": "DCA-540",
	"11F5:0007": "DCA-540",
	"11F5:1004": "DCA-540",
	"04DA:2121": "Panasonic VS/MX/SA",
	"04DA:2129": "Softbank 705p",
	"04DA:213C": "Softbank 810p",
	"04DA:2149": "Softbank 820p",
	"04DA:2159": "Softbank 821p",
	"04DA:2172": "Softbank 830p",
	"04DA:2173": "Softbank 831p",
};

export function getUSBDeviceName(vid: number, pid: number): string | undefined {
	const id = sprintf("%04X:%04X", vid, pid);
	return USB_DEVICES[id];
}

export function usePromiseWithResolvers<T>() {
	let resolve: ((value: (PromiseLike<T> | T)) => void) | undefined;
	let reject: ((reason?: any) => void) | undefined;
	const promise = new Promise<T>((_resolve, _reject) => {
		resolve = _resolve;
		reject = _reject;
	});
	return { promise, resolve: resolve!, reject: reject! };
}

export function decodeCString(buffer: Buffer): string {
	const zero = buffer.indexOf(0);
	return buffer.subarray(0, zero < 0 ? buffer.length : zero).toString();
}

export function delay(timeout: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, timeout));
}

export async function retryAsync<T>(callback: () => Promise<T>, options: { max: number, until: (lastResult: T) => boolean }) {
	let lastResult: T;
	for (let i = 0; i < options.max; i++) {
		lastResult = await callback();
		if (!options.until(lastResult))
			break;
	}
	return lastResult!;
}

export async function retryAsyncOnError(callback: () => Promise<void>, options: { max: number }) {
	let lastError: unknown;
	for (let i = 0; i < options.max; i++) {
		try {
			await callback();
			return;
		} catch (e) {
			lastError = e;
		}
	}
	throw lastError;
}

// Reads exactly size bytes, or fails once the deadline (a Date.now() timestamp) passes
// or signal is aborted
export async function readExact(port: AsyncSerialPort, size: number, deadline: number, signal?: AbortSignal): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let remaining = size;
	while (remaining > 0) {
		if (signal?.aborted)
			throw new Error("Serial receive cancelled.");
		const left = deadline - Date.now();
		if (left <= 0)
			throw new Error("Serial receive timeout.");
		// Short waits with a signal, so that an abort ends the read soon
		const chunk = await port.read(remaining, Math.min(left, signal ? 250 : 2000));
		if (!chunk?.length)
			continue;
		chunks.push(chunk);
		remaining -= chunk.length;
	}
	return Buffer.concat(chunks);
}

// Drops input until the line has been quiet for timeout ms, but for maxTime ms at
// most: a line that never goes quiet must not keep it forever
export async function flushInput(port: AsyncSerialPort, timeout: number, maxTime = Math.max(3000, timeout * 10)): Promise<void> {
	// A read without a timeout waits for the next byte, however long that takes
	timeout = Math.max(timeout, 1);
	const deadline = Date.now() + maxTime;
	let chunk: Buffer | undefined;
	do {
		chunk = await port.read(1, timeout);
	} while (chunk?.length && Date.now() < deadline);
}

// Switches the port to baudRate, false when the port refuses that rate: legacy
// Windows COM ports refuse anything above 115200
export async function trySetBaudRate(port: AsyncSerialPort, baudRate: number): Promise<boolean> {
	try {
		await port.update({ baudRate });
		return true;
	} catch (e) {
		if (!port.isOpen)
			throw e;
		return false;
	}
}

export function hexdump(buffer: Buffer) {
	const str: string[] = [];
	for (const byte of buffer)
		str.push(byte.toString(16).padStart(2, "0").toUpperCase());
	return str.join(" ");
}
