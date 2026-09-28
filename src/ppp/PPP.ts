import createDebug from 'debug';
import { createHash } from 'node:crypto';
import { BaseSerialProtocol } from '#src/BaseSerialProtocol.js';
import { usePromiseWithResolvers } from '#src/utils.js';

const debug = createDebug('ppp');

const PPP_FLAG = 0x7E;
const PPP_ESCAPE = 0x7D;
const PPP_ESCAPE_XOR = 0x20;
const PPP_FCS_INITIAL = 0xFFFF;
const PPP_FCS_GOOD = 0xF0B8;

enum PppProtocol {
	IPV4 = 0x0021,
	IPCP = 0x8021,
	LCP = 0xC021,
	PAP = 0xC023,
	CHAP = 0xC223,
}

enum PppControlCode {
	CONFIGURE_REQUEST = 1,
	CONFIGURE_ACK = 2,
	CONFIGURE_NAK = 3,
	CONFIGURE_REJECT = 4,
	TERMINATE_REQUEST = 5,
	TERMINATE_ACK = 6,
	CODE_REJECT = 7,
	PROTOCOL_REJECT = 8,
	ECHO_REQUEST = 9,
	ECHO_REPLY = 10,
}

enum PapCode {
	AUTHENTICATE_REQUEST = 1,
	AUTHENTICATE_ACK = 2,
	AUTHENTICATE_NAK = 3,
}

enum ChapCode {
	CHALLENGE = 1,
	RESPONSE = 2,
	SUCCESS = 3,
	FAILURE = 4,
}

const CHAP_MD5 = 5;

enum LcpOption {
	MRU = 1,
	ACCM = 2,
	AUTHENTICATION_PROTOCOL = 3,
	MAGIC_NUMBER = 5,
	PROTOCOL_FIELD_COMPRESSION = 7,
	ADDRESS_CONTROL_COMPRESSION = 8,
}

enum IpcpOption {
	IP_COMPRESSION_PROTOCOL = 2,
	IP_ADDRESS = 3,
	PRIMARY_DNS = 129,
	SECONDARY_DNS = 131,
}

type PppPacket = {
	protocol: number;
	payload: Buffer;
};

export type PppConnectOptions = {
	username?: string;
	password?: string;
	timeout?: number;
	retryInterval?: number;
};

export type PppConnectionInfo = {
	localAddress: string;
	remoteAddress?: string;
	primaryDns?: string;
	secondaryDns?: string;
};

export type PppPingResult = {
	address: string;
	bytes: number;
	time: number;
	ttl: number;
};

type ControlPacket = {
	code: number;
	identifier: number;
	data: Buffer;
};

type PacketWaiter = {
	resolve: (packet: PppPacket | undefined) => void;
	timer: NodeJS.Timeout;
};

export class PPP extends BaseSerialProtocol {
	private frame: number[] = [];
	private receivingFrame = false;
	private escaped = false;
	private running = false;
	private identifier = 0;
	private pingSequence = 0;
	private receiveAccm = 0xFFFFFFFF;
	private transmitAccm = 0xFFFFFFFF;
	private transmitProtocolCompressed = false;
	private transmitAddressControlCompressed = false;
	private transmitMru = 1500;
	private localMagic = 0;
	private linkOpened = false;
	private chapUsername: Buffer | undefined;
	private chapPassword: Buffer | undefined;
	private chapChallengeIdentifier: number | undefined;
	private packets: PppPacket[] = [];
	private waiter: PacketWaiter | undefined;
	private configuredAddress: Buffer | undefined;
	private readonly handleSerialDataCallback = this.handleSerialData.bind(this);
	private readonly handleSerialCloseCallback = this.handleSerialClose.bind(this);

	private handleSerialClose() {
		this.stop();
	}

	private handleSerialData(data: Buffer) {
		for (const byte of data) {
			if (byte == PPP_FLAG) {
				if (this.receivingFrame && this.frame.length > 0)
					this.handleFrame(Buffer.from(this.frame));
				this.frame = [];
				this.receivingFrame = true;
				this.escaped = false;
				continue;
			}

			if (!this.receivingFrame)
				continue;

			if (this.escaped) {
				this.frame.push(byte ^ PPP_ESCAPE_XOR);
				this.escaped = false;
				continue;
			}

			if (byte == PPP_ESCAPE) {
				this.escaped = true;
				continue;
			}

			if (byte < 0x20 && (this.receiveAccm & (1 << byte)) != 0)
				continue;

			this.frame.push(byte);
		}
	}

