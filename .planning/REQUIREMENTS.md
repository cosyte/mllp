# @cosyte/hl7-mllp — v1 Requirements

All requirements are user-facing behaviors a developer consuming `@cosyte/hl7-mllp` can verify. REQ-IDs are stable across phases and referenced from `ROADMAP.md` for traceability.

**Post-research revision (2026-04-22):** 28 new REQ-IDs + 10 amendments accepted from the research-phase synthesis. No existing REQ-IDs were deleted or demoted.

---

## v1 Requirements

### Project Setup & Build (SETUP)

- [ ] **SETUP-01** — Developer can run `pnpm install && pnpm build && pnpm test` from a clean clone and all three succeed.
- [ ] **SETUP-02** — Package publishes as dual ESM + CJS with a correct `exports` map; consumers on either module system resolve the right entry point, plus subpath exports `@cosyte/hl7-mllp/testing` (in-memory transport) and `@cosyte/hl7-mllp/ack-from-hl7` (parser-coupled ACK helpers) each produce their own tree-shakeable bundle. `@arethetypeswrong/cli` is a CI publish-gate.
- [ ] **SETUP-03** — Package has zero runtime `dependencies` in `package.json`. `@cosyte/hl7` is declared under `peerDependencies` with `peerDependenciesMeta.optional = true`; developers not using ACK helpers see no install warning. The `@cosyte/hl7-mllp/ack-from-hl7` subpath is `external`'d from the main bundle so the peer is never pulled transitively.
- [ ] **SETUP-04** — TypeScript consumers get full IntelliSense (types, JSDoc, `@example` tags) on every public API surface.
- [ ] **SETUP-05** — Repo targets **Node 20+** and compiles to ES2022 with `"strict": true` and `"noUncheckedIndexedAccess": true`. `engines.node` is `">=20.0.0"`. _(Amended 2026-04-22 — Node 18 EOL 2025-04-30.)_
- [ ] **SETUP-06** — `pnpm lint` and `pnpm typecheck` pass with zero warnings.
- [ ] **SETUP-07** — ESLint rule forbids `Buffer.prototype.slice()` inside `src/framing/`, `src/server/`, and `src/client/`; call sites must use `.subarray()` (zero-copy). Rule is an `error`, not a `warn`. _(Prevents the `slice`-copies-in-modern-Node performance trap.)_

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
- [ ] **FRAME-11** — `FrameReader` enforces `maxFrameSizeBytes` (default 16 MB); accumulator overflow throws `MllpFramingError('MLLP_FRAME_TOO_LARGE')` with the byte offset at which the cap was reached. _(DoS prevention — the accumulator is otherwise unbounded.)_
- [ ] **FRAME-12** — Bytes-in / bytes-out round-trip fidelity: every byte value 0x00–0xFF plus a 1 MB random-byte corpus passes through the framing codec unchanged (excluding the `VT`/`FS` bytes which must be handled by FRAME-02). _(Proves the buffer-first promise at the test level.)_

### Warnings & Tolerance (WARN)

