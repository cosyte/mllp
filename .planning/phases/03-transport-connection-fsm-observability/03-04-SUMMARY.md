---
phase: 03-transport-connection-fsm-observability
plan: "04"
subsystem: connection
tags: [connection, fsm, drain, close, integration, barrel, transport]

dependency_graph:
  requires:
    - 03-01  # Transport interface + NetTransport
    - 03-02  # InMemoryTransport (used in all new tests)
    - 03-03  # Connection class (augmented here)
  provides:
    - Drain timeout enforcement in close() via Promise.race() (LIFE-05)
    - CONNECTING/RECONNECTING cancellation in close() (LIFE-05)
    - 14 close/destroy edge-case tests
    - 7 integration tests — round-trip over InMemoryTransport (TRANS-03)
    - Phase 3 public exports in src/index.ts
    - NetTransport re-exported from transport barrel
  affects:
    - Phase 4 Server (registers beforeClose() hook — drain contract now enforced)
    - Phase 5 Client (same)

tech-stack:
  added: []
  patterns:
    - "Promise.race([beforeClose, sleep(timeout)]) for drain timeout enforcement"
    - "handle.unref() on drain timeout timer — does not keep process alive (T-03-04-01)"
    - "close() during CONNECTING/RECONNECTING → CLOSED immediately (LIFE-05)"
    - "Idempotent close() re-entry when already DRAINING"

key-files:
  created:
    - test/connection/close-destroy.test.ts
    - test/connection/integration.test.ts
  modified:
    - src/connection/connection.ts
    - src/index.ts
    - src/transport/index.ts

key-decisions:
  - "Promise.race with unref()'d timer — drain timeout does not keep process alive"
  - "close() during CONNECTING/RECONNECTING cancels immediately via transport.destroy() — no drain needed"
  - "DRAINING re-entry is idempotent — second close() call awaits the same drain"
  - "NetTransport added to transport/index.ts barrel to enable src/index.ts re-export"
  - "InMemoryTransport NOT added to main barrel — stays in @cosyte/hl7-mllp/testing subpath only"

requirements-completed:
  - LIFE-05
  - TRANS-01
  - TRANS-02
  - TRANS-03

metrics:
  duration_minutes: 15
  completed_date: "2026-04-24"
  tasks_completed: 5
  tasks_total: 5
  files_created: 2
  files_modified: 3
---

# Phase 3 Plan 04: Close/Destroy, Integration Tests & Main Barrel Summary

**One-liner:** `close()` drain timeout enforcement via `Promise.race()` with CONNECTING/RECONNECTING cancellation, 21 new tests over InMemoryTransport, and Phase 3 public API re-exports in the main barrel.

## What Was Built

### `src/connection/connection.ts` — drain timeout enforcement (LIFE-05)

The existing `close()` implementation called `beforeClose()` without enforcing the timeout. This plan replaced it with:

- **CONNECTING/RECONNECTING cancellation**: `close()` from these states transitions directly to `CLOSED` and calls `transport.destroy()` — no drain attempted, no timer leak (LIFE-05, T-03-04-02).
- **`_drainWithTimeout(timeoutMs)`**: private method that races `beforeClose(timeoutMs)` against a `setTimeout` promise. Timeout fires → `DRAINING → CLOSED` + `transport.destroy()`. Normal completion → `DRAINING → DISCONNECTED` + `transport.close()`.
- **`handle.unref()`**: drain timer is unref'd so it does not keep the Node.js process alive after all other work finishes (T-03-04-01).
- **Idempotent DRAINING re-entry**: `close()` called while already DRAINING awaits the existing drain rather than starting a second one.

### `test/connection/close-destroy.test.ts` — 14 tests (LIFE-05)

| Suite | Tests |
|-------|-------|
| close() during CONNECTING | 3 |
| close() during CONNECTED → DRAINING → DISCONNECTED | 3 |
| close() drain timeout | 3 |
| destroy() | 5 |

All using InMemoryTransport and `vi.useFakeTimers()` for deterministic timeout verification.

### `test/connection/integration.test.ts` — 7 tests (TRANS-03)

Full send→receive round-trips over `InMemoryTransport.pair()` with no real sockets:

| Test | Coverage |
|------|----------|
| Client sends, server receives | TRANS-03 basic round-trip |
| Server sends ACK back to client | Bidirectional (TRANS-03) |
| split(1) one-byte chunking | TRANS-04 chunk reassembly |
| connectionId consistent across events | LIFE-04 |
| getStats() JSON round-trip | OBS-04 |
| Multiple messages in sequence | Ordering guarantee |
| bytesIn/bytesOut tracked | OBS-03 |

