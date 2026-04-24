---
phase: 04-mllp-server
verified: 2026-04-24T15:50:00Z
status: gaps_found
score: 10/13 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Each Connection emits 'message' with Object.freeze({ payload, meta }) where meta = { connectionId, byteOffset, warnings }"
    status: partial
    reason: "byteOffset is always 0 (stub) and warnings is always [] (empty). The FrameReader tracks _byteOffset internally and accumulates per-frame warnings, but Connection.ts _onFrameDecoded emits only { payload, connectionId } — neither byteOffset nor per-frame warnings are threaded through. This is a cross-phase architecture gap: FrameReader.onFrame callback signature only receives (payload: Buffer), so byteOffset cannot be passed without changing Phase 2's FrameReader interface and Phase 3's Connection._onFrameDecoded."
    artifacts:
      - path: "src/server/server.ts"
        issue: "meta.byteOffset hardcoded to 0 (line 640); meta.warnings hardcoded to [] (line 641)"
      - path: "src/connection/connection.ts"
        issue: "_onFrameDecoded emits only { payload, connectionId } — no byteOffset or per-frame warnings"
      - path: "src/framing/decoder.ts"
        issue: "onFrame callback signature is (payload: Buffer) — byteOffset is private, not passed to callers"
    missing:
      - "FrameReader.onFrame callback must be changed to pass byteOffset: (payload: Buffer, byteOffset: number) => void"
      - "Connection._onFrameDecoded must be updated to include byteOffset in the emitted message event"
      - "Server _onSocketAccepted must pass actual byteOffset and per-frame warnings to MessageMeta"
      - "Alternatively, scope this to a cross-phase fix tracked for Phase 7 fixtures (which need real byteOffset for test assertions)"

  - truth: "server.getStats() returns { listening, port, host, connections, activeConnections, totalBytesIn, totalBytesOut, acceptedTotal, closedTotal } as a plain JSON-serializable object"
    status: partial
    reason: "_closedTotal double-increments when a DISCONNECTED connection later reaches CLOSED. Two independent once() listeners (_onConnEnded for 'disconnect' and 'close') can both fire for the same connection: when a peer closes gracefully (CONNECTED → DRAINING → DISCONNECTED), 'disconnect' fires and increments _closedTotal; if _drainAll's straggler timeout then calls conn.destroy(), Connection.destroy() transitions DISCONNECTED → CLOSED, firing 'close' and incrementing _closedTotal a second time."
    artifacts:
      - path: "src/server/server.ts"
        issue: "Lines 602-607: two separate once() listeners on 'disconnect' and 'close' both call _onConnEnded without a single-fire guard"
    missing:
      - "Add a single-fire guard to _onConnEnded: let ended = false; if (ended) return; ended = true;"

  - truth: "Auto-ACK errors are caught and re-emitted as 'error' on the connection — they do not crash the server (D-04)"
    status: partial
    reason: "The onMessage return-value contract is broken: ServerOptions.onMessage is typed as (payload, meta, conn) => void | Buffer | Promise<Buffer> and the JSDoc documents 'Return a Buffer or Promise<Buffer> to send as the ACK payload (auto-framed)'. However, the implementation discards the return value with 'void this._opts.onMessage?.(payload, meta, conn)'. A developer following the documented interface signature who returns a Buffer expects an ACK to be sent but silently gets no ACK. This is a self-inconsistency within Phase 4 (interface contract vs. implementation) — while not failing a REQUIREMENTS line item (SERVER requirements don't specify return-value-sends-ACK), it introduces a broken public API surface that will mislead consumers."
    artifacts:
      - path: "src/server/server.ts"
        issue: "Line 651: 'void this._opts.onMessage?.(payload, meta, conn)' discards Buffer|Promise<Buffer> return value"
        issue: "Lines 116-120: ServerOptions.onMessage typed as returning void | Buffer | Promise<Buffer> — Buffer return advertised but never sent"
    missing:
      - "Either (a) implement the return-value path: if onMessage returns Buffer|Promise<Buffer>, send it as ACK via encodeFrame + conn.send(), or (b) change the onMessage return type to 'void' and remove the misleading JSDoc claim"
---

# Phase 4: MLLP Server Verification Report

