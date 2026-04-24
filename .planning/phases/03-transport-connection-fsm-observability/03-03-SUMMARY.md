---
phase: 03-transport-connection-fsm-observability
plan: "03"
subsystem: connection
tags: [connection, fsm, lifecycle, observability, warnings]
dependency_graph:
  requires:
    - 03-01  # Transport interface + NetTransport (Transport type consumed here)
    - 02     # FrameReader (composed inside Connection)
  provides:
    - Connection class with 6-state FSM
    - ConnectionState, ConnectionStats, StateChangeEvent, ReconnectingEvent types
    - Connection module barrel (src/connection/index.ts)
    - MllpConnectionError re-exported via barrel
    - 64 unit tests covering LIFE-01–04, WARN-10, OBS-03/04/05
  affects:
    - 03-04  # Integration tests will compose Connection + InMemoryTransport
    - Phase 4 # Server registers beforeClose() hook on Connection instances
    - Phase 5 # Client registers beforeClose() hook and 'message' listener
tech_stack:
  added:
    - "node:crypto randomUUID() for connectionId (D-11)"
    - "node:events EventEmitter as Connection base class"
  patterns:
    - "6-state FSM via LEGAL_TRANSITIONS ReadonlyMap (LIFE-02)"
    - "Ring buffer: _warningBuffer keeps last 100, shift() oldest on overflow (OBS-05)"
    - "Warning enrichment: Object.freeze({ ...w, connectionId }) re-frozen (D-09)"
    - "beforeClose hook pattern: instance property override for Phase 4/5 drain (D-07/D-08)"
    - "Object.freeze() on every emitted event payload (T-03-03-01)"
key_files:
  created:
    - src/connection/connection.ts
    - src/connection/index.ts
    - test/connection/connection.test.ts
  modified: []
decisions:
  - "CONNECTING → CLOSED (not DISCONNECTED) on transport error — CONNECTING has no legal path to DISCONNECTED per LIFE-02 graph"
  - "beforeClose is a public instance property (not a protected method) so Phase 4/5 can override without subclassing"
  - "message events not delivered when state is CONNECTING (guard added: state must be CONNECTED or DRAINING)"
metrics:
  duration_minutes: 22
  completed_date: "2026-04-24"
  tasks_completed: 3
  tasks_total: 3
  files_created: 3
  files_modified: 1
---

# Phase 3 Plan 03: Connection Class — 6-State FSM, Lifecycle Events & Observability Summary

**One-liner:** `Connection` class with LEGAL_TRANSITIONS-validated 6-state FSM, `crypto.randomUUID()` connectionId, `Object.freeze`'d event payloads, 100-entry warning ring buffer, and `Date|null` timestamp `getStats()`.

## What Was Built

### `src/connection/connection.ts`

The `Connection` class (`extends EventEmitter`) implementing:

- **6-state FSM** (`CONNECTING | CONNECTED | DRAINING | RECONNECTING | DISCONNECTED | CLOSED`) validated by the `LEGAL_TRANSITIONS` `ReadonlyMap`. Illegal edges are silently ignored, preserving FSM integrity (T-03-03-04).
- **`connectionId`** generated via `crypto.randomUUID()` (RFC 4122 UUIDv4, D-11). Stable across all events and `getStats()`.
- **Lifecycle events**: `stateChange`, `connect`, `disconnect`, `reconnecting`, `close`, `message`, `warning`, `error` — every emitted payload is `Object.freeze`'d (T-03-03-01).
- **`message` event** fires for every decoded MLLP frame via `FrameReader` composition (D-05). No `ack` event — that is MllpClient-layer (D-06).
- **`onWarning(fn)`** per-connection subscriber with D-09 enrichment: `Object.freeze({ ...w, connectionId })` re-frozen before delivery.
- **Warning ring buffer** capped at `MAX_WARNINGS = 100`; `_warningsByCode` Map is always accurate regardless of truncation; `warningsTruncated` flag set on first overflow (OBS-05, T-03-03-02).
- **`getStats()`** returns JSON-serializable `ConnectionStats` with `Date | null` timestamps (not epoch ms, per OBS-04).
- **`beforeClose` hook**: public instance property defaulting to `() => Promise.resolve()`. Phase 4 (Server) and Phase 5 (Client) assign drain logic without subclassing (D-07/D-08).
- **`send(data)`**: returns `false` immediately if CLOSED or DISCONNECTED; tracks `bytesOut` and `lastByteOutAt`.
- Transport callbacks wired in constructor: `onData` feeds `FrameReader.push()` and tracks `bytesIn`/`lastByteInAt`; `onClose` drives FSM; `onError` emits typed `MllpConnectionError`.

