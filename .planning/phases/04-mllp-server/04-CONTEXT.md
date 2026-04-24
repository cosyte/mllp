# Phase 4: MLLP Server - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

MLLP Server: `src/server/` — `MllpServer` class, `createServer()`, `createStarterServer()`, `server.getStats()`. Exposes the full server-side public API (listen, accept connections, route messages, auto-ACK, graceful shutdown, keepalive, AbortSignal, Symbol.asyncDispose, frozen event payloads). Depends on Phase 3 (`Connection`, `NetTransport`, `FrameReader`, `encodeFrame`, `MllpConnectionError`).

No client logic. No ACK helpers. No TLS (Phase 6 adds TlsTransport and wires it in). No HL7 parsing. Zero new runtime deps.

</domain>

<decisions>
## Implementation Decisions

### Server Class Shape
- **D-01:** `MllpServer` **extends Node.js `EventEmitter`** — the same pattern established by `Connection` in Phase 3 (which `conn.on('message', ...)` implies). Public events: `'connection'`, `'error'`, `'close'`, `'listening'`. `createServer(opts)` is the factory; it instantiates and returns `MllpServer`. This is consistent with Node.js's own `net.Server` pattern and lets developers use familiar `.on()` syntax. `src/server/server.ts` holds the class; `src/server/index.ts` is the barrel.

- **D-02:** `MllpServer` does **not** extend `net.Server` — it wraps one internally. The public API surface is our own (`listen`, `close`, `getStats`, events); the underlying `net.Server` is an implementation detail. This preserves the Transport abstraction boundary and lets tests swap in `InMemoryTransport` pairs without a TCP listener.

### Auto-ACK Semantics (SERVER-04)
- **D-03:** When `{ autoAck: 'AA' }` or `{ autoAck: fn }` is set, the server fires the `'message'` event on the connection **before** sending the auto-ACK. This gives the developer observability (logging, metrics, auditing) without requiring manual `conn.send()`. The developer's `'message'` handler must NOT call `conn.send()` when auto-ACK is active — doing so would result in two ACKs sent (documented in JSDoc with `@throws`-style warning). If `autoAck` is a function returning `Buffer | Promise<Buffer>`, the resolved buffer is used as the ACK payload.

- **D-04:** Auto-ACK errors (e.g., `fn` throws, `conn.send()` rejects) are emitted as `'error'` events on the connection — they do NOT crash the server. The server continues accepting messages; the peer will timeout waiting for the ACK and may retry.

### Connection Tracking and Graceful Shutdown (SERVER-01, SERVER-06)
- **D-05:** `MllpServer` maintains a `Set<Connection>` of all active connections (`_connections`). On `'connection'` each accepted connection is added; on connection `'close'` event it is removed. This is the source of truth for `server.getStats().activeConnections` and for shutdown coordination.

- **D-06:** `server.close({ drainTimeoutMs })` follows this sequence: (1) stops accepting new connections (`net.Server.close()`), (2) calls `conn.close()` on every active connection in `_connections` (which triggers their `beforeClose()` hook — Phase 3 D-07/D-08), (3) races all connection close promises against a shared `drainTimeoutMs` deadline (default 30 000 ms), (4) any connection not closed by the deadline gets `conn.destroy()`, (5) resolves when `_connections` is empty. `server.close()` returns a single `Promise<void>` that resolves when all connections have reached `DISCONNECTED` or `CLOSED`.

- **D-07:** The server registers a `beforeClose()` hook on each accepted `Connection` that resolves the per-connection drain promise once the server's auto-ACK pipeline is flushed. At Phase 4 scope, this is a simple no-op that resolves immediately (since the server doesn't buffer outgoing ACKs — `conn.send()` flush is already awaited by the caller). Phase 5 (Client) register their own `beforeClose()` for send-queue drain. The hook slot is already reserved by Phase 3 D-08.

### `createStarterServer` Options (SERVER-08)
- **D-08:** `createStarterServer({ port, onMessage, host?, framing?, autoAck? })` signature. The `onMessage` callback receives `(payload: Buffer, meta: MessageMeta, conn: Connection)` and returns `Buffer | Promise<Buffer>` (the ACK payload) or `void` (if autoAck is separately configured). Starter defaults: `autoAck: 'AA'`, `drainTimeoutMs: 30_000`, `Symbol.asyncDispose` wired, `handleSignals: false` (opt-in).

