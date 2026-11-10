---
id: tolerate-sender-quirks
title: Tolerate a sender's framing quirks
sidebar_label: Tolerate framing quirks
description: "Accept the framing deviations real senders produce, one flag at a time, on a FrameReader or a server, and see each one reported by a stable warning code."
---

# Tolerate a sender's framing quirks

Real senders do not always write the canonical block `VT` payload `FS` `CR`. Some end a frame with
`FS` alone, some put a line feed after it, some pad before the `VT`, and a few omit the `VT`
entirely. This guide shows how to accept each of those deviations deliberately, and how to see
every one you accepted. [Framing and tolerance](./framing.md) explains the model behind it.

The reference entries used here are [`FrameReader`](./api/src.md#framereader),
[`FrameReaderOptions`](./api/src.md#framereaderoptions), [`MllpWarning`](./api/src.md#mllpwarning)
and [`MllpFramingError`](./api/src.md#mllpframingerror). Every code is listed in
[Warning and error codes](./warning-and-error-codes.md#framing-warnings).

## The four flags

| Flag                     | Accepts                             | Warning code              | `FrameReader` default | Server default |
| ------------------------ | ----------------------------------- | ------------------------- | --------------------- | -------------- |
| `allowFsOnly`            | a frame that ends `FS` with no `CR` | `MLLP_FS_WITHOUT_CR`      | off                   | on             |
| `allowLfAfterFs`         | a line feed after `FS`              | `MLLP_LF_AFTER_FS`        | off                   | on             |
| `allowLeadingWhitespace` | padding before `VT`                 | `MLLP_LEADING_WHITESPACE` | off                   | on             |
| `allowMissingLeadingVt`  | a frame with no leading `VT`        | `MLLP_MISSING_LEADING_VT` | off                   | off            |

With a flag off, the deviation is not tolerated: `FrameReader.push()` throws `MllpFramingError`
with that code, and a connection that meets it is closed. With the flag on, the payload is
recovered and the code is reported as a warning. `strict: true` turns all four off again, whatever
the individual flags say.

## On a standalone reader

A `FrameReader` you construct yourself is strict until you opt in:

```ts runnable
import { FrameReader, MllpFramingError } from "@cosyte/mllp";

// <VT> "A" <FS> <LF>: a line feed where the <CR> belongs.
const bytes = Buffer.from([0x0b, 0x41, 0x1c, 0x0a]);

let refused = "";
try {
  new FrameReader({ onFrame: () => {} }).push(bytes);
} catch (err) {
  refused = err instanceof MllpFramingError ? err.code : "other";
}
refused; // => "MLLP_LF_AFTER_FS"

const codes: string[] = [];
const frames: string[] = [];
new FrameReader({
  onFrame: (payload) => frames.push(payload.toString("latin1")),
  onWarning: (warning) => codes.push(warning.code),
  allowLfAfterFs: true,
}).push(bytes);

frames; // => ["A"]
codes; // => ["MLLP_LF_AFTER_FS"]
```

## On a server

A server applies `allowFsOnly`, `allowLfAfterFs` and `allowLeadingWhitespace` to every connection it
accepts, because it is the side that has to take what senders write. Its `onWarning` option sees
every warning from every connection:

```ts runnable
import { connect } from "node:net";
import { createServer } from "@cosyte/mllp";

const codes: string[] = [];
const server = createServer({
  autoAck: "AA",
  onMessage: async () => {},
  onWarning: (warning) => codes.push(warning.code),
});
await server.listen(0);

// A sender that ends its frame <FS> <LF> instead of <FS> <CR>.
const socket = connect(server.getStats().port ?? 0, "127.0.0.1");
await new Promise((resolve) => socket.once("connect", resolve));
const reply = new Promise<Buffer>((resolve) => socket.once("data", resolve));
socket.write(
  Buffer.concat([
    Buffer.from([0x0b]),
    Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0301|P|2.5.1\r"),
    Buffer.from([0x1c, 0x0a]),
  ]),
);

(await reply).toString("latin1").includes("MSA|AA|CTRL0301"); // => true
codes; // => ["MLLP_LF_AFTER_FS"]

socket.destroy();
await server.close();
```

Pass `framing` to change those defaults. Whatever you pass is merged over them, so
`framing: { strict: true }` makes a server as strict as a bare reader, and
`framing: { allowMissingLeadingVt: true }` adds the fourth flag. Turn `allowMissingLeadingVt` on
only for a sender you have identified: a stream with no `VT` gives the reader no reliable way to
tell where a message starts.

The client takes the same `framing` option for the acknowledgments it reads, and applies none of
the flags unless you pass them.

## Bound the frame size

A reader buffers until it sees `FS`, so a peer that opens a frame and never closes it would grow
the buffer without end. `maxFrameSizeBytes` caps it; the default is 16 MiB (16,777,216 bytes).
Past the cap, `push()` throws `MllpFramingError` with `MLLP_FRAME_TOO_LARGE`, and on a server or
client that closes the connection:

```ts runnable
import { FrameReader, MllpFramingError } from "@cosyte/mllp";

const reader = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: 8 });

let code = "";
try {
  reader.push(Buffer.from([0x0b, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
} catch (err) {
  code = err instanceof MllpFramingError ? err.code : "other";
}
code; // => "MLLP_FRAME_TOO_LARGE"
```

On a server, set it through `framing: { maxFrameSizeBytes }`.

## Log warnings without the payload

A warning carries a `code`, the `byteOffset` in the stream where the deviation was found, the
`connectionId` (on a server or client) and a `timestamp`. Log those. The `message` of two codes,
`MLLP_MISSING_LEADING_VT` and `MLLP_FS_WITHOUT_CR`, includes the one byte found where a framing byte
was expected, which on an unframed stream is the first byte of the message; if your logs may hold
no message content at all, leave `message` out.
