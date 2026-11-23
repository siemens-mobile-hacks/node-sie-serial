import { sprintf } from "sprintf-js";
import createDebug from "debug";
import { loadBootCode, BSLCpu, BSLOptions } from '#src/boot/BSL.js';
import { decodeCString, hexdump } from '#src/utils.js';
import { BaseSerialProtocol } from '#src/BaseSerialProtocol.js';

const debug = createDebug('ebl');

enum CMD {
	SET_EBU_CONFIG	= 0x801,
	SET_BAUDRATE	= 0x82,
	BAD_BAUDRATE	= 0x83,
	CFI_STAGE1		= 0x84,
	CFI_STAGE2		= 0x85,
	STOP_TIMEOUT	= 0x102,
	IMAGE_HEADER	= 0x204,
	VERIFY_IMAGE	= 0x205,
	SET_ADDRESS		= 0x802,
	READ			= 0x803,
	WRITE			= 0x804,
	ERASE			= 0x805,
	ERASE_STATUS	= 0x806,
	FILL			= 0x808,
}

const BAUDRATES = [115200, 230400, 460800, 921600];

export class EBLError extends Error {
	constructor(message: string, ...args: any[]) {
		const errorMessage = sprintf(message, ...args);
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

export type EBLConnectOptions = BSLOptions & {
	skipBSL?: boolean;
};

export type EBLEraseStatus = {
	idle: boolean;
	nextAddress: number;
	raw: Buffer;
};

type EBLPacket = {
	cmd: number;
	payload: Buffer;
};

async function loadEBLCode(): Promise<(cpu: BSLCpu) => Buffer> {
	const [{ EBL_SGOLD1 }, { EBL_SGOLD2 }, { EBL_SGOLD3 }] = await Promise.all([
		import('./ebl_sgold1.bin.js'),
		import('./ebl_sgold2.bin.js'),
		import('./ebl_sgold3.bin.js'),
	]);
	return (cpu) => {
		switch (cpu) {
			case 'pmb8875':
				return EBL_SGOLD1;
			case 'pmb8876':
				return EBL_SGOLD2;
			case 'pmb8877':
				return EBL_SGOLD3;
			case 'pmb887x':
				throw new EBLError('EBL is not available for unknown CPU.');
		}
	};
}

export class EBL extends BaseSerialProtocol {
	private eblInfo?: EBLInfo;

	getSupportedBaudrates() {
		return BAUDRATES;
	}

	async connect(options: EBLConnectOptions = {}): Promise<void> {
		if (!options.skipBSL) {
			const getEBLCode = await loadEBLCode();
			const bootStatus = await loadBootCode(this.port, ({ cpu }) => getEBLCode(cpu), options);
			if (!bootStatus.success)
				throw new EBLError(bootStatus.error);
		}

		debug("Waiting response from EBL...");

		const response = await this.port.readExact(76, 100);

		const mode = response.readUInt32LE(0);
		const major = response.readUInt32LE(4);
		const minor = response.readUInt32LE(8);
		const name = decodeCString(response.subarray(12));

		debug(sprintf("Boot mode: %02X", mode));
		debug(sprintf("EBL: %s %d.%d", name, major, minor));

		this.eblInfo = { mode, major, minor, name };
	}

	getInfo() {
		if (!this.eblInfo)
			throw new EBLError("Not connected!");
		return this.eblInfo;
	}

	async getFlashInfo(buffer?: Buffer): Promise<Buffer> {
		const response = await this.sendCommand(CMD.CFI_STAGE1, buffer ?? Buffer.from([0, 0]));
		if (!response.length)
			throw new EBLError('Invalid CFI stage 1 response length: %d', response.length);
		return response;
	}

	async selectFlashDriver(flashInfo: Buffer): Promise<number> {
		const response = await this.sendCommand(CMD.CFI_STAGE2, flashInfo);
		if (response.length < 2)
			throw new EBLError('Invalid CFI stage 2 response length: %d', response.length);
		return response.readUInt16LE(0);
	}

	async stopTimeout(): Promise<Buffer> {
		return await this.sendCommand(CMD.STOP_TIMEOUT);
	}

	async sendImageHeader(header: Buffer): Promise<number> {
		if (header.length > 0x800)
			throw new EBLError('Image header is too large: %d', header.length);

		const response = await this.sendCommand(CMD.IMAGE_HEADER, header);
		if (response.length < 1)
			throw new EBLError('Invalid image header response length: %d', response.length);
		return response[0];
	}

	async verifyImage(): Promise<number> {
		const response = await this.sendCommand(CMD.VERIFY_IMAGE);
		if (response.length < 1)
			throw new EBLError('Invalid verify image response length: %d', response.length);
		return response[0];
	}

	async configureMemory(config: Buffer): Promise<Buffer> {
		if (config.length != 0x58)
			throw new EBLError('Memory configuration must be exactly 0x58 bytes, got %d', config.length);

		const response = await this.sendCommand(CMD.SET_EBU_CONFIG, config);
		if (response.length != 0x14)
			throw new EBLError('Invalid memory configuration response length: %d', response.length);
		return response;
	}

	async setAddress(address: number): Promise<Buffer> {
		const payload = Buffer.alloc(4);
		payload.writeUInt32LE(address);
		const response = await this.sendCommand(CMD.SET_ADDRESS, payload);
		if (response.length != 6)
			throw new EBLError('Invalid set address response length: %d', response.length);
		return response;
	}

	async readFlash(size: number): Promise<Buffer> {
		if (!Number.isInteger(size) || size < 1 || size > 0x800)
			throw new EBLError('Invalid flash read size: %d', size);

		const payload = Buffer.alloc(2);
		payload.writeUInt16LE(size);
		const response = await this.sendCommand(CMD.READ, payload);
		if (response.length != size)
			throw new EBLError('Invalid flash read response length: %d, expected: %d', response.length, size);
		return response;
	}

	async writeFlash(data: Buffer): Promise<number> {
		if (data.length < 2 || data.length > 0x800 || (data.length & 1) != 0)
			throw new EBLError('Flash write size must be even and between 2 and 0x800 bytes, got %d', data.length);

		const response = await this.sendCommand(CMD.WRITE, data);
		if (response.length < 2)
			throw new EBLError('Invalid flash write response length: %d', response.length);
		return response.readUInt16LE(0);
	}

	async eraseFlash(start: number, end: number): Promise<number> {
		if (end < start)
			throw new EBLError('Invalid erase range: %08X-%08X', start, end);

		const payload = Buffer.alloc(8);
		payload.writeUInt32LE(start, 0);
		payload.writeUInt32LE(end, 4);
		const response = await this.sendCommand(CMD.ERASE, payload);
		if (response.length < 2)
			throw new EBLError('Invalid erase response length: %d', response.length);
		return response.readUInt16LE(0);
	}

	async getEraseStatus(): Promise<EBLEraseStatus> {
		const response = await this.sendCommand(CMD.ERASE_STATUS);
		if (response.length != 6)
			throw new EBLError('Invalid erase status response length: %d', response.length);

		return {
			idle: response[0] != 0,
			nextAddress: response.readUInt32LE(1),
			raw: response,
		};
	}

	async fillFlash(value: number): Promise<number> {
		const payload = Buffer.alloc(1);
		payload.writeUInt8(value);
		await this.sendPacket(CMD.FILL, payload);
		const response = await this.recvPacket(CMD.WRITE);
		if (response.payload.length < 2)
			throw new EBLError('Invalid flash fill response length: %d', response.payload.length);
		return response.payload.readUInt16LE(0);
	}

	async setBaudrate(baudrate: number): Promise<boolean> {
		const cmd = Buffer.alloc(4);
		cmd.writeUInt32LE(baudrate);
		await this.sendPacket(CMD.SET_BAUDRATE, cmd);
		const response = await this.recvPacket([CMD.SET_BAUDRATE, CMD.BAD_BAUDRATE]);
		if (response.cmd == CMD.BAD_BAUDRATE)
			return false;
		if (response.payload.length < 4)
			throw new EBLError('Invalid set baudrate response length: %d', response.payload.length);

		const receivedBaudrate = response.payload.readUInt32LE(0);
		if (receivedBaudrate == baudrate) {
			await this.port.update({ baudRate: baudrate });
			return true;
		}
		return false;
	}

	async sendCommand(cmd: number, payload?: Buffer) {
		await this.sendPacket(cmd, payload);
		return (await this.recvPacket(cmd)).payload;
	}

	async sendPacket(cmd: number, payload?: Buffer): Promise<void> {
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

	async recvPacket(fromCmd: number | number[]): Promise<EBLPacket> {
		const header = await this.port.readExact(6, 1000);
		const pktStartToken = header.readUInt16LE(0);
		const cmd = header.readUInt16LE(2);
		const size = header.readUInt16LE(4);

		const expectedCommands = Array.isArray(fromCmd) ? fromCmd : [fromCmd];
		if (!expectedCommands.includes(cmd))
			throw new EBLError('Invalid packet cmd=%02X, but expected cmd=%s', cmd, expectedCommands.map(v => sprintf('%02X', v)).join('/'));

		if (pktStartToken != 2)
			throw new EBLError("Invalid packet, pktStartToken=%02X", pktStartToken);

		const body = await this.port.readExact(size + 4, 1000);

		const chk = body.readUInt16LE(size);
		const pktEndToken = body.readUInt16LE(size + 2);

		if (pktEndToken != 3)
			throw new EBLError("Invalid packet, pktEndToken=%02X", pktEndToken);

		const realChk = EBL.checksum(cmd, body.subarray(0, size));
		if (chk != realChk)
			throw new EBLError("Invalid packet, data corrupted (received=%02X, real=%02X)", chk, realChk);

		debug.enabled && debug(sprintf("[RX] %s %s", hexdump(header), hexdump(body)));

		return { cmd, payload: body.subarray(0, size) };
	}

	async disconnect(): Promise<void> {
		// Not implemented!
	}

	private static checksum(cmd: number, data: Buffer) {
		let chk = (cmd + data.length) & 0xFFFF;
		for (let i = 0; i < data.length; i++)
			chk = (chk + data[i]) & 0xFFFF;
		return chk;
	}
}