- **D-09:** Signal handling opt-in: `{ handleSignals?: boolean }` (default `false`). When `true`, `createStarterServer` registers `process.once('SIGTERM', handler)` and `process.once('SIGINT', handler)` that call `server.close()` and then `process.exit(0)`. Uses `once` (not `on`) to avoid accumulating handlers across multiple server instances in tests. Signals not registered on raw `createServer()` — only `createStarterServer`.

### Keepalive Mechanism (SERVER-07)
- **D-10:** `keepaliveIntervalMs` enables **TCP-level keepalive probes** via `socket.setKeepAlive(true, keepaliveIntervalMs)` on each accepted socket — this uses the OS TCP stack to detect dead peers (half-open connections, network partitions). It does NOT close the connection on idle application data — only when the OS reports the peer is unreachable.

- **D-11:** To close connections that are TCP-alive but application-idle (no HL7 messages for N ms), use `{ idleTimeoutMs }` (distinct from `keepaliveIntervalMs`). `idleTimeoutMs` resets on every `'message'` event; if it elapses, `conn.destroy(new Error('idle timeout'))` is called, which emits `MllpConnectionError({ phase: 'receive' })`. Both options are independent and can be used together.

### Server-Level Framing Tolerance (SERVER-12)
- **D-12:** `createServer({ framing: FrameReaderOptions })` passes tolerance opts to every `FrameReader` created per connection. Default for server: `{ allowFsOnly: true, allowLfAfterFs: true, allowLeadingWhitespace: true, allowMissingLeadingVt: false }` — matches real-world device behavior. `{ strict: true }` at the server level overrides all tolerance opts to false and escalates every deviation to a thrown `MllpFramingError`. Framing opts are the same `FrameReaderOptions` type from Phase 2 — no new type needed.

### Observability (OBS-02)
- **D-13:** `server.getStats()` maintains server-level counters internally (not derived from live connections): `acceptedTotal` increments on `'connection'`; `closedTotal` increments when each connection fires `'close'`. `activeConnections` is `_connections.size`. `totalBytesIn` / `totalBytesOut` aggregate from each connection's `getStats()` at call time. Shape: `{ listening: boolean, port: number | null, host: string | null, connections: number, activeConnections: number, totalBytesIn: number, totalBytesOut: number, acceptedTotal: number, closedTotal: number }`.

### Event Freezing (SERVER-10)
- **D-14:** All event payloads emitted by `MllpServer` and its connections are `Object.freeze()`'d before emission, consistent with Phase 2/3 pattern. Frozen: `'connection'` payload `{ connectionId, remoteAddress, remotePort }`, `'error'` payload, `'stateChange'` payload, `'message'` payload `{ payload, meta }`. The `Connection` objects emitted in `'connection'` events are references (not frozen) — only the event payload wrapper is frozen.

### Module Structure
- **D-15:** `src/server/server.ts` — `MllpServer` class + `createServer()` factory + `createStarterServer()` factory. `src/server/index.ts` — barrel re-exporting public surface. Public exports added to `src/index.ts` barrel: `MllpServer`, `createServer`, `createStarterServer`, `ServerOptions`, `StarterServerOptions`, `ServerStats`, `MessageMeta`.

### Claude's Discretion
- Internal `_connections` Set cleanup (use `WeakRef` or direct ref — direct ref is simpler since we already remove on 'close')
- Exact `MessageMeta` type fields beyond the required `{ connectionId, byteOffset, warnings }` from SERVER-03
- Whether `listen()` resolves immediately after `net.Server` emits 'listening' or after the first connection tick (emit 'listening' event → resolve)
- `net.Server` backlog parameter (use Node default of 511)
- Whether `createServer()` validates opts at construction time (recommended: validate in `listen()` call — prevents throw-on-import)

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Vision, zero runtime deps, Buffer-first API, no `console.*`, frozen events, Postel's Law
- `.planning/REQUIREMENTS.md` §"MLLP Server (SERVER)" — SERVER-01..12 (full server requirement set)
- `.planning/REQUIREMENTS.md` §"Observability (OBS)" — OBS-02 (server.getStats() shape)
- `.planning/REQUIREMENTS.md` §"Connection Lifecycle & State Machine (LIFE)" — LIFE-01..05 (FSM + beforeClose hook)
- `.planning/REQUIREMENTS.md` §"Warnings & Tolerance (WARN)" — WARN-03, WARN-06, WARN-10
- `.planning/ROADMAP.md` §"Phase 4: MLLP Server" — phase goal, success criteria, plan breakdown
- `CLAUDE.md` §"Engineering Guardrails" — `.subarray()`, frozen events, no `console.*`, Buffer-first, SETUP-07

