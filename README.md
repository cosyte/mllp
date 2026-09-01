<a href="https://cosyte.com">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://cosyte.com/tile/cosyte-lockup-tile-on-dark-1200x300.png">
    <img alt="The Cosyte logo on its own white ground: the icon beside the word Cosyte." src="https://cosyte.com/tile/cosyte-lockup-tile-on-light-1200x300.png">
  </picture>
</a>

# @cosyte/mllp

> HL7 v2 over MLLP for Node.js, with framing, ACK correlation and reconnects handled for you.

[![npm version](https://img.shields.io/npm/v/@cosyte/mllp.svg)](https://www.npmjs.com/package/@cosyte/mllp)
[![CI](https://img.shields.io/github/actions/workflow/status/cosyte/mllp/ci.yml?branch=main&label=CI)](https://github.com/cosyte/mllp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

Production-grade MLLP client and server for Node.js, transport-only sibling to @cosyte/hl7

## Contents

- [Why this exists](#why-this-exists)
- [Status](#status)
- [Install](#install)
- [Usage](#usage)
- [PHI and safety](#phi-and-safety)
- [API](#api)
- [Compatibility](#compatibility)
- [Contributing](#contributing)
- [Trademarks](#trademarks)
- [License](#license)

## Why this exists

HL7 v2 interfaces still move over MLLP, and the protocol stops at the frame: `VT + payload + FS + CR`
and nothing else. Everything that decides whether an interface survives a bad night is left to the
integrator, so every team writes the same acknowledgement correlator, the same reconnect loop and the
same backpressure guard, and one of them is subtly wrong. The nearest alternative is a full
integration engine such as Mirth Connect, which brings a runtime, a database and a deployment story
you may not want inside a Node.js service. `@cosyte/mllp` is that transport on its own: a library you
import, with zero runtime dependencies, an in-memory transport so your tests never open a socket, and
one guarantee it will not trade away, which is that a positive acknowledgement cannot precede a
durable commit.

## Status

**This README describes `0.1.0`.** The public API is settled and safe to depend on: the client, the
server, the framing codec, the in-memory transport and the optional `ack-from-hl7` bridge are what
this release commits to. The stable warning codes and security-warning codes are part of that
surface, so renaming or removing one is a breaking change.

Named rather than implied, here is what is still moving:

- **Batch acknowledgement is not built.** An HL7 batch envelope (`FHS`/`BHS`, HL7 v2.5.1 §2.10.3) or
  a frame carrying more than one `MSH` yields a warned, non-positive `AE`. That is deliberate, since
  a positive acknowledgement correlated to the first message would tell the sender a whole batch was
  accepted while the rest went unread, but it means the surface that would carry batch support does
  not exist yet.
- **Verified engine coverage is a growing list, not a complete one.** The differential harness runs
  against freely available engines only. See [Compatibility](#compatibility) for who is in it and who
  is not.
- **MLLP Release 2 is not spoken**, and no option selects it.

## Install

```bash
# engines.node: >=22.0.0    packageManager: pnpm@10.0.0
# published dual: ESM (import) and CJS (require), each with its own type declarations
pnpm add @cosyte/mllp

# optional peer, needed only for the ack-from-hl7 subpath
pnpm add @cosyte/hl7
```

## Usage

Start a server. Auto-ACK is on by default, and the server awaits your handler, which is the durable
commit step, before it answers.

```ts
import { createStarterServer } from "@cosyte/mllp";

const server = await createStarterServer({
  port: 2575,
  onMessage: async (payload) => {
    await db.commit(payload); // a throw here answers AE, never AA
  },
});
```

Send a message and read the acknowledgement the server built. The payload API is **Buffer-first**
everywhere: HL7 v2 messages are raw bytes with caller-managed charset decoding.

```ts
import { createStarterClient } from "@cosyte/mllp";

const client = await createStarterClient({ host: "127.0.0.1", port: 2575 });

const ack = await client.send(
  Buffer.from(
    "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVING_APP|RECEIVING_FAC|20260101120000||ADT^A01|CTRL0001|P|2.5.1\r",
  ),
);

console.log(ack.toString("utf8").split("\r").join("\n"));
```

```text
MSH|^~\&|RECEIVING_APP|RECEIVING_FAC|SENDING_APP|SENDING_FAC|20260831191657||ACK|96184dbca807488c8583|P|2.5.1
MSA|AA|CTRL0001
```

`MSH-7` and the acknowledgement's own `MSH-10` change on every run. `MSA|AA|CTRL0001` is the part to
read: `MSA-2` echoes the control id you sent, byte for byte, which is what lets the client match the
answer to the message.

### Framing on its own

`encodeFrame` and `FrameReader` are exported so you can frame and unframe without a socket. The
reader is a stateful decoder: feed it whatever TCP hands you, and complete frames fire on `onFrame`.

```ts
import { encodeFrame, FrameReader } from "@cosyte/mllp";

const payload = Buffer.from(
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVING_APP|RECEIVING_FAC|20260101120000||ADT^A01|CTRL0001|P|2.5.1\r",
);

const frame = encodeFrame(payload);
console.log(frame.subarray(0, 3).toString("hex"), frame.subarray(-2).toString("hex"));
console.log("frame", frame.length, "payload", payload.length);

const reader = new FrameReader({
  onFrame: (bytes, byteOffset, warnings) => {
    console.log("onFrame at", byteOffset, bytes.length, "bytes,", warnings.length, "warnings");
  },
});

reader.push(frame.subarray(0, 10)); // partial chunk: nothing fires
reader.push(frame.subarray(10)); // completes the frame
```

```text
0b4d53 1c0d
frame 105 payload 102
onFrame at 0 102 bytes, 0 warnings
```

`0b` is the leading `VT`, `1c0d` the trailing `FS CR`, and the three framing bytes are the whole
difference between 105 and 102.

### The commit contract

A positive acknowledgement (`AA`) tells the sender _"you may forget this message. I have it."_ So a
receiver must never send one before the message is durably handled, or the message is silently lost.
`@cosyte/mllp` makes that structural: pair `autoAck: 'AA'` with an `onMessage` handler and the server
**awaits your handler and only then acknowledges**.

Handler resolves, you get `AA`, **unless the inbound could not carry a correlatable positive
acknowledgement** (no readable `MSH`, an empty `MSH-10`, a batch or concatenated payload, or trailing
bytes the framer discarded). In that case the commit still happened, but the acknowledgement is
downgraded to `AE` and a `nack` event names the reason, because a positive acknowledgement the sender
cannot match is one it will resend. Handler throws, you get `AE`, or `AR` via `MllpAckError`.
`autoAck: 'AA'` _without_ a handler is documented as a transport-accept: "received and framed", not
"processed".

### Transport security (MLLPS)

TLS is built on `node:tls`: no bundled TLS, no extra dependency. Certificate verification is **on by
default**, the server binds `127.0.0.1` by default, and binding all interfaces needs an explicit
`allowWildcardBind: true`.

```ts
import { createServer, createClient } from "@cosyte/mllp";

// Server: mutual TLS (IHE ATNA ITI-19)
const server = createServer({
  tls: { cert: certPem, key: keyPem, ca: clientCaPem, clientAuth: "MUST" },
});
await server.listen(2575, "127.0.0.1");

// Client: verify the peer, and present a certificate of our own
const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem, cert: clientCertPem, key: clientKeyPem },
});
```

The [TLS guide](https://github.com/cosyte/mllp/blob/main/docs-content/tls.md) has the `ClientAuth`
table, the TLS 1.2 floor (IHE ATNA ITI-19), the typed failure modes (`tls-verify` against
`tls-handshake`), and the bind-safety details.

## PHI and safety

An MLLP frame carries an HL7 v2 message, and an HL7 v2 message carries patient data. This package is
the transport under that traffic, so what it does with those bytes is a safety property rather than a
footnote.

**What it does with your payload.** It moves the buffer you hand it to the peer and hands the peer's
bytes back to your handler. It holds a message in memory only while that message is in flight: from
`send()` until its acknowledgement is correlated, or until `close()` drains it or reports it
unresolved.

**The one read it performs, and where that read stops.** This package does not parse HL7, but it is
not blind to the payload either, and the bound is worth more to you than the slogan. To answer a
message it has to correlate the answer, so it locates the `MSH` segment and reads the header fields
an acknowledgement is built from: `MSH-10`, echoed byte for byte into `MSA-2`, the sending and
receiving application and facility, which swap sides in the reply, and the declared delimiters,
processing id and version. **That scan is bounded at the `MSH` segment's own terminator**, so no
field of any later segment is reachable: `PID` and everything after it is never read, never decoded
and never echoed. It is one scan, in one place, shared by the client's correlator and both
acknowledgement builders. Separately, the leading identifier of each segment is checked so that a
batch envelope or a second `MSH` can be refused rather than falsely acknowledged; no field of those
segments is read.

**What it does not do.** It does not parse the message, and outside the bounded `MSH` read above it
does not inspect it. It writes nothing to disk: there is no queue, no write-ahead log, no replay
store and no cache anywhere in this package. Library code calls no logger and no `console` method.

**What its diagnostics can carry.** Shape rather than content: no error, warning, event payload or
stats object ever echoes a run of message content.

- A **framing error** carries at most the single byte at the structural violation, plus that byte's
  offset.
- A **warning message** carries structural facts: byte offsets, counts and accumulated sizes. Two
  framing codes are the exception worth knowing about. `MLLP_MISSING_LEADING_VT` and
  `MLLP_FS_WITHOUT_CR` render the hex of the single byte found where a framing byte was expected,
  and on a stream that omits its leading `VT` that byte is the first byte of the unframed content.
  One byte, never a run, the same bound a framing error carries. If that is more than your threat
  model allows, log `code` and `byteOffset` rather than `message`.
- The **acknowledgement-correlation diagnostics** are stricter. Their text comes from a frozen
  registry keyed on the code alone, with no value parameter anywhere in it, so a control id cannot
  reach one; they report byte lengths instead of bytes.
- `getStats()` returns plain JSON-serialisable counters, and the two security warnings raised
  through `process.emitWarning` carry their code and a fixed description. The wildcard-bind warning
  names the address you bound, which is your own configuration, never message content.

**What you still own.**

- **Encryption in transit.** A plain MLLP connection is cleartext on the wire. TLS is built in, but
  you have to turn it on and supply the material.
- **Logging and retention.** The moment you log a payload, an acknowledgement body or a control id,
  it is yours to protect. Nothing here stores a message, so nothing here can delete one on request
  either.
- **Idempotency.** MLLP plus an acknowledgement is at-least-once at best. De-duplicate on `MSH-10`
  plus `MSH-7` in your application.
- **Exposure.** The `127.0.0.1` default and the wildcard-bind opt-in are guardrails, not a network
  policy. Widening either is your decision.

Every example on this page uses placeholder application and facility names and a synthetic control
id. No sample here carries a name, a date of birth, an identifier or an address, and none should.

## API

Three code subpaths ship, plus `@cosyte/mllp/package.json`:

- **`@cosyte/mllp`** is the whole transport: `createServer` and `createStarterServer`, `createClient`
  and `createStarterClient`, `encodeFrame` and `FrameReader`, `Connection`, `buildRawAck`, the typed
  errors, and the differential harness (`runDifferential`).
- **`@cosyte/mllp/testing`** is `InMemoryTransport`, a deterministic socket-free test double. Every
  test that can run over it should.
- **`@cosyte/mllp/ack-from-hl7`** builds acknowledgements from parsed messages, and is the one place
  the optional `@cosyte/hl7` peer is needed.

What comes with them:

- **Strict framing** (`VT + payload + FS + CR`), acknowledgement correlation, auto-reconnect with
  backoff, and backpressure.
- **A lenient decoder and a strict encoder** (Postel's Law) with **11 stable warning codes** carrying
  byte offsets. Tolerance is opt-in per flag; the server ships tolerant defaults.
- **An explicit 6-state connection machine**
  (`CONNECTING | CONNECTED | DRAINING | RECONNECTING | DISCONNECTED | CLOSED`) with `stateChange`
  events, never socket flags.
- **`AbortSignal` on every awaitable** and `Symbol.asyncDispose` on every closeable.
- **A drain on `close()`** that tells a message which was never written apart from one whose fate is
  unknown, because only one of those is safe to resend.
- **Zero runtime dependencies.** Node stdlib only.

Full reference: [the documentation](https://github.com/cosyte/mllp/tree/main/docs-content).

## Compatibility

- **Node.js 22 and 24.** `engines.node` is `>=22.0.0` and CI runs both.
- **HL7 v2 payloads are bytes here, with one bounded exception.** This package does not parse HL7.
  It reads the `MSH` header its acknowledgement is built from and stops at that segment's
  terminator, which [PHI and safety](#phi-and-safety) sets out in full. For actual parsing, pair it
  with [`@cosyte/hl7`](https://github.com/cosyte/hl7), which is exactly what the `ack-from-hl7`
  subpath does.
- **Differentially verified against freely available engines**: Mirth Connect from NextGen, and the
  Google Cloud Healthcare MLLP adapter. **Epic and Cerner are not part of that harness**, and no
  claim about either is made here. `runDifferential` ships in the published artifact, so you can aim
  it at your own test or staging endpoint and get a per-exchange frame-parity and `MSA-2` correlation
  report for the engine you actually integrate with.
- **Known gaps, stated rather than hidden.** No batch acknowledgement, no MLLP Release 2, no queue or
  replay of unacknowledged messages, no clinical acceptance decision, and no PKI. The
  [known limitations](https://github.com/cosyte/mllp/blob/main/docs-content/limitations.md) page is
  the full list. Read it before you depend on this.

## Contributing

Questions, bug reports and interoperability findings belong in
[GitHub issues](https://github.com/cosyte/mllp/issues). Pull requests are welcome, and there is a gap
worth naming: this repository carries no contributor guide yet, so open an issue before a large
change so the approach can be agreed first.

A contribution must clear every gate this repository ships, all of them scripts you can run yourself:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm format:check
pnpm check:no-emdash
pnpm check:no-internal-refs
pnpm check:agent-notes
pnpm phi-scan
pnpm build
pnpm changeset   # every meaningful change carries one
```

Never commit real patient data, in a test fixture or anywhere else. `pnpm phi-scan` runs on every
commit and is deliberately hard to bypass.

## Trademarks

Epic, Cerner, Mirth Connect, NextGen, and Google Cloud Healthcare are trademarks of their respective
owners. cosyte is not affiliated with, endorsed by, or sponsored by any of them. The names identify
the engines this package is tested against, and those it is not. See
[TRADEMARKS.md](./TRADEMARKS.md).

## License

MIT, Copyright (c) 2026 Cosyte. See [LICENSE](./LICENSE).
