# @cosyte/hl7-mllp — v1 Requirements

All requirements are user-facing behaviors a developer consuming `@cosyte/hl7-mllp` can verify. REQ-IDs are stable across phases and referenced from `ROADMAP.md` for traceability.

---

## v1 Requirements

### Project Setup & Build (SETUP)

- [ ] **SETUP-01** — Developer can run `pnpm install && pnpm build && pnpm test` from a clean clone and all three succeed.
- [ ] **SETUP-02** — Package publishes as dual ESM + CJS with a correct `exports` map; consumers on either module system resolve the right entry point, plus optional subpath exports for `@cosyte/hl7-mllp/testing` (in-memory transport) and `@cosyte/hl7-mllp/ack-from-hl7` (parser-coupled ACK helpers).
- [ ] **SETUP-03** — Package has zero runtime `dependencies` in `package.json`. `@cosyte/hl7` is declared under `peerDependencies` with `peerDependenciesMeta.optional = true`; developers not using ACK helpers see no install warning.
- [ ] **SETUP-04** — TypeScript consumers get full IntelliSense (types, JSDoc, `@example` tags) on every public API surface.
- [ ] **SETUP-05** — Repo targets Node 18+ and compiles to ES2022 with `"strict": true` and `"noUncheckedIndexedAccess": true`.
- [ ] **SETUP-06** — `pnpm lint` and `pnpm typecheck` pass with zero warnings.

### Framing Codec (FRAME)

