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

## What's in the box

- **Client + server** with strict MLLP framing (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff, and backpressure.
- **Explicit 6-state connection machine** (`CONNECTING | CONNECTED | DRAINING | RECONNECTING | DISCONNECTED | CLOSED`) with `stateChange` events — never socket flags.
- **Lenient decoder, strict encoder** (Postel's Law) with **11 stable warning codes** carrying byte offsets.
- **TLS** support; `AbortSignal` on every awaitable and `Symbol.asyncDispose` on every closeable.
- **In-memory transport** (`@cosyte/mllp/testing`) — a deterministic, socket-free test double for fast, reliable tests.
- **`@cosyte/hl7` as an optional peer** — the `@cosyte/mllp/ack-from-hl7` subpath builds ACKs from parsed messages when it's installed.

## License

MIT
