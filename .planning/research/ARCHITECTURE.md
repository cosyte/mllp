# Architecture Research — `@cosyte/hl7-mllp`

**Domain:** Node.js network-protocol library (MLLP client + server over TCP/TLS) — transport-only sibling to `@cosyte/hl7`.
**Researched:** 2026-04-22
**Confidence:** HIGH for layering and state-machine recommendations (multiple mature libs cross-checked); MEDIUM for backpressure-units and AsyncIterable recommendations (opinionated calls between two defensible options); HIGH for TLS-as-separate-class and subpath exports recommendations (verified against Node docs + tsup docs).

---

## Executive Summary

The proposed layering (`framing/` → `transport/` → `server/` + `client/` → `ack-from-hl7/` + `testing/`) matches the mature-library convention: `ws` puts framing in a `sender`/`receiver` pair, `mysql2` puts framing in a `packets` module, `undici` puts HTTP parsing in a WASM parser peer to the Client. None of them share the state machine between "Transport" and "Public Client" — the FSM lives on the connection wrapper, and the public Client composes one. Our sketch does this correctly.

The single biggest recommendation is to **expand the 4-state FSM to a 6-state FSM** (`CONNECTING` / `CONNECTED` / `DRAINING` / `DISCONNECTED` / `RECONNECTING` / `CLOSED`) — without `RECONNECTING` the client's auto-reconnect loop has nowhere to live in the state space (right now it must either stay in `DISCONNECTED` or drop back into `CONNECTING`, neither of which is honest), and without a terminal `CLOSED` state a consumer cannot tell "temporarily down, will come back" from "user-destroyed, never again."

The second recommendation is to add an explicit `maxFrameSizeBytes` cap on the `FrameReader` (currently unbounded — a DoS vector) and extend REQ-FRAME/ERR accordingly.

The third is to **keep TLS as a separate `TlsTransport` class, not a flag on `NetTransport`.** Node's `tls.connect` and `net.connect` have non-trivially different options objects, different error-surface semantics during handshake, and Node's own issue tracker documents that wrapping is lossy. Two classes behind one interface is correct.

Everything else is a small refinement (buffering owner, ACK correlation data structure, `AbortSignal` threading) rather than a structural change.

---

## Standard Architecture

### System Overview

```
┌───────────────────────────────────────────────────────────────────────┐
│                          Public API Layer                              │
├───────────────────────────────────────────────────────────────────────┤
│  ┌──────────────────┐            ┌────────────────────┐                │
│  │  createServer()  │            │  createClient()    │                │
│  │  MllpServer      │            │  MllpClient        │  (composition) │
│  └────────┬─────────┘            └─────────┬──────────┘                │
│           │ composes                       │ composes                  │
├───────────┼────────────────────────────────┼───────────────────────────┤
│           │       Connection Layer         │                           │
├───────────┼────────────────────────────────┼───────────────────────────┤
│  ┌────────▼────────────────────────────────▼─────────┐                 │
│  │           Connection  (6-state FSM,               │                 │
│  │           connectionId, lifecycle events,          │                 │
│  │           owns one FrameReader, owns one           │                 │
│  │           write-queue, surfaces warnings)          │                 │
│  └───────────┬────────────────────────┬──────────────┘                 │
│              │ uses                   │ uses                            │
├──────────────┼────────────────────────┼────────────────────────────────┤
│              │    Transport Layer     │                                 │
├──────────────┼────────────────────────┼────────────────────────────────┤
│  ┌───────────▼─────────┐   ┌──────────▼──────────┐                     │
│  │   Transport (iface) │◄──┤  FrameReader        │  (stateful byte     │
│  │   ├─ NetTransport   │   │  FrameWriter        │   codec — pure;     │
│  │   ├─ TlsTransport   │   │  WarningFactory     │   no sockets)       │
│  │   └─ InMemoryTrans  │   └─────────────────────┘                     │
│  └─────────────────────┘                                                │
├───────────────────────────────────────────────────────────────────────┤
│                          Byte Codec Layer                              │
│                  (framing/ — zero deps, pure fns)                      │
└───────────────────────────────────────────────────────────────────────┘

Opt-in subpath:
    @cosyte/hl7-mllp/ack-from-hl7    — peer-dep-aware ACK builders
    @cosyte/hl7-mllp/testing         — re-exports InMemoryTransport
```

### Component Responsibilities

