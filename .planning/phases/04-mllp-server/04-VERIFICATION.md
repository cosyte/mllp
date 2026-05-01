---
phase: 04-mllp-server
verified: 2026-04-24T16:20:00Z
status: passed
score: 13/13 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 10/13
  gaps_closed:
    - "meta.byteOffset and meta.warnings in 'message' events now carry real values (FrameReader threads byteOffset + per-frame warnings through Connection to server MessageMeta)"
    - "server.getStats().closedTotal single-fire guard added (let ended = false) — no double-count on disconnect+close"
    - "ServerOptions.onMessage typed as void-only — misleading Buffer|Promise<Buffer> return type and JSDoc removed"
  gaps_remaining: []
  regressions: []
---

# Phase 4: MLLP Server Verification Report

**Phase Goal:** MLLP Server — createServer(), per-connection pipeline, auto-ACK, graceful shutdown, idle keepalive, createStarterServer, AbortSignal + Symbol.asyncDispose, frozen event payloads, server.getStats()
**Verified:** 2026-04-24T16:20:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure plan 04-05

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|---------|
| 1 | createServer({ onMessage, framing }) returns MllpServer wrapping net.Server without exposing it | ✓ VERIFIED | `class MllpServer extends EventEmitter` (line 237); private `_netServer: NetServer`; `createServer()` factory at line 747 |
| 2 | server.listen(port) resolves once TCP socket is bound and emits 'listening' with frozen { port, host } | ✓ VERIFIED | listen() implementation lines 278-330; `Object.freeze({ port: actualPort, host: actualHost })` at line 316; test: "listen(0) emits listening event with frozen { port, host }" passes |
| 3 | Each accepted socket creates NetTransport → Connection pipeline added to _connections | ✓ VERIFIED | `_onSocketAccepted` lines 560-669; `new NetTransport(socket)`, `new Connection(connOpts)`, `this._connections.add(conn)` |
| 4 | Each Connection emits 'message' with Object.freeze({ payload, meta }) where meta = { connectionId, byteOffset, warnings } | ✓ VERIFIED | `FrameReader._deliverFrame()` calls `onFrame(payload, frameStart, frameWarnings)` (3 args); `Connection._onFrameDecoded` freezes `{ payload, connectionId, byteOffset, warnings }`; server destructures and passes `byteOffset`/`warnings` directly to `MessageMeta` (lines 636-642). New tests: byteOffset=0 for first frame, byteOffset=5 with 5-byte SP preamble, warnings array populated with MLLP_LF_AFTER_FS — all pass. |
| 5 | conn.send(buf) from within the message handler writes framed bytes via encodeFrame and returns boolean | ✓ VERIFIED | `_sendAutoAck` calls `conn.send(encodeFrame(ackPayload))` (line 701); Connection.send() documented as boolean; manual conn.send() tested in auto-ack.test.ts |
| 6 | Server-level framing opts (D-12 defaults + caller overrides) passed to every Connection's FrameReader | ✓ VERIFIED | `SERVER_DEFAULT_FRAMING` constant lines 207-212; merged at lines 568-571; test: "server uses liberal framing by default" passes |
| 7 | autoAck: 'AA' synthesizes AA ACK from MSH without peer dep; autoAck: fn uses custom builder | ✓ VERIFIED | `_buildAutoAck` method lines 502-554; MSH-10 extraction; `_sendAutoAck` at lines 682-727; all auto-ACK tests pass |
| 8 | Auto-ACK errors are caught and re-emitted as 'error' on connection — they do not crash the server (D-04) | ✓ VERIFIED | try/catch in `_sendAutoAck` lines 716-726; default conn error handler; D-04 error swallow tests pass |
| 9 | server.close({ drainTimeoutMs }) drains all connections with _drainAll(Promise.all + side-effect setTimeout) | ✓ VERIFIED | `_drainAll` lines 410-430; `Promise.all(closePromises)`; `timeoutHandle.unref()`; graceful-shutdown tests pass including stuck-connection test |
| 10 | AbortSignal on listen() and close() rejects with DOMException('Aborted', 'AbortError') | ✓ VERIFIED | DOMException at lines 288, 297, 355, 378; `removeEventListener` cleanup in finally block; all abort tests pass |
| 11 | server.getStats().closedTotal increments exactly once per connection regardless of whether disconnect then close both fire | ✓ VERIFIED | `let ended = false` guard at line 599; `if (ended) return; ended = true;` at lines 601-602; new test "closedTotal increments exactly once even when both disconnect and close fire" passes with closedTotal === 1 |
| 12 | createStarterServer({ port, onMessage }) returns listening server with auto-ACK AA, 30s drain, Symbol.asyncDispose | ✓ VERIFIED | `createStarterServer` lines 769-800; `autoAck: opts.autoAck ?? 'AA'`; `drainTimeoutMs: 30_000`; `await server.listen(opts.port)`; all starter-server tests pass |
| 13 | Every event payload emitted by MllpServer is Object.freeze()'d | ✓ VERIFIED | Object.freeze calls on all emitted events; 'listening', 'connection', 'message', 'close' all frozen; frozen event audit tests pass |

