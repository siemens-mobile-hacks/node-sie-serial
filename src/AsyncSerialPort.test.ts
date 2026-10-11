import { BindingInterface, BindingPortInterface, OpenOptions, PortStatus, SetOptions, UpdateOptions } from '@serialport/bindings-interface';
import { describe, expect, test } from 'vitest';
import { AsyncSerialPort, SerialReadTimeoutError } from './AsyncSerialPort.js';
import { AsyncSerialPort as NodeAsyncSerialPort } from './AsyncSerialPort.node.js';

class TestPortBinding implements BindingPortInterface {
	readonly openOptions: Required<OpenOptions>;
	isOpen = true;
	readCalls = 0;
	writeCalls = 0;
	writes: Buffer[] = [];
	drainCalls = 0;
	maxParallelWrites = 0;
	private activeWrites = 0;
	private received = Buffer.alloc(0);
	private pendingRead?: {
		buffer: Buffer;
		offset: number;
		length: number;
		resolve: (result: { buffer: Buffer; bytesRead: number }) => void;
		reject: (error: Error) => void;
	};
	private releaseWrite?: () => void;

	constructor(options: OpenOptions) {
		this.openOptions = {
			dataBits: 8,
			lock: true,
			stopBits: 1,
			parity: 'none',
			rtscts: false,
			xon: false,
			xoff: false,
			xany: false,
			hupcl: true,
			...options,
		};
	}

	emit(data: Buffer): void {
		this.received = Buffer.concat([this.received, data]);
		this.completeRead();
	}

	unblockWrite(): void {
		this.releaseWrite?.();
		this.releaseWrite = undefined;
	}

	failRead(error: Error): void {
		this.pendingRead?.reject(error);
		this.pendingRead = undefined;
	}

	async close(): Promise<void> {
		this.isOpen = false;
		this.pendingRead?.reject(Object.assign(new Error('Port closed'), { canceled: true }));
		this.pendingRead = undefined;
	}

	read(buffer: Buffer, offset: number, length: number): Promise<{ buffer: Buffer; bytesRead: number }> {
		this.readCalls++;
		if (!this.isOpen)
			return Promise.reject(new Error('Port is not open'));
		if (this.pendingRead)
			return Promise.reject(new Error('Overlapping read'));
		return new Promise((resolve, reject) => {
			this.pendingRead = { buffer, offset, length, resolve, reject };
			this.completeRead();
		});
	}

	async write(buffer: Buffer): Promise<void> {
		this.writeCalls++;
		this.writes.push(buffer);
		this.activeWrites++;
		this.maxParallelWrites = Math.max(this.maxParallelWrites, this.activeWrites);
		if (this.writeCalls == 1)
			await new Promise<void>((resolve) => this.releaseWrite = resolve);
		this.activeWrites--;
	}

	async update(options: UpdateOptions): Promise<void> {
		this.openOptions.baudRate = options.baudRate;
	}

	async set(_options: SetOptions): Promise<void> {}

	async get(): Promise<PortStatus> {
		return { cts: true, dsr: false, dcd: true };
	}

	async getBaudRate(): Promise<{ baudRate: number }> {
		return { baudRate: this.openOptions.baudRate };
	}

	async flush(): Promise<void> {
		this.received = Buffer.alloc(0);
	}

	async drain(): Promise<void> {
		this.drainCalls++;
	}

	private completeRead(): void {
		const read = this.pendingRead;
		if (!read || !this.received.length)
			return;
		this.pendingRead = undefined;
		const bytesRead = Math.min(read.length, this.received.length);
		this.received.copy(read.buffer, read.offset, 0, bytesRead);
		this.received = this.received.subarray(bytesRead);
		read.resolve({ buffer: read.buffer, bytesRead });
	}
}

