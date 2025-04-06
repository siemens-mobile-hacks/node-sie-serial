import { sprintf } from "sprintf-js";
import { AsyncSerialPort } from "./AsyncSerialPort.js";
import createDebug from "debug";
import { loadBootCode, LoadBootCodeOptions } from "./BSL.js";
import { decodeCString, hexdump } from "./utils.js";

const debug = createDebug('ebl');

enum CMD {
	SET_EBU_CONFIG	= 0x801,
	SET_BAUDRATE	= 0x82,
	CFI_STAGE1		= 0x84,
	CFI_STAGE2		= 0x85,
}

const BAUDRATES = [115200, 230400, 460800, 921600];

export class EBLError extends Error {
	constructor(message: string, ...args: any[]) {
		const errorMessage = sprintf(message, args);
		debug(errorMessage);
		super(errorMessage);
	}
}

export type EBLInfo = {
	mode: number;
	major: number;
	minor: number;
	name: string;
};

type EBUFlashConfig = {
	cs: number;
	addrsel: number;
	buscon: number;
	busap: number;
};

type EBUFLashInfo = {
	valid: boolean;
	vid: number;
	pid: number;
};

export class EBL {
	private readonly port: AsyncSerialPort;
	private eblInfo?: EBLInfo;

	constructor(port: AsyncSerialPort) {
		this.port = port;
	}

	getSupportedBaudrates() {
		return BAUDRATES;
	}

	async connect(options: LoadBootCodeOptions = {}): Promise<void> {
		const bootStatus = await loadBootCode(this.port, Buffer.from([0x00F020E3, 0xFDFFFFEA]), options);
		if (!bootStatus.success)
			throw new EBLError(bootStatus.error);

		debug("Waiting response from EBL...");

		const response = await this.port.read(76, 100);
		if (!response)
			throw new EBLError("No response from EBL! (ebl info)");

		const mode = response.readUInt32LE(0);
		const major = response.readUInt32LE(4);
		const minor = response.readUInt32LE(8);
		const name = decodeCString(response.subarray(12));

		debug(sprintf("Boot mode: %02X", mode));
		debug(sprintf("EBL: %s %d.%d", name, major, minor));

		this.eblInfo = { mode, major, minor, name };
		await this.setBaudrate(115200);
	}

	async setupEBU(flashConfig: EBUFlashConfig[]) {
		const cmd = Buffer.alloc(88);
		let offset = 0;
		offset = cmd.writeUInt32LE(5, offset);
		offset = cmd.writeUInt32LE(0x04020000, offset);
		offset = cmd.writeUInt32LE(115200, offset);
		offset = cmd.writeUInt32LE(2, offset);
		offset = cmd.writeUInt32LE(1, offset);
		offset = cmd.writeUInt32LE(0, offset);

		for (let i = 0; i < 4; i++) {
			offset = cmd.writeUInt32LE(flashConfig[i].cs, offset);
			offset = cmd.writeUInt32LE(flashConfig[i].addrsel, offset);
			offset = cmd.writeUInt32LE(flashConfig[i].buscon, offset);
			offset = cmd.writeUInt32LE(flashConfig[i].busap, offset);
		}

		await this.sendCommand(CMD.SET_EBU_CONFIG, cmd);

		let flashInfo: EBUFLashInfo[] = [];
		let responseCFI1 = await this.sendCommand(CMD.CFI_STAGE1, Buffer.from([0, 0]));
		for (let i = 0; i < 4; i++) {
			const cfiOffset = i * 64;
			const cfi = responseCFI1.subarray(cfiOffset, cfiOffset + 64);
			const valid = cfi.readUInt32LE(0) == 1;
			const vid = cfi.readUInt32LE(4);
			const pid = cfi.readUInt32LE(8);
			flashInfo.push({ valid, vid, pid });
		}

		return flashInfo;
	}

	async setBaudrate(baudrate: number): Promise<boolean> {
		const cmd = Buffer.alloc(4);
		cmd.writeUInt32LE(baudrate);
		const response = await this.sendCommand(CMD.SET_BAUDRATE, cmd);
		const receivedBaudrate = response.readUInt32LE(0);
		if (receivedBaudrate == baudrate) {
			await this.port.update({ baudRate: baudrate });
			return true;
		}
		return false;
	}

	private async sendCommand(cmd: number, payload?: Buffer) {
		await this.sendPacket(cmd, payload);
		return await this.recvPacket(cmd);
	}

	private async sendPacket(cmd: number, payload?: Buffer): Promise<void> {
		const pkt = Buffer.concat([ Buffer.alloc(6), payload ? payload : Buffer.alloc(0), Buffer.alloc(4) ]);
		const size = (payload?.length ?? 0);
		pkt.writeUInt16LE(2, 0);
		pkt.writeUInt16LE(cmd, 2);
		pkt.writeUInt16LE(size, 4);

		const chk = EBL.checksum(cmd, pkt.subarray(6, 6 + size));
		pkt.writeUInt16LE(chk, pkt.length - 4);
		pkt.writeUInt16LE(3, pkt.length - 2);

		debug.enabled && debug(sprintf("[TX] %s", hexdump(pkt)));

		await this.port.write(pkt);
	}

	private async recvPacket(fromCmd: number): Promise<Buffer> {
		const header = await this.port.read(6, 1000);
		if (!header)
			throw new EBLError("No response from EBL! (pkt header)");
		const pktStartToken = header.readUInt16LE(0);
		const cmd = header.readUInt16LE(2);
		const size = header.readUInt16LE(4);

		if (fromCmd != cmd)
			throw new EBLError("Invalid packet cmd=%02X, but expected cmd=%02X", cmd, fromCmd);

		if (pktStartToken != 2)
			throw new EBLError("Invalid packet, pktStartToken=%02X", pktStartToken);

		const body = await this.port.read(size + 4, 1000);
		if (!body)
			throw new EBLError("No response from EBL! (pkt body)");

		const chk = body.readUInt16LE(size);
		const pktEndToken = body.readUInt16LE(size + 2);

		if (pktEndToken != 3)
			throw new EBLError("Invalid packet, pktEndToken=%02X", pktEndToken);

		const realChk = EBL.checksum(cmd, body.subarray(0, size));
		if (chk != realChk)
			throw new EBLError("Invalid packet, data corrupted (received=%02X, real=%02X)", chk, realChk);

		debug.enabled && debug(sprintf("[RX] %s %s", hexdump(header), hexdump(body)));

		return body.subarray(0, size);
	}

	async disconnect(): Promise<void> {
		// TODO
	}

	private static checksum(cmd: number, data: Buffer) {
		let chk = (cmd + data.length) & 0xFFFF;
		for (let i = 0; i < data.length; i++)
			chk = (chk + data[i]) & 0xFFFF;
		return chk;
	}
}
