import { BFC_FRAME_TYPES } from './BFC.js';

export class BfcChannel {
	constructor(bus, id) {
		this.id = id;
		this.bus = bus;
	}
	
	async ping(timeout = 10000) {
		try {
			return await this.bus.sendAuth(this.id, 0x02, timeout);
		} catch (e) { console.log(e) }
		return false;
	}
	
	async setPhoneBaudrate(baudrate) {
		let payload = Buffer.concat([ Buffer.from([0x02]), Buffer.from(baudrate.toString()) ]);
		let response = await this.bus.exec(this.id, 0x01, payload);
		if (response[0] == 0x02 && response[1] == 0xEE)
			return false;
		return true;
	}
	
	async getDisplayCount() {
		let response = await this.bus.exec(this.id, 0x0A, [0x06]);
		return response[1];
	}
	
	async getDisplayInfo(display_id) {
		let response = await this.bus.exec(this.id, 0x0A, [0x07, display_id]);
		return {
			subcmd:		response.readUInt8(0),
			width:		response.readUInt16LE(1),
			height:		response.readUInt16LE(3),
			clientId:	response.readUInt8(5),
		};
	}
	
	async getDisplayBufferInfo(client_id) {
		let response = await this.bus.exec(this.id, 0x0A, [0x09, client_id]);
		return {
			subcmd:		response.readUInt8(0),
			clientId:	response.readUInt8(1),
			width:		response.readUInt16LE(2),
			height:		response.readUInt16LE(4),
			x:			response.readUInt16LE(6),
			y:			response.readUInt16LE(8),
			addr:		response.readUInt32LE(10),
			type:		response.readUInt8(14),
		};
	}
	
	async sendAT(cmd, timeout) {
		let tmp_buffer = "";
		let parser = (frame, resolve) => {
			tmp_buffer += frame.data.toString();
			if (tmp_buffer.match(/\r\n(OK|ERROR|\+CMS ERROR|\+CME ERROR)[^\r\n]*\r\n$/s))
				resolve(tmp_buffer);
		};
		return await this.bus.exec(this.id, 0x17, cmd, { parser, timeout });
	}
	
	async readMemory(address, length) {
		let cmd = Buffer.alloc(9);
		cmd.writeUInt8(0x01, 0);
		cmd.writeUInt32LE(address, 1);
		cmd.writeUInt32LE(length, 5);
		
		if (length > 32 * 1024)
			throw new Error(`Maximum length for memory reading is 32k.`);
		
		let frameId = 0;
		let tmpBuffer = Buffer.alloc(0);
		
		let parser = (frame, resolve) => {
			if (frameId == 0) {
				let ack = frame.data.readUInt16BE(0);
				if (ack != 0x100)
					resolve(new Error(`readMemory(): invalid ACK (0x${ack.toString(16)})`));
			} else if (frame.type == BFC_FRAME_TYPES.SIGNLE) {
				tmpBuffer = Buffer.concat([tmpBuffer, frame.data]);
			} else if (frame.type == BFC_FRAME_TYPES.MULTIPLE) {
				tmpBuffer = Buffer.concat([tmpBuffer, frame.data.slice(1)]);
			} else {
				throw new Error(`Unknown frame received: ${JSON.stringify(frame)}`);
			}
			
			if (tmpBuffer.length > length) {
				resolve(new Error(`readMemory(): invalid length ${tmpBuffer.length} > ${length}`));
			} else if (tmpBuffer.length == length) {
				resolve(tmpBuffer);
			}
			
			frameId++;
		};
		return await this.bus.exec(this.id, 0x06, cmd, { parser });
	}
}
