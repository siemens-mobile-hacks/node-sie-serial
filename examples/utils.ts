import { AsyncSerialPort } from "../src/index.js";
import { SerialPort } from "serialport";
import { SerialPortStream } from '@serialport/stream';
import { SocketBinding, SocketBindingInterface } from 'serialport-bindings-socket';

export async function openPort(path: string, baudRate: number): Promise<AsyncSerialPort> {
	if (path.match(/^(tcp|unix)/)) {
		return new AsyncSerialPort(new SerialPortStream<SocketBindingInterface>({
			binding: SocketBinding,
			path,
			baudRate,
			autoOpen: false
		}));
	} else {
		return new AsyncSerialPort(new SerialPort({
			path,
			baudRate,
			autoOpen: false
		}));
	}
}
