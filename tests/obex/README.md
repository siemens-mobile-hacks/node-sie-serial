# OBEX e2e tests

These tests talk to a real Siemens phone — an emulated one, or one on a cable.
[pmb887x-emu](https://github.com/siemens-mobile-hacks/pmb887x-emu) boots an
actual fullflash and exposes the phone's USART0 as a QEMU TCP chardev; the tests
open it with `serialport-bindings-socket` and run the protocol code of `src/`
against the firmware that answers there. Nothing is mocked: the AT interpreter,
the `AT^SQWE=3` mode switch and the FlexMem OBEX server are the phone's own.

```
pnpm test                                             # the unit tests, everywhere
pnpm test:obex-emulator                               # this suite, needs an emulator and a fullflash
OBEX_E2E_DEVICE=/dev/ttyUSB0 pnpm test:obex-hardware  # the same suite against a phone on a cable
```

Without an emulator or the fullflashes the suites skip themselves and print what
is missing — they are not part of `pnpm test`.

`obexSuite(target)` is what all of them share. A `PhoneTarget` (`target.ts`) is
either an emulator the suite boots, with its model and directories known from
the table in `emulator.ts`, or the phone on the other end of `OBEX_E2E_DEVICE`
(`device.ts`), which is whatever somebody plugged in.

## Against a real phone

A phone on a cable is the only way to cover a real link and the phones the
emulator cannot run — everything before the x65, the BFB transport included.

| Variable | Default | |
| --- | --- | --- |
| `OBEX_E2E_DEVICE` | — | the port, e.g. `/dev/ttyUSB0` (or `tcp://host:port`); without it the suite skips |
| `OBEX_E2E_SMALL_FILES_DIR` | — | a directory holding files below 4 KiB to download; without it the suite looks for one, starting at the root |
| `OBEX_E2E_BAUDRATE` | — | pin the AT probe to one speed instead of walking all of them |
| `OBEX_E2E_RECONNECT_WAIT_MS` | `5000` | the pause between the disconnect and the connect of the reconnect test |

**It writes to the phone.** Inside its directory it creates `e2e-*` files and
an `e2e-dir` folder, reads them back and deletes them again, and before the
first test it deletes whatever of those a failed run left behind. It touches
nothing else.

The directory is the first of `/Data/Misc`, `/Data/System/tmp`, `/tmp`,
`/Misc` and `/Bitmap` (`WRITABLE_DIR_CANDIDATES` in `phones/probe.ts`)
that the phone's listings show and that gives a small upload back. The suite
only enters folders a listing shows, never a path on a guess, and ignores the
listed permissions: an M56 grants write access in `group-perm` alone. x65 and
x75 phones have `/Data/Misc`. The EGOLD phones have no `Data` folder and keep
their folders in the root: a C60 gets `/tmp`, an M56 `/Misc`, an A56 `/Bitmap`.
The A56's `/Inbox` is never tried: it keeps what is deleted there, and a few
deletes there hang the phone until a power cycle. The suite prints the
directory it picked. When the listings show none of them, it fails before the
first test with a listing of the root; when none gives an upload back, the
tests that upload are skipped.

What the suite cannot know about a phone it did not boot is its identity: it
reads the name and the platform from the phone, checks that the phone has both
and prints them. The uploads are 16 KiB, several packets on every phone. At
the end the suite disconnects, which hands the phone back to its AT interpreter.

The emulated phones get exactly the same treatment: the same upload size and
the same pause before reconnecting. The suite does not work around the emulator
bugs below, so a test that trips over one fails.


## The phones

| Board | Fullflash | |
| --- | --- | --- |
| `siemens-el71` | `EL71v41lg91.bin` | NewSGOLD, ~16 s to the first AT answer, ~691 kbaud, 8203 byte OBEX packets |
| `siemens-s75` | `S75v40lg1.bin` | NewSGOLD, ~10 s, ~691 kbaud, 8208 byte OBEX packets |

The SGOLD boards are left out for now. The emulated CX70 and SL65 lose a serial
command within their first minute, which fails their uploads. The unit tests
cover SGOLD phones with the recorded S66 and SL65.

The suite still gives each phone a full minute before it starts. The AT
interpreter answering does not mean the phone is ready: the rest of the startup
keeps blocking the serial task for seconds at a time, and an OBEX exchange that
runs into its 15 s timeout takes the session down with it and fails the test,
and the next test has to connect all over again. Waiting the boot out is what makes the suite
reproducible; starting after ~10 s loses a random one of the phones about
half the time. On top of that `beforeAll` waits for the file system itself,
which comes up later still — the phone lists directories correctly while
opening a file in them is still answered with `Not found`.

Each test file boots its own emulator on its own TCP port; the tests inside one
file share that phone and run in order. The files run **one at a time**
(`--no-file-parallelism`): QEMU runs the phone on a precise instruction clock
that is pinned to real time, so two of them competing for CPU boot slower than
the suite waits for.
A phone that the tests write to is started with `--rw` on a private copy of the
fullflash: `--rw` persists FlexMem writes into the image, and the shared
fullflash has to stay byte-identical for other projects' tests.

## The emulator quirks

* **The emulated USART hands the guest its input far faster than the wire
  would — patch it or writes panic the phone.** `usart_schedule_accept_input()`
  waits one frame time and then lets the chardev fill the whole RX FIFO, so the
  guest sees up to 8 bytes per frame instead of one; a guest that drains the
  FIFO pulls the next delivery forward on top of that. A bulk OBEX PUT then
  arrives as an interrupt storm, GSM layer 1 misses its deadline and the
  firmware panics on purpose — `>>EXIT<< ... FILE: l1bbcsg`, after which it
  never answers again. The panic arrives **over the phone's serial line**, not
  in the emulator's log, so from the client it looks like the phone just went
  quiet.

  It is an emulator bug, not a phone or an OBEX limit, and it is not a host
  speed problem: the same 4136 byte PUT that panics when written in one go
  succeeds byte for byte when the host paces it to ~100 kbaud, and it panics
  identically on an idle host, on a loaded one, and with the emulated CPU pinned
  anywhere between 70 and 140 MHz. `-icount precise-clocks=on` (which the
  launcher always passes) cannot help: the over-fast delivery is measured in
  guest time, so slowing the host down scales it too.

  The fix is to charge one frame time per word delivered and to refuse new input
  while the line is still busy. With it the EL71 and the S75 take 4 KiB writes
  ten times in a row; without it they die on the first one.
* **The host baud rate is meaningless, but the guest's is not.** It is a TCP
  chardev, so whatever `SerialPort` is opened with is ignored — but the firmware
  programs USART0 itself, and the emulator paces delivery to *that*: ~691 kbaud
  on the x75 phones.
* **Every emulated phone loses a command every 30–40 s.** Pinged with `AT`
  every half second over the raw socket, the phone leaves one ping in about
  thirty unanswered for good and answers the next one at once: the EL71 from
  about three minutes after boot on, the SGOLD boards from the first minute. It
  is not the flash, it happens without `--rw` as well. In OBEX mode a
  lost request or response is a 15 s timeout, after which the client redoes the
  handshake, so the phone seems to go quiet for ~20 s. Then it repeats the
  request if that is safe (reads, `mkdir`, deletes, uploads over a file it may
  delete); a `move()` or an upload that may have left part of a file fails
  instead. When the retry is lost too, the operation fails and the session
  ends, and the suite's `beforeEach` connects again. This is the first thing to
  suspect when a test flakes; the x75 suites mostly finish before it starts.
* **A session can be redone.** `OBEX.disconnect()`'s `+++` escape really does
  hand the wire back to the AT interpreter, but the phone needs a few seconds
  before the next handshake catches it — unlike the flasher's service mode,
  where the phone is dead after one session. Reconnecting too early does not
  just fail the handshake, it loses the session for good, so the suite waits
  5 s, the same as on a real phone.
* `--wait-for-serial` is *not* used here: the tests want the firmware running,
  not the boot ROM serial monitor.
* **The BFC transport of `OBEX.connect()` cannot be tested here.** A phone booted
  on a service cable sits in BFC mode and answers no AT command, so `connect()`
  tunnels the mode switch through BFC instead. The emulated phone does BFC fine
  (`BFC.connect()` reports the product and `AT^SQWE=0` answers `OK` through the
  tunnel), but it never actually switches the wire to OBEX afterwards: the
  following OBEX CONNECT is answered by nothing. And once an OBEX session has
  run, the emulated phone cannot be put back into BFC mode at all
  (`AT^SQWE=1` is accepted but the BFC ping then fails). The unit tests cover
  the BFC transport with a recorded SL65 (`phones/db/SL65v53.json`).
* **Neither can the BFB transport.** Only phones before the x55 generation
  (S45, ME45, SL45...) wrap OBEX in BFB frames, and the emulator runs x65 and
  later phones. Its framing is unit-tested against frames that siefs and
  obexftp's libbfb build (`src/ObexBfbLink.test.ts`), and the client against a
  hand-written S45 (`phones/db/synthetic-S45v56.json`); end to end it needs one
  of those phones on a cable.
