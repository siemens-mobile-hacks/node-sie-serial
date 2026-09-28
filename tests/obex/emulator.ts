// Runs an emulated Siemens phone for the e2e tests.
//
// pmb887x-emu boots a real fullflash and exposes the phone's USART0 as a QEMU
// TCP chardev, which serialport reaches through serialport-bindings-socket. The
// firmware that answers on it is the phone's own, so the tests talk to a real
// AT interpreter and a real FlexMem OBEX server - see tests/obex/README.md for what
// the emulator can and cannot do.

import { spawn, spawnSync, ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { SerialPortStream } from '@serialport/stream';
import { SocketBinding, SocketBindingInterface } from 'serialport-bindings-socket';
import { AsyncSerialPort, PhonePlatform } from '../../src/index.js';
import { PhoneTarget, RECONNECT_WAIT_MS, RunningTarget } from './target.js';

// The phone is still booting, and its file system comes up well after its AT
// interpreter answers
const READY_TIMEOUT_MS = 180000;

export type EmulatedPhone = {
	// the pmb887x-emu board name
	device: string;
	// the fullflash file in the fullflashes directory
	fullflash: string;
	// what the phone answers to AT+CGMI/AT+CGMM/AT+CGMR
	deviceName: string;
	platform: PhonePlatform;
	// how long to let the phone boot before talking to it. Its AT interpreter
	// answers after ~10-16 s already, but the rest of the startup then still
	// blocks the serial task for many seconds at a time - long enough for an
	// OBEX exchange to run into its timeout, after which the session is lost
	// for good. Waiting the phone out is what makes the suite reproducible.
	bootWaitMS: number;
	// a directory of this firmware the tests may create and delete entries in
	writableDir: string;
	// a directory of this firmware holding small files to download
	smallFilesDir: string;
};

export const EL71: EmulatedPhone = {
	device: 'siemens-el71',
	fullflash: 'EL71v41lg91.bin',
	deviceName: 'SIEMENS EL71 v41',
	platform: 'NewSGOLD',
	bootWaitMS: 60000,
	writableDir: '/Data/Misc',
	smallFilesDir: '/Cache/default',
};

export const S75: EmulatedPhone = {
	device: 'siemens-s75',
	fullflash: 'S75v40lg1.bin',
	deviceName: 'SIEMENS S75 v40',
	platform: 'NewSGOLD',
	bootWaitMS: 60000,
	writableDir: '/Data/Misc',
	smallFilesDir: '/Data/Misc',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Either point the environment variables at them, or put them where the
// gitignored defaults are - a symlink into an emulator build and a fullflash
// collection elsewhere does the job.
const EMU_CANDIDATES = [
	process.env.OBEX_E2E_EMU,
	path.join(HERE, '.emu/pmb887x-emu'),
].filter((candidate): candidate is string => !!candidate);

const FULLFLASH_DIRS = [
	process.env.OBEX_E2E_FULLFLASHES,
	path.join(HERE, 'fullflashes'),
].filter((candidate): candidate is string => !!candidate);

function findEmulator(): string | undefined {
	for (const candidate of EMU_CANDIDATES) {
		if (fs.existsSync(candidate) && spawnSync(candidate, ['--version']).status === 0)
			return candidate;
	}
	// stdout is null when `which` itself is missing
	const fromPath = spawnSync('which', ['pmb887x-emu'], { encoding: 'utf8' }).stdout?.trim();
	return fromPath || undefined;
}

function findFullflash(name: string): string | undefined {
	for (const dir of FULLFLASH_DIRS) {
		const file = path.join(dir, name);
		if (fs.existsSync(file))
			return file;
	}
	return undefined;
}

/**
 * Why the e2e tests cannot run here, or undefined when they can. The suites skip
 * themselves with this message instead of failing: a checkout without the
 * emulator and the fullflashes is the normal case.
 */
function emulatorUnavailable(phone: EmulatedPhone): string | undefined {
	if (!findEmulator())
		return `pmb887x-emu not found (looked at ${EMU_CANDIDATES.join(', ')}, and in PATH). ` +
			`Build it from https://github.com/siemens-mobile-hacks/pmb887x-emu and point OBEX_E2E_EMU at it.`;
	if (!findFullflash(phone.fullflash))
		return `the fullflash ${phone.fullflash} was not found in ${FULLFLASH_DIRS.join(', ')}. ` +
			`Point OBEX_E2E_FULLFLASHES at a directory holding it.`;
	return undefined;
}

// Every emulator that is still running, so that none of them survives this
// process: they are spawned detached (to be killable as a group) and would
// otherwise keep running - and keep eating CPU, which makes the next run's
// phones miss their timing - whenever vitest tears a worker down before
// afterAll finished.
const runningEmulators = new Set<() => void>();

// A QEMU that crashed was killed by a signal, and has no exit code
function exited(emu: ChildProcess): boolean {
	return emu.exitCode !== null || emu.signalCode !== null;
}

function killEmulatorGroup(emu: ChildProcess): void {
	if (exited(emu))
		return;
	try {
		process.kill(-emu.pid!, 'SIGKILL');
	} catch {
		emu.kill('SIGKILL');
	}
}

function killRunningEmulators(): void {
	for (const kill of runningEmulators)
		kill();
	runningEmulators.clear();
}

process.on('exit', killRunningEmulators);
// A signal listener replaces Node's default of terminating, and a vitest worker
// that ignores Ctrl-C or a CI's SIGTERM lives on as an orphan spinning on its
// closed IPC channel. So after the cleanup the signal is raised again with the
// listener gone (once), which terminates the process; process.exit() would
// throw inside vitest.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
	process.once(signal, () => {
		killRunningEmulators();
		process.kill(process.pid, signal);
	});
}

async function allocatePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address() as net.AddressInfo;
			server.close(() => resolve(port));
		});
	});
}

