[![NPM Version](https://img.shields.io/npm/v/%40sie-js%2Fserial)](https://www.npmjs.com/package/@sie-js/serial)

# Summary

Various serial protocols which are used in the Siemens Mobile Phones.

Install this package with npm:

```shell
npm i @sie-js/serial
```

# BFC

Protocol for service operations with the phone.

```js
import fs from 'fs';
import { SerialPort } from 'serialport';
import { BFC } from '@sie-js/serial';

let bfc = new BFC(port);
bfc.setVerbose(true);
await bfc.connect();
await bfc.setBestSpeed();

let displaysCnt = await bfc.getDisplayCount();
console.log(`Total displays: ${displaysCnt}`);

for (let i = 1; i <= displaysCnt; i++) {
  let displaysInfo = await bfc.getDisplayInfo(i);
  let displaysBuffer = await bfc.getDisplayBufferInfo(displaysInfo.clientId);
  console.log(displaysBuffer);

  console.time("read");

  let memory = Buffer.alloc(0);

  let bytesToRead = displaysBuffer.width * displaysBuffer.height * 2;
  let bufferCursor = displaysBuffer.addr;
  while (bytesToRead > 0) {
    let chunk = await bfc.readMemory(bufferCursor, Math.min(bytesToRead, 63 * 256));
    memory = Buffer.concat([memory, chunk]);
    bytesToRead -= chunk.length;
    bufferCursor += chunk.length;
  }

  fs.writeFileSync("/tmp/screen.bin", memory);

  console.timeEnd("read");
}

await bus.disconnect();
```

# AtChannel

Working with classic AT commands.

```js
import { SerialPort } from 'serialport';
import { AtChannel } from '@sie-js/serial';

let port = new SerialPort({ path: '/dev/ttyUSB0', baudRate: 115200 });

let atc = new AtChannel(port);
atc.start();
atc.setVerbose(true);

console.log(await atc.handshake());
console.log(await atc.sendCommandNumeric("AT+CGSN"));
```
