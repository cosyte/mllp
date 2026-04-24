---
phase: "04-mllp-server"
plan: "04"
subsystem: server
tags: [server, mllp, createStarterServer, getStats, observability, signals, asyncDispose, frozen-events]
dependency_graph:
  requires:
    - "04-01"  # MllpServer skeleton — _connections Set, StarterServerOptions stub, getStats stub
    - "04-02"  # Auto-ACK dispatch — _sendAutoAck, encodeFrame wrapping
    - "04-03"  # Graceful shutdown — close(), _drainAll, AbortSignal
  provides:
    - "src/server/server.ts:createStarterServer()"   # three-line server factory (SERVER-08)
    - "src/server/server.ts:getStats()"              # live byte aggregation (OBS-02)
    - "src/server/server.ts:MllpServer[Symbol.asyncDispose]"  # await using support (SERVER-11)
    - "src/server/server.ts:close()"                 # emits frozen 'close' event (SERVER-10)
  affects:
    - "05-mllp-client"  # client follows same Symbol.asyncDispose + getStats patterns
    - "08-examples-readme"  # createStarterServer is the three-line north-star example
tech_stack:
  added: []
  patterns:
    - "createStarterServer delegates to createServer() + server.listen() — factory wraps factory"
    - "handleSignals: process.once(SIGTERM/SIGINT) + server.once('close', cleanup) for zero-accumulation signal handling in tests"
    - "getStats() aggregates from live Set<Connection> at call time — no cached counter for bytes"
    - "MllpServer emits 'close' with Object.freeze({}) at end of both drain paths in close()"
key_files:
  created:
    - test/server/starter-server.test.ts
  modified:
    - src/server/server.ts
key-decisions:
  - "server.once('close', cleanup) removes SIGTERM/SIGINT handlers early when close() fires before signal — prevents handler accumulation across test instances"
  - "close() now emits MllpServer 'close' event (Object.freeze({})) at end of drain — needed for signal cleanup hook, also completes frozen-event audit"
  - "getStats() iterates live this._connections Set (not snapshotted) for byte aggregation — correct for real-time operational metrics"

requirements-completed:
  - SERVER-08
  - SERVER-10
  - SERVER-11
  - OBS-02

# Metrics
duration: 5min
completed: "2026-04-24"
---

# Phase 4 Plan 04: createStarterServer + getStats() + Frozen Event Audit Summary

**`createStarterServer` one-call factory with handleSignals, live-aggregating `server.getStats()`, and complete frozen-event audit — delivering the "three lines of code" north-star (SERVER-08, OBS-02, SERVER-10, SERVER-11)**

## Performance

- **Duration:** 5 min
- **Started:** 2026-04-24T19:12:18Z
- **Completed:** 2026-04-24T19:17:00Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2 (src/server/server.ts, test/server/starter-server.test.ts)

## Accomplishments

- `createStarterServer({ port, onMessage })` resolves with a listening server in one call — auto-ACK AA default, 30 s drain, Symbol.asyncDispose wired, no manual `.listen()` needed (SERVER-08)
- `server.getStats()` stub replaced with live byte aggregation over `this._connections` — both `connections` and `activeConnections` fields, all fields JSON-serializable (OBS-02)
- `handleSignals: true` registers `process.once('SIGTERM'/'SIGINT')` with automatic cleanup via `server.once('close', ...)` — `process.listenerCount('SIGTERM') === 0` after `server.close()` (D-09, T-04-04-01)
- `close()` now emits server-level `'close'` event with `Object.freeze({})` at both drain completion paths, completing the frozen-event audit (SERVER-10)
- `Symbol.asyncDispose` already present from Plan 01; verified it compiles and tests confirm `await server[Symbol.asyncDispose]()` calls `close()` (SERVER-11)
- 18 new TDD tests added (RED: 5 failing → GREEN: all 292 pass)

## Task Commits

1. **RED: failing tests for Plan 04** — `0adcec5` (test)
2. **GREEN: implementation** — `1f56edc` (feat)

## Files Created/Modified

- `src/server/server.ts` — `StarterServerOptions` JSDoc + `@example` completed; `getStats()` stub replaced with live aggregation; `createStarterServer` gained `handleSignals` support; `close()` emits frozen `'close'` event
- `test/server/starter-server.test.ts` — 18 TDD tests: createStarterServer, getStats() byte aggregation, Symbol.asyncDispose, handleSignals (SIGTERM/SIGINT register + cleanup), frozen event payloads audit

## Decisions Made

