---
id: quickstart
title: Quickstart
sidebar_position: 1
---

# Quickstart

`@cosyte/mllp` is **transport, not parsing**: it frames HL7 v2 bytes onto the wire, correlates the
ACK that comes back, and never inspects the payload. The core primitive is the frame — `VT + payload
+ FS + CR` — and everything else (the client, the server, reconnect, TLS) is built on it. This page
starts there, then shows the client and server you will actually deploy.

## Frame a message, read it back

`encodeFrame` wraps a payload in the canonical MLLP envelope; `FrameReader` de-frames a byte stream
back into payloads. The encoder is **strict** — it always emits `VT + payload + FS + CR` — and the
reader hands each complete payload to `onFrame`, regardless of how the bytes were chunked on the
wire:

```ts runnable
import { encodeFrame, FrameReader } from "@cosyte/mllp";

// A synthetic HL7 v2 message — bytes the transport carries and never reads.
const payload = Buffer.from("MSH|^~\\&|SEND|FAC|RECV|FAC|20260717||ADT^A01|MSG00001|P|2.5");

const frame = encodeFrame(payload);

// Canonical framing: <VT> … <FS> <CR>.
frame[0]; // => 0x0b
frame[frame.length - 2]; // => 0x1c
frame[frame.length - 1]; // => 0x0d

// Feed the framed bytes back through a reader; the payload comes out byte-for-byte.
let received;
new FrameReader({ onFrame: (p) => (received = p) }).push(frame);

received.equals(payload); // => true
```

The payload round-trips **exactly** — the transport adds and strips three delimiter bytes and
changes nothing in between. What those bytes *mean* is the HL7 parser's job, not this package's.

## Tolerate a real sender's quirks — loudly

Real senders drop the leading `<VT>`, append a stray `<LF>`, or pad with whitespace. A bare
`FrameReader` is **strict by default**; you opt in to each tolerance flag by flag, and every
tolerated deviation surfaces as a warning with a **stable code** rather than passing silently
(Postel's Law):

```ts runnable
import { FrameReader } from "@cosyte/mllp";

// A sender padded the frame with a leading space before <VT>.
const padded = Buffer.from([0x20, 0x0b, 0x41, 0x1c, 0x0d]); // SP, VT, "A", FS, CR

const codes = [];
const reader = new FrameReader({
  onFrame: () => {},
  onWarning: (w) => codes.push(w.code),
  allowLeadingWhitespace: true, // opt in to tolerate the padding
});
reader.push(padded);

codes.includes("MLLP_LEADING_WHITESPACE"); // => true
```

The warning codes are a **public, versioned contract** — log pipelines key on them, so renaming one
is a breaking change. `MllpServer` ships tolerant defaults because it is the side that must accept
what real senders emit; see [Framing & tolerance](./framing.md) for the flag-by-flag table.

## The encoder refuses an unframable payload

MLLP is **not byte-transparent**: the delimiters are literal byte values, so a payload must not
itself contain `0x0B` (`<VT>`) or `0x1C` (`<FS>`). Rather than emit a frame a peer would mis-split,
the strict encoder throws:

```ts runnable throws
import { encodeFrame } from "@cosyte/mllp";

// The payload contains a raw <FS> (0x1C) — it cannot be framed unambiguously.
encodeFrame(Buffer.from([0x41, 0x1c, 0x42])); // throws MllpFramingError (MLLP_PAYLOAD_CONTAINS_FS)
```

That is why a payload's charset matters to the transport: UTF-16/UTF-32 put those bytes inside
ordinary characters. Use a single-byte encoding, UTF-8, or Shift_JIS — see
[Known limitations](./limitations.md).

## Send a message over a connection

On a real link, `createStarterClient` is the batteries-included path (auto-reconnect on, sensible
backoff and backpressure). `send()` resolves with **the ACK correlated to your message**, not with
whatever bytes arrive next:

```ts
import { createStarterClient } from "@cosyte/mllp";

await using client = await createStarterClient({ host: "127.0.0.1", port: 2575 });

const ack = await client.send(Buffer.from(rawHl7)); // resolves on the correlated ACK frame
// Pass an AbortSignal to bound any await; the client is disposed on scope exit.
```

`send` never resolves without its ACK, so a message can never silently "deliver". Reconnects,
backoff, and backpressure are handled for you. See
[Connection, reconnect & backpressure](./reliability.md).

## Receive messages — with the commit contract

Server-side, pair `autoAck: 'AA'` with an `onMessage` handler and the server treats your handler
**as** the durable-commit step: it awaits it, and only then acknowledges — `AA` on success, a
**negative** code if your handler throws. A positive ACK can never precede a successful commit:

```ts
import { createServer } from "@cosyte/mllp";

const server = createServer({
  autoAck: "AA",
  onMessage: async (payload, meta) => {
    // `payload` is a raw Buffer — charset decoding stays with you.
    await db.commit(payload); // throw here ⇒ AE (a resend may succeed), never AA
  },
});
await server.listen(2575, "127.0.0.1");
```

This is the page to internalize before you put the package in front of a clinical system — read
[ACKs & the commit contract](./acks.md) next.

> **About runnable examples.** The blocks tagged ` ```ts runnable ` above are extracted by the docs
> build, executed against the package, and their `// =>` results asserted — so a documented example
> can never silently drift from the code. They stay at the framing layer because it runs
> deterministically in-process; the client/server blocks open real sockets, so they are shown as
> plain ` ```ts ` illustrations. For socket-free *integration* tests, the `@cosyte/mllp/testing`
> subpath's in-memory transport wires a `Connection` end-to-end with no ports and no certs.

## Next

- [Framing & tolerance](./framing.md) — the wire format, the opt-in tolerance flags, and the stable
  warning-code registry.
- [ACKs & the commit contract](./acks.md) — the page to read before a clinical deployment.
- [Connection, reconnect & backpressure](./reliability.md) — the 6-state machine, backoff, and load
  shedding.
- [Known limitations & non-goals](./limitations.md) — what *not* to trust this transport to do.
