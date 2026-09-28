import { describe, expect, test } from 'vitest';
import {
	detectPhonePlatform,
	forgetsFolderAfterPut,
	isObexResponseCode,
	obexResponseName,
	ObexHeaderId,
	ObexOpcode,
	ObexPacketWriter,
	OBEX_TARGET_FLEXMEM,
	OBEX_VERSION_1_0,
	parseFolderListing,
	parseObexHeaders,
} from './OBEX.js';

// A real C60 root listing captured over a DCA-510 cable: the phone marks its own
// system folders write-only instead of setting a hidden attribute.
const FOLDER_LISTING_C60 =
	'<?xml version="1.0"?>\r\n' +
	'<!DOCTYPE folder-listing SYSTEM "obex-folder-listing.dtd">\r\n' +
	'<folder-listing version="1.0">\r\n' +
	'    <folder name="PersistentData" modified="20040101T000200" user-perm="WD" group-perm="W" />\r\n' +
	'    <folder name="Data inbox" modified="20040101T000202" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="Internet" modified="20040101T043326" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="Cache" modified="20040101T043326" user-perm="WD" group-perm="R" />\r\n' +
	'    <folder name="Java" modified="20040101T043426" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="Sounds" modified="20040101T043444" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="tmp" modified="20250330T013600" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="Animations" modified="20250330T013606" user-perm="RWD" group-perm="R" />\r\n' +
	'    <folder name="Pictures" modified="20250330T013608" user-perm="RWD" group-perm="R" />\r\n' +
	'</folder-listing>';

describe('OBEX: ObexPacketWriter', () => {
	test('CONNECT packet matches the SiMoCo layout', () => {
		const packet = new ObexPacketWriter(ObexOpcode.CONNECT);
		packet.appendByte(OBEX_VERSION_1_0);
		packet.appendByte(0x00);
		packet.appendUint16(0x4006);
		packet.appendHeader(ObexHeaderId.TARGET, OBEX_TARGET_FLEXMEM);

		expect(packet.toBuffer()).toEqual(Buffer.concat([
			Buffer.from([ObexOpcode.CONNECT, 0x00, 0x1A, OBEX_VERSION_1_0, 0x00, 0x40, 0x06]),
			Buffer.from([ObexHeaderId.TARGET, 0x00, 0x13]),
			OBEX_TARGET_FLEXMEM,
		]));
	});

	test('SETPATH root/up/down packets match the siefs layout', () => {
		const root = new ObexPacketWriter(ObexOpcode.SETPATH);
		root.appendByte(0x02);
		root.appendByte(0x00);
		root.appendHeader(ObexHeaderId.NAME, Buffer.alloc(0));
		expect(root.toBuffer()).toEqual(Buffer.from([0x85, 0x00, 0x08, 0x02, 0x00, 0x01, 0x00, 0x03]));

		const up = new ObexPacketWriter(ObexOpcode.SETPATH);
		up.appendByte(0x03);
		up.appendByte(0x00);
		expect(up.toBuffer()).toEqual(Buffer.from([0x85, 0x00, 0x05, 0x03, 0x00]));

		const down = new ObexPacketWriter(ObexOpcode.SETPATH);
		down.appendByte(0x02);
		down.appendByte(0x00);
		down.appendUnicodeStringHeader(ObexHeaderId.NAME, 'Misc');
		expect(down.toBuffer()).toEqual(Buffer.from([
			0x85, 0x00, 0x12, 0x02, 0x00,
			0x01, 0x00, 0x0D,
			0x00, 0x4D, 0x00, 0x69, 0x00, 0x73, 0x00, 0x63, 0x00, 0x00,
		]));
	});

	test('TYPE header is a null terminated ASCII string', () => {
		const packet = new ObexPacketWriter(ObexOpcode.GET_FINAL);
		packet.appendStringHeader(ObexHeaderId.TYPE, 'x-obex/folder-listing');
		expect(packet.toBuffer()).toEqual(Buffer.concat([
			Buffer.from([0x83, 0x00, 0x1C, ObexHeaderId.TYPE, 0x00, 0x19]),
			Buffer.from('x-obex/folder-listing\0', 'latin1'),
		]));
	});

	test('CONNECTION_ID header is a 4 byte value without a length field', () => {
		const packet = new ObexPacketWriter(ObexOpcode.DISCONNECT);
		packet.appendUint32Header(ObexHeaderId.CONNECTION_ID, 0x12345678);
		expect(packet.toBuffer()).toEqual(Buffer.from([0x81, 0x00, 0x08, 0xCB, 0x12, 0x34, 0x56, 0x78]));
	});
});

