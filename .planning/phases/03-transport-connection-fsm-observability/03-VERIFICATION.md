---
phase: 03-transport-connection-fsm-observability
verified: 2026-04-24T13:10:00Z
status: gaps_found
score: 10/14 must-haves verified
overrides_applied: 0
gaps:
  - truth: "Connection emits 'reconnecting' event with frozen { from, to, reason } payload matching the exported ReconnectingEvent interface"
    status: failed
    reason: "CR-01: ReconnectingEvent interface declares { attempt: number; delayMs: number } but the 'reconnecting' event is emitted with { connectionId: string } only. Phase 5 subscribers destructuring { attempt, delayMs } will receive undefined. Public API type contract violation."
    artifacts:
      - path: "src/connection/connection.ts"
        issue: "Line 450 emits Object.freeze({ connectionId: this.connectionId }) but the exported ReconnectingEvent interface at line 68-71 declares { attempt: number; delayMs: number }. The JSDoc @example at line 63 also destructures { attempt, delayMs }."
    missing:
      - "Align ReconnectingEvent interface with what is actually emitted — either Option A (remove reconnecting emission from _transition(), have Phase 5 emit it with correct payload) or Option B (fix interface to { readonly connectionId: string; readonly attempt?: number; readonly delayMs?: number })"
      - "Update JSDoc @example that demonstrates { attempt, delayMs } destructuring"
  - truth: "Connection transitions CONNECTING → CLOSED (not stuck) when transport closes unexpectedly during CONNECTING"
    status: failed
    reason: "WR-01: _onTransportClose() calls _transition('DISCONNECTED', 'peer closed') when state is CONNECTING. CONNECTING → DISCONNECTED is not in LEGAL_TRANSITIONS, so _transition() silently ignores it. The FSM remains stuck in CONNECTING indefinitely. Resources are leaked; the 'disconnect' or 'close' event never fires. The test at line 102 of connection.test.ts acknowledges this with a comment but works around it instead of asserting the correct post-condition."
    artifacts:
      - path: "src/connection/connection.ts"
        issue: "Lines 463-470: _onTransportClose() attempts _transition('DISCONNECTED') from CONNECTING and RECONNECTING states. Both are illegal per LEGAL_TRANSITIONS (CONNECTING's legal targets are CONNECTED, RECONNECTING, CLOSED; RECONNECTING's legal targets are CONNECTING, CLOSED). The transition is silently dropped, leaving the FSM stuck."
    missing:
      - "Fix _onTransportClose(): when state is CONNECTING or RECONNECTING, transition to CLOSED (the correct terminal for unexpected peer-close from these states), not DISCONNECTED"
      - "Add a test asserting that transport close from CONNECTING results in state === 'CLOSED' and that the 'close' event fired"
  - truth: "Connection correctly routes RECONNECTING-state errors to CLOSED (not stuck in RECONNECTING)"
    status: failed
    reason: "WR-02: _onTransportError() maps RECONNECTING to target 'DISCONNECTED' (via the else branch of 'CONNECTING ? CLOSED : DISCONNECTED'). RECONNECTING → DISCONNECTED is illegal per LEGAL_TRANSITIONS. The transition is silently dropped. Additionally, errors during RECONNECTING receive phase 'receive' instead of the semantically correct 'reconnect'."
    artifacts:
      - path: "src/connection/connection.ts"
        issue: "Line 488: target is computed as 'this._state === CONNECTING ? CLOSED : DISCONNECTED'. For RECONNECTING state this maps to DISCONNECTED, but RECONNECTING → DISCONNECTED is illegal. The phase ternary at lines 474-477 also assigns 'receive' for RECONNECTING errors instead of 'reconnect'."
    missing:
      - "Fix _onTransportError(): map both CONNECTING and RECONNECTING to CLOSED target (neither has a path to DISCONNECTED)"
      - "Fix phase ternary: add 'this._state === RECONNECTING ? reconnect' arm before the fallback 'receive'"
  - truth: "close() during DRAINING is truly idempotent — a second concurrent call joins the in-progress drain rather than starting a second beforeClose() invocation"
    status: failed
    reason: "WR-03: close() during DRAINING calls _drainWithTimeout(timeout) again, which calls this.beforeClose(timeoutMs) a second time concurrently. Phase 4 (Server ACK drain) and Phase 5 (send-queue drain) hooks will not be written to tolerate concurrent invocations. The comment at line 331 says 'idempotent re-entry guard' but this is incorrect."
    artifacts:
      - path: "src/connection/connection.ts"
        issue: "Lines 331-334: when state === 'DRAINING', code falls through to _drainWithTimeout(timeout), calling beforeClose() again. No promise cache is used to share the in-progress drain."
    missing:
      - "Add a _drainPromise: Promise<void> | null cache field"
      - "In close(): when state === 'DRAINING', return this._drainPromise ?? Promise.resolve()"
      - "When initiating drain from CONNECTED: this._drainPromise = this._drainWithTimeout(timeout).finally(() => { this._drainPromise = null; }); return this._drainPromise"
