import { AsyncSerialPort } from "./AsyncSerialPort.js";

export class BaseSerialProtocol {
	#port?: AsyncSerialPort;

	protected get port(): AsyncSerialPort {
		if (!this.#port)
			throw new Error("Serial port not attached!");
		return this.#port;
	}

	protected set port(port: AsyncSerialPort | undefined) {
		this.#port = port;
	}

	constructor(port?: AsyncSerialPort) {
		this.port = port;
	}

	attachSerialPort(port: AsyncSerialPort) {
		this.port = port;
	}

	detachSerialPort() {
		this.port = undefined;
	}

	getSerialPort() {
		return this.#port;
	}
}
