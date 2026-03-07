import { AsyncSerialPort } from "./AsyncSerialPort.js";

export class BaseSerialProtocol {
	protected readonly port: AsyncSerialPort;

	constructor(port: AsyncSerialPort) {
		this.port = port;
	}

	getSerialPort() {
		return this.port;
	}
}