### `src/index.ts` — Phase 3 public exports

Added:
- `Transport` (type re-export)
- `NetTransport` (value re-export)
- `Connection`, `ConnectionOptions`, `ConnectionState`, `ConnectionStats`, `StateChangeEvent`, `ReconnectingEvent` (types + value)
- `MllpConnectionError`, `ConnectionErrorPhase`

`InMemoryTransport` intentionally excluded — stays in `@cosyte/hl7-mllp/testing` subpath only.

### `src/transport/index.ts` — NetTransport barrel addition

Added `export { NetTransport } from './net-transport.js'` so the main barrel can re-export it from a single transport entry point.

## Task Commits

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Drain timeout enforcement | `94ee2ae` | src/connection/connection.ts |
| 2 | close/destroy edge-case tests | `b993a59` | test/connection/close-destroy.test.ts |
| 3 | Integration tests | `a785612` | test/connection/integration.test.ts |
| 4 | Main barrel update | `02daf65` | src/index.ts, src/transport/index.ts, src/connection/connection.ts (lint fix) |
| 5 | Full test suite verification | (no commit — verification only) | — |

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm test` | 225 tests, 0 failures (14 test files) |
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | 0 errors |
| `pnpm build` | ESM + CJS, 3 subpaths |
| No `.slice()` in src/transport\|connection\|testing | Confirmed |
| No `console.*` in library code | Confirmed (only in JSDoc examples) |
| `InMemoryTransport` not in src/index.ts | Confirmed |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Unnecessary type assertion in `_drainWithTimeout`**
- **Found during:** Task 4 (pnpm lint)
- **Issue:** `(handle as NodeJS.Timeout).unref()` — the assertion is unnecessary since `setTimeout` already returns `NodeJS.Timeout` in Node.js; ESLint rule `@typescript-eslint/no-unnecessary-type-assertion` flagged it.
- **Fix:** Simplified to `handle.unref()` with no cast.
- **Files modified:** `src/connection/connection.ts`
- **Commit:** `02daf65` (included in Task 4 commit)

**2. [Rule 3 - Blocking] `NetTransport` not in `transport/index.ts` barrel**
- **Found during:** Task 4 (implementing main barrel)
- **Issue:** `src/index.ts` re-exports from `./transport/index.js`, but `NetTransport` was only in `net-transport.ts` without a barrel re-export — making `export { NetTransport } from './transport/index.js'` a dead import.
- **Fix:** Added `export { NetTransport } from './net-transport.js'` to `src/transport/index.ts`.
- **Files modified:** `src/transport/index.ts`
- **Commit:** `02daf65`

## Known Stubs

None — all public API surfaces are fully implemented. The `beforeClose` no-op from Plan 03 is now enforced by the timeout mechanism. Phase 4 (Server) and Phase 5 (Client) will override `beforeClose` with real drain logic.

## Threat Flags

No new security-relevant surfaces beyond those in the plan's `<threat_model>`. All mitigations implemented:

| Threat | Mitigation Applied |
|--------|--------------------|
| T-03-04-01: Timer keeps process alive | `handle.unref()` on drain timeout |
| T-03-04-02: close() during CONNECTING hangs | Immediate CLOSED + transport.destroy() |
| T-03-04-03: InMemoryTransport in main barrel | Excluded — test-only subpath only |
| T-03-04-04: Multiple Promise.race timeout accumulation | One timeout per close(); destroy() immediately exits DRAINING |

## Self-Check: PASSED

| Item | Status |
|------|--------|
| `src/connection/connection.ts` — _drainWithTimeout | FOUND |
| `src/connection/connection.ts` — Promise.race | FOUND |
| `test/connection/close-destroy.test.ts` | FOUND |
| `test/connection/integration.test.ts` | FOUND |
| `src/index.ts` — Phase 3 exports | FOUND |
| `src/transport/index.ts` — NetTransport export | FOUND |
| Commit 94ee2ae (Task 1 — drain timeout) | FOUND |
| Commit b993a59 (Task 2 — close/destroy tests) | FOUND |
| Commit a785612 (Task 3 — integration tests) | FOUND |
| Commit 02daf65 (Task 4 — barrel update) | FOUND |
| pnpm test: 225 passing | VERIFIED |
| pnpm typecheck: 0 errors | VERIFIED |
| pnpm lint: 0 errors | VERIFIED |
| pnpm build: success | VERIFIED |
