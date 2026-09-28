import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { OBEX } from '../src/index.js';
import { openPort } from './utils.js';

const { values: argv } = parseArgs({
	options: {
		port: {
			type: 'string',
			default: '/dev/ttyUSB0'
		},
		baudrate: {
			type: 'string',
			default: '0'
		},
		dir: {
			type: 'string',
			default: '/'
		},
		get: {
			type: 'string'
		},
		put: {
			type: 'string'
		},
		file: {
			type: 'string'
		},
		help: {
			type: 'boolean',
			short: 'h',
			default: false
		},
		usage: {
			type: 'boolean',
			default: false
		}
	}
});

if (argv.help || argv.usage) {
	console.log(`USAGE: obex.js --port /dev/ttyUSB0 [--baudrate 115200] [--dir /] [--get /Misc/file.txt [--file local.txt]] [--put /Misc/file.txt --file local.txt]`);
	console.log(`--get saves to --file, by default to the remote file's name in the current directory`);
	process.exit(0);
}

if (argv.put && !argv.file) {
	console.error(`--put needs --file, the local file to upload`);
	process.exit(1);
}

const port = await openPort(argv.port, 115200);
await port.open();

const obex = new OBEX(port);
port.on('error', (err) => console.error('Port error', err));
port.on('close', () => console.error('Port close'));

// A phone left in OBEX mode answers no AT commands until it is escaped or
// power-cycled, so the session is ended on errors too
try {
	console.log('Connecting...');
	await obex.connect(+argv.baudrate);

	console.log('DEVICE', obex.getDeviceName());
	console.log('PLATFORM', obex.getPlatform());
	console.log('MAX PACKET SIZE', obex.getMaxPacketSize());
	console.log('CAPACITY', await obex.getCapacity());
	console.log('AVAILABLE', await obex.getAvailable());

	if (argv.get) {
		const data = await obex.getFile(argv.get, ({ percent, speed }) => {
			console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s`);
		});
		const file = argv.file ?? argv.get.split(/[\/\\]+/).pop()!;
		fs.writeFileSync(file, data);
		console.log(`${data.length} bytes saved to ${file}`);
	} else if (argv.put) {
		const file = argv.file!;
		await obex.putFile(argv.put, fs.readFileSync(file), ({ percent, speed }) => {
			console.log(`Progress: ${percent.toFixed(2)}% | Speed: ${(speed / 1024).toFixed(2)} KB/s`);
		});
		console.log(`${file} uploaded to ${argv.put}`);
	} else {
		for (const entry of await obex.readDir(argv.dir)) {
			const mtime = entry.mtime ? entry.mtime.toISOString() : '-';
			console.log(`${entry.isDir ? 'd' : '-'}${entry.readable ? 'r' : '-'}${entry.writable ? 'w' : '-'}` +
				` ${String(entry.size).padStart(10)} ${mtime} ${entry.name}`);
		}
	}
} finally {
	await obex.disconnect();
	await port.close();
}
