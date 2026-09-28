// One phone's recorded behavior: what probe.ts measures and fakePhone.ts plays.
// Codes, markers and frames are hex strings, like in the evidence.

import fs from 'node:fs';
import path from 'node:path';
import { detectPhonePlatform, PhonePlatform } from '../../../src/OBEX.js';

// Bumped whenever a field is added, removed or changes its meaning
export const SCHEMA_VERSION = 5;

export type PhoneEntry = {
	schema: number;
	id: string;
	source: 'hardware' | 'emulator' | 'synthetic';
	recorded: { date: string; tool: string; notes?: string };
	identity: { vendor: string | null; model: string | null; revision: string | null };
	at: {
		// the speeds the AT interpreter answered ATQ0 V1 E0 at
		speeds: number[];
		// the median time from sending a command to its final result line, null when
		// not measured. A cable or a phone can add several hundred ms.
		latencyMs: number | null;
		// whether the first command came back echoed, i.e. echo was on until E0: the
		// state the phone was found in, which the fake phone starts in
		echo: boolean | null;
		// the final result line of AT^SQWE=0, AT^SQWE=3 and AT^SBFB=1, or TIMEOUT; for
		// a phone reached through BFC, of the AT commands sent through its tunnel
		results: Record<string, string>;
	};
	// A phone on a service cable in BFC mode answers no AT: the speed BFC answered at,
	// where the identity was read and AT^SQWE=3 sent through BFC's AT tunnel
	bfc: { speed: number } | null;
	// "none" means the phone refused AT^SQWE=3, and AT^SBFB=1 too or does not get it
	// because it knows AT^SQWE, "unknown" that the probe could not tell (see problems)
	transport: 'raw' | 'bfb' | 'none' | 'unknown';
	bfb: BfbBehavior | null;
	raw: RawBehavior | null;
	obex: ObexBehavior | null;
	// What the probe could not tell, "<step>: <why>". A field it could not measure is
	// null, which is not the same as a phone without the behavior.
	problems: string[];
	// per probe step, "+<ms> TX|RX|-- <hex, text or note>" lines
	evidence: Record<string, string[]>;
};

export type BfbBehavior = {
	// the first speed the hello was answered at, and the answer
	helloSpeed: number | null;
	helloAnswer: string | null;
	// the frame that acknowledges our packets, and whether it comes before the answer
	ackFrame: string | null;
	ackBeforeResponse: boolean | null;
	// the marker of the phone's first packet of a session and of the later ones
	firstMarker: string | null;
	laterMarker: string | null;
	// how the phone numbers its packets: its own counter, our number, or always the same
	sequence: 'counter' | 'echo' | 'constant' | 'unknown';
	// the AT speeds answering after at^sbfb=0 in a BFB frame
	leaveSpeeds: number[];
};

export type RawBehavior = {
	// How the phone leaves raw OBEX mode. plus: DISCONNECT and the +++ escape. none:
	// the cable refuses to set DTR, like the DCA-540, a USB link to an x65 that takes
	// +++ for the start of an OBEX packet and answers nothing until a power cycle;
	// the phone stays in OBEX mode, and the next session goes on in it.
	escape: 'plus' | 'none';
	// the AT speeds answering after DISCONNECT and the +++ escape
	escapeSpeeds: number[];
};

export type ObexBehavior = {
	connect: { code: string; version: string; flags: string; maxPacket: number; connectionId: boolean };
	// the response code of a folder listing GET without and with the connection id,
	// null when the phone sent no connection id
	connectionId: { without: string | null; with: string | null };
	codes: {
		setpathMissing: string | null;
		getMissing: string | null;
		deleteMissing: string | null;
		deleteMissingInJava: string | null;
		abortIdle: string | null;
		disconnect: string | null;
	};
	rootFolders: string[];
	// the listing XML up to the first entry
	listingPrologue: string;
	// the folder the file checks ran in, null when there was none to write into
	writableDir: string | null;
	// body bytes per GET answer of a file that takes several packets
	getChunk: number | null;
	// what a PUT over an existing file does
	overwrite: 'append' | 'replace' | 'other' | null;
	caseInsensitive: boolean | null;
	info: { capacity: boolean; available: boolean };
};

