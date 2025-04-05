import createDebug from 'debug';
import { AsyncSerialPort } from './AsyncSerialPort.js';

const IGNITION_ON_PERIOD = 50;
const IGNITION_OFF_PERIOD = 150;

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
};

export async function loadBootCode(port: AsyncSerialPort, code: Buffer, options: LoadBootCodeOptions = {}): Promise<LoadBootCodeResult> {
	options = {
		autoIgnition: true,
		autoIgnitionInvertPolarity: false,
		...options
	};

	await port.update({ baudRate: 115200 });

	let cpuType = 0;
	let lastDtr = false;
	let lastIgnition = 0;

	debug("Sending ping (AT)...");
	debug("Please, short press red button!");

	while (!options.signal?.aborted) {
		if (options.autoIgnition) {
			const ignitionTimeout = lastDtr ? IGNITION_ON_PERIOD : IGNITION_OFF_PERIOD;
			if ((Date.now() - lastIgnition) >= ignitionTimeout) {
				lastDtr = !lastDtr;
				if (options.autoIgnitionInvertPolarity) {
					await port.setSignals({ dtr: !lastDtr });
				} else {
					await port.setSignals({ dtr: lastDtr });
				}
				lastIgnition = Date.now();
			}
		}

		await port.write("AT");

		const response = await port.readByte(5);
		if (response != -1 && (response == 0xB0 || response == 0xC0)) {
			cpuType = response;
			debug(`Detected CPU: ${CPU_NAMES[cpuType]}`);
			break;
		}
	}

	await port.setSignals({ dtr: options.autoIgnitionInvertPolarity });

	const cpu = CPU_TYPES[cpuType];
	let status: BSLStatus;
	let error: string | undefined;

	if (options.signal?.aborted) {
		error = "Aborted by user.";
		status = BSLStatus.ABORTED;
	} else {
		await port.write(genPayload(code));

		debug(`Sending EBL code (${code.length} bytes)...`);
		const response = await port.readByte(1000);
		if (response == -1) {
			error = "Timeout, ACK not received.";
			status = BSLStatus.TIMEOUT;
		} else if (response == 0xC1 || response == 0xB1) {
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
		return { success: true, status, cpu };
	} else {
		debug(`ERROR: ${error}`);
		return { success: false, error: error!, status, cpu };
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
