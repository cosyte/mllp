---
phase: 03-transport-connection-fsm-observability
verified: 2026-04-24T14:00:00Z
status: passed
score: 14/14 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: gaps_found
  previous_score: 10/14
  gaps_closed:
    - "CR-01: ReconnectingEvent interface aligned — connectionId: string required, attempt/delayMs optional"
    - "WR-01: _onTransportClose() now transitions CONNECTING/RECONNECTING to CLOSED, not illegal DISCONNECTED"
    - "WR-02: _onTransportError() maps RECONNECTING to 'reconnect' phase and routes CONNECTING/RECONNECTING to CLOSED target"
    - "WR-03: close() during DRAINING returns cached _drainPromise — beforeClose called exactly once on concurrent calls"
  gaps_remaining: []
  regressions: []
---

# Phase 3: Transport Abstraction, Connection FSM & Observability — Verification Report

**Phase Goal:** A developer using either a real `net.Socket`-backed transport or the in-memory test transport gets an identical `Transport` interface, an inspectable 6-state connection FSM (`CONNECTING`/`CONNECTED`/`DRAINING`/`RECONNECTING`/`DISCONNECTED`/`CLOSED`), per-connection warning streams, `connection.getStats()` observability, and a consistent lifecycle-event contract that every downstream phase (server/client) builds on. Connection lives in its own `src/connection/` module, peer to `src/transport/`.
**Verified:** 2026-04-24T14:00:00Z
**Status:** passed
**Re-verification:** Yes — after gap closure via Plan 05 (CR-01, WR-01, WR-02, WR-03)

---

## Goal Achievement

### Observable Truths

| #   | Truth                                                                                                              | Status     | Evidence                                                                                                                                              |
| --- | ------------------------------------------------------------------------------------------------------------------ | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Transport is a pure callback-bag TypeScript interface with write/close/destroy/onData/onConnect/onClose/onError     | VERIFIED   | `src/transport/index.ts` exports `Transport` interface with all 7 methods, no EventEmitter inheritance                                                |
| 2   | NetTransport wraps net.Socket, wiring its EventEmitter events to the registered callbacks with set-once semantics  | VERIFIED   | `src/transport/net-transport.ts` — `class NetTransport implements Transport`, 4x `removeAllListeners + on` pattern confirmed                          |
| 3   | MllpConnectionError is a named Error subclass with cause (Error) and phase union (all 5 values)                   | VERIFIED   | `src/connection/error.ts` — phase union has all 5: 'connect'\|'send'\|'receive'\|'close'\|'reconnect'; `override readonly cause: Error`              |
| 4   | InMemoryTransport.pair() returns two connected ends with synchronous delivery                                      | VERIFIED   | `src/testing/in-memory-transport.ts:72` — `static pair()` confirmed; 25 tests pass including synchronous delivery                                   |
| 5   | Connection class exposes .state as one of exactly the 6 ConnectionState values                                     | VERIFIED   | `src/connection/connection.ts:35-41` — type union, `LEGAL_TRANSITIONS` map covers all 6 states                                                      |
| 6   | Connection emits 'stateChange' with frozen { from, to, reason } payload                                           | VERIFIED   | `_transition()` at line 448-451 — `Object.freeze<StateChangeEvent>()` confirmed                                                                     |
| 7   | connectionId is generated via crypto.randomUUID() — stable string on every event                                  | VERIFIED   | Line 212: `this.connectionId = randomUUID()`                                                                                                         |
| 8   | Connection fires 'message' for every decoded MLLP frame (not 'ack' — that is MllpClient-layer)                    | VERIFIED   | `_onFrameDecoded()` emits 'message'; no 'ack' emission anywhere in Connection; 65 unit tests confirm                                                 |
| 9   | Connection.onWarning(fn) registers per-connection warning subscriber (WARN-10)                                     | VERIFIED   | `onWarning()` at line 256; `_onFramingWarning()` wires correctly with enrichment and try/catch                                                       |
| 10  | Connection.getStats() returns JSON-serializable object with Date\|null timestamps (not epoch ms)                   | VERIFIED   | `getStats()` at lines 416-434 — `Date \| null` fields confirmed; integration test OBS-04 round-trip passes                                          |
| 11  | Warning buffer keeps last 100 entries; warningsByCode counts every warning regardless of truncation                | VERIFIED   | `MAX_WARNINGS = 100` at line 131, ring buffer with `_warningsTruncated`, `_warningsByCode` Map always updated                                        |
| 12  | Every public event payload is Object.freeze'd                                                                      | VERIFIED   | `stateChange`, `connect`, `disconnect`, `reconnecting`, `close`, `message`, `warning`, `error` all frozen in `_transition()` and handlers            |
| 13  | ReconnectingEvent interface matches what 'reconnecting' event actually emits at runtime                            | VERIFIED   | Interface (lines 72-76): `{ connectionId: string; attempt?: number; delayMs?: number }`. Emission (line 458): `Object.freeze({ connectionId })` — compatible; optional fields absent is valid |
| 14  | FSM transitions correct for CONNECTING/RECONNECTING on peer close or transport error; close() DRAINING idempotent  | VERIFIED   | WR-01: `_onTransportClose()` lines 475-479 transitions CONNECTING/RECONNECTING to CLOSED. WR-02: `_onTransportError()` lines 483-496 maps RECONNECTING to 'reconnect' phase and CLOSED target. WR-03: `_drainPromise` cache at line 199, returned at line 339 |

