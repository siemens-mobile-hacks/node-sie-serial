// The e2e tests of the OBEX client, run against one phone: an emulated one, or a
// real one on a cable (see target.ts).
//
// Every test talks to the phone's real FlexMem server over its serial port: the
// packets are the ones src/obex/OBEX.ts builds and the answers come out of the phone
// firmware. Bringing a phone up takes a while, so one session is shared by the
// whole suite and the tests run in order.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import { AsyncSerialPort, OBEX, ObexDirEntry, PhonePlatform } from '../../src/index.js';
import { PhoneTarget, RunningTarget } from './target.js';
import { findListedDirs, WRITABLE_DIR_CANDIDATES } from './phones/probe.js';

// A file of the firmware below this size is read back whole
const MAX_READ_SIZE = 4096;

// Several packets on every phone: the x75 ones take ~8 KiB per packet
const PAYLOAD_SIZE = 16 * 1024;

// How many directories the suite lists at most while looking for such a file
const MAX_SEARCHED_DIRS = 20;

// Everything the tests create in the writable directory. A run that failed
// halfway leaves some of them behind, and the next run deletes them first.
const E2E_NAMES = ['e2e-probe.bin', 'e2e-roundtrip.bin', 'e2e-overwrite.bin', 'e2e-dir', 'e2e-before.bin', 'e2e-after.bin'];

function find(entries: ObexDirEntry[], name: string): ObexDirEntry | undefined {
	return entries.find((entry) => entry.name == name);
}

// The absolute form OBEX.getCurrentPath() reports, e.g. "/Data/Misc"
function normalizePath(path: string): string {
	return '/' + path.split('/').filter(Boolean).join('/');
}

function joinPath(dir: string, name: string): string {
	return normalizePath(`${dir}/${name}`);
}

// How much of what the phone sent is kept for the panic check
const RECEIVED_TAIL_SIZE = 4096;

// The last bytes the phone sent, tapped below the stream so that the protocols see
// the port unchanged. A phone that panics writes ">>EXIT<< ... FILE: ..." to its
// serial line and never answers again (see README.md); the OBEX client skips that
// text as garbage, so only this tail says why the phone went quiet.
function tapReceived(port: AsyncSerialPort): () => Buffer {
	const binding = (port.getParentPort() as any).port;
	const read = binding.read;
	let tail = Buffer.alloc(0);
	binding.read = async (buffer: Buffer, offset: number, length: number) => {
		const result = await read.call(binding, buffer, offset, length);
		tail = Buffer.concat([tail, buffer.subarray(offset, offset + result.bytesRead)]).subarray(-RECEIVED_TAIL_SIZE);
		return result;
	};
	return () => tail;
}

// The panic message among the bytes the phone sent, if it panicked
function findPanic(received: Buffer): string | undefined {
	const text = received.toString('latin1');
	const at = text.indexOf('>>EXIT<<');
	return at < 0 ? undefined : text.slice(at, at + 300).replace(/[^\x20-\x7e]+/g, ' ').trim();
}

