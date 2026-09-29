export enum IpProtocol {
	ICMP = 1,
	TCP = 6,
	UDP = 17,
}

export type Ipv4Packet = {
	source: Buffer;
	destination: Buffer;
	protocol: number;
	ttl: number;
	payload: Buffer;
};

export function parseIpv4Address(address: string): Buffer {
	const parts = address.split('.');
	if (parts.length != 4 || parts.some((part) => !part.match(/^\d{1,3}$/)))
		throw new Error(`Invalid IPv4 address: ${address}`);
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255))
		throw new Error(`Invalid IPv4 address: ${address}`);
	return Buffer.from(octets);
}

export function formatIpv4Address(address: Buffer): string {
	return [...address.subarray(0, 4)].join('.');
}

export function internetChecksum(data: Buffer): number {
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

export function transportChecksum(source: Buffer, destination: Buffer, protocol: number, payload: Buffer): number {
	const pseudoHeader = Buffer.alloc(12);
	source.copy(pseudoHeader, 0, 0, 4);
	destination.copy(pseudoHeader, 4, 0, 4);
	pseudoHeader[9] = protocol;
	pseudoHeader.writeUInt16BE(payload.length, 10);
	return internetChecksum(Buffer.concat([pseudoHeader, payload]));
}

export function encodeIpv4Packet(source: Buffer, destination: Buffer, protocol: number, payload: Buffer, identification: number): Buffer {
	const packet = Buffer.alloc(20 + payload.length);
	packet[0] = 0x45;
	packet.writeUInt16BE(packet.length, 2);
	packet.writeUInt16BE(identification, 4);
	packet.writeUInt16BE(0x4000, 6);
	packet[8] = 64;
	packet[9] = protocol;
	source.copy(packet, 12, 0, 4);
	destination.copy(packet, 16, 0, 4);
	packet.writeUInt16BE(internetChecksum(packet.subarray(0, 20)), 10);
	payload.copy(packet, 20);
	return packet;
}

export function parseIpv4Packet(data: Buffer): Ipv4Packet | undefined {
	if (data.length < 20 || data[0] >> 4 != 4)
		return undefined;
	const headerLength = (data[0] & 0x0F) * 4;
	const totalLength = data.readUInt16BE(2);
	if (headerLength < 20 || totalLength < headerLength || totalLength > data.length)
		return undefined;
	if ((data.readUInt16BE(6) & 0x3FFF) != 0 || internetChecksum(data.subarray(0, headerLength)) != 0)
		return undefined;
	return {
		source: data.subarray(12, 16),
		destination: data.subarray(16, 20),
		protocol: data[9],
		ttl: data[8],
		payload: data.subarray(headerLength, totalLength),
	};
}
