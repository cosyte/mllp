# Phase 5: MLLP Client - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning

<domain>
## Phase Boundary

MLLP Client: `src/client/` — `MllpClient` class, `createClient()`, `createStarterClient()`, `client.getStats()`. Exposes the full client-side public API (connect, send-with-ACK, exponential-backoff reconnect, FIFO + controlId ACK matching, backpressure with count + bytes watermarks, `pipeline:false` serialization, dead-peer detection, AbortSignal, Symbol.asyncDispose, frozen event payloads). Depends on Phase 3 (`Connection`, `NetTransport`, `FrameReader`, `encodeFrame`, `MllpConnectionError`) and Phase 2 (`MllpFramingError`, warning codes).

No server logic. No ACK builders (Phase 6). No TLS (Phase 6 adds TlsTransport and wires it in). No HL7 parsing. Zero new runtime deps.

</domain>

<decisions>
## Implementation Decisions

### Client Class Shape

- **D-01:** `MllpClient` **extends Node.js `EventEmitter`** — same precedent as `Connection` (Phase 3) and `MllpServer` (Phase 4 D-01). Public events: `'connect'`, `'reconnecting'`, `'disconnect'`, `'close'`, `'error'`, `'drain'`, `'stateChange'`, `'warning'`, `'message'`, `'ack'`. `createClient(opts)` is the factory. `src/client/client.ts` holds the class; `src/client/index.ts` is the barrel.

- **D-02:** `MllpClient` does **not** extend `net.Socket` or wrap one directly — it composes a `Connection` from Phase 3 (which itself wraps a `Transport`). This preserves the Transport abstraction so `InMemoryTransport.pair()` plugs in for tests and `TlsTransport` plugs in for Phase 6 without touching client code. Leave a `// Phase 6: wire TlsTransport here when opts.tls is set` seam in `createClient` (mirror Phase 4 server precedent).

### ACK Correlation Internals (Area 1 — locked)

- **D-03:** **Unified `Map<correlationKey, PendingAck>`** with ES2015 insertion-ordered iteration is the single source of truth for in-flight + queued sends. FIFO mode uses a private monotonic `sendSeq` (number) as the key; `correlateByControlId:true` mode uses MSH-10 (string) as the key. One `queueBytes` counter, one timeout sweep, one graveyard map. Located at `src/client/correlator.ts` (~200–250 LOC, single file).

- **D-04:** **Late-ACK graveyard** — a sibling `Map<correlationKey, { timedOutAt, controlId }>` retains entries for `2 * ackTimeoutMs` after they fire `MllpTimeoutError`. An inbound ACK whose key hits the graveyard emits `MLLP_ACK_AFTER_TIMEOUT` warning (CLIENT-16) and is dropped. Eviction is lazy (checked on every match attempt) — no separate sweep timer.