**Phase Goal:** MLLP Server — createServer(), per-connection pipeline, auto-ACK, graceful shutdown, idle keepalive, createStarterServer, AbortSignal + Symbol.asyncDispose, frozen event payloads, server.getStats()
**Verified:** 2026-04-24T15:50:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | createServer({ onMessage, framing }) returns MllpServer wrapping net.Server without exposing it | ✓ VERIFIED | `class MllpServer extends EventEmitter` (line 241); private `_netServer: NetServer`; `createServer()` factory at line 750 |
| 2 | server.listen(port) resolves once TCP socket is bound and emits 'listening' with frozen { port, host } | ✓ VERIFIED | listen() implementation lines 282-334; `Object.freeze({ port: actualPort, host: actualHost })` at line 320; test: "listen(0) emits listening event with frozen { port, host }" passes |
| 3 | Each accepted socket creates NetTransport → Connection pipeline added to _connections | ✓ VERIFIED | `_onSocketAccepted` lines 564-669; `new NetTransport(socket)`, `new Connection(connOpts)`, `this._connections.add(conn)` |
| 4 | Each Connection emits 'message' with frozen { payload, meta } where meta = { connectionId, byteOffset, warnings } | ✗ FAILED | `byteOffset: 0` (hardcoded stub, line 640); `warnings: []` (empty always, line 641). Real FrameReader byteOffset is private; Connection.ts _onFrameDecoded emits only { payload, connectionId }. Meta structure exists but two of three meaningful fields are stub values. |
| 5 | conn.send(buf) from within the message handler writes framed bytes via encodeFrame and returns boolean | ✓ VERIFIED | _sendAutoAck calls `conn.send(encodeFrame(ackPayload))` (line 704); Connection.send() documented as boolean; manual conn.send() tested in auto-ack.test.ts |
| 6 | Server-level framing opts (D-12 defaults + caller overrides) passed to every Connection's FrameReader | ✓ VERIFIED | `SERVER_DEFAULT_FRAMING` constant lines 211-216; `{ ...SERVER_DEFAULT_FRAMING, ...(this._opts.framing ?? {}) }` merged at line 572-575; test: "server uses liberal framing by default" passes |
| 7 | autoAck: 'AA' synthesizes AA ACK from MSH without peer dep; autoAck: fn uses custom builder | ✓ VERIFIED | `_buildAutoAck` method lines 506-558; MSH-10 extraction `fields[9] ?? ''`; `_sendAutoAck` at lines 682-730; tests: MSA round-trip, field swap, async fn mode all pass |
| 8 | Auto-ACK errors re-emitted as 'error' on connection; server does not crash (D-04) | ✓ VERIFIED | try/catch in `_sendAutoAck` lines 719-729; default conn error handler added (lines 589-593); D-04 error swallow tests pass |
| 9 | server.close({ drainTimeoutMs }) drains all connections with _drainAll(Promise.all + side-effect setTimeout) | ✓ VERIFIED | `_drainAll` lines 414-434; `Promise.all(closePromises)` at line 430; `timeoutHandle.unref()` at line 427; graceful-shutdown tests pass including stuck-connection drain test |
| 10 | AbortSignal on listen() and close() rejects with DOMException('Aborted', 'AbortError') | ✓ VERIFIED | DOMException at lines 292, 301, 359, 382; `removeEventListener` cleanup in finally blocks; all abort tests pass |
| 11 | server.getStats() returns JSON-serializable plain object with all required fields | ✗ FAILED (partial) | Field shape is correct (lines 462-482); live byte aggregation works (tested). BUT _closedTotal double-increments: two independent once() listeners ('disconnect' + 'close') both invoke _onConnEnded without a single-fire guard (lines 602-607). Values will be accurate in most cases but overcounting is possible when _drainAll destroy() fires on already-DISCONNECTED connections. |
| 12 | createStarterServer({ port, onMessage }) returns listening server with auto-ACK AA, 30s drain, Symbol.asyncDispose | ✓ VERIFIED | `createStarterServer` lines 772-803; `autoAck: opts.autoAck ?? 'AA'`; `drainTimeoutMs: 30_000`; `await server.listen(opts.port)`; all starter-server tests pass |
| 13 | Every event payload emitted by MllpServer is Object.freeze()'d | ✓ VERIFIED | 11 Object.freeze calls in server.ts; 'listening', 'connection', 'message', 'close' all frozen; frozen event audit tests pass |

**Score:** 10/13 truths verified (3 failed/partial)

### Deferred Items

