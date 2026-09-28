// The OBEX client against every phone of the behavior database in tests/obex/phones/db,
// each played by the fake phone, without pinning the exact requests the client sends.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { OBEX, ObexDelays } from './OBEX.js';
import { clientPlatform, isUsable, loadDatabase, PhoneEntry } from '../../tests/obex/phones/entry.js';
import { openFakePhonePort } from '../../tests/obex/phones/fakePhone.js';
import { probePhone } from '../../tests/obex/phones/probe.js';

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../tests/obex/phones/db');
const database = loadDatabase(DB);
// An entry the probe could not finish, e.g. of a phone that answered no AT, or of
// a phone without FlexMem access, has no session for the fake phone to play
const entries = database.map(({ entry }) => entry).filter(isUsable);

// The S66 answered every AT command ~405 ms late on a host whose event loop noticed
// a readable USB serial port only at its next timer: the emulated EL71 with that
// timing, at every speed, the first answer echoed
function withLateAtAnswers(entry: PhoneEntry): PhoneEntry {
	return {
		...entry,
		id: `${entry.id}-late-at`,
		at: { ...entry.at, speeds: [115200, 57600, 19200, 230400, 9600, 38400], latencyMs: 405, echo: true },
	};
}
const el71 = entries.find((entry) => entry.id == 'emulated-EL71v41')!;

// Where disconnect() leaves the phone: in OBEX mode on a cable without the escape
const handedBackTo = (entry: PhoneEntry) => entry.raw?.escape == 'none' ? 'raw' : 'at';

// The fake phone answers at once
const DELAYS: Partial<ObexDelays> = { flush: 20, escape: 150 };

// Identifies the phone, round-trips a file and walks up a level, then hands the
// phone back to the next program
async function session(entry: PhoneEntry): Promise<void> {
	const { port, phone } = await openFakePhonePort(entry, { escapeGuardMs: 100 });
	try {
		const obex = new OBEX(port, DELAYS);
		await obex.connect(0);
		const { vendor, model, revision } = entry.identity;
		// AT+CGMR may answer a whole build string, e.g. the S66's 34,"OFFICIAL",...
		expect(obex.getDeviceName()).toBe(`${vendor} ${model} v${revision?.match(/^\s*(\d+)/)?.[1]}`);
		expect(obex.getPlatform()).toBe(clientPlatform(entry));

		const folders = (await obex.readDir('/')).filter((e) => e.isDir).map((e) => e.name);
		expect(folders).toEqual(expect.arrayContaining(entry.obex!.rootFolders));

		const dir = entry.obex!.writableDir;
		if (dir) {
			const file = `${dir}/phones-test.bin`;
			const data = Buffer.alloc(3000);
			for (let i = 0; i < data.length; i++)
				data[i] = (i * 7 + 1) & 0xFF;
			await obex.putFile(file, data);
			expect(await obex.getFile(file)).toEqual(data);
			await obex.deleteFile(file);

			// One level up from there
			const parent = dir.split('/').slice(0, -1).join('/') || '/';
			const listed = (await obex.readDir(parent)).map((e) => e.name.toLowerCase());
			expect(listed).toContain(dir.split('/').pop()!.toLowerCase());
		}

		await obex.disconnect();
		expect(phone.mode).toBe(handedBackTo(entry));

		const next = new OBEX(port, DELAYS);
		await next.connect(0);
		expect((await next.readDir('/')).length).toBeGreaterThan(0);
		await next.disconnect();
		expect(phone.mode).toBe(handedBackTo(entry));
	} finally {
		await port.close();
	}
}

// loadDatabase() above already threw with every problem of an invalid entry
test('OBEX: every entry of the database is named after its id', () => {
	expect(database.length).toBeGreaterThan(0);
	for (const { file, entry } of database)
		expect(path.basename(file, '.json')).toBe(entry.id);
});

describe.concurrent.each(entries)('OBEX: the $id phone ($source, $transport)', { timeout: 30000 }, (entry) => {
	test('a session lists the root, round-trips a file and hands the phone back to the next one', async () => {
		await session(entry);
	});
});

describe.concurrent('OBEX: a phone whose AT answers arrive ~400 ms late', { timeout: 60000 }, () => {
	// The client's AT handshake gives each try 150 ms, so the answers arrive late,
	// and each would be taken for the next command's without the drain after it
	test('the OBEX client identifies it and runs a session', async () => {
		await session(withLateAtAnswers(el71));
	});

	test('the probe records its AT timing and gets through the whole session', async () => {
		const expected = withLateAtAnswers(el71);
		const { port, phone } = await openFakePhonePort(expected);
		try {
			const entry = await probePhone(port, { dir: expected.obex!.writableDir!, id: expected.id, source: 'synthetic' });

			expect(entry.problems).toEqual([]);
			expect(entry.at.speeds).toEqual(expected.at.speeds);
			expect(entry.at.echo).toBe(true);
			expect(entry.at.latencyMs).toBeGreaterThanOrEqual(400);
			expect(entry.at.latencyMs).toBeLessThan(600);
			expect(entry.identity).toEqual(expected.identity);
			expect(entry.transport).toBe('raw');
			expect(entry.obex).toEqual(expected.obex);
			expect(entry.raw).toEqual(expected.raw);
			expect(phone.mode).toBe('at');
		} finally {
			await port.close();
		}
	});
});
