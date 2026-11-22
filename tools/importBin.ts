import fs from 'node:fs';

const LINE_LENGTH = 128;

const BINARIES = [
	{ input: 'firmware/chaos_x85.bin',			output: 'src/boot/chaos.bin.ts',		name: 'CHAOS_BOOT_CODE' },
	{ input: 'firmware/ebl_sgold1.bin',			output: 'src/ebl/ebl_sgold1.bin.ts',	name: 'EBL_SGOLD1' },
	{ input: 'firmware/ebl_sgold2.bin',			output: 'src/ebl/ebl_sgold2.bin.ts',	name: 'EBL_SGOLD2' },
	{ input: 'firmware/ebl_sgold3.bin',			output: 'src/ebl/ebl_sgold3.bin.ts',	name: 'EBL_SGOLD3' },
];

for (const { input, output, name } of BINARIES) {
	const base64 = fs.readFileSync(input).toString('base64');
	const lines: string[] = [];
	for (let i = 0; i < base64.length; i += LINE_LENGTH)
		lines.push(`\t'${base64.substring(i, i + LINE_LENGTH)}'`);
	fs.writeFileSync(output, `export const ${name} = Buffer.from(\n${lines.join(' +\n')},\n\t'base64'\n);\n`);
}