None identified. All gaps are within Phase 4 scope or cross-phase architecture concerns addressable by a gap plan.

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/server/server.ts` | MllpServer class + createServer() + types | ✓ VERIFIED | 804 lines; all required exports present; compiles clean |
| `src/server/index.ts` | Server module barrel | ✓ VERIFIED | Re-exports MllpServer, createServer, createStarterServer, types |
| `src/index.ts` (Phase 4 block) | Phase 4 exports in main barrel | ✓ VERIFIED | "// Phase 4: server" block present (line 38-47) |
| `test/server/server.test.ts` | Skeleton tests | ✓ VERIFIED | 15 tests, all passing |
| `test/server/auto-ack.test.ts` | Auto-ACK tests | ✓ VERIFIED | 14 tests, all passing |
| `test/server/graceful-shutdown.test.ts` | Shutdown tests | ✓ VERIFIED | 15 tests, all passing |
| `test/server/starter-server.test.ts` | Starter tests | ✓ VERIFIED | 18 tests, all passing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `_onSocketAccepted` | `Connection` | `new Connection({ transport, framing: mergedFramingOpts })` | ✓ WIRED | Lines 572-580 |
| `_onSocketAccepted` | `NetTransport` | `new NetTransport(socket)` | ✓ WIRED | Line 571 |
| `MllpServer` | Connection 'message' | `conn.on('message', handler)` | ✓ WIRED | Line 636 |
| `_sendAutoAck` | `conn.send` | `conn.send(encodeFrame(ackPayload))` | ✓ WIRED | Line 704 |
| `createStarterServer` | `createServer` | `const server = createServer({ ...opts })` | ✓ WIRED | Line 773 |
| `MllpServer[Symbol.asyncDispose]` | `this.close()` | `return this.close()` | ✓ WIRED | Line 447 |
| `server.getStats()` | `conn.getStats()` | `for (const conn of this._connections) { conn.getStats() }` | ✓ WIRED | Lines 466-470 |
| `src/index.ts Phase 4 block` | `src/server/index.js` | `export { ... } from './server/index.js'` | ✓ WIRED | Lines 38-47 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `server.getStats()` | `totalBytesIn/Out` | `conn.getStats().bytesIn/bytesOut` for each conn in `_connections` | Yes — aggregated from live connections | ✓ FLOWING |
| `server.getStats()` | `connections`, `activeConnections` | `this._connections.size` | Yes — live Set size | ✓ FLOWING |
| `server.getStats()` | `closedTotal` | `this._closedTotal++` in `_onConnEnded` | Partially — double-counts on disconnect+close | ⚠ HOLLOW — counter can be inflated |
| `MessageMeta.byteOffset` | `byteOffset: 0` | Hardcoded, no source | No — always 0 | ✗ DISCONNECTED |
| `MessageMeta.warnings` | `warnings: []` | Hardcoded empty array | No — always empty | ✗ DISCONNECTED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| createServer({}).listen(0) resolves | pnpm test (server.test.ts) | "listen(0) resolves" — PASS | ✓ PASS |
| autoAck: 'AA' sends MSA round-trip | pnpm test (auto-ack.test.ts) | "autoAck: AA — server sends ACK containing MSA|AA" — PASS | ✓ PASS |
| close({ drainTimeoutMs: 100 }) with stuck conn | pnpm test (graceful-shutdown.test.ts) | stuck connection destroyed, close resolves ~124ms — PASS | ✓ PASS |
| createStarterServer({ port: 0 }).getStats().listening | pnpm test (starter-server.test.ts) | listening=true, all OBS-02 fields present — PASS | ✓ PASS |
| handleSignals: true cleanup after close() | pnpm test (starter-server.test.ts) | process.listenerCount('SIGTERM') === 0 after close() — PASS | ✓ PASS |
| Symbol.asyncDispose calls close() | pnpm test (starter-server.test.ts) | "await using server compiles and calls close()" — PASS | ✓ PASS |
| pnpm typecheck exits 0 | pnpm typecheck | 0 TS errors | ✓ PASS |
| pnpm build produces ESM+CJS | pnpm build | ESM + CJS + DTS all built | ✓ PASS |
| 292 tests pass | pnpm test | 292/292 pass, 18 test files | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SERVER-01 | 04-01 | createServer(); listen() resolves on bind; close() resolves after connections drain | ✓ SATISFIED | listen() + close() implementations; server.test.ts tests |
| SERVER-02 | 04-01 | 'connection' event fires for every accepted connection | ✓ SATISFIED (partial deviation) | 'connection' event fires with frozen { connectionId, remoteAddress, remotePort } — conn object not passed in event (design decision D-14); conn accessible via onMessage callback |
| SERVER-03 | 04-01 | 'message' event; meta includes { connectionId, byteOffset, warnings } | ✗ PARTIAL | connectionId is correct; byteOffset is always 0; warnings is always [] — FrameReader threading missing |
| SERVER-04 | 04-02 | autoAck: 'AA' or fn; default disables auto-ACK | ✓ SATISFIED | _buildAutoAck and _sendAutoAck; all auto-ACK tests pass |
| SERVER-05 | 04-01/02 | conn.send(buffer) handles framing; returns boolean | ✓ SATISFIED | encodeFrame wrapping in _sendAutoAck; Connection.send() boolean documented; tested |
| SERVER-06 | 04-03 | close({ drainTimeoutMs }) graceful shutdown | ✓ SATISFIED | _drainAll with Promise.all + side-effect setTimeout; tests pass including stuck-conn test |
| SERVER-07 | 04-03 | keepaliveIntervalMs + deadPeerTimeoutMs | ✓ SATISFIED | socket.setKeepAlive (line 567); deadPeerTimer unref + reset on message + clear on close (lines 610-628); SERVER-07 idle timer tests pass |
| SERVER-08 | 04-04 | createStarterServer factory — batteries-included | ✓ SATISFIED | createStarterServer lines 772-803; auto-ACK 'AA', 30s drain, Symbol.asyncDispose; starter tests pass |
| SERVER-09 | 04-03 | AbortSignal on listen() and close() | ✓ SATISFIED | DOMException AbortError on abort; removeEventListener cleanup; all abort tests pass |
| SERVER-10 | 04-04 | All event payloads Object.freeze()'d | ✓ SATISFIED | 11 Object.freeze calls; 'listening', 'connection', 'message', 'close' events all frozen; audit tests pass |
| SERVER-11 | 04-04 | Symbol.asyncDispose delegates to close() | ✓ SATISFIED | `async [Symbol.asyncDispose]()` at line 446; test confirms it compiles and calls close() |
| SERVER-12 | 04-01 | framing tolerance opts flow to every connection | ✓ SATISFIED | SERVER_DEFAULT_FRAMING + caller merge; framing opts test passes |
| OBS-02 | 04-04 | server.getStats() JSON-serializable plain object | ✓ SATISFIED (partial bug) | All required fields present; totalBytesIn/Out aggregated from live connections; _closedTotal can double-count (CR-02) |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|---------|--------|
| `src/server/server.ts` | 640 | `byteOffset: 0` — hardcoded stub | ⚠ Warning | meta.byteOffset always 0; SC-1 requires real frame position |
| `src/server/server.ts` | 641 | `warnings: [] as readonly MllpWarning[]` — always empty | ⚠ Warning | meta.warnings always empty; SC-1 requires per-frame warnings |
| `src/server/server.ts` | 602-607 | Two independent once() listeners for 'disconnect' + 'close' both increment _closedTotal without single-fire guard | 🛑 Blocker | _closedTotal double-counts on disconnect+close sequence; OBS-02 counter inaccurate |
| `src/server/server.ts` | 116-120, 651 | onMessage typed as returning Buffer|Promise<Buffer> but implementation discards return value | 🛑 Blocker | Interface contract promises return-value-sends-ACK but silently ignores it; developers cannot send ACK by returning Buffer from onMessage |
| `src/server/server.ts` | 368 | `signal?.removeEventListener('abort', () => {/**/})` — anonymous function removes nothing (no-op) | ⚠ Warning | Dead code; harmless at runtime but misleading |
| `src/server/server.ts` | 625 | `conn.once('close', clearTimeout)` but not `conn.once('disconnect', clearTimeout)` for deadPeerTimer | ⚠ Warning | Timer may fire on already-DISCONNECTED connection; contributes to CR-02 double-count |
| `src/server/server.ts` | 695 | `as` cast on autoAck function type | ⚠ Warning | Unjustified type assertion; violates no-as-casts guardrail from CLAUDE.md |
| `src/server/server.ts` | 14,41,63,234,744 | console.log in JSDoc @example blocks | ℹ Info | Only in doc comments, not runtime code; borderline per guardrail intent |

### Human Verification Required

None — all critical behaviors are verifiable programmatically.

### Gaps Summary

Three gaps block full goal achievement:

**Gap 1 (byteOffset/warnings threading):** meta.byteOffset is always 0 and meta.warnings is always empty. This is a cross-phase architecture limitation: Phase 2's FrameReader.onFrame signature is `(payload: Buffer) => void` with no byteOffset argument, and Phase 3's Connection._onFrameDecoded emits only `{ payload, connectionId }`. Fixing this requires changes to FrameReader (Phase 2), Connection (Phase 3), and server (Phase 4). The ROADMAP SC-1 for Phase 4 explicitly states the developer receives `meta.byteOffset` — this is a real gap, not a deferred item.

**Gap 2 (_closedTotal double-counting):** The two independent `once()` listeners for 'disconnect' and 'close' can both fire for the same connection, inflating `_closedTotal`. The fix is a one-line guard: `let ended = false; if (ended) return; ended = true;` in `_onConnEnded`. This is a small bug with a trivial fix.

**Gap 3 (onMessage return value discarded):** The `ServerOptions.onMessage` interface type advertises `Buffer | Promise<Buffer>` as a valid return type, with JSDoc saying "Return a Buffer or Promise<Buffer> to send as the ACK payload." The implementation uses `void this._opts.onMessage?.(...)` and never reads the return value. This is an internal contract violation: the type system promises behavior the implementation doesn't deliver. A developer following the documented API cannot use this pattern.

These three gaps are addressable in a focused gap-closure plan targeting `src/server/server.ts` and `src/framing/decoder.ts` + `src/connection/connection.ts` for the byteOffset threading.

---

_Verified: 2026-04-24T15:50:00Z_
_Verifier: Claude (gsd-verifier)_