### `src/connection/index.ts`

Module barrel re-exporting:
- `Connection`, `ConnectionOptions`, `ConnectionState`, `ConnectionStats`, `StateChangeEvent`, `ReconnectingEvent`
- `MllpConnectionError`, `ConnectionErrorPhase` (from `./error.js`)

### `test/connection/connection.test.ts`

64 unit tests using a `makeMockTransport()` fixture (implements `Transport` with vi.fn() and manually triggered callbacks):

| Suite | Tests | Requirements covered |
|-------|-------|----------------------|
| LIFE-01: state property | 2 | LIFE-01 |
| LIFE-04: connectionId | 2 | LIFE-04 |
| LIFE-01/02: stateChange event | 6 | LIFE-01, LIFE-02 |
| LIFE-03: lifecycle events | 12 | LIFE-03, D-05, D-06 |
| WARN-10: per-connection onWarning | 6 | WARN-10, D-09 |
| OBS-03/04/05: getStats() | 13 | OBS-03, OBS-04, OBS-05 |
| destroy() | 6 | LIFE-02 |
| close() | 6 | LIFE-02, D-07 |
| send() | 3 | (write path) |
| error event | 4 | ERR-03 |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] CONNECTING → CLOSED on transport error (not DISCONNECTED)**
- **Found during:** Task 3 (test execution)
- **Issue:** `_onTransportError` attempted `_transition('DISCONNECTED', ...)` from `CONNECTING` state. `CONNECTING → DISCONNECTED` is not in `LEGAL_TRANSITIONS` (only `CONNECTED`, `RECONNECTING`, `CLOSED` are legal targets from `CONNECTING`), so the transition was silently ignored and the state remained stuck in `CONNECTING`.
- **Fix:** When state is `CONNECTING` and a transport error occurs, transition to `CLOSED` (the only reachable terminal from CONNECTING without a successful connect). All other active states still transition to `DISCONNECTED` on error.
- **Files modified:** `src/connection/connection.ts` (L427–441), `test/connection/connection.test.ts` (test expectation updated to `CLOSED`)
- **Commit:** af42847

**2. [Rule 1 - Bug] TypeScript `exactOptionalPropertyTypes` error on `StateChangeEvent`**
- **Found during:** Task 1 (pnpm typecheck)
- **Issue:** `Object.freeze<StateChangeEvent>({ from, to, reason })` where `reason?: string` failed with `exactOptionalPropertyTypes: true` because spreading `reason: undefined` into an object typed as having an optional `reason: string` is not assignable.
- **Fix:** Conditional object literal: `reason !== undefined ? { from, to, reason } : { from, to }` — omits the key entirely when no reason is provided.
- **Files modified:** `src/connection/connection.ts` (L394–396)
- **Commit:** 9c32b29 (included in initial implementation)

**3. [Rule 2 - Missing guard] Message delivery gated on active state**
- **Found during:** Task 3 (test "does not emit message when in CONNECTING state")
- **Issue:** Plan skeleton included `if (state !== CONNECTED && state !== DRAINING) return` in `_onFrameDecoded`. This was implemented as designed — not technically a deviation but worth documenting: frames decoded before `notifyConnect()` (e.g. data arriving during TLS handshake) are silently dropped, not delivered.
- **Files modified:** None (was implemented correctly per plan)

## Known Stubs

None — all public API surfaces are fully implemented. The `beforeClose` no-op is intentional and documented; Phase 4/5 will override it.

## Threat Flags

No new security-relevant surfaces beyond those in the plan's `<threat_model>`. All mitigations implemented:

| Threat | Mitigation Applied |
|--------|--------------------|
| T-03-03-01: Event payload mutation | `Object.freeze()` on all 8 emitted event types |
| T-03-03-02: Warning buffer unbounded | Ring buffer `MAX_WARNINGS=100`; `warningsTruncated` flag |
| T-03-03-04: FSM illegal transition | `LEGAL_TRANSITIONS` map checked before every `_transition()` |
| T-03-03-05: onWarning handler throws | `try/catch` wrapping per-connection subscriber (WARN-06) |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/connection/connection.ts` | FOUND |
| `src/connection/index.ts` | FOUND |
| `test/connection/connection.test.ts` | FOUND |
| `03-03-SUMMARY.md` | FOUND |
| Commit 9c32b29 (Task 1 — Connection class) | FOUND |
| Commit 5f70aca (Task 2 — barrel) | FOUND |
| Commit af42847 (Task 3 — tests + bug fix) | FOUND |