	private handleFrame(frame: Buffer) {
		if (frame.length < 4 || pppFcs(frame) != PPP_FCS_GOOD) {
			debug(`Discarding invalid frame: ${frame.toString('hex')}`);
			return;
		}

		let offset = 0;
		if (frame[0] == 0xFF && frame[1] == 0x03)
			offset = 2;

		let protocol = frame[offset++];
		if ((protocol & 1) == 0)
			protocol = (protocol << 8) | frame[offset++];

		if ((protocol & 1) == 0 || offset > frame.length - 2) {
			debug(`Discarding malformed frame: ${frame.toString('hex')}`);
			return;
		}

		const packet = {
			protocol,
			payload: frame.subarray(offset, frame.length - 2),
		};
		debug(`<< ${protocolName(protocol)} ${formatDebugPayload(protocol, packet.payload)}`);
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			clearTimeout(waiter.timer);
			waiter.resolve(packet);
		} else {
			this.packets.push(packet);
		}
	}

	start(initialData?: Buffer) {
		if (this.running)
			return;
		this.frame = [];
		this.receivingFrame = false;
		this.escaped = false;
		this.receiveAccm = 0xFFFFFFFF;
		this.transmitAccm = 0xFFFFFFFF;
		this.transmitProtocolCompressed = false;
		this.transmitAddressControlCompressed = false;
		this.transmitMru = 1500;
		this.localMagic = 0;
		this.linkOpened = false;
		this.identifier = 0;
		this.pingSequence = 0;
		this.chapUsername = undefined;
		this.chapPassword = undefined;
		this.chapChallengeIdentifier = undefined;
		this.packets = [];
		this.configuredAddress = undefined;
		this.running = true;
		this.port.on('data', this.handleSerialDataCallback);
		this.port.on('close', this.handleSerialCloseCallback);
		if (initialData?.length)
			this.handleSerialData(initialData);
	}

	stop() {
		if (!this.running)
			return;
		this.running = false;
		this.linkOpened = false;
		this.chapPassword?.fill(0);
		this.chapUsername = undefined;
		this.chapPassword = undefined;
		this.chapChallengeIdentifier = undefined;
		this.port.off('data', this.handleSerialDataCallback);
		this.port.off('close', this.handleSerialCloseCallback);
		this.frame = [];
		this.packets = [];
		this.configuredAddress = undefined;
		if (this.waiter) {
			const waiter = this.waiter;
			this.waiter = undefined;
			clearTimeout(waiter.timer);
			waiter.resolve(undefined);
		}
	}

	private async send(protocol: number, payload: Buffer | number[]) {
		if (!this.running)
			throw new Error('PPP is not started.');
		if (payload.length > this.transmitMru)
			throw new Error(`PPP payload exceeds the peer MRU of ${this.transmitMru} bytes.`);

		const protocolBuffer = this.transmitProtocolCompressed && protocol < 0x100 ?
			Buffer.from([protocol]) :
			Buffer.from([protocol >> 8, protocol & 0xFF]);
		const header = this.transmitAddressControlCompressed ?
			protocolBuffer :
			Buffer.concat([Buffer.from([0xFF, 0x03]), protocolBuffer]);
		const body = Buffer.concat([header, Buffer.from(payload)]);
		const fcs = pppFcs(body) ^ 0xFFFF;
		const frame = Buffer.concat([body, Buffer.from([fcs & 0xFF, fcs >> 8])]);
		const encoded: number[] = [PPP_FLAG];
		for (const byte of frame) {
			if (byte == PPP_FLAG || byte == PPP_ESCAPE || (byte < 0x20 && (this.transmitAccm & (1 << byte)) != 0)) {
				encoded.push(PPP_ESCAPE, byte ^ PPP_ESCAPE_XOR);
			} else {
				encoded.push(byte);
			}
		}
		encoded.push(PPP_FLAG);
		debug(`>> ${protocolName(protocol)} ${formatDebugPayload(protocol, Buffer.from(payload))}`);
		await this.port.write(Buffer.from(encoded));
	}

	async connect(options: PppConnectOptions = {}): Promise<PppConnectionInfo> {
		if (!this.running)
			throw new Error('PPP is not started.');

		const timeout = options.timeout ?? 30000;
		const retryInterval = options.retryInterval ?? 1000;
		const deadline = Date.now() + timeout;
		let authenticationProtocol: number | undefined;
		let localLcpOpened = false;
		let peerLcpOpened = false;
		let lcpRequest = this.createControlPacket(PppControlCode.CONFIGURE_REQUEST, lcpOptions());
		await this.send(PppProtocol.LCP, lcpRequest);

		while (!localLcpOpened || !peerLcpOpened) {
			const packet = await this.nextPacketUntil(deadline, retryInterval);
			if (!packet) {
				await this.send(PppProtocol.LCP, lcpRequest);
				continue;
			}
			if (packet.protocol != PppProtocol.LCP)
				continue;
			const control = parseControlPacket(packet.payload);
			switch (control.code) {
				case PppControlCode.CONFIGURE_REQUEST: {
					const result = inspectLcpOptions(control.data);
					if (result.reject.length > 0) {
						await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_REJECT, control.identifier, result.reject);
					} else if (result.nak.length > 0) {
						await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_NAK, control.identifier, result.nak);
					} else {
						await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_ACK, control.identifier, control.data);
						peerLcpOpened = true;
						authenticationProtocol = result.authenticationProtocol;
						this.transmitAccm = result.accm;
						this.transmitProtocolCompressed = result.protocolCompressed;
						this.transmitAddressControlCompressed = result.addressControlCompressed;
						this.transmitMru = result.mru;
					}
					break;
				}
				case PppControlCode.CONFIGURE_ACK:
					if (control.identifier == lcpRequest[1] && control.data.equals(lcpRequest.subarray(4))) {
						localLcpOpened = true;
						this.receiveAccm = readAccmOption(lcpRequest.subarray(4)) ?? 0xFFFFFFFF;
						this.localMagic = readMagicOption(lcpRequest.subarray(4)) ?? 0;
					}
					break;
				case PppControlCode.CONFIGURE_NAK:
				case PppControlCode.CONFIGURE_REJECT:
					if (control.identifier == lcpRequest[1]) {
						lcpRequest = this.createControlPacket(PppControlCode.CONFIGURE_REQUEST, updateLcpOptions(lcpRequest.subarray(4), control));
						await this.send(PppProtocol.LCP, lcpRequest);
					}
					break;
				default:
					await this.handleLinkControl(control);
			}
		}
		this.linkOpened = true;

		if (authenticationProtocol == PppProtocol.PAP) {
			await this.authenticatePap(options.username ?? '', options.password ?? '', deadline, retryInterval);
		} else if (authenticationProtocol == PppProtocol.CHAP) {
			await this.authenticateChap(options.username ?? '', options.password ?? '', deadline, retryInterval);
		}

		return this.configureIp(deadline, retryInterval);
	}

	private async authenticatePap(username: string, password: string, deadline: number, retryInterval: number) {
		const usernameBuffer = Buffer.from(username);
		const passwordBuffer = Buffer.from(password);
		if (usernameBuffer.length > 255 || passwordBuffer.length > 255)
			throw new Error('PPP PAP credentials must not exceed 255 bytes.');
		const data = Buffer.concat([
			Buffer.from([usernameBuffer.length]), usernameBuffer,
			Buffer.from([passwordBuffer.length]), passwordBuffer,
		]);
		const request = this.createControlPacket(PapCode.AUTHENTICATE_REQUEST, data);
		try {
			await this.send(PppProtocol.PAP, request);

			while (true) {
				const packet = await this.nextPacketUntil(deadline, retryInterval);
				if (!packet) {
					await this.send(PppProtocol.PAP, request);
					continue;
				}
				if (packet.protocol == PppProtocol.LCP) {
					await this.handleLinkControl(parseControlPacket(packet.payload));
					continue;
				}
				if (packet.protocol != PppProtocol.PAP) {
					if (packet.protocol != PppProtocol.IPCP)
						await this.rejectProtocol(packet);
					continue;
				}
				const response = parseControlPacket(packet.payload);
				if (response.identifier != request[1])
					continue;
				if (response.code == PapCode.AUTHENTICATE_ACK)
					return;
				if (response.code == PapCode.AUTHENTICATE_NAK)
					throw new Error(`PPP authentication failed: ${parsePapMessage(response.data)}`);
			}
		} finally {
			passwordBuffer.fill(0);
			data.fill(0);
			request.fill(0);
		}
	}

	private async authenticateChap(username: string, password: string, deadline: number, retryInterval: number) {
		this.chapUsername = Buffer.from(username);
		this.chapPassword = Buffer.from(password);
		while (true) {
			const packet = await this.nextPacketUntil(deadline, retryInterval);
			if (!packet)
				continue;
			if (packet.protocol == PppProtocol.LCP) {
				await this.handleLinkControl(parseControlPacket(packet.payload));
				continue;
			}
			if (packet.protocol != PppProtocol.CHAP) {
				if (packet.protocol != PppProtocol.IPCP)
					await this.rejectProtocol(packet);
				continue;
			}

			if (await this.handleChap(packet.payload))
				return;
		}
	}

	private async handleChap(payload: Buffer): Promise<boolean> {
		const control = parseControlPacket(payload);
		if (control.code == ChapCode.CHALLENGE) {
			if (!this.chapUsername || !this.chapPassword)
				throw new Error('PPP peer requested CHAP without configured credentials.');
			if (control.data.length == 0 || control.data[0] > control.data.length - 1)
				throw new Error('PPP peer sent a malformed CHAP challenge.');
			const challenge = control.data.subarray(1, 1 + control.data[0]);
			const digest = createHash('md5')
				.update(Buffer.from([control.identifier]))
				.update(this.chapPassword)
				.update(challenge)
				.digest();
			const response = Buffer.concat([Buffer.from([digest.length]), digest, this.chapUsername]);
			this.chapChallengeIdentifier = control.identifier;
			await this.sendControl(PppProtocol.CHAP, ChapCode.RESPONSE, control.identifier, response);
		} else if (control.code == ChapCode.SUCCESS && control.identifier == this.chapChallengeIdentifier) {
			this.chapChallengeIdentifier = undefined;
			return true;
		} else if (control.code == ChapCode.FAILURE && control.identifier == this.chapChallengeIdentifier) {
			throw new Error(`PPP CHAP authentication failed: ${control.data.toString()}`);
		}
		return false;
	}

	private async configureIp(deadline: number, retryInterval: number): Promise<PppConnectionInfo> {
		let localOpened = false;
		let peerOpened = false;
		let remoteAddress: string | undefined;
		let requestOptions = ipcpOptions();
		let request = this.createControlPacket(PppControlCode.CONFIGURE_REQUEST, requestOptions);
		await this.send(PppProtocol.IPCP, request);

		while (!localOpened || !peerOpened) {
			const packet = await this.nextPacketUntil(deadline, retryInterval);
			if (!packet) {
				await this.send(PppProtocol.IPCP, request);
				continue;
			}
			if (packet.protocol == PppProtocol.LCP) {
				await this.handleLinkControl(parseControlPacket(packet.payload));
				continue;
			}
			if (packet.protocol == PppProtocol.CHAP) {
				await this.handleChap(packet.payload);
				continue;
			}
			if (packet.protocol != PppProtocol.IPCP) {
				if (packet.protocol != PppProtocol.PAP)
					await this.rejectProtocol(packet);
				continue;
			}

			const control = parseControlPacket(packet.payload);
			switch (control.code) {
				case PppControlCode.CONFIGURE_REQUEST: {
					const rejected = rejectIpcpOptions(control.data);
					if (rejected.length > 0) {
						await this.sendControl(PppProtocol.IPCP, PppControlCode.CONFIGURE_REJECT, control.identifier, rejected);
					} else {
						await this.sendControl(PppProtocol.IPCP, PppControlCode.CONFIGURE_ACK, control.identifier, control.data);
						peerOpened = true;
						remoteAddress = readIpOption(control.data, IpcpOption.IP_ADDRESS);
					}
					break;
				}
				case PppControlCode.CONFIGURE_ACK:
					if (control.identifier == request[1] && control.data.equals(requestOptions))
						localOpened = true;
					break;
				case PppControlCode.CONFIGURE_NAK:
					if (control.identifier == request[1]) {
						requestOptions = replaceIpcpOptions(requestOptions, control.data);
						request = this.createControlPacket(PppControlCode.CONFIGURE_REQUEST, requestOptions);
						await this.send(PppProtocol.IPCP, request);
					}
					break;
				case PppControlCode.CONFIGURE_REJECT:
					if (control.identifier == request[1]) {
						requestOptions = removeRejectedOptions(requestOptions, control.data);
						request = this.createControlPacket(PppControlCode.CONFIGURE_REQUEST, requestOptions);
						await this.send(PppProtocol.IPCP, request);
					}
					break;
			}
		}

		const localAddress = readIpOption(requestOptions, IpcpOption.IP_ADDRESS);
		if (!localAddress || localAddress == '0.0.0.0')
			throw new Error('IPCP opened without a local IPv4 address.');
		this.configuredAddress = parseIpv4Address(localAddress);
		return {
			localAddress,
			remoteAddress,
			primaryDns: readIpOption(requestOptions, IpcpOption.PRIMARY_DNS),
			secondaryDns: readIpOption(requestOptions, IpcpOption.SECONDARY_DNS),
		};
	}

	async ping(address: string, timeout = 5000, payload = Buffer.from('node-sie-serial')): Promise<PppPingResult> {
		const destination = parseIpv4Address(address);
		const info = this.getConfiguredAddress();
		const identifier = process.pid & 0xFFFF;
		const sequence = this.pingSequence++ & 0xFFFF;
		const icmp = Buffer.alloc(8 + payload.length);
		icmp[0] = 8;
		icmp.writeUInt16BE(identifier, 4);
		icmp.writeUInt16BE(sequence, 6);
		payload.copy(icmp, 8);
		icmp.writeUInt16BE(internetChecksum(icmp), 2);

		const ip = Buffer.alloc(20 + icmp.length);
		ip[0] = 0x45;
		ip.writeUInt16BE(ip.length, 2);
		ip.writeUInt16BE(sequence, 4);
		ip.writeUInt16BE(0x4000, 6);
		ip[8] = 64;
		ip[9] = 1;
		info.copy(ip, 12);
		destination.copy(ip, 16);
		ip.writeUInt16BE(internetChecksum(ip.subarray(0, 20)), 10);
		icmp.copy(ip, 20);

		const started = Date.now();
		const deadline = started + timeout;
		await this.send(PppProtocol.IPV4, ip);
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error(`Ping to ${address} timed out.`);
			const packet = await this.nextPacketUntil(deadline, remaining);
			if (!packet)
				throw new Error(`Ping to ${address} timed out.`);
			if (packet.protocol == PppProtocol.LCP) {
				await this.handleLinkControl(parseControlPacket(packet.payload));
				continue;
			}
			if (packet.protocol == PppProtocol.CHAP) {
				await this.handleChap(packet.payload);
				continue;
			}
			if (packet.protocol != PppProtocol.IPV4) {
				if (packet.protocol != PppProtocol.IPCP && packet.protocol != PppProtocol.PAP)
					await this.rejectProtocol(packet);
				continue;
			}
			if (packet.payload.length < 28 || packet.payload[0] >> 4 != 4)
				continue;
			const headerLength = (packet.payload[0] & 0x0F) * 4;
			const totalLength = packet.payload.readUInt16BE(2);
			if (headerLength < 20 || totalLength < headerLength + 8 || totalLength > packet.payload.length)
				continue;
			if (packet.payload[9] != 1 || !packet.payload.subarray(12, 16).equals(destination) || !packet.payload.subarray(16, 20).equals(info))
				continue;
			if (internetChecksum(packet.payload.subarray(0, headerLength)) != 0)
				continue;
			const response = packet.payload.subarray(headerLength, totalLength);
			if (internetChecksum(response) != 0)
				continue;
			if (response[0] != 0 || response.readUInt16BE(4) != identifier || response.readUInt16BE(6) != sequence)
				continue;
			return {
				address: formatIpv4Address(packet.payload.subarray(12, 16)),
				bytes: response.length - 8,
				time: Date.now() - started,
				ttl: packet.payload[8],
			};
		}
	}

	async disconnect(timeout = 2000) {
		if (!this.running)
			return;
		try {
			const request = this.createControlPacket(PppControlCode.TERMINATE_REQUEST, Buffer.alloc(0));
			await this.send(PppProtocol.LCP, request);
			const deadline = Date.now() + timeout;
			while (Date.now() < deadline) {
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					break;
				const packet = await this.nextPacketUntil(deadline, remaining);
				if (!packet)
					break;
				if (packet.protocol != PppProtocol.LCP)
					continue;
				const control = parseControlPacket(packet.payload);
				if (control.code == PppControlCode.TERMINATE_ACK && control.identifier == request[1])
					break;
				await this.handleLinkControl(control);
			}
		} finally {
			this.stop();
		}
	}

	private getConfiguredAddress(): Buffer {
		if (!this.configuredAddress)
			throw new Error('PPP is not configured.');
		return this.configuredAddress;
	}

	private createControlPacket(code: number, data: Buffer): Buffer {
		const packet = Buffer.alloc(4 + data.length);
		packet[0] = code;
		packet[1] = this.identifier++ & 0xFF;
		packet.writeUInt16BE(packet.length, 2);
		data.copy(packet, 4);
		return packet;
	}

	private async sendControl(protocol: number, code: number, identifier: number, data: Buffer) {
		const packet = Buffer.alloc(4 + data.length);
		packet[0] = code;
		packet[1] = identifier;
		packet.writeUInt16BE(packet.length, 2);
		data.copy(packet, 4);
		await this.send(protocol, packet);
	}

	private async handleLinkControl(control: ControlPacket) {
		switch (control.code) {
			case PppControlCode.CONFIGURE_REQUEST: {
				const result = inspectLcpOptions(control.data);
				if (result.reject.length > 0) {
					await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_REJECT, control.identifier, result.reject);
				} else if (result.nak.length > 0) {
					await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_NAK, control.identifier, result.nak);
				} else {
					await this.sendControl(PppProtocol.LCP, PppControlCode.CONFIGURE_ACK, control.identifier, control.data);
					this.transmitAccm = result.accm;
					this.transmitProtocolCompressed = result.protocolCompressed;
					this.transmitAddressControlCompressed = result.addressControlCompressed;
					this.transmitMru = result.mru;
				}
				break;
			}
			case PppControlCode.ECHO_REQUEST: {
				const echoData = Buffer.from(control.data);
				if (echoData.length >= 4)
					echoData.writeUInt32BE(this.localMagic, 0);
				await this.sendControl(PppProtocol.LCP, PppControlCode.ECHO_REPLY, control.identifier, echoData);
				break;
			}
			case PppControlCode.CODE_REJECT:
				throw new Error('PPP peer rejected an LCP code.');
			case PppControlCode.PROTOCOL_REJECT:
				if (control.data.length >= 2)
					throw new Error(`PPP peer rejected ${protocolName(control.data.readUInt16BE(0))}.`);
				throw new Error('PPP peer sent a malformed Protocol-Reject.');
			case PppControlCode.TERMINATE_REQUEST:
				await this.sendControl(PppProtocol.LCP, PppControlCode.TERMINATE_ACK, control.identifier, control.data);
				throw new Error('PPP link was terminated by the peer.');
		}
	}

	private async rejectProtocol(packet: PppPacket) {
		if (!this.linkOpened)
			return;
		const data = Buffer.concat([
			Buffer.from([packet.protocol >> 8, packet.protocol & 0xFF]),
			packet.payload,
		]).subarray(0, this.transmitMru - 4);
		await this.send(PppProtocol.LCP, this.createControlPacket(PppControlCode.PROTOCOL_REJECT, data));
	}

	private async nextPacketUntil(deadline: number, interval: number): Promise<PppPacket | undefined> {
		const remaining = deadline - Date.now();
		if (remaining <= 0)
			throw new Error('PPP negotiation timed out.');
		if (this.packets.length > 0)
			return this.packets.shift();
		if (this.waiter)
			throw new Error('Only one PPP packet consumer is supported.');

		const { promise, resolve } = usePromiseWithResolvers<PppPacket | undefined>();
		const wait = Math.max(1, Math.min(remaining, interval));
		this.waiter = {
			resolve,
			timer: setTimeout(() => {
				this.waiter = undefined;
				resolve(undefined);
			}, wait),
		};
		return promise;
	}
}

