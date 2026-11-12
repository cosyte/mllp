---
id: property-test-your-code
title: Property-test your own code with generated MLLP streams
sidebar_label: Property-test your code
description: "Test your own MLLP code on generated frames, messy streams and hostile bytes in any chunks, with the fast-check generators at @cosyte/mllp/arbitraries."
---

# Property-test your own code with generated MLLP streams

A test written by hand checks the byte streams its author thought of. A property-based test states
a rule, such as "every message sent comes out the other end" or "this never crashes the listener",
and checks it on as many generated streams as you ask for. `@cosyte/mllp/arbitraries` exports the
generators we use to test this library, built on [fast-check](https://fast-check.dev), so you can
point them at code you build on it.

The reference entries used here are [`FrameReader`](./api/src.md#framereader),
[`encodeFrame`](./api/src.md#encodeframe) and [`MllpFramingError`](./api/src.md#mllpframingerror).
The generators' options are in their TSDoc comments, which an editor shows on hover.

Every generated value is synthetic and random, so a failing case is safe to paste into an issue.

## Install fast-check

```bash
npm install --save-dev fast-check
```

fast-check is an optional peer dependency of `@cosyte/mllp`. Only `@cosyte/mllp/arbitraries` loads
it; the main entry point never does, so code that only sends and receives messages does not need
it.

## Check that your code reads any stream

`stream()` generates one to five canonical frames back to back, split into chunks at random places,
the way a socket delivers them: a frame across many reads, many frames in one read, now and then an
empty read. It comes with the payloads the stream carries, so the rule can be exact. Here the code
under test collects the messages on a connection.

```ts runnable
import fc from "fast-check";
import { FrameReader } from "@cosyte/mllp";
import { stream } from "@cosyte/mllp/arbitraries";

// Your code: collect every message that arrives on a connection, as text.
function collect(reads: readonly Buffer[]): string[] {
  const messages: string[] = [];
  const reader = new FrameReader({
    onFrame: (payload) => messages.push(payload.toString("latin1")),
  });
  for (const read of reads) reader.push(read);
  return messages;
}

// The rule: whatever the reads, every message arrives once, in order, unchanged.
fc.assert(
  fc.property(stream({ content: "hl7" }), (s) => {
    const expected = s.payloads.map((p) => p.toString("latin1"));
    return JSON.stringify(collect(s.chunks)) === JSON.stringify(expected);
  }),
  { numRuns: 50 },
);

const [sample] = fc.sample(stream({ content: "hl7", minFrames: 2, maxFrames: 2 }), {
  numRuns: 1,
  seed: 1,
});
collect(sample?.chunks ?? []).length; // => 2
```

`payload()` gives the payloads alone and `frame()` one canonical frame with its payload. Each takes
`content`: `"bytes"` (the default, any byte but `VT` and `FS`), `"text"`, or `"hl7"` for synthetic
HL7 v2 messages with a control id in `MSH-10`.

## Check your code against senders' framing quirks

`messyStream()` generates the framing quirks real senders produce: padding before a `VT`, a frame
with no `VT`, an empty frame, and a frame ended by `FS` and a line feed or by `FS` and the next
`VT`. It never puts a `VT` or a bare `FS` inside a frame, since a reader refuses such a frame
whole. Give it the
tolerances your reader has, and it generates only what that reader accepts, with the payloads and
the warning codes the reader must report for each frame. The flags below are a server's defaults.

```ts runnable
import fc from "fast-check";
import { FrameReader } from "@cosyte/mllp";
import { messyStream } from "@cosyte/mllp/arbitraries";

const tolerances = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowLeadingWhitespace: true,
  allowMissingLeadingVt: false,
};

// Your code: read a connection, keeping each message's warning codes for the log.
function readWithWarnings(reads: readonly Buffer[]): { text: string; codes: string[] }[] {
  const out: { text: string; codes: string[] }[] = [];
  const reader = new FrameReader({
    ...tolerances,
    onFrame: (payload, _offset, warnings) => {
      out.push({ text: payload.toString("latin1"), codes: warnings.map((w) => w.code) });
    },
  });
  for (const read of reads) reader.push(read);
  return out;
}

fc.assert(
  fc.property(messyStream({ ...tolerances, content: "text" }), (s) => {
    const got = readWithWarnings(s.chunks);
    const expected = s.payloads.map((p, i) => ({
      text: p.toString("latin1"),
      codes: s.warnings[i],
    }));
    return JSON.stringify(got) === JSON.stringify(expected);
  }),
  { numRuns: 50 },
);

const padded = Buffer.from("\r\n\vMSH|^~\\&|A\x1c\r", "latin1");
readWithWarnings([padded])[0]?.codes; // => ["MLLP_LEADING_WHITESPACE"]
```

## Feed your code hostile bytes

`hostileInput()` generates the chunks of a stream a reader may meet from a broken sender, a port
scanner or an attacker: random bytes, bytes thick with `VT`, `FS`, `CR` and whitespace, and messy
streams with bytes inserted, deleted, repeated and cut off. A reader may refuse one with an
`MllpFramingError`, but your code around it must not crash, hang or let anything else escape.

```ts runnable
import fc from "fast-check";
import { FrameReader, MllpFramingError } from "@cosyte/mllp";
import { hostileInput } from "@cosyte/mllp/arbitraries";

// Your code: read a connection, and close it on a framing error rather than crash the listener.
function serve(reads: readonly Buffer[]): "open" | "closed" {
  const reader = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: 64 });
  try {
    for (const read of reads) reader.push(read);
    return "open";
  } catch (err) {
    if (err instanceof MllpFramingError) return "closed";
    throw err;
  }
}

fc.assert(
  fc.property(hostileInput(), (reads) => {
    serve(reads);
  }),
  { numRuns: 100 },
);

serve([Buffer.from("GET / HTTP/1.1\r\n")]); // => "closed"
```

`chunked(bytes)` splits bytes of your own the same way, so a test of yours can check that how a
stream is read never changes what your code does with it.

## Pick the generators

| Generator        | Generates                                                                                      | Options                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `payload()`      | a `Buffer` the encoder accepts: no `VT`, no `FS`                                               | `content`, `minLength`, `maxLength`                                                                                                 |
| `frame()`        | `{ payload, bytes }`: a canonical frame, written from the specification, not by `encodeFrame`  | the payload options                                                                                                                 |
| `stream()`       | `{ payloads, bytes, chunks }`: canonical frames back to back, in random reads                  | the payload options, `minFrames`, `maxFrames`, `maxCuts`                                                                            |
| `messyStream()`  | `{ payloads, warnings, bytes, chunks }`: a stream with framing quirks a lenient reader accepts | the stream options, and `allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`, `allowLeadingWhitespace` (each `true` by default) |
| `hostileInput()` | the chunks of a hostile stream, a `Buffer[]`                                                   | `maxLength`, `maxCuts`                                                                                                              |
| `chunked(bytes)` | the given bytes split into random reads, a `Buffer[]`                                          | `maxCuts`                                                                                                                           |

## Replay a failure

When a rule fails, fast-check shrinks the case to a small one and reports the seed and path that
produced it. Each generated case keeps a copy of itself, so a failure reports the case as it was
generated, even when the code under test changed the bytes it was given.

```ts runnable
import fc from "fast-check";
import { payload } from "@cosyte/mllp/arbitraries";

// A rule that is wrong, in code that overwrites its input as it goes.
const neverHasAZeroByte = fc.property(payload(), (p) => {
  const found = p.includes(0);
  p.fill(0x41);
  return !found;
});

let report = "";
try {
  fc.assert(neverHasAZeroByte, { seed: 42 });
} catch (err) {
  report = String(err);
}
report.includes("seed: 42"); // => true
report.includes("Counterexample: [Buffer.from([0])]"); // => true
```

Pass the reported `seed` and `path` back to `fc.assert` to run that one case again, already shrunk,
while you fix it. A test in CI can run more cases than one on a laptop: set `numRuns` from an
environment variable, as we do with `COSYTE_PROPERTY_RUNS`.

## Reference

- [`FrameReader`](./api/src.md#framereader), [`encodeFrame`](./api/src.md#encodeframe),
  [`MllpFramingError`](./api/src.md#mllpframingerror)
- [Tolerate a sender's framing quirks](./tolerate-sender-quirks.md) shows each tolerance flag, and
  [Framing and tolerance](./framing.md) explains the model behind them.
- [Testing and quality](./testing-and-quality.md) says how we use these generators on this
  library.
