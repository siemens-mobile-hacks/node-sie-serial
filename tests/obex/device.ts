// The OBEX suite against a real phone on a cable:
//
//   OBEX_E2E_DEVICE=/dev/ttyUSB0 pnpm test:obex-hardware
//
// Nothing about the phone is known in advance: its identity is read from it and
// only its shape is checked. Where the tests may write differs per generation,
// so the suite picks the directory from the phone's folder listings.
//
// This writes to the phone. The suite creates e2e-* files and an e2e-dir folder
// in that directory and deletes them again; it touches nothing else.

import { openPort } from '../../examples/utils.js';
import { PhoneTarget, RECONNECT_WAIT_MS } from './target.js';

// Unlike an emulator, a real phone is not booting: it answers right away or not
// at all, and a long silent retry only delays saying so
const READY_TIMEOUT_MS = 45000;

export function deviceTarget(): PhoneTarget {
	const path = process.env.OBEX_E2E_DEVICE;
	const baudRate = Number(process.env.OBEX_E2E_BAUDRATE ?? 0);
	const reconnectWaitMS = Number(process.env.OBEX_E2E_RECONNECT_WAIT_MS ?? RECONNECT_WAIT_MS);
	return {
		name: path ?? 'a real phone',
		unavailable: unavailable(path, baudRate, reconnectWaitMS),
		baudRate,
		smallFilesDir: process.env.OBEX_E2E_SMALL_FILES_DIR,
		reconnectWaitMS,
		readyTimeoutMS: READY_TIMEOUT_MS,
		async start() {
			// The speed is the probe's business, this only opens the port
			const port = await openPort(path!, 115200);
			await port.open();
			return {
				port,
				// the phone keeps no log for us
				log: () => '',
				stop: () => port.close(),
			};
		},
	};
}

function unavailable(path: string | undefined, baudRate: number, reconnectWaitMS: number): string | undefined {
	if (!path)
		return 'set OBEX_E2E_DEVICE (e.g. /dev/ttyUSB0) to run these against a real phone';
	if (!Number.isInteger(baudRate) || baudRate < 0)
		return `OBEX_E2E_BAUDRATE must be a baud rate, not ${JSON.stringify(process.env.OBEX_E2E_BAUDRATE)}`;
	if (!Number.isFinite(reconnectWaitMS) || reconnectWaitMS < 0)
		return `OBEX_E2E_RECONNECT_WAIT_MS must be a number of milliseconds, not ${JSON.stringify(process.env.OBEX_E2E_RECONNECT_WAIT_MS)}`;
	return undefined;
}
