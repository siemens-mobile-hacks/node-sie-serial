import createDebug from 'debug';
import { usePromiseWithResolvers } from '#src/utils.js';
import { encodeIpv4Packet, IpProtocol, parseIpv4Address, parseIpv4Packet, transportChecksum } from './IPv4.js';
import type { PPP } from './PPP.js';
import { PppProtocol } from './PppProtocol.js';

const debug = createDebug('ppp:tcp');

const TCP_FIN = 0x01;
const TCP_SYN = 0x02;
const TCP_RST = 0x04;
const TCP_PSH = 0x08;
const TCP_ACK = 0x10;
const TCP_MSS = 536;

type TcpSegment = {
	sequence: number;
	acknowledgement: number;
	flags: number;
	payload: Buffer;
};

type SegmentWaiter = {
	resolve: (segment: TcpSegment) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

type AckWaiter = {
	acknowledgement: number;
	resolve: () => void;
	reject: (error: Error) => void;
};

type CloseWaiter = {
	resolve: () => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

export type TcpDataHandler = (data: Buffer) => void;

export class TCP {
	readonly localPort: number;
	private readonly source: Buffer;
	private destination: Buffer | undefined;
	private remotePort = 0;
	private sequence = Math.floor(Math.random() * 0x100000000) >>> 0;
	private remoteSequence = 0;
	private identification = 0;
	private connected = false;
	private remoteClosed = false;
	private closed = false;
	private closing = false;
	private sending = false;
	private readonly handlers = new Set<TcpDataHandler>();
	private readonly segments: TcpSegment[] = [];
	private segmentWaiter: SegmentWaiter | undefined;
	private ackWaiter: AckWaiter | undefined;
	private closeWaiter: CloseWaiter | undefined;
	private readonly unsubscribe: () => void;

	constructor(private readonly ppp: PPP, localPort = randomEphemeralPort()) {
		if (!Number.isInteger(localPort) || localPort < 1 || localPort > 0xFFFF)
			throw new Error(`Invalid TCP port: ${localPort}`);
		this.localPort = localPort;
		this.source = parseIpv4Address(ppp.getLocalAddress());
		this.unsubscribe = ppp.onPacket((packet) => this.handlePacket(packet.protocol, packet.payload));
	}

	onData(callback: TcpDataHandler): () => void {
		if (this.closed)
			throw new Error('TCP socket is closed.');
		this.handlers.add(callback);
		return () => this.handlers.delete(callback);
	}

	async connect(address: string, port: number, timeout = 10000): Promise<void> {
		if (this.closed)
			throw new Error('TCP socket is closed.');
		if (this.connected || this.destination)
			throw new Error('TCP socket is already connected or connecting.');
		if (!Number.isInteger(port) || port < 1 || port > 0xFFFF)
			throw new Error(`Invalid TCP port: ${port}`);
		this.destination = parseIpv4Address(address);
		this.remotePort = port;
		const deadline = Date.now() + timeout;
		try {
			while (true) {
				const remaining = deadline - Date.now();
				if (remaining <= 0)
					throw new Error(`TCP connection to ${address}:${port} timed out.`);
				const response = this.nextSegment(Math.min(1000, remaining));
				try {
					await this.sendSegment(TCP_SYN, Buffer.alloc(0), Buffer.from([2, 4, TCP_MSS >> 8, TCP_MSS & 0xFF]));
				} catch (error) {
					void response.catch(() => undefined);
					throw error;
				}
				let segment: TcpSegment;
				try {
					segment = await response;
				} catch {
					continue;
				}
				if ((segment.flags & TCP_RST) != 0)
					throw new Error(`TCP connection to ${address}:${port} was refused.`);
				if ((segment.flags & (TCP_SYN | TCP_ACK)) != (TCP_SYN | TCP_ACK) || segment.acknowledgement != ((this.sequence + 1) >>> 0))
					continue;
				this.sequence = segment.acknowledgement;
				this.remoteSequence = (segment.sequence + 1) >>> 0;
				this.connected = true;
				await this.sendSegment(TCP_ACK, Buffer.alloc(0));
				return;
			}
		} catch (error) {
			this.destroy();
			throw error;
		}
	}

	async send(data: Buffer, timeout = 10000): Promise<void> {
		this.ensureConnected();
		if (this.sending)
			throw new Error('A TCP send is already in progress.');
		this.sending = true;
		try {
			for (let offset = 0; offset < data.length; offset += TCP_MSS) {
				const payload = data.subarray(offset, offset + TCP_MSS);
				await this.sendAndWaitForAck(TCP_ACK | TCP_PSH, payload, payload.length, timeout);
			}
		} finally {
			this.sending = false;
		}
	}

	async close(timeout = 5000): Promise<void> {
		if (this.closed)
			return;
		if (this.closing)
			throw new Error('TCP close is already in progress.');
		if (this.sending)
			throw new Error('A TCP send is in progress.');
		this.closing = true;
		try {
			if (this.connected) {
				const deadline = Date.now() + timeout;
				await this.sendAndWaitForAck(TCP_ACK | TCP_FIN, Buffer.alloc(0), 1, timeout);
				if (!this.remoteClosed)
					await this.waitForRemoteClose(deadline - Date.now());
			}
		} finally {
			this.destroy();
		}
	}

	destroy(): void {
		if (this.closed)
			return;
		this.closed = true;
		this.connected = false;
		this.unsubscribe();
		this.handlers.clear();
		const error = new Error('TCP socket is closed.');
		if (this.segmentWaiter) {
			clearTimeout(this.segmentWaiter.timer);
			this.segmentWaiter.reject(error);
			this.segmentWaiter = undefined;
		}
		this.ackWaiter?.reject(error);
		this.ackWaiter = undefined;
		if (this.closeWaiter) {
			clearTimeout(this.closeWaiter.timer);
			this.closeWaiter.reject(error);
			this.closeWaiter = undefined;
		}
	}

	private async sendAndWaitForAck(flags: number, payload: Buffer, sequenceLength: number, timeout: number): Promise<void> {
		const expected = (this.sequence + sequenceLength) >>> 0;
		const deadline = Date.now() + timeout;
		while (true) {
			const remaining = deadline - Date.now();
			if (remaining <= 0)
				throw new Error('TCP acknowledgement timed out.');
			const { promise, resolve, reject } = usePromiseWithResolvers<void>();
			this.ackWaiter = { acknowledgement: expected, resolve, reject };
			const timer = setTimeout(() => resolve(), Math.min(1000, remaining));
			try {
				await this.sendSegment(flags, payload);
				await promise;
			} catch (error) {
				this.ackWaiter = undefined;
				throw error;
			} finally {
				clearTimeout(timer);
			}
			if (!this.ackWaiter) {
				this.sequence = expected;
				return;
			}
			this.ackWaiter = undefined;
		}
	}

	private async sendSegment(flags: number, payload: Buffer, options = Buffer.alloc(0)): Promise<void> {
		if (!this.destination)
			throw new Error('TCP socket has no remote address.');
		const segment = Buffer.alloc(20 + options.length + payload.length);
		segment.writeUInt16BE(this.localPort, 0);
		segment.writeUInt16BE(this.remotePort, 2);
		segment.writeUInt32BE(this.sequence, 4);
		segment.writeUInt32BE((flags & TCP_ACK) != 0 ? this.remoteSequence : 0, 8);
		segment[12] = ((20 + options.length) / 4) << 4;
		segment[13] = flags;
		segment.writeUInt16BE(0xFFFF, 14);
		options.copy(segment, 20);
		payload.copy(segment, 20 + options.length);
		segment.writeUInt16BE(transportChecksum(this.source, this.destination, IpProtocol.TCP, segment), 16);
		const packet = encodeIpv4Packet(this.source, this.destination, IpProtocol.TCP, segment, this.identification++ & 0xFFFF);
		await this.ppp.sendPacket(PppProtocol.IPV4, packet);
	}

	private handlePacket(protocol: number, data: Buffer): void {
		if (protocol != PppProtocol.IPV4 || !this.destination)
			return;
		const ip = parseIpv4Packet(data);
		if (!ip || ip.protocol != IpProtocol.TCP || !ip.source.equals(this.destination) || !ip.destination.equals(this.source))
			return;
		if (ip.payload.length < 20 || transportChecksum(ip.source, ip.destination, IpProtocol.TCP, ip.payload) != 0)
			return;
		if (ip.payload.readUInt16BE(0) != this.remotePort || ip.payload.readUInt16BE(2) != this.localPort)
			return;
		const headerLength = (ip.payload[12] >> 4) * 4;
		if (headerLength < 20 || headerLength > ip.payload.length)
			return;
		const segment = {
			sequence: ip.payload.readUInt32BE(4),
			acknowledgement: ip.payload.readUInt32BE(8),
			flags: ip.payload[13],
			payload: ip.payload.subarray(headerLength),
		};
		if (!this.connected) {
			if (this.segmentWaiter) {
				const waiter = this.segmentWaiter;
				this.segmentWaiter = undefined;
				clearTimeout(waiter.timer);
				waiter.resolve(segment);
			} else {
				this.segments.push(segment);
			}
			return;
		}
		this.handleConnectedSegment(segment);
	}

	private handleConnectedSegment(segment: TcpSegment): void {
		if ((segment.flags & TCP_RST) != 0) {
			this.ackWaiter?.reject(new Error('TCP connection was reset by the peer.'));
			this.ackWaiter = undefined;
			this.destroy();
			return;
		}
		if ((segment.flags & TCP_ACK) != 0 && this.ackWaiter?.acknowledgement == segment.acknowledgement) {
			const waiter = this.ackWaiter;
			this.ackWaiter = undefined;
			waiter.resolve();
		}
		if (segment.sequence != this.remoteSequence) {
			void this.sendSegment(TCP_ACK, Buffer.alloc(0)).catch((error: unknown) => debug('TCP ACK failed: %O', error));
			return;
		}
		if (segment.payload.length > 0) {
			this.remoteSequence = (this.remoteSequence + segment.payload.length) >>> 0;
			const data = Buffer.from(segment.payload);
			for (const callback of this.handlers) {
				try {
					callback(data);
				} catch (error) {
					debug('TCP data callback failed: %O', error);
				}
			}
		}
		if ((segment.flags & TCP_FIN) != 0) {
			this.remoteSequence = (this.remoteSequence + 1) >>> 0;
			this.remoteClosed = true;
			if (this.closeWaiter) {
				const waiter = this.closeWaiter;
				this.closeWaiter = undefined;
				clearTimeout(waiter.timer);
				waiter.resolve();
			}
		}
		if (segment.payload.length > 0 || (segment.flags & TCP_FIN) != 0)
			void this.sendSegment(TCP_ACK, Buffer.alloc(0)).catch((error: unknown) => debug('TCP ACK failed: %O', error));
	}

	private nextSegment(timeout: number): Promise<TcpSegment> {
		const segment = this.segments.shift();
		if (segment)
			return Promise.resolve(segment);
		if (this.segmentWaiter)
			throw new Error('Only one TCP packet consumer is supported.');
		const { promise, resolve, reject } = usePromiseWithResolvers<TcpSegment>();
		this.segmentWaiter = {
			resolve,
			reject,
			timer: setTimeout(() => {
				this.segmentWaiter = undefined;
				reject(new Error('TCP response timed out.'));
			}, timeout),
		};
		return promise;
	}

	private waitForRemoteClose(timeout: number): Promise<void> {
		if (timeout <= 0)
			throw new Error('TCP close timed out.');
		if (this.closeWaiter)
			throw new Error('TCP close is already in progress.');
		const { promise, resolve, reject } = usePromiseWithResolvers<void>();
		this.closeWaiter = {
			resolve,
			reject,
			timer: setTimeout(() => {
				this.closeWaiter = undefined;
				reject(new Error('TCP close timed out.'));
			}, timeout),
		};
		return promise;
	}

	private ensureConnected(): void {
		if (!this.connected || this.remoteClosed || this.closing || this.closed)
			throw new Error('TCP socket is not connected.');
	}
}

function randomEphemeralPort(): number {
	return 49152 + Math.floor(Math.random() * 16384);
}
