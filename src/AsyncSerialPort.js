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
				resolve(result);
			};
			let onClose = () => {
				removeListeners();
				resolve(result);
			};
			let onEnd = () => {
				removeListeners();
				resolve(result);
			};
			let onError = (err) => {
				removeListeners();
				reject(err);
			};
			let onReadable = () => {
				let chunk = this.port.read(size - bytesRead);
				if (chunk == null)
					return;

				if (result) {
					result = Buffer.concat([result, chunk]);
				} else {
					result = chunk;
				}

				if (result.length == size) {
					removeListeners();
					resolve(result);
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
