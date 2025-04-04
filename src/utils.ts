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

export function hexdump(buffer: Buffer) {
	const str: string[] = [];
	for (const byte of buffer)
		str.push(byte.toString(16).padStart(2, "0").toUpperCase());
	return str.join(" ");
}
