import { AsyncSerialPort } from '@sie-js/serial';
import { autoDetect } from 'serialport-rs';
import { SocketBinding } from 'serialport-bindings-socket';

export async function openPort(path: string, baudRate: number): Promise<AsyncSerialPort> {
	if (path.match(/^(tcp|unix)/)) {
		return new AsyncSerialPort({
			binding: SocketBinding,
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
