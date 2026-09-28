import { describe, expect, test } from 'vitest';
import { ObexBfbLink } from './ObexBfbLink.js';
import { openDevicePort, SerialDevice } from '../../tests/obex/phones/fakePhone.js';

// Wire bytes of siefs' tra_send() and obexftp's bfb_stuff_data(), which frame
// these packets byte-identically: 0x02 marks the first packet of the session,
// frames carry at most 32 bytes, and the CRC is CRC-16/X.25 in little endian
const CONNECT = Buffer.from('80001a100040064600136b01cb31410611d49a770050da3f471f', 'hex');
const CONNECT_FRAMES = Buffer.from('16203602fd00001a80001a100040064600136b01cb31410611d49a770050da3f471f21160117e3', 'hex');
const GET_NEXT = Buffer.from('830003', 'hex');
const GET_NEXT_FRAMES = Buffer.from('160a1c03fc0100038300037a07', 'hex');

// And the phone's answers, framed the same way
const SUCCESS = Buffer.from('a00003', 'hex');
const SUCCESS_FRAMES = Buffer.from('160a1c02fd000003a000030eef', 'hex');
const BODY = Buffer.from('9000284800256768696a6b6c6d6e6f707172737475767778797a6162636465666768696a6b6c6d6e', 'hex');
const BODY_FRAMES = Buffer.from('16203603fc0100289000284800256768696a6b6c6d6e6f707172737475767778797a61160f1962636465666768696a6b6c6d6e53df', 'hex');

const ACK = Buffer.from('16021401fe', 'hex');
const HELLO = Buffer.from('02010314', 'hex');
const HELLO_ANSWER = Buffer.from('02020014aa', 'hex');

const TIMEOUTS = { hello: 50, ack: 50, flush: 10 };
const LEAVE = Buffer.concat([Buffer.from([0x06, 0x0A, 0x0C]), Buffer.from('at^sbfb=0\r')]);

// A phone that answers the hello at helloSpeed and whatever else answer() returns
async function phone(answer: (data: Buffer) => Buffer | undefined = () => undefined, helloSpeed = 57600) {
	const writes: Buffer[] = [];
	const serial: SerialDevice & { refusedBaudRates: number[]; respond(data: Buffer): void } = {
		baudRate: undefined,
		refusedBaudRates: [],
		output: () => {},
		respond: (data) => serial.output(data),
		receive(data) {
			writes.push(data);
			const response = data.equals(HELLO) ? (serial.baudRate == helloSpeed ? HELLO_ANSWER : undefined) : answer(data);
			if (response)
				serial.respond(response);
		},
	};
	return { serial, port: await openDevicePort(serial), writes };
}