- **D-05:** **Unmatched controlId** — in `correlateByControlId:true` mode, an inbound ACK whose MSA-2 matches neither the live store nor the graveyard emits `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to `'error'` and is dropped (CLIENT-15).

- **D-06:** **`pipeline:false` serialization** is implemented as a `maxInFlight=1` guard on the same store — NOT a separate correlator class. When the store has 1 entry, further `send()` calls await drain (or reject per backpressure policy) before being added.

- **D-07:** **CLIENT-17 reconnect-resend in controlId mode** is a single walk: `for (const pending of pendingAcks.values()) transport.write(pending.frame)` after `RECONNECTING → CONNECTED`. Insertion order is preserved by `Map`. **CLIENT-17 reconnect-reject in FIFO mode** is `for (const pending of pendingAcks.values()) pending.reject(new MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' }))` followed by `pendingAcks.clear()`.

### Reconnect-Time In-Flight Semantics (Area 2 — locked)

- **D-08:** **Hybrid asymmetric rule** — extends the locked CLIENT-17 mental model symmetrically across queued AND in-flight sets:
  - **FIFO mode:** queued AND in-flight sends reject. Queued sends use the existing `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })`. **In-flight** sends (write flushed, ACK timer started, then socket dropped) reject with a NEW distinct cause: `MllpConnectionError({ phase: 'reconnect', cause: 'in-flight-orphan' })`. The distinct cause preserves the at-most-once vs at-least-once distinction healthcare callers (medication, orders) need.
  - **controlId mode:** queued AND in-flight sends are re-transmitted on the new connection (idempotent via stable MSH-10). The peer is expected to dedupe (Mirth, BizTalk, Cloverleaf, Rhapsody all do this on MSH-10) — `correlateByControlId:true` is itself the explicit opt-in that signals this contract.

- **D-09:** **`'in-flight-orphan'` is a new stable cause code** under `MllpConnectionError.cause`. Like the warning-code union, this is a public API; renaming or removing it is a breaking change. Add to the error documentation and (if a cause-code union exists) to its type union.

- **D-10:** **`pipeline:false` collapses the in-flight set to ≤1**, making both branches trivially testable over `InMemoryTransport`: one fixture per mode, write-flush-then-drop.

### Dead-Peer / Idle Detection (Area 3 — locked)

- **D-11:** **Two independent options**, mirroring Phase 4 server D-10/D-11 exactly:
  - `keepaliveIntervalMs` — TCP-level keepalive via `socket.setKeepAlive(true, keepaliveIntervalMs)` on the underlying socket. OS-level half-open detection (network partitions, NAT-table eviction).
  - `deadPeerTimeoutMs` — application-level idle timer keyed on **last bytes/ACK received** (NOT on `send()` — otherwise a chatty sender masks a dead peer). Resets on every inbound message, ACK, or warning event. If elapsed, calls `connection.destroy(new Error('dead peer timeout'))` which surfaces as `MllpConnectionError({ phase: 'receive' })` (matches Phase 4 server D-11 phase name for symmetry).

- **D-12:** **Both options default off (undefined)** — opt-in only. JSDoc on each option references the operational playbook (DOCS-04 item e — VPN half-open tuning).

- **D-13:** **FSM routing on dead-peer trip honors `autoReconnect`**:
  - `autoReconnect:true` (default per createStarterClient): `CONNECTED → DISCONNECTED → RECONNECTING → CONNECTING` via the standard disconnect path. Backoff applies; backoff-reset rule (CLIENT-09) applies.
  - `autoReconnect:false`: `CONNECTED → DISCONNECTED` (terminal-for-this-attempt; caller may manually `connect()` again).

- **D-14:** **Timer cleanup on FSM transition** — both timers MUST be cleared on every transition out of `CONNECTED` (especially `RECONNECTING`, `DRAINING`, `DISCONNECTED`, `CLOSED`). Re-armed on every entry into `CONNECTED`. Belongs in the plan's test list — verifiable over `InMemoryTransport` by transitioning the FSM and asserting timer handles.

### `retryStrategy` Hook Contract (Area 4 — locked)

- **D-15:** **Rich `RetryContext` object** signature:
  ```ts
  interface RetryContext {
    readonly attempt: number;
    readonly lastError: Error;
    readonly lastDelayMs: number;
    readonly totalElapsedMs: number;
    readonly sinceLastSuccessMs: number;
    readonly classifiedAs: 'transient' | 'permanent';
    readonly signal: AbortSignal;
  }
  type RetryStrategy = (ctx: RetryContext) => number | null;
  ```
  Frozen via `Object.freeze` before passing to user code (matches project pattern for emitted payloads).

- **D-16:** **Composition A** — the CLIENT-18 transient/permanent classifier runs **first**. Permanent errors (`ENOTFOUND`, TLS cert errors, `EACCES`) transition directly to `CLOSED` without invoking `retryStrategy`. Only transient errors invoke `retryStrategy`. The `ctx.classifiedAs` field is provided to the hook so advanced callers CAN override (e.g., "this `ECONNREFUSED` is permanent in my deployment"); but by default the hook only sees `'transient'`.

- **D-17:** **`null`-return semantics** — `retryStrategy` returning `null` halts reconnection; the FSM transitions to `CLOSED` (terminal). Matches CLIENT-18 permanent-error path; keeps `RECONNECTING` bounded.

- **D-18:** **`ctx.signal: AbortSignal`** is the same `AbortSignal` passed into `connect()` (or a never-aborting sentinel if none was provided). Hook implementations that await external state can short-circuit on abort. Adding `signal` is cheap NOW; introducing it later is breaking.

- **D-19:** **Default `retryStrategy`** when not supplied: `(ctx) => Math.min(30_000, 100 * 2 ** ctx.attempt) * jitter(0.8, 1.2)`. Caps at 30 s, ±20 % jitter. Backoff-reset (CLIENT-09) applies via the `sinceLastSuccessMs` field — if a recent success fired, the FSM resets `attempt` to 0 before the next call.

### Connection Tracking and Module Structure

- **D-20:** **`MllpClient` holds a single `Connection`** (not a set). Lifecycle events (`'stateChange'`, `'message'`, `'error'`, `'warning'`) re-emit on the client with the same payloads (frozen).

- **D-21:** **Module structure** (single-file-per-concern, mirrors Phase 4's `server.ts` monolith but split where complexity warrants):
  - `src/client/client.ts` — `MllpClient` class + `createClient` factory + `createStarterClient` factory
  - `src/client/correlator.ts` — `Correlator` class (Area 1) — pure data structure + matching, no FSM knowledge
  - `src/client/error.ts` — `MllpTimeoutError`, `MllpBackpressureError`, `isTransientConnectionError` (CLIENT-18 classifier export)
  - `src/client/index.ts` — barrel re-exporting public surface
  - Public exports added to `src/index.ts`: `MllpClient`, `createClient`, `createStarterClient`, `ClientOptions`, `StarterClientOptions`, `ClientStats`, `RetryContext`, `RetryStrategy`, `MllpTimeoutError`, `MllpBackpressureError`, `isTransientConnectionError`.

### `createStarterClient` Defaults (CLIENT-10)

- **D-22:** `createStarterClient({ host, port, onMessage? })` minimal signature. Defaults: `autoReconnect: true`, `ackTimeoutMs: 30_000`, `correlateByControlId: false` (FIFO — simplest mental model), `pipeline: true` (parallel), `highWaterMark: 64`, `onBackpressure: 'reject'`, `Symbol.asyncDispose` wired, frozen event payloads, `handleSignals: false` (opt-in, matches Phase 4 D-09).

### Backpressure Defaults (CLIENT-11/12)

- **D-23:** **`highWaterMark`** accepts `number` (count, default 64) or `{ bytes: number }` or `{ count: number, bytes: number }` (stricter-of-two wins per ROADMAP success criterion 4). Byte-mode is opt-in; default is count-only. `client.getStats()` exposes both `queueDepth` and `queueBytes` regardless of which mode is active — observability is unconditional.

- **D-24:** **`'drain'` event** fires when both `queueDepth < highWaterMark.count` AND `queueBytes < highWaterMark.bytes` (whichever applies). Frozen payload: `Object.freeze({ queueDepth, queueBytes })`.

### Event Freezing (CLIENT analog of SERVER-10)

- **D-25:** All event payloads emitted by `MllpClient` are `Object.freeze`'d before emission. Frozen: `'connect'`, `'reconnecting'` (extends Phase 3 `ReconnectingEvent` — populates `attempt` and `delayMs` per D-19), `'stateChange'`, `'message'`, `'ack'`, `'error'`, `'warning'`, `'drain'`, `'disconnect'`, `'close'`. The `RetryContext` passed to user code is also frozen (D-15).

### Observability (CLIENT-OBS-01)

- **D-26:** **`client.getStats()`** returns JSON-serializable plain object — no Buffers, no class instances:
  ```ts
  {
    state: ConnectionState,
    connectionId: string | null,
    queueDepth: number,
    queueBytes: number,
    inFlight: number,
    warningsByCode: Record<WarningCode, number>,
    totalBytesIn: number,
    totalBytesOut: number,
    sentTotal: number,
    ackedTotal: number,
    timedOutTotal: number,
    reconnectAttempts: number,
    lastConnectedAt: number | null,
    lastAckAt: number | null
  }
  ```

### Claude's Discretion

- Internal `Map` key type for FIFO mode — synthetic monotonic `number` (sendSeq) is recommended over `bigint` for memory.
- Graveyard TTL — proposed `2 * ackTimeoutMs`; tunable internal constant if this proves wrong in tests.
- Exact wording of stable cause-code documentation (`'in-flight-orphan'` JSDoc).
- `'ack'` event payload shape: `{ payload: Buffer, controlId: string | null, latencyMs: number }` — frozen.
- Whether `connect()` retries on initial failure vs fail-fast — recommend fail-fast unless caller passes `autoReconnect: true` AND `retryStrategy` allows attempt-0 to be transient (i.e., RECONNECTING reachable from CONNECTING-failure path per Phase 3 LIFE-02).
- Internal `_lastSuccessAt` field tracking — needed for backoff reset (CLIENT-09) and `sinceLastSuccessMs` (D-15).
- Whether `client.send()` returns `Promise<Buffer>` (the ACK payload bytes) or `Promise<{ payload: Buffer, controlId: string | null }>` — recommend `Promise<Buffer>` matching ROADMAP success criterion 1's "receives the inbound ACK payload (framing stripped) as a Buffer".

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements
- `.planning/PROJECT.md` — Vision, zero runtime deps, Buffer-first API, no `console.*`, frozen events, Postel's Law, stable warning codes
- `.planning/REQUIREMENTS.md` §"MLLP Client (CLIENT)" — CLIENT-01..19 (full client requirement set)
- `.planning/REQUIREMENTS.md` §"Observability (OBS)" — OBS-01 (client.getStats() shape)
- `.planning/REQUIREMENTS.md` §"Connection Lifecycle & State Machine (LIFE)" — LIFE-01..05 (FSM + edge graph)
- `.planning/REQUIREMENTS.md` §"Errors (ERR)" — ERR-02 (MllpTimeoutError), ERR-04 (MllpBackpressureError)
- `.planning/REQUIREMENTS.md` §"Warnings & Tolerance (WARN)" — `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`
- `.planning/ROADMAP.md` §"Phase 5: MLLP Client" — phase goal, success criteria, plan breakdown
- `.planning/research/SUMMARY.md` — A10 / DOCS-04e (VPN half-open tuning operational playbook)
- `CLAUDE.md` §"Engineering Guardrails" — `.subarray()`, frozen events, no `console.*`, Buffer-first, SETUP-07

### Prior phase context (MUST read)
- `.planning/phases/04-mllp-server/04-CONTEXT.md` — D-01 (EventEmitter pattern), D-09 (handleSignals), D-10/D-11 (keepalive + deadPeer split that the client mirrors), D-13 (getStats shape pattern), D-14 (event freezing)
- `.planning/phases/03-transport-connection-fsm-observability/03-CONTEXT.md` — Connection FSM, ReconnectingEvent shape (Phase 5 populates `attempt` + `delayMs` per D-19), beforeClose hook, getStats
- `.planning/phases/02-framing-codec-warnings/02-CONTEXT.md` — FrameReader callback-bag, encodeFrame, warning codes (esp. `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`)

### Existing code (read before planning file list)
- `src/connection/connection.ts` — Connection class, 6-state FSM, beforeClose hook, send(), getStats(); Phase 5 composes one
- `src/connection/error.ts` — `MllpConnectionError`, `ConnectionErrorPhase` union (`'reconnect'` already in union); D-09 adds `'in-flight-orphan'` to the cause set
- `src/transport/net-transport.ts` — NetTransport wrapping net.Socket; Phase 5 instantiates per-connection
- `src/framing/decoder.ts` — FrameReader (Phase 5 wires per-connection through Connection)
- `src/framing/encoder.ts` — encodeFrame (used by `connection.send()`)
- `src/framing/warnings.ts` — warning code union; client emits `MLLP_ACK_*` codes
- `src/server/server.ts` — Phase 4 monolith; **read for symmetry** (events list, getStats shape, opt-in handleSignals, frozen-payload pattern)
- `src/index.ts` — current barrel; Phase 5 adds client public exports here
- `src/client/` directory — empty; Phase 5 creates `client.ts`, `correlator.ts`, `error.ts`, `index.ts`

### External prior art (informative, NOT a runtime dep)
- ioredis commandQueue + redis-py command stack — informed Area 1 (unified Map structure)
- node-redis v4 reconnectStrategy + got/p-retry/undici RetryHandler — informed Area 4 (rich RetryContext)
- Mirth Connect issue #1441, #734 — informed Area 2 (controlId resend matches real-world receiver dedupe behavior)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Connection` (`src/connection/connection.ts`) — Phase 5 composes ONE per `MllpClient`. Subscribe to `'message'` (inbound ACK candidates), `'stateChange'` (drives reconnect FSM), `'warning'` (re-emit). Use `connection.send(buf)` for outbound (Connection wraps in encodeFrame).
- `NetTransport` (`src/transport/net-transport.ts`) — wrap each new `net.Socket` (per reconnect attempt) in NetTransport, pass to `new Connection({ transport })`.
- `MllpConnectionError` (`src/connection/error.ts`) — `phase: 'reconnect'` already in union (per Phase 3 D-01 fix). D-09 in this CONTEXT adds `'in-flight-orphan'` to the cause taxonomy.
- `FrameReader` (`src/framing/decoder.ts`) — already wired per-connection by `Connection` itself; client doesn't instantiate directly. Client framing tolerance opts (if any) flow through `Connection` config the same way `server` does.
- `encodeFrame` (`src/framing/encoder.ts`) — used internally by `connection.send()`.
- `Object.freeze` event-payload pattern — established in Phase 2/3/4; mandatory for every emit (CLIENT-D-25).

### Established Patterns
- EventEmitter for public API objects (Connection, Server set the precedent; Client follows).
- `Object.freeze` on every emitted payload — mandatory.
- `.subarray()` not `.slice()` — SETUP-07 ESLint rule extends to `src/client/` (per CLAUDE.md guardrail; `src/framing|server|client` is the rule's scope).
- Stable warning + error-cause codes are public API — D-09 introduces `'in-flight-orphan'`.
- JSDoc + `@example` on every public export (CLIENT-10 starter especially needs a three-line example demonstrating the north star).
- Callback-bag pattern for INTERNAL interfaces (Transport) — NOT for public EventEmitter API (MllpClient).
- Single-file-per-concern with file split when complexity warrants — `correlator.ts` is the one Phase 4 server didn't need.

### Integration Points
- `src/index.ts` — add client public exports (D-21 list).
- Phase 6 (TLS) — `createClient({ tls })` will switch transport to `TlsTransport`. Leave `// Phase 6: wire TlsTransport here when opts.tls is set` comment at the branch point in `createClient`.
- Phase 6 (ack-from-hl7) — independent module; client does NOT import the parser at runtime. The `@cosyte/hl7-mllp/ack-from-hl7` subpath builds ACKs that callers PASS TO `client.send()`; client treats them as opaque Buffers.
- Phase 7 (testing) — `InMemoryTransport.pair()` from Phase 3 is the test substrate; deterministic chunked-read fuzz fixtures live here. The unified `Correlator` (D-03) is independently testable as a pure data structure.

</code_context>

<specifics>
## Specific Ideas

- **`'ack'` event** (in addition to `send()` promise resolution) — fires on every successfully matched ACK with `Object.freeze({ payload: Buffer, controlId: string | null, latencyMs: number })`. Lets observability layers log every ACK without instrumenting every `send()` call site.
- **`isTransientConnectionError(err)`** is exported from the main barrel (CLIENT-18 success criterion). Same module that defines the classifier consumed in Composition A (D-16). Implementation: switch on `err.code` (`ENOTFOUND`, `EACCES`, TLS cert error names → permanent; `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `EPIPE` → transient; default → transient).
- **Backoff reset rule** (CLIENT-09): `_lastSuccessAt` updated on every resolved ACK. On `RECONNECTING` entry, if `Date.now() - _lastSuccessAt < someThreshold` (recommend reading `_attempt = 0` if any success since the last `RECONNECTING` exit), reset `_attempt` to 0 BEFORE invoking `retryStrategy`. This makes `ctx.sinceLastSuccessMs` consistent with the reset.
- **Three-line north-star** must work: `await using c = createStarterClient({ host: 'localhost', port: 2575 }); const ack = await c.send(payloadBuffer);`. JSDoc `@example` on `createStarterClient` should include exactly this snippet.

</specifics>

<deferred>
## Deferred Ideas

- **Async `retryStrategy`** (Area 4 Option 4): defer to a future minor version if a concrete use case appears (e.g., consulting Secrets Manager mid-reconnect). Sync→async is a non-breaking widening.
- **Heartbeat / no-op MLLP frame** (Area 3 Option 5): defer indefinitely — not in MLLP spec; competing engines won't recognize it. Document in DOCS-06 anti-feature table as "intentionally not implemented; use both keepalive options instead".
- **Configurable `inFlightOnReconnect`** (Area 2 Option 4): defer indefinitely — option-explosion violates the stable-codes guardrail. The hybrid asymmetric rule (D-08) handles every observed real-world peer behavior.
- **Per-message priority queue / out-of-order send** — not in v1 requirements; CLIENT-17 implies FIFO insertion.
- **Send-side frame batching** — not in v1; one logical message per `send()` call.
- **Persistent reconnect queue (disk-backed)** — explicitly out of scope (PROJECT.md anti-feature; use BullMQ/Mirth if you need this).

</deferred>

---

*Phase: 05-mllp-client*
*Context gathered: 2026-04-30 (advisor mode, full_maturity calibration)*
