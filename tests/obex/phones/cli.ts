// The phone behavior database (tests/obex/phones/db): record a phone into it, list what
// it holds, check the fake phone or a phone against an entry, compare two entries.
//
//   pnpm exec tsx tests/obex/phones/cli.ts record --port /dev/ttyUSB0
//   pnpm exec tsx tests/obex/phones/cli.ts list
//   pnpm exec tsx tests/obex/phones/cli.ts check --entry tests/obex/phones/db/S66v34.json
//   pnpm exec tsx tests/obex/phones/cli.ts check --entry tests/obex/phones/db/S66v34.json --port /dev/ttyUSB0
//   pnpm exec tsx tests/obex/phones/cli.ts diff tests/obex/phones/db/a.json tests/obex/phones/db/b.json

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { openPort } from '../../../examples/utils.js';
import {
	clientPlatform,
	compareEntries,
	connectionIdNeeded,
	ID_PATTERN,
	isUsable,
	loadDatabase,
	loadEntry,
	Mismatch,
	PhoneEntry,
	refusesObex,
	saveEntry,
	suggestedId,
} from './entry.js';
import { openFakePhonePort } from './fakePhone.js';
import { probePhone, ProbeOptions } from './probe.js';

const DB = path.join(path.dirname(fileURLToPath(import.meta.url)), 'db');

const { values: argv, positionals } = parseArgs({
	allowPositionals: true,
	options: {
		port: { type: 'string' },
		dir: { type: 'string' },
		id: { type: 'string' },
		entry: { type: 'string' },
		out: { type: 'string' },
		notes: { type: 'string' },
		source: { type: 'string', default: 'hardware' },
		force: { type: 'boolean', default: false },
	},
});

function fail(message: string): never {
	console.error(message);
	process.exit(2);
}

async function probeDevice(portPath: string, options: ProbeOptions): Promise<PhoneEntry> {
	const port = await openPort(portPath, 115200);
	await port.open();
	try {
		return await probePhone(port, options);
	} finally {
		await port.close();
	}
}

async function probeFake(entry: PhoneEntry): Promise<PhoneEntry> {
	const { port } = await openFakePhonePort(entry);
	try {
		return await probePhone(port, { dir: entry.obex?.writableDir ?? undefined, id: entry.id, source: 'synthetic' });
	} finally {
		await port.close();
	}
}

const list = (values: unknown[]) => values.length ? values.join(', ') : 'none';

function summary(entry: PhoneEntry): void {
	const { identity, at, bfb, obex } = entry;
	console.log(`${identity.vendor ?? '?'} ${identity.model ?? '?'} v${identity.revision ?? '?'}, transport ${entry.transport}, ` +
		`the OBEX client detects ${clientPlatform(entry)}`);
	const results = Object.entries(at.results).map(([cmd, result]) => `${cmd} ${result}`).join(', ');
	if (entry.bfc)
		console.log(`  BFC at ${entry.bfc.speed} baud, no AT: on a service cable; through BFC's AT tunnel ${results}`);
	else
		console.log(`  AT at ${list(at.speeds)}, answers after ${at.latencyMs ?? '?'} ms, echo ${at.echo ?? '?'}; ${results}`);
	if (bfb) {
		console.log(`  BFB: hello at ${bfb.helloSpeed}, ack ${bfb.ackFrame} ${bfb.ackBeforeResponse ? 'before' : 'after'} the answer, ` +
			`markers ${bfb.firstMarker}/${bfb.laterMarker}, sequence ${bfb.sequence}, AT after leaving at ${list(bfb.leaveSpeeds)}`);
		if (!bfb.leaveSpeeds.length && bfb.helloSpeed)
			console.log('  WARNING: no AT answer after leaving BFB, the phone may need a power cycle.');
	}
	if (entry.raw) {
		if (entry.raw.escape == 'none') {
			console.log('  raw OBEX: no +++ escape, the cable refuses to set DTR: the phone stays in OBEX mode between sessions');
		} else {
			console.log(`  raw OBEX: AT after the escape at ${list(entry.raw.escapeSpeeds)}`);
			if (!entry.raw.escapeSpeeds.length)
				console.log('  WARNING: no AT answer after the +++ escape, the phone may need a power cycle.');
		}
	}
	if (obex) {
		console.log(`  OBEX: max packet ${obex.connect.maxPacket}, connection id ${obex.connect.connectionId ? `sent, without it ${obex.connectionId.without}, with it ${obex.connectionId.with}` : 'not sent'} ` +
			`(needed: ${connectionIdNeeded(entry)}); missing: setpath ${obex.codes.setpathMissing}, get ${obex.codes.getMissing}, ` +
			`delete ${obex.codes.deleteMissing}, delete in Java ${obex.codes.deleteMissingInJava}; ` +
			`overwrite ${obex.overwrite}, case-insensitive ${obex.caseInsensitive}, GET chunks ${obex.getChunk}`);
	}
	if (entry.problems.length) {
		console.log(`  The probe could not tell everything:`);
		for (const problem of entry.problems)
			console.log(`    - ${problem}`);
	}
}