**Score: 14/14 truths verified**

---

### Required Artifacts

| Artifact                             | Expected                                                  | Status   | Details                                                                                   |
| ------------------------------------ | --------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `src/transport/index.ts`             | Transport interface with 7 methods                        | VERIFIED | All 7 methods present with JSDoc                                                          |
| `src/transport/net-transport.ts`     | NetTransport class implementing Transport                 | VERIFIED | `implements Transport`, 4x removeAllListeners+on, no .slice(), no console.*               |
| `src/connection/error.ts`            | MllpConnectionError with phase union                      | VERIFIED | All 5 phase values, `override readonly cause: Error`                                     |
| `src/testing/in-memory-transport.ts` | InMemoryTransport with pair/split/pause/resume/destroy    | VERIFIED | All methods present, private constructor, _writeDepth guard, .subarray()                 |
| `src/testing/index.ts`               | Testing barrel re-exporting InMemoryTransport             | VERIFIED | Stub removed; `export { InMemoryTransport }` confirmed                                   |
| `src/connection/connection.ts`       | Connection class — 6-state FSM, lifecycle events, getStats | VERIFIED | All four FSM bugs fixed (CR-01, WR-01, WR-02, WR-03); 230 tests pass                   |
| `src/connection/index.ts`            | Connection module barrel                                  | VERIFIED | Exports Connection, ConnectionOptions, ConnectionState, ConnectionStats, StateChangeEvent, ReconnectingEvent, MllpConnectionError, ConnectionErrorPhase |
| `src/index.ts`                       | Main barrel with Phase 3 public exports                   | VERIFIED | Transport (type), NetTransport, Connection, ConnectionState, MllpConnectionError all exported; InMemoryTransport correctly excluded |

---

### Key Link Verification

| From                                 | To                          | Via                         | Status | Details                                                            |
| ------------------------------------ | --------------------------- | --------------------------- | ------ | ------------------------------------------------------------------ |
| `src/transport/net-transport.ts`     | `src/transport/index.ts`    | `implements Transport`      | WIRED  | Line 39: `export class NetTransport implements Transport`          |
| `src/testing/in-memory-transport.ts` | `src/transport/index.ts`    | `implements Transport`      | WIRED  | Line 40: `export class InMemoryTransport implements Transport`     |
| `src/connection/connection.ts`       | `src/transport/index.ts`    | `import type { Transport }` | WIRED  | Line 23: `import type { Transport } from '../transport/index.js'`  |
| `src/connection/connection.ts`       | `src/framing/decoder.ts`    | `new FrameReader`           | WIRED  | Line 220: `this._reader = new FrameReader(...)`                    |
| `src/connection/connection.ts`       | `src/connection/error.ts`   | `new MllpConnectionError`   | WIRED  | Lines 26-27: both MllpConnectionError and ConnectionErrorPhase imported; used at lines 489, 483 |
| `src/index.ts`                       | `src/transport/index.ts`    | `re-export Transport, NetTransport` | WIRED | Lines 25-26 confirmed                                         |
| `src/index.ts`                       | `src/connection/index.ts`   | `re-export Connection, MllpConnectionError` | WIRED | Lines 27-39 confirmed                                    |

