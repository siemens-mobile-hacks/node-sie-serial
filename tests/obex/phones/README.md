# The OBEX phone database

`db/*.json` records how individual phones behave, one entry per model, firmware
and cable. The fake phone (`fakePhone.ts`) plays any entry, and
`src/obex/OBEX.phones.test.ts` runs the OBEX client against every entry, so a phone
recorded once stays in the unit tests without being plugged in.

An entry records behaviors rather than a fixed session: how fast the phone
answers AT commands, how it leaves OBEX mode, how it numbers its BFB packets,
which code answers a missing file, whether a PUT over an existing file appends.
The client can change which requests it sends, and in what order, and still be
tested against the same phones.

## Recording a phone

```
pnpm exec tsx tests/obex/phones/cli.ts record --port /dev/ttyUSB0 --notes "DCA-540"
```

- The phone has to be freshly booted or cleanly disconnected: in its AT
  interpreter, or in BFC mode on a service cable.
- The entry is named `<model>v<revision>` after what the phone says about itself,
  e.g. `S66v34`. `--id` overrides that. A second entry of the same phone, e.g. on
  another cable, gets a prefix or suffix: `DCA540-S66v34`. Entries no real phone
  recorded start with `emulated-` or `synthetic-`.
- The file checks write `probe.bin` into the first of `/Data/Misc`,
  `/Data/System/tmp`, `/tmp`, `/Misc` and `/Bitmap` that the phone
  lists and that gives an upload back, then delete it. `--dir` names another
  folder.
- `--notes` is free text for the entry.

It takes a minute or two, writes `db/<id>.json`, and checks the fake phone
against the new entry. Recording an id already in the database prints what
changed. A probe that reached neither AT nor BFC writes to the temp directory
instead, and one that could not finish never replaces an entry that works unless
`--force` is given.

## What the probe does to a phone

- It asks `AT+CGMI`, `AT+CGMM` and `AT+CGMR`, or the same through BFC. It never
  asks for the IMEI.
- It switches to OBEX the way the client does: `AT^SQWE=0`, `AT^SQWE=3`, and
  `AT^SBFB=1` if the phone does not know `AT^SQWE`; on a service cable
  `AT^SQWE=3` through BFC's AT tunnel.
- On BFB phones it jumps its sequence numbering once, to tell whether the phone
  counts its packets or echoes ours.
- It lists the root with and without the connection id, asks for a missing
  folder and file, deletes a missing file (also in `/Java`), and asks for the
  capacity and free space.
- It uploads `probe.bin` twice (3000, then 100 bytes), downloads it, downloads
  it again as `PROBE.BIN`, and deletes it.
- It ends by leaving BFB or escaping raw OBEX mode, records where the phone
  answers afterwards, and turns echo back on if it was on.

Every step keeps the bytes it exchanged, with timestamps, in the entry's
`evidence`. File contents are not kept. A step that fails goes into `problems`,
its fields stay `null` ("not measured"), and the steps that don't depend on it
still run.

## Other commands

| Command | |
| --- | --- |
| `list` | one row per entry: transport, AT speeds and latency, the platform the client derives from `AT+CGMM`, whether the connection id is needed, overwrite, case of names, problems |
| `check --entry <file>` | probes the fake phone playing the entry and compares, as `record` does at its end |
| `check --entry <file> --port /dev/ttyUSB0` | probes the phone again and compares it with its entry |
| `diff <a.json> <b.json>` | two entries side by side |

A mismatch lists the fields that differ, grouped by probe step, each group
followed by the bytes both sides exchanged. When the fake phone differs from a
recording, the phone does something `fakePhone.ts` cannot play yet: the entry
and the output show exactly what.

## Keeping the database healthy

- `loadEntry()` reads schema `SCHEMA_VERSION` only, and names every missing
  field, unknown field and wrong type at once, so a typo cannot pass as "not
  measured". `src/obex/OBEX.phones.test.ts` checks that every entry loads and is named
  after its id.
- To add a behavior: add the field to `PhoneEntry` and the validator in
  `entry.ts`, bump `SCHEMA_VERSION`, measure it in `probe.ts`, play it in
  `fakePhone.ts`, describe it below, and record the phones again.
- After a change to `probe.ts` or `fakePhone.ts`, `check` every entry: the unit
  tests run the probe on one AT phone only, not through BFC or BFB.

  ```
  for f in tests/obex/phones/db/*.json; do pnpm exec tsx tests/obex/phones/cli.ts check --entry $f; done
  ```

## Entry fields

| Field | |
| --- | --- |
| `identity` | what `AT+CGMI`, `AT+CGMM` and `AT+CGMR` (or BFC) answer |
| `at.speeds` | the speeds the AT interpreter answered `ATQ0 V1 E0` at |
| `at.latencyMs` | the median time from a command to its final result line |
| `at.echo` | whether the first command came back echoed: the state the phone was found in, not compared |
| `at.results` | the final result of `AT^SQWE=0`, `AT^SQWE=3` and `AT^SBFB=1`, or `TIMEOUT`. For a `bfc` entry, what BFC's AT tunnel answered: the switch cuts off the answer to `AT^SQWE=3` there, and the fake phone's own AT interpreter answers it `OK` |
| `transport` | `raw` after `AT^SQWE=3`, `bfb` after `AT^SBFB=1` and an answered hello, `none` when the phone refused the raw mode and had no `AT^SBFB=1` for it, `unknown` when the probe could not tell |
| `bfc` | for a phone on a service cable that answers BFC instead of AT, like an SL65: the speed BFC answered at |
| `bfb.helloSpeed`, `bfb.helloAnswer` | the first speed the BFB hello was answered at, and the answer |
| `bfb.ackFrame`, `bfb.ackBeforeResponse` | the frame acknowledging our packets, and whether it comes before the answer |
| `bfb.firstMarker`, `bfb.laterMarker` | the marker of the phone's first packet of a session and of the later ones |
| `bfb.sequence` | how the phone numbers its packets: `counter`, `echo` (our number), `constant`, or `unknown` |
| `bfb.leaveSpeeds` | the AT speeds answering after leaving BFB |
| `raw.escape` | `plus` for DISCONNECT and the `+++` escape; `none` where the cable refuses to set DTR, like the DCA-540: the phone takes `+++` for OBEX data and gets stuck, so it stays in OBEX mode between sessions |
| `raw.escapeSpeeds` | the AT speeds answering after the escape, none for a phone that needs a power cycle then |
| `obex.connect` | the CONNECT answer: code, version, flags, max packet size, whether it carried a connection id |
| `obex.connectionId` | the code of a folder listing without and with the connection id |
| `obex.codes` | the answers to a missing folder, a missing file, a delete of a missing file (in the file checks' folder and in `/Java`), an idle ABORT and the DISCONNECT |
| `obex.rootFolders`, `obex.listingPrologue` | the folders of the root, and the listing's XML up to the first entry |
| `obex.writableDir` | the folder the file checks ran in |
| `obex.getChunk` | body bytes per GET answer of a file that takes several packets |
| `obex.overwrite` | what a PUT over an existing file does: `append`, `replace` or `other` |
| `obex.caseInsensitive` | whether `PROBE.BIN` is `probe.bin` |
| `obex.info` | whether the capacity and free space requests are answered |
| `problems` | what the probe could not tell, `<step>: <why>` |
| `evidence` | the bytes each step exchanged, with timestamps |

`synthetic-S45v56.json` is written by hand: it is what `src/obex/ObexBfbLink.ts`
assumes a pre-x55 phone does, until a real S45, ME45 or SL45 replaces it.
`emulated-EL71v41.json` is recorded from pmb887x-emu.
