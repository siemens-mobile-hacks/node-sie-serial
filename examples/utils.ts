import { AsyncSerialPort, delay } from '@sie-js/serial';
import { autoDetect } from 'serialport-rs';
import { SocketBinding } from 'serialport-bindings-socket';
import { WebUSBBinding } from 'serialport-bindings-webusb';

const USB_WAIT_INTERVAL = 500;

export async function openPort(path: string, baudRate: number): Promise<AsyncSerialPort> {
	if (path.match(/^(tcp|unix)/)) {
		return new AsyncSerialPort({
			binding: SocketBinding,
			path,
			baudRate,
		});
	} else if (path.startsWith('webusb:')) {
		await waitForUSBDevice(path);
		return new AsyncSerialPort({
			binding: WebUSBBinding,
			path,
			baudRate,
		});
	} else {
		return new AsyncSerialPort({
			binding: autoDetect(),
			path,
			baudRate,
		});
	}
}

async function waitForUSBDevice(selector: string): Promise<void> {
	let waiting = false;
	while (!(await WebUSBBinding.list()).some((port) => matchesUSBPath(port.path, selector))) {
		if (!waiting) {
			console.log(`Waiting for USB device ${selector}...`);
			waiting = true;
		}
		await delay(USB_WAIT_INTERVAL);
	}
}

function matchesUSBPath(path: string, selector: string): boolean {
	const params = new URL(path).searchParams;
	for (const [name, value] of new URL(selector).searchParams) {
		const portValue = params.get(name);
		const matches = name == 'vid' || name == 'pid' ?
			portValue?.toLowerCase() == value.toLowerCase() :
			portValue == value;
		if (!matches)
			return false;
	}
	return true;
}
