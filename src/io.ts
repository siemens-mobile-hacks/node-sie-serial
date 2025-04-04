import createDebug from "debug";
import { sprintf } from "sprintf-js";

export type IoReadWriteProgress = {
	cursor: number;
	total: number;
	elapsed: number;
}

export type IoReadWriteOptions = {
	chunkSize?: number;
	onProgress?: (progress: IoReadWriteProgress) => void;
	progressInterval?: number;
	align?: number;
	signal?: AbortSignal | null;
};

export type IoWriteResult = {
	canceled: boolean;
	written: number;
};

export type IoReadResult = {
	buffer: Buffer;
	canceled: boolean;
};

export type IoReadApi = {
	chunkSize: number;
	debug: createDebug.Debugger,
	readMemoryChunk: (address: number, length: number, buffer: Buffer, bufferOffset: number) => Promise<void>;
};

export type IoWriteApi = {
	chunkSize: number;
	debug: createDebug.Debugger,
	writeMemoryChunk: (address: number, length: number, buffer: Buffer, bufferOffset: number) => Promise<void>;
};

export async function ioReadMemory(api: IoReadApi, address: number, length: number, options: IoReadWriteOptions = {}): Promise<IoReadResult> {
	const validOptions = {
		chunkSize: 0xFFFFFFFF,
		progressInterval: 500,
		align: 1,
		...options
	};
	const start = Date.now();
	const buffer = Buffer.alloc(length);
	let cursor = 0;
	let canceled = false;
	let lastProgressCalled = 0;

	if ((address % validOptions.align) != 0)
		throw new Error(sprintf("Address %04X is not aligned to %d!", address, validOptions.align));

	if ((length % validOptions.align) != 0)
		throw new Error(sprintf("Length %04X is not aligned to %d!", length, validOptions.align));

	while (cursor < buffer.length) {
		if (validOptions.signal?.aborted) {
			canceled = true;
			api.debug("Reading canceled by user.");
			break;
		}

		if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && cursor > 0)) {
			validOptions.onProgress && validOptions.onProgress({
				cursor,
				total: buffer.length,
				elapsed: Date.now() - start
			});
			lastProgressCalled = Date.now();
		}

		let chunkSize = Math.min(buffer.length - cursor, validOptions.chunkSize, api.chunkSize);
		if ((chunkSize % validOptions.align) != 0)
			chunkSize -= chunkSize % validOptions.align;

		await api.readMemoryChunk(address + cursor, chunkSize, buffer, cursor);

		cursor += chunkSize;
	}
	validOptions.onProgress && validOptions.onProgress({
		cursor,
		total: buffer.length,
		elapsed: Date.now() - start
	});
	return { buffer, canceled };
}

export async function ioWriteMemory(api: IoWriteApi, address: number, buffer: Buffer, options: IoReadWriteOptions = {}): Promise<IoWriteResult> {
	const validOptions = {
		chunkSize: 0xFFFFFFFF,
		progressInterval: 500,
		align: 1,
		...options
	};
	let start = Date.now();
	let cursor = 0;
	let lastProgressCalled = 0;
	let canceled = false;

	if ((address % validOptions.align) != 0)
		throw new Error(sprintf("Address %04X is not aligned to %d!", address, validOptions.align));

	if ((buffer.length % validOptions.align) != 0)
		throw new Error(sprintf("Length %04X is not aligned to %d!", buffer.length, validOptions.align));

	while (cursor < buffer.length) {
		if (validOptions.signal?.aborted) {
			canceled = true;
			api.debug("Writing canceled by user.");
			break;
		}

		if (!validOptions.progressInterval || (Date.now() - lastProgressCalled > validOptions.progressInterval && cursor > 0)) {
			validOptions.onProgress && validOptions.onProgress({
				cursor,
				total: buffer.length,
				elapsed: Date.now() - start
			});
			lastProgressCalled = Date.now();
		}

		let chunkSize = Math.min(buffer.length - cursor, validOptions.chunkSize, api.chunkSize);
		if ((chunkSize % validOptions.align) != 0)
			chunkSize -= chunkSize % validOptions.align;

		await api.writeMemoryChunk(address + cursor, chunkSize, buffer, cursor);
		cursor += chunkSize;
	}
	validOptions.onProgress && validOptions.onProgress({
		cursor,
		total: buffer.length,
		elapsed: Date.now() - start
	});
	return { written: cursor, canceled };
}
