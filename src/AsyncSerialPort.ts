import type {
	BindingInterface,
	BindingPortInterface,
	OpenOptions,
	PortStatus,
	SetOptions,
	UpdateOptions,
} from '@serialport/bindings-interface';

const DEFAULT_HIGH_WATER_MARK = 64 * 1024;

export type AsyncSerialPortOptions<TOptions extends OpenOptions = OpenOptions> = TOptions & {
	binding: BindingInterface<BindingPortInterface, TOptions>;
	highWaterMark?: number;
};

export class SerialReadTimeoutError extends Error {
	constructor() {
		super('Serial receive timeout.');
		this.name = 'SerialReadTimeoutError';
	}
}

export class AsyncSerialPort<TOptions extends OpenOptions = OpenOptions> {
	private readonly binding: BindingInterface<BindingPortInterface, TOptions>;
	private readonly openOptions: TOptions;
	private port?: BindingPortInterface;
	private opening?: Promise<void>;
	private readError?: unknown;
	private readonly readBuffer: Buffer;
	private readBufferStart = 0;
	private readBufferLength = 0;
	private readonly dataWaiters = new Set<() => void>();
	private readonly spaceWaiters = new Set<() => void>();
	private readQueueTail: Promise<void> = Promise.resolve();
	private pendingReadCount = 0;
	private writeQueueTail: Promise<void> = Promise.resolve();

