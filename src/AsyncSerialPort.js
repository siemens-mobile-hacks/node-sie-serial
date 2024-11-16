export class AsyncSerialPort {
	port;

	constructor(port) {
		this.port = port;
	}

	on(event, callback) {
		return this.port.on(event, callback);
	}

	off(event, callback) {
		return this.port.off(event, callback);
	}

	isOpen() {
		return this.port.isOpen;
	}

	getBaudrate() {
		return this.port.baudRate;
	}

	open() {
		if (this.port.isOpen)
			return true;

		return new Promise((resolve, reject) => {
			this.port.open((err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	async close() {
		if (!this.port.isOpen)
			return true;

		return new Promise((resolve, reject) => {
			this.port.close((err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	async readByte(timeout = 0) {
		let byte = await this.read(1, timeout);
		return byte == null ? -1 : byte[0];
	}

	read(size, timeout) {
		return new Promise((resolve, reject) => {
			let result;
			let bytesRead = 0;
			let timeoutTimer;

			let removeListeners = () => {
				this.port.removeListener("close", onClose);
				this.port.removeListener("end", onEnd);
				this.port.removeListener("error", onError);
				this.port.removeListener("readable", onReadable);

				if (timeoutTimer)
					clearTimeout(timeoutTimer);
			};
			let onTimeout = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			let onClose = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			let onEnd = () => {
				removeListeners();
				resolve(result?.subarray(0, bytesRead));
			};
			let onError = (err) => {
				removeListeners();
				reject(err);
			};
			let onReadable = () => {
				let bytesToRead = Math.min(size - bytesRead, this.port.readableLength);
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

			this.port.on("close", onClose);
			this.port.on("end", onEnd);
			this.port.on("error", onError);
			this.port.on("readable", onReadable);

			if (timeout)
				timeoutTimer = setTimeout(onTimeout, timeout);
		});
	}

	write(data) {
		return new Promise((resolve, reject) => {
			this.port.write(data);
			this.port.drain((err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	getSignals() {
		return new Promise((resolve, reject) => {
			this.port.get((err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	setSignals(signals) {
		return new Promise((resolve, reject) => {
			this.port.set(signals, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	update(settings) {
		return new Promise((resolve, reject) => {
			this.port.update(settings, (err) => {
				if (err) {
					reject(err);
				} else {
					resolve(true);
				}
			});
		});
	}

	getPort() {
		return this.port;
	}
}