---

# Phase 3: Transport Abstraction, Connection FSM & Observability — Verification Report

**Phase Goal:** A developer using either a real `net.Socket`-backed transport or the in-memory test transport gets an identical `Transport` interface, an inspectable 6-state connection FSM (`CONNECTING`/`CONNECTED`/`DRAINING`/`RECONNECTING`/`DISCONNECTED`/`CLOSED`), per-connection warning streams, `connection.getStats()` observability, and a consistent lifecycle-event contract that every downstream phase (server/client) builds on. Connection lives in its own `src/connection/` module, peer to `src/transport/`.
**Verified:** 2026-04-24T13:10:00Z
**Status:** gaps_found — 4 gaps across 1 critical and 3 warning severity issues
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Transport is a pure callback-bag TypeScript interface with write/close/destroy/onData/onConnect/onClose/onError | VERIFIED | `src/transport/index.ts` exports `Transport` interface with all 7 methods, no EventEmitter inheritance |
| 2 | NetTransport wraps net.Socket, wiring its EventEmitter events to the registered callbacks with set-once semantics | VERIFIED | `src/transport/net-transport.ts:39` — `class NetTransport implements Transport`, 4x `removeAllListeners + on` pattern confirmed |
| 3 | MllpConnectionError is a named Error subclass with cause (Error) and phase union (all 5 values) | VERIFIED | `src/connection/error.ts` — phase union has all 5: 'connect'\|'send'\|'receive'\|'close'\|'reconnect'; `override readonly cause: Error` |
| 4 | InMemoryTransport.pair() returns two connected ends with synchronous delivery | VERIFIED | `src/testing/in-memory-transport.ts:72` — `static pair()` confirmed; 25 tests pass including synchronous delivery |
| 5 | Connection class exposes .state as one of exactly the 6 ConnectionState values | VERIFIED | `src/connection/connection.ts:34-40` — type union, `LEGAL_TRANSITIONS` map covers all 6 states |
| 6 | Connection emits 'stateChange' with frozen { from, to, reason } payload | VERIFIED | `_transition()` at line 440-443 — `Object.freeze<StateChangeEvent>()` confirmed; `exactOptionalPropertyTypes` handled correctly |
| 7 | connectionId is generated via crypto.randomUUID() — stable string on every event | VERIFIED | Line 206: `this.connectionId = randomUUID()` |
| 8 | Connection fires 'message' for every decoded MLLP frame (not 'ack' — that is MllpClient-layer) | VERIFIED | `_onFrameDecoded()` emits 'message'; no 'ack' emission anywhere in Connection; 64 unit tests confirm |
| 9 | Connection.onWarning(fn) registers per-connection warning subscriber (WARN-10) | VERIFIED | `onWarning()` at line 250; `_onFramingWarning()` wires correctly with enrichment and try/catch |
| 10 | Connection.getStats() returns JSON-serializable object with Date\|null timestamps (not epoch ms) | VERIFIED | `getStats()` at line 408-426 — `Date \| null` confirmed; integration test OBS-04 round-trip passes |
| 11 | Warning buffer keeps last 100 entries; warningsByCode counts every warning regardless of truncation | VERIFIED | `MAX_WARNINGS = 100`, ring buffer with `_warningsTruncated`, `_warningsByCode` Map always updated |
| 12 | Every public event payload is Object.freeze'd | VERIFIED | `stateChange`, `connect`, `disconnect`, `reconnecting`, `close`, `message`, `warning`, `error` all frozen |
| 13 | Connection emits 'reconnecting' event with payload matching the exported ReconnectingEvent interface | FAILED | CR-01: Interface declares `{ attempt: number; delayMs: number }` but line 450 emits `{ connectionId: string }` only |
| 14 | FSM transitions are correct for all states including CONNECTING and RECONNECTING on unexpected peer close or transport error | FAILED | WR-01: `_onTransportClose()` attempts illegal CONNECTING/RECONNECTING → DISCONNECTED transitions (silently ignored); WR-02: `_onTransportError()` maps RECONNECTING to DISCONNECTED target (illegal). Plus WR-03: `close()` during DRAINING starts a second concurrent `beforeClose()` call. |

