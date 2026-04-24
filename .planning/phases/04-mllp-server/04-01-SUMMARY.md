---
phase: "04-mllp-server"
plan: "01"
subsystem: server
tags: [server, mllp, event-emitter, connection-tracking, framing]
dependency_graph:
  requires:
    - "03-transport-connection-fsm-observability"  # Connection, NetTransport, FrameReader
  provides:
    - "src/server/server.ts"  # MllpServer class + createServer() + types
    - "src/server/index.ts"   # server module barrel
  affects:
    - "04-02"  # auto-ACK + message routing built on this skeleton
    - "04-03"  # graceful shutdown fills in close() stub
    - "04-04"  # createStarterServer + getStats() aggregation fills in stubs
tech_stack:
  added: []
  patterns:
    - "EventEmitter extension (MllpServer extends EventEmitter, not net.Server)"
    - "NetTransport per accepted socket, Connection per NetTransport"
    - "SERVER_DEFAULT_FRAMING constant merged with caller framing opts"
    - "conn.once('close') + conn.once('disconnect') for _connections cleanup"
    - "ReturnType<typeof setTimeout> for deadPeerTimer (not NodeJS.Timeout)"
    - "eslint-disable-next-line for Plan 03 stub param"
key_files:
  created:
    - src/server/server.ts
    - src/server/index.ts
    - test/server/server.test.ts
  modified: []
decisions:
  - "Listened for both 'close' and 'disconnect' on Connection to clean up _connections — peer-close transitions to DISCONNECTED (not CLOSED) in the Phase 3 FSM"
  - "Used exactOptionalPropertyTypes-safe conditional spread for ConnectionOptions.onWarning"
  - "Replaced .slice() timestamp with explicit UTC getters in _buildMinimalAA (SETUP-07)"
  - "Added eslint-disable-next-line for close(opts) stub param — Plan 03 will use it"
  - "TDD: RED commit e40ef6b, GREEN commit 9ecbfd2"
metrics:
  duration_seconds: 372
  completed_date: "2026-04-24"
  tasks_completed: 2
  files_changed: 3
---

# Phase 4 Plan 01: MllpServer Skeleton Summary

MllpServer class wrapping net.Server with per-connection NetTransport + Connection pipeline, SERVER_DEFAULT_FRAMING, frozen event payloads, and server barrel export.

## What Was Built

**`src/server/server.ts`** — Full MllpServer class skeleton:
- `MllpServer extends EventEmitter` — wraps `net.Server` internally, never extends it (D-02)
- `createServer(opts): MllpServer` factory
- `listen(port, hostOrOpts?)` — resolves after `net.Server` 'listening'; emits frozen `{ port, host }` on `'listening'`; supports AbortSignal
- `close(_opts?)` — skeleton: stops net.Server, sets `_listening = false`; Plan 03 adds drain coordination
- `[Symbol.asyncDispose]()` — delegates to `close()`
- `getStats(): ServerStats` — returns `connections`, `activeConnections` (both `_connections.size`), `acceptedTotal`, `closedTotal`; `totalBytesIn`/`totalBytesOut` stubbed at 0 (Plan 04 aggregates)
- `_onSocketAccepted(socket)` — full pipeline: `socket.setKeepAlive()` → `NetTransport` → `Connection` → framing → events
- `SERVER_DEFAULT_FRAMING` constant: `allowFsOnly/allowLfAfterFs/allowLeadingWhitespace = true`, `allowMissingLeadingVt = false` (D-12)
- `deadPeerTimeoutMs` idle timer with `unref()` and reset on `'message'` (D-11)
- `autoAck: 'AA' | fn` paths with error-swallow-to-conn-emit (D-03/D-04)
- `_buildMinimalAA()` — MSH-10 extraction without parser for best-effort AA
- Phase 6 TLS comment at `new NetTransport(socket)` line

**`src/server/index.ts`** — Barrel re-exporting all public server surface following `src/connection/index.ts` pattern exactly.

**`test/server/server.test.ts`** — TDD tests covering all skeleton behaviors (15 tests, all passing).

## Tasks Completed

