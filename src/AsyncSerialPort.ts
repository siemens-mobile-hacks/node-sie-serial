import { SerialPortStream } from "@serialport/stream";
import { BindingInterface, SetOptions } from "@serialport/bindings-interface";

export class AsyncSerialPort<T extends BindingInterface = BindingInterface> {
	private readonly port: SerialPortStream<T>;

	constructor(port: SerialPortStream<T>) {
		this.port = port;
	}

	on(event: string | symbol, listener: (...args: any[]) => void) {
		return this.port.on(event, listener);
	}

	off(event: string | symbol, listener: (...args: any[]) => void) {
		return this.port.off(event, listener);
	}

	get isOpen(): boolean {
		return this.port.isOpen;
	}

	get baudRate(): number {
		return this.port.baudRate;
	}

	async open(): Promise<void> {
		if (this.port.isOpen)
			return;
		return new Promise((resolve, reject) => {
			this.port.open((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	async close(): Promise<void> {
		if (!this.port.isOpen)
			return;
		return new Promise((resolve, reject) => {
			this.port.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	async readByte(timeout = 0): Promise<number> {
		const byte = await this.read(1, timeout);
		return byte == null ? -1 : byte[0];
	}

	async read(size: number, timeout?: number): Promise<Buffer | undefined> {
		if (!this.port.isOpen)
			throw new Error("Port is not open");

		if (this.port.readableLength >= size)
			return this.port.read(size);

		return new Promise((resolve, reject) => {
			let result: Buffer | undefined;
			let bytesRead = 0;
			let timeoutTimer: NodeJS.Timeout | undefined;

			const removeListeners = () => {
				this.port.removeListener("close", onClose);
				this.port.removeListener("end", onEnd);
				this.port.removeListener("error", onError);
				this.port.removeListener("readable", onReadable);

				if (timeoutTimer) {
					clearTimeout(timeoutTimer);
					timeoutTimer = undefined;
				}
			};
			const onTimeout = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			const onClose = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			const onEnd = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			const onError = (err: Error) => {
				removeListeners();
				reject(err);
			};
			const onReadable = () => {
				const bytesToRead = Math.min(size - bytesRead, this.port.readableLength);
				if (bytesToRead == 0)
					return;

				let chunk = this.port.read(bytesToRead);
				if (!result)
					result = Buffer.alloc(size);
				chunk.copy(result, bytesRead);
				bytesRead += chunk.length

				if (bytesRead == size) {
					removeListeners();
					resolve(result?.subarray(0, bytesRead));
				}
			};

			if (this.port.readableLength > 0)
				onReadable();
			if (bytesRead == size)
				return;

			this.port.on("close", onClose);
			this.port.on("end", onEnd);
			this.port.on("error", onError);
			this.port.on("readable", onReadable);

			if (timeout)
				timeoutTimer = setTimeout(onTimeout, timeout);
		});
	}

	async write(data: any): Promise<void> {
		if (!this.port.isOpen)
			throw new Error("Port is not open");
		this.port.write(data);
	}

	async getSignals(): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.port.isOpen)
				reject(new Error("Port is not open"));
			this.port.get((err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	async setSignals(signals: SetOptions): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.port.isOpen)
				reject(new Error("Port is not open"));
			this.port.set(signals, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	update(settings: { baudRate: number }): Promise<void> {
		return new Promise((resolve, reject) => {
			if (!this.port.isOpen)
				reject(new Error("Port is not open"));
			this.port.update(settings, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve();
				}
			});
		});
	}

	getParentPort(): SerialPortStream<T> {
		return this.port;
	}
}