---

### Data-Flow Trace (Level 4)

| Artifact                      | Data Variable                    | Source                                            | Produces Real Data | Status    |
| ----------------------------- | -------------------------------- | ------------------------------------------------- | ------------------ | --------- |
| `Connection` (message events) | `payload` in 'message' event     | `FrameReader.onFrame` → `_onFrameDecoded` → emit  | Yes — real decoded bytes from transport | FLOWING |
| `Connection.getStats()`       | `bytesIn`, `bytesOut`, `warningsByCode` | Incremented in `onData` / `send()` / `_onFramingWarning()` | Yes — live counters | FLOWING |
| `Connection` (stateChange)    | `{ from, to, reason }`           | `_transition()` on real state changes             | Yes — actual FSM transitions | FLOWING |

---

### Behavioral Spot-Checks

| Behavior                                | Command                         | Result                                   | Status |
| --------------------------------------- | ------------------------------- | ---------------------------------------- | ------ |
| 230 tests pass (all phase 2+3 files)    | `pnpm test`                     | 230 passed, 0 failed, 14 test files      | PASS   |
| typecheck passes                        | `pnpm typecheck`                | 0 errors                                 | PASS   |
| lint passes                             | `pnpm lint`                     | 0 errors                                 | PASS   |
| No .slice() in transport/connection/testing | `grep -rn '\.slice(' src/transport/ src/connection/ src/testing/` | No output | PASS |
| No console.* in executable library code | Checked grep output             | Only in JSDoc `@example` comments, not executable code | PASS |
| InMemoryTransport not in main barrel    | `grep 'InMemoryTransport' src/index.ts` | No output | PASS |
| WR-01 test: transport close from CONNECTING → CLOSED | `connection.test.ts:109` | `conn.state === 'CLOSED'` and `closeFired === true` | PASS |
| WR-02 test: transport error from RECONNECTING → CLOSED with phase='reconnect' | `close-destroy.test.ts:159` | `errorPayload.error.phase === 'reconnect'` | PASS |
| WR-03 test: concurrent close() calls — beforeClose called once | `close-destroy.test.ts:177` | `beforeCloseCallCount === 1` | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description                                       | Status    | Evidence                                                                   |
| ----------- | ----------- | ------------------------------------------------- | --------- | -------------------------------------------------------------------------- |
| TRANS-01    | 03-01, 03-04 | Transport interface; Connection composes Transport | SATISFIED | `src/transport/index.ts` exports `Transport`; `Connection` accepts `transport: Transport` |
| TRANS-02    | 03-02, 03-04 | InMemoryTransport with pair()                     | SATISFIED | `InMemoryTransport.pair()` implemented and tested with 25 tests           |
| TRANS-03    | 03-04       | Full round-trip with InMemoryTransport, no sockets | SATISFIED | `test/connection/integration.test.ts` — 7 tests covering bidirectional send/receive |
| TRANS-04    | 03-02       | InMemoryTransport split/pause/resume/destroy      | SATISFIED | All four methods implemented and tested                                    |
| LIFE-01     | 03-03       | .state property, 'stateChange' event              | SATISFIED | 6-state type, LEGAL_TRANSITIONS, Object.freeze'd stateChange               |
| LIFE-02     | 03-03, 03-04, 03-05 | Full transition graph                     | SATISFIED | All edges correct; WR-01/WR-02 fixed — CONNECTING/RECONNECTING now route to CLOSED on transport close/error |
| LIFE-03     | 03-03, 03-05 | Lifecycle event ordering                         | SATISFIED | connect/message/warning/error/disconnect/close/reconnecting all fire; CR-01 fixed — 'reconnecting' interface matches emission |
| LIFE-04     | 03-03       | Stable connectionId on all events                 | SATISFIED | `crypto.randomUUID()` at construction; every emitted event includes connectionId |
| LIFE-05     | 03-04, 03-05 | close() during CONNECTING/RECONNECTING cancels; CONNECTED drains | SATISFIED | CONNECTING/RECONNECTING → CLOSED; drain timeout via Promise.race; WR-03 fixed — concurrent DRAINING close() idempotent |
| WARN-10     | 03-03       | Per-connection onWarning subscription             | SATISFIED | `onWarning(fn)`, D-09 enrichment, ring buffer, try/catch                  |
| OBS-03      | 03-03       | connection.getStats()                             | SATISFIED | Returns all required fields including state, connectionId, remoteAddress/Port, bytesIn/Out, timestamps |
| OBS-04      | 03-03       | getStats() JSON-serializable, Date not epoch ms   | SATISFIED | Date\|null confirmed; integration test OBS-04 passes                      |
| OBS-05      | 03-03       | Warning buffer capped at 100, accurate warningsByCode | SATISFIED | MAX_WARNINGS=100, warningsTruncated flag, _warningsByCode Map             |
| ERR-03      | 03-01       | MllpConnectionError with cause + phase union      | SATISFIED | All 5 phase values; override readonly cause: Error                         |

