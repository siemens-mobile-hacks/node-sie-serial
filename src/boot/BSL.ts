import createDebug from 'debug';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { sprintf } from "sprintf-js";

const IGNITION_ON_PERIOD = 500;
const IGNITION_OFF_PERIOD = 250;

const CPU_NAMES: Record<number, string> = {
	0xB0:	'PMB8875 (SGold)',
	0xC0:	'PMB8876 (SGold2)',
};

const CPU_TYPES: Record<number, string> = {
	0xB0:	'sgold',
	0xC0:	'sgold2',
};

const debug = createDebug("bsl");

export enum BSLStatus {
	SUCCESS,
	TIMEOUT,
	DENIED,
	UNKNOWN,
	ABORTED
}

export type LoadBootCodeOptions = {
	autoIgnition?: boolean;
	autoIgnitionInvertPolarity?: boolean;
	signal?: AbortSignal | null;
};

type LoadBootCodeResultOk = {
	success: true;
};

type LoadBootCodeResultError = {
	success: false;
	error: string;
};

export type LoadBootCodeResult = (LoadBootCodeResultOk | LoadBootCodeResultError) & {
	status: BSLStatus;
	cpu: string;
	secureBoot: boolean;
};

export async function loadBootCode(port: AsyncSerialPort, code: Buffer, options: LoadBootCodeOptions = {}): Promise<LoadBootCodeResult> {
	options = {
		autoIgnition: true,
		autoIgnitionInvertPolarity: false,
		...options
	};

	await port.update({ baudRate: 115200 });
	await port.setSignals({ dtr: options.autoIgnitionInvertPolarity, rts: false });

	let cpuType = 0;
	let lastDtr = false;
	let pulses = 0;
	const started = Date.now();
	let nextIgnition = started;

	debug("Sending ping (AT)...");
	debug("Please, short press red button!");

	while (!options.signal?.aborted) {
		const now = Date.now();
		if (options.autoIgnition && now >= nextIgnition) {
			lastDtr = !lastDtr;
			await port.setSignals({ dtr: options.autoIgnitionInvertPolarity ? !lastDtr : lastDtr });
			if (lastDtr)
				pulses++;
			nextIgnition = now + (lastDtr ? IGNITION_ON_PERIOD : IGNITION_OFF_PERIOD);
		}

		await port.write("AT");

		const response = await port.readByte(5);
		if (response != -1 && CPU_TYPES[response & 0xF0]) {
			cpuType = response & 0xF0;
			debug(`Detected CPU: ${CPU_NAMES[cpuType]} (ignition pulses: ${pulses}, ${Date.now() - started} ms)`);
			break;
		}

		if (response != -1)
			debug(sprintf("Unexpected response: %02X", response));
	}

	if (options.autoIgnition)
		await port.setSignals({ dtr: options.autoIgnitionInvertPolarity });

	const cpu = CPU_TYPES[cpuType];
	let status: BSLStatus;
	let error: string | undefined;
	const secureBoot = !options.signal?.aborted && await port.readByte(5) == 0xC4;

	if (secureBoot)
		debug("Secure boot detected.");

	if (options.signal?.aborted) {
		error = "Aborted by user.";
		status = BSLStatus.ABORTED;
	} else if (secureBoot && await port.readByte(5) == -1) {
		error = "Timeout, secure boot chip ID not received.";
		status = BSLStatus.TIMEOUT;
	} else {
		await port.write(genPayload(code));

		debug(`Sending EBL code (${code.length} bytes)...`);
		const response = await port.readByte(2000);
		if (response == -1) {
			error = "Timeout, ACK not received.";
			status = BSLStatus.TIMEOUT;
		} else if (response == 0x01 || response == 0xC1 || response == 0xB1) {
			status = BSLStatus.SUCCESS;
		} else if (response == 0x1C || response == 0x1B) {
			error = "EBL code is denied by bootloader.";
			status = BSLStatus.DENIED;
		} else {
			error = `Unexpected response: ${response.toString(16)}`;
			status = BSLStatus.UNKNOWN;
		}
	}

	if (status == BSLStatus.SUCCESS) {
		debug("ACK received, EBL successfully loaded.");
		return { success: true, status, cpu, secureBoot };
	} else {
		debug(`ERROR: ${error}`);
		return { success: false, error: error!, status, cpu, secureBoot };
	}
}

function genPayload(code: Buffer): Buffer {
	let chk = 0;
	for (let i = 0; i < code.length; i++)
		chk ^= code[i];
	return Buffer.concat([
		Buffer.from([0x30, code.length & 0xFF, (code.length >> 8) & 0xFF]),
		code,
		Buffer.from([chk])
	]);
}