function parseControlPacket(payload: Buffer): ControlPacket {
	if (payload.length < 4)
		throw new Error('PPP control packet is shorter than its header.');
	const length = payload.readUInt16BE(2);
	if (length < 4 || length > payload.length)
		throw new Error(`Invalid PPP control packet length ${length}.`);
	return {
		code: payload[0],
		identifier: payload[1],
		data: payload.subarray(4, length),
	};
}

function lcpOptions(): Buffer {
	const options = Buffer.alloc(12);
	options[0] = LcpOption.ACCM;
	options[1] = 6;
	options.writeUInt32BE(0, 2);
	options[6] = LcpOption.MAGIC_NUMBER;
	options[7] = 6;
	options.writeUInt32BE(Math.floor(Math.random() * 0x100000000), 8);
	return options;
}

function inspectLcpOptions(data: Buffer) {
	const nak: Buffer[] = [];
	const reject: Buffer[] = [];
	let authenticationProtocol: number | undefined;
	let accm = 0xFFFFFFFF;
	let protocolCompressed = false;
	let addressControlCompressed = false;
	let mru = 1500;
	for (const option of splitOptions(data)) {
		switch (option[0]) {
			case LcpOption.MRU:
				if (option.length == 4) {
					mru = option.readUInt16BE(2);
				} else {
					reject.push(option);
				}
				break;
			case LcpOption.MAGIC_NUMBER:
				if (option.length != 6)
					reject.push(option);
				break;
			case LcpOption.ACCM:
				if (option.length == 6) {
					accm = option.readUInt32BE(2);
				} else {
					reject.push(option);
				}
				break;
			case LcpOption.AUTHENTICATION_PROTOCOL:
				if (option.length == 4 && option.readUInt16BE(2) == PppProtocol.PAP) {
					authenticationProtocol = PppProtocol.PAP;
				} else if (option.length == 5 && option.readUInt16BE(2) == PppProtocol.CHAP && option[4] == CHAP_MD5) {
					authenticationProtocol = PppProtocol.CHAP;
				} else {
					nak.push(Buffer.from([LcpOption.AUTHENTICATION_PROTOCOL, 4, PppProtocol.PAP >> 8, PppProtocol.PAP & 0xFF]));
				}
				break;
			case LcpOption.PROTOCOL_FIELD_COMPRESSION:
				if (option.length == 2) {
					protocolCompressed = true;
				} else {
					reject.push(option);
				}
				break;
			case LcpOption.ADDRESS_CONTROL_COMPRESSION:
				if (option.length == 2) {
					addressControlCompressed = true;
				} else {
					reject.push(option);
				}
				break;
			default:
				reject.push(option);
		}
	}
	return {
		nak: Buffer.concat(nak),
		reject: Buffer.concat(reject),
		authenticationProtocol,
		accm,
		protocolCompressed,
		addressControlCompressed,
		mru,
	};
}

