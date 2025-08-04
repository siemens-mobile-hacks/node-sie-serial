import createDebug from "debug";
import { sprintf } from "sprintf-js";

export type IoFlashRegion = {
	addr: number;
	size: number;
	eraseSize: number;
};

export type IoReadWriteProgress = {
	percent: number;
	cursor: number;
	total: number;
	elapsed: number;
	speed: number;
	remaining: number;
	errors: number;
	pageAddr: number;
	pageSize: number;
}

export type IoReadWriteOptions = {
	pageSize?: number;
	onProgress?: (progress: IoReadWriteProgress) => void;
	progressInterval?: number;
	align?: number;
	signal?: AbortSignal | null;
};

export type IoWriteResult = {
	canceled: boolean;
	written: number;
	errors: number;
};

export type IoReadResult = {
	buffer: Buffer;
	canceled: boolean;
	errors: number;
};

export type IoAdaptivePageSizeConfig = {
	smallPageSize: number;
	smallPageRetryCount: number;
	bigPageSize: number;
	bigPageRetryCount: number;
};

export type IoReadApi = {
	pageSize: number;
	align: number;
	debug: createDebug.Debugger,
	read: (address: number, length: number, buffer: Buffer, bufferOffset: number) => Promise<void>;
	onError?: (e: unknown) => Promise<void>;
	maxRetries?: number;
	adaptivePageSize?: IoAdaptivePageSizeConfig;
};

export type IoWriteApi = {
	pageSize: number;
	align: number;
	debug: createDebug.Debugger,
	write: (address: number, buffer: Buffer) => Promise<void>;
	onError?: (e: unknown) => Promise<void>;
	maxRetries?: number;
	adaptivePageSize?: IoAdaptivePageSizeConfig;
};

export type IoProgressOptions = {
	total: number;
	baseAddr?: number;
	progressInterval: number;
	onProgress?: (progress: IoReadWriteProgress) => void;
};

export type IoFlashWriteChunks = {
	addr: number;
	size: number;
	bufferOffset: number;
	bufferSize: number;
	isPartial: boolean;
};

export function ioProgressTracker(options: IoProgressOptions) {
	const start = Date.now();
	let currentCursor = 0;
	let lastProgressCalled = 0;
	let lastSpeedCheck = Date.now();
	let lastSpeedCursor = 0;
	let effectiveSpeed = 0;
	let currentErrors = 0;
	let currentPageSize = 0;
	let progressCalled = false;

	const reportProgressDirect = () => {
		const elapsed = Date.now() - start;
		const speed = effectiveSpeed ? effectiveSpeed : currentCursor / (elapsed / 1000);
		const remaining = (options.total - currentCursor) / speed;

		options.onProgress && options.onProgress({
			percent: currentCursor / options.total * 100,
			cursor: currentCursor,
			total: options.total,
			speed,
			remaining,
			elapsed,
			errors: currentErrors,
			pageAddr: currentCursor + (options.baseAddr ?? 0),
			pageSize: currentPageSize,
		});

		lastProgressCalled = Date.now();
	};

	const report = (cursor: number, errors: number = 0, chunkSize: number = 0) => {
		currentCursor = cursor;
		currentErrors = errors;
		currentPageSize = chunkSize;

		if (Date.now() - lastSpeedCheck >= 1000) {
			const elapsed = Date.now() - lastSpeedCheck;
			effectiveSpeed = (currentCursor - lastSpeedCursor) / (elapsed / 1000);
			lastSpeedCursor = currentCursor;
			lastSpeedCheck = Date.now();
		}

		if (!options.progressInterval || (Date.now() - lastProgressCalled >= options.progressInterval && cursor > 0)) {
			reportProgressDirect();
			progressCalled = true;
		} else {
			progressCalled = false;
		}
	};

	const stop = () => {
		if (!progressCalled)
			reportProgressDirect();
	};

	return { report, stop };
}

export async function ioReadMemory(api: IoReadApi, address: number, length: number, options: IoReadWriteOptions = {}): Promise<IoReadResult> {
	const validOptions = {
		pageSize: 0x100000000,
		progressInterval: 100,
		...options
	};
	let buffer = Buffer.alloc(length);
	let cursor = 0;
	let canceled = false;
	let errors = 0;
	let retriesCount = 0;
	let pageSizeErrorsCount = 0;

	if ((address % api.align) != 0)
		throw new Error(sprintf("Address %04X is not aligned to %d!", address, api.align));

	if ((length % api.align) != 0)
		throw new Error(sprintf("Length %04X is not aligned to %d!", length, api.align));

	let pageSize = Math.min(validOptions.pageSize, api.pageSize);
	if ((pageSize % api.align) != 0)
		throw new Error(sprintf("Page size %04X is not aligned to %d!", pageSize, api.align));

	if (api.adaptivePageSize) {
		if (api.adaptivePageSize.smallPageSize > api.adaptivePageSize.bigPageSize)
			throw new Error("adaptivePageSize.smallPageSize must be <= bigPageSize");
		if (api.adaptivePageSize.smallPageSize % api.align !== 0 || api.adaptivePageSize.bigPageSize % api.align !== 0)
			throw new Error("adaptivePageSize page sizes must be aligned.");
	}

	const progress = ioProgressTracker({
		total: buffer.length,
		baseAddr: address,
		progressInterval: validOptions.progressInterval,
		onProgress: validOptions.onProgress
	});

	while (cursor < buffer.length) {
		if (validOptions.signal?.aborted) {
			canceled = true;
			api.debug("Reading canceled by user.");
			break;
		}

		let readSize = Math.min(buffer.length - cursor, pageSize);

		try {
			progress.report(cursor, errors, readSize);
			await api.read(address + cursor, readSize, buffer, cursor);
			cursor += readSize;
			retriesCount = 0;
			pageSizeErrorsCount = 0;
		} catch (e) {
			errors++;
			retriesCount++;

			if (api.onError)
				await api.onError(e);

			if (!api.maxRetries || retriesCount >= api.maxRetries)
				throw e;

			if (api.adaptivePageSize) {
				const remainingBytes = buffer.length - cursor;
				if (remainingBytes > api.adaptivePageSize.smallPageSize) {
					const maxReadTries = pageSize >= api.adaptivePageSize.bigPageSize ?
						api.adaptivePageSize.bigPageRetryCount :
						api.adaptivePageSize.smallPageRetryCount;
					pageSizeErrorsCount++;
					if (pageSizeErrorsCount >= maxReadTries) {
						pageSizeErrorsCount = 0;
						if (pageSize > api.adaptivePageSize.smallPageSize) {
							pageSize = Math.floor(pageSize / 2);
							pageSize -= pageSize % api.align;
							if (pageSize === 0)
								throw new Error("Adaptive page size reduced to zero.");
							api.debug(sprintf("Reducing page size to: 0x%02X", pageSize));
						}
					}
				}
			}
		}
	}

	progress.report(cursor, errors, 0);
	progress.stop();

	// Partial result
	if (canceled)
		buffer = buffer.subarray(0, cursor);

	return { buffer, canceled, errors };
}

