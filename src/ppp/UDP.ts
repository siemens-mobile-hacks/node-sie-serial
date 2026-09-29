import createDebug from 'debug';
import { encodeIpv4Packet, formatIpv4Address, IpProtocol, parseIpv4Address, parseIpv4Packet, transportChecksum } from './IPv4.js';
import type { PPP } from './PPP.js';
import { PppProtocol } from './PppProtocol.js';

const debug = createDebug('ppp:udp');

export type UdpMessage = {
	address: string;
	port: number;
	data: Buffer;
};

export type UdpMessageHandler = (message: UdpMessage) => void;

export class UDP {
	readonly port: number;
	private identification = 0;
	private readonly source: Buffer;
	private readonly handlers = new Set<UdpMessageHandler>();
	private readonly unsubscribe: () => void;
	private closed = false;

	constructor(private readonly ppp: PPP, port = randomEphemeralPort()) {
		if (!Number.isInteger(port) || port < 1 || port > 0xFFFF)
			throw new Error(`Invalid UDP port: ${port}`);
		this.port = port;
		this.source = parseIpv4Address(ppp.getLocalAddress());
		this.unsubscribe = ppp.onPacket((packet) => this.handlePacket(packet.protocol, packet.payload));
	}

	onMessage(callback: UdpMessageHandler): () => void {
		if (this.closed)
			throw new Error('UDP socket is closed.');
		this.handlers.add(callback);
		return () => this.handlers.delete(callback);
	}

	async send(address: string, port: number, data: Buffer): Promise<void> {
		if (this.closed)
			throw new Error('UDP socket is closed.');
		if (!Number.isInteger(port) || port < 1 || port > 0xFFFF)
			throw new Error(`Invalid UDP port: ${port}`);
		if (data.length > 1472)
			throw new Error('UDP payload is too large.');
		const destination = parseIpv4Address(address);
		const datagram = Buffer.alloc(8 + data.length);
		datagram.writeUInt16BE(this.port, 0);
		datagram.writeUInt16BE(port, 2);
		datagram.writeUInt16BE(datagram.length, 4);
		data.copy(datagram, 8);
		const checksum = transportChecksum(this.source, destination, IpProtocol.UDP, datagram);
		datagram.writeUInt16BE(checksum == 0 ? 0xFFFF : checksum, 6);
		const packet = encodeIpv4Packet(this.source, destination, IpProtocol.UDP, datagram, this.identification++ & 0xFFFF);
		await this.ppp.sendPacket(PppProtocol.IPV4, packet);
	}

	close(): void {
		if (this.closed)
			return;
		this.closed = true;
		this.unsubscribe();
		this.handlers.clear();
	}

	private handlePacket(protocol: number, data: Buffer): void {
		if (protocol != PppProtocol.IPV4)
			return;
		const ip = parseIpv4Packet(data);
		if (!ip || ip.protocol != IpProtocol.UDP || !ip.destination.equals(this.source) || ip.payload.length < 8)
			return;
		const length = ip.payload.readUInt16BE(4);
		if (ip.payload.readUInt16BE(2) != this.port || length < 8 || length > ip.payload.length)
			return;
		const datagram = ip.payload.subarray(0, length);
		if (datagram.readUInt16BE(6) != 0 && transportChecksum(ip.source, ip.destination, IpProtocol.UDP, datagram) != 0)
			return;
		const message = {
			address: formatIpv4Address(ip.source),
			port: datagram.readUInt16BE(0),
			data: Buffer.from(datagram.subarray(8)),
		};
		for (const callback of this.handlers) {
			try {
				callback(message);
			} catch (error) {
				debug('UDP message callback failed: %O', error);
			}
		}
	}
}

function randomEphemeralPort(): number {
	return 49152 + Math.floor(Math.random() * 16384);
}