describe('OBEX: parseObexHeaders', () => {
	test('parses all four header classes of a real GET response', () => {
		const body = Buffer.from('hello', 'latin1');
		const packet = Buffer.concat([
			Buffer.from([0x90, 0x00, 0x00]),
			Buffer.from([ObexHeaderId.LENGTH, 0x00, 0x00, 0x10, 0x00]),      // 0xC0 class
			Buffer.from([ObexHeaderId.BODY, 0x00, body.length + 3]), body,   // 0x40 class
			Buffer.from([ObexHeaderId.NAME, 0x00, 0x05, 0x00, 0x41]),        // 0x00 class
			Buffer.from([0x94, 0x07]),                                       // 0x80 class, 1 byte value
		]);
		packet.writeUInt16BE(packet.length, 1);

		const headers = parseObexHeaders(packet);
		expect(headers.get(ObexHeaderId.LENGTH)!.readUInt32BE(0)).toBe(0x1000);
		expect(headers.get(ObexHeaderId.BODY)).toEqual(body);
		expect(headers.get(ObexHeaderId.NAME)).toEqual(Buffer.from([0x00, 0x41]));
		expect(headers.get(0x94 as ObexHeaderId)).toEqual(Buffer.from([0x07]));
	});

	test('stops at a header that runs past the packet length instead of reading out of bounds', () => {
		const packet = Buffer.from([
			0xA0, 0x00, 0x0B,
			ObexHeaderId.BODY, 0x00, 0x06, 0x01, 0x02, 0x03,
			ObexHeaderId.NAME, 0x00, 0xFF, // claims 255 bytes, only 2 are left
		]);
		const headers = parseObexHeaders(packet);
		expect(headers.get(ObexHeaderId.BODY)).toEqual(Buffer.from([0x01, 0x02, 0x03]));
		expect(headers.has(ObexHeaderId.NAME)).toBe(false);
	});

	test('a packet without headers yields nothing', () => {
		expect(parseObexHeaders(Buffer.from([0xA0, 0x00, 0x03])).size).toBe(0);
	});

	// The CONNECT response of the C60 capture: version, flags and the max packet
	// size come before the headers, here the Connection-ID and WHO
	test('reads the headers of a CONNECT response from offset 7', () => {
		const packet = Buffer.from('a0001f100001dacb000001004a00136b01cb31410611d49a770050da3f471f', 'hex');
		const headers = parseObexHeaders(packet, 7);
		expect(headers.get(ObexHeaderId.CONNECTION_ID)).toEqual(Buffer.from([0x00, 0x00, 0x01, 0x00]));
		expect(headers.get(ObexHeaderId.WHO)).toEqual(OBEX_TARGET_FLEXMEM);
	});

	test('stops at the end of a buffer shorter than its length field', () => {
		// the BODY header fits the length field, not the buffer
		const packet = Buffer.from([0xA0, 0x00, 0x20, ObexHeaderId.BODY, 0x00, 0x10, 0x01, 0x02]);
		expect(parseObexHeaders(packet).size).toBe(0);
	});
});

describe('OBEX: parseFolderListing', () => {
	test('hides the system folders a C60 reports as write-only', () => {
		const byName = Object.fromEntries(parseFolderListing(FOLDER_LISTING_C60).map((e) => [e.name, e]));

		expect(byName['PersistentData'].hidden).toBe(true);
		expect(byName['Cache'].hidden).toBe(true);
		for (const name of ['Data inbox', 'Internet', 'Java', 'Sounds', 'tmp', 'Animations', 'Pictures'])
			expect(byName[name].hidden, name).toBe(false);

		// the raw permissions stay available for the UI
		expect(byName['PersistentData'].readable).toBe(false);
		expect(byName['PersistentData'].writable).toBe(true);
		expect(byName['Sounds'].readable).toBe(true);

		expect(byName['Data inbox'].isDir).toBe(true);
		expect(byName['Data inbox'].mtime).toEqual(new Date(2004, 0, 1, 0, 2, 2));
	});

	test('hides the telecom tree and entries with a hidden attribute', () => {
		const entries = parseFolderListing(
			'<?xml version="1.0"?><folder-listing>' +
			'<folder name="telecom" user-perm="RWD"/>' +
			'<file name="secret.png" size="1" hidden="true"/>' +
			'<file name="normal.png" size="1" hidden="false"/>' +
			'</folder-listing>');
		const byName = Object.fromEntries(entries.map((e) => [e.name, e]));

		expect(byName['telecom'].hidden).toBe(true);
		expect(byName['secret.png'].hidden).toBe(true);
		expect(byName['normal.png'].hidden).toBe(false);
	});

	test('decodes XML entities in names and reads file sizes', () => {
		const entries = parseFolderListing(
			'<folder-listing>' +
			'<file name="a &amp; b &lt;1&gt;.txt" size="12345" user-perm="R"/>' +
			'<file name="&quot;quoted&quot;.txt" size="0"/>' +
			'</folder-listing>');

		expect(entries[0].name).toBe('a & b <1>.txt');
		expect(entries[0].size).toBe(12345);
		expect(entries[0].writable).toBe(false);
		expect(entries[1].name).toBe('"quoted".txt');
	});

	test('entries without a name and a malformed modified attribute are tolerated', () => {
		const entries = parseFolderListing(
			'<folder-listing>' +
			'<file size="1"/>' +
			'<file name="ok.txt" size="1" modified="not-a-date"/>' +
			'</folder-listing>');

		expect(entries.length).toBe(1);
		expect(entries[0].name).toBe('ok.txt');
		expect(entries[0].mtime).toBeUndefined();
	});

	test('a listing without entries is empty, not an error', () => {
		expect(parseFolderListing('<folder-listing version="1.0"></folder-listing>')).toEqual([]);
	});

	test('reads single quoted attributes, a > inside a value and character references', () => {
		const entries = parseFolderListing(
			'<folder-listing>' +
			"<file name='single.txt' size = '7'/>" +
			'<file name="a > b.txt" size="1"/>' +
			'<file name="caf&#233; &#x41;&amp;#66;.txt" size="1"/>' +
			'<file name="bad &#99999999;.txt" size="1"/>' +
			'</folder-listing>');

		expect(entries.map((e) => e.name)).toEqual(['single.txt', 'a > b.txt', 'café A&#66;.txt', 'bad &#99999999;.txt']);
		expect(entries[0].size).toBe(7);
	});

	// A decoded & starts no second reference
	test('entities are decoded once: &#x26;amp; is &amp;', () => {
		const entries = parseFolderListing('<folder-listing><file name="a&#x26;amp;b &#38;lt;.txt" size="1"/></folder-listing>');
		expect(entries[0].name).toBe('a&amp;b &lt;.txt');
	});

	test('the folder-listing element itself is no folder, even with a name attribute', () => {
		const entries = parseFolderListing('<folder-listing version="1.0" name="root"><folder name="Misc"/></folder-listing>');
		expect(entries.map((e) => e.name)).toEqual(['Misc']);
	});

	test('a modified time with a trailing Z is UTC', () => {
		const [utc, local] = parseFolderListing(
			'<folder-listing>' +
			'<file name="utc.txt" modified="20060203T040506Z"/>' +
			'<file name="local.txt" modified="20060203T040506"/>' +
			'</folder-listing>');

		expect(utc.mtime).toEqual(new Date(Date.UTC(2006, 1, 3, 4, 5, 6)));
		expect(local.mtime).toEqual(new Date(2006, 1, 3, 4, 5, 6));
	});
});