async function openTestPort(highWaterMark?: number): Promise<{
	port: AsyncSerialPort;
	bindingPort: TestPortBinding;
	bindingPorts: TestPortBinding[];
}> {
	let bindingPort: TestPortBinding | undefined;
	const bindingPorts: TestPortBinding[] = [];
	const binding: BindingInterface<TestPortBinding> = {
		list: async () => [],
		open: async (options) => {
			bindingPort = new TestPortBinding(options);
			bindingPorts.push(bindingPort);
			return bindingPort;
		},
	};
	const port = new AsyncSerialPort({ binding, path: 'test', baudRate: 115200, highWaterMark });
	await port.open();
	return { port, bindingPort: bindingPort!, bindingPorts };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('AsyncSerialPort', () => {
	test('exposes the open binding port', async () => {
		const { port, bindingPort } = await openTestPort();
		expect(port.getBindingPort()).toBe(bindingPort);
		await port.close();
		expect(() => port.getBindingPort()).toThrow('Port is not open');
	});

	test('keeps unread bytes buffered while the read pump continues', async () => {
		const { port, bindingPort } = await openTestPort();
		await nextTurn();
		expect(bindingPort.readCalls).toBe(1);
		bindingPort.emit(Buffer.from([1, 2, 3]));
		await nextTurn();
		expect(bindingPort.readCalls).toBe(2);
		expect(await port.read(2, 100)).toEqual(Buffer.from([1, 2]));
		expect(await port.readNextChunk()).toEqual(Buffer.from([3]));
		await port.close();
	});

	test('wraps the read buffer without overwriting unread bytes', async () => {
		const { port, bindingPort } = await openTestPort();
		const initial = Buffer.alloc(64 * 1024, 0x11);
		bindingPort.emit(initial);
		await nextTurn();
		expect(bindingPort.readCalls).toBe(1);

		expect(await port.read(48 * 1024)).toEqual(initial.subarray(0, 48 * 1024));
		await nextTurn();
		expect(bindingPort.readCalls).toBe(2);

		const wrapped = Buffer.alloc(32 * 1024, 0x22);
		bindingPort.emit(wrapped);
		expect(await port.read(48 * 1024)).toEqual(Buffer.concat([
			initial.subarray(48 * 1024),
			wrapped,
		]));
		await port.close();
	});

	test('uses the configured high water mark as the read buffer capacity', async () => {
		const { port, bindingPort } = await openTestPort(4);
		bindingPort.emit(Buffer.from([1, 2, 3, 4, 5, 6]));
		await nextTurn();
		expect(bindingPort.readCalls).toBe(1);

		expect(await port.read(2)).toEqual(Buffer.from([1, 2]));
		await nextTurn();
		expect(bindingPort.readCalls).toBe(2);
		expect(await port.readExact(4)).toEqual(Buffer.from([3, 4, 5, 6]));
		await port.close();
	});

	test('rejects an invalid high water mark', () => {
		const binding: BindingInterface<TestPortBinding> = {
			list: async () => [],
			open: async (options) => new TestPortBinding(options),
		};
		expect(() => new AsyncSerialPort({
			binding,
			path: 'test',
			baudRate: 115200,
			highWaterMark: 0,
		})).toThrow('High water mark must be a positive safe integer.');
	});

	test('passes binding-specific options without internal options', async () => {
		interface CustomOpenOptions extends OpenOptions {
			customOption: string;
		}

		let receivedOptions: CustomOpenOptions | undefined;
		const binding: BindingInterface<TestPortBinding, CustomOpenOptions> = {
			list: async () => [],
			open: async (options) => {
				receivedOptions = options;
				return new TestPortBinding(options);
			},
		};
		const port: AsyncSerialPort = new AsyncSerialPort({
			binding,
			path: 'test',
			baudRate: 115200,
			customOption: 'custom',
			highWaterMark: 8,
		});
		await port.open();

		expect(receivedOptions).toEqual({
			path: 'test',
			baudRate: 115200,
			customOption: 'custom',
		});
		await port.close();
	});

	test('passes binding-specific options through the Node entry point', async () => {
		interface CustomOpenOptions extends OpenOptions {
			customOption: string;
		}

		let receivedOptions: CustomOpenOptions | undefined;
		const binding: BindingInterface<TestPortBinding, CustomOpenOptions> = {
			list: async () => [],
			open: async (options) => {
				receivedOptions = options;
				return new TestPortBinding(options);
			},
		};
		const port: NodeAsyncSerialPort = new NodeAsyncSerialPort({
			binding,
			path: 'test',
			baudRate: 115200,
			customOption: 'custom',
			highWaterMark: 8,
		});
		await port.open();

		expect(receivedOptions).toEqual({
			path: 'test',
			baudRate: 115200,
			customOption: 'custom',
		});
		await port.close();
	});

	test('preserves a native read that completes after a timeout', async () => {
		const { port, bindingPort } = await openTestPort();
		const first = port.read(2, 20);
		await nextTurn();
		bindingPort.emit(Buffer.from([1]));
		expect(await first).toEqual(Buffer.from([1]));

		const late = port.read(1, 100);
		bindingPort.emit(Buffer.from([2]));
		expect(await late).toEqual(Buffer.from([2]));
		await port.close();
	});

	test('reads directly into a caller buffer at an offset', async () => {
		const { port, bindingPort } = await openTestPort();
		bindingPort.emit(Buffer.from([1, 2, 3]));
		await nextTurn();

		const target = Buffer.alloc(5, 0xFF);
		expect(await port.readInto(target, 1, 3)).toBe(3);
		expect(target).toEqual(Buffer.from([0xFF, 1, 2, 3, 0xFF]));
		await port.close();
	});

	test('returns the number of bytes written by readInto on timeout', async () => {
		const { port, bindingPort } = await openTestPort();
		const target = Buffer.alloc(4, 0xFF);
		const read = port.readInto(target, 1, 3, 20);
		bindingPort.emit(Buffer.from([1, 2]));

		expect(await read).toBe(2);
		expect(target).toEqual(Buffer.from([0xFF, 1, 2, 0xFF]));
		await port.close();
	});

	test('reads an exact number of bytes across binding reads', async () => {
		const { port, bindingPort } = await openTestPort();
		const read = port.readExact(3);
		bindingPort.emit(Buffer.from([1]));
		await nextTurn();
		bindingPort.emit(Buffer.from([2, 3]));

		expect(await read).toEqual(Buffer.from([1, 2, 3]));
		await port.close();
	});

	test('throws when readExactInto times out before filling the buffer', async () => {
		const { port, bindingPort } = await openTestPort();
		const target = Buffer.alloc(4, 0xFF);
		const read = port.readExactInto(target, 1, 3, 20);
		bindingPort.emit(Buffer.from([1, 2]));

		await expect(read).rejects.toBeInstanceOf(SerialReadTimeoutError);
		await expect(read).rejects.toThrow('Serial receive timeout.');
		expect(target).toEqual(Buffer.from([0xFF, 1, 2, 0xFF]));
		await port.close();
	});

	test('readExactInto throws the abort reason', async () => {
		const { port } = await openTestPort();
		const controller = new AbortController();
		const reason = new Error('Cancelled');
		const read = port.readExactInto(Buffer.alloc(1), 0, 1, 0, controller.signal);
		controller.abort(reason);

		await expect(read).rejects.toBe(reason);
		await port.close();
	});

	test('aborts a read without consuming subsequent data', async () => {
		const { port, bindingPort } = await openTestPort();
		const controller = new AbortController();
		const abandoned = port.read(1, 0, controller.signal);
		await nextTurn();
		controller.abort();
		expect(await abandoned).toBeUndefined();

		const next = port.read(1);
		bindingPort.emit(Buffer.from([0x55]));
		expect(await next).toEqual(Buffer.from([0x55]));
		await port.close();
	});

	test('returns bytes already read when readInto is aborted', async () => {
		const { port, bindingPort } = await openTestPort();
		const controller = new AbortController();
		const target = Buffer.alloc(2);
		const read = port.readInto(target, 0, 2, 0, controller.signal);
		bindingPort.emit(Buffer.from([0x55]));
		await nextTurn();
		controller.abort();

		expect(await read).toBe(1);
		expect(target[0]).toBe(0x55);
		await port.close();
	});

	test('hands an aborted chunk read to the next reader', async () => {
		const { port, bindingPort } = await openTestPort();
		const controller = new AbortController();
		const abandoned = port.readNextChunk(controller.signal);
		await nextTurn();
		controller.abort();
		expect(await abandoned).toBeUndefined();

		const next = port.readNextChunk();
		bindingPort.emit(Buffer.from([0x55]));
		expect(await next).toEqual(Buffer.from([0x55]));
		await port.close();
	});

	test('does not consume buffered data after a chunk read is aborted', async () => {
		const { port, bindingPort } = await openTestPort();
		const controller = new AbortController();
		const abandoned = port.readNextChunk(controller.signal);
		await nextTurn();
		bindingPort.emit(Buffer.from([0x55]));
		queueMicrotask(() => controller.abort());

		expect(await abandoned).toBeUndefined();
		expect(await port.readNextChunk()).toEqual(Buffer.from([0x55]));
		await port.close();
	});

	test('does not return buffered data after the binding read fails', async () => {
		const { port, bindingPort } = await openTestPort();
		bindingPort.emit(Buffer.from([0x55]));
		await nextTurn();
		bindingPort.failRead(new Error('Read failed'));
		await nextTurn();

		await expect(port.readNextChunk()).rejects.toThrow('Read failed');
	});

	test('keeps queued reads ordered when data is already buffered', async () => {
		const { port, bindingPort } = await openTestPort();
		const first = port.read(2);
		bindingPort.emit(Buffer.from([1]));
		await nextTurn();

		const second = port.readByte();
		bindingPort.emit(Buffer.from([2, 3]));
		expect(await first).toEqual(Buffer.from([1, 2]));
		expect(await second).toBe(3);
		await port.close();
	});

	test('serializes writes for bindings that reject overlap', async () => {
		const { port, bindingPort } = await openTestPort();
		const first = port.write(new Uint8Array([1]));
		const second = port.write(Buffer.from([2]));
		await nextTurn();
		expect(bindingPort.writeCalls).toBe(1);
		bindingPort.unblockWrite();
		await Promise.all([first, second]);
		expect(bindingPort.writeCalls).toBe(2);
		expect(bindingPort.writes).toEqual([Buffer.from([1]), Buffer.from([2])]);
		expect(bindingPort.maxParallelWrites).toBe(1);
		await port.close();
	});

	test('does not send a queued write through a reopened port', async () => {
		const { port, bindingPort, bindingPorts } = await openTestPort();
		const active = port.write(Buffer.from([1]));
		const stale = port.write(Buffer.from([2]));
		await nextTurn();
		await port.close();
		await port.open();

		bindingPort.unblockWrite();
		await active;
		await expect(stale).rejects.toThrow('Port is not open');
		expect(bindingPorts[1].writeCalls).toBe(0);
		await port.close();
	});

	test('drains writes queued before it', async () => {
		const { port, bindingPort } = await openTestPort();
		const write = port.write(Buffer.from([1]));
		const drain = port.drain();
		await nextTurn();
		expect(bindingPort.drainCalls).toBe(0);

		bindingPort.unblockWrite();
		await Promise.all([write, drain]);
		expect(bindingPort.drainCalls).toBe(1);
		await port.close();
	});

	test('flushes the binding and discards buffered input', async () => {
		const { port, bindingPort } = await openTestPort();
		bindingPort.emit(Buffer.from([1, 2]));
		await nextTurn();
		await port.flush();
		expect(await port.read(1, 20)).toBeUndefined();

		bindingPort.emit(Buffer.from([3]));
		expect(await port.readByte(100)).toBe(3);
		await port.close();
	});

	test('discards a requested number of bytes without allocating a result', async () => {
		const { port, bindingPort } = await openTestPort();
		bindingPort.emit(Buffer.from([1, 2]));
		const discard = port.discard(3, 100);
		bindingPort.emit(Buffer.from([3, 4]));

		expect(await discard).toBe(3);
		expect(await port.readByte(100)).toBe(4);
		await port.close();
	});

	test('returns the number of bytes discarded on timeout', async () => {
		const { port, bindingPort } = await openTestPort();
		const discard = port.discard(3, 20);
		bindingPort.emit(Buffer.from([1, 2]));

		expect(await discard).toBe(2);
		await port.close();
	});

	test('discards buffered and incoming data until the port is idle', async () => {
		const { port, bindingPort } = await openTestPort();
		bindingPort.emit(Buffer.from([1]));
		const discard = port.discardUntilIdle(20, 200);
		setTimeout(() => bindingPort.emit(Buffer.from([2, 3])), 10);
		await discard;

		expect(await port.read(1, 20)).toBeUndefined();
		bindingPort.emit(Buffer.from([4]));
		expect(await port.readByte(100)).toBe(4);
		await port.close();
	});
});
