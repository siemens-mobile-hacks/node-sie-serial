import createDebug from 'debug';
import { AsyncSerialPort } from './AsyncSerialPort.js';

const IGNITION_ON_PERIOD = 50;
const IGNITION_OFF_PERIOD = 150;

const CPU_NAMES = {
	0xB0:	'PMB8875 (SGold)',
	0xC0:	'PMB8876 (SGold)',
};

const CPU_TYPES = {
	0xB0:	'sgold',
	0xC0:	'sgold2',
};

const debug = createDebug("bsl");

export const BSL_ERRORS = {
	SUCCESS:	0,
	TIMEOUT:	1,
	DENIED:		2,
	UNKNOWN:	3,
	ABORTED:	4,
};

export async function loadBootCode(port, code, options = {}) {
	if (!(port instanceof AsyncSerialPort))
		throw new Error(`Port is not AsyncSerialPort!`);

	options = {
		autoIgnition: true,
		autoIgnitionInvertPolarity: false,
		signal: null,
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
			let ignitionTimeout = lastDtr ? IGNITION_ON_PERIOD : IGNITION_OFF_PERIOD;
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

		let response = await port.readByte(5);
		if (response != -1 && (response == 0xB0 || response == 0xC0)) {
			cpuType = response;
			debug(`Detected CPU: ${CPU_NAMES[cpuType]}`);
			break;
		}
	}

	await port.setSignals({ dtr: options.autoIgnitionInvertPolarity });

	let result = {
		cpu: CPU_TYPES[cpuType],
		status: BSL_ERRORS.SUCCESS,
		error: null
	};

	if (options.signal?.aborted) {
		result.error = "Aborted by user.";
		result.status = BSL_ERRORS.ABORTED;
	} else {
		await port.write(genPayload(code));

		debug(`Sending EBL code (${code.length} bytes)...`);
		let response = await port.readByte(1000);
		if (response == -1) {
			result.error = "Timeout, ACK not received.";
			result.status = BSL_ERRORS.TIMEOUT;
		} else if (response == 0xC1 || response == 0xB1) {
			result.status = BSL_ERRORS.SUCCESS;
		} else if (response == 0x1C || response == 0x1B) {
			result.error = "EBL code is denied by bootloader.";
			result.status = BSL_ERRORS.DENIED;
		} else {
			result.error = `Unexpected response: ${response.toString(16)}`;
			result.status = BSL_ERRORS.UNKNOWN;
		}
	}

	if (result.status == BSL_ERRORS.SUCCESS) {
		debug("ACK received, EBL successfully loaded.");
	} else {
		debug(`ERROR: ${result.error}`);
	}

	return result;
}

function genPayload(code) {
	let chk = 0;
	for (let i = 0; i < code.length; i++)
		chk ^= code[i];
	return Buffer.concat([
		Buffer.from([0x30, code.length & 0xFF, (code.length >> 8) & 0xFF]),
		code,
		Buffer.from([chk])
	]);
}