**Score: 10/14 truths verified**

---

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src/transport/index.ts` | Transport interface with 7 methods | VERIFIED | All 7 methods present with JSDoc; NetTransport re-exported via barrel |
| `src/transport/net-transport.ts` | NetTransport class implementing Transport | VERIFIED | `implements Transport`, 4x removeAllListeners+on, no .slice(), no console.* |
| `src/connection/error.ts` | MllpConnectionError with phase union | VERIFIED | All 5 phase values, `override readonly cause: Error` |
| `src/testing/in-memory-transport.ts` | InMemoryTransport with pair/split/pause/resume/destroy | VERIFIED | All methods present, private constructor, _writeDepth guard, .subarray() |
| `src/testing/index.ts` | Testing barrel re-exporting InMemoryTransport | VERIFIED | Stub removed; `export { InMemoryTransport }` confirmed |
| `src/connection/connection.ts` | Connection class — 6-state FSM, lifecycle events, onWarning, getStats() | PARTIAL | Core structure correct; 3 FSM bugs (WR-01, WR-02, WR-03) and 1 type contract violation (CR-01) |
| `src/connection/index.ts` | Connection module barrel | VERIFIED | Exports Connection, ConnectionOptions, ConnectionState, ConnectionStats, StateChangeEvent, ReconnectingEvent, MllpConnectionError, ConnectionErrorPhase |
| `src/index.ts` | Main barrel with Phase 3 public exports | VERIFIED | Transport (type), NetTransport, Connection, ConnectionState, MllpConnectionError all exported; InMemoryTransport correctly excluded |

---

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/transport/net-transport.ts` | `src/transport/index.ts` | `implements Transport` | WIRED | Line 39: `export class NetTransport implements Transport` |
| `src/testing/in-memory-transport.ts` | `src/transport/index.ts` | `implements Transport` | WIRED | Line 40: `export class InMemoryTransport implements Transport` |
| `src/connection/connection.ts` | `src/transport/index.ts` | `import type { Transport }` | WIRED | Line 23: `import type { Transport } from '../transport/index.js'` |
| `src/connection/connection.ts` | `src/framing/decoder.ts` | `new FrameReader` | WIRED | Line 214: `this._reader = new FrameReader(...)` |
| `src/connection/connection.ts` | `src/connection/error.ts` | `new MllpConnectionError` | WIRED | Line 26: `import { MllpConnectionError }` — used at line 479 |
| `src/index.ts` | `src/transport/index.ts` | `re-export Transport, NetTransport` | WIRED | Lines 25-26 confirmed |
| `src/index.ts` | `src/connection/index.ts` | `re-export Connection, MllpConnectionError` | WIRED | Lines 27-36 confirmed |