function updateLcpOptions(options: Buffer, response: ControlPacket): Buffer {
	if (response.code == PppControlCode.CONFIGURE_REJECT)
		return removeRejectedOptions(options, response.data);
	return replaceOptions(options, response.data);
}

function readAccmOption(options: Buffer): number | undefined {
	const option = splitOptions(options).find((item) => item[0] == LcpOption.ACCM && item.length == 6);
	return option?.readUInt32BE(2);
}

function readMagicOption(options: Buffer): number | undefined {
	const option = splitOptions(options).find((item) => item[0] == LcpOption.MAGIC_NUMBER && item.length == 6);
	return option?.readUInt32BE(2);
}

function ipcpOptions(): Buffer {
	return Buffer.from([
		IpcpOption.IP_ADDRESS, 6, 0, 0, 0, 0,
		IpcpOption.PRIMARY_DNS, 6, 0, 0, 0, 0,
		IpcpOption.SECONDARY_DNS, 6, 0, 0, 0, 0,
	]);
}

function rejectIpcpOptions(data: Buffer): Buffer {
	return Buffer.concat(splitOptions(data).filter((option) => {
		switch (option[0]) {
			case IpcpOption.IP_ADDRESS:
			case IpcpOption.PRIMARY_DNS:
			case IpcpOption.SECONDARY_DNS:
				return option.length != 6;
			default:
				return true;
		}
	}));
}

