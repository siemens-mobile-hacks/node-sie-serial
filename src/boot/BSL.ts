import createDebug from 'debug';
import { AsyncSerialPort } from '#src/AsyncSerialPort.js';
import { sprintf } from "sprintf-js";

const IGNITION_ON_PERIOD = 500;
const IGNITION_OFF_PERIOD = 250;

const CPU_NAMES: Record<number, string> = {
	0xB0:	'PMB8875 (SGold)',
	0xC0:	'PMB8876 (SGold2)',
	0xD0:	'PMB8877 (SGold3)',
};

export type BSLCpu = 'pmb8875' | 'pmb8876' | 'pmb8877' | 'pmb887x';

const CPU_TYPES: Record<number, BSLCpu> = {
	0xB0:	'pmb8875',
	0xC0:	'pmb8876',
	0xD0:	'pmb8877',
};

const debug = createDebug("bsl");

export enum BSLStatus {
	SUCCESS,
	TIMEOUT,
	DENIED,
	UNKNOWN,
	ABORTED,
	DWD_BOOTLOADER
}

export enum BSLStage {
	CONNECT,
	UPLOAD,
	WAIT_ACK,
	ABORTED,
	DONE
}

export type BSLBootInfo = {
	cpu: BSLCpu;
	secureBoot: boolean;
};

export type BSLBootCodeProvider = (info: BSLBootInfo) => Buffer | Promise<Buffer>;

export type BSLOptions = {
	autoIgnition?: boolean;
	autoIgnitionInvertPolarity?: boolean;
	onProgress?: (stage: BSLStage) => void;
	signal?: AbortSignal;
};

type BSLResultOk = BSLBootInfo & {
	success: true;
};

type BSLResultError = {
	success: false;
	error: string;
	cpu?: BSLCpu;
	secureBoot: boolean;
};

export type BSLResult = (BSLResultOk | BSLResultError) & {
	status: BSLStatus;
};

export async function loadBootCode(port: AsyncSerialPort, code?: BSLBootCodeProvider, options: BSLOptions = {}): Promise<BSLResult> {
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

	options.onProgress?.(BSLStage.CONNECT);
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

		const response = await port.readByte(5, options.signal);
		if (response != -1 && CPU_TYPES[response & 0xF0]) {
			cpuType = response & 0xF0;
			debug(`Detected CPU: ${CPU_NAMES[cpuType]} (ignition pulses: ${pulses}, ${Date.now() - started} ms)`);
			break;
		}

		if (response == 0x0B) {
			debug(`Detected DWD bootloader (ignition pulses: ${pulses}, ${Date.now() - started} ms)`);
			options.onProgress?.(BSLStage.DONE);
			return {
				success: true,
				status: BSLStatus.DWD_BOOTLOADER,
				secureBoot: true,
				cpu: "pmb887x", // unknown at this moment
			};
		}

		if (response != -1)
			debug(sprintf("Unexpected response: %02X", response));
	}

	if (options.autoIgnition)
		await port.setSignals({ dtr: options.autoIgnitionInvertPolarity });

	let status: BSLStatus;
	let error: string | undefined;
	const cpu = CPU_TYPES[cpuType];

	// Check for secure BSL
	const secureBootHello = await port.read(2, 5, options.signal);
	const secureBoot = secureBootHello?.length == 2 && secureBootHello.readUint8(0) == (cpuType | 0x04);

	if (secureBoot) {
		debug(`Secure boot detected (${secureBootHello.toString('hex').toUpperCase()}).`);
	}

	if (options.signal?.aborted) {
		error = "Aborted by user.";
		status = BSLStatus.ABORTED;
	} else if (!code) {
		status = BSLStatus.SUCCESS;
	} else {
		const bootCode = await code({ cpu, secureBoot });
		const payload = genPayload(bootCode);

		if (!options.signal?.aborted) {
			debug(`Sending EBL code (${bootCode.length} bytes)...`);
			options.onProgress?.(BSLStage.UPLOAD);
			await port.write(payload);
			options.onProgress?.(BSLStage.WAIT_ACK);
		}

		const response = await port.readByte(2000, options.signal ?? undefined);
		if (options.signal?.aborted) {
			error = "Aborted by user.";
			status = BSLStatus.ABORTED;
		} else if (response == -1) {
			error = "Timeout, ACK not received.";
			status = BSLStatus.TIMEOUT;
		} else if (response == 0x01 || response == 0xC1 || response == 0xB1) {
			debug("ACK received, EBL successfully loaded.");
			status = BSLStatus.SUCCESS;
		} else if (response == 0x1C || response == 0x1B) {
			error = "EBL code is denied by bootloader.";
			status = BSLStatus.DENIED;
		} else {
			error = `Unexpected response: ${response.toString(16)}`;
			status = BSLStatus.UNKNOWN;
		}
	}

	options.onProgress?.(status == BSLStatus.ABORTED ? BSLStage.ABORTED : BSLStage.DONE);

	if (status == BSLStatus.SUCCESS) {
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
