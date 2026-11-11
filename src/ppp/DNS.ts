import { usePromiseWithResolvers } from '#src/utils.js';
import { formatIpv4Address } from './IPv4.js';
import type { PPP } from './PPP.js';
import { UDP } from './UDP.js';

const DNS_PORT = 53;
const DNS_FLAG_RESPONSE = 0x8000;
const DNS_FLAG_RECURSION_DESIRED = 0x0100;
const DNS_RCODE_MASK = 0x000F;
const DNS_TYPE_A = 1;
const DNS_CLASS_IN = 1;
const DNS_POINTER = 0xC0;

export function encodeDnsQuery(id: number, hostname: string): Buffer {
	const labels = hostname.split('.').map((label) => Buffer.from(label, 'ascii'));
	if (labels.some((label) => label.length < 1 || label.length > 63))
		throw new Error(`Invalid DNS name: ${hostname}`);
	const header = Buffer.alloc(12);
	header.writeUInt16BE(id, 0);
	header.writeUInt16BE(DNS_FLAG_RECURSION_DESIRED, 2);
	header.writeUInt16BE(1, 4);
	const question = Buffer.alloc(4);
	question.writeUInt16BE(DNS_TYPE_A, 0);
	question.writeUInt16BE(DNS_CLASS_IN, 2);
	return Buffer.concat([
		header,
		...labels.flatMap((label) => [Buffer.from([label.length]), label]),
		Buffer.from([0]),
		question,
	]);
}

export function parseDnsResponse(id: number, response: Buffer): string[] | undefined {
	if (response.length < 12 || response.readUInt16BE(0) != id)
		return undefined;
	const flags = response.readUInt16BE(2);
	if ((flags & DNS_FLAG_RESPONSE) == 0)
		return undefined;
	const rcode = flags & DNS_RCODE_MASK;
	if (rcode != 0)
		throw new Error(`DNS server returned error ${rcode}.`);
	const questions = response.readUInt16BE(4);
	const answers = response.readUInt16BE(6);
	let offset = 12;
	for (let i = 0; i < questions; i++)
		offset = skipDnsName(response, offset) + 4;
	const addresses: string[] = [];
	for (let i = 0; i < answers; i++) {
		offset = skipDnsName(response, offset);
		if (offset + 10 > response.length)
			throw new Error('DNS response is truncated.');
		const type = response.readUInt16BE(offset);
		const dataClass = response.readUInt16BE(offset + 2);
		const dataLength = response.readUInt16BE(offset + 8);
		offset += 10;
		if (offset + dataLength > response.length)
			throw new Error('DNS response is truncated.');
		if (type == DNS_TYPE_A && dataClass == DNS_CLASS_IN && dataLength == 4)
			addresses.push(formatIpv4Address(response.subarray(offset, offset + 4)));
		offset += dataLength;
	}
	return addresses;
}

export class DNS {
	constructor(private readonly ppp: PPP) {}

	async resolveIpv4(hostname: string, server: string, timeout = 10000): Promise<string[]> {
		const id = Math.floor(Math.random() * 0x10000);
		const udp = new UDP(this.ppp);
		const { promise, resolve, reject } = usePromiseWithResolvers<string[]>();
		udp.onMessage((message) => {
			if (message.address != server || message.port != DNS_PORT)
				return;
			try {
				const addresses = parseDnsResponse(id, message.data);
				if (addresses)
					resolve(addresses);
			} catch (error) {
				reject(error);
			}
		});
		const timer = setTimeout(() => reject(new Error(`DNS query for ${hostname} timed out.`)), timeout);
		void promise.catch(() => undefined);
		try {
			await udp.send(server, DNS_PORT, encodeDnsQuery(id, hostname));
			return await promise;
		} finally {
			clearTimeout(timer);
			udp.close();
		}
	}
}

function skipDnsName(message: Buffer, offset: number): number {
	while (offset < message.length) {
		const length = message[offset];
		if ((length & DNS_POINTER) == DNS_POINTER)
			return offset + 2;
		offset += 1 + length;
		if (length == 0)
			return offset;
	}
	throw new Error('DNS response is truncated.');
}