- [ ] **FRAME-01** — `encodeFrame(payload: Buffer): Buffer` wraps any payload in canonical `VT (0x0B) + payload + FS (0x1C) + CR (0x0D)` framing and returns the wrapped buffer.
- [ ] **FRAME-02** — `encodeFrame()` throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_VT')` or `MllpFramingError('MLLP_PAYLOAD_CONTAINS_FS')` when the payload would produce an ambiguous frame, unless `{ allowDelimiterBytesInPayload: true }` is set (in which case the bytes are preserved verbatim and a warning is returned for the caller to log).
- [ ] **FRAME-03** — Encoder never emits any variant of framing other than canonical `VT…FS+CR`; there is no option to loosen the emit path (Postel's Law: conservative emitter).
- [ ] **FRAME-04** — `FrameReader` accepts any sequence of `Buffer` chunks of any size — including chunks that split mid-payload, mid-delimiter, or across multiple frames — and yields complete payload `Buffer`s in the same order they were received.
- [ ] **FRAME-05** — `FrameReader` correctly handles N complete frames concatenated in a single chunk, 1 frame split across N chunks, leading/trailing bytes before the first VT, and back-to-back frames with zero bytes between them.
- [ ] **FRAME-06** — `FrameReader` carries an internal byte offset such that every warning and error includes the absolute stream position where the anomaly was detected.
- [ ] **FRAME-07** — Decoder tolerates `FS` without trailing `CR` when `{ allowFsOnly: true }`; emits `MLLP_FS_WITHOUT_CR` warning with byte offset.
- [ ] **FRAME-08** — Decoder tolerates `FS + LF` (instead of `FS + CR`) when `{ allowLfAfterFs: true }`; emits `MLLP_LF_AFTER_FS` warning.
- [ ] **FRAME-09** — Decoder tolerates a missing leading `VT` when `{ allowMissingLeadingVt: true }` (treats the first byte of the stream or first byte after a terminator as payload start); emits `MLLP_MISSING_LEADING_VT` warning.
- [ ] **FRAME-10** — Decoder tolerates leading whitespace (SP, TAB, LF, CR) before `VT` when `{ allowLeadingWhitespace: true }`; emits `MLLP_LEADING_WHITESPACE` warning with the count of bytes skipped.

### Warnings & Tolerance (WARN)

- [ ] **WARN-01** — Every tolerated framing deviation emits a frozen `MllpWarning` object: `{ code: string, message: string, byteOffset: number, connectionId: string, timestamp: Date }`.
- [ ] **WARN-02** — Warning codes are a stable, exported union type: `'MLLP_MISSING_LEADING_VT' | 'MLLP_FS_WITHOUT_CR' | 'MLLP_LF_AFTER_FS' | 'MLLP_LEADING_WHITESPACE' | 'MLLP_TRAILING_BYTES' | 'MLLP_PAYLOAD_CONTAINS_VT' | 'MLLP_PAYLOAD_CONTAINS_FS' | 'MLLP_EMPTY_PAYLOAD'`.
- [ ] **WARN-03** — A consumer subscribing to `onWarning` on either the client or the server receives every warning as it is emitted; the warning also appears in a per-connection `warnings` array accessible from lifecycle events.
- [ ] **WARN-04** — When a warning's tolerance is NOT enabled, the same condition throws `MllpFramingError` with the same stable code in place of a warning — Postel's Law for the encoder is strict; for the decoder, strictness is the default and tolerance is explicit.
- [ ] **WARN-05** — Trailing bytes between a `CR` terminator and the next `VT` (other than whitespace with `allowLeadingWhitespace`) emit `MLLP_TRAILING_BYTES` and are discarded; empty payloads between `VT` and `FS` emit `MLLP_EMPTY_PAYLOAD` and yield a zero-length `Buffer` to the consumer.
- [ ] **WARN-06** — A developer can pass `{ onWarning: fn }` at the server, client, or reader level; the handler receives the `MllpWarning` and the invocation is wrapped in try/catch so a throwing handler does not corrupt stream state.
- [ ] **WARN-07** — Each warning's `message` is stable human-readable text suitable for logs; it never contains payload bytes or secrets, only positional metadata.
- [ ] **WARN-08** — Enabling `{ strict: true }` at the reader/server/client level escalates every tolerated-deviation warning to a thrown `MllpFramingError` with the same stable code; strict mode does not affect `MLLP_TRAILING_BYTES` or `MLLP_EMPTY_PAYLOAD` alone (those remain warnings), but it does affect the leading-VT / FS-CR / LF-after-FS cases.

### Typed Errors (ERR)

- [ ] **ERR-01** — `MllpFramingError` is thrown for wire-format problems; carries `{ code: WarningCode, byteOffset: number, snippet: Buffer }` where `snippet` is the ≤ 64 bytes around the anomaly.
- [ ] **ERR-02** — `MllpTimeoutError` is thrown (or rejects the `send()` promise) when an ACK does not arrive within the configured timeout; carries `{ messageControlId: string | undefined, elapsedMs: number }`.
- [ ] **ERR-03** — `MllpConnectionError` is thrown (or emitted via `onError`) for socket-layer problems (connect refused, ECONNRESET, ETIMEDOUT, DNS failure); carries `{ cause: Error, phase: 'connect' | 'send' | 'receive' | 'close' }`.
- [ ] **ERR-04** — `MllpBackpressureError` is thrown (or rejects the `send()` promise) when the in-flight queue exceeds the high-water mark and `{ onBackpressure: 'reject' }` is configured; carries `{ queueDepth: number, highWaterMark: number }`.

### Transport Abstraction (TRANS)

- [ ] **TRANS-01** — Both the server and client accept a `Transport` interface, not a raw `net.Socket`; the default production transport wraps `net.Socket` and the default TLS transport wraps `tls.TLSSocket`.
- [ ] **TRANS-02** — `InMemoryTransport` (exported from `@cosyte/hl7-mllp/testing`) implements the same `Transport` interface: readable, writable, close, error, event-driven, supports `pair()` to create two ends connected back-to-back.
- [ ] **TRANS-03** — A developer can write a full round-trip test (client → server → ACK → client) using `InMemoryTransport.pair()` without opening any sockets; the suite runs deterministically with no timing assumptions.
- [ ] **TRANS-04** — `InMemoryTransport` supports simulated conditions: `split(bytesPerChunk)` forces chunked reads, `pause()/resume()` simulates backpressure, `destroy(reason)` simulates abrupt disconnect.

### Connection Lifecycle & State Machine (LIFE)

- [ ] **LIFE-01** — Every connection exposes a `state` property that is exactly one of `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'DISCONNECTED'`; transitions are observable via a `'stateChange'` event with `{ from, to, reason }`.
- [ ] **LIFE-02** — `CONNECTING → CONNECTED` fires once after TCP handshake (or TLS handshake for TLS transports); `CONNECTED → DRAINING` fires on graceful close requests; `DRAINING → DISCONNECTED` fires after in-flight messages resolve; any state → `DISCONNECTED` fires on error or destroy.
- [ ] **LIFE-03** — Lifecycle events are fired in a consistent order: `onConnect` (once, on `CONNECTED`), `onMessage` (per framed message), `onAck` (client-side per received ACK), `onWarning` (per warning), `onError` (per non-recoverable error), `onDisconnect` (once, on `DISCONNECTED`).
- [ ] **LIFE-04** — Every connection has a stable `connectionId: string` (UUIDv4 or ULID-compatible) that is present on every event payload, every warning, and every error emitted by that connection.
- [ ] **LIFE-05** — Calling `close()` during `CONNECTING` cancels the connect attempt without leaking timers; calling `close()` during `CONNECTED` transitions to `DRAINING` and resolves when in-flight ACK-waiters complete or the drain timeout elapses.

### MLLP Server (SERVER)

- [ ] **SERVER-01** — `createServer(opts)` returns a server object; `server.listen(port, host?)` resolves when the underlying socket is listening; `server.close()` resolves after all active connections reach `DISCONNECTED`.
- [ ] **SERVER-02** — `server.on('connection', (conn) => ...)` fires for every accepted connection; each `conn` is a `Connection` with the full state machine, events, and a `send(buffer)` method for writing framed ACKs or messages back.
- [ ] **SERVER-03** — `conn.on('message', (payload: Buffer, meta) => ...)` fires for every complete framed message; `payload` is the raw bytes between `VT` and `FS` (framing stripped); `meta` includes `{ connectionId, byteOffset, warnings: readonly MllpWarning[] }`.
- [ ] **SERVER-04** — A developer can enable auto-ACK mode (`{ autoAck: 'AA' | ((payload) => Buffer | Promise<Buffer>) }`) so the server responds to every inbound message without manual `conn.send()`; disabling auto-ACK (default) hands the developer full control.
- [ ] **SERVER-05** — Server-side `conn.send(buffer)` handles framing (wraps in `VT…FS+CR`) and returns a `Promise<void>` that resolves once the bytes are flushed to the kernel; respects the underlying socket's backpressure.
- [ ] **SERVER-06** — `server.close({ drainTimeoutMs })` triggers graceful shutdown: stops accepting new connections, allows in-flight messages and their ACKs to complete, forcibly closes any connection that does not drain within `drainTimeoutMs` (default: 30s).
- [ ] **SERVER-07** — Per-connection idle keepalive: if no bytes are received for `keepaliveIntervalMs` (default: off), the server either sends a TCP keepalive probe (`socket.setKeepAlive(true, ...)`) or closes the connection with `MllpConnectionError({ phase: 'receive', cause: new Error('idle timeout') })`, configurable.

### MLLP Client (CLIENT)

- [ ] **CLIENT-01** — `createClient(opts)` returns a client; `client.connect()` resolves on `CONNECTED` (after TCP / TLS handshake); `client.close()` resolves after drain.
- [ ] **CLIENT-02** — `client.send(payload: Buffer)` returns `Promise<Buffer>` that resolves with the inbound ACK's payload (framing stripped) or rejects with `MllpTimeoutError` / `MllpConnectionError` / `MllpBackpressureError`.
- [ ] **CLIENT-03** — ACK correlation: when the peer returns ACKs in-order on a single connection, `send()` resolves in FIFO order against outgoing sends. When `{ correlateByControlId: true }` is set, the client extracts MSH-10 from the outbound payload and matches it against MSA-2 on each inbound ACK, allowing out-of-order or interleaved ACK handling.
- [ ] **CLIENT-04** — `send()` honors a configurable per-message `ackTimeoutMs` (default: 30_000). On timeout, the promise rejects with `MllpTimeoutError`; the outbound message is not retried automatically.
- [ ] **CLIENT-05** — Auto-reconnect: when `{ autoReconnect: true }` is set and the connection drops unexpectedly, the client transitions `DISCONNECTED → CONNECTING` after an exponential-backoff delay (`initialDelayMs: 100`, `maxDelayMs: 30_000`, `multiplier: 2`, `jitter: 0.2`); the `'reconnecting'` event fires with the attempt number and next delay.
- [ ] **CLIENT-06** — During reconnection, queued sends continue to queue up to the high-water mark; sends rejected for backpressure include the current `state` and `queueDepth`. Setting `{ autoReconnect: false }` causes pending sends to reject with `MllpConnectionError` on disconnect.
- [ ] **CLIENT-07** — Backpressure: when the underlying transport's `write()` returns `false`, the client queues subsequent `send()` calls up to `highWaterMark` in-flight messages (default: 64). Behavior at overflow is configurable: `{ onBackpressure: 'reject' }` (default — throws `MllpBackpressureError`) or `{ onBackpressure: 'wait' }` (blocks until the queue drains).
- [ ] **CLIENT-08** — Idle keepalive + dead-peer detection: `keepaliveIntervalMs` (default: off) triggers TCP keepalive probes via `socket.setKeepAlive(true, ...)`; `{ deadPeerTimeoutMs }` (default: off) forcibly closes the connection (and triggers auto-reconnect if enabled) when no bytes have been received for that interval.
- [ ] **CLIENT-09** — `client.destroy()` is distinct from `client.close()`: `destroy()` abruptly terminates the socket regardless of in-flight work, rejects every pending `send()` with `MllpConnectionError({ phase: 'close' })`, and transitions directly to `DISCONNECTED`.

### ACK Helpers (ACK)

- [ ] **ACK-01** — `buildAckAA(parsedInbound)` returns a `Buffer` containing a valid HL7 v2 application-accept ACK with MSA-1 = `AA`, MSA-2 populated from the inbound MSH-10, and MSH-3..7 swapped from the inbound (sender ↔ receiver). Exported from `@cosyte/hl7-mllp/ack-from-hl7`.
- [ ] **ACK-02** — `buildAckAE(parsedInbound, err)` and `buildAckAR(parsedInbound, err)` return ACKs with MSA-1 = `AE` / `AR` respectively, MSA-3 populated with a human-readable error, and an ERR segment when structured details are provided.
- [ ] **ACK-03** — ACK helpers accept either a parsed `Hl7Message` from `@cosyte/hl7` (when the peer dep is installed) or a plain object `{ controlId, sendingApp, sendingFacility, receivingApp, receivingFacility, timestamp, version }` so the helper works without the peer dep for users who hand-parse MSH.
- [ ] **ACK-04** — `send()` with `{ awaitAck: false }` resolves on write-flush without waiting for an ACK; the default (`awaitAck: true`) requires an ACK within `ackTimeoutMs`.
- [ ] **ACK-05** — Raw ACK pass-through is always supported: a developer handling the `'message'` event can call `conn.send(rawAckBuffer)` with any `Buffer` they construct; the server never silently rewrites the caller's ACK payload.

### TLS (TLS)

- [ ] **TLS-01** — `createServer({ tls: {...tlsOptions} })` accepts an `http.Server`-compatible TLS options object (`key`, `cert`, `ca`, `requestCert`, `rejectUnauthorized`) and serves over `tls.createServer` instead of `net.createServer`.
- [ ] **TLS-02** — `createClient({ tls: {...tlsOptions} })` uses `tls.connect` instead of `net.connect`; accepts `host`, `port`, `servername` (SNI), `ca`, `cert`, `key`, `rejectUnauthorized`.
- [ ] **TLS-03** — TLS and non-TLS use the same `Transport` interface; the connection state machine and lifecycle events fire identically in both modes. `CONNECTING → CONNECTED` fires after the TLS handshake completes, not merely after TCP handshake.
- [ ] **TLS-04** — TLS handshake errors surface as `MllpConnectionError({ phase: 'connect', cause: <TLS error> })` with the original TLS error preserved in `cause`.

### Testing & Fixtures (TEST)

- [ ] **TEST-01** — `pnpm test --coverage` reports ≥ 90% line coverage on `src/framing/`, `src/server/`, and `src/client/`, with a green test suite.
- [ ] **TEST-02** — Canonical fixtures: round-trip test suite sends and receives an ADT^A01, ORU^R01, SIU^S12, MDM^T02, and a 1 MB synthetic payload across `InMemoryTransport`; every ACK matches by controlId; every send → ACK → close cycle completes within a bounded number of event-loop ticks.
- [ ] **TEST-03** — Chunked-read fixtures: for each canonical fixture, drive the decoder with every partition of the byte stream — all-in-one, 1-byte chunks, random chunk sizes, chunks that split `VT`, `FS`, and `CR` bytes mid-delimiter — and assert that the reader yields exactly one payload per frame with identical bytes.
- [ ] **TEST-04** — Tolerance fixtures: one fixture per warning code (`MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`); each one decodes with the matching tolerance opt-in and warns, and throws `MllpFramingError` with the same code under `{ strict: true }`.
- [ ] **TEST-05** — Lifecycle fixtures: a test spins up a server + client over `InMemoryTransport`, asserts the exact sequence of state transitions on both ends (`CONNECTING → CONNECTED → DRAINING → DISCONNECTED`), and asserts that `onConnect` / `onMessage` / `onAck` / `onDisconnect` fire in the correct order with stable `connectionId` on every event.
- [ ] **TEST-06** — Failure-mode fixtures: abrupt disconnect mid-frame, ACK timeout, ACK with mismatched controlId (under `correlateByControlId`), backpressure overflow, reconnect with queued sends — every case is covered by a deterministic test and yields the expected typed error.

### Examples & Documentation (DOCS)

- [ ] **DOCS-01** — `examples/server-basic/` is a standalone runnable TypeScript example (`pnpm start` from the example directory) that listens on a port, logs every inbound message, and auto-ACKs with `AA`.
- [ ] **DOCS-02** — `examples/client-basic/` is a standalone runnable TypeScript example that connects to `localhost:2575`, sends a hand-crafted HL7 message from a fixture, prints the ACK, and exits cleanly.
- [ ] **DOCS-03** — `examples/tls/` is a standalone runnable example that uses self-signed test certs (shipped in the example dir) and demonstrates mutual TLS between client and server.
- [ ] **DOCS-04** — README includes: a three-line "hello world" for both server and client at the top; a cookbook section (auto-ACK, manual ACK, reconnect, backpressure, TLS, in-memory testing); the full stable warning-code list with descriptions; a "what this package does not do" section pointing at `@cosyte/hl7` for parsing.
- [ ] **DOCS-05** — `pnpm publish --dry-run` produces a clean tarball with `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`; no test fixtures, examples, or source `.ts` files leak into the package; the tarball is inspected and documented in the Phase 8 summary.

---

## v2 / Deferred

- **Typed ACK builders per message type** — e.g., `buildAckA01(msg, disposition)` that understands trigger-specific field requirements. V1 ships generic ACK helpers only.
- **Structured message correlation beyond controlId** — e.g., time-windowed correlation, batch ACKs. V1 does FIFO by default and controlId-matching as an opt-in.
- **Connection pooling / multi-endpoint failover** — V1 ships single-endpoint client with auto-reconnect; pool abstractions are v2.
- **Persistent disk-backed outbound queue** — that is an integration engine, not MLLP.
- **Prometheus / OpenTelemetry adapters** — V1 exposes events; caller wires their observability.
- **Streaming `Readable<Buffer>` payload API** — V1 reads and emits whole payloads; streaming large payloads is v2.
- **Batch (FHS/BHS) framing awareness** — V1 frames individual messages; BHS awareness is v2.
- **Browser / Deno / Bun runtimes** — V1 targets Node 18+ only.

## Out of Scope (v1)

- **HL7 v2 parsing or serialization** — delegated to `@cosyte/hl7` peer dep.
- **HL7 v3, CDA, FHIR transports** — different protocols.
- **File-based batch ingestion** — not a transport concern.
- **Store-and-forward / persistent queue** — integration engine concern.
- **Routing / fan-out / transformation** — higher-level framework.
- **HTTP-based HL7** — rare; roadmap if demanded.
- **Built-in metrics backends** — expose events, caller wires their own.

---

## Traceability

Filled in by `ROADMAP.md` — each REQ-ID maps to exactly one phase.

| REQ-ID | Phase | Status |
|--------|-------|--------|
| SETUP-01..06 | Phase 1 | Pending |
| FRAME-01..10 | Phase 2 | Pending |
| WARN-01..08 | Phase 2 | Pending |
| ERR-01..04 | Phase 2 / 5 | Pending |
| TRANS-01..04 | Phase 3 | Pending |
| LIFE-01..05 | Phase 3 | Pending |
| SERVER-01..07 | Phase 4 | Pending |
| CLIENT-01..09 | Phase 5 | Pending |
| ACK-01..05 | Phase 6 | Pending |
| TLS-01..04 | Phase 6 | Pending |
| TEST-01..06 | Phase 7 | Pending |
| DOCS-01..05 | Phase 8 | Pending |