function replaceIpcpOptions(options: Buffer, replacements: Buffer): Buffer {
	return replaceOptions(options, replacements);
}

function replaceOptions(options: Buffer, replacements: Buffer): Buffer {
	const replacementMap = new Map(splitOptions(replacements).map((option) => [option[0], option]));
	return Buffer.concat(splitOptions(options).map((option) => replacementMap.get(option[0]) ?? option));
}

function removeRejectedOptions(options: Buffer, rejected: Buffer): Buffer {
	const rejectedTypes = new Set(splitOptions(rejected).map((option) => option[0]));
	return Buffer.concat(splitOptions(options).filter((option) => !rejectedTypes.has(option[0])));
}

function splitOptions(data: Buffer): Buffer[] {
	const options: Buffer[] = [];
	let offset = 0;
	while (offset < data.length) {
		if (offset + 2 > data.length || data[offset + 1] < 2 || offset + data[offset + 1] > data.length)
			throw new Error('Malformed PPP configuration option.');
		options.push(data.subarray(offset, offset + data[offset + 1]));
		offset += data[offset + 1];
	}
	return options;
}

function readIpOption(options: Buffer, type: number): string | undefined {
	const option = splitOptions(options).find((item) => item[0] == type && item.length == 6);
	return option ? formatIpv4Address(option.subarray(2)) : undefined;
}

