import { Duplex } from 'node:stream';
import type { PPP } from './PPP.js';
import { TCP } from './TCP.js';

export class TcpSocket extends Duplex {
	private readonly tcp: TCP;

	constructor(ppp: PPP) {
		super({ allowHalfOpen: false });
		this.tcp = new TCP(ppp);
		this.tcp.onData((data) => this.push(data));
		this.tcp.onEnd((error) => {
			if (error)
				this.destroy(error);
			else
				this.push(null);
		});
	}

	async connect(address: string, port: number, timeout?: number): Promise<void> {
		try {
			await this.tcp.connect(address, port, timeout);
		} catch (error) {
			this.destroy();
			throw error;
		}
	}

	override _read(): void {
	}

	override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
		this.tcp.send(chunk).then(() => callback(), callback);
	}

	override _final(callback: (error?: Error | null) => void): void {
		this.tcp.close().then(() => {
			this.push(null);
			callback();
		}, callback);
	}

	override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
		this.tcp.destroy();
		callback(error);
	}
}
