---
phase: 03-transport-connection-fsm-observability
plan: "02"
subsystem: testing
tags: [in-memory-transport, transport, test-double, deterministic, backpressure]

# Dependency graph
requires:
  - phase: 03-01
    provides: Transport interface (callback-bag) that InMemoryTransport implements

provides:
  - InMemoryTransport class with pair()/split()/pause()/resume()/destroy()/simulateConnect()
  - src/testing/in-memory-transport.ts — deterministic socket-free Transport test double
  - src/testing/index.ts — testing subpath barrel (stub replaced with real export)
  - test/testing/in-memory-transport.test.ts — 25 tests covering TRANS-02/03/04

affects:
  - 03-03 (Connection class — uses InMemoryTransport for socket-free FSM tests)
  - 03-04 (observability/stats tests — uses InMemoryTransport)
  - Phase 4 Server tests
  - Phase 5 Client tests
  - Phase 7 Testing/Fixtures (InMemoryTransport is the primary test double)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Synchronous inline delivery: write() fires peer onData before returning (D-03)"
    - "_writeDepth counter for re-entrancy detection — throws on recursive write from onData"
    - "Buffer.from(buf) copy in pause queue to prevent mutation bugs (T-03-02-02)"
    - "Private constructor + static pair() factory for always-connected Transport pairs"

key-files:
  created:
    - src/testing/in-memory-transport.ts
    - test/testing/in-memory-transport.test.ts
  modified:
    - src/testing/index.ts

key-decisions:
  - "Synchronous inline delivery chosen (D-03) — onData fires during write(), not via microtask or setImmediate"
  - "pause() queues Buffer.from(buf) copies, not views — caller buffer mutation after write() does not corrupt queue"
  - "simulateConnect() added as test helper to fire onConnect — not part of Transport interface but public on InMemoryTransport"
  - "Private constructor enforces pair() as the only creation path — standalone InMemoryTransport without a peer is unsupported"

patterns-established:
  - "InMemoryTransport.pair() is the canonical way to create socket-free Transport pairs for all future tests"
  - "Tests that can run over InMemoryTransport MUST run over InMemoryTransport (CLAUDE.md guardrail)"

requirements-completed:
  - TRANS-02
  - TRANS-03
  - TRANS-04

# Metrics
duration: 4min
completed: "2026-04-24"
---

# Phase 3 Plan 02: InMemoryTransport Summary

**Deterministic socket-free Transport test double: InMemoryTransport with synchronous delivery, split/pause/resume/destroy, and 25-test coverage of TRANS-02/03/04**

## Performance

- **Duration:** ~4 min
- **Started:** 2026-04-24T16:36:58Z
- **Completed:** 2026-04-24T16:40:30Z
- **Tasks:** 3
- **Files modified:** 3 (2 created, 1 modified)

## Accomplishments

- Implemented InMemoryTransport implementing the Transport interface — synchronous delivery, re-entrancy guard, split/pause/resume/destroy
- Replaced the Phase 2 stub in src/testing/index.ts with a real InMemoryTransport re-export; build and typecheck clean
- Created 25-test suite covering all TRANS-02/03/04 requirements including bidirectional round-trips, chunked delivery, backpressure queueing, destroy ordering, and the re-entrancy guard

## Task Commits

Each task was committed atomically:

1. **Task 1: InMemoryTransport implementation** - `3bb75f4` (feat)
2. **Task 2: Replace testing barrel stub** - `2d93d5e` (feat)
3. **Task 3: InMemoryTransport tests** - `54bdddf` (test)

## Files Created/Modified

- `src/testing/in-memory-transport.ts` — InMemoryTransport class: pair(), write(), close(), destroy(), onData/onConnect/onClose/onError, split(), pause(), resume(), simulateConnect(), _deliverChunk()
- `src/testing/index.ts` — Replaced TESTING_STUB placeholder with `export { InMemoryTransport }` re-export
- `test/testing/in-memory-transport.test.ts` — 25 tests covering all TRANS-02/03/04 behaviors

## Decisions Made

- **Private constructor**: InMemoryTransport uses a private constructor so pair() is the only creation path. A standalone InMemoryTransport without a _peer is legal but write() returns false until paired — this is acceptable for close()/destroy() tests that only need one end.
- **simulateConnect() public**: The method fires onConnect and is not part of the Transport interface. Made public on InMemoryTransport so tests can trigger the connect event without special ceremony.
- **close() marks both ends destroyed**: Mirrors TCP FIN — calling close() on end A marks A and B as destroyed and fires both onClose handlers, preventing further writes in either direction.

## Deviations from Plan

None — plan executed exactly as written. The implementation matched the plan's code template with minor additions (more detailed JSDoc, extra test cases for edge cases like idempotent close/destroy, buffer mutation safety test).

## Issues Encountered

None. pnpm install was needed in the worktree (node_modules missing — expected for a fresh worktree), then all tasks proceeded cleanly.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- InMemoryTransport is ready for use in Phase 3 plans 03 and 04 (Connection FSM and observability)
- The `@cosyte/hl7-mllp/testing` subpath builds cleanly and exports InMemoryTransport
- All subsequent test phases (4, 5, 7) can import InMemoryTransport directly from `../../src/testing/in-memory-transport.js` or via the barrel

---
*Phase: 03-transport-connection-fsm-observability*
*Completed: 2026-04-24*

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/testing/in-memory-transport.ts | FOUND |
| src/testing/index.ts | FOUND |
| test/testing/in-memory-transport.test.ts | FOUND |
| .planning/phases/03-transport-connection-fsm-observability/03-02-SUMMARY.md | FOUND |
| Commit 3bb75f4 (feat: InMemoryTransport implementation) | FOUND |
| Commit 2d93d5e (feat: barrel stub replaced) | FOUND |
| Commit 54bdddf (test: 25 tests) | FOUND |
