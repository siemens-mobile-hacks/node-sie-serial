import { describe, expect, test } from 'vitest';
import { encodeDnsQuery, parseDnsResponse } from './DNS.js';

describe('DNS: encodeDnsQuery', () => {
	test('encodes an A query with recursion desired', () => {
		expect(encodeDnsQuery(0x1234, 'example.org').toString('hex')).toBe(
			'1234' + '0100' + '0001' + '0000' + '0000' + '0000' +
			'07' + Buffer.from('example').toString('hex') + '03' + Buffer.from('org').toString('hex') + '00' +
			'0001' + '0001',
		);
	});
});

describe('DNS: parseDnsResponse', () => {
	test('decodes A records after a compressed CNAME answer', () => {
		const response = Buffer.from(
			'1234' + '8180' + '0001' + '0002' + '0000' + '0000' +
			'03' + Buffer.from('www').toString('hex') + '07' + Buffer.from('example').toString('hex') + '03' + Buffer.from('org').toString('hex') + '00' +
			'0001' + '0001' +
			// www.example.org CNAME example.org
			'c00c' + '0005' + '0001' + '00000e10' + '0002' + 'c010' +
			// example.org A 93.184.215.14
			'c010' + '0001' + '0001' + '00000e10' + '0004' + '5db8d70e',
			'hex',
		);
		expect(parseDnsResponse(0x1234, response)).toEqual(['93.184.215.14']);
	});

	test('ignores responses to another query', () => {
		const response = Buffer.from('4321' + '8180' + '0000' + '0000' + '0000' + '0000', 'hex');
		expect(parseDnsResponse(0x1234, response)).toBeUndefined();
	});

	test('reports a server error', () => {
		const response = Buffer.from('1234' + '8183' + '0000' + '0000' + '0000' + '0000', 'hex');
		expect(() => parseDnsResponse(0x1234, response)).toThrow('DNS server returned error 3.');
	});
});
