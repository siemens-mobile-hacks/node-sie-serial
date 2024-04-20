export class AtChannel {
	constructor(port) {
		this.port = port;
		this.serialDataCallback = (data) => this._handleSerialData(data);
		this.buffer = "";
		this.verbose = false;
		this.unsolHandlers = [];
	}

	setVerbose(flag) {
		this.verbose = flag;
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

	_handleSerialData(data) {
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
		if (this.verbose)
			console.log(`AT -- ${line}`);

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
			});
		}
		this.currentCommand = false;
	}

	addUnsolicitedHandler(preifx, callback) {
		this.unsolHandlers.push({ prefix: `${prefix}:`, callback });
	}

	start() {
		this.port.on('data', this.serialDataCallback);
	}

	stop() {
		this.port.off('data', this.serialDataCallback);
		this.buffer = "";

		if (this.currentCommand)
			this._resolveCurrentCommand(false, "TIMEOUT");
	}

	async checkCommandExists(cmd, timeout) {
		let response = await this.sendCommand("NO_RESPONSE", cmd, "", timeout);
		if (response.success || response.status.match(/^\+(CME|CMS)/))
			return true;
		return false;
	}

	async sendRawCommand(type, cmd, prefix, cmdTimeout) {
		if ((type == "DEFAULT" || type == "MULTILINE") && prefix == "")
			type = "NO_RESPONSE";

		cmdTimeout ||= 10 * 1000;

		while (this.currentCommand) {
			await this.currentCommand.promise;
		}

		let timeout = setTimeout(() => this._resolveCurrentCommand(false, "TIMEOUT"), cmdTimeout);

		this.currentCommand = {
			lines: [],
			prefix,
			type,
			timeout
		};

		let promise = new Promise((resolve, reject) => {
			this.currentCommand.resolve = resolve;
			this.currentCommand.reject = reject;
		});
		this.currentCommand.promise = promise;

		if (this.verbose)
			console.log(`AT >> ${cmd}`);

		try {
			await serialPortAsyncWrite(this.port, `${cmd}\r`);
		} catch (e) {
			console.error(`[AtChannel]`, e);
			this._resolveCurrentCommand(false, "UNKNOWN");
		}

		let response = await promise;
		if (this.verbose) {
			if (type != "NO_PREFIX_ALL") {
				for (let line of response.lines)
					console.log(`AT << ${line}`);
			}

			if (response.status.length > 0)
				console.log(`AT << ${response.status}`);
		}

		return response;
	}

	async sendCommand(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("PREFIX", cmd, prefix, timeout);
	}

	async sendCommandNoPrefix(cmd, timeout = 0) {
		return this.sendRawCommand("NO_PREFIX", cmd, "", timeout);
	}

	async sendCommandNoPrefixAll(cmd, timeout = 0) {
		return this.sendRawCommand("NO_PREFIX_ALL", cmd, "", timeout);
	}

	async sendCommandMultiline(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("MULTILINE", cmd, prefix, timeout);
	}

	async sendCommandNumeric(cmd, timeout = 0) {
		return this.sendRawCommand("NUMERIC", cmd, "", timeout);
	}

	async sendCommandNumericOrWithPrefix(cmd, prefix = "", timeout = 0) {
		return this.sendRawCommand("NUMERIC", cmd, prefix, timeout);
	}

	async sendCommandNoResponse(cmd, timeout = 0) {
		return this.sendRawCommand("NO_RESPONSE", cmd, "", timeout);
	}

	async sendCommandDial(cmd, timeout = 0) {
		return this.sendRawCommand("DIAL", cmd, "", timeout);
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

async function serialPortAsyncWrite(port, data) {
	return new Promise((resolve, reject) => {
		port.write(data);
		port.drain((err) => {
			if (err) {
				reject(err);
			} else {
				resolve(true);
			}
		});
	});
}