function parsePapMessage(data: Buffer): string {
	if (data.length == 0)
		return '';
	if (data[0] > data.length - 1)
		throw new Error('PPP peer sent a malformed PAP message.');
	return data.subarray(1, 1 + data[0]).toString();
}

function parseIpv4Address(address: string): Buffer {
	const parts = address.split('.');
	if (parts.length != 4 || parts.some((part) => !part.match(/^\d{1,3}$/)))
		throw new Error(`Invalid IPv4 address: ${address}`);
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255))
		throw new Error(`Invalid IPv4 address: ${address}`);
	return Buffer.from(octets);
}

function formatIpv4Address(address: Buffer): string {
	return [...address.subarray(0, 4)].join('.');
}

function internetChecksum(data: Buffer): number {
	let sum = 0;
	for (let offset = 0; offset < data.length; offset += 2) {
		sum += data[offset] << 8;
		if (offset + 1 < data.length)
			sum += data[offset + 1];
		while (sum > 0xFFFF)
			sum = (sum & 0xFFFF) + (sum >>> 16);
	}
	return (~sum) & 0xFFFF;
}

function pppFcs(data: Buffer): number {
	let fcs = PPP_FCS_INITIAL;
	for (const byte of data) {
		fcs ^= byte;
		for (let bit = 0; bit < 8; bit++)
			fcs = (fcs & 1) != 0 ? (fcs >>> 1) ^ 0x8408 : fcs >>> 1;
	}
	return fcs;
}

function protocolName(protocol: number): string {
	return PppProtocol[protocol] ?? `0x${protocol.toString(16).padStart(4, '0')}`;
}

function formatDebugPayload(protocol: number, payload: Buffer): string {
	if (protocol == PppProtocol.PAP || protocol == PppProtocol.CHAP)
		return `<${payload.length} authentication bytes>`;
	return payload.toString('hex');
}
