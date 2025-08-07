import { sprintf } from "sprintf-js";

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

export function getUSBDeviceName(vid: number, pid: number) {
	const id = sprintf("%04X:%04X", vid, pid);
	return USB_DEVICES[id] ?? id;
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
	let len = 0;
	for (let i = 1; i < buffer.length; i++) {
		if (buffer[i] == 0)
			break;
		len++;
	}
	return buffer.subarray(0, len + 1).toString();
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

export function hexdump(buffer: Buffer) {
	const str: string[] = [];
	for (const byte of buffer)
		str.push(byte.toString(16).padStart(2, "0").toUpperCase());
	return str.join(" ");
}
