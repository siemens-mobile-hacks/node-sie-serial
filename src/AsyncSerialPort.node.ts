import { autoDetect } from 'serialport-rs';
import type { BindingInterface, BindingPortInterface, OpenOptions } from '@serialport/bindings-interface';
import {
	AsyncSerialPort as BaseAsyncSerialPort,
	type AsyncSerialPortOptions as BaseAsyncSerialPortOptions,
} from './AsyncSerialPort.js';

export { SerialReadTimeoutError } from './AsyncSerialPort.js';

export type AsyncSerialPortOptions<TOptions extends OpenOptions = OpenOptions> =
	Omit<BaseAsyncSerialPortOptions<TOptions>, 'binding'> & {
		binding?: BindingInterface<BindingPortInterface, TOptions>;
};

export class AsyncSerialPort<TOptions extends OpenOptions = OpenOptions> extends BaseAsyncSerialPort {
	constructor(options: AsyncSerialPortOptions<TOptions>) {
		const binding: BindingInterface = options.binding ?? autoDetect();
		super({ ...options, binding });
	}
}