describe('OBEX: ObexBfbLink', () => {
	test('open finds the speed the phone answers the hello at', async () => {
		const { serial, port } = await phone(undefined, 115200);
		await ObexBfbLink.open(port, TIMEOUTS);
		expect(serial.baudRate).toBe(115200);
	});

	test('open gives up when no speed answers', async () => {
		const { port } = await phone(undefined, 9600);
		await expect(ObexBfbLink.open(port, TIMEOUTS)).rejects.toThrow('The phone does not answer in BFB mode.');
	});

	test('packets go out in 32 byte frames, only the first one of the session marked 0x02', async () => {
		const { port, writes } = await phone(() => ACK);
		const link = await ObexBfbLink.open(port, TIMEOUTS);

		await link.send(CONNECT);
		expect(writes[writes.length - 1]).toEqual(CONNECT_FRAMES);
		await link.send(GET_NEXT);
		expect(writes[writes.length - 1]).toEqual(GET_NEXT_FRAMES);
	});

	// siefs acknowledges again before each resend, in case the phone is still
	// resending a packet of its own
	test('an unacknowledged packet is sent again, three times at most', async () => {
		const { port, writes } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		await expect(link.send(CONNECT)).rejects.toThrow('The phone does not acknowledge BFB packets.');
		expect(writes).toEqual([CONNECT_FRAMES, ACK, CONNECT_FRAMES, ACK, CONNECT_FRAMES]);
	});

	test('an acknowledgement behind noise counts', async () => {
		const { port, writes } = await phone(() => Buffer.concat([Buffer.from('00ff', 'hex'), ACK]));
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		await link.send(CONNECT);
		expect(writes).toEqual([CONNECT_FRAMES]);
	});

	// Sent again, the packet would run twice on a phone that does not recognize resends
	test('an answer in place of the acknowledgement counts as one, and is received', async () => {
		const { port, writes } = await phone((data) => data.equals(CONNECT_FRAMES) ? SUCCESS_FRAMES : undefined);
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		await link.send(CONNECT);
		expect(await link.receive(1000)).toEqual(SUCCESS);
		expect(writes).toEqual([CONNECT_FRAMES, ACK]);
	});

	// Our acknowledgement of that answer got lost, so the phone is still sending it
	test('a resend of the previous answer is no acknowledgement', async () => {
		let packets = 0;
		const { serial, port, writes } = await phone((data) => {
			if (data.equals(ACK))
				return undefined;
			return ++packets == 1 ? SUCCESS_FRAMES : ACK;
		});
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		serial.respond(SUCCESS_FRAMES);
		expect(await link.receive(1000)).toEqual(SUCCESS);
		writes.length = 0;

		await link.send(CONNECT);
		expect(writes).toEqual([CONNECT_FRAMES, ACK, CONNECT_FRAMES]);
	});

	test('frames of other channels are skipped', async () => {
		const { serial, port } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);

		serial.respond(Buffer.concat([HELLO_ANSWER, SUCCESS_FRAMES]));
		expect(await link.receive(1000)).toEqual(SUCCESS);
	});

	test('a header announcing more than 32 bytes is noise, not a frame', async () => {
		const { serial, port } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);

		serial.respond(Buffer.concat([Buffer.from([0x16, 0x40, 0x16 ^ 0x40]), SUCCESS_FRAMES]));
		expect(await link.receive(1000)).toEqual(SUCCESS);
	});

	test('a packet is assembled from its frames and acknowledged, noise and stray acknowledgements are skipped', async () => {
		const { serial, port, writes } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		serial.respond(Buffer.concat([Buffer.from('00ff41', 'hex'), ACK, SUCCESS_FRAMES, BODY_FRAMES]));
		expect(await link.receive(1000)).toEqual(SUCCESS);
		expect(await link.receive(1000)).toEqual(BODY);
		expect(writes).toEqual([ACK, ACK]);
	});

	test('a resent packet is acknowledged again but delivered once', async () => {
		const { serial, port, writes } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		serial.respond(Buffer.concat([SUCCESS_FRAMES, SUCCESS_FRAMES, BODY_FRAMES]));
		expect(await link.receive(1000)).toEqual(SUCCESS);
		expect(await link.receive(1000)).toEqual(BODY);
		expect(writes).toEqual([ACK, ACK, ACK]);
	});

	test('a packet with a bad CRC is not acknowledged, its resend is', async () => {
		const { serial, port, writes } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		writes.length = 0;

		const corrupted = Buffer.from(SUCCESS_FRAMES);
		corrupted[corrupted.length - 1] ^= 0xFF;
		serial.respond(Buffer.concat([corrupted, SUCCESS_FRAMES]));
		expect(await link.receive(1000)).toEqual(SUCCESS);
		expect(writes).toEqual([ACK]);
	});

	test('receive fails once its timeout passes', async () => {
		const { port } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);
		await expect(link.receive(100)).rejects.toThrow('Serial receive timeout.');
	});

	test('close sends at^sbfb=0 in an AT frame, like siefs', async () => {
		const { port, writes } = await phone();
		const link = await ObexBfbLink.open(port, TIMEOUTS);

		await link.close();
		expect(writes[writes.length - 1]).toEqual(LEAVE);
	});

	// For a phone at a BFB speed nobody knows: one the hello missed, or one a killed
	// session left in BFB mode
	test('leave sends at^sbfb=0 at every speed BFB runs at', async () => {
		const speeds: number[] = [];
		const serial: SerialDevice = {
			baudRate: undefined,
			output: () => {},
			receive(data) {
				if (data.equals(LEAVE))
					speeds.push(serial.baudRate!);
			},
		};

		await ObexBfbLink.leave(await openDevicePort(serial), TIMEOUTS);
		expect(speeds).toEqual([57600, 115200, 230400]);
	});

	test('open and leave skip a speed the port refuses', async () => {
		const { serial, port } = await phone(undefined, 230400);
		serial.refusedBaudRates = [115200];

		await ObexBfbLink.open(port, TIMEOUTS);
		expect(serial.baudRate).toBe(230400);
		await ObexBfbLink.leave(port, TIMEOUTS);
	});
});