// A tiny structural validator: every problem of an entry at once, with its path
type Check = (value: unknown, at: string, errors: string[]) => void;
const OPTIONAL = Symbol('optional');
type OptionalCheck = Check & { [OPTIONAL]?: true };

function typed(name: string, test: (value: unknown) => boolean): Check {
	return (value, at, errors) => {
		if (!test(value))
			errors.push(`${at}: ${value === undefined ? 'missing' : `${JSON.stringify(value)} is not ${name}`}`);
	};
}

const str = typed('a string', (v) => typeof v == 'string');
const num = typed('a number', (v) => typeof v == 'number' && Number.isFinite(v));
const bool = typed('true or false', (v) => typeof v == 'boolean');
const hexCode = typed('a hex code like "0xC4"', (v) => typeof v == 'string' && /^0x[0-9A-F]{2}$/.test(v));

function oneOf(...values: string[]): Check {
	return typed(`one of ${values.join(', ')}`, (v) => values.includes(v as string));
}

function nullable(check: Check): Check {
	return (value, at, errors) => {
		if (value !== null)
			check(value, at, errors);
	};
}

function optional(check: Check): OptionalCheck {
	const wrapped: OptionalCheck = (value, at, errors) => {
		if (value !== undefined)
			check(value, at, errors);
	};
	wrapped[OPTIONAL] = true;
	return wrapped;
}

function arrayOf(check: Check): Check {
	return (value, at, errors) => {
		if (!Array.isArray(value)) {
			errors.push(`${at}: ${value === undefined ? 'missing' : 'is not a list'}`);
			return;
		}
		value.forEach((item, i) => check(item, `${at}[${i}]`, errors));
	};
}

function recordOf(check: Check): Check {
	return (value, at, errors) => {
		if (typeof value != 'object' || value === null || Array.isArray(value)) {
			errors.push(`${at}: ${value === undefined ? 'missing' : 'is not an object'}`);
			return;
		}
		for (const [key, item] of Object.entries(value))
			check(item, `${at}.${key}`, errors);
	};
}

// Missing and unknown fields are both errors: a typo must not pass as "not measured"
function object(fields: Record<string, OptionalCheck>): Check {
	return (value, at, errors) => {
		if (typeof value != 'object' || value === null || Array.isArray(value)) {
			errors.push(`${at || 'entry'}: ${value === undefined ? 'missing' : 'is not an object'}`);
			return;
		}
		for (const [key, check] of Object.entries(fields)) {
			const field = at ? `${at}.${key}` : key;
			if (!(key in value) && !check[OPTIONAL])
				errors.push(`${field}: missing`);
			else
				check((value as Record<string, unknown>)[key], field, errors);
		}
		for (const key of Object.keys(value)) {
			if (!(key in fields))
				errors.push(`${at ? `${at}.${key}` : key}: unknown field`);
		}
	};
}

const speeds = arrayOf(num);
const code = nullable(hexCode);