---

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| `Connection` (message delivery) | `payload` in 'message' event | `FrameReader.onFrame` → `_onFrameDecoded` → `emit('message')` | Yes — FrameReader produces real decoded payloads from transport chunks | FLOWING |
| `Connection.getStats()` | `bytesIn`, `bytesOut`, `warningsByCode` | Incremented in `onData` callback / `send()` / `_onFramingWarning()` | Yes — real counters, not static | FLOWING |
| `Connection` (stateChange) | `{ from, to, reason }` | `_transition()` called on real state changes | Yes — reflects actual FSM state | FLOWING |

---

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| 225 tests pass (all phase 2+3 test files) | `pnpm test` | 225 passed, 0 failed, 14 test files | PASS |
| typecheck passes | `pnpm typecheck` | 0 errors (confirmed by plan 04 SUMMARY) | PASS |
| lint passes | `pnpm lint` | 0 errors (confirmed by plan 04 SUMMARY) | PASS |
| No .slice() in transport/connection/testing | `grep -rn '\.slice(' src/transport/ src/connection/ src/testing/` | No output | PASS |
| No console.* in library code | `grep -rn 'console\.' src/transport/ src/connection/ src/testing/` (filtered to non-JSDoc) | Only in JSDoc @example comments, not in executable code | PASS |
| InMemoryTransport not in main barrel | `grep -n 'InMemoryTransport' src/index.ts` | No output | PASS |

---

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| TRANS-01 | 03-01, 03-04 | Transport interface; Connection composes Transport | SATISFIED | `src/transport/index.ts` exports `Transport`; `src/connection/connection.ts` accepts `transport: Transport` |
| TRANS-02 | 03-02, 03-04 | InMemoryTransport with pair() | SATISFIED | `InMemoryTransport.pair()` implemented and tested with 25 tests |
| TRANS-03 | 03-04 | Full round-trip with InMemoryTransport, no sockets | SATISFIED | `test/connection/integration.test.ts` — 7 tests covering bidirectional send/receive |
| TRANS-04 | 03-02 | InMemoryTransport split/pause/resume/destroy | SATISFIED | All four methods implemented and tested |
| LIFE-01 | 03-03 | .state property, 'stateChange' event | SATISFIED | 6-state type, LEGAL_TRANSITIONS, Object.freeze'd stateChange |
| LIFE-02 | 03-03, 03-04 | Full transition graph | PARTIAL | Most edges correct; CONNECTING/RECONNECTING → DISCONNECTED on transport-close/error are incorrectly silently dropped (WR-01, WR-02) |
| LIFE-03 | 03-03 | Lifecycle event ordering | PARTIAL | connect/message/warning/error/disconnect/close all fire; 'reconnecting' event fires with wrong payload shape (CR-01) |
| LIFE-04 | 03-03 | Stable connectionId on all events | SATISFIED | `crypto.randomUUID()` at construction; every emitted event includes connectionId |
| LIFE-05 | 03-04 | close() during CONNECTING/RECONNECTING cancels; CONNECTED drains | PARTIAL | CONNECTING cancellation works correctly; RECONNECTING cancellation works in `close()` but `_onTransportClose` during RECONNECTING is broken; drain timeout enforced via Promise.race; WR-03 makes re-entrant DRAINING non-idempotent |
| WARN-10 | 03-03 | Per-connection onWarning subscription | SATISFIED | `onWarning(fn)`, D-09 enrichment, ring buffer, try/catch |
| OBS-03 | 03-03 | connection.getStats() | SATISFIED | Returns all required fields |
| OBS-04 | 03-03 | getStats() JSON-serializable, Date not epoch ms | SATISFIED | Date\|null confirmed; integration test OBS-04 passes |
| OBS-05 | 03-03 | Warning buffer capped at 100, accurate warningsByCode | SATISFIED | MAX_WARNINGS=100, warningsTruncated flag, _warningsByCode Map |
| ERR-03 | 03-01 | MllpConnectionError with cause + phase union | SATISFIED | All 5 phase values; override readonly cause: Error |