	constructor(options: AsyncSerialPortOptions<TOptions>) {
		const { binding, highWaterMark = DEFAULT_HIGH_WATER_MARK } = options;
		if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1)
			throw new RangeError('High water mark must be a positive safe integer.');
		this.binding = binding;
		this.openOptions = { ...options };
		Reflect.deleteProperty(this.openOptions, 'binding');
		Reflect.deleteProperty(this.openOptions, 'highWaterMark');
		this.readBuffer = Buffer.allocUnsafe(highWaterMark);
	}

	get isOpen(): boolean {
		return this.port?.isOpen ?? false;
	}

	get baudRate(): number {
		return this.openOptions.baudRate;
	}

	getBindingPort(): BindingPortInterface {
		return this.getOpenPort();
	}

	open(): Promise<void> {
		if (this.isOpen)
			return Promise.resolve();
		if (this.opening)
			return this.opening;

		const opening = this.binding.open(this.openOptions).then((port) => {
			this.port = port;
			this.readError = undefined;
			this.readBufferStart = 0;
			this.readBufferLength = 0;
			void this.pump(port);
		});
		this.opening = opening;
		const clearOpening = () => {
			if (this.opening == opening)
				this.opening = undefined;
		};
		void opening.then(clearOpening, clearOpening);
		return opening;
	}

	async close(): Promise<void> {
		if (this.opening)
			await this.opening;
		const port = this.port;
		if (!port)
			return;

		this.port = undefined;
		this.readError = new Error('Port is not open');
		this.readBufferStart = 0;
		this.readBufferLength = 0;
		this.notify(this.dataWaiters);
		this.notify(this.spaceWaiters);
		if (port.isOpen)
			await port.close();
	}

	readByte(timeout = 0, signal?: AbortSignal): Promise<number> {
		if (signal?.aborted)
			return Promise.resolve(-1);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength)
			return Promise.resolve(this.takeBufferedByte());
		return this.queueRead(() => this.readByteOrTimeout(timeout, signal));
	}

	read(size: number, timeout = 0, signal?: AbortSignal): Promise<Buffer | undefined> {
		if (!Number.isSafeInteger(size) || size < 0)
			return Promise.reject(new RangeError('Read size must be a non-negative safe integer.'));
		if (signal?.aborted)
			return Promise.resolve(undefined);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength >= size)
			return Promise.resolve(this.takeBuffered(size));
		return this.queueRead(() => this.readOrTimeout(size, timeout, signal));
	}

	readExact(size: number, timeout = 0, signal?: AbortSignal): Promise<Buffer> {
		if (!Number.isSafeInteger(size) || size < 0)
			return Promise.reject(new RangeError('Read size must be a non-negative safe integer.'));
		if (signal?.aborted)
			return Promise.reject(signal.reason);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength >= size)
			return Promise.resolve(this.takeBuffered(size));
		return this.queueRead(async () => {
			const result = Buffer.allocUnsafe(size);
			await this.readExactIntoOrThrow(result, 0, size, timeout, signal);
			return result;
		});
	}

	readInto(buffer: Buffer, offset = 0, length?: number, timeout = 0, signal?: AbortSignal): Promise<number> {
		if (!Buffer.isBuffer(buffer))
			return Promise.reject(new TypeError('Read buffer must be a Buffer.'));
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
			return Promise.reject(new RangeError('Read offset is outside the buffer.'));
		length ??= buffer.length - offset;
		if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset)
			return Promise.reject(new RangeError('Read length is outside the buffer.'));
		if (!length)
			return Promise.resolve(0);
		if (signal?.aborted)
			return Promise.resolve(0);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength >= length) {
			this.consumeBuffered(buffer, offset, length);
			return Promise.resolve(length);
		}
		return this.queueRead(() => this.readIntoOrTimeout(buffer, offset, length, timeout, signal));
	}

	readExactInto(buffer: Buffer, offset = 0, length?: number, timeout = 0, signal?: AbortSignal): Promise<void> {
		if (!Buffer.isBuffer(buffer))
			return Promise.reject(new TypeError('Read buffer must be a Buffer.'));
		if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length)
			return Promise.reject(new RangeError('Read offset is outside the buffer.'));
		length ??= buffer.length - offset;
		if (!Number.isSafeInteger(length) || length < 0 || length > buffer.length - offset)
			return Promise.reject(new RangeError('Read length is outside the buffer.'));
		if (signal?.aborted)
			return Promise.reject(signal.reason);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength >= length) {
			this.consumeBuffered(buffer, offset, length);
			return Promise.resolve();
		}
		return this.queueRead(() => this.readExactIntoOrThrow(buffer, offset, length, timeout, signal));
	}

	discard(size: number, timeout = 0, signal?: AbortSignal): Promise<number> {
		if (!Number.isSafeInteger(size) || size < 0)
			return Promise.reject(new RangeError('Discard size must be a non-negative safe integer.'));
		if (!size || signal?.aborted)
			return Promise.resolve(0);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength >= size) {
			this.discardBuffered(size);
			return Promise.resolve(size);
		}
		return this.queueRead(() => this.discardOrTimeout(size, timeout, signal));
	}

	readNextChunk(abortSignal?: AbortSignal): Promise<Buffer | undefined> {
		if (abortSignal?.aborted)
			return Promise.resolve(undefined);
		if (!this.pendingReadCount && !this.readError && this.port?.isOpen && this.readBufferLength)
			return Promise.resolve(this.takeBuffered(this.readBufferLength));
		return this.queueRead(async () => {
			if (abortSignal?.aborted)
				return undefined;
			this.throwReadError();
			while (!this.readBufferLength) {
				if (!await this.wait(this.dataWaiters, 0, abortSignal))
					return undefined;
				this.throwReadError();
			}
			if (abortSignal?.aborted)
				return undefined;
			return this.takeBuffered(this.readBufferLength);
		});
	}

	discardUntilIdle(
		idleTimeout: number,
		maxTimeout = Math.max(3000, idleTimeout * 10),
		signal?: AbortSignal,
	): Promise<void> {
		if (!Number.isSafeInteger(idleTimeout) || idleTimeout < 1)
			return Promise.reject(new RangeError('Idle timeout must be a positive safe integer.'));
		if (!Number.isSafeInteger(maxTimeout) || maxTimeout < idleTimeout)
			return Promise.reject(new RangeError('Maximum timeout must be at least the idle timeout.'));
		return this.queueRead(() => this.discardUntilIdleInternal(idleTimeout, maxTimeout, signal));
	}

	write(data: Uint8Array | string): Promise<void> {
		let port: BindingPortInterface;
		try {
			port = this.getOpenPort();
		} catch (error) {
			return Promise.reject(error);
		}
		const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
		const write = this.writeQueueTail.then(async () => {
			if (this.port != port || !port.isOpen)
				throw new Error('Port is not open');
			try {
				await port.write(buffer);
			} catch (error) {
				await this.disconnect(port, error);
				throw error;
			}
		});
		this.writeQueueTail = write.catch(() => {});
		return write;
	}

	async drain(): Promise<void> {
		const port = this.getOpenPort();
		const writes = this.writeQueueTail;
		await writes;
		if (this.port != port || !port.isOpen)
			throw new Error('Port is not open');
		try {
			await port.drain();
		} catch (error) {
			await this.disconnect(port, error);
			throw error;
		}
	}

	async flush(): Promise<void> {
		const port = this.getOpenPort();
		const writes = this.writeQueueTail;
		await writes;
		if (this.port != port || !port.isOpen)
			throw new Error('Port is not open');
		try {
			await port.flush();
		} catch (error) {
			await this.disconnect(port, error);
			throw error;
		}

		this.discardBuffered(this.readBufferLength);
	}

	async getSignals(): Promise<PortStatus> {
		return this.getOpenPort().get();
	}

	async setSignals(signals: SetOptions): Promise<void> {
		await this.getOpenPort().set(signals);
	}

	async update(settings: UpdateOptions): Promise<void> {
		await this.getOpenPort().update(settings);
		this.openOptions.baudRate = settings.baudRate;
	}

	private async pump(port: BindingPortInterface): Promise<void> {
		try {
			while (this.port == port && port.isOpen) {
				while (this.readBufferLength == this.readBuffer.length) {
					if (this.port != port)
						return;
					await this.wait(this.spaceWaiters);
				}

				const writeOffset = (this.readBufferStart + this.readBufferLength) % this.readBuffer.length;
				const writeLength = Math.min(
					this.readBuffer.length - this.readBufferLength,
					this.readBuffer.length - writeOffset,
				);
				const { bytesRead } = await port.read(this.readBuffer, writeOffset, writeLength);
				if (!bytesRead)
					throw new Error('Serial port closed.');
				if (this.port != port)
					return;
				this.readBufferLength += bytesRead;
				this.notify(this.dataWaiters);
			}
		} catch (error) {
			await this.disconnect(port, error);
		}
	}

	private queueRead<T>(action: () => Promise<T>): Promise<T> {
		this.pendingReadCount++;
		const result = this.readQueueTail.then(action);
		this.readQueueTail = result.then(
			() => { this.pendingReadCount--; },
			() => { this.pendingReadCount--; },
		);
		return result;
	}

	private async readByteOrTimeout(timeout: number, signal?: AbortSignal): Promise<number> {
		if (signal?.aborted)
			return -1;
		this.throwReadError();
		if (this.readBufferLength)
			return this.takeBufferedByte();
		if (!await this.wait(this.dataWaiters, timeout, signal) || signal?.aborted)
			return -1;
		this.throwReadError();
		return this.readBufferLength ? this.takeBufferedByte() : -1;
	}

	private async readOrTimeout(size: number, timeout: number, signal?: AbortSignal): Promise<Buffer | undefined> {
		if (size == 0)
			return Buffer.alloc(0);

		const result = Buffer.allocUnsafe(size);
		const bytesRead = await this.readIntoOrTimeout(result, 0, size, timeout, signal);
		return bytesRead ? result.subarray(0, bytesRead) : undefined;
	}

	private async readIntoOrTimeout(
		target: Buffer,
		targetOffset: number,
		size: number,
		timeout: number,
		signal?: AbortSignal,
	): Promise<number> {
		this.throwReadError();

		let bytesRead = 0;
		const deadline = timeout ? Date.now() + timeout : 0;
		while (bytesRead < size) {
			if (signal?.aborted)
				break;
			if (this.readBufferLength) {
				const chunkSize = Math.min(size - bytesRead, this.readBufferLength);
				this.consumeBuffered(target, targetOffset + bytesRead, chunkSize);
				bytesRead += chunkSize;
				continue;
			}

			this.throwReadError();
			if (deadline && Date.now() >= deadline)
				break;
			const remainingTime = deadline ? Math.max(1, deadline - Date.now()) : 0;
			if (!await this.wait(this.dataWaiters, remainingTime, signal))
				break;
		}

		return bytesRead;
	}

	private async readExactIntoOrThrow(
		target: Buffer,
		targetOffset: number,
		size: number,
		timeout: number,
		signal?: AbortSignal,
	): Promise<void> {
		const bytesRead = await this.readIntoOrTimeout(target, targetOffset, size, timeout, signal);
		signal?.throwIfAborted();
		if (bytesRead != size)
			throw new SerialReadTimeoutError();
	}

	private async discardOrTimeout(size: number, timeout: number, signal?: AbortSignal): Promise<number> {
		this.throwReadError();

		let bytesDiscarded = 0;
		const deadline = timeout ? Date.now() + timeout : 0;
		while (bytesDiscarded < size) {
			if (signal?.aborted)
				break;
			if (this.readBufferLength) {
				const chunkSize = Math.min(size - bytesDiscarded, this.readBufferLength);
				this.discardBuffered(chunkSize);
				bytesDiscarded += chunkSize;
				continue;
			}

			this.throwReadError();
			if (deadline && Date.now() >= deadline)
				break;
			const remainingTime = deadline ? Math.max(1, deadline - Date.now()) : 0;
			if (!await this.wait(this.dataWaiters, remainingTime, signal))
				break;
		}

		return bytesDiscarded;
	}

	private async discardUntilIdleInternal(idleTimeout: number, maxTimeout: number, signal?: AbortSignal): Promise<void> {
		const deadline = Date.now() + maxTimeout;
		while (true) {
			signal?.throwIfAborted();
			this.throwReadError();
			this.discardBuffered(this.readBufferLength);

			const remainingTime = deadline - Date.now();
			if (remainingTime <= 0)
				return;
			if (!await this.wait(this.dataWaiters, Math.min(idleTimeout, remainingTime), signal)) {
				signal?.throwIfAborted();
				return;
			}
		}
	}

	private takeBuffered(size: number): Buffer {
		const result = Buffer.allocUnsafe(size);
		this.consumeBuffered(result, 0, size);
		return result;
	}

	private takeBufferedByte(): number {
		const byte = this.readBuffer[this.readBufferStart];
		this.readBufferStart++;
		if (this.readBufferStart == this.readBuffer.length)
			this.readBufferStart = 0;
		this.readBufferLength--;
		this.notify(this.spaceWaiters);
		return byte;
	}

	private consumeBuffered(target: Buffer, targetOffset: number, size: number): void {
		const firstSize = Math.min(size, this.readBuffer.length - this.readBufferStart);
		this.readBuffer.copy(target, targetOffset, this.readBufferStart, this.readBufferStart + firstSize);
		if (firstSize < size)
			this.readBuffer.copy(target, targetOffset + firstSize, 0, size - firstSize);
		this.readBufferStart = (this.readBufferStart + size) % this.readBuffer.length;
		this.readBufferLength -= size;
		this.notify(this.spaceWaiters);
	}

	private discardBuffered(size: number): void {
		this.readBufferStart = (this.readBufferStart + size) % this.readBuffer.length;
		this.readBufferLength -= size;
		this.notify(this.spaceWaiters);
	}

	private wait(waiters: Set<() => void>, timeout = 0, signal?: AbortSignal): Promise<boolean> {
		if (signal?.aborted)
			return Promise.resolve(false);

		return new Promise((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (ready: boolean) => {
				waiters.delete(onReady);
				if (timer)
					clearTimeout(timer);
				if (signal)
					signal.removeEventListener('abort', onAbort);
				resolve(ready);
			};
			const onReady = () => finish(true);
			const onAbort = () => finish(false);
			waiters.add(onReady);
			if (timeout)
				timer = setTimeout(() => finish(false), timeout);
			if (signal)
				signal.addEventListener('abort', onAbort, { once: true });
		});
	}

	private notify(waiters: Set<() => void>): void {
		for (const wake of waiters)
			wake();
	}

	private throwReadError(): void {
		if (this.readError)
			throw this.readError;
		this.getOpenPort();
	}

	private getOpenPort(): BindingPortInterface {
		if (!this.port?.isOpen)
			throw new Error('Port is not open');
		return this.port;
	}

	private async disconnect(port: BindingPortInterface, error: unknown): Promise<void> {
		if (this.port != port)
			return;
		this.port = undefined;
		this.readError = error;
		this.notify(this.dataWaiters);
		this.notify(this.spaceWaiters);
		if (port.isOpen) {
			try {
				await port.close();
			} catch {}
		}
	}
}