export function obexSuite(target: PhoneTarget): void {
	const suite = target.unavailable ? describe.skip : describe;
	if (target.unavailable)
		console.warn(`Skipping the e2e tests on ${target.name}: ${target.unavailable}`);

	function payload(seed: number): Buffer {
		const data = Buffer.alloc(PAYLOAD_SIZE);
		for (let i = 0; i < data.length; i++)
			data[i] = (i * 7 + seed) & 0xFF;
		return data;
	}

	suite(`OBEX on ${target.name}`, () => {
		let running: RunningTarget;
		let obex: OBEX;
		// What the phone said about itself on the first connect
		let identity: { deviceName?: string; platform: PhonePlatform };
		let writableDir: string;
		// Whether writableDir gives an upload back: the A56's /Bitmap has taken
		// uploads and answered the GET of one with an empty file
		let keepsFiles = true;
		let received: () => Buffer = () => Buffer.alloc(0);
		let panicked = false;

		beforeAll(async () => {
			running = await target.start();
			received = tapReceived(running.port);
			obex = new OBEX(running.port);
			try {
				await waitUntilReady();
				identity = { deviceName: obex.getDeviceName(), platform: obex.getPlatform() };
				console.log(`${target.name}: ${identity.deviceName ?? 'a phone without a name'}, ` +
					`${identity.platform}, max packet ${obex.getMaxPacketSize()} bytes`);
				await chooseWritableDir();
			} catch (e) {
				// A real phone stays on its cable, and would stay in OBEX mode
				await obex.disconnect().catch(() => {});
				const log = running.log();
				const panic = findPanic(received());
				await running.stop();
				throw new Error(`${(e as Error).message}` +
					`${panic ? `\n${target.name} panicked: ${panic}` : ''}` +
					`${log ? `\nEmulator output:\n${log}` : ''}`);
			}
		});

		// A panicked phone answers nothing any more, so the later tests fail at once
		// instead of each running into its timeouts. A session lost otherwise, e.g.
		// to a failed reconnect, is opened again, so that it fails one test only.
		beforeEach(async () => {
			if (panicked)
				throw new Error(`${target.name} panicked in an earlier test: ${findPanic(received())}`);
			if (!obex.isConnected)
				await obex.connect(target.baudRate);
		});

		// The test the phone panicked in gets the panic as one of its errors
		afterEach(() => {
			const panic = findPanic(received());
			if (panic && !panicked) {
				panicked = true;
				throw new Error(`${target.name} panicked: ${panic}`);
			}
		});

		// The AT interpreter answers long before the file system behind OBEX is
		// up: an emulated phone already lists directories while opening a file in
		// them is still answered with "Not found". How long that takes is wall
		// clock and not guest time - QEMU runs the phone on a precise instruction
		// clock, so a busy host boots it more slowly - so this waits for a real
		// file operation to succeed instead of for a fixed time.
		async function waitUntilReady(): Promise<void> {
			const deadline = Date.now() + target.readyTimeoutMS;
			let lastError: unknown;
			while (Date.now() < deadline) {
				try {
					if (!obex.isConnected)
						await obex.connect(target.baudRate);
					await readSmallFile();
					return;
				} catch (e) {
					lastError = e;
					await delay(3000);
				}
			}
			throw new Error(`${target.name} was not ready after ${target.readyTimeoutMS / 1000} s: ${(lastError as Error)?.message}`);
		}

		// A file of the firmware below MAX_READ_SIZE: in smallFilesDir, or else the
		// first one a walk from the root comes across
		async function findSmallFile(): Promise<{ path: string; size: number }> {
			const queue = [target.smallFilesDir ?? '/'];
			for (let listed = 0; queue.length && listed < MAX_SEARCHED_DIRS; listed++) {
				const dir = queue.shift()!;
				// While searching, a folder the phone will not enter is no reason to stop
				const entries = target.smallFilesDir ? await obex.readDir(dir) : await obex.readDir(dir).catch(() => []);
				const files = entries.filter((entry) => !entry.isDir && entry.size > 0 && entry.size < MAX_READ_SIZE);
				if (files.length) {
					const file = files.sort((a, b) => a.size - b.size)[0];
					return { path: joinPath(dir, file.name), size: file.size };
				}
				// Hidden folders too: the system folders a phone hides by withholding the
				// read permission still list, and hold the small files
				if (!target.smallFilesDir)
					queue.push(...entries.filter((entry) => entry.isDir).map((entry) => joinPath(dir, entry.name)));
			}
			throw new Error(`no file below ${MAX_READ_SIZE} bytes in ${target.smallFilesDir ?? `the first ${MAX_SEARCHED_DIRS} folders`}`);
		}

		// Downloads such a file and checks it against the size the phone's own
		// listing announced for it
		async function readSmallFile(): Promise<void> {
			const file = await findSmallFile();
			const data = await obex.getFile(file.path);
			expect(data.length, file.path).toBe(file.size);
			expect(data.every((byte) => byte == 0)).toBe(false);
		}

		// The candidates the listings show. A folder the phone lists but will not enter
		// counts as empty.
		async function listedDirs(): Promise<string[]> {
			const found = await findListedDirs((dir) => obex.readDir(dir).catch(() => []));
			if (!found.length) {
				const root = (await obex.readDir('/')).map((entry) => entry.name).join(', ');
				throw new Error(`The phone lists none of ${WRITABLE_DIR_CANDIDATES.join(', ')}, ` +
					`the root holds: ${root}. Add one of its folders to WRITABLE_DIR_CANDIDATES.`);
			}
			return found;
		}

		// The folder the target names, or else the first listed candidate that gives
		// a small upload back. Without one, the tests that upload are skipped, and the
		// others use the first candidate.
		async function chooseWritableDir(): Promise<void> {
			const candidates = target.writableDir ? [target.writableDir] : await listedDirs();
			const reasons: string[] = [];
			for (const dir of candidates) {
				const reason = await uploadComesBack(dir);
				if (!reason) {
					writableDir = dir;
					console.log(`${target.name}: the tests write into ${writableDir}`);
					return;
				}
				reasons.push(`${dir} ${reason}`);
			}
			writableDir = candidates[0];
			keepsFiles = false;
			console.warn(`${target.name}: no folder keeps an uploaded file (${reasons.join('; ')}), ` +
				`the tests that upload are skipped and the others use ${writableDir}`);
		}

		// Clears what a failed run left in dir, then uploads a small file and reads it
		// back. Why it did not come back, or undefined when it did.
		async function uploadComesBack(dir: string): Promise<string | undefined> {
			const probe = joinPath(dir, 'e2e-probe.bin');
			const data = Buffer.alloc(32, 0x5A);
			try {
				for (const entry of await obex.readDir(dir)) {
					if (E2E_NAMES.includes(entry.name))
						await obex.deleteFile(joinPath(dir, entry.name));
				}
				await obex.putFile(probe, data);
				const back = await obex.getFile(probe).catch((e: Error) => e);
				await obex.deleteFile(probe).catch(() => {});
				if (back instanceof Error)
					return `takes uploads, but gives them back as: ${back.message}`;
				return back.equals(data) ? undefined : `takes uploads, but gives back ${back.length} of the ${data.length} bytes`;
			} catch (e) {
				return `refuses them: ${(e as Error).message}`;
			}
		}

		// A real phone stays on its cable after the suite, so it is handed back to
		// its AT interpreter
		afterAll(async () => {
			const panic = findPanic(received());
			if (panic)
				console.error(`${target.name} panicked: ${panic}`);

			await obex?.disconnect();
			await running?.port.close().catch(() => {});
			await running?.stop();
		});

		test('the phone identifies itself', (ctx) => {
			expect(obex.isConnected).toBe(true);
			if (target.deviceName) {
				expect(identity).toEqual({ deviceName: target.deviceName, platform: target.platform });
				return;
			}
			// On a cable without the +++ escape, like the DCA-540, a phone an earlier
			// session left in OBEX mode is connected in it and never asked AT+CGMM
			if (identity.deviceName === undefined && identity.platform == 'unknown')
				ctx.skip('the phone was found in OBEX mode and not asked for its name: power-cycle it to test this');
			// Whatever phone this is, it has a name and a model of a known platform
			expect(identity.deviceName).toBeTruthy();
			expect(identity.platform).not.toBe('unknown');
		});

		test('CONNECT settles on a packet size both sides take', () => {
			// we offer 0x4006, the x75 phones answer ~8 KiB, the x65 ones 1030 and the C60 474
			const size = obex.getMaxPacketSize();
			expect(size).toBeGreaterThanOrEqual(255);
			expect(size).toBeLessThanOrEqual(0x4006);
		});

		test('the phone reports its FlexMem capacity and free space', async () => {
			const capacity = await obex.getCapacity();
			const available = await obex.getAvailable();
			expect(capacity).toBeGreaterThan(0);
			expect(available).toBeGreaterThan(0);
			expect(available).toBeLessThan(capacity);
		});

		test('the root directory holds folders', async () => {
			const entries = await obex.readDir('/');
			expect(entries.some((entry) => entry.isDir), entries.map((e) => e.name).join(', ')).toBe(true);
			expect(obex.getCurrentPath()).toBe('/');
		});

		test('setPath walks into a subdirectory and back to the root', async () => {
			const entries = await obex.readDir(writableDir);
			expect(obex.getCurrentPath()).toBe(normalizePath(writableDir));
			expect(entries.every((entry) => entry.name.length > 0)).toBe(true);

			await obex.readDir('/');
			expect(obex.getCurrentPath()).toBe('/');
		});

		test('a file of the firmware downloads with the size its listing announced', async () => {
			await readSmallFile();
		});

		test('the phone answers Not found for a file that is not there', async () => {
			await expect(obex.getFile(joinPath(writableDir, 'e2e-does-not-exist.bin')))
				.rejects.toThrow(/Not found/);
		});

		test('setPath into a directory that does not exist fails without creating it', async () => {
			await expect(obex.readDir(joinPath(writableDir, 'e2e-no-such-dir')))
				.rejects.toThrow(/setpath/);
			expect(find(await obex.readDir(writableDir), 'e2e-no-such-dir')).toBeUndefined();
		});

		// The +++ escape of disconnect() hands the wire back to the AT
		// interpreter, and the whole handshake has to work a second time
		test('the phone can be disconnected and connected again', async () => {
			await obex.disconnect();
			expect(obex.isConnected).toBe(false);

			await delay(target.reconnectWaitMS);

			await obex.connect(target.baudRate);
			expect(obex.isConnected).toBe(true);
			expect(obex.getDeviceName()).toBe(identity.deviceName);
			expect((await obex.readDir('/')).length).toBeGreaterThan(0);
		});

		test('an upload comes back byte for byte and can be deleted again', async (ctx) => {
			if (!keepsFiles)
				ctx.skip();
			const path = joinPath(writableDir, 'e2e-roundtrip.bin');
			const data = payload(0x11);
			const reports: number[] = [];

			await obex.putFile(path, data, (e) => reports.push(e.cursor));
			expect(reports[reports.length - 1], 'the progress callback did not reach the end').toBe(data.length);

			const listed = find(await obex.readDir(writableDir), 'e2e-roundtrip.bin');
			expect(listed, 'the uploaded file is not in the directory').toBeDefined();
			expect(listed!.isDir).toBe(false);
			expect(listed!.size).toBe(data.length);

			expect(await obex.getFile(path)).toEqual(data);

			await obex.deleteFile(path);
			expect(find(await obex.readDir(writableDir), 'e2e-roundtrip.bin')).toBeUndefined();
		});

		// The EGOLD and SGOLD phones append to an existing file instead of truncating
		// it, which is why putFile() deletes the target first
		test('uploading over an existing file replaces it instead of appending', async (ctx) => {
			if (!keepsFiles)
				ctx.skip();
			const path = joinPath(writableDir, 'e2e-overwrite.bin');
			const first = payload(0x22);
			const second = payload(0x33).subarray(0, 100);

			await obex.putFile(path, first);
			await obex.putFile(path, second);

			expect(await obex.getFile(path)).toEqual(second);
			await obex.deleteFile(path);
		});

		test('mkdir creates a directory the listing then shows', async () => {
			const path = joinPath(writableDir, 'e2e-dir');

			await obex.mkdir(path);
			const created = find(await obex.readDir(writableDir), 'e2e-dir');
			expect(created, 'the created directory is not in the listing').toBeDefined();
			expect(created!.isDir).toBe(true);

			await obex.deleteFile(path);
			expect(find(await obex.readDir(writableDir), 'e2e-dir')).toBeUndefined();
		});

		test('move renames a file in place', async (ctx) => {
			if (!keepsFiles)
				ctx.skip();
			const from = joinPath(writableDir, 'e2e-before.bin');
			const to = joinPath(writableDir, 'e2e-after.bin');
			const data = payload(0x55);

			await obex.putFile(from, data);
			await obex.move(from, to);

			const entries = await obex.readDir(writableDir);
			expect(find(entries, 'e2e-before.bin')).toBeUndefined();
			expect(find(entries, 'e2e-after.bin')).toBeDefined();
			expect(await obex.getFile(to)).toEqual(data);

			await obex.deleteFile(to);
		});
	});
}
