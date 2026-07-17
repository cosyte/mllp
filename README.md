# @cosyte/mllp

> Send and receive HL7 v2 over a production-grade MLLP connection in a few lines — with framing, ACK correlation, auto-reconnect, and backpressure handled for you.

[![npm version](https://img.shields.io/npm/v/@cosyte/mllp.svg)](https://www.npmjs.com/package/@cosyte/mllp)
[![CI](https://img.shields.io/github/actions/workflow/status/cosyte/mllp/ci.yml?branch=main&label=CI)](https://github.com/cosyte/mllp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg)](https://nodejs.org)

A developer-focused MLLP (Minimal Lower Layer Protocol) client and server for Node.js and TypeScript. Transport-only sibling to [`@cosyte/hl7`](https://github.com/cosyte/hl7) (the parser): `@cosyte/mllp` moves the bytes, `@cosyte/hl7` reads them.

**Status: under active development. API not yet stable (`0.0.x`).**

---

## Quickstart

```bash
# pnpm (recommended) — also works with: npm install @cosyte/mllp  |  yarn add @cosyte/mllp
pnpm add @cosyte/mllp
```

```ts
import { createStarterServer } from "@cosyte/mllp";

// Echoes every received frame straight back as the ACK.
const server = await createStarterServer({ port: 2575, onMessage: (buf) => buf });
```

```ts
import { createStarterClient } from "@cosyte/mllp";

const client = await createStarterClient({ host: "localhost", port: 2575 });
const ack = await client.send(Buffer.from("MSH|^~\\&|..."));
```

The payload API is **Buffer-first** everywhere — HL7 v2 messages are raw bytes with caller-managed charset decoding.

## MLLPS / TLS

TLS is built on `node:tls` — no bundled TLS, no extra dependency. Certificate verification is **on
by default**; the server binds `127.0.0.1` by default and requires an explicit opt-in
(`allowWildcardBind: true`) to bind all interfaces.

```ts
// Server — plain TLS
const server = createServer({ tls: { cert: certPem, key: keyPem } });
await server.listen(2575, "127.0.0.1");

// Server — mutual TLS (ATNA ITI-19)
const server = createServer({
  tls: { cert: certPem, key: keyPem, ca: clientCaPem, clientAuth: "MUST" },
});
```

```ts
// Client
const client = createClient({ host: "mllp.example.com", port: 2575, tls: { ca: caPem } });

// Client — mutual TLS
const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem, cert: clientCertPem, key: clientKeyPem },
});
```

See the **MLLPS / TLS** doc for the `ClientAuth` table, the TLS 1.2 floor (IHE ATNA ITI-19), typed
failure modes (`tls-verify` vs `tls-handshake`), and bind-safety details.

## Fail-safe ACKs — the commit contract

A positive acknowledgement (`AA`) tells the sender *"you may forget this message — I have it."* So a
receiver must never send one before the message is durably handled, or the message is silently lost.
`@cosyte/mllp` makes that structural: pair `autoAck: 'AA'` with an `onMessage` handler and the server
**awaits your handler (the durable-commit step) and only then ACKs**.

```ts
const server = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    await db.commit(payload); // throw here ⇒ AE (resend may succeed), never AA
  },
});
```

Handler resolves ⇒ `AA`. Handler throws ⇒ `AE` (or `AR` via `MllpAckError`). **A positive ACK cannot
precede a successful commit.** `autoAck: 'AA'` *without* a handler is documented as a
transport-accept — "received and framed", not "processed".

## What's in the box

- **Client + server** with strict MLLP framing (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff, and backpressure.
- **The commit contract** — a positive ACK can never precede a durable commit; an unparseable inbound can never yield a positive ACK.
- **Explicit 6-state connection machine** (`CONNECTING | CONNECTED | DRAINING | RECONNECTING | DISCONNECTED | CLOSED`) with `stateChange` events — never socket flags.
- **Lenient decoder, strict encoder** (Postel's Law) with **11 stable warning codes** carrying byte offsets. Tolerance is opt-in per flag; the server ships tolerant defaults.
- **TLS (MLLPS)** — verification on by default, mutual TLS (`clientAuth: 'NONE' | 'WANT' | 'MUST'`), a TLS 1.2 floor per IHE ATNA ITI-19, and bind-safety guardrails (`127.0.0.1` default, wildcard binds require opt-in). `AbortSignal` on every awaitable and `Symbol.asyncDispose` on every closeable.
- **PHI-safe diagnostics** — no error, warning, event payload, or stats object ever echoes a *run* of message content; a framing error carries at most the single byte at the structural violation.
- **In-memory transport** (`@cosyte/mllp/testing`) — a deterministic, socket-free test double for fast, reliable tests.
- **`@cosyte/hl7` as an optional peer** — the `@cosyte/mllp/ack-from-hl7` subpath builds ACKs from parsed messages when it's installed.
- **Zero runtime dependencies.** Node stdlib only.

## What it deliberately does not do

MLLP + ACK is **at-least-once at best** — your application owns idempotency and de-duplication
(`MSH-10` + `MSH-7`). This package does not parse HL7 (use `@cosyte/hl7`), does not queue or replay
unacked messages, does not decide clinical acceptance, does not speak MLLP **Release 2**, and ships
no PKI. The full list is in the **Known limitations & non-goals** doc — read it before you depend on
this.

## Trademarks

Epic, Cerner, Mirth Connect, NextGen, and Google Cloud Healthcare are trademarks of their respective owners. cosyte is not affiliated with, endorsed by, or
sponsored by any of them — the names identify the engines this package is tested against, and those it is not. See [TRADEMARKS.md](./TRADEMARKS.md).

## License

MIT