---

### Anti-Patterns Found

| File                                   | Line | Pattern                                             | Severity | Impact                   |
| -------------------------------------- | ---- | --------------------------------------------------- | -------- | ------------------------ |
| `src/connection/connection.ts`         | 166-167 | `console.log` in JSDoc `@example` blocks          | Info     | JSDoc only — not executable code; acceptable |
| `src/transport/net-transport.ts`       | 15   | `console.log` in JSDoc `@example` block            | Info     | JSDoc only — not executable code; acceptable |

No blockers. No stubs. No hardcoded empty data in rendering paths.

---

### Human Verification Required

None — all checks are programmatic for this phase.

---

## Re-verification Summary

All four gaps from the initial verification were closed by Plan 05:

**CR-01 CLOSED:** `ReconnectingEvent` interface updated to `{ readonly connectionId: string; readonly attempt?: number; readonly delayMs?: number }`. The JSDoc @example now shows `{ connectionId }` destructuring. The emission at line 458 emits `{ connectionId: this.connectionId }` which is fully compatible with the interface (required field present; optional fields absent is valid TypeScript).

**WR-01 CLOSED:** `_onTransportClose()` (lines 465-480) now correctly branches `CONNECTING | RECONNECTING → CLOSED` via `_transition('CLOSED', 'peer closed')`. The previously illegal `CONNECTING → DISCONNECTED` attempt is gone. New test at `connection.test.ts:109` asserts `conn.state === 'CLOSED'` and `closeFired === true` after transport close from CONNECTING.

**WR-02 CLOSED:** `_onTransportError()` (lines 482-497) phase ternary now includes `RECONNECTING ? 'reconnect'` arm before the `'receive'` fallback. Target ternary routes both `CONNECTING` and `RECONNECTING` to `CLOSED`. New test at `close-destroy.test.ts:159` asserts `errorPayload.error.phase === 'reconnect'`.

**WR-03 CLOSED:** `_drainPromise: Promise<void> | null` field added at line 199. `close()` during `DRAINING` returns `this._drainPromise ?? Promise.resolve()` (line 339) without invoking `beforeClose` again. New test at `close-destroy.test.ts:177` asserts `beforeCloseCallCount === 1` after two concurrent `close()` calls.

No regressions in previously-passing truths. All 14 roadmap success criteria verified.

---

_Verified: 2026-04-24T14:00:00Z_
_Verifier: Claude (gsd-verifier)_