**Score:** 13/13 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/framing/decoder.ts` | FrameReader.onFrame with byteOffset + per-frame warnings | ✓ VERIFIED | `onFrame: (payload: Buffer, byteOffset: number, warnings: readonly MllpWarning[]) => void`; `_frameStartOffset` and `_frameWarnings` fields; `_deliverFrame` calls 3-arg form |
| `src/connection/connection.ts` | Connection._onFrameDecoded threads byteOffset/warnings | ✓ VERIFIED | `onFrame: (payload, byteOffset, warnings) => { this._onFrameDecoded(payload, byteOffset, warnings); }`; message event includes all 4 fields |
| `src/server/server.ts` | server uses real byteOffset/warnings; single-fire guard; void onMessage | ✓ VERIFIED | No stub values; `let ended = false` guard present; `onMessage?: (...) => void` (line 116) |
| `src/server/index.ts` | Server module barrel | ✓ VERIFIED | Re-exports MllpServer, createServer, createStarterServer, types |
| `src/index.ts` (Phase 4 block) | Phase 4 exports in main barrel | ✓ VERIFIED | Phase 4 server block present |
| `test/server/server.test.ts` | Gap-closure tests appended | ✓ VERIFIED | New `describe('Gap closure...')` block with 6 tests covering all 3 gaps; 21 total tests in file |
| `test/framing/decoder-byteoffset.test.ts` | FrameReader byteOffset TDD tests | ✓ VERIFIED | 8 tests covering byteOffset=0, byteOffset>0, consecutive frames, reset(), empty warnings, MLLP_LF_AFTER_FS, no bleed across frames, no onWarning handler |
| `test/server/auto-ack.test.ts` | Auto-ACK tests | ✓ VERIFIED | 14 tests, all passing |
| `test/server/graceful-shutdown.test.ts` | Shutdown tests | ✓ VERIFIED | 15 tests, all passing |
| `test/server/starter-server.test.ts` | Starter tests | ✓ VERIFIED | 18 tests, all passing |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `FrameReader._deliverFrame` | `FrameReaderOptions.onFrame` | `this._opts.onFrame(payload, frameStart, frameWarnings)` | ✓ WIRED | 3-arg call confirmed at decoder.ts line 470 |
| `Connection._onFrameDecoded` | Connection 'message' event | `Object.freeze({ payload, connectionId, byteOffset, warnings })` | ✓ WIRED | connection.ts line 502 |
| `Connection FrameReader` | `_onFrameDecoded` | `onFrame: (payload, byteOffset, warnings) => { this._onFrameDecoded(...) }` | ✓ WIRED | connection.ts line 222 |
| `server message handler` | `MessageMeta` | `const { payload, connectionId, byteOffset, warnings } = event; Object.freeze({ connectionId, byteOffset, warnings })` | ✓ WIRED | server.ts lines 637-642 |
| `_onSocketAccepted` | `Connection` | `new Connection({ transport, framing: mergedFramingOpts })` | ✓ WIRED | server.ts lines 572-576 |
| `_sendAutoAck` | `conn.send` | `conn.send(encodeFrame(ackPayload))` | ✓ WIRED | server.ts line 701 |
| `createStarterServer` | `createServer` | `const server = createServer({ ...opts })` | ✓ WIRED | server.ts line 770 |
| `MllpServer[Symbol.asyncDispose]` | `this.close()` | `return this.close()` | ✓ WIRED | server.ts line 443 |
| `server.getStats()` | `conn.getStats()` | `for (const conn of this._connections) { conn.getStats() }` | ✓ WIRED | server.ts lines 462-466 |

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|--------------|--------|-------------------|--------|
| `server.getStats()` | `totalBytesIn/Out` | `conn.getStats().bytesIn/bytesOut` for each conn | Yes — aggregated from live connections | ✓ FLOWING |
| `server.getStats()` | `closedTotal` | `this._closedTotal++` in `_onConnEnded` with single-fire guard | Yes — increments exactly once per connection | ✓ FLOWING |
| `MessageMeta.byteOffset` | `byteOffset` from `event.byteOffset` | `FrameReader._frameStartOffset` at VT byte | Yes — actual stream offset | ✓ FLOWING |
| `MessageMeta.warnings` | `warnings` from `event.warnings` | `FrameReader._frameWarnings` per-frame accumulator | Yes — per-frame warning array | ✓ FLOWING |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| meta.byteOffset === 0 for first frame | test/server/server.test.ts "meta.byteOffset is 0 for the first frame at stream start" | PASS | ✓ PASS |
| meta.byteOffset === 5 with 5-byte SP preamble | test/server/server.test.ts "meta.byteOffset is > 0 when frame does not start at byte 0" | PASS | ✓ PASS |
| meta.warnings contains MLLP_LF_AFTER_FS | test/server/server.test.ts "meta.warnings contains MLLP_LF_AFTER_FS..." | PASS | ✓ PASS |
| closedTotal === 1 after peer close (not 2) | test/server/server.test.ts "closedTotal increments exactly once..." | PASS | ✓ PASS |
| autoAck: 'AA' sends MSA round-trip | pnpm test (auto-ack.test.ts) | 14 tests PASS | ✓ PASS |
| close({ drainTimeoutMs: 100 }) with stuck conn | pnpm test (graceful-shutdown.test.ts) | stuck connection destroyed, close resolves — PASS | ✓ PASS |
| createStarterServer({ port: 0 }).getStats().listening | pnpm test (starter-server.test.ts) | listening=true, all OBS-02 fields present — PASS | ✓ PASS |
| pnpm typecheck exits 0 | pnpm typecheck | 0 TS errors | ✓ PASS |
| 306 tests pass | pnpm test | 306/306 pass, 19 test files (14 new from 04-05) | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|---------|
| SERVER-01 | 04-01 | createServer(); listen() resolves on bind; close() resolves after connections drain | ✓ SATISFIED | listen() + close() implementations; server.test.ts tests |
| SERVER-02 | 04-01 | 'connection' event fires for every accepted connection | ✓ SATISFIED (design deviation D-14) | 'connection' event fires with frozen { connectionId, remoteAddress, remotePort }; conn accessible via onMessage |
| SERVER-03 | 04-01 + 04-05 | 'message' event; meta includes { connectionId, byteOffset, warnings } | ✓ SATISFIED | byteOffset = real frame-start offset; warnings = per-frame array from FrameReader; 4 new tests verify |
| SERVER-04 | 04-02 | autoAck: 'AA' or fn; default disables auto-ACK | ✓ SATISFIED | _buildAutoAck and _sendAutoAck; all auto-ACK tests pass |
| SERVER-05 | 04-01/02 | conn.send(buffer) handles framing; returns boolean | ✓ SATISFIED | encodeFrame wrapping in _sendAutoAck; Connection.send() boolean documented; tested |
| SERVER-06 | 04-03 | close({ drainTimeoutMs }) graceful shutdown | ✓ SATISFIED | _drainAll with Promise.all + side-effect setTimeout; tests pass including stuck-conn test |
| SERVER-07 | 04-03 | keepaliveIntervalMs + deadPeerTimeoutMs | ✓ SATISFIED | socket.setKeepAlive (line 563); deadPeerTimer unref + reset on message + clear on close (lines 610-628); idle timer tests pass |
| SERVER-08 | 04-04 | createStarterServer factory — batteries-included | ✓ SATISFIED | createStarterServer lines 769-800; auto-ACK 'AA', 30s drain, Symbol.asyncDispose; starter tests pass |
| SERVER-09 | 04-03 | AbortSignal on listen() and close() | ✓ SATISFIED | DOMException AbortError on abort; removeEventListener cleanup; all abort tests pass |
| SERVER-10 | 04-04 | All event payloads Object.freeze()'d | ✓ SATISFIED | Object.freeze on all emitted events; audit tests pass |
| SERVER-11 | 04-04 | Symbol.asyncDispose delegates to close() | ✓ SATISFIED | `async [Symbol.asyncDispose]()` at line 442; test confirms it calls close() |
| SERVER-12 | 04-01 | framing tolerance opts flow to every connection | ✓ SATISFIED | SERVER_DEFAULT_FRAMING + caller merge; framing opts test passes |
| OBS-02 | 04-04 + 04-05 | server.getStats() JSON-serializable plain object | ✓ SATISFIED | All required fields present; totalBytesIn/Out aggregated; closedTotal single-fire guard eliminates double-count |

### Anti-Patterns Found

No blockers or warnings remaining from prior verification. The following were resolved by plan 04-05:

| File | Was | Fix Applied |
|------|-----|-------------|
| `src/server/server.ts` | `byteOffset: 0` stub (line 640) | Replaced with `byteOffset` from destructured event |
| `src/server/server.ts` | `warnings: []` stub (line 641) | Replaced with `warnings` from destructured event |
| `src/server/server.ts` | Two once() listeners without single-fire guard | `let ended = false` guard added |
| `src/server/server.ts` | onMessage typed as `void | Buffer | Promise<Buffer>` | Narrowed to `void`; JSDoc updated |
| `src/server/server.ts` | Dead anonymous `removeEventListener` | Line removed entirely |
| `src/server/server.ts` | Unjustified `as` cast in `_sendAutoAck` | Replaced with `const autoAck` + `else if` narrowing |

Remaining info-level item (no impact on correctness):
- `src/server/server.ts` lines 13, 96, 219, 229, 437: `console.log` in JSDoc `@example` blocks only (not runtime code)

### Human Verification Required

None — all critical behaviors are verifiable programmatically.

### Gaps Summary

No gaps. All three gaps from the initial verification have been closed by plan 04-05:

- **Gap 1 (byteOffset/warnings threading):** `FrameReaderOptions.onFrame` now carries `(payload, byteOffset, warnings)`. `Connection._onFrameDecoded` threads them into the message event. Server destructures from event and passes to `MessageMeta`. Verified by 4 new tests + 8 FrameReader unit tests.

- **Gap 2 (_closedTotal double-counting):** Single-fire guard (`let ended = false`) prevents `_onConnEnded` from incrementing `_closedTotal` more than once when both `disconnect` and `close` fire. Verified by dedicated test asserting `closedTotal === 1`.

- **Gap 3 (onMessage return type contract):** `ServerOptions.onMessage` is now `(...) => void`. The misleading `Buffer | Promise<Buffer>` return type is gone from the interface. JSDoc updated to direct callers to `conn.send()`. Verified by `pnpm typecheck` (a Buffer-returning callback would now be a compile error).

Phase 4 goal fully achieved.

---

_Verified: 2026-04-24T16:20:00Z_
_Verifier: Claude (gsd-verifier)_
