import { autoDetect } from '@sie-js/node-serialport-bindings-cpp';
import type { BindingInterface } from '@serialport/bindings-interface';
import {
	AsyncSerialPort as BaseAsyncSerialPort,
	type AsyncSerialPortOptions as BaseAsyncSerialPortOptions,
} from './AsyncSerialPort.js';

export { SerialReadTimeoutError } from './AsyncSerialPort.js';

export type AsyncSerialPortOptions = Omit<BaseAsyncSerialPortOptions, 'binding'> & {
	binding?: BindingInterface;
};

export class AsyncSerialPort extends BaseAsyncSerialPort {
	constructor(options: AsyncSerialPortOptions) {
		const { binding = autoDetect(), ...openOptions } = options;
		super({ binding, ...openOptions });
	}
}
