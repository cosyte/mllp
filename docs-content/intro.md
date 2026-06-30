---
id: intro
title: Getting started
sidebar_position: 1
---

# @cosyte/mllp

A production-grade MLLP client and server for Node.js — the transport-only sibling to
`@cosyte/hl7`. It moves HL7 v2 messages over TCP and gives you the parts the spec leaves to you:
canonical framing (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff,
backpressure, TLS, and an in-memory transport so your tests never open a socket. Zero runtime
dependencies; Node stdlib only.

This package is transport, not parsing. It carries bytes and never inspects the payload — pair it
with `@cosyte/hl7` (or any parser) when you need to read fields. The `ack-from-hl7` subpath is the
one optional bridge between the two.

## Install

```bash
npm install @cosyte/mllp
```

`@cosyte/hl7` is an **optional** peer dependency — install it only if you use the `ack-from-hl7`
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

`send` resolves with the ACK frame the remote returns, matched back to your message — not just the
next bytes off the wire. Reconnects, backoff, and backpressure are handled for you; pass an
`AbortSignal` to bound any await.

## Receive messages

```ts
import { MllpServer } from "@cosyte/mllp";

const server = new MllpServer({ port: 2575 });
server.on("message", async ({ payload, respond }) => {
  await respond(buildAck(payload)); // you own the ACK bytes
});
await server.listen();
```

The server frames and de-frames for you; you decide what to send back. The payload is a raw
`Buffer` — charset decoding stays with the caller.

## Fail-safe ACKs — the commit contract

A positive acknowledgement (`AA`) tells the sender "you may forget this message — I have it." So a
server must **never** emit `AA` before the message is durably handled. `@cosyte/mllp` makes that
structural: pair `autoAck: 'AA'` with an `onMessage` handler, and the server **awaits your handler
(the durable-commit step) and only then ACKs** — `AA` on success, a **negative** code on failure,
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
- **Handler throws / rejects ⇒ `AE`** (application error — the sender may resend).
- **Handler throws `MllpAckError({ ackCode: 'AR' })` ⇒ `AR`** (application reject — do not resend
  unchanged).

On failure the server emits a PHI-safe `'nack'` event carrying only `{ connectionId, ackCode }` — the
payload and the thrown error's message (which may carry PHI) never reach the wire or the event.

`autoAck: 'AA'` **without** an `onMessage` handler degrades to a **transport-accept**: `AA` means
"bytes received and framed", not "application-processed" — only safe when a downstream component owns
durability. For full control, pass `autoAck: fn` to build the ACK bytes yourself, or omit `autoAck`
for manual mode (`respond()` / `conn.send()`).

## Framing and tolerance

The encoder is strict: it always emits canonical `VT + payload + FS + CR`. The decoder is liberal —
real-world senders drop the leading `VT`, append a stray `LF`, or pad with whitespace — and surfaces
each deviation as a warning with a **stable code** and byte offset rather than failing the frame
(Postel's Law). Codes such as `MLLP_MISSING_LEADING_VT` and `MLLP_TRAILING_BYTES` are part of the
public API. Accumulators are bounded: frames past `maxFrameSizeBytes` (16 MB default) throw
`MLLP_FRAME_TOO_LARGE` instead of growing unbounded.

## Testing without sockets

```ts
import { MllpClient, MllpServer } from "@cosyte/mllp";
import { createInMemoryTransport } from "@cosyte/mllp/testing";

const { client: clientTransport, server: serverTransport } = createInMemoryTransport();
```

The in-memory transport is a first-class deliverable from the `@cosyte/mllp/testing` subpath.
Wire a client and server together in-process — deterministic, no ports, no certs — and reserve real
sockets for integration smoke tests.

## ACK from an HL7 message

The optional `ack-from-hl7` subpath builds a spec-correct ACK from an inbound HL7 v2 message,
echoing the original `MSH` control id. It is the only place this package touches `@cosyte/hl7`:

```ts
import { ackFromHl7 } from "@cosyte/mllp/ack-from-hl7";

server.on("message", async ({ payload, respond }) => {
  await respond(ackFromHl7(payload)); // requires the @cosyte/hl7 peer dep
});
```

## Next

- Read the **API reference** for every export, generated from source.
- For parsing the payloads this transport carries, see **`@cosyte/hl7`**.