// Prints what differs, with the evidence of both sides once per probe step
function report(expected: PhoneEntry, actual: PhoneEntry, names: [string, string], { failOnMismatch = true } = {}): boolean {
	const mismatches = compareEntries(expected, actual);
	if (!mismatches.length) {
		console.log(`MATCH: the ${names[1]} behaves like the ${names[0]}.`);
		return true;
	}
	const steps = new Map<string, Mismatch[]>();
	for (const mismatch of mismatches)
		steps.set(mismatch.step, [...steps.get(mismatch.step) ?? [], mismatch]);
	for (const [step, list] of steps) {
		console.log(`\n=== step ${step}`);
		for (const m of list)
			console.log(`MISMATCH ${m.field}: ${names[0]} ${JSON.stringify(m.expected)}, ${names[1]} ${JSON.stringify(m.actual)}`);
		for (const [name, entry] of [[names[0], expected], [names[1], actual]] as const) {
			const lines = entry.evidence[step] ?? [];
			console.log(`  --- ${name}${lines.length ? '' : ': no evidence recorded'}`);
			for (const line of lines)
				console.log(`  ${line}`);
		}
	}
	console.log(`\n${mismatches.length} behaviors differ.`);
	if (failOnMismatch)
		process.exitCode = 1;
	return false;
}

// One row per phone, the behaviors the OBEX client depends on
function table(rows: { file: string; entry: PhoneEntry }[]): void {
	const header = ['id', 'source', 'model', 'platform', 'transport', 'AT speeds', 'latency', 'echo', 'conn id needed', 'overwrite', 'case-insens.', 'delete in Java', 'problems'];
	const cells = rows.map(({ entry }) => {
		const { at, obex } = entry;
		const speeds = at.speeds.length == 6 ? 'all 6' : at.speeds.map((speed) => `${speed / 1000}k`).join(' ');
		return [
			entry.id,
			entry.source,
			entry.identity.model ?? '?',
			clientPlatform(entry),
			entry.transport,
			speeds || 'none',
			at.latencyMs === null ? '?' : `${at.latencyMs} ms`,
			at.echo === null ? '?' : at.echo ? 'on' : 'off',
			connectionIdNeeded(entry),
			obex?.overwrite ?? '?',
			obex?.caseInsensitive === null || !obex ? '?' : obex.caseInsensitive ? 'yes' : 'no',
			obex?.codes.deleteMissingInJava ?? '?',
			String(entry.problems.length),
		];
	});
	const widths = header.map((title, i) => Math.max(title.length, ...cells.map((row) => row[i].length)));
	const line = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd();
	console.log(line(header));
	console.log(line(widths.map((width) => '-'.repeat(width))));
	for (const row of cells)
		console.log(line(row));
}

