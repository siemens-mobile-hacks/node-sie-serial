import createDebug from 'debug';
import { AsyncSerialPort } from './AsyncSerialPort.js';
import { usePromiseWithResolvers } from "./utils.js";

const debug = createDebug('atc');

export type AtCommandResponse = {
	success: boolean;
	status: string;
	lines: string[];
	binary?: Buffer;
};

export type AtCommandOptions = {
	timeout?: number;
	binarySize?: number;
};

export type AtCommandType = "DEFAULT" | "MULTILINE" | "PREFIX" | "NO_RESPONSE" | "NO_PREFIX" | "NO_PREFIX_ALL" | "BINARY" | "NUMERIC" | "DIAL";

export type AtUnsolicitedHandler = {
	prefix: string;
	callback: (line: string) => void;
};

export class AtChannel {
	private port: AsyncSerialPort<any>;
	private buffer: string = "";
	private unsolicitedHandlers: AtUnsolicitedHandler[] = [];
	private paused = true;
	private currentCommand: {
		lines: string[];
		prefix: string;
		type: string;
		timeout: NodeJS.Timeout;
		buffer?: Buffer;
		binaryOffset: number;
		promise: Promise<AtCommandResponse>;
		resolve: (value: AtCommandResponse) => void;
		reject: (e: Error) => void;
	} | undefined;
	private readonly handleSerialDataCallback = this.handleSerialData.bind(this);
	private readonly handleSerialCloseCallback = this.handleSerialClose.bind(this);

	constructor(port: AsyncSerialPort<any>) {
		this.port = port;
	}

	private handleSerialClose() {
		this.stop();
	}

	private handleSerialData(data: Buffer) {
		const cmd = this.currentCommand;
		if (cmd && cmd.type == "BINARY") {
			const chunkSize = Math.min(data.length, cmd.buffer!.length - cmd.binaryOffset);
			data.copy(cmd.buffer!, cmd.binaryOffset, 0, chunkSize);
			cmd.binaryOffset += chunkSize;
			data = data.subarray(chunkSize);
			if (!data.length)
				return;
			cmd.type = "NO_RESPONSE";
		}

		this.buffer += data.toString();

		let newLineIndex: number;
		do {
			newLineIndex = this.buffer.indexOf("\r\n");
			if (newLineIndex >= 0) {
				const line = this.buffer.substring(0, newLineIndex);
				this.buffer = this.buffer.substring(newLineIndex + 2);
				if (line.length > 0)
					this.handleLine(line);
			}
		} while (newLineIndex >= 0);
	}

	private handleUnsolicitedLine(line: string) {
		debug(`AT -- ${line}`);
		for (const h of this.unsolicitedHandlers) {
			if (line.startsWith(h.prefix))
				h.callback(line);
		}
	}

	private handleLine(line: string) {
		const cmd = this.currentCommand;
		if (!cmd) {
			this.handleUnsolicitedLine(line);
			return;
		}

		if (isSuccessResponse(line, cmd.type == "DIAL")) {
			this.resolveCurrentCommand(true, line);
			return;
		}

		if (isErrorResponse(line, cmd.type == "DIAL")) {
			this.resolveCurrentCommand(false, line);
			return;
		}

		switch (cmd.type) {
			case "PREFIX":
				if (line.startsWith(cmd.prefix)) {
					cmd.lines.push(line);
				} else {
					this.handleUnsolicitedLine(line);
				}
			break;

			case "NO_PREFIX_ALL":
				cmd.lines.push(line);
				this.handleUnsolicitedLine(line);
			break;

			case "NO_PREFIX":
				if (line.match(/^[+*^!]/)) {
					this.handleUnsolicitedLine(line);
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
					this.handleUnsolicitedLine(line);
				}
			break;

			case "MULTILINE":
				if (line.startsWith(cmd.prefix)) {
					cmd.lines.push(line);
				} else if (cmd.lines.length > 0) {
					if (line.match(/^[+*^!]/)) {
						this.handleUnsolicitedLine(line);
					} else {
						cmd.lines[0] += `\r\n${line}`;
					}
				} else {
					this.handleUnsolicitedLine(line);
				}
			break;

			default:
				this.handleUnsolicitedLine(line);
			break;
		}
	}

	private resolveCurrentCommand(success: boolean, status: string) {
		const cmd = this.currentCommand;
		if (cmd) {
			clearTimeout(cmd.timeout);
			cmd.resolve({
				success,
				status,
				lines: cmd.lines,
				binary: cmd.buffer?.subarray(2),
			});
		}
		this.currentCommand = undefined;
	}

