import createDebug from 'debug';
import { serialPortAsyncWrite } from './utils.js';

let debug = createDebug('atc');

export class AtChannel {
	port;
	serialDataCallback;
	buffer;
	unsolHandlers;
	paused = true;

	constructor(port = null) {
		this.port = port;
		this.serialDataCallback = (data) => this._handleSerialData(data);
		this.serialCloseCallback = () => this._handleSerialClose();
		this.buffer = "";
		this.unsolHandlers = [];
	}

	_isErrorResponse(line, dial) {
		if (line.match(/^(ERROR|\+CMS ERROR|\+CME ERROR)/))
			return true;

		if (dial) {
			if (line.match(/^(NO CARRIER|NO ANSWER|NO DIALTONE)/))
				return true;
		}

		return false;
	}

	_isSuccessResponse(line, dial) {
		if (line == "OK")
			return true;

		if (dial) {
			if (line == "CONNECT")
				return true;
		}

		return false;
	}

	_handleSerialClose() {
		this.stop();
	}

	_handleSerialData(data) {
		let cmd = this.currentCommand;
		if (cmd && cmd.type == "BINARY") {
			let chunkSize = Math.min(data.length, cmd.buffer.length - cmd.binaryOffset);
			data.copy(cmd.buffer, cmd.binaryOffset, 0, chunkSize);
			cmd.binaryOffset += chunkSize;
			data = data.slice(chunkSize);

			if (!data.length)
				return;

			cmd.type = "NO_RESPONSE";
		}

		this.buffer += data.toString();

		let newLineIndex;
		do {
			newLineIndex = this.buffer.indexOf("\r\n");
			if (newLineIndex >= 0) {
				let line = this.buffer.substr(0, newLineIndex);
				this.buffer = this.buffer.substr(newLineIndex + 2);
				if (line.length > 0)
					this._handleLine(line);
			}
		} while (newLineIndex >= 0);
	}

	_handleUnsolicitedLine(line) {
		debug(`AT -- ${line}`);

		for (let h of this.unsolHandlers) {
			if (line.startsWidth(h.prefix))
				h.callback(line);
		}
	}

	_handleLine(line) {
		let cmd = this.currentCommand;
		if (!cmd) {
			this._handleUnsolicitedLine(line);
			return;
		}

		if (this._isSuccessResponse(line, cmd.type == "DIAL")) {
			this._resolveCurrentCommand(true, line);
			return;
		}

		if (this._isErrorResponse(line, cmd.type == "DIAL")) {
			this._resolveCurrentCommand(false, line);
			return;
		}

		switch (cmd.type) {
			case "PREFIX":
				if (line.startsWith(cmd.prefix)) {
					cmd.lines.push(line);
				} else {
					this._handleUnsolicitedLine(line);
				}
			break;

			case "NO_PREFIX_ALL":
				cmd.lines.push(line);
				this._handleUnsolicitedLine(line);
			break;

			case "NO_PREFIX":
				if (line.match(/^[+*^!]/)) {
					this._handleUnsolicitedLine(line);
				} else {
					cmd.lines.push(line);
				}
			break;

			case "NUMERIC":
				if (cmd.prefix.length > 0 && line.startsWith(cmd.prefix)) {
					cmd.lines.push(line);
				} else if (line.match(/^[0-9]/)) {
					cmd.lines.push(line);
				} else {
					this._handleUnsolicitedLine(line);
				}
			break;

			case "MULTILINE":
				if (line.startsWith(cmd.prefix)) {
					cmd.lines.push(line);
				} else if (cmd.lines.length > 0) {
					if (line.match(/^[+*^!]/)) {
						this._handleUnsolicitedLine(line);
					} else {
						cmd.lines[0] += `\r\n${line}`;
					}
				} else {
					this._handleUnsolicitedLine(line);
				}
			break;

			default:
				this._handleUnsolicitedLine(line);
			break;
		}
	}

