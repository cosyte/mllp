---
phase: "04-mllp-server"
plan: "03"
subsystem: server
tags: [server, mllp, graceful-shutdown, drain-timeout, abortsignal, keepalive, barrel]
dependency_graph:
  requires:
    - "04-01"  # MllpServer skeleton — _connections Set, close() stub, listen() AbortSignal stub
    - "04-02"  # Auto-ACK dispatch — _sendAutoAck, encodeFrame wrapping
  provides:
    - "src/server/server.ts:close()"       # full drain coordination + AbortSignal
    - "src/server/server.ts:_drainAll()"   # Promise.all + side-effect setTimeout
    - "src/index.ts Phase 4 block"         # server public surface in main barrel
  affects:
    - "04-04"  # createStarterServer + getStats aggregation — uses close() drain path
tech_stack:
  added: []
  patterns:
    - "Promise.all(closePromises) + side-effect setTimeout for drain coordination (_drainAll)"
    - "timeoutHandle.unref() prevents process keep-alive during drain"
    - "DOMException('Aborted', 'AbortError') on AbortSignal rejection (Node 20+ global)"
    - "signal.addEventListener('abort', handler, { once: true }) + removeEventListener cleanup"
    - "Straggler loop iterates live this._connections Set (not snapshot) to avoid double-destroy"
key_files:
  created:
    - test/server/graceful-shutdown.test.ts
  modified:
    - src/server/server.ts
    - src/index.ts
decisions:
  - "_drainAll uses Promise.all (not Promise.race) — timeout is a side effect that destroys stragglers; Promise.all settles when all conn.close() promises settle after destroy() forces CLOSED"
  - "Straggler loop iterates live this._connections (not snapshotted array) — connections that drained normally are already removed from the Set, avoiding unnecessary destroy() calls"
  - "AbortSignal on close() wires a separate abortPromise and races it against _drainAll via Promise.race — on abort, all active connections are destroyed and promise rejects with DOMException"
  - "DOMException('Aborted', 'AbortError') used throughout (not plain Error) — matches Web API convention and Node 20+ global availability"
  - "Test for stuck-drain uses beforeClose hook override (set to never-resolving promise) to simulate a straggler — more reliable than relying on socket timing"
metrics:
  duration_seconds: 263
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_changed: 3
requirements_completed:
  - SERVER-06
  - SERVER-07
  - SERVER-09
---

# Phase 4 Plan 03: Graceful Shutdown + AbortSignal + Phase 4 Barrel Summary

`server.close()` with Promise.all drain coordination, straggler destroy() via side-effect setTimeout, AbortSignal wired on both `listen()` and `close()` using DOMException, and Phase 4 server exports appended to `src/index.ts`.

## What Was Built

**`src/server/server.ts`** — Full graceful shutdown implementation:

- `close(opts?)` replaces the Plan 01 skeleton:
  1. `this._netServer.close()` — stops accepting new connections immediately
  2. `this._listening = false`
  3. If `_connections` is empty: resolves immediately
  4. Wires AbortSignal handler (if provided) that force-destroys all connections and rejects with `DOMException('Aborted', 'AbortError')`
  5. `await _drainAll(drainTimeoutMs)` — Promise.all + side-effect setTimeout

- `_drainAll(drainTimeoutMs: number): Promise<void>` private method:
  - Snapshots `[...this._connections]` for the `conn.close()` call map
  - `Promise.all(closePromises)` — waits for all connections to settle
  - Side-effect `setTimeout` at `drainTimeoutMs` iterates **live** `this._connections` (not snapshot) and calls `conn.destroy()` on remaining stragglers
  - `timeoutHandle.unref()` — drain timer never keeps process alive
  - `clearTimeout(timeoutHandle)` in `finally` block

- `listen()` AbortSignal upgraded from `new Error('listen() aborted')` to `new DOMException('Aborted', 'AbortError')` — both pre-aborted and mid-listen abort paths covered

- `close()` AbortSignal: pre-aborted fast path + mid-drain abort handler with `removeEventListener` cleanup (T-04-03-02 mitigated)

- `deadPeerTimeoutMs` verified present and correct from Plan 01 (timer/unref/reset on 'message'/clear on 'close')

**`src/index.ts`** — Phase 4 server export block appended:
```typescript
// Phase 4: server
export {
  MllpServer,
  createServer,
  createStarterServer,
  type ServerOptions,
  type StarterServerOptions,
  type ServerStats,
  type MessageMeta,
} from './server/index.js';
```

**`test/server/graceful-shutdown.test.ts`** — 15 TDD tests covering:
- `close()` with zero connections resolves immediately
- `close()` on freshly-created (never-listened) server resolves immediately
- `close()` with one active connection resolves
- `close()` stops accepting new connections after call
- `close({ drainTimeoutMs: 100 })` with stuck `beforeClose` hook: straggler timeout fires destroy(), close resolves in ~100ms
- `close()` sets `listening=false`
- `_drainAll` private method exists on instance
- `listen({ signal })` with already-aborted signal → DOMException AbortError
- `listen({ signal })` abort during listen → DOMException AbortError
- Already-aborted signal does not leave server listening
- `close({ signal })` with already-aborted → DOMException AbortError
- `close({ signal })` abort during drain → connections destroyed, settles
- `deadPeerTimeoutMs` fires after idle timeout
- `deadPeerTimeoutMs` timer resets on message