async function waitForSerialPort(port: number, timeoutMS: number, emu: ChildProcess): Promise<void> {
	const deadline = Date.now() + timeoutMS;
	while (Date.now() < deadline) {
		const open = await new Promise<boolean>((resolve) => {
			const socket = net.connect({ host: '127.0.0.1', port });
			socket.once('connect', () => { socket.destroy(); resolve(true); });
			socket.once('error', () => resolve(false));
		});
		if (open)
			return;
		if (exited(emu))
			throw new Error(`the emulator exited with ${emu.exitCode ?? emu.signalCode} before opening its serial port`);
		await delay(300);
	}
	throw new Error(`the emulator serial port 127.0.0.1:${port} did not open within ${timeoutMS} ms`);
}

/**
 * Boots one emulated phone and opens its serial port. The fullflash is mapped
 * as a writable QEMU pflash drive (--rw), so FlexMem writes really land in the
 * flash image, and it is a private copy: the writes persist across an emulator
 * restart and would otherwise modify the shared fullflash.
 */
async function startPhone(phone: EmulatedPhone): Promise<RunningTarget> {
	const emuBin = findEmulator()!;
	const flashCopyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obex-e2e-'));
	const flashPath = path.join(flashCopyDir, phone.fullflash);
	fs.copyFileSync(findFullflash(phone.fullflash)!, flashPath);

	const tcpPort = await allocatePort();
	const args = [
		'--device', phone.device,
		'--fullflash', flashPath,
		// the emulator's own defaults for the siemens-* boards
		'--siemens-esn=12345678',
		'--siemens-imei=490154203237518',
		'--serial', `tcp:127.0.0.1:${tcpPort},server=on,wait=off`,
		'--rw',
	];

	// detached: the emulator and its QEMU get their own process group, which is
	// what stop() kills - killing only the parent leaves QEMU behind
	const emu = spawn(emuBin, args, {
		detached: true,
		env: { ...process.env, QEMU_AUDIO_DRV: 'none' },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	const output: Buffer[] = [];
	emu.stdout.on('data', (chunk: Buffer) => output.push(chunk));
	emu.stderr.on('data', (chunk: Buffer) => output.push(chunk));
	const log = () => Buffer.concat(output).toString().trimEnd();

	const cleanup = () => {
		killEmulatorGroup(emu);
		fs.rmSync(flashCopyDir, { recursive: true, force: true });
	};
	runningEmulators.add(cleanup);

	const stop = async (): Promise<void> => {
		runningEmulators.delete(cleanup);
		const wasRunning = !exited(emu);
		cleanup();
		if (wasRunning)
			await delay(200);
	};

	try {
		await waitForSerialPort(tcpPort, 60000, emu);
		// The AT interpreter comes up well after the chardev does, and the boot
		// ROM would answer AT commands in between
		await delay(phone.bootWaitMS);

		// The host baud rate is meaningless on a TCP chardev; the firmware pins
		// USART0 at 115200 either way
		const port = new AsyncSerialPort(new SerialPortStream<SocketBindingInterface>({
			binding: SocketBinding,
			path: `tcp://127.0.0.1:${tcpPort}`,
			baudRate: 115200,
			autoOpen: false,
		}));
		await port.open();
		return { port, log, stop };
	} catch (e) {
		await stop();
		const emuOutput = log();
		throw new Error(`${(e as Error).message}${emuOutput ? `\nEmulator output:\n${emuOutput}` : ''}`);
	}
}

// The suite's view of an emulated phone: everything about it is known, and every
// run boots it from a private copy of its fullflash
export function emulatorTarget(phone: EmulatedPhone): PhoneTarget {
	return {
		name: phone.device,
		unavailable: emulatorUnavailable(phone),
		deviceName: phone.deviceName,
		platform: phone.platform,
		baudRate: 0,
		writableDir: phone.writableDir,
		smallFilesDir: phone.smallFilesDir,
		reconnectWaitMS: RECONNECT_WAIT_MS,
		readyTimeoutMS: READY_TIMEOUT_MS,
		start: () => startPhone(phone),
	};
}