| Task | Commit | Files |
|------|--------|-------|
| RED: failing server tests | e40ef6b | test/server/server.test.ts |
| GREEN: MllpServer class + createServer() | 9ecbfd2 | src/server/server.ts |
| Task 2: server barrel | 8800d26 | src/server/index.ts |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Connection tracking uses both 'close' and 'disconnect' events**
- **Found during:** Task 1 GREEN verification
- **Issue:** Phase 3 FSM transitions CONNECTED → DISCONNECTED when peer closes gracefully; 'close' event only fires on CLOSED state. Listening only on 'close' meant connections leaked in `_connections` until `conn.destroy()` was called.
- **Fix:** Added `conn.once('disconnect', _onConnEnded)` alongside `conn.once('close', _onConnEnded)` so both graceful-disconnect and forced-close paths remove the connection from `_connections`.
- **Files modified:** src/server/server.ts
- **Commit:** 9ecbfd2

**2. [Rule 1 - Bug] exactOptionalPropertyTypes: onWarning undefined not assignable**
- **Found during:** Task 1 typecheck
- **Issue:** `new Connection({ transport, framing, onWarning: this._opts.onWarning })` — `onWarning` could be `undefined` but `ConnectionOptions.onWarning` is typed as `(w: MllpWarning) => void` (not `| undefined`) under `exactOptionalPropertyTypes: true`.
- **Fix:** Conditional spread — only include `onWarning` in ConnectionOptions when defined.
- **Files modified:** src/server/server.ts
- **Commit:** 9ecbfd2

**3. [Rule 2 - SETUP-07] .slice() in _buildMinimalAA timestamp**
- **Found during:** Task 1 ESLint check
- **Issue:** `new Date().toISOString().replace(...).slice(0, 14)` — SETUP-07 ESLint rule bans `.slice()` on non-array-literal expressions in src/server/.
- **Fix:** Replaced with explicit `Date.getUTCFullYear/Month/Date/Hours/Minutes/Seconds` calls with `padStart()`.
- **Files modified:** src/server/server.ts
- **Commit:** 9ecbfd2

**4. [Rule 2 - Missing] eslint-disable for Plan 03 stub param**
- **Found during:** Task 1 ESLint check
- **Issue:** `close(opts?)` with `opts` unused in skeleton body triggers `@typescript-eslint/no-unused-vars`.
- **Fix:** Added `// eslint-disable-next-line @typescript-eslint/no-unused-vars` comment with note that Plan 03 will use the param. The public API signature is preserved.
- **Files modified:** src/server/server.ts
- **Commit:** 9ecbfd2

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `totalBytesIn: 0` | src/server/server.ts | ~374 | Plan 04 aggregates from `conn.getStats().bytesIn` across `_connections` |
| `totalBytesOut: 0` | src/server/server.ts | ~375 | Plan 04 aggregates from `conn.getStats().bytesOut` across `_connections` |

These stubs do not prevent the plan goal (server skeleton + message routing). They are documented placeholders for Plan 04.

## Threat Surface Scan

No new threat surface beyond what the plan's `<threat_model>` documents. All 5 threats from the register were addressed:

| Threat | Status |
|--------|--------|
| T-04-01-01 (DoS: FrameReader unbounded) | Mitigated — maxFrameSizeBytes inherited from SERVER_DEFAULT_FRAMING merge |
| T-04-01-02 (DoS: _connections Set growth) | Mitigated — removed on both 'close' and 'disconnect' events |
| T-04-01-03 (Spoofing: remoteAddress) | Accepted — documented in plan |
| T-04-01-04 (Info: MllpWarning.message) | Mitigated — warnings contain only codes/offsets, no payload bytes |
| T-04-01-05 (DoS: dead-peer timer accumulation) | Mitigated — all timers call `.unref()`, cleared on conn 'close' |

## Self-Check: PASSED

All files exist on disk. All commits exist in git log. TypeScript typecheck clean. All 245 tests pass (230 prior + 15 new server tests). ESLint clean on src/server/. No .slice() in live code. No console.* in live code. 8 Object.freeze calls in server.ts (>= 3 required).