---

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `src/connection/connection.ts` | 63-71 | JSDoc @example for 'reconnecting' event destructures `{ attempt, delayMs }` — these fields are never emitted | Blocker (CR-01) | Phase 5 developers following the JSDoc example will get undefined at runtime |
| `src/connection/connection.ts` | 450 | `emit('reconnecting', Object.freeze({ connectionId }))` — emits `{ connectionId }` only, not `{ attempt, delayMs }` | Blocker (CR-01) | Type mismatch between exported interface and runtime payload |
| `src/connection/connection.ts` | 463-470 | `_onTransportClose()` attempts CONNECTING → DISCONNECTED and RECONNECTING → DISCONNECTED — both illegal per LEGAL_TRANSITIONS | Blocker (WR-01) | FSM stuck in CONNECTING when transport closes unexpectedly — resource leak |
| `src/connection/connection.ts` | 488 | `_onTransportError()` maps RECONNECTING to DISCONNECTED target — illegal per LEGAL_TRANSITIONS | Warning (WR-02) | Latent Phase 5 bug — FSM stuck in RECONNECTING after error during reconnect attempt |
| `src/connection/connection.ts` | 477 | `_onTransportError()` assigns 'receive' phase for RECONNECTING state errors instead of 'reconnect' | Warning (WR-02) | Wrong ConnectionErrorPhase value emitted for RECONNECTING errors |
| `src/connection/connection.ts` | 331-334 | `close()` during DRAINING calls `_drainWithTimeout()` again — starts a second concurrent `beforeClose()` | Warning (WR-03) | Phase 4/5 `beforeClose` hooks will not be written to tolerate concurrent invocations |
| `test/connection/connection.test.ts` | 102 | Comment acknowledges CONNECTING → DISCONNECTED is illegal but test works around rather than asserting correct behavior | Info | Masks the WR-01 regression surface |

---

### Human Verification Required

None — all verifiable checks are programmatic for this phase.

---

## Gaps Summary

Four issues prevent full goal achievement:

**CR-01 (blocking — public API contract):** The exported `ReconnectingEvent` interface (`{ attempt: number; delayMs: number }`) does not match what the `'reconnecting'` event actually emits at runtime (`{ connectionId: string }`). This is a breaking public API type contract violation that TypeScript cannot catch because `EventEmitter.emit()` is untyped. Phase 5 code that subscribes to `'reconnecting'` events will receive `undefined` for both `attempt` and `delayMs`.

**WR-01 (blocking — FSM correctness):** `_onTransportClose()` attempts the illegal transition `CONNECTING → DISCONNECTED` (and `RECONNECTING → DISCONNECTED`). The `_transition()` function silently ignores these illegal edges by design (FSM integrity protection), leaving the connection stuck in `CONNECTING` forever. No cleanup occurs, no events fire, and resources are leaked. This directly contradicts the LIFE-02 requirement that the FSM transitions along defined edges — it is not just a Phase 5 concern since `CONNECTING` is the initial state of every Phase 4 server-accepted connection.

**WR-02 (warning — latent Phase 5):** `_onTransportError()` also attempts the illegal `RECONNECTING → DISCONNECTED` transition and assigns the wrong `phase` value ('receive' instead of 'reconnect') for reconnect-state errors. This is latent until Phase 5 implements auto-reconnect but will manifest immediately when it does.

**WR-03 (warning — latent Phase 4/5):** `close()` during `DRAINING` starts a second concurrent `beforeClose()` call instead of joining the in-progress drain. Phase 4 and Phase 5 `beforeClose` hooks will not be written to tolerate concurrent invocations, so this will cause double-drain races.

WR-01 and CR-01 are the primary blockers for full goal achievement. WR-02 and WR-03 are latent but will become blockers in Phases 4 and 5 respectively.

---

_Verified: 2026-04-24T13:10:00Z_
_Verifier: Claude (gsd-verifier)_
