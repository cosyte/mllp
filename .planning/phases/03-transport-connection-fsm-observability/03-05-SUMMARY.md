---
phase: 03-transport-connection-fsm-observability
plan: "05"
subsystem: connection
tags: [fsm, connection, lifecycle, reconnect, drain, error-handling]

# Dependency graph
requires:
  - phase: 03-04
    provides: "Connection FSM with 6-state machine, close/destroy, beforeClose hook, getStats()"

provides:
  - "CR-01: ReconnectingEvent interface aligned to actual runtime emission (connectionId: string required, attempt/delayMs optional)"
  - "WR-01: _onTransportClose() correctly routes CONNECTING/RECONNECTING to CLOSED instead of illegal DISCONNECTED"
  - "WR-02: _onTransportError() maps RECONNECTING state to 'reconnect' phase; both CONNECTING and RECONNECTING target CLOSED"
  - "WR-03: close() during DRAINING joins cached _drainPromise instead of spawning second beforeClose call"
  - "IN-02: connection.test.ts updated with correct CLOSED assertion after transport close from CONNECTING"
  - "IN-01: close-destroy.test.ts with 4 RECONNECTING state transition tests covering close, transport close, transport error, concurrent drain"

affects: [04-mllp-server, 05-mllp-client]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "_drainPromise cache pattern for idempotent async drain (join in-progress promise, do not re-invoke)"
    - "ConnectionErrorPhase explicit type annotation on _onTransportError phase ternary"
    - "Internal _transition() access via unknown cast in tests for white-box FSM state forcing"

key-files:
  created: []
  modified:
    - src/connection/connection.ts
    - test/connection/connection.test.ts
    - test/connection/close-destroy.test.ts

key-decisions:
  - "CR-01: ReconnectingEvent.connectionId is required (string); attempt and delayMs are optional pending Phase 5 backoff implementation"
  - "WR-01/WR-02: Both CONNECTING and RECONNECTING route to CLOSED (terminal) on unexpected peer close or error — not DISCONNECTED which has no incoming edges from these states per LEGAL_TRANSITIONS"
  - "WR-03: _drainPromise field caches in-flight drain; second close() returns same promise without calling beforeClose again"
  - "ConnectionErrorPhase imported explicitly from error.ts for type annotation clarity in _onTransportError"

patterns-established:
  - "Promise caching for idempotent async operations: store in-flight promise in field, return it on re-entry"
  - "FSM stuck-state prevention: always verify target state is legal per LEGAL_TRANSITIONS before calling _transition"

requirements-completed: [LIFE-02, LIFE-03, LIFE-05]

# Metrics
duration: 4min
completed: "2026-04-24"
---

# Phase 3 Plan 05: Gap Closure Summary

**Four FSM bugs patched in connection.ts (CR-01, WR-01, WR-02, WR-03): ReconnectingEvent interface aligned, CONNECTING/RECONNECTING states now safely terminate to CLOSED on peer close or error, and concurrent close() calls join the in-flight drain without double-invoking beforeClose.**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-24T17:39:30Z
- **Completed:** 2026-04-24T17:42:41Z
- **Tasks:** 3 (2 code tasks + 1 verification)
- **Files modified:** 3

## Accomplishments

- Fixed CR-01: `ReconnectingEvent` interface now has `connectionId: string` (required) matching what `_transition('RECONNECTING')` actually emits; `attempt` and `delayMs` are optional (Phase 5 will populate)
- Fixed WR-01: `_onTransportClose()` now branches CONNECTING and RECONNECTING to `CLOSED` (not `DISCONNECTED`), preventing FSM from getting stuck in unreachable states
- Fixed WR-02: `_onTransportError()` phase ternary maps RECONNECTING to `'reconnect'`; target ternary routes both CONNECTING and RECONNECTING to CLOSED (terminal)
- Fixed WR-03: `close()` during DRAINING returns `this._drainPromise ?? Promise.resolve()` — second caller joins the first drain; `beforeClose` is called exactly once
- Added 5 new tests (65 in connection.test.ts, 18 in close-destroy.test.ts) — total suite: 230 tests, all passing

## Task Commits

1. **Task 1: Fix CR-01, WR-01, WR-02, WR-03 in connection.ts** - `cf057ec` (fix)
2. **Task 2: Fix test at line 102 (IN-02) and add RECONNECTING coverage (IN-01)** - `8912f8d` (test)
3. **Task 3: Verify full test suite and typecheck** - (verification only, no new files)

## Files Created/Modified

- `src/connection/connection.ts` — Four targeted edits: ReconnectingEvent interface, `_drainPromise` field + `close()` fix, `_onTransportClose()` fix, `_onTransportError()` fix; explicit `ConnectionErrorPhase` import
- `test/connection/connection.test.ts` — Replaced workaround test with clean IN-02 assertion; added WR-01 transport-close-from-CONNECTING test
- `test/connection/close-destroy.test.ts` — New "RECONNECTING state transitions" describe block with 4 tests covering all RECONNECTING paths (WR-01, WR-02, WR-03)

## Decisions Made

- Imported `ConnectionErrorPhase` explicitly as a separate `import type` rather than relying on transitive inference from `MllpConnectionError` — makes the type annotation self-documenting
- Used `(conn as unknown as { _transition: ... })` cast in tests (consistent with `// eslint-disable` pattern) to force FSM to RECONNECTING state without needing to create full reconnect scaffolding
- WR-03 test uses real `setTimeout(resolve, 50)` in `beforeClose` (not fake timers) since the test just needs two concurrent calls to resolve successfully; fake timers not required here

## Deviations from Plan

None — plan executed exactly as written. All four edits applied verbatim. InMemoryTransport.destroy(reason) correctly fires onError then onClose, so the inline mock fallback was not needed.

## Issues Encountered

None. All four FSM bugs were straightforward targeted edits. TypeScript inferred types correctly after adding the explicit `ConnectionErrorPhase` import.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- Phase 3 gap closure complete: all 4 bugs (CR-01, WR-01, WR-02, WR-03) fixed and verified
- Connection FSM is now correct for Phase 4 server connections — CONNECTING → CLOSED on peer drop will not leave server-accepted connections stuck
- Phase 5 client reconnect logic will build on the correct RECONNECTING → CLOSED terminal path
- 230 tests passing, 0 TypeScript errors, 0 ESLint errors

---
*Phase: 03-transport-connection-fsm-observability*
*Completed: 2026-04-24*