- **`server.once('close', cleanup)` for signal handler removal:** `process.once` handlers self-remove when signals fire, but in tests close() fires before any signal. Adding `server.once('close', ...)` ensures early cleanup so `process.listenerCount('SIGTERM') === 0` after close — critical for test isolation.
- **`close()` emits `'close'` event:** MllpServer's own `'close'` event was never wired in Plans 01-03. Adding it in both `close()` return paths (zero-connections path and post-drain path) was needed for the signal cleanup hook and also completes the public event surface documented in JSDoc.
- **`getStats()` iterates live Set:** Real-time operational metrics should reflect live state. Snapshotting would introduce stale data. For-of over a Set is safe in single-threaded Node.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] MllpServer.close() was not emitting a server-level `'close'` event**
- **Found during:** Task 1 GREEN (handleSignals cleanup test failing)
- **Issue:** `server.once('close', cleanup)` in `createStarterServer` depended on the server emitting its own `'close'` event, but `close()` completed without emitting one. The `'close'` event was documented in the class JSDoc as a public event but was never wired. This also meant the frozen-event audit (SERVER-10) was incomplete.
- **Fix:** Added `this.emit('close', Object.freeze({}))` at the end of both `close()` completion paths — the zero-connections early return and the post-drain path.
- **Files modified:** src/server/server.ts (lines 369, 401)
- **Verification:** `handleSignals` cleanup tests pass; `Object.freeze` count is now 11; `pnpm test` 292/292
- **Committed in:** `1f56edc`

---

**Total deviations:** 1 auto-fixed (Rule 2 — missing critical functionality)
**Impact on plan:** Essential for correct signal-handler cleanup and completion of frozen-event audit. No scope creep.

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `byteOffset: 0` | src/server/server.ts | ~640 | Pre-existing from Plans 01-02; threading actual byte offsets from FrameReader is a Phase 7 enhancement, not Phase 4 scope |

## Threat Surface Scan

All 5 threats from the plan's `<threat_model>` addressed:

| Threat | Status |
|--------|--------|
| T-04-04-01 (DoS: SIGTERM handler accumulation) | Mitigated — `process.once` self-removes on first fire; `server.once('close', cleanup)` removes early on close(); `process.listenerCount('SIGTERM') === 0` after close() verified by test |
| T-04-04-02 (EoP: process.exit in sigHandler) | Accepted — operator opts in via `handleSignals: true`; expected behavior for k8s/systemd |
| T-04-04-03 (Info: getStats totalBytesIn/Out) | Accepted — byte counters are non-sensitive operational metrics |
| T-04-04-04 (DoS: getStats during connection churn) | Accepted — for-of over Set is safe in single-threaded Node; stale counts acceptable |
| T-04-04-05 (Tampering: mutable event payloads) | Mitigated — all event payloads frozen; `close()` now emits frozen `'close'` completing the audit |

## TDD Gate Compliance

- RED gate: `0adcec5` — `test(04-04): add failing tests for createStarterServer, getStats() byte aggregation, handleSignals, Symbol.asyncDispose`
- GREEN gate: `1f56edc` — `feat(04-04): implement createStarterServer handleSignals, getStats() byte aggregation, frozen close event`

Both gates present in git log. No REFACTOR commit needed.

## Self-Check

Files exist:
- `src/server/server.ts`: YES
- `test/server/starter-server.test.ts`: YES

Commits exist:
- RED `0adcec5`: YES
- GREEN `1f56edc`: YES

Acceptance criteria:
- `grep -n "createStarterServer" src/server/server.ts` → 7 matches (want >= 2): YES
- `grep -n "StarterServerOptions" src/server/server.ts` → interface with `port: number` field: YES
- `grep -n "Symbol.asyncDispose" src/server/server.ts` → class method at line 446: YES
- `grep -n "handleSignals" src/server/server.ts` → process.once usage at line 789: YES
- `grep -n "removeListener.*SIGTERM" src/server/server.ts` → cleanup at line 796: YES
- `grep -n "totalBytesIn\|totalBytesOut"` in getStats() body → loop accumulation at lines 464-469: YES
- `grep -n "connections:.*_connections.size" src/server/server.ts` → line 475: YES
- `grep -rn "this.emit" src/server/server.ts | grep -v "Object.freeze\|error"` → 2 matches (both verified frozen via multi-line pattern — `frozenEvent` variable + multi-line connection emit): PASS
- `grep -c "Object.freeze" src/server/server.ts` → 11 (want >= 5): YES
- `pnpm typecheck` exits 0: YES
- `pnpm test` exits 0 — 292/292 pass: YES
- `pnpm build` exits 0: YES
- No `.slice()` in src/server/: YES
- No `console.*` in src/server/: YES

## Self-Check: PASSED

---
*Phase: 04-mllp-server*
*Completed: 2026-04-24*
