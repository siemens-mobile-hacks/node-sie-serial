[![NPM Version](https://img.shields.io/npm/v/%40sie-js%2Fserial)](https://www.npmjs.com/package/@sie-js/serial)

# Summary

Various serial protocols which are used in the Siemens Mobile Phones.

Install this package with npm:

```shell
npm i @sie-js/serial
```

# Examples

| Protocol | Example                                                                                                  | Description                      |
|----------|----------------------------------------------------------------------------------------------------------|----------------------------------|
| BFC      | [examples/bfc.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/bfc.ts)     | Siemens Debug protocol           |
| CGSN     | [examples/cgsn.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/cgsn.ts)   | ArmDebugger protocol             |
| AT       | [examples/atc.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/atc.ts)     | Modem AT commadns protocol       |
| BSL      | [examples/bsl.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/bsl.ts)     | Serial Bootstrap Loader protocol |
| DWD      | [examples/dwd.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/dwd.ts)     | APOXI debug protocol (DWDIO)     |
| CHAOS    | [examples/chaos.ts](https://github.com/siemens-mobile-hacks/node-sie-serial/blob/main/examples/chaos.ts) | Chaos flasher protocol           |

# AI-assisted contributions

We are not against AI. We are against vibe coding, AI slop, and attempts to offload engineering work to a model. This project prioritizes quality, not development speed or results at any cost.

1. **Do not use AI-generated text in human-to-human communication.**

   Write comments, discussions, PR descriptions, and responses to reviewers yourself.

2. **Do not let AI submit PRs or commits.**

   The author must always be a human who has personally reviewed the changes and takes responsibility for them.

4. **Do not submit code primarily designed or written by AI.**

   Architecture, algorithms, code organization, and the final implementation must be decided by a human. AI may only be used as an auxiliary tool.

6. **You must understand all the code you submit.**

   You must be able to explain every change, justify your decisions, and fix any problems yourself. If you do not understand the code, open a feature request instead of a PR.

8. **Code must be simple, clear, and tested.**

   Follow KISS, the project's coding style, and its existing architecture. Do not introduce unnecessary abstractions, dependencies, or untested changes.

AI slop PRs will be closed without review.