## Tasks Completed

| Task | Commit | Files |
|------|--------|-------|
| RED: failing graceful-shutdown tests | 3ba9e50 | test/server/graceful-shutdown.test.ts |
| GREEN: close() drain + AbortSignal | 50f6d48 | src/server/server.ts, test/server/graceful-shutdown.test.ts |
| Task 2: Phase 4 barrel exports | 767d53a | src/index.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test timing assumption wrong for stuck-connection drain**
- **Found during:** Task 1 GREEN verification (1 test failing: `expected 0 to be >= 80`)
- **Issue:** The original test assumed `conn.close()` on an open socket would take ~100ms because the socket was open. But `Connection.close()` with a no-op `beforeClose` resolves immediately (transitions CONNECTED→DRAINING→DISCONNECTED and calls `transport.close()`). The drain timeout only fires when `beforeClose` itself hangs.
- **Fix:** Updated test to override `conn.beforeClose` to a never-resolving promise, correctly simulating a straggler that requires `conn.destroy()` from the timeout.
- **Files modified:** test/server/graceful-shutdown.test.ts
- **Commit:** 50f6d48

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `totalBytesIn: 0` | src/server/server.ts | ~430 | Plan 04 aggregates from `conn.getStats().bytesIn` |
| `totalBytesOut: 0` | src/server/server.ts | ~431 | Plan 04 aggregates from `conn.getStats().bytesOut` |
| `byteOffset: 0` | src/server/server.ts | ~600 | Plan 04 threads actual byte offsets from FrameReader |

Pre-existing from Plans 01/02. Do not prevent Plan 03's goal.

## Threat Surface Scan

All 4 threats from the plan's `<threat_model>` were addressed:

| Threat | Status |
|--------|--------|
| T-04-03-01 (DoS: drainTimeoutMs=0) | Accepted — `drainTimeoutMs: 0` immediately destroys all connections (safe fast-close behavior) |
| T-04-03-02 (DoS: signal handler accumulation) | Mitigated — `{ once: true }` + `removeEventListener` in finally block; no accumulation across test instances |
| T-04-03-03 (DoS: slow-close / connections never drain) | Mitigated — `drainTimeoutMs` deadline with `handle.unref()`; `conn.destroy()` force-closes stragglers; process can still exit |
| T-04-03-04 (DoS: dead-peer timer accumulation) | Mitigated — Plan 01 implementation verified: each timer stored in `let deadPeerTimer`; reset on 'message', cleared on 'close'; `.unref()` on all timers |

## TDD Gate Compliance

- RED gate: `3ba9e50` — `test(04-03): add failing tests for graceful shutdown, AbortSignal on listen/close, drain timeout`
- GREEN gate: `50f6d48` — `feat(04-03): implement graceful shutdown, drain-timeout coordination, AbortSignal on listen/close`

Both gates present in git log. No REFACTOR commit needed (code clean after GREEN).

## Self-Check: PASSED

- `src/server/server.ts` exists: YES
- `src/index.ts` Phase 4 block: YES (`grep "// Phase 4: server" src/index.ts` returns match)
- `test/server/graceful-shutdown.test.ts` exists: YES
- RED commit `3ba9e50` exists: YES
- GREEN commit `50f6d48` exists: YES
- barrel commit `767d53a` exists: YES
- `grep -n "_drainAll" src/server/server.ts`: returns match (lines 320, 368, 370, 389)
- `grep -n "Promise\.all" src/server/server.ts`: returns match (line 405)
- `grep -n "\.unref()" src/server/server.ts`: returns matches (lines 402, 583, 590)
- `grep -n "DOMException.*AbortError" src/server/server.ts`: returns 4 matches
- `grep -n "removeEventListener.*abort" src/server/server.ts`: returns 4 matches
- `grep -n "deadPeerTimeoutMs" src/server/server.ts`: returns 5 matches
- `grep "// Phase 4: server" src/index.ts`: match found
- `grep "createServer" src/index.ts`: match (no `type` prefix — function export)
- `grep "type ServerOptions" src/index.ts`: match
- `grep "type MessageMeta" src/index.ts`: match
- `grep "from.*server/index" src/index.ts`: match with `.js` extension
- `pnpm typecheck` exits 0: YES
- `pnpm test` exits 0: YES (274/274 tests pass)
- `pnpm build` exits 0: YES (ESM + CJS + DTS all succeeded)
- No `.slice()` in live code in `src/server/`: CONFIRMED (only in comment)
- No `console.*` in live code in `src/server/`: CONFIRMED (only in JSDoc examples)
- `grep -n "Promise\.all" src/server/server.ts` returns match in `_drainAll`: YES (line 405)