### Prior phase context (MUST read)
- `.planning/phases/03-transport-connection-fsm-observability/03-CONTEXT.md` — D-05 (Connection fires 'message' for all frames), D-07/D-08 (beforeClose hook — Server registers drain logic here), D-09 (warning enrichment pattern)
- `.planning/phases/02-framing-codec-warnings/02-CONTEXT.md` — FrameReader callback-bag shape, encodeFrame strict emitter

### Existing code (read before planning file list)
- `src/connection/connection.ts` — Connection class, beforeClose hook, FSM, send(), getStats()
- `src/transport/net-transport.ts` — NetTransport wrapping net.Socket
- `src/framing/decoder.ts` — FrameReader with tolerance opts (server composes this per-connection)
- `src/framing/encoder.ts` — encodeFrame (server uses for conn.send() framing)
- `src/index.ts` — current barrel (Phase 4 adds server exports here)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Connection` (src/connection/connection.ts) — Phase 4 instantiates one per accepted socket. Register `beforeClose()` for graceful drain. `conn.send(buf)` wraps in encodeFrame and writes.
- `NetTransport` (src/transport/net-transport.ts) — Wrap each accepted `net.Socket` in NetTransport, pass to `new Connection({ transport })`.
- `FrameReader` (src/framing/decoder.ts) — One per connection, initialized with server-level framing opts. Wire to `transport.onData()` inside Connection.
- `encodeFrame` (src/framing/encoder.ts) — Used by `conn.send()` (already wired in Connection.send()).
- `MllpConnectionError` (src/connection/error.ts) — Surface in server 'error' events.
- `src/server/` directory — empty, Phase 4 creates server.ts + index.ts.
- `src/index.ts` — barrel stub has `// Phase 4: server` comment placeholder.

### Established Patterns
- EventEmitter extension for public API objects (Connection sets this precedent; Server follows it).
- `Object.freeze()` on every emitted event payload — mandatory per SERVER-10.
- `.subarray()` not `.slice()` — SETUP-07 ESLint rule enforced in `src/server/`.
- JSDoc + `@example` on every public export — SERVER-08 and createStarterServer especially need a three-line usage example.
- Callback-bag pattern for INTERNAL interfaces (Transport) — NOT for public EventEmitter API (MllpServer, Connection).

### Integration Points
- `src/index.ts` — add server public exports.
- Phase 5 (Client) will import `Connection`, `NetTransport` — server doesn't touch client code.
- Phase 6 (TLS) — `createServer({ tls })` will use `TlsTransport` instead of `NetTransport`. Server code should branch: if `opts.tls`, use `TlsTransport`; else use `NetTransport`. `TlsTransport` doesn't exist yet — leave a `// Phase 6: wire TlsTransport here` comment at the branch point.

</code_context>

<specifics>
## Specific Ideas

- `conn.send(buf)` on the server side wraps `buf` in `encodeFrame()` — same as client side. Connection.send() already handles this. Server `onMessage` handler receives the DECODED payload (framing stripped); developer's reply is the raw payload, server re-encodes.
- `createStarterServer({ onMessage })` — the `onMessage` function is effectively the auto-ACK builder. If `onMessage` returns a `Buffer`, it is used as the ACK payload; if it returns `void`, default `AA` ACK is constructed from MSH bytes (no parser needed — extract MSH-10 by splitting on `|` and taking index 9). The "no parser" path is the default; `@cosyte/hl7` peer dep is not required for Phase 4.
- AbortSignal on `listen()` and `close()`: wire via `signal.addEventListener('abort', handler, { once: true })`. On abort, call `server.close()` (if listening) or reject (if listen in progress). Pair with `signal.removeEventListener` cleanup.
- Server `'listening'` event payload: `Object.freeze({ port: actualPort, host: actualHost })` — emit after `net.Server` 'listening' fires.

</specifics>

<deferred>
## Deferred Ideas

- `server.broadcast(buf)` — send to all active connections. Not in v1 requirements.
- Per-connection `maxMessageRate` throttling — not in v1.
- `net.Server` clustering / SO_REUSEPORT — not in v1.
- TLS SNI routing at server level — Phase 6.

</deferred>

---

*Phase: 04-mllp-server*
*Context gathered: 2026-04-24 (auto mode)*
