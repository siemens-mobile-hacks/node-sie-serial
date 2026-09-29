import { usePromiseWithResolvers } from '#src/utils.js';
import { encodeIpv4Packet, formatIpv4Address, internetChecksum, IpProtocol, parseIpv4Address, parseIpv4Packet } from './IPv4.js';
import type { PPP, PppPingResult } from './PPP.js';
import { PppProtocol } from './PppProtocol.js';

export class ICMP {
	private sequence = 0;
	private identification = 0;

	constructor(private readonly ppp: PPP) {}

	async ping(address: string, timeout = 5000, payload = Buffer.from('node-sie-serial')): Promise<PppPingResult> {
		const destination = parseIpv4Address(address);
		const source = parseIpv4Address(this.ppp.getLocalAddress());
		const identifier = process.pid & 0xFFFF;
		const sequence = this.sequence++ & 0xFFFF;
		const request = Buffer.alloc(8 + payload.length);
		request[0] = 8;
		request.writeUInt16BE(identifier, 4);
		request.writeUInt16BE(sequence, 6);
		payload.copy(request, 8);
		request.writeUInt16BE(internetChecksum(request), 2);

		const started = Date.now();
		const { promise, resolve, reject } = usePromiseWithResolvers<PppPingResult>();
		const unsubscribe = this.ppp.onPacket((packet) => {
			if (packet.protocol != PppProtocol.IPV4)
				return;
			const ip = parseIpv4Packet(packet.payload);
			if (!ip || ip.protocol != IpProtocol.ICMP || !ip.source.equals(destination) || !ip.destination.equals(source))
				return;
			if (ip.payload.length < 8 || internetChecksum(ip.payload) != 0)
				return;
			if (ip.payload[0] != 0 || ip.payload.readUInt16BE(4) != identifier || ip.payload.readUInt16BE(6) != sequence)
				return;
			resolve({
				address: formatIpv4Address(ip.source),
				bytes: ip.payload.length - 8,
				time: Date.now() - started,
				ttl: ip.ttl,
			});
		});
		const timer = setTimeout(() => reject(new Error(`Ping to ${address} timed out.`)), timeout);
		try {
			const ip = encodeIpv4Packet(source, destination, IpProtocol.ICMP, request, this.identification++ & 0xFFFF);
			await this.ppp.sendPacket(PppProtocol.IPV4, ip);
			return await promise;
		} finally {
			clearTimeout(timer);
			unsubscribe();
		}
	}
}
