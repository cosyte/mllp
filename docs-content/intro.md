---
id: intro
title: Getting started
sidebar_position: 1
---

# @cosyte/mllp

A production-grade MLLP client and server for Node.js: the transport-only sibling to
`@cosyte/hl7`. It moves HL7 v2 messages over TCP and gives you the parts the spec leaves to you:
canonical framing (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff,
backpressure, TLS, and an in-memory transport so your tests never open a socket. Zero runtime
dependencies; Node stdlib only.

This package is transport, not parsing. It carries bytes and never inspects the payload. Pair it
with `@cosyte/hl7` (or any parser) when you need to read fields. The `ack-from-hl7` subpath is the
one optional bridge between the two.

## Install

```bash
npm install @cosyte/mllp
```

`@cosyte/hl7` is an **optional** peer dependency. Install it only if you use the `ack-from-hl7`
subpath:

```bash
npm install @cosyte/hl7
```

## Send a message

```ts
import { MllpClient } from "@cosyte/mllp";

const client = new MllpClient({ host: "127.0.0.1", port: 2575 });
await client.connect();

const ack = await client.send(Buffer.from(rawHl7)); // resolves on the correlated ACK frame
await client[Symbol.asyncDispose]();
```

`send` resolves with the ACK frame the remote returns, matched back to your message, not just the
next bytes off the wire. Reconnects, backoff, and backpressure are handled for you; pass an
`AbortSignal` to bound any await.

## Receive messages

```ts
import { createServer } from "@cosyte/mllp";

const server = createServer({
  onMessage: (payload, meta) => {
    // Each inbound message, de-framed for you. `payload` is a raw Buffer.
    // Charset decoding stays with the caller. How you acknowledge is next.
    route(payload);
  },
});
await server.listen(2575, "127.0.0.1");
```

The server frames and de-frames for you; you decide what to send back. The payload is a raw
`Buffer`. Charset decoding stays with the caller. The `'message'` event and the `onMessage`
callback always fire **before** any ACK is sent.

## Fail-safe ACKs: the commit contract

A positive acknowledgement (`AA`) tells the sender "you may forget this message. I have it." So a
server must **never** emit `AA` before the message is durably handled. `@cosyte/mllp` makes that
structural: pair `autoAck: 'AA'` with an `onMessage` handler, and the server **awaits your handler
(the durable-commit step) and only then ACKs**: `AA` on success, a **negative** code on failure,
never `AA` before commit.

```ts
const server = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    await db.commit(payload); // throw here ⇒ AE (resend may succeed), never AA
  },
});
```

- **Handler resolves ⇒ `AA`** (HL7 Table 0008), echoing the inbound `MSH-10` into `MSA-2`.
- **Handler throws / rejects ⇒ `AE`** (application error, the sender may resend).
- **Handler throws `MllpAckError({ ackCode: 'AR' })` ⇒ `AR`** (application reject, do not resend
  unchanged).

On failure the server emits a PHI-safe `'nack'` event carrying only `{ connectionId, ackCode }`. The
payload and the thrown error's message (which may carry PHI) never reach the wire or the event.

`autoAck: 'AA'` **without** an `onMessage` handler degrades to a **transport-accept**: `AA` means
"bytes received and framed", not "application-processed": only safe when a downstream component owns
durability. For full control, pass `autoAck: fn` to build the ACK bytes yourself, or omit `autoAck`
for manual mode (`respond()` / `conn.send()`).

## Framing and tolerance

The encoder is strict: it always emits canonical `VT + payload + FS + CR`. The decoder is liberal
where you let it be: real-world senders drop the leading `VT`, append a stray `LF`, or pad with
whitespace, and each tolerated deviation surfaces as a warning with a **stable code** and byte offset
rather than failing the frame (Postel's Law). Codes such as `MLLP_MISSING_LEADING_VT` and
`MLLP_TRAILING_BYTES` are part of the public API.

Note that **tolerance is opt-in**: a bare `FrameReader` is *strict* by default, while `MllpServer`
ships tolerant defaults (`allowFsOnly`, `allowLfAfterFs`, `allowLeadingWhitespace`) because it is the
side that must accept what real senders emit. Accumulators are bounded: frames past
`maxFrameSizeBytes` (16 MB default) throw `MLLP_FRAME_TOO_LARGE` instead of growing unbounded.

See [Framing & tolerance](./framing.md) for the flag-by-flag table and the full warning-code registry.

## Testing without sockets

```ts
import { Connection } from "@cosyte/mllp";
import { InMemoryTransport } from "@cosyte/mllp/testing";

// Two connected, in-process ends: a write to one delivers synchronously to the other.
const [clientSide, serverSide] = InMemoryTransport.pair();
const conn = new Connection({ transport: clientSide });
// Drive framing + ACK correlation deterministically against `serverSide`.
```

The in-memory transport is a first-class deliverable from the `@cosyte/mllp/testing` subpath.
Pair two ends with `InMemoryTransport.pair()` and hand one to a `Connection` (deterministic, no
ports, no certs) and reserve real sockets for integration smoke tests.

## ACK from an HL7 message

The optional `ack-from-hl7` subpath builds a spec-correct, MLLP-framed ACK from an inbound HL7 v2
message: a thin adapter over `@cosyte/hl7`'s `buildAck` (hl7 owns the ACK content and control
tables; this package frames and correlates). It is the only place this package touches
`@cosyte/hl7`, and the peer is loaded lazily on first call:

```ts
import { buildAckAA, buildAckAE } from "@cosyte/mllp/ack-from-hl7";

// After your handler durably commits the message (the commit contract):
const { frame, code, correlationId } = buildAckAA(payload); // requires the @cosyte/hl7 peer dep
socket.write(frame); // VT + ACK + FS + CR, MSA-2 echoes the inbound MSH-10 verbatim

// On a processing failure, never acknowledge what you did not commit:
socket.write(buildAckAE(payload, { error: { conditionCode: "207" } }).frame);
```

`buildMllpAck` is the core (explicit `code`); `buildAckAA/AE/AR/CA/CE/CR` are the six
Table-0008 conveniences; `detectMode` reports original-vs-enhanced from the inbound MSH-15/16.
Fail-safe by construction: an inbound without a findable MSH-10 **never** yields a positive
ACK. The disposition downgrades (`AA`→`AE`, `CA`→`CE`) and the result carries a warning
(`ACK_NO_CORRELATION_ID` from the peer, or `MLLP_ACK_INBOUND_UNPARSEABLE` when the inbound
could not be parsed at all). Warnings carry codes and structural context only, never message
content.

The builder's own limits (it trusts your disposition, MSA-2 is a canonical re-serialization rather
than the inbound's original bytes, and there is no enhanced-mode sequencing) are covered in
[ACKs & the commit contract](./acks.md).

## Next

- **[Framing & tolerance](./framing.md)**: the wire format, the opt-in tolerance flags, the stable
  warning codes, and the PHI contract on diagnostics.
- **[ACKs & the commit contract](./acks.md)**: the page to read before you put this in front of a
  clinical system.
- **[Connection, reconnect & backpressure](./reliability.md)**: the 6-state machine, backoff,
  dead-peer detection, and load shedding.
- **[MLLPS / TLS](./tls.md)**: mutual TLS, the ATNA TLS 1.2 floor, bind safety.
- **[Known limitations & non-goals](./limitations.md)**: what *not* to trust this package to do.
  Read it before you depend on it.
- The **API reference** for every export, generated from source.
- For parsing the payloads this transport carries, see **`@cosyte/hl7`**.
