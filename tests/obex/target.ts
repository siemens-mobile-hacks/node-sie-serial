// What the OBEX suite runs against: an emulated phone it boots itself, or a real
// one already on the end of a cable.
//
// The two differ in what the suite may assume. An emulator is a known firmware,
// so its identity and directories are in the table next to it; a real phone is
// whatever somebody plugged in, so its identity is read from the phone and only
// its shape is checked.

import { AsyncSerialPort, PhonePlatform } from '../../src/index.js';

// A phone answers AT commands a moment after the +++ escape, five seconds is
// generous
export const RECONNECT_WAIT_MS = 5000;

export interface RunningTarget {
	port: AsyncSerialPort;
	// everything the harness captured, for a failure message
	log(): string;
	stop(): Promise<void>;
}

export interface PhoneTarget {
	// names the describe block
	name: string;
	// why the suite cannot run, when it cannot: it skips with this
	unavailable?: string;
	// what the phone answers to AT+CGMI/AT+CGMM/AT+CGMR and its platform, when
	// that is known before it is asked
	deviceName?: string;
	platform?: PhonePlatform;
	// the speed connect() pins the AT probe to, 0 probes all of them
	baudRate: number;
	// a directory the tests may create and delete entries in; without one the
	// suite looks for one itself
	writableDir?: string;
	// a directory holding files small enough to download quickly; without one the
	// suite goes looking for such a file itself
	smallFilesDir?: string;
	// how long to leave the phone alone after a disconnect before connecting again
	reconnectWaitMS: number;
	// how long to keep trying until the phone and its file system answer. An
	// emulator is still booting, a real phone answers right away or not at all.
	readyTimeoutMS: number;
	start(): Promise<RunningTarget>;
}