	_resolveCurrentCommand(success, status) {
		let cmd = this.currentCommand;
		if (cmd) {
			clearTimeout(cmd.timeout);
			cmd.resolve({
				success,
				status,
				lines: cmd.lines,
				binary: cmd.buffer?.slice(2),
			});
		}
		this.currentCommand = false;
	}

	addUnsolicitedHandler(prefix, callback) {
		this.unsolHandlers.push({ prefix: `${prefix}:`, callback });
	}

	start() {
		if (this.paused) {
			this.paused = false;
			this.port.on('data', this.serialDataCallback);
			this.port.on('close', this.serialCloseCallback);
		}
	}

	stop() {
		if (!this.paused) {
			this.paused = true;
			this.port.off('data', this.serialDataCallback);
			this.port.off('close', this.serialCloseCallback);
			this.buffer = "";

			if (this.currentCommand)
				this._resolveCurrentCommand(false, "TIMEOUT");
		}
	}

	destroy() {
		this.port = null;
	}

	async checkCommandExists(cmd, timeout) {
		let response = await this.sendCommand("NO_RESPONSE", cmd, "", timeout);
		if (response.success || response.status.match(/^\+(CME|CMS)/))
			return true;
		return false;
	}

	async sendRawCommand(type, cmd, prefix, { timeout, binarySize }) {
		if ((type == "DEFAULT" || type == "MULTILINE") && prefix == "")
			type = "NO_RESPONSE";

		timeout ||= 10 * 1000;

		while (this.currentCommand) {
			await this.currentCommand.promise;
		}

		let timeoutId = setTimeout(() => this._resolveCurrentCommand(false, "TIMEOUT"), timeout);
		let buffer;

		if (type == "BINARY") {
			buffer = Buffer.alloc(binarySize + 2);
		}

		this.currentCommand = {
			lines: [],
			prefix,
			type,
			timeout: timeoutId,
			buffer,
			binaryOffset: 0
		};

		let promise = new Promise((resolve, reject) => {
			this.currentCommand.resolve = resolve;
			this.currentCommand.reject = reject;
		});
		this.currentCommand.promise = promise;

		debug(`AT >> ${cmd}`);

		try {
			await serialPortAsyncWrite(this.port, `${cmd}\r`);
		} catch (e) {
			console.error(`[AtChannel]`, e);
			this._resolveCurrentCommand(false, "PORT_CLOSED");
		}

		let response = await promise;
		if (type != "NO_PREFIX_ALL") {
			for (let line of response.lines)
				debug(`AT << ${line}`);

			if (response.status.length > 0)
				debug(`AT << ${response.status}`);
		}

		return response;
	}

	async sendCommandBinaryResponse(cmd, binarySize, timeout = 0) {
		return this.sendRawCommand("BINARY", cmd, "", { timeout, binarySize });
	}

	async sendCommand(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("PREFIX", cmd, prefix, { timeout });
	}

	async sendCommandNoPrefix(cmd, timeout = 0) {
		return this.sendRawCommand("NO_PREFIX", cmd, "", { timeout });
	}

	async sendCommandNoPrefixAll(cmd, timeout = 0) {
		return this.sendRawCommand("NO_PREFIX_ALL", cmd, "", { timeout });
	}

	async sendCommandMultiline(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("MULTILINE", cmd, prefix, { timeout });
	}

	async sendCommandNumeric(cmd, timeout = 0) {
		return this.sendRawCommand("NUMERIC", cmd, "", { timeout });
	}

	async sendCommandNumericOrWithPrefix(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("NUMERIC", cmd, prefix, { timeout });
	}

	async sendCommandNoResponse(cmd, timeout = 0) {
		return this.sendRawCommand("NO_RESPONSE", cmd, "", { timeout });
	}

	async sendCommandDial(cmd, timeout = 0) {
		return this.sendRawCommand("DIAL", cmd, "", { timeout });
	}

	async handshake(tries = 3) {
		for (let i = 0; i < tries; i++) {
			let response = await this.sendCommandNoResponse("ATQ0 V1 E0", 150);
			if (response.success)
				return true;
		}
		return false;
	}
}

