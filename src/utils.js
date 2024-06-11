export async function serialPortAsyncUpdate(port, settings) {
	return new Promise((resolve, reject) => {
		port.update(settings, (err) => {
			if (err) {
				reject(err);
			} else {
				resolve(true);
			}
		});
	});
}

export async function serialPortAsyncWrite(port, data) {
	return new Promise((resolve, reject) => {
		port.write(data);
		port.drain((err) => {
			if (err) {
				reject(err);
			} else {
				resolve(true);
			}
		});
	});
}

export function serialWaitForOpen(port) {
	return new Promise((resolve, reject) => {
		port.on('open', async () => {
			resolve(port);
		});
		port.on('error', (err) => {
			reject(err);
		});
	});
}