	addUnsolicitedHandler(prefix: string, callback: AtUnsolicitedHandler["callback"]) {
		this.unsolicitedHandlers.push({ prefix: `${prefix}:`, callback });
	}

	start() {
		if (this.paused) {
			this.paused = false;
			this.port.on('data', this.handleSerialDataCallback);
			this.port.on('close', this.handleSerialCloseCallback);
		}
	}

	stop() {
		if (!this.paused) {
			this.paused = true;
			this.port.off('data', this.handleSerialDataCallback);
			this.port.off('close', this.handleSerialCloseCallback);
			this.buffer = "";

			if (this.currentCommand)
				this.resolveCurrentCommand(false, "TIMEOUT");
		}
	}

	private async sendRawCommand(type: AtCommandType, cmd: string, prefix: string, { timeout, binarySize }: AtCommandOptions): Promise<AtCommandResponse> {
		if ((type == "DEFAULT" || type == "MULTILINE") && prefix == "")
			type = "NO_RESPONSE";

		timeout ||= 10 * 1000;

		while (this.currentCommand) {
			await this.currentCommand.promise;
		}

		const { promise, resolve, reject } = usePromiseWithResolvers<AtCommandResponse>();

		this.currentCommand = {
			lines: [],
			prefix,
			type,
			timeout: setTimeout(() => this.resolveCurrentCommand(false, "TIMEOUT"), timeout),
			binaryOffset: 0,
			promise,
			reject,
			resolve
		};

		if (type == "BINARY") {
			this.currentCommand.buffer = Buffer.alloc(binarySize! + 2);
		}

		debug(`AT >> ${cmd}`);

		try {
			await this.port.write(`${cmd}\r`);
		} catch (e) {
			console.error(`[AtChannel]`, e);
			this.resolveCurrentCommand(false, "PORT_CLOSED");
		}

		const response = await promise;
		if (type != "NO_PREFIX_ALL") {
			for (const line of response.lines)
				debug(`AT << ${line}`);
			if (response.status.length > 0)
				debug(`AT << ${response.status}`);
		}

		return response;
	}

	async checkCommandExists(cmd: string, timeout: number = 0) {
		const response = await this.sendRawCommand("NO_RESPONSE", cmd, "", { timeout });
		return !!(response.success || response.status.match(/^\+(CME|CMS)/));
	}

	async sendCommand(cmd: string, prefix = "", timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("PREFIX", cmd, prefix, { timeout });
	}

	async sendCommandBinaryResponse(cmd: string, binarySize: number, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("BINARY", cmd, "", { timeout, binarySize });
	}

	async sendCommandNoPrefix(cmd: string, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("NO_PREFIX", cmd, "", { timeout });
	}

	async sendCommandNoPrefixAll(cmd: string, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("NO_PREFIX_ALL", cmd, "", { timeout });
	}

	async sendCommandMultiline(cmd: string, prefix = "", timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("MULTILINE", cmd, prefix, { timeout });
	}

	async sendCommandNumeric(cmd: string, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("NUMERIC", cmd, "", { timeout });
	}

	async sendCommandNumericOrWithPrefix(cmd: string, prefix = "", timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("NUMERIC", cmd, prefix, { timeout });
	}

	async sendCommandNoResponse(cmd: string, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("NO_RESPONSE", cmd, "", { timeout });
	}

	async sendCommandDial(cmd: string, timeout = 0): Promise<AtCommandResponse> {
		return this.sendRawCommand("DIAL", cmd, "", { timeout });
	}

	async handshake(tries = 3): Promise<boolean> {
		for (let i = 0; i < tries; i++) {
			const response = await this.sendCommandNoResponse("ATQ0 V1 E0", 150);
			if (response.success)
				return true;
		}
		return false;
	}
}

function isErrorResponse(line: string, dial: boolean): boolean {
	if (line.match(/^(ERROR|\+CMS ERROR|\+CME ERROR)/))
		return true;
	if (dial) {
		if (line.match(/^(NO CARRIER|NO ANSWER|NO DIALTONE)/))
			return true;
	}
	return false;
}

function isSuccessResponse(line: string, dial: boolean): boolean {
	if (line == "OK")
		return true;
	if (dial) {
		if (line == "CONNECT")
			return true;
	}
	return false;
}
