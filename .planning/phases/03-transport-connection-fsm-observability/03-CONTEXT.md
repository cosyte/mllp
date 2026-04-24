# Phase 3: Transport Abstraction, Connection FSM & Observability - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Transport abstraction layer + 6-state Connection FSM + per-connection observability. Delivers:
- `Transport` interface (plain TS callback-bag) + `NetTransport` (`net.Socket` wrapper) in `src/transport/`
- `InMemoryTransport` (deterministic test double) in `src/testing/`
- `Connection` class in `src/connection/` — 6-state FSM, lifecycle events, per-connection `onWarning`, `getStats()`, `close()`/`destroy()`
- `MllpConnectionError` typed error with full `phase` union

No server or client logic. No HL7 parsing. Zero runtime deps — Node stdlib only.

</domain>

<decisions>
## Implementation Decisions

### Transport Interface Shape
- **D-01:** `Transport` is a **pure callback-bag TypeScript interface** — not a class, not an EventEmitter extension. Methods: `write(buf: Buffer): boolean`, `close(): void`, `destroy(reason?: Error): void`. Registration methods: `onData(fn: (chunk: Buffer) => void): void`, `onConnect(fn: () => void): void`, `onClose(fn: () => void): void`, `onError(fn: (err: Error) => void): void`. This matches the established `FrameReader` callback-bag pattern from Phase 2. `InMemoryTransport` stores callbacks in fields — no `node:events` import required anywhere in the interface layer.
- **D-02:** `NetTransport` implements `Transport` by wiring `net.Socket` EventEmitter events to the registered callbacks (`socket.on('data', fn)`, etc.). It is the only place where `net.Socket`'s EventEmitter surface is consumed. Outside `NetTransport`, nothing knows about EventEmitter.

### InMemoryTransport Delivery Timing
- **D-03:** `InMemoryTransport` uses **synchronous inline delivery** — when end A calls `write(buf)`, end B's registered `onData` handler fires before `write()` returns. This is consistent with `FrameReader.push()` synchronous frame delivery and satisfies TRANS-03 "deterministic with no timing assumptions." Guard against re-entrant writes with a `_writeDepth` counter; throw a clear error if a write is triggered recursively from inside a delivery handler.
- **D-04:** `split(bytesPerChunk)` slices the written buffer into chunks before delivering them synchronously one by one. `pause()` sets a flag; while paused, writes to the paused end queue internally and do NOT deliver. `resume()` flushes the queue synchronously. `destroy(reason)` sets closed state, fires `onError` and `onClose`.

### Incoming Frame Routing — `onMessage` vs `onAck`
- **D-05:** `Connection` fires `'message'` (or calls `onMessage` callback) for **every decoded MLLP frame**, regardless of content. Connection has no HL7 parser and makes no attempt to classify frames as ACKs vs patient messages. This preserves zero-dep constraint and single responsibility.
- **D-06:** `onAck` is a **MllpClient-layer event** (Phase 5), not a bare `Connection`-class event. `MllpClient` installs its own listener on `connection.on('message', ...)` and routes to its internal `AckCorrelator`. LIFE-03's `onAck` entry documents the MllpClient public API, not the Connection class. Phase 7 lifecycle tests assert `'ack'` events on `MllpClient` instances, not raw `Connection` objects.

### `close()` Drain Contract
- **D-07:** `Connection` exposes a **`beforeClose(drainTimeoutMs: number): Promise<void>` hook** (no-op default that resolves immediately). Phase 4 (Server) registers its ACK-drain logic; Phase 5 (Client) registers its send-queue drain logic. Connection owns the DRAINING state transition and enforces `drainTimeoutMs` — it calls `beforeClose()`, races against the timeout, and transitions to `DISCONNECTED` (or force-closes to `CLOSED` on timeout) regardless of hook outcome.
- **D-08:** At the bare `Connection` level (Phase 3), `beforeClose()` is a no-op — DRAINING → DISCONNECTED transitions once the socket's write buffer drains (`socket.once('drain', ...)`) or immediately if already drained. The hook signature is committed in Phase 3 so Phase 4/5 have a stable integration point without touching FSM internals.

### Warning Enrichment (from Phase 2)
- **D-09:** When Phase 3 wires `onWarning` from `FrameReader`, it enriches warnings before forwarding: `emit('warning', Object.freeze({ ...w, connectionId: this.connectionId }))`. This is the canonical enrichment path from Phase 2 (02-CONTEXT.md D-08). The warning is re-frozen after the spread.

### `MllpConnectionError` Phase Union
- **D-10:** The `phase` union for `MllpConnectionError` is locked in Phase 3 as: `'connect' | 'send' | 'receive' | 'close' | 'reconnect'`. All 5 values are defined in the error type even though `'reconnect'` is only used in Phase 5 (CLIENT-17). ERR-03 specifies the full union — Phase 3 locks it to avoid a breaking change later.

### `connectionId` Generation
- **D-11:** `connectionId` is generated via `crypto.randomUUID()` (built into Node 20+ — zero deps). Type is `string`. LIFE-04 says "UUIDv4 or ULID-compatible" — `crypto.randomUUID()` generates RFC 4122 UUIDv4. No third-party UUID library needed.