export async function ioWriteMemory(api: IoWriteApi, address: number, buffer: Buffer, options: IoReadWriteOptions = {}): Promise<IoWriteResult> {
	const validOptions = {
		pageSize: 0x100000000,
		progressInterval: 100,
		...options
	};
	let cursor = 0;
	let canceled = false;
	let errors = 0;
	let retriesCount = 0;
	let pageSizeErrorsCount = 0;

	if ((address % api.align) != 0)
		throw new Error(sprintf("Address %04X is not aligned to %d!", address, api.align));

	if ((buffer.length % api.align) != 0)
		throw new Error(sprintf("Length %04X is not aligned to %d!", buffer.length, api.align));

	let pageSize = Math.min(validOptions.pageSize, api.pageSize);
	if ((pageSize % api.align) != 0)
		throw new Error(sprintf("Page size %04X is not aligned to %d!", pageSize, api.align));

	if (api.adaptivePageSize) {
		if (api.adaptivePageSize.smallPageSize > api.adaptivePageSize.bigPageSize)
			throw new Error("adaptivePageSize.smallPageSize must be <= bigPageSize");
		if (api.adaptivePageSize.smallPageSize % api.align !== 0 || api.adaptivePageSize.bigPageSize % api.align !== 0)
			throw new Error("adaptivePageSize page sizes must be aligned.");
	}

	const progress = ioProgressTracker({
		total: buffer.length,
		baseAddr: address,
		progressInterval: validOptions.progressInterval,
		onProgress: validOptions.onProgress
	});

	while (cursor < buffer.length) {
		if (validOptions.signal?.aborted) {
			canceled = true;
			api.debug("Writing canceled by user.");
			break;
		}

		let writeSize = Math.min(buffer.length - cursor, pageSize);
		try {
			progress.report(cursor, errors, writeSize);
			await api.write(address + cursor, buffer.subarray(cursor, cursor + writeSize));
			cursor += writeSize;
			retriesCount = 0;
		} catch (e) {
			errors++;
			retriesCount++;

			if (api.onError)
				await api.onError(e);

			if (!api.maxRetries || retriesCount >= api.maxRetries)
				throw e;

			if (api.adaptivePageSize) {
				const remainingBytes = buffer.length - cursor;
				if (remainingBytes > api.adaptivePageSize.smallPageSize) {
					const maxReadTries = pageSize >= api.adaptivePageSize.bigPageSize ?
						api.adaptivePageSize.bigPageRetryCount :
						api.adaptivePageSize.smallPageRetryCount;
					pageSizeErrorsCount++;
					if (pageSizeErrorsCount >= maxReadTries) {
						pageSizeErrorsCount = 0;
						if (pageSize > api.adaptivePageSize.smallPageSize) {
							pageSize = Math.floor(pageSize / 2);
							pageSize -= pageSize % api.align;
							if (pageSize === 0)
								throw new Error("Adaptive page size reduced to zero.");
							api.debug(sprintf("Reducing page size to: 0x%02X", pageSize));
						}
					}
				}
			}
		}
	}

	progress.report(cursor, errors, 0);
	progress.stop();

	return { written: cursor, canceled, errors };
}

export function findFlashRegion(addr: number, regions: IoFlashRegion[]): IoFlashRegion | undefined {
	for (const region of regions) {
		if (addr >= region.addr && addr < region.addr + region.size)
			return region;
	}
	return undefined;
}

export function alignToFlashRegions(addr: number, size: number, regions: IoFlashRegion[]): IoFlashWriteChunks[] {
	const chunks: IoFlashWriteChunks[] = [];

	while (size > 0) {
		const region = findFlashRegion(addr, regions);
		if (!region)
			throw new Error(sprintf("Address %08X is out of bounds!", addr));
		const bufferOffset = addr - region.addr;
		const bufferSize = Math.min(size, region.size - bufferOffset);
		chunks.push({
			addr: region.addr,
			size: region.size,
			bufferOffset,
			bufferSize,
			isPartial: bufferOffset != 0 || bufferSize != region.size,
		});
		addr += bufferSize;
		size -= bufferSize;
	}

	return chunks;
}