switch (positionals[0]) {
	case 'record': {
		if (!argv.port)
			fail('record needs --port');
		if (!['hardware', 'emulator', 'synthetic'].includes(argv.source!))
			fail(`--source is hardware, emulator or synthetic, not ${argv.source}`);
		if (argv.id && !ID_PATTERN.test(argv.id))
			fail(`"${argv.id}" does not follow the naming convention, <model>v<revision>, e.g. S66v34. See tests/obex/phones/README.md.`);
		console.log(`Probing ${argv.port}, this takes a minute or two...`);
		const entry = await probeDevice(argv.port!, { dir: argv.dir, id: argv.id, source: argv.source as PhoneEntry['source'], notes: argv.notes });
		const suggested = suggestedId(entry.identity, entry.source);
		if (!argv.id)
			entry.id = suggested ?? 'unidentified';
		else if (suggested && argv.id != suggested && !argv.id.startsWith(`${suggested}-`) && !argv.id.endsWith(`-${suggested}`))
			console.warn(`WARNING: by the naming convention this phone's id is ${suggested}, not ${argv.id}.`);
		summary(entry);

		const out = argv.out ?? path.join(DB, `${entry.id}.json`);
		let old: PhoneEntry | undefined;
		if (fs.existsSync(out)) {
			try {
				// Even from an entry of another schema: a new one is recorded after each bump
				entry.recorded.notes ??= JSON.parse(fs.readFileSync(out, 'utf8')).recorded?.notes;
				old = loadEntry(out);
			} catch (e) {
				console.warn(`WARNING: ${(e as Error).message}`);
			}
		}
		// A probe that reached neither AT nor BFC learned nothing about the phone, and one
		// that failed must not replace an entry that works, or one that can't be read: both
		// go to a file of their own instead of into the database
		const unreachable = !entry.at.speeds.length && !entry.bfc;
		const keepOld = fs.existsSync(out) && (!old || isUsable(old)) && !isUsable(entry) && !argv.force;
		if (unreachable || keepOld || (!argv.id && !suggested && !argv.out)) {
			const failed = path.join(os.tmpdir(), `phone-probe-${entry.id}-${Date.now()}.json`);
			saveEntry(failed, entry);
			console.log(`\nThe probe did not get far enough to make a database entry${fs.existsSync(out) ? `, so ${out} is kept` : ''}.`);
			console.log(`What it recorded is in ${failed}; send that file with this output if the problems above don't explain it.`);
			process.exitCode = 1;
			break;
		}
		if (old) {
			console.log(`\n${out} existed, what changed:`);
			report(old, entry, ['old entry', 'new recording'], { failOnMismatch: false });
		}
		saveEntry(out, entry);
		console.log(`\nSaved ${out}`);
		if (!isUsable(entry)) {
			if (entry.transport == 'none') {
				console.log('The phone has neither raw OBEX nor BFB, there is nothing for the fake phone to reproduce.');
			} else if (refusesObex(entry)) {
				console.log(`The phone refused the OBEX CONNECT with ${entry.obex!.connect.code}: it has no FlexMem access, the fake phone and the OBEX client tests skip this entry.`);
			} else {
				console.log('The probe could not tell everything (see above), so the fake phone and the OBEX client tests skip this entry.');
				process.exitCode = 1;
			}
			break;
		}
		console.log('\nChecking the fake phone against the new entry...');
		if (!report(entry, await probeFake(entry), ['phone', 'fake phone']))
			console.log(`The fake phone does not reproduce this phone yet. Send ${out} and this output to update tests/obex/phones/fakePhone.ts.`);
		break;
	}
	case 'list':
		table(loadDatabase(DB));
		break;
	case 'check': {
		if (!argv.entry)
			fail('check needs --entry, and --port to check a phone instead of the fake phone');
		const entry = loadEntry(argv.entry!);
		if (argv.port) {
			const phone = await probeDevice(argv.port, { dir: argv.dir ?? entry.obex?.writableDir ?? undefined, id: entry.id });
			if (!report(entry, phone, ['entry', 'phone']))
				console.log('The phone does not behave like its entry: another firmware, a cable, or a setting that changed?');
		} else if (!isUsable(entry)) {
			fail(`${argv.entry} is not a usable entry (transport ${entry.transport}), there is nothing for the fake phone to play.`);
		} else if (!report(entry, await probeFake(entry), ['entry', 'fake phone'])) {
			console.log('The fake phone does not reproduce the entry: tests/obex/phones/fakePhone.ts needs to learn the behaviors above.');
		}
		break;
	}
	case 'diff': {
		const [a, b] = positionals.slice(1);
		if (!a || !b)
			fail('diff needs two entries');
		report(loadEntry(a), loadEntry(b), [path.basename(a), path.basename(b)]);
		break;
	}
	default:
		fail('usage: cli.ts record|list|check|diff, see the top of tests/obex/phones/cli.ts');
}