// The CPU of each board in pmb887x-emu: PMB8875 is SGOLD, PMB8876 NewSGOLD
describe('OBEX: detectPhonePlatform', () => {
	test('detects SGOLD models', () => {
		for (const model of ['C65', 'CX65', 'M65', 'S65', 'S66', 'SL65', 'SK65', 'CX70', 'C72', 'C75', 'CX75', 'M75', 'ME75', 'CF75', 'S65F', 'M65C'])
			expect(detectPhonePlatform(model), model).toBe('SGOLD');
	});

	test('detects NewSGOLD models', () => {
		for (const model of ['S75', 'SL75', 'E71', 'EL71', 'M72', 'CL61', 'C81', 'M81', 'S68', 'EL71F'])
			expect(detectPhonePlatform(model), model).toBe('NewSGOLD');
	});

	test('everything else is EGOLD, an unknown model is unknown', () => {
		for (const model of ['C60', 'S55', 'M55', 'SL55', 'C55', 'A65', 'AX75', 'S45', 'SL45', 'MC60', 'C65v'])
			expect(detectPhonePlatform(model), model).toBe('EGOLD');
		expect(detectPhonePlatform(undefined)).toBe('unknown');
		expect(detectPhonePlatform('')).toBe('unknown');
	});
});

describe('OBEX: isObexResponseCode', () => {
	test('takes every OBEX response code, and nothing without the final bit', () => {
		for (const code of [0x90, 0xA0, 0xA6, 0xB0, 0xB5, 0xC0, 0xCF, 0xD5, 0xE0, 0xE1])
			expect(isObexResponseCode(code), code.toString(16)).toBe(true);
		// CR, LF, the O and K of an OK, a space, and codes OBEX does not define
		for (const code of [0x0D, 0x0A, 0x4F, 0x4B, 0x20, 0xA7, 0xB6, 0xD6, 0xE2, 0xFF])
			expect(isObexResponseCode(code), code.toString(16)).toBe(false);
	});
});

describe('OBEX: obexResponseName', () => {
	test('names a response with and without the final bit', () => {
		expect(obexResponseName(0x44)).toBe('Not found');
		expect(obexResponseName(0xC4)).toBe('Not found');
		expect(obexResponseName(0xC3)).toBe('Forbidden');
		expect(obexResponseName(0x77)).toBe('Unknown response 0x77');
	});
});

describe('OBEX: forgetsFolderAfterPut', () => {
	test('names the A56 and its siblings only', () => {
		for (const model of ['A55', 'A56', 'C55', 'a56'])
			expect(forgetsFolderAfterPut(model), model).toBe(true);
		for (const model of ['C60', 'M56', 'S55', 'S65', 'A65', undefined])
			expect(forgetsFolderAfterPut(model), String(model)).toBe(false);
	});
});