- [ ] **WARN-01** — Every tolerated framing deviation emits a frozen `MllpWarning` object: `{ code: string, message: string, byteOffset: number, connectionId: string, timestamp: Date }`.
- [ ] **WARN-02** — Warning codes are a stable, exported union type: `'MLLP_MISSING_LEADING_VT' | 'MLLP_FS_WITHOUT_CR' | 'MLLP_LF_AFTER_FS' | 'MLLP_LEADING_WHITESPACE' | 'MLLP_TRAILING_BYTES' | 'MLLP_PAYLOAD_CONTAINS_VT' | 'MLLP_PAYLOAD_CONTAINS_FS' | 'MLLP_EMPTY_PAYLOAD' | 'MLLP_FRAME_TOO_LARGE' | 'MLLP_ACK_UNMATCHED_CONTROL_ID' | 'MLLP_ACK_AFTER_TIMEOUT'`. _(Amended 2026-04-22 — three codes added for FRAME-11, CLIENT-15, CLIENT-16.)_
- [ ] **WARN-03** — A consumer subscribing to `onWarning` on either the client or the server receives every warning as it is emitted; the warning also appears in a per-connection `warnings` array accessible from lifecycle events.
- [ ] **WARN-04** — When a warning's tolerance is NOT enabled, the same condition throws `MllpFramingError` with the same stable code in place of a warning — Postel's Law for the encoder is strict; for the decoder, strictness is the default and tolerance is explicit.
- [ ] **WARN-05** — Trailing bytes between a `CR` terminator and the next `VT` (other than whitespace with `allowLeadingWhitespace`) emit `MLLP_TRAILING_BYTES` and are discarded; empty payloads between `VT` and `FS` emit `MLLP_EMPTY_PAYLOAD` and yield a zero-length `Buffer` to the consumer.
- [ ] **WARN-06** — A developer can pass `{ onWarning: fn }` at the server, client, or reader level; the handler receives the `MllpWarning` and the invocation is wrapped in try/catch so a throwing handler does not corrupt stream state.
- [ ] **WARN-07** — Each warning's `message` is stable human-readable text suitable for logs; it never contains payload bytes or secrets, only positional metadata.
- [ ] **WARN-08** — Enabling `{ strict: true }` at the reader/server/client level escalates every tolerated-deviation warning to a thrown `MllpFramingError` with the same stable code; strict mode does not affect `MLLP_TRAILING_BYTES` or `MLLP_EMPTY_PAYLOAD` alone (those remain warnings), but it does affect the leading-VT / FS-CR / LF-after-FS cases.
- [ ] **WARN-09** — `MLLP_FRAME_TOO_LARGE` is a first-class framing error code, never demoted to a warning. _(Paired with FRAME-11 — a frame-size overflow means we have already consumed `maxFrameSizeBytes` of memory; continuing is dangerous.)_
- [ ] **WARN-10** — Each `Connection` exposes its own `onWarning(fn)` subscription and a `connection.warnings` snapshot array; server-level and client-level `onWarning` remain as aggregate streams of all connections. _(Per-connection attribution for servers with many peers — lets an operator pull "all warnings for connectionId X" in one call.)_

### Typed Errors (ERR)

- [ ] **ERR-01** — `MllpFramingError` is thrown for wire-format problems; carries `{ code: WarningCode, byteOffset: number, snippet: Buffer }` where `snippet` is the ≤ 64 bytes around the anomaly.
- [ ] **ERR-02** — `MllpTimeoutError` is thrown (or rejects the `send()` promise) when an ACK does not arrive within the configured timeout; carries `{ messageControlId: string | undefined, elapsedMs: number }`.
- [ ] **ERR-03** — `MllpConnectionError` is thrown (or emitted via `onError`) for socket-layer problems (connect refused, ECONNRESET, ETIMEDOUT, DNS failure); carries `{ cause: Error, phase: 'connect' | 'send' | 'receive' | 'close' | 'reconnect' }`.
- [ ] **ERR-04** — `MllpBackpressureError` is thrown (or rejects the `send()` promise) when the in-flight queue exceeds the high-water mark and `{ onBackpressure: 'reject' }` is configured; carries `{ queueDepth: number, queueBytes: number, highWaterMark: number | { bytes: number } }`.

### Transport Abstraction (TRANS)

- [ ] **TRANS-01** — Both the server and client accept a `Transport` interface, not a raw `net.Socket`; the default production transport wraps `net.Socket` and the default TLS transport wraps `tls.TLSSocket`. The interface lives in `src/transport/`; the `Connection` FSM lives in `src/connection/` and composes a `Transport`.
- [ ] **TRANS-02** — `InMemoryTransport` (exported from `@cosyte/hl7-mllp/testing`) implements the same `Transport` interface: readable, writable, close, error, event-driven, supports `pair()` to create two ends connected back-to-back.
- [ ] **TRANS-03** — A developer can write a full round-trip test (client → server → ACK → client) using `InMemoryTransport.pair()` without opening any sockets; the suite runs deterministically with no timing assumptions.
- [ ] **TRANS-04** — `InMemoryTransport` supports simulated conditions: `split(bytesPerChunk)` forces chunked reads, `pause()/resume()` simulates backpressure, `destroy(reason)` simulates abrupt disconnect.