// The id naming convention: <model>v<revision> the way the phone names them, e.g.
// S66v34, with a prefix or suffix for a second entry of the same phone
// (DCA540-S66v34), and emulated- or synthetic- in front of what no real phone
// recorded
export const ID_PATTERN = /^((emulated|synthetic)-)?[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/;

const ENTRY: Check = object({
	schema: num,
	id: typed('an id like S66v34', (v) => typeof v == 'string' && ID_PATTERN.test(v)),
	source: oneOf('hardware', 'emulator', 'synthetic'),
	recorded: object({ date: str, tool: str, notes: optional(str) }),
	identity: object({ vendor: nullable(str), model: nullable(str), revision: nullable(str) }),
	at: object({ speeds, latencyMs: nullable(num), echo: nullable(bool), results: recordOf(str) }),
	transport: oneOf('raw', 'bfb', 'none', 'unknown'),
	bfc: nullable(object({ speed: num })),
	bfb: nullable(object({
		helloSpeed: nullable(num),
		helloAnswer: nullable(str),
		ackFrame: nullable(str),
		ackBeforeResponse: nullable(bool),
		firstMarker: code,
		laterMarker: code,
		sequence: oneOf('counter', 'echo', 'constant', 'unknown'),
		leaveSpeeds: speeds,
	})),
	raw: nullable(object({ escape: oneOf('plus', 'none'), escapeSpeeds: speeds })),
	obex: nullable(object({
		connect: object({ code: hexCode, version: hexCode, flags: hexCode, maxPacket: num, connectionId: bool }),
		connectionId: object({ without: code, with: code }),
		codes: object({
			setpathMissing: code,
			getMissing: code,
			deleteMissing: code,
			deleteMissingInJava: code,
			abortIdle: code,
			disconnect: code,
		}),
		rootFolders: arrayOf(str),
		listingPrologue: str,
		writableDir: nullable(str),
		getChunk: nullable(num),
		overwrite: nullable(oneOf('append', 'replace', 'other')),
		caseInsensitive: nullable(bool),
		info: object({ capacity: bool, available: bool }),
	})),
	problems: arrayOf(str),
	evidence: recordOf(arrayOf(str)),
});

function validate(value: unknown): string[] {
	const errors: string[] = [];
	ENTRY(value, '', errors);
	return errors;
}

export function loadEntry(file: string): PhoneEntry {
	let entry: Record<string, unknown>;
	try {
		entry = JSON.parse(fs.readFileSync(file, 'utf8'));
	} catch (e) {
		throw new Error(`${file}: ${(e as Error).message}`);
	}
	if (entry.schema !== SCHEMA_VERSION)
		throw new Error(`${file}: schema ${entry.schema}, this checkout reads schema ${SCHEMA_VERSION} only. Record the phone again.`);
	const errors = validate(entry);
	if (errors.length)
		throw new Error(`${file} is not a valid phone entry:\n  ${errors.join('\n  ')}`);
	return entry as PhoneEntry;
}

// Every entry of the database, sorted by id
export function loadDatabase(dir: string): { file: string; entry: PhoneEntry }[] {
	return fs.readdirSync(dir)
		.filter((name) => name.endsWith('.json'))
		.sort()
		.map((name) => ({ file: path.join(dir, name), entry: loadEntry(path.join(dir, name)) }));
}

export function saveEntry(file: string, entry: PhoneEntry): void {
	const errors = validate(entry);
	if (errors.length)
		throw new Error(`Refusing to save an invalid entry to ${file}:\n  ${errors.join('\n  ')}`);
	fs.writeFileSync(file, JSON.stringify(entry, null, '\t') + '\n');
}

// Entries the OBEX client can run against: the probe got through a mode switch and
// the OBEX session
export function isUsable(entry: PhoneEntry): boolean {
	return (entry.transport == 'raw' || entry.transport == 'bfb') && entry.obex !== null && !refusesObex(entry);
}

// The phone switched to OBEX but refused the FlexMem CONNECT, like the S56: it
// has no OBEX file access
export function refusesObex(entry: PhoneEntry): boolean {
	return entry.obex !== null && (parseInt(entry.obex.connect.code, 16) & 0x7F) != 0x20;
}

export function suggestedId(identity: PhoneEntry['identity'], source: PhoneEntry['source']): string | undefined {
	if (!identity.model)
		return undefined;
	const model = identity.model.replace(/[^A-Za-z0-9]+/g, '');
	const revision = identity.revision?.match(/^\s*(\d+)/)?.[1];
	const base = revision ? `${model}v${revision}` : model;
	return source == 'hardware' ? base : `${source == 'emulator' ? 'emulated' : 'synthetic'}-${base}`;
}

export function hex(value: number): string {
	return `0x${value.toString(16).toUpperCase().padStart(2, '0')}`;
}

// The platform the OBEX client derives from AT+CGMM
export function clientPlatform(entry: PhoneEntry): PhonePlatform {
	return detectPhonePlatform(entry.identity.model ?? undefined);
}

// Whether the phone refuses requests without the connection id: "yes", "no", "not
// sent" when the CONNECT answer carried none, "?" when not measured
export function connectionIdNeeded(entry: PhoneEntry): 'yes' | 'no' | 'not sent' | '?' {
	const obex = entry.obex;
	if (!obex)
		return '?';
	if (!obex.connect.connectionId)
		return 'not sent';
	const ok = (value: string | null) => value !== null && (parseInt(value, 16) & 0x70) == 0x20;
	if (obex.connectionId.without === null)
		return '?';
	if (ok(obex.connectionId.without))
		return 'no';
	return ok(obex.connectionId.with) ? 'yes' : '?';
}

export type Mismatch = {
	field: string;
	expected: unknown;
	actual: unknown;
	// the evidence key of the probe step the field comes from
	step: string;
};

// The probe step each field comes from, for printing its evidence. A phone on a
// service cable answers its identity and mode switch through BFC.
const BFC_STEPS: [RegExp, string][] = [
	[/^bfc/, 'bfc'],
	[/^identity/, 'bfc.identity'],
	[/^at\.results|^transport/, 'bfc.mode'],
];
const FIELD_STEPS: [RegExp, string][] = [
	[/^identity/, 'at.identity'],
	[/^at\.(speeds|latencyMs|echo)/, 'at.speeds'],
	[/^at\.results|^transport/, 'at.mode'],
	[/^bfb\.hello/, 'bfb.hello'],
	[/^bfb\.(ackFrame|ackBeforeResponse|firstMarker)/, 'bfb.connect'],
	[/^bfb\.(laterMarker|sequence)/, 'bfb.sequence'],
	[/^bfb\.leaveSpeeds/, 'bfb.leave'],
	[/^raw\./, 'raw.escape'],
	[/^obex\.connect\./, 'obex.connect'],
	[/^obex\.connectionId/, 'obex.connectionId'],
	[/^obex\.(rootFolders|listingPrologue)/, 'obex.listing'],
	[/^obex\.codes\.deleteMissingInJava/, 'obex.java'],
	[/^obex\.codes/, 'obex.codes'],
	[/^obex\.(writableDir|getChunk|overwrite|caseInsensitive)/, 'obex.files'],
	[/^obex\.info/, 'obex.info'],
];

function stepOf(field: string, viaBfc: boolean): string {
	return [...viaBfc ? BFC_STEPS : [], ...FIELD_STEPS].find(([pattern]) => pattern.test(field))?.[1] ?? field;
}

// Timings on a real phone jitter, a latency not measured matches anything, and echo
// is the state the phone was found in (a session before may have turned it off);
// the rest has to be equal
function sameValue(field: string, expected: unknown, actual: unknown): boolean {
	if (field == 'at.echo' || (field == 'at.latencyMs' && expected === null))
		return true;
	if (field == 'at.latencyMs' && typeof expected == 'number' && typeof actual == 'number')
		return Math.abs(expected - actual) <= Math.max(150, expected * 0.4);
	return JSON.stringify(expected) == JSON.stringify(actual);
}

function walk(field: string, expected: unknown, actual: unknown, out: Mismatch[], viaBfc: boolean): void {
	const isObject = (v: unknown) => typeof v == 'object' && v !== null && !Array.isArray(v);
	if (isObject(expected) && isObject(actual)) {
		const keys = new Set([...Object.keys(expected as object), ...Object.keys(actual as object)]);
		for (const key of keys)
			walk(field ? `${field}.${key}` : key, (expected as any)[key], (actual as any)[key], out, viaBfc);
		return;
	}
	if (!sameValue(field, expected, actual))
		out.push({ field, expected, actual, step: stepOf(field, viaBfc) });
}

// Every behavior field that differs; the id, the recording metadata, the problems
// and the evidence don't count
export function compareEntries(expected: PhoneEntry, actual: PhoneEntry): Mismatch[] {
	const behavior = (entry: PhoneEntry) => ({
		identity: entry.identity,
		at: entry.at,
		transport: entry.transport,
		bfc: entry.bfc,
		bfb: entry.bfb,
		raw: entry.raw,
		obex: entry.obex,
	});
	const out: Mismatch[] = [];
	walk('', behavior(expected), behavior(actual), out, !!(expected.bfc || actual.bfc));
	return out;
}
