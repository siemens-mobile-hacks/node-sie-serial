import { configDefaults, defineConfig } from 'vitest/config';

const DEVICE_SUITE = 'tests/obex/OBEX.device.test.ts';

// What a real serial session with a phone needs, emulated or on a cable
const phoneSession = {
	// A phone boot plus a real serial session is nothing like a unit test
	testTimeout: 180000,
	hookTimeout: 300000,
};

// The unit tests next to the sources run everywhere. The OBEX suites in tests/obex
// run a real session on demand: against an emulated phone, or a phone on a cable.
// Only the emulators need the X server of the global setup.
export default defineConfig({
	ssr: {
		resolve: {
			conditions: ['source'],
		},
	},
	test: {
		projects: [
			{
				test: {
					name: 'unit',
					include: ['src/**/*.test.ts'],
					// The OBEX session tests each wait on a simulated phone in real time
					maxConcurrency: 20,
				},
			},
			{
				test: {
					name: 'obex-emulator',
					include: ['tests/obex/**/*.test.ts'],
					exclude: [...configDefaults.exclude, DEVICE_SUITE],
					globalSetup: ['tests/obex/globalSetup.ts'],
					...phoneSession,
				},
			},
			{
				test: {
					name: 'obex-hardware',
					include: [DEVICE_SUITE],
					...phoneSession,
				},
			},
		],
	},
});