### Connection Lifecycle & State Machine (LIFE)

- [ ] **LIFE-01** — Every connection exposes a `state` property that is exactly one of `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions are observable via a `'stateChange'` event with `{ from, to, reason }`. _(Amended 2026-04-22 — 4-state FSM expanded to 6 states. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal after `destroy()` and distinct from the transient `DISCONNECTED`.)_
- [ ] **LIFE-02** — Transition graph:
  - `CONNECTING → CONNECTED` after TCP (or TLS) handshake.
  - `CONNECTING → RECONNECTING` on connect failure with `autoReconnect: true` and a transient error.
  - `CONNECTING → CLOSED` on permanent error (CLIENT-18) or explicit `destroy()`.
  - `CONNECTED → DRAINING` on `close()`.
  - `CONNECTED → RECONNECTING` on peer drop with `autoReconnect: true`.
  - `CONNECTED → DISCONNECTED` on peer drop with `autoReconnect: false`.
  - `DRAINING → DISCONNECTED` on graceful drain completion.
  - `DRAINING → CLOSED` on drain-timeout force-close.
  - `RECONNECTING → CONNECTING` on backoff elapse.
  - `RECONNECTING → CLOSED` on permanent error (CLIENT-18) or `destroy()`.
  - `DISCONNECTED → CLOSED` on `destroy()` or terminal reclaim.
  - Any non-terminal state → `CLOSED` on `destroy()`.
  _(Amended 2026-04-22 — full transition graph specified for 6-state FSM.)_
- [ ] **LIFE-03** — Lifecycle events are fired in a consistent order: `onConnect` (once, on `CONNECTED`), `onMessage` (per framed message), `onAck` (client-side per received ACK), `onWarning` (per warning), `onError` (per non-recoverable error), `onDisconnect` (on `DISCONNECTED`), `onReconnecting` (once per reconnect attempt with `{ attempt, delayMs }`), `onDrain` (once when `queueDepth` reaches low-water after backpressure), `onClose` (once, terminal, on `CLOSED`). _(Amended 2026-04-22 — `onDrain`, `onReconnecting`, `onClose` added.)_
- [ ] **LIFE-04** — Every connection has a stable `connectionId: string` (UUIDv4 or ULID-compatible) that is present on every event payload, every warning, and every error emitted by that connection.
- [ ] **LIFE-05** — Calling `close()` during `CONNECTING` or `RECONNECTING` cancels the attempt without leaking timers; calling `close()` during `CONNECTED` transitions to `DRAINING` and resolves when in-flight ACK-waiters complete or the drain timeout elapses.

### MLLP Server (SERVER)

- [ ] **SERVER-01** — `createServer(opts)` returns a server object; `server.listen(port, host?)` resolves when the underlying socket is listening; `server.close()` resolves after all active connections reach `DISCONNECTED` or `CLOSED`.
- [ ] **SERVER-02** — `server.on('connection', (conn) => ...)` fires for every accepted connection; each `conn` is a `Connection` with the full state machine, events, and a `send(buffer)` method for writing framed ACKs or messages back.
- [ ] **SERVER-03** — `conn.on('message', (payload: Buffer, meta) => ...)` fires for every complete framed message; `payload` is the raw bytes between `VT` and `FS` (framing stripped); `meta` includes `{ connectionId, byteOffset, warnings: readonly MllpWarning[] }`.
- [ ] **SERVER-04** — A developer can enable auto-ACK mode (`{ autoAck: 'AA' | ((payload) => Buffer | Promise<Buffer>) }`) so the server responds to every inbound message without manual `conn.send()`; disabling auto-ACK (default) hands the developer full control.
- [ ] **SERVER-05** — Server-side `conn.send(buffer)` handles framing (wraps in `VT…FS+CR`) and returns `boolean` (`true` = flushed immediately, `false` = buffered due to backpressure); callers must handle `false` explicitly. _(Amended Phase 4: Phase 3 implemented `Connection.send()` as boolean per Node.js `net.Socket.write()` semantics; the original "Promise<void>" wording was aspirational.)_
- [ ] **SERVER-06** — `server.close({ drainTimeoutMs })` triggers graceful shutdown: stops accepting new connections, allows in-flight messages and their ACKs to complete, forcibly closes any connection that does not drain within `drainTimeoutMs` (default: 30s).
- [ ] **SERVER-07** — Per-connection keepalive with two distinct options: (1) `keepaliveIntervalMs` (default: off) sends OS-level TCP keepalive probes via `socket.setKeepAlive(true, ms)` to detect half-open connections; (2) `deadPeerTimeoutMs` (default: off, ROADMAP SC-5 name) closes the connection with `MllpConnectionError({ phase: 'receive' })` when no HL7 messages are received for that interval (application-level idle close). Both options are independent and can be combined.
- [ ] **SERVER-08** — `createStarterServer({ port, onMessage, host?, tls?, autoAck? })` returns a batteries-included server — auto-ACK `AA` enabled, 30s drain timeout, `Symbol.asyncDispose` wired, opt-in SIGTERM/SIGINT handlers. _(Makes PROJECT.md's "three lines of code" north-star literally true.)_
- [ ] **SERVER-09** — `server.listen()` and `server.close()` accept `{ signal?: AbortSignal }`; aborting causes the in-progress call to reject with `AbortError` and the server to reach `CLOSED` without leaking sockets.
- [ ] **SERVER-10** — Event payloads dispatched by the server (`connection`, `message`, `error`, `stateChange`, `disconnect`, `close`) are `Object.freeze()`'d so subscribers cannot mutate shared event state. _(Consistency with WARN-01.)_
- [ ] **SERVER-11** — `server[Symbol.asyncDispose]()` exists and delegates to `close({ drainTimeoutMs })` with the same default as SERVER-06, enabling `await using server = createServer(...)` syntax.
- [ ] **SERVER-12** — `createServer({ framing: FrameReaderOptions })` exposes the framing-tolerance opt-ins (FRAME-07..10, FRAME-11) to server-level callers; the default is permissive-with-warnings (`allowFsOnly: true`, `allowLfAfterFs: true`, `allowLeadingWhitespace: true`, `allowMissingLeadingVt: false`) and `{ strict: true }` rejects every deviation. _(Real-world devices emit non-canonical frames; operator needs a dial.)_

### MLLP Client (CLIENT)

- [ ] **CLIENT-01** — `createClient(opts)` returns a client; `client.connect()` resolves on `CONNECTED` (after TCP / TLS handshake); `client.close()` resolves after drain.
- [ ] **CLIENT-02** — `client.send(payload: Buffer)` returns `Promise<Buffer>` that resolves with the inbound ACK's payload (framing stripped) or rejects with `MllpTimeoutError` / `MllpConnectionError` / `MllpBackpressureError`. An ACK with MSA-1 = `AE` or `AR` is still an ACK and resolves the promise; the caller inspects the payload.
- [ ] **CLIENT-03** — ACK correlation: when the peer returns ACKs in-order on a single connection, `send()` resolves in FIFO order against outgoing sends. When `{ correlateByControlId: true }` is set, the client extracts MSH-10 from the outbound payload and matches it against MSA-2 on each inbound ACK, allowing out-of-order or interleaved ACK handling.
- [ ] **CLIENT-04** — `send()` honors a configurable per-message `ackTimeoutMs` (default: 30_000). **The timeout clock starts at the write-flush callback, not at the `send()` call** — pre-flush queue time is not charged to the peer. `send()` also accepts `{ signal?: AbortSignal }` (paired with CLIENT-11); aborting rejects with `AbortError`. On timeout, the promise rejects with `MllpTimeoutError`; the outbound message is not retried automatically. _(Amended 2026-04-22.)_
- [ ] **CLIENT-05** — Auto-reconnect: when `{ autoReconnect: true }` is set and the connection drops, the client transitions `CONNECTED/CONNECTING → RECONNECTING` immediately, schedules the next connect after an exponential-backoff delay (`initialDelayMs: 100`, `maxDelayMs: 30_000`, `multiplier: 2`, `jitter: 0.2`), then `RECONNECTING → CONNECTING` on delay elapse. The `'reconnecting'` event fires per attempt with `{ attempt, delayMs }`. Backoff resets to `initialDelayMs` after any disconnect that was preceded by at least one successful ACK on the prior session. _(Amended 2026-04-22 — 6-state FSM wording + reset-on-recent-success, ioredis pattern.)_
- [ ] **CLIENT-06** — During reconnection, queued sends continue to queue up to the high-water mark; sends rejected for backpressure include the current `state` and `queueDepth`. Setting `{ autoReconnect: false }` causes pending sends to reject with `MllpConnectionError` on disconnect.
- [ ] **CLIENT-07** — Backpressure: when the underlying transport's `write()` returns `false`, the client queues subsequent `send()` calls up to `highWaterMark`. `highWaterMark` accepts either a message count (default: `64`) or `{ bytes: number }` (e.g. `{ bytes: 50 * 1024 * 1024 }`); when both count and byte caps are supplied, the stricter trigger wins. Behavior at overflow is configurable: `{ onBackpressure: 'reject' }` (default — throws `MllpBackpressureError`) or `{ onBackpressure: 'wait' }` (awaits a `'drain'` event or the per-message timeout, whichever fires first). _(Amended 2026-04-22 — byte watermark added, drain-event mechanism specified.)_
- [ ] **CLIENT-08** — Idle keepalive + dead-peer detection: `keepaliveIntervalMs` (default: off) triggers TCP keepalive probes via `socket.setKeepAlive(true, ...)`; `{ deadPeerTimeoutMs }` (default: off) forcibly closes the connection (and triggers auto-reconnect if enabled) when no bytes have been received for that interval.
- [ ] **CLIENT-09** — `client.destroy()` is distinct from `client.close()`: `destroy()` abruptly terminates the socket regardless of in-flight work, rejects every pending `send()` with `MllpConnectionError({ phase: 'close' })`, and transitions directly to `CLOSED` (not `DISCONNECTED`). _(Amended 2026-04-22 — `CLOSED` terminal state pairs with LIFE-01.)_
- [ ] **CLIENT-10** — `createStarterClient({ host, port, tls? })` returns a batteries-included client — auto-reconnect on, exponential backoff with jitter, FIFO ACK correlation, 30s ACK timeout, `Symbol.asyncDispose` wired. _(Mirror of SERVER-08; makes PROJECT.md's "three lines of code" north-star literally true on the client side.)_
- [ ] **CLIENT-11** — `client.connect()`, `client.send()`, and `client.close()` all accept `{ signal?: AbortSignal }`. Aborting before completion rejects with `AbortError`; aborting a `connect()` cancels pending timers, aborting a `send()` cancels the ACK wait, aborting a `close()` abandons the drain.
- [ ] **CLIENT-12** — `{ retryStrategy?: (attempt: number) => number | null }` overrides the default exponential backoff; returning a number sets the next delay in ms, returning `null` halts auto-reconnect and transitions to `CLOSED`. _(Matches `ioredis`; enables circuit-breaker integration.)_
- [ ] **CLIENT-13** — Client event payloads (`message`, `ack`, `error`, `stateChange`, `disconnect`, `reconnecting`, `drain`, `close`) are `Object.freeze()`'d. _(Mirror of SERVER-10.)_
- [ ] **CLIENT-14** — `client[Symbol.asyncDispose]()` exists and delegates to `close()` with default drain timeout, enabling `await using client = createClient(...)` syntax.
- [ ] **CLIENT-15** — Under `correlateByControlId: true`, an inbound ACK with a MSA-2 value that matches no outgoing send emits an `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to `onError`; no pending `send()` resolves or rejects from the stray ACK; each pending send continues to wait for its own timeout. _(Closes a specified-but-undefined edge in CLIENT-03.)_
- [ ] **CLIENT-16** — A late-arriving ACK whose matching `send()` has already rejected with `MllpTimeoutError` emits `MLLP_ACK_AFTER_TIMEOUT` (WARN-02) with `{ elapsedSinceSendMs, controlId }` context; the ACK is dropped. _(Operational forensics for chronic-timeout diagnosis.)_
- [ ] **CLIENT-17** — Queued sends across a reconnect: in `correlateByControlId: true` mode the client re-transmits queued sends on the new connection (idempotent from the peer's perspective because MSH-10 is stable); in FIFO mode queued sends reject with `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })` because FIFO cannot be safely resumed across sessions. _(FIFO ordering is session-scoped; a fresh connection is a fresh ordering.)_
- [ ] **CLIENT-18** — Transient vs permanent error classification: transient errors (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`) trigger `RECONNECTING`; permanent errors (`ENOTFOUND`, `EACCES`, `CERT_HAS_EXPIRED`, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, any `tls.TLSSocket` cert-validation error) halt auto-reconnect and transition to `CLOSED`. The helper `isTransientConnectionError(err): boolean` is exported from the main barrel so callers can implement their own retry policies. _(Prevents tight-loop reconnect against permanent failure.)_
- [ ] **CLIENT-19** — `{ pipeline: false }` option enforces strict send → await-ACK → send serialization: the client does not issue the next `write()` until the previous ACK has been received (or timed out). Default is `{ pipeline: true }` (current behavior: unlimited concurrent in-flight sends up to `highWaterMark`). _(For BizTalk-style MLLP v2 peers that require serialized send/ACK pairs.)_

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
- [ ] **TLS-05** — `tls.servername` defaults to `tls.host` when unset; if neither is resolvable (both empty) the client refuses to connect with `MllpConnectionError({ phase: 'connect', cause: new Error('TLS servername required') })`. _(Prevents silent wrong-tenant-cert bugs against SNI-multiplexed peers.)_

### Observability (OBS) — new category 2026-04-22

- [ ] **OBS-01** — `client.getStats()` returns a JSON-serializable plain object: `{ state, connectionId, queueDepth, queueBytes, inFlight, warningsByCode: Record<WarningCode, number>, bytesIn, bytesOut, lastByteInAt: Date | null, lastByteOutAt: Date | null, reconnectAttempts, connectedAt: Date | null }`. _(Enables operator debugging at 3 AM without adding instrumentation.)_
- [ ] **OBS-02** — `server.getStats()` returns `{ listening: boolean, port: number, host: string, connections: number, activeConnections: number, totalBytesIn, totalBytesOut, acceptedTotal, closedTotal }` as a JSON-serializable plain object.
- [ ] **OBS-03** — Every `Connection` exposes `connection.getStats()` returning `{ state, connectionId, remoteAddress: string | null, remotePort: number | null, warningsByCode: Record<WarningCode, number>, bytesIn, bytesOut, lastByteInAt: Date | null, lastByteOutAt: Date | null, connectedAt: Date | null }`. _(Per-connection is the unit of observation.)_
- [ ] **OBS-04** — All three `getStats()` surfaces return plain objects that pass `JSON.stringify(stats)` with no loss (no `Buffer`, no class instances, no circular refs, `Date` values serialize as ISO strings per ECMAScript default). _(Log pipelines require JSON.)_
- [ ] **OBS-05** — Per-connection recent-warnings array is capped at the 100 most-recent entries with `warningsTruncated: boolean` flag on `getStats()`; the `warningsByCode` count map retains accurate counts regardless of truncation. _(Prevents unbounded memory growth on chronically noisy peers.)_

### Testing & Fixtures (TEST)

- [ ] **TEST-01** — `pnpm test --coverage` reports ≥ 90% line coverage on `src/framing/`, `src/server/`, and `src/client/`, with a green test suite.
- [ ] **TEST-02** — Canonical fixtures: round-trip test suite sends and receives an ADT^A01, ORU^R01, SIU^S12, MDM^T02, and a 1 MB synthetic payload across `InMemoryTransport`; every ACK matches by controlId; every send → ACK → close cycle completes within a bounded number of event-loop ticks.
- [ ] **TEST-03** — Chunked-read fixtures: for each canonical fixture, drive the decoder with every partition of the byte stream — all-in-one, 1-byte chunks, random chunk sizes, chunks that split `VT`, `FS`, and `CR` bytes mid-delimiter — and assert that the reader yields exactly one payload per frame with identical bytes.
- [ ] **TEST-04** — Tolerance fixtures: one fixture per warning code (11 codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`); each one decodes with the matching tolerance opt-in (or triggers via the right path) and warns, and throws / fires the documented error where applicable.
- [ ] **TEST-05** — Lifecycle fixtures: a test spins up a server + client over `InMemoryTransport`, asserts the exact sequence of state transitions on both ends through the 6-state FSM (including a test covering `CONNECTED → RECONNECTING → CONNECTING → CONNECTED` and one covering `CONNECTED → CLOSED` via `destroy()`), and asserts that `onConnect` / `onMessage` / `onAck` / `onReconnecting` / `onDisconnect` / `onClose` fire in the correct order with stable `connectionId` on every event.
- [ ] **TEST-06** — Failure-mode fixtures: abrupt disconnect mid-frame, ACK timeout, ACK with mismatched controlId (under `correlateByControlId`), late-arriving ACK after timeout, orphan-drain on destroy, backpressure overflow (count + bytes), reconnect with queued sends (FIFO reject + controlId resume), transient vs permanent error classification, `pipeline: false` serialization, TLS handshake failure (expired cert, wrong SNI) — every case is covered by a deterministic test and yields the expected typed error.

### Examples & Documentation (DOCS)

- [ ] **DOCS-01** — `examples/server-basic/` is a standalone runnable TypeScript example (`pnpm start` from the example directory) that listens on a port, logs every inbound message, and auto-ACKs with `AA`.
- [ ] **DOCS-02** — `examples/client-basic/` is a standalone runnable TypeScript example that connects to `localhost:2575`, sends a hand-crafted HL7 message from a fixture, prints the ACK, and exits cleanly.
- [ ] **DOCS-03** — `examples/tls/` is a standalone runnable example demonstrating mutual TLS between client and server. Test certificates are generated at `pretest` by a `scripts/generate-test-certs.mjs` helper (using `selfsigned` devDep) into a gitignored `examples/tls/certs/` directory; certs are **never committed**. A top-level `pnpm certs:gen` script is documented in the example's README.
- [ ] **DOCS-04** — README includes: a three-line "hello world" for both server and client at the top (using SERVER-08 / CLIENT-10 starter helpers); a cookbook section (auto-ACK, manual ACK, reconnect, backpressure, TLS, in-memory testing, `AbortSignal` cancellation, `pipeline: false` for BizTalk peers); the full stable warning-code list with descriptions; an "operational playbook" section covering (a) `AE` / `AR` are still ACKs, (b) k8s SIGTERM wiring, (c) never `rejectUnauthorized: false` in production, (d) when to set `pipeline: false`, (e) VPN / half-open-connection tuning with keepalive and dead-peer detection; a "what this package does not do" section pointing at `@cosyte/hl7` for parsing.
- [ ] **DOCS-05** — `pnpm publish --dry-run` produces a clean tarball with `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, `package.json`; no test fixtures, examples, or source `.ts` files leak into the package; the tarball is inspected and documented in the Phase 8 summary. `@arethetypeswrong/cli` is a publish-gate CI step verifying dual-publish + subpath types.
- [ ] **DOCS-06** — README includes an "Anti-features → use this instead" table mapping each out-of-scope item to a recommended alternative: HL7 parsing → `@cosyte/hl7`; full integration engine → Mirth Connect / Rhapsody / Iguana; FHIR → `fhir-kit-client`; store-and-forward queue → BullMQ or similar; routing / fan-out → the user's own integration layer; HTTP-based HL7 → not ours, and not recommended. _(Reduces years of drive-by "does this do X?" issues.)_
- [ ] **DOCS-07** — README opens with a "Three lines" section that literally shows a three-line server and a three-line client using `createStarterServer` / `createStarterClient`; the examples are extracted from `examples/server-basic/` and `examples/client-basic/` by a CI script so they cannot drift from the runnable sources. _(Proves the north-star claim on the landing page. Depends on SERVER-08 + CLIENT-10.)_

---

## v2 / Deferred

- **Typed ACK builders per message type** — e.g., `buildAckA01(msg, disposition)` that understands trigger-specific field requirements. V1 ships generic ACK helpers only.
- **Structured message correlation beyond controlId** — e.g., time-windowed correlation, batch ACKs. V1 does FIFO by default and controlId-matching as an opt-in.
- **Connection pooling / multi-endpoint failover** — V1 ships single-endpoint client with auto-reconnect; pool abstractions are v2.
- **Persistent disk-backed outbound queue** — that is an integration engine, not MLLP.
- **Prometheus / OpenTelemetry adapters** — V1 exposes events + `getStats()`; caller wires their observability backend.
- **Streaming `Readable<Buffer>` payload API** — V1 reads and emits whole payloads; streaming large payloads is v2.
- **Batch (FHS/BHS) framing awareness** — V1 frames individual messages; BHS awareness is v2.
- **`{ unsafeResumeFifoOnReconnect: true }`** — escape hatch for CLIENT-17's default reject behavior. Deferred pending user feedback.
- **TLS cert rotation hook** — long-lived connections surviving cert rotation. V1 requires reconnect to pick up new certs.
- **Browser / Deno / Bun runtimes** — V1 targets Node 20+ only.

## Out of Scope (v1)

- **HL7 v2 parsing or serialization** — delegated to `@cosyte/hl7` peer dep.
- **HL7 v3, CDA, FHIR transports** — different protocols.
- **File-based batch ingestion** — not a transport concern.
- **Store-and-forward / persistent queue** — integration engine concern.
- **Routing / fan-out / transformation** — higher-level framework.
- **HTTP-based HL7** — rare; roadmap if demanded.
- **Built-in metrics backends** — expose events + `getStats()`, caller wires their own.

---

## Traceability

Each REQ-ID maps to exactly one phase.

| REQ-ID range | Phase | Status |
|--------------|-------|--------|
| SETUP-01..07 | Phase 1 | Pending |
| FRAME-01..11 | Phase 2 | Pending |
| WARN-01..09 | Phase 2 | Pending |
| ERR-01 (`MllpFramingError`) | Phase 2 | Pending |
| TRANS-01..04 | Phase 3 | Pending |
| LIFE-01..05 | Phase 3 | Pending |
| WARN-10 (per-connection warning stream) | Phase 3 | Pending |
| OBS-03, OBS-04, OBS-05 | Phase 3 | Pending |
| ERR-03 (`MllpConnectionError`) | Phase 3 | Pending |
| SERVER-01..12 | Phase 4 | Pending |
| OBS-02 (`server.getStats()`) | Phase 4 | Pending |
| CLIENT-01..19 | Phase 5 | Pending |
| OBS-01 (`client.getStats()`) | Phase 5 | Pending |
| ERR-02 (`MllpTimeoutError`) | Phase 5 | Pending |
| ERR-04 (`MllpBackpressureError`) | Phase 5 | Pending |
| ACK-01..05 | Phase 6 | Pending |
| TLS-01..05 | Phase 6 | Pending |
| TEST-01..06 | Phase 7 | Pending |
| FRAME-12 (byte-fidelity test) | Phase 7 | Pending |
| DOCS-01..07 | Phase 8 | Pending |

**Coverage check:** 7 + 11 + 9 + 1 + 4 + 5 + 1 + 3 + 1 + 12 + 1 + 19 + 1 + 1 + 1 + 5 + 5 + 6 + 1 + 7 = **101 / 101 v1 REQ-IDs mapped to exactly one phase.**

## Per-category totals

| Category | Count |
|----------|------:|
| SETUP | 7 |
| FRAME | 12 |
| WARN | 10 |
| ERR | 4 |
| TRANS | 4 |
| LIFE | 5 |
| SERVER | 12 |
| CLIENT | 19 |
| ACK | 5 |
| TLS | 5 |
| TEST | 6 |
| DOCS | 7 |
| OBS *(new)* | 5 |
| **Total** | **101** |
