![NPM Version](https://img.shields.io/npm/v/%40sie-js%2Fserial)

# Installation
```
npm i @sie-js/serial
```

# BFC
```js
import fs from 'fs';
import { SerialPort } from 'serialport';
import { BFC } from '@sie-js/serial';


let bus = new BFC(port);
bus.setVerbose(true);
await bus.connect();
await bus.setSpeed(921600);

let bfc = bus.openChannel();

let display_cnt = await bfc.getDisplayCount();
console.log(`Total displays: ${display_cnt}`);

for (let i = 1; i <= display_cnt; i++) {
  let display_info = await bfc.getDisplayInfo(i);
  let display_buffer = await bfc.getDisplayBufferInfo(display_info.clientId);
  console.log(display_buffer);
  
  console.time("read");
  
  let memory = Buffer.alloc(0);
  
  let size_to_read = display_buffer.width * display_buffer.height * 2;
  let chunk_size = 63 * 256;
  let buffer_cursor = display_buffer.addr;
  while (size_to_read > 0) {
    let chunk = await bfc.readMemory(buffer_cursor, Math.min(size_to_read, chunk_size));
    memory = Buffer.concat([memory, chunk]);
    size_to_read -= chunk.length;
    buffer_cursor += chunk.length;
  }
  
  fs.writeFileSync("/tmp/screen.bin", memory);
  
  console.timeEnd("read");
}

await bus.disconnect();
```

# AtChannel
```js
import { SerialPort } from 'serialport';
import { AtChannel } from '@sie-js/serial';

let port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });

let at_channel = new AtChannel(port);
at_channel.start();
at_channel.setVerbose(true);

console.log(await at_channel.handshake());
console.log(await at_channel.sendCommandNumeric("AT+CGSN"));
```
