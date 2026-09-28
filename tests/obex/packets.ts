// OBEX response packets and headers, the way the simulated phones answer

export function obexPacket(code: number, ...parts: Buffer[]): Buffer {
	const packet = Buffer.concat([Buffer.from([code, 0, 0]), ...parts]);
	packet.writeUInt16BE(packet.length, 1);
	return packet;
}

export function obexHeader(id: number, value: Buffer): Buffer {
	const header = Buffer.concat([Buffer.from([id, 0, 0]), value]);
	header.writeUInt16BE(header.length, 1);
	return header;
}