### Claude's Discretion
- Internal file structure within `src/transport/`, `src/connection/`, `src/testing/` — planner decides (e.g., `net-transport.ts`, `in-memory-transport.ts`, `connection.ts`, `fsm.ts` or consolidated)
- Exact `getStats()` snapshot timing — whether `connectedAt` is captured at FSM transition or socket `connect` event (both are equivalent; pick the simpler one)
- Warning buffer ring-buffer implementation details (keep last 100 entries; `warningsTruncated: boolean` per OBS-05)
- Whether `destroy()` accepts a `reason?: Error` parameter or `reason?: string` — either works, planner decides type

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and decisions
- `.planning/PROJECT.md` — Vision, zero runtime deps, Buffer-first API, no `console.*` in library code, Postel's Law
- `.planning/REQUIREMENTS.md` §"Transport Abstraction (TRANS)" — TRANS-01..04 (Transport interface, InMemoryTransport, pair()/split()/pause()/destroy())
- `.planning/REQUIREMENTS.md` §"Connection Lifecycle & State Machine (LIFE)" — LIFE-01..05 (6-state FSM, full transition graph, lifecycle events, connectionId, close()/drain semantics)
- `.planning/REQUIREMENTS.md` §"Warnings & Tolerance (WARN)" — WARN-10 (per-connection onWarning + warnings snapshot array)
- `.planning/REQUIREMENTS.md` §"Observability (OBS)" — OBS-03, OBS-04, OBS-05 (connection.getStats() shape, JSON-serializable, 100-entry warning buffer cap)
- `.planning/REQUIREMENTS.md` §"Typed Errors (ERR)" — ERR-03 (MllpConnectionError with phase union)
- `.planning/ROADMAP.md` §"Phase 3: Transport, Connection FSM & Observability" — 4-plan breakdown, success criteria (5 items), plan objectives
- `CLAUDE.md` §"Engineering Guardrails" — `.subarray()` only (no `.slice()` in src/), frozen event payloads, stable warning codes, 6-state FSM spec

### Prior phase decisions
- `.planning/phases/02-framing-codec-warnings/02-CONTEXT.md` — D-01 (FrameReader callback-per-frame, Phase 3 wires via Transport.onData), D-07/D-08 (warning enrichment pattern: `{ ...w, connectionId }` re-frozen)
- `.planning/phases/01-project-foundation/01-CONTEXT.md` — Established patterns (TypeScript strict, tsup dual-build, ESLint SETUP-07)

### Research
- `.planning/research/ARCHITECTURE.md` — Module layering (transport/ → connection/ → server|client/); AckCorrelator lives in MllpClient not Connection; data-flow diagram

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `src/framing/decoder.ts` — `FrameReader` with `{ onFrame, onWarning, maxFrameSizeBytes, ...toleranceOpts }` callback-bag API. Phase 3 composes it: `transport.onData(chunk => this._reader.push(chunk))`.
- `src/framing/error.ts` — `MllpFramingError` pattern. `MllpConnectionError` should follow the same typed-error shape.
- `src/framing/registry.ts` — `createWarning()` factory. Per-connection warning enrichment re-uses this factory output (`{ ...w, connectionId }`).
- `src/index.ts` — existing barrel. Phase 3 adds `Transport`, `NetTransport`, `Connection`, `MllpConnectionError`, `InMemoryTransport` re-exports.
- `src/testing/index.ts` — stub barrel with comment "Populated in Phase 3" — replace stub with real `InMemoryTransport` export.

### Established Patterns
- Callback-bag interfaces (not EventEmitter inheritance) — FrameReader sets this standard.
- `.subarray()` enforced by SETUP-07 ESLint rule — active in `src/transport/`, `src/connection/`, `src/testing/`.
- `Object.freeze()` on every outbound event payload — active from Phase 2 warnings; extend to all Connection events.
- JSDoc + `@example` on every public export — already in place for framing types.
- 90% coverage gate on `src/framing/`, `src/server/`, `src/client/` in `vitest.config.ts`. Phase 3's `src/transport/` and `src/connection/` are not explicitly gated yet — planner should add them or rely on Phase 7.

### Integration Points
- `src/index.ts` — Phase 3 populates the main barrel with transport/connection public types.
- `src/testing/index.ts` — Phase 3 replaces stub with `InMemoryTransport` implementation.
- Phase 4 (Server) — imports `Connection`, `NetTransport`, `FrameReader`, `MllpConnectionError` from their respective modules. Registers `beforeClose()` hook on Connection for server-side drain.
- Phase 5 (Client) — imports `Connection`, registers `'message'` listener and wires `AckCorrelator` for `onAck` routing. Registers `beforeClose()` hook for client-side drain.

</code_context>

<specifics>
## Specific Ideas

- `Transport.onData / onConnect / onClose / onError` registration methods are set-once: subsequent calls to `onData(fn)` replace the previous handler (not additive). This prevents listener leaks across reconnect cycles. Planner should decide whether to throw on double-registration or silently replace.
- `InMemoryTransport._writeDepth` counter for re-entrancy guard: if `write()` is called from within a delivery handler, throw `new Error('InMemoryTransport: re-entrant write detected')` rather than silently corrupting the frame sequence.
- `connection.getStats()` must return `Date | null` for timestamps (not numbers or strings) — `OBS-04` says pass `JSON.stringify()` with no loss (Dates serialize to ISO strings by ECMAScript default). Do NOT convert to epoch milliseconds in `getStats()`.
- Warning buffer strategy: ring buffer — keep last 100, discard oldest. `warningsTruncated: boolean` = true if any were discarded. `warningsByCode` count map is always accurate (counts every warning regardless of buffer overflow).

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within Phase 3 scope.

</deferred>

---

*Phase: 03-transport-connection-fsm-observability*
*Context gathered: 2026-04-24*
