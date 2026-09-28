import { EL71, emulatorTarget } from './emulator.js';
import { obexSuite } from './obexSuite.js';

obexSuite(emulatorTarget(EL71));