| Component | Responsibility | Implementation |
|-----------|----------------|----------------|
| `framing/` | Pure byte codec: `encodeFrame(Buffer)`, stateful `FrameReader` state machine (SCANNING_FOR_VT / READING_PAYLOAD / EXPECTING_CR), warning factory, `MllpFramingError`. **No I/O, no sockets, no promises, no events.** | Plain classes + pure functions. Testable in isolation with synchronous byte arrays. |
| `transport/Transport` (iface) | `write(Buffer): Promise<void>`, `close(): Promise<void>`, `destroy(err?): void`, event emission for `data` / `close` / `error`. | TypeScript interface. No implementation. |
| `transport/NetTransport` | Wraps `net.Socket`, translates native events to Transport contract, carries socket options (`keepAlive`, `noDelay`). | ~150 LOC class. Never exposed directly — consumers pass opts, library constructs. |
| `transport/TlsTransport` | Wraps `tls.TLSSocket` via `tls.connect()`. Same Transport contract, but `CONNECTING → CONNECTED` only after handshake. | Peer class to `NetTransport` (see Recommendation #8). |
| `transport/InMemoryTransport` | `pair()` returns two linked ends; `split(n)` forces chunked reads; `pause()`/`resume()`/`destroy()` for deterministic fault injection. | Re-exported via `@cosyte/hl7-mllp/testing`. |
| `connection/Connection` | Owns the 6-state FSM, the `connectionId`, the single `FrameReader` instance, the write-queue, lifecycle-event emission, warning aggregation. The Connection is instantiated **once per accepted TCP connection** (server side) or **once per `connect()` attempt — recreated on reconnect** (client side). | Class extending a typed emitter. Holds one Transport + one FrameReader. |
| `server/MllpServer` | Owns `net.createServer()` (or `tls.createServer()`), accepts connections, wraps each in a `Connection` with a fresh `FrameReader`, surfaces `connection` / `message` events, implements auto-ACK, graceful `close({ drainTimeoutMs })`. | ~200 LOC class. Composes `Connection` + `FrameReader`. |
| `client/MllpClient` | Single-connection client: `connect()`, `send(buf) → Promise<Buffer>`, ACK correlation (FIFO default, controlId opt-in), backpressure queue, exponential-backoff reconnect (state: `RECONNECTING`). Instantiates a fresh `Connection` per reconnect attempt. | ~400 LOC class. The most behavior-heavy component. |
| `ack-from-hl7/` | Peer-dep-coupled ACK builders. Two entry signatures: (a) `buildAckAA(hl7Message)` when `@cosyte/hl7` is installed; (b) `buildAckAA({ controlId, sendingApp, ... })` plain-object fallback. Isolated behind a subpath export so the main bundle does not reference `@cosyte/hl7`. | Separate entry file, separate build target. |
| `testing/` | Re-exports `InMemoryTransport` (and any other test utilities) from the `/testing` subpath. Zero new code — pure re-export. | One file. |
| `errors/` | `MllpFramingError`, `MllpConnectionError`, `MllpTimeoutError`, `MllpBackpressureError`. One file, one export barrel. | Class hierarchy with stable `code` strings. |

---

## Recommendation #1 — Layering

**Audit of mature Node socket/protocol libraries:**

| Library | Framing lives in | State machine lives on | Public class composes |
|---------|------------------|------------------------|-----------------------|
| **`ws`** | `lib/sender.js` + `lib/receiver.js` — peer files to `websocket.js` | On `websocket.js` (readyState: CONNECTING/OPEN/CLOSING/CLOSED) | WebSocket composes Receiver + Sender + net.Socket. No separate "Connection" wrapper. |
| **`mysql2`** | `lib/packets/*` — peer to `lib/connection.js` | On `Connection` class (has a command queue and per-packet state) | Connection composes Packet parser + net.Socket directly. |
| **`ioredis`** | Inside `Redis.ts` (protocol parsing is `RedisParser`, a separate module) | 7-state FSM on the `Redis` class itself (see #2) | `Redis` class composes `RedisParser` + `Connector` (the TCP/TLS abstraction). |
| **`undici`** | `lib/llhttp` (WASM parser — peer module) | On `Client` (internal `_connecting` / `_needDrain` / `_closed` flags — not a single enum) | `Client` composes `llhttp` parser + `net.Socket`/`tls.TLSSocket`. |
| **`pg`** | `Connection` does protocol IO; framing is inside `lib/connection.js` (mixed) | Implicit — `Client` wraps `Connection`; readyForQuery is the transition signal | `Client` composes `Connection`; `Pool` composes N `Client`s. |

**What converges:**
1. Framing is **always** its own module (`ws/sender+receiver`, `mysql2/packets`, `ioredis/RedisParser`, `undici/llhttp`). Our `framing/` is standard.
2. The state machine lives on **one class**, not spread between transport and public API. That class is either the public Client (ws, ioredis, undici) or a Connection wrapper (mysql2, pg).
3. None of them expose a formal `Transport` interface to consumers — it's internal. `undici` is the closest: it has a `Dispatcher` abstraction. Our `Transport` interface exposed via `/testing` is a pragmatic choice for testability — equivalent to undici's `MockAgent` pattern.

**Verdict on our sketch:**

> **Keep the proposed layering with one correction: the state machine lives on `Connection`, and `MllpClient`/`MllpServer` each *compose* a Connection (or recreate one on reconnect).** Do not duplicate state tracking between Client and Connection.

**Recommendation:**
- `framing/` — pure byte codec — **CORRECT as sketched** (matches ws, mysql2, ioredis).
- `transport/` — contains the Transport interface + NetTransport/TlsTransport/InMemoryTransport. **CORRECT.**
- `connection/` — **add this folder.** Today the roadmap bundles `Connection` into Phase 3 alongside transport. Splitting it into `src/connection/` makes the responsibility cut explicit: transport carries bytes, connection carries *state*.
- `server/` and `client/` — composition layers. **CORRECT as sketched.**
- `ack-from-hl7/` and `testing/` — separate subpath entry files. **CORRECT.**

**Changes to ROADMAP:**
- Phase 3 Plan list should explicitly split: Plan 03-01 = Transport; Plan 03-02 = InMemoryTransport; Plan 03-03 = **Connection class (new module `src/connection/`)**; Plan 03-04 = close/destroy semantics. The roadmap already has 4 plans — this is a rename/re-scoping, not a new plan.

---

## Recommendation #2 — State Machine

**Committed set:** `CONNECTING` / `CONNECTED` / `DRAINING` / `DISCONNECTED` (4 states).

**Comparison:**

| Library | States | Notes |
|---------|--------|-------|
| **`ws` WebSocket** | `CONNECTING` / `OPEN` / `CLOSING` / `CLOSED` (4) | Matches WHATWG DOM spec. No RECONNECTING — ws does not auto-reconnect. |
| **`ioredis`** | `wait` / `connecting` / `connect` / `ready` / `reconnecting` / `close` / `end` (7) | Separates "socket up" (`connect`) from "ready for commands" (`ready`). Separate `close` (temporarily down, may reconnect) and `end` (terminal). |
| **`pg`** (Client) | Implicit — `connected`/`_connecting`/`_queryable` flags, not a formal enum | No terminal state distinction from transient close. |
| **`mysql2`** | Implicit via internal `_closing`/`_fatalError` flags + command-queue state | "Can't add command when connection is in closed state" error is driven by these flags. |
| **`undici`** (Client) | Internal flags `_connecting`/`_needDrain`/`_closed`/`_destroyed` (no enum) | Pool has more states per-socket. |

**What our 4-state set misses:**

1. **`RECONNECTING`** — with `autoReconnect: true`, between a dropped connection and the next `CONNECTING` attempt, the client is neither connected nor permanently disconnected. Today the roadmap's REQ-CLIENT-05 says "`DISCONNECTED → CONNECTING` after an exponential-backoff delay." But during the backoff delay the state is `DISCONNECTED` — which is **also** the terminal state after `client.destroy()`. A consumer cannot tell "my client is permanently dead" from "my client will retry in 24 seconds." This is ioredis's exact motivation for splitting `close` (reconnecting) from `end` (terminal).
2. **Terminal vs transient.** Analogous to ioredis `end`, we need a state that means "the user called `client.destroy()` or `server.close()`; this object will not transition again."

**What our 4-state set does *not* need:**

- `HALF_OPEN` — Node's `net.Socket` has a `allowHalfOpen` flag, but MLLP is strictly request/response. Half-open adds no semantic value; treat half-open as `DRAINING`.
- `READY` (separate from `CONNECTED`) — ioredis needs this because Redis has a post-connect handshake (`AUTH`, `SELECT`). MLLP has no handshake beyond TCP/TLS. Skip.
- `CLOSING` (separate from `DRAINING`) — `DRAINING` covers it. `ws`'s `CLOSING` is exactly our `DRAINING`.

**Recommended state set (6 states):**

```
CONNECTING   — TCP/TLS handshake in progress. Timers active.
CONNECTED    — Handshake complete. Sending/receiving allowed.
DRAINING     — close() called; no new sends accepted; waiting for in-flight ACKs / write flush.
DISCONNECTED — Connection dropped, reconnect NOT scheduled (or autoReconnect=false).
               Terminal IF autoReconnect is false; transient otherwise (→ RECONNECTING on next tick).
RECONNECTING — autoReconnect=true, backoff timer active, next attempt scheduled.
               Outgoing sends queue up to highWaterMark.
CLOSED       — Terminal. User called destroy() (client) or close() finished (server).
               Further state changes forbidden. All pending sends rejected.
```

**Transition edges:**

```
(initial)              → CONNECTING
CONNECTING             → CONNECTED        (handshake success)
CONNECTING             → DISCONNECTED     (handshake fail, autoReconnect=false)
CONNECTING             → RECONNECTING     (handshake fail, autoReconnect=true)
CONNECTING             → CLOSED           (destroy() during CONNECTING)
CONNECTED              → DRAINING         (close() called)
CONNECTED              → DISCONNECTED     (socket error/reset, autoReconnect=false)
CONNECTED              → RECONNECTING     (socket error/reset, autoReconnect=true)
CONNECTED              → CLOSED           (destroy() — abrupt)
DRAINING               → CLOSED           (drain complete or drainTimeout elapsed)
DRAINING               → CLOSED           (destroy() during drain — abrupt)
DISCONNECTED           → CLOSED           (destroy() from DISCONNECTED)
RECONNECTING           → CONNECTING       (backoff elapsed, attempt fires)
RECONNECTING           → CLOSED           (destroy() during RECONNECTING)
CLOSED                 → (none — terminal)
```

**Why 6 and not 5 or 7:**

- 4 states (current): conflates "transient disconnect with pending retry" and "permanently dead." Bug magnet.
- 5 states (add `RECONNECTING`, no `CLOSED`): consumer still can't tell "will come back" from "destroyed" *after* the retry count is exhausted. `CLOSED` disambiguates.
- 7 states (ioredis-style): `READY` and `WAIT` are redundant for MLLP. Don't add.

**Changes to existing REQs:**

| REQ-ID | Current | Proposed |
|--------|---------|----------|
| **LIFE-01** | "`'CONNECTING' \| 'CONNECTED' \| 'DRAINING' \| 'DISCONNECTED'`" | Expand to 6-state union. |
| **LIFE-02** | Lists `CONNECTING → CONNECTED`, `CONNECTED → DRAINING`, `DRAINING → DISCONNECTED`, "any → DISCONNECTED on error" | Add `CONNECTED/CONNECTING → RECONNECTING` (autoReconnect), `RECONNECTING → CONNECTING`, `DRAINING → CLOSED`, `DISCONNECTED → CLOSED`, "any non-terminal → CLOSED on destroy()". |
| **CLIENT-05** | "transitions `DISCONNECTED → CONNECTING` after an exponential-backoff delay" | Correct wording: "transitions `CONNECTED/CONNECTING → RECONNECTING` on drop; `RECONNECTING → CONNECTING` when backoff elapses." |
| **CLIENT-09** | `destroy()` "transitions directly to `DISCONNECTED`" | Correct wording: "transitions directly to `CLOSED`." |
| **SERVER-06** | `close()` "closes any connection that does not drain within `drainTimeoutMs`" | No change in behavior; terminal state is `CLOSED`. |

**Migration risk:** Low. All changes are additive to the state enum; the four existing states keep their names and meanings. Consumer code that does `if (conn.state === 'CONNECTED')` does not break.

---

## Recommendation #3 — Event Model

**Landscape (2026):**

Since July 2024 `@types/node` exposes `EventEmitter<T>` as a generic directly on the stdlib class. This is now the idiomatic choice for a library that sticks with Node's native emitter. Previously the standard answer was `strict-event-emitter-types` (by Brian Terlson) or hand-rolling a `TypedEventEmitter`; neither is needed in 2026.

**Trade-offs:**

| Option | Pros | Cons |
|--------|------|------|
| **Native `EventEmitter<Events>`** (Node 18+ with `@types/node` ≥ Jul 2024) | Zero deps; matches the rest of Node stdlib (`net.Server` emits are typed the same way); familiar API (`.on('message', ...)`); works fine for async listeners. | Loose semantics around error handling (throwing listeners crash the process unless caught); no built-in backpressure. |
| **`EventTarget` + `CustomEvent`** | DOM-compatible; works in browsers | MLLP is Node-only; `EventTarget` listeners can't receive multiple positional args naturally; ecosystem still prefers `EventEmitter`. |
| **Hand-rolled typed emitter** | Full control, compact surface | Reinvents `on/off/once`; loses Node interop (`events.on()` async iterator — see #4). |
| **Third-party typed wrappers** (`typed-emitter`, `strict-event-emitter-types`) | Stronger inference on complex event maps | Adds a dev-time type-only dep with no real benefit over native generics in 2026. Most are in maintenance mode. |

**Recommendation:**

> **Use `EventEmitter<Events>` from `node:events` with a typed event-map interface, for every publicly observable surface (`MllpServer`, `MllpClient`, `Connection`).** Expose the `.on()` / `.once()` / `.off()` surface as the canonical pattern. Keep the `onWarning` / `onMessage` option-bag hooks from REQ-WARN-06 / REQ-SERVER-03 as convenience shortcuts that register a listener internally.

**Concrete signatures:**

```typescript
// src/connection/events.ts
export interface ConnectionEvents {
  stateChange: [change: { from: ConnectionState; to: ConnectionState; reason: string }];
  message: [payload: Buffer, meta: MessageMeta];
  ack: [payload: Buffer, meta: MessageMeta];
  warning: [warning: MllpWarning];
  error: [error: MllpError];
  disconnect: [reason: string];
  close: [];                              // for CLOSED terminal
  reconnecting: [info: { attempt: number; nextDelayMs: number }];
}

// src/connection/connection.ts
import { EventEmitter } from 'node:events';
export class Connection extends EventEmitter<ConnectionEvents> {
  // .on('message', (payload, meta) => ...)     — typed
  // .on('stateChange', ({ from, to }) => ...)  — typed
}
```

**Impact on REQs:** None — REQ-LIFE-03 already lists the event names. This recommendation fixes the *typing strategy* for Phase 1 scaffold.

---

## Recommendation #4 — Async Model (Promises, AbortSignal, AsyncIterable)

### 4a. Promises on every public method — CONFIRMED

Matches 2026 idiom. `pg.Client.query()`, `undici.request()`, `net.Socket` (via `stream/promises`), `ws.WebSocket.send()` in strict mode — all return promises. Callbacks-only is no longer a credible API style for new libraries.

### 4b. `AbortSignal` on every awaitable — CONFIRMED WITH NUANCE

Recommend AbortSignal on:
- `client.connect({ signal })`
- `client.send(buf, { signal, ackTimeoutMs })` — `signal` layers over `ackTimeoutMs` via `AbortSignal.any([signal, AbortSignal.timeout(ackTimeoutMs)])`
- `server.listen(port, { signal })`
- `server.close({ signal, drainTimeoutMs })`

Do NOT put `AbortSignal` on synchronous methods (`conn.send()` on the server side when it's purely a write-flush with no ACK wait). `AbortSignal` on a hot path adds 2 listener registrations per call — measurable at 1,000 msg/s.

**Idiomatic pattern (per Node.js blog, 2025):**

```typescript
async send(payload: Buffer, opts: SendOptions = {}): Promise<Buffer> {
  const { signal, ackTimeoutMs = 30_000 } = opts;
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  const timeoutSignal = AbortSignal.timeout(ackTimeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  // ... register handler on `combined`, cleanup in finally
}
```

**Changes to existing REQs:** None — REQ-CLIENT-04 already mentions `ackTimeoutMs`. This adds the `signal` field to the existing `SendOptions` interface (backwards-compatible).

### 4c. Server message stream: AsyncIterable vs EventEmitter

**The real question:** when a server accepts a connection, how does a consumer read inbound messages?

| Option | Example ecosystem | Fit for MLLP |
|--------|-------------------|--------------|
| **`.on('message', cb)` callback** | `ws`, `ioredis`, `mysql2` | Native; simple; allows multiple concurrent listeners. |
| **`async function* () { for await (const msg of conn) }`** | `net.Socket` via `stream/promises`; `events.on()` | Clean; but serializes consumption (one handler loop); harder to fan out. |
| **Return a `Readable<Buffer>` stream** | `http.IncomingMessage` | Backpressure via `.pause()/resume()` is native. But consumer has to reassemble frames themselves — antithetical to our "we own framing" promise. |

**Recommendation:**

> **Primary surface: `.on('message', (payload, meta) => ...)` callback-based, matching ws/ioredis/mysql2.** Also provide `events.on(conn, 'message')` interop (no extra code — Node's `events.on()` works against any `EventEmitter` for free), which gives consumers the AsyncIterable pattern when they want it:

```typescript
import { on } from 'node:events';

for await (const [payload, meta] of on(conn, 'message', { signal })) {
  // ...
}
```

This "one library, both patterns" approach is what `undici` landed on after wavering: primary API is callbacks/promises, with stream/iterable interop for free by virtue of being an `EventEmitter`.

**Changes to REQs:** None. REQ-SERVER-03 already specifies `.on('message', ...)`. Just document the `events.on()` interop in the README (Phase 8 / DOCS-04).

---

## Recommendation #5 — Buffering Boundaries and Frame Size Cap

**Where the buffer lives:**

The `FrameReader` carries an internal `Buffer` accumulator (byte offset + partial-frame state). Per mature-library convention:

- `ws`'s `Receiver` is one-per-connection. Constructed in `WebSocket`'s constructor or when the server accepts a connection.
- `mysql2`'s packet parser is one-per-`Connection`.
- `undici`'s llhttp parser instance is one-per-`Client`.

**Recommendation:**

> **The `Connection` class owns exactly one `FrameReader` instance, constructed at connection start, destroyed at terminal state. The `Server` / `Client` do not touch FrameReader directly.**

This matches REQ-FRAME-06 already ("FrameReader carries an internal byte offset"). The architectural clarification is: the offset is **per connection, monotonic from the moment the TCP connection opens, and reset on reconnect** (the new Connection gets a new FrameReader).

### Frame size cap — DoS prevention

**This is missing from the current REQ set.** Discovered via the `hl7v2-rs` security advisory (GitHub issue) and the Python-hl7 `read_stream` bug — unbounded inbound buffers are a documented MLLP foot-gun. Large OBX images legitimately reach 10+ MB; a malicious peer can send `VT` followed by an infinite payload with no `FS` and watch your process OOM.

**Recommendation:**

> **Add a `maxFrameSizeBytes` option to `FrameReader`, `MllpServer`, and `MllpClient`. Default: 16 MB. When exceeded mid-frame, emit `MllpFramingError({ code: 'MLLP_FRAME_TOO_LARGE', byteOffset, limit })` and transition the Connection to `DISCONNECTED` (or `RECONNECTING` per policy).**

**New requirements to add to REQUIREMENTS.md:**

- **FRAME-11** — `FrameReader` enforces a configurable `maxFrameSizeBytes` cap (default 16 MB). When an in-progress frame exceeds the cap, the reader throws `MllpFramingError({ code: 'MLLP_FRAME_TOO_LARGE', byteOffset, limit })` and its accumulator is reset. *Phase 2.*
- **WARN-09** — `MLLP_FRAME_TOO_LARGE` is a stable warning/error code exported alongside the others. *Phase 2.*

**Changes to ROADMAP:** These ride inside existing Phase 2 plans (02-PLAN-03 FrameReader state machine). No phase restructuring needed.

---

## Recommendation #6 — ACK Correlation Data Structure

**Two modes (REQ-CLIENT-03):**

1. **FIFO (default):** outgoing sends resolve in the order they were enqueued, against each inbound ACK in order. No controlId lookup.
2. **ControlId (opt-in):** on outbound, extract MSH-10; on inbound, match MSA-2.

### FIFO path

Data structure: a **singly-linked list queue** of `PendingSend` nodes. Not a JS `Array` used as a queue — `Array.prototype.shift()` is O(n) on V8 for non-small arrays. Linked list gives O(1) enqueue and dequeue.

```typescript
interface PendingSend {
  resolve: (ack: Buffer) => void;
  reject: (err: Error) => void;
  timeoutTimer: NodeJS.Timeout;
  controlId?: string;  // populated iff correlateByControlId is true
  byteLength: number;  // for byte-based backpressure (see #7)
  next: PendingSend | null;
}
```

### ControlId path

Data structure: a `Map<string, PendingSend>` **plus** the same linked-list queue for insertion order. Two reasons:
1. The Map is the lookup index (O(1) on MSA-2).
2. The queue is needed to find the head-of-line for "ACK with unknown controlId — advance head? fail the oldest? per REQ-CLIENT-03 policy."

Both structures reference the same `PendingSend` objects (one node, two collections). Removal from both is still O(1) because the node carries `next/prev` pointers.

### Timeouts

Each `PendingSend` carries its own `timeoutTimer` (set via `setTimeout(reject, ackTimeoutMs)`). **Do not use a single global timeout wheel** — Node's `setTimeout` is already hashed internally for timer efficiency, and per-pending-send timers let you cancel precisely on resolve/reject without sweeping.

### What happens when both modes active

They are strictly either-or. The Client constructor switches implementation strategy once based on `correlateByControlId`. At runtime, one code path runs. No "both at once" complexity.

### Why not just a JS `Array`

For typical HL7 workloads (≤ 64 in-flight), `Array.shift()` is plenty fast. Linked-list matters at the tail (thousands in-flight) or when you want guaranteed O(1) irrespective of queue depth — which matters for backpressure-under-overload testing (TEST-06). Also: linked-list with doubly-linked nodes lets you cancel a middle element (timeout expiry) in O(1). Array-based would be O(n) to splice.

**Changes to REQs:** None. REQ-CLIENT-03 and REQ-CLIENT-04 and REQ-CLIENT-07 remain as-is; this is an implementation-detail recommendation for Phase 5 plans 05-02/05-03/05-05.

---

## Recommendation #7 — Backpressure Structure

**Question A — count of messages vs total bytes:**

Comparison:
- **undici** measures backpressure in *request count* per Client (`pipelining`) and uses Node stream `writableNeedDrain` for byte-level.
- **Node streams** use `highWaterMark` in bytes for Writable.
- **ioredis** has a command queue with no size cap by default.

**Recommendation:**

> **Dual watermarks, both configurable. Default to count-based.**

```typescript
interface BackpressureOptions {
  highWaterMarkInFlight?: number;     // default: 64 messages
  highWaterMarkBytes?: number;        // default: Infinity (opt-in)
  onBackpressure?: 'reject' | 'wait'; // default: 'reject'
}
```

Rationale:
- Count-based default matches REQ-CLIENT-07 as-written (64 in-flight). Simple, predictable, matches user intuition ("my queue hit 64 sends").
- Bytes-based is opt-in for shops shipping OBX images. A single 20 MB OBX + 64 in-flight gives 1.3 GB of queued buffers — easy OOM. Byte cap is a second safety belt.
- Either limit trips `onBackpressure`.

### Question B — `wait` policy implementation

**Not** `AsyncLocalStorage` (wrong tool — that's for context propagation).
**Not** a busy-wait loop.

**Recommendation:**

> **Implement `wait` as a Promise that resolves on a `'drain'` event from the Connection. Use `Promise.race` to combine the drain wait with the per-message timeout.**

```typescript
// Pseudocode inside send()
if (queueDepth >= highWaterMark && opts.onBackpressure === 'wait') {
  const drainPromise = new Promise<void>((resolve) => {
    conn.once('drain', resolve);
  });
  const timeoutPromise = new Promise<never>((_, reject) => {
    AbortSignal.timeout(ackTimeoutMs).addEventListener('abort', () =>
      reject(new MllpTimeoutError({ messageControlId, elapsedMs: ackTimeoutMs }))
    );
  });
  await Promise.race([drainPromise, timeoutPromise]);
}
// Proceed to enqueue + write.
```

The Connection emits `'drain'` when `queueDepth` crosses back below a low-water mark (typically `highWaterMark / 2` — standard practice to avoid event-storm oscillation).

**Changes to REQs:**
- Augment **CLIENT-07** to mention both watermark dimensions (bytes optional, count default).
- Add a stable `'drain'` event to **LIFE-03**'s event list.
- Both fit in existing Phase 5 Plan 05-05 (backpressure).

---

## Recommendation #8 — TLS: Separate Class, Not a Flag

**Evidence:**

- Node docs (`tls.TLSSocket`): "TLSSocket is a wrapped version of net.Socket that does transparent encryption" — but multiple GitHub issues (`nodejs/node#30468`, `#3963`, `#8752`) document that *wrapping an existing `net.Socket` in a `tls.TLSSocket`* is subtly broken in ways that `tls.connect()` directly is not.
- **`pg`'s approach:** `ssl: true` on the Client; internally pg goes through the Postgres-specific SSL negotiation handshake (`SSLRequest` message) **before** handing off to `tls.connect()`. This works for pg because Postgres invented its own SSL upgrade protocol. **MLLP has no SSL upgrade — it's either TLS from byte zero or it's not.**
- **`undici`'s approach:** TLS is driven by the origin URL (`https://` vs `http://`). Internally, separate code paths: the Dispatcher constructs either a `net.Socket` or a `tls.TLSSocket` at the `connect()` boundary.
- **`ws`'s approach:** `WebSocket` constructor takes a URL; `wss://` routes to `tls.connect()`, `ws://` to `net.connect()`. Same underlying codepath, different connector.
- **`mysql2`'s approach:** `ssl: {...}` option; internally, separate `TlsConnection` path selected at connect time.

**The pattern:** every mature lib makes the *caller-facing* option a single flag (`ssl: {...}` / `tls: {...}` / `wss://`), but the *internal implementation* fans out to two separate code paths at the TCP/TLS boundary.

**Recommendation:**

> **Keep two Transport classes internally (`NetTransport`, `TlsTransport`), but the caller-facing API passes `{ tls: {...tlsOptions} }` to `createClient` / `createServer` — the library picks the transport. This is transparent to users; they don't see the Transport classes.** The `InMemoryTransport` is the third peer.

Public API (no change from REQ-TLS-01/02):
```typescript
createClient({ host, port, tls: { ca, cert, key, servername, rejectUnauthorized } })
createServer({ tls: { key, cert } })
```

Internal factory:
```typescript
// src/transport/factory.ts
export function createTransport(opts: TransportOptions): Transport {
  if ('tls' in opts && opts.tls) return new TlsTransport(opts);
  return new NetTransport(opts);
}
```

**Rationale:**
1. `net.Socket` and `tls.TLSSocket` diverge significantly during the handshake phase — the state transition `CONNECTING → CONNECTED` requires listening for `'connect'` on `net.Socket` but `'secureConnect'` on `tls.TLSSocket`. A single class with an `if (isTls)` branch turns into a tangle.
2. Error mapping differs. Handshake failure on `net` is an ECONNREFUSED; on TLS it's a cert-validation or `tls.TLSSocket` error. Separate classes let each map to `MllpConnectionError({ phase: 'connect', cause })` cleanly.
3. Options objects differ. `NetConnectOptions` vs `TlsConnectOptions` have ~20 disjoint fields. Collapsing into one options object invites type gymnastics.

**Changes to ROADMAP:**
- Phase 3 scaffolds the `Transport` interface + `NetTransport` + `InMemoryTransport` (already planned).
- Phase 6 adds `TlsTransport` (already planned as 06-PLAN-03). **No change needed** — keep the separate-class design.
- Phase 3 plan 03-01 should stub a `TlsTransport` type import so the factory's return type is known ahead of Phase 6 — avoids a Phase 6 retrofit of the factory signature.

**Changes to REQs:** None. REQ-TRANS-01, REQ-TLS-01..04 are all consistent with this.

---

## Recommendation #9 — Subpath Exports (`package.json#exports`)

**Current state of the art (2026) for TypeScript dual ESM+CJS packages with subpath entries:**

1. Each subpath needs its own `tsup` entry.
2. `exports` uses conditional exports with `types` FIRST in each condition block (TypeScript resolution bug — `types` must be first or consumers on older `moduleResolution: node16/nodenext` break).
3. `typesVersions` is no longer needed if `exports.types` is set correctly and packager is recent.
4. Per `johnnyreilly` / `arethetypeswrong.github.io`: ship `.d.cts` AND `.d.mts` (or a single `.d.ts` if tsup's dual emission is configured). `tsup` handles this via `dts: true` + per-format output.

### Concrete `package.json#exports`

```json
{
  "name": "@cosyte/hl7-mllp",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.mjs",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.mjs",
      "require": "./dist/index.cjs"
    },
    "./testing": {
      "types": "./dist/testing.d.ts",
      "import": "./dist/testing.mjs",
      "require": "./dist/testing.cjs"
    },
    "./ack-from-hl7": {
      "types": "./dist/ack-from-hl7.d.ts",
      "import": "./dist/ack-from-hl7.mjs",
      "require": "./dist/ack-from-hl7.cjs"
    },
    "./package.json": "./package.json"
  },
  "files": ["dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "peerDependencies": {
    "@cosyte/hl7": "^0.1.0"
  },
  "peerDependenciesMeta": {
    "@cosyte/hl7": { "optional": true }
  }
}
```

### Corresponding `tsup.config.ts`

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    testing: 'src/testing/index.ts',
    'ack-from-hl7': 'src/ack-from-hl7/index.ts',
  },
  format: ['esm', 'cjs'],
  outDir: 'dist',
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'es2022',
  platform: 'node',
  treeshake: true,
  splitting: false,
  minify: false,
  shims: false,
  skipNodeModulesBundle: true,
  // Ensure `@cosyte/hl7` is NEVER bundled into the ack-from-hl7 entry.
  external: ['@cosyte/hl7'],
});
```

### Why this structure works

- **`types` first in each exports condition block** — required for TS 5.0+ under `moduleResolution: nodenext`. Missing this is the #1 cause of "my types work locally but not after publish."
- **`./package.json` export** — required by certain bundlers (Vite, Next.js) that read package.json of dependencies.
- **`external: ['@cosyte/hl7']`** — ensures the parser peer dep is NOT bundled into `ack-from-hl7.mjs`. Required by REQ-SETUP-03.
- **Three separate entries, not subpath via `src/index.ts` re-export** — subpaths must be their own tsup entries so they become their own bundle files. A single bundle with multiple re-exports defeats tree-shaking.

**Verification plan (Phase 1 / Phase 8):**
Run `pnpm dlx @arethetypeswrong/cli --pack` as a CI step after `pnpm publish --dry-run`. This is the definitive check for dual-publish correctness in 2026. Add as a gate in DOCS-05.

**Changes to REQs:**
- **SETUP-02** covers this already. Recommend adding to the existing check: "and `@arethetypeswrong/cli` passes on the packed tarball." This is a sub-check, not a new REQ.

---

## Recommendation #10 — Build Order / DAG Revision

**Current DAG (from ROADMAP):**

```
1 → 2 → 3 → {4, 5} → 6 → 7 → 8
```

Phase 6 depends on 2, 4, AND 5. Phase 7 depends on 2, 3, 4, 5, 6. Phase 8 depends on 7.

### Question A — Can Phase 4 (Server) and Phase 5 (Client) parallelize with a stub Connection?

**No, and you shouldn't try.** Justification:

- `Connection` (Phase 3) owns the 6-state FSM, the FrameReader binding, the write-queue, lifecycle events. **Server and Client are both defined as *thin compositions* over Connection.** If you stub Connection, you stub the actual behavior — the server and client become placeholders, not parallelizable work.
- Instead, Phase 4 and Phase 5 **already parallelize with each other** (roadmap is correct). That's the valuable parallelism. Don't try to further subdivide by stubbing Phase 3.

### Question B — Does Phase 6 (ACK Helpers + TLS) genuinely need Phases 4 AND 5?

**Phase 6 is two unrelated concerns bundled together.** Let me separate:

- **ACK Helpers** (`buildAckAA/AE/AR`) — pure functions over HL7 MSH fields. Depends on **Phase 2** only (framing: the output of `buildAckAA` is a Buffer that will be framed via `encodeFrame`). Does NOT depend on Phase 4 (server) or Phase 5 (client) — the helpers are standalone pure functions. The peer-dep adapter is a thin wrapper.
- **TLS** — a new Transport implementation. Depends on **Phase 3** (Transport interface). Its *integration* into Server and Client requires Phases 4 and 5, but writing the `TlsTransport` class itself only needs Phase 3.

### Revised DAG

```
Phase 1 → Phase 2 → Phase 3 ─┬─→ Phase 4 (Server) ─────────────┐
                              ├─→ Phase 5 (Client) ─────────────┤
                              └─→ Phase 6a (TlsTransport) ──────┤
                                                                 │
Phase 2 → Phase 6b (ACK Helpers) ────────────────────────────────┤
                                                                 ▼
                                                            Phase 6c (integration: wire TLS into
                                                                     Server+Client, wire auto-ACK
                                                                     helper into Server)
                                                                 │
                                                                 ▼
                                                             Phase 7 → Phase 8
```

**What this changes:**

- Phase 6a (TlsTransport class) can start as soon as Phase 3 lands — parallel with Phase 4 and Phase 5.
- Phase 6b (ACK helpers + subpath adapter) can start as soon as Phase 2 lands — parallel with Phase 3, 4, 5.
- Phase 6c is the only sub-phase that genuinely needs 4, 5, and the two 6a/6b deliverables.

**Pragmatic interpretation:** if the project is single-threaded (one developer), keep the existing ROADMAP DAG — the gains are marginal. The revision matters if two workstreams are running in parallel.

### Revised plan-level DAG inside ROADMAP

Recommended edit to ROADMAP "Parallelization Notes":

```
- Phase 6 plans can parallelize per the following sub-DAG:
  - 06-PLAN-01 (plain-object ACK builders)       → needs Phase 2 only; can run after Phase 2.
  - 06-PLAN-02 (peer-dep adapter)                → needs 06-PLAN-01.
  - 06-PLAN-03 (TlsTransport class)              → needs Phase 3 only; can run after Phase 3.
  - 06-PLAN-04 (new: integrate TLS + ACK into Server/Client auto-ACK path)
                                                  → needs 06-PLAN-01/02/03, Phase 4, Phase 5.
```

Currently Phase 6 has 3 plans; splitting out an integration plan gives 4 plans and makes the dependency structure honest.

**Changes to ROADMAP:**
- Rewrite Phase 6's `Depends on`: `Phase 2 (ACK helpers), Phase 3 (TlsTransport), Phase 4 + Phase 5 (integration only)`.
- Split current Plan 06-PLAN-03 into two plans as above.
- Update the ASCII "Dependencies" diagram at the bottom of ROADMAP.md.

---

## Recommended Project Structure

```
src/
├── index.ts                          # Public barrel — createServer, createClient, types
├── framing/                          # Pure byte codec (zero I/O, zero events)
│   ├── index.ts                      #   barrel
│   ├── constants.ts                  #   VT=0x0B, FS=0x1C, CR=0x0D, LF=0x0A, DEFAULT_MAX_FRAME_SIZE
│   ├── encode-frame.ts               #   encodeFrame(Buffer): Buffer
│   ├── frame-reader.ts               #   stateful SCANNING_FOR_VT/READING_PAYLOAD/EXPECTING_CR FSM
│   ├── warnings.ts                   #   warning codes, MllpWarning factory, Object.freeze
│   └── warning-codes.ts              #   'MLLP_MISSING_LEADING_VT' | ... union
├── errors/                           # Typed error hierarchy
│   ├── index.ts                      #   barrel
│   ├── framing-error.ts              #   MllpFramingError
│   ├── connection-error.ts           #   MllpConnectionError
│   ├── timeout-error.ts              #   MllpTimeoutError
│   └── backpressure-error.ts         #   MllpBackpressureError
├── transport/                        # Transport abstraction
│   ├── index.ts                      #   barrel (internal — not publicly re-exported)
│   ├── transport.ts                  #   Transport interface
│   ├── net-transport.ts              #   NetTransport (wraps net.Socket)
│   ├── tls-transport.ts              #   TlsTransport (wraps tls.TLSSocket)  [Phase 6a]
│   ├── in-memory-transport.ts        #   InMemoryTransport + pair() + split()
│   └── factory.ts                    #   createTransport({ tls? }) picks Net vs Tls
├── connection/                       # 6-state FSM + lifecycle events [NEW: split from transport]
│   ├── index.ts                      #   barrel
│   ├── state.ts                      #   ConnectionState enum, transition table
│   ├── connection.ts                 #   Connection extends EventEmitter<ConnectionEvents>
│   ├── events.ts                     #   ConnectionEvents interface
│   └── id.ts                         #   connectionId generator (ULID or crypto.randomUUID)
├── server/                           # Server composition layer
│   ├── index.ts                      #   barrel
│   ├── create-server.ts              #   createServer(opts)
│   ├── mllp-server.ts                #   MllpServer class
│   ├── auto-ack.ts                   #   autoAck mode: 'AA' | fn | undefined
│   └── shutdown.ts                   #   graceful close({ drainTimeoutMs })
├── client/                           # Client composition layer
│   ├── index.ts                      #   barrel
│   ├── create-client.ts              #   createClient(opts)
│   ├── mllp-client.ts                #   MllpClient class
│   ├── ack-correlator.ts             #   FIFO queue OR controlId Map (strategy pattern)
│   ├── pending-send.ts               #   PendingSend linked-list node
│   ├── backoff.ts                    #   exponential backoff with jitter calculator
│   └── backpressure.ts               #   highWaterMark enforcement + drain event
├── testing/                          # Subpath entry — /testing
│   └── index.ts                      #   re-export { InMemoryTransport } from '../transport'
└── ack-from-hl7/                     # Subpath entry — /ack-from-hl7
    ├── index.ts                      #   barrel
    ├── build-ack-aa.ts               #   AA ACK builder
    ├── build-ack-ae.ts               #   AE ACK builder
    ├── build-ack-ar.ts               #   AR ACK builder
    ├── err-segment.ts                #   ERR segment builder
    └── from-hl7-message.ts           #   @cosyte/hl7 adapter (peer-dep-aware)

test/
├── framing/                          # Phase 2 tests
├── transport/                        # Phase 3 tests
├── connection/                       # Phase 3 tests
├── server/                           # Phase 4 tests
├── client/                           # Phase 5 tests
├── ack-from-hl7/                     # Phase 6 tests
├── tls/                              # Phase 6 tests
├── fixtures/                         # Phase 7 — ADT^A01, ORU^R01, SIU^S12, MDM^T02, 1MB synthetic
└── integration/                      # Phase 7 — round-trip, chunked-read fuzz, failure-mode

examples/
├── server-basic/                     # DOCS-01
├── client-basic/                     # DOCS-02
└── tls/                              # DOCS-03
```

### Structure Rationale

- **`framing/` is pure** — no I/O, no sockets, no promises. Testable with synchronous byte arrays. Matches `ws/lib/sender.js` + `receiver.js`, `mysql2/lib/packets/`, `ioredis`'s `RedisParser`.
- **`errors/` is a top-level folder** — errors are referenced from every other module; placing them as a peer avoids circular imports.
- **`transport/` is internal** — not re-exported via `src/index.ts`. The public API hides Transport completely; users pass `{ tls?: ... }` opts and the factory picks. `InMemoryTransport` is the one exception, re-exported via `/testing`.
- **`connection/` is split from `transport/`** (new recommendation) — Connection is the state-machine owner, Transport is the byte-carrier. Conflating them (as the current Phase 3 roadmap does) blurs the responsibility cut.
- **`server/` and `client/` are composition layers only** — they compose Connection + FrameReader + auto-ACK/correlator. They do not own state. This matches `ws`'s `WebSocketServer` composing `WebSocket` instances.
- **`testing/` and `ack-from-hl7/` are their own tsup entries** — required for the subpath exports contract (SETUP-02). Never reachable via `from '@cosyte/hl7-mllp'` — only via `from '@cosyte/hl7-mllp/testing'`.

---

## Public API Shape (TypeScript signatures)

```typescript
// src/index.ts — the public surface

// -------- Server --------
export function createServer(opts?: ServerOptions): MllpServer;

export interface ServerOptions {
  autoAck?: 'AA' | ((payload: Buffer, meta: MessageMeta) => Buffer | Promise<Buffer>);
  maxFrameSizeBytes?: number;          // default 16 * 1024 * 1024
  keepaliveIntervalMs?: number;        // default: off
  deadPeerTimeoutMs?: number;          // default: off
  tls?: TlsOptions;                    // routes to TlsTransport if present
  strict?: boolean;                    // REQ-WARN-08: strict framing
  tolerance?: Partial<FramingTolerance>;
  transport?: (socket: net.Socket | tls.TLSSocket) => Transport; // escape hatch
  onWarning?: (w: MllpWarning) => void;
}

export interface MllpServer extends EventEmitter<ServerEvents> {
  listen(port: number, host?: string, opts?: { signal?: AbortSignal }): Promise<void>;
  close(opts?: { drainTimeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  address(): AddressInfo | null;
  readonly connections: ReadonlySet<Connection>;
}

export interface ServerEvents {
  connection: [conn: Connection];
  listening: [info: { port: number; host: string }];
  close: [];
  error: [err: MllpError];
}

// -------- Client --------
export function createClient(opts: ClientOptions): MllpClient;

export interface ClientOptions {
  host: string;
  port: number;
  ackTimeoutMs?: number;               // default 30_000
  correlateByControlId?: boolean;      // default false — FIFO
  autoReconnect?: boolean;             // default true
  reconnect?: BackoffOptions;
  highWaterMarkInFlight?: number;      // default 64
  highWaterMarkBytes?: number;         // default Infinity
  onBackpressure?: 'reject' | 'wait';  // default 'reject'
  maxFrameSizeBytes?: number;          // default 16 * 1024 * 1024
  keepaliveIntervalMs?: number;
  deadPeerTimeoutMs?: number;
  tls?: TlsOptions;
  strict?: boolean;
  tolerance?: Partial<FramingTolerance>;
  onWarning?: (w: MllpWarning) => void;
}

export interface BackoffOptions {
  initialDelayMs?: number;  // default 100
  maxDelayMs?: number;      // default 30_000
  multiplier?: number;      // default 2
  jitter?: number;          // default 0.2
  maxAttempts?: number;     // default Infinity
}

export interface MllpClient extends EventEmitter<ClientEvents> {
  readonly state: ConnectionState;
  readonly connectionId: string;       // current attempt
  connect(opts?: { signal?: AbortSignal }): Promise<void>;
  send(payload: Buffer, opts?: SendOptions): Promise<Buffer>;
  close(opts?: { drainTimeoutMs?: number; signal?: AbortSignal }): Promise<void>;
  destroy(reason?: Error): void;
}

export interface SendOptions {
  ackTimeoutMs?: number;
  awaitAck?: boolean;                  // default true
  signal?: AbortSignal;
}

export interface ClientEvents extends ConnectionEvents {
  reconnecting: [info: { attempt: number; nextDelayMs: number }];
  drain: [];
}

// -------- Connection (both sides) --------
export type ConnectionState =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DRAINING'
  | 'DISCONNECTED'
  | 'RECONNECTING'
  | 'CLOSED';

export interface Connection extends EventEmitter<ConnectionEvents> {
  readonly connectionId: string;
  readonly state: ConnectionState;
  readonly warnings: readonly MllpWarning[];
  send(payload: Buffer, opts?: { signal?: AbortSignal }): Promise<void>;
  close(opts?: { drainTimeoutMs?: number }): Promise<void>;
  destroy(reason?: Error): void;
}

export interface ConnectionEvents {
  stateChange: [{ from: ConnectionState; to: ConnectionState; reason: string }];
  message: [payload: Buffer, meta: MessageMeta];
  ack: [payload: Buffer, meta: MessageMeta];
  warning: [w: MllpWarning];
  error: [err: MllpError];
  disconnect: [reason: string];
  close: [];
}

export interface MessageMeta {
  connectionId: string;
  byteOffset: number;
  warnings: readonly MllpWarning[];
  receivedAt: Date;
}

// -------- Framing --------
export function encodeFrame(payload: Buffer, opts?: EncodeOptions): Buffer;
export class FrameReader { /* ... */ }
export interface FramingTolerance {
  allowFsOnly: boolean;
  allowLfAfterFs: boolean;
  allowMissingLeadingVt: boolean;
  allowLeadingWhitespace: boolean;
}

// -------- Errors --------
export { MllpFramingError, MllpConnectionError, MllpTimeoutError, MllpBackpressureError } from './errors';
export type { MllpWarning, WarningCode } from './framing';
```

---

## Architectural Patterns

### Pattern 1: Typed EventEmitter as the public observability surface

**What:** Every public class (`MllpServer`, `MllpClient`, `Connection`) extends `EventEmitter<EventMap>` from `node:events` with a generic event-map interface. Lifecycle events (`stateChange`, `message`, `ack`, `error`, `close`) are typed; consumers get IntelliSense on `.on()`.

**When:** Always for Node library classes that emit events. Deprecates all third-party typed-emitter wrappers.

**Trade-offs:** Native idiom, zero deps, Node interop (`events.on(conn, 'message')` gives async iteration for free). The only cost: users of `@types/node` < July 2024 won't see generics — not a concern at Node 18+ (REQ-SETUP-05).

```typescript
class MllpClient extends EventEmitter<ClientEvents> {
  emit<K extends keyof ClientEvents>(event: K, ...args: ClientEvents[K]): boolean {
    return super.emit(event, ...args);
  }
}
```

### Pattern 2: State-carrier + byte-carrier split

**What:** The `Connection` owns state (FSM, queues, lifecycle events). The `Transport` owns bytes (read/write, close, destroy). One class per responsibility, composed — never collapsed.

**When:** Any protocol library where "TCP-ness" and "protocol-ness" are separable. MLLP cleanly separates: TCP is TCP; MLLP is a framing layer on top.

**Trade-offs:** Two classes per connection (slight cost); but the in-memory transport becomes trivial (TRANS-02..04), and TLS slots in as a pure `TlsTransport` without touching `Connection` (TLS-01..04).

### Pattern 3: Strategy pattern for ACK correlation

**What:** `AckCorrelator` is an interface with two implementations: `FifoCorrelator` (default) and `ControlIdCorrelator` (opt-in). The `MllpClient` constructor picks one based on `correlateByControlId`. Both implement the same `register(pendingSend)` / `resolve(ack)` / `reject(err)` contract.

**When:** Any time the library has "default simple behavior + opt-in complex behavior" where the two share an interface.

**Trade-offs:** One extra indirection; worth it because it cleanly separates the FIFO path (simple, well-tested) from the controlId path (more error surface: mismatched MSA-2, head-of-line policy).

### Pattern 4: Pure-function byte codec at the bottom of the stack

**What:** `framing/` has no classes that emit events or return promises. `encodeFrame(Buffer): Buffer`. `new FrameReader().push(chunk: Buffer): { payloads: Buffer[]; warnings: MllpWarning[] }`. Synchronous, deterministic, independently testable.

**When:** Protocol libraries. Keeps the most critical correctness surface (byte framing) hermetic.

**Trade-offs:** The Connection layer has to pump `push()` into the reader and translate its return into events. That's ~20 LOC of glue. In exchange, Phase 2 tests don't need a Transport, a Connection, or a socket — just `push(bytes)`, assert on `payloads`.

### Pattern 5: AbortSignal layered over timeouts

**What:** Any public awaitable accepts `signal?: AbortSignal`. Internal timeouts are expressed as `AbortSignal.timeout(ms)`, and user signals combine via `AbortSignal.any([userSignal, timeoutSignal])`.

**When:** All async public methods in 2026.

**Trade-offs:** Two signal allocations per send. Measurable only at extreme throughput. Worth it for cancellation safety.

```typescript
async send(payload: Buffer, opts: SendOptions = {}): Promise<Buffer> {
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(opts.ackTimeoutMs ?? 30_000)])
    : AbortSignal.timeout(opts.ackTimeoutMs ?? 30_000);
  signal.throwIfAborted();
  // ...
}
```

---

## Data Flow

### Inbound message flow (Server side)

```
TCP bytes
    ↓
net.Socket 'data' event
    ↓
NetTransport.emit('data', chunk)
    ↓
Connection._onTransportData(chunk) ──► FrameReader.push(chunk)
                                            ↓
                                       { payloads: Buffer[], warnings: MllpWarning[] }
                                            ↓
For each warning: Connection.emit('warning', w)
For each payload: Connection.emit('message', payload, meta)
                                            ↓
                                  MllpServer relays to its own 'connection' consumer
                                            ↓
                                  Consumer calls conn.send(ackBuffer)
                                            ↓
                                  Connection.send(ack) ──► encodeFrame(ack) ──► NetTransport.write(frame)
                                            ↓
                                       TCP bytes out
```

### Outbound send flow (Client side)

```
client.send(payload, { signal, ackTimeoutMs })
    ↓
[Check state === CONNECTED? If RECONNECTING/CONNECTING, queue per backpressure policy]
    ↓
AckCorrelator.register(pendingSend)  // FIFO or controlId-Map
    ↓
encodeFrame(payload)
    ↓
NetTransport.write(frame)
    ↓
[Returns Promise<Buffer> — resolves when corresponding ACK arrives via inbound flow]

Inbound ACK flow:
TCP bytes in ──► FrameReader.push() ──► Connection.emit('message', ackPayload, meta)
                                              ↓
                                     AckCorrelator.resolve(ackPayload)
                                              ↓
                                     pendingSend.resolve(ackPayload)  // original send's Promise settles
```

### State transition flow

```
External trigger (connect/socket-error/close/drain-complete)
    ↓
Connection._transition(nextState, reason)
    ↓
[Validate transition against state-table; throw if illegal]
    ↓
this.state = nextState
    ↓
emit('stateChange', { from, to, reason })
    ↓
[Per-state side-effects: clear timers, start timers, drain queue, reject pending, etc.]
```

---

## Scaling Considerations

Library scaling is about wire throughput and memory, not user count. MLLP endpoints in production run from 10 msg/day (small practice) to 10,000+ msg/s (nationwide HIE).

| Scale | Architecture Adjustments |
|-------|--------------------------|
| **1–100 msg/s** | Defaults are fine. Array-based queue would work. |
| **100–1,000 msg/s** | Linked-list queue matters (Array.shift() starts hurting). FrameReader's internal Buffer should use `Buffer.concat` with a pre-grown accumulator, not allocate per chunk. |
| **1,000–10,000 msg/s** | Consider: (a) `zero-copy` FrameReader that works on `Buffer` slices rather than concatenations; (b) move to `stream.Readable`-based plumbing with native backpressure; (c) pool PendingSend objects. This is post-v1. |
| **10,000+ msg/s** | Out of scope for v1 library. Connection pooling (v2) or a native binding (never). |

### Scaling priorities (what breaks first)

1. **Buffer allocation overhead in FrameReader.** Under load, `Buffer.concat([accumulator, newChunk])` per chunk is the first hot spot. Mitigation: pre-allocated slab + byteOffset tracking. Not v1 work.
2. **Event listener registration churn on AbortSignal per send.** Minor. Measurable at > 5k msg/s. Mitigation: pooled `AbortController`. Not v1 work.
3. **Timer allocation for per-send timeouts.** Node's timers are hashed, so this is cheaper than naive. Still: a hierarchical timer wheel would win. Not v1 work.

---

## Anti-Patterns

### Anti-Pattern 1: State tracked on both `MllpClient` and `Connection`

**What people do:** `MllpClient.isConnected` flag that duplicates `Connection.state`.
**Why it's wrong:** Two sources of truth drift. A user sees `client.isConnected === true` but `client.send()` rejects because Connection is actually in DRAINING. We hit this exact bug in the sibling parser work.
**Do this instead:** `MllpClient.state` is a getter that returns `this._connection.state`. One source of truth. Every place in the client code reads the same thing the user reads.

### Anti-Pattern 2: Framing logic embedded in the Connection class

**What people do:** Consuming `net.Socket` 'data' events inside `Connection.ts`, doing VT-scanning inline, emitting 'message' from a 200-line method.
**Why it's wrong:** Framing is the most correctness-critical surface we own (REQ-FRAME-01..10). Burying it inside Connection means every framing test requires a Connection + Transport + socket simulation. Development velocity collapses.
**Do this instead:** Strict `framing/` folder with pure functions and a pure-stateful `FrameReader`. Connection is 30 lines of glue: `_onData(chunk) { const { payloads, warnings } = this.reader.push(chunk); ...emit }`.

### Anti-Pattern 3: Unbounded inbound buffer

**What people do:** Accumulate bytes in a `Buffer` until `FS+CR` arrives. No cap.
**Why it's wrong:** Malicious peer sends `VT` + infinite payload. OOM. Known security issue in `hl7v2-rs` and documented in `python-hl7` issue #17.
**Do this instead:** Configurable `maxFrameSizeBytes` with a sensible default (16 MB). Exceed → throw `MllpFramingError({ code: 'MLLP_FRAME_TOO_LARGE' })` and transition to DISCONNECTED.

### Anti-Pattern 4: TLS as a boolean flag switching internal code paths

**What people do:** `NetTransport` has `if (this.tls) { use tls.connect() } else { use net.connect() }` sprinkled throughout.
**Why it's wrong:** The `connect`/`secureConnect` event, the error surface during handshake, and the options object all diverge. Net/Tls branches tangle. Mock/test paths have to account for both.
**Do this instead:** Two classes behind one `Transport` interface. A factory picks one. Users see `{ tls?: TlsOptions }` only.

### Anti-Pattern 5: Backpressure as a single byte-count watermark

**What people do:** Borrow `highWaterMark: 16 * 1024` from Node streams. Apply to MLLP send queue.
**Why it's wrong:** HL7 messages are 500 B to 10+ MB. A single byte-watermark either admits too many small messages (OOM on burst) or too few large ones (stuck on legitimate OBX images).
**Do this instead:** Dual watermark: count-based (default 64 in-flight) AND bytes-based (default Infinity, opt-in). Either tripping asserts backpressure.

### Anti-Pattern 6: Reconnect timer inside the `DISCONNECTED` state

**What people do:** On socket drop, stay in `DISCONNECTED`, set a `setTimeout` to call `connect()` again.
**Why it's wrong:** `DISCONNECTED` now means two things ("temporarily down, will retry" vs "permanently dead"). `client.destroy()` behavior becomes ambiguous. User can't observe "we're actively reconnecting."
**Do this instead:** Add explicit `RECONNECTING` state (#2). Observable via `'stateChange'` and `'reconnecting'` events.

---

## Integration Points

### External (Node stdlib)

| Integration | Pattern | Notes |
|-------------|---------|-------|
| `net.Socket` | Wrapped by `NetTransport`. Never exposed. | TCP_NODELAY on by default (MLLP is request/response; Nagle hurts). |
| `tls.TLSSocket` via `tls.connect()` | Wrapped by `TlsTransport`. Never exposed. | Use `tls.connect()` directly — never `new TLSSocket(existingSocket)` (documented issue nodejs/node#30468). |
| `net.Server` / `tls.Server` | Wrapped by `MllpServer`. Exposed via `server.address()`. | `server.close()` maps to our graceful drain. |
| `events.EventEmitter` | Base class for all observable types. | Typed via `EventEmitter<Events>` (@types/node ≥ Jul 2024). |
| `AbortSignal` | Threaded into every awaitable. | Use `AbortSignal.any()` (Node 20+) or polyfill combining for 18. |

### Internal Boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| `framing/` ↔ `connection/` | Synchronous function calls. `FrameReader.push()` returns arrays. | Pure on framing side. Connection wraps in events. |
| `transport/` ↔ `connection/` | Transport interface: `data`/`close`/`error` events; `write`/`close`/`destroy` methods. | Connection owns the Transport instance. |
| `connection/` ↔ `server/` | Server keeps a `Set<Connection>`. Composition. | Server wires each new Connection's events through to its own `connection` event listeners. |
| `connection/` ↔ `client/` | Client holds at most one Connection at a time. Replaces on reconnect. | Client carries `correlator`, `backpressure`, `backoff` — Connection stays transport-generic. |
| `client/` ↔ `ack-from-hl7/` | **None at runtime.** `ack-from-hl7` is a separate subpath bundle. | REQ-SETUP-03: main bundle never imports `@cosyte/hl7`. |
| `testing/` ↔ `transport/` | Re-export only. | One-line file. |

---

## Sources

- **Undici architecture**:
  - [HTTP Fundamentals: Understanding Undici and its Working Mechanism — Platformatic](https://blog.platformatic.dev/http-fundamentals-understanding-undici-and-its-working-mechanism) (confirmed Dispatcher/Client/Pool/Agent hierarchy; llhttp as peer parser module)
  - [undici on GitHub](https://github.com/nodejs/undici)
  - [Undici Dispatcher API docs](https://github.com/nodejs/undici/blob/main/docs/docs/api/Dispatcher.md) (AsyncIterable support, in-flight dedup)
- **ws WebSocket library**:
  - [ws source layout — lib/](https://github.com/websockets/ws/tree/master/lib) (sender.js + receiver.js peers, websocket.js owns state)
  - [ws README](https://github.com/websockets/ws)
- **ioredis state machine**:
  - [ioredis Redis.ts source](https://github.com/redis/ioredis/blob/main/lib/Redis.ts) (7-state FSM: wait/connecting/connect/ready/close/reconnecting/end)
  - [ioredis issue #571 — manual-close vs reconnect](https://github.com/redis/ioredis/issues/571)
- **node-postgres**:
  - [node-postgres Client API](https://node-postgres.com/apis/client)
  - [Connection Pooling — DeepWiki](https://deepwiki.com/brianc/node-postgres/4-connection-pooling)
  - [pg connection URI](https://node-postgres.com/features/connecting)
- **mysql2**:
  - [mysql2 GitHub](https://github.com/sidorares/node-mysql2) (command queue, per-Connection state)
  - [mysql2 issue #1898 — closed state errors](https://github.com/sidorares/node-mysql2/issues/1898)
- **TypeScript EventEmitter**:
  - [@types/node generics PR — DefinitelyTyped discussion](https://github.com/DefinitelyTyped/DefinitelyTyped/discussions/55298) (July 2024 native EventEmitter<T>)
  - [strict-event-emitter-types](https://github.com/bterlson/strict-event-emitter-types)
  - [typed-emitter](https://github.com/andywer/typed-emitter)
- **AbortSignal API design**:
  - [Managing Asynchronous Operations in Node.js with AbortController — AppSignal (Feb 2025)](https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html)
  - [Using AbortSignal in Node.js — OpenJS Foundation](https://openjsf.org/blog/using-abortsignal-in-node-js)
  - [Modern Node.js Patterns for 2025](https://kashw1n.com/blog/nodejs-2025/)
- **Async iterators interop**:
  - [events.on() AsyncIterable — Node.js docs](https://nodejs.org/api/events.html)
  - [Symbol.asyncIterator — MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Symbol/asyncIterator)
- **TLS / TLSSocket**:
  - [TLS — Node.js docs](https://nodejs.org/api/tls.html)
  - [nodejs/node#30468 — TLSSocket wrapping divergence](https://github.com/nodejs/node/issues/30468)
  - [nodejs/node#8752 — TLSSocket from net.Socket limitations](https://github.com/nodejs/node/issues/8752)
- **MLLP DoS / frame size**:
  - [python-hl7 issue #17 — RECV_BUFFER truncation](https://github.com/johnpaulett/python-hl7/issues/17)
  - [hl7v2-rs issue #156 — DoS via unbounded body size](https://github.com/EffortlessMetrics/hl7v2-rs/issues/156)
  - [MuleSoft HL7 MLLP Connector Reference — streaming strategies](https://docs.mulesoft.com/hl7-mllp-connector/latest/hl7-mllp-connector-reference)
  - [HL7 MLLP Transport Specification (Rene Spronk)](https://www.hl7.org/documentcenter/public/wg/inm/mllp_transport_specification.PDF)
- **tsup + subpath exports**:
  - [Dual Publishing ESM and CJS Modules with tsup — johnnyreilly](https://johnnyreilly.com/dual-publishing-esm-cjs-modules-with-tsup-and-are-the-types-wrong)
  - [Ship ESM & CJS in one Package — antfu.me](https://antfu.me/posts/publish-esm-and-cjs)
  - [TypeScript in 2025 with ESM and CJS npm publishing — Liran Tal](https://lirantal.com/blog/typescript-in-2025-with-esm-and-cjs-npm-publishing)

---
*Architecture research for: @cosyte/hl7-mllp (Node.js MLLP client+server library)*
*Researched: 2026-04-22*
