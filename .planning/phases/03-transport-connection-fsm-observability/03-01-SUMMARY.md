---
phase: 03-transport-connection-fsm-observability
plan: "01"
subsystem: transport
tags: [transport, net-socket, error-types, connection-fsm-foundation]
dependency_graph:
  requires: [src/framing/error.ts, src/framing/decoder.ts]
  provides: [src/transport/index.ts, src/transport/net-transport.ts, src/connection/error.ts]
  affects: [src/connection/, src/server/, src/client/, src/testing/]
tech_stack:
  added: []
  patterns: [callback-bag-interface, set-once-handler-semantics, removeAllListeners-replace]
key_files:
  created:
    - src/transport/index.ts
    - src/transport/net-transport.ts
    - src/connection/error.ts
    - test/transport/net-transport.test.ts
    - test/connection/error.test.ts
  modified: []
decisions:
  - "ConnectionErrorPhase union locked as multiline type alias (idiomatic TS) with all 5 values: 'connect' | 'send' | 'receive' | 'close' | 'reconnect'"
  - "override readonly cause: Error required to narrow base Error.cause (unknown in ES2022 lib) — strict TS enforcement"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-24"
  tasks_completed: 3
  files_created: 5
  tests_added: 16
---

# Phase 3 Plan 01: Transport Interface, NetTransport & MllpConnectionError Summary

Transport callback-bag interface, net.Socket wrapper, and typed connection error class — the foundation all downstream Phase 3+ plans build on.

## Tasks Completed

| Task | Name | Commit | Files |
|------|------|--------|-------|
| 1 | Transport interface module | 88b1dca | src/transport/index.ts |
| 2 | NetTransport wrapping net.Socket | 1d49d26 | src/transport/net-transport.ts, test/transport/net-transport.test.ts |
| 3 | MllpConnectionError typed error | ea8575f | src/connection/error.ts, test/connection/error.test.ts |

## What Was Built

**`src/transport/index.ts`** — Pure TypeScript callback-bag interface `Transport` with 7 methods: `write(buf: Buffer): boolean`, `close(): void`, `destroy(reason?: Error): void`, `onData`, `onConnect`, `onClose`, `onError`. Set-once semantics documented: each `onXxx` registration replaces the prior handler, preventing listener accumulation across reconnect cycles. No EventEmitter inheritance, no imports required.

**`src/transport/net-transport.ts`** — `NetTransport implements Transport` wrapping `net.Socket`. The only place in the codebase that consumes net.Socket's EventEmitter surface (D-02). Each `onXxx(fn)` call uses `socket.removeAllListeners(event)` + `socket.on(event, fn)` for clean set-once replacement.

**`src/connection/error.ts`** — `MllpConnectionError extends Error` with `override readonly cause: Error` and `readonly phase: ConnectionErrorPhase`. Phase union locked to all 5 values (`'connect' | 'send' | 'receive' | 'close' | 'reconnect'`) upfront to avoid a breaking type change when `'reconnect'` is exercised in Phase 5 CLIENT-17. Error.captureStackTrace applied for clean stack traces.

## Test Results

16 tests across 2 files, all passing:
- `test/transport/net-transport.test.ts` — 11 tests (write, close, destroy, onData, onConnect, onClose, onError, set-once replacement semantics)
- `test/connection/error.test.ts` — 5 tests (instanceof, name, cause/phase, all 5 phases, cause identity)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Added `override` modifier to `cause` property**
- **Found during:** Task 3 — `pnpm typecheck` reported TS4114 error
- **Issue:** TypeScript 5.9 strict mode requires `override` when a subclass property shadows a base class member. `Error` in ES2022 lib defines `cause?: unknown`; our `cause: Error` narrows it and requires `override`.
- **Fix:** Changed `readonly cause: Error` to `override readonly cause: Error` in `MllpConnectionError`
- **Files modified:** `src/connection/error.ts`
- **Commit:** ea8575f (included in Task 3 commit)

**2. [Non-issue] Phase union multiline format**
- The plan acceptance criteria expected single-line `'connect' | 'send' | 'receive' | 'close' | 'reconnect'` for grep, but idiomatic TypeScript uses multiline union type aliases. All 5 values are present; the grep criterion is cosmetic. Tests confirm all 5 values work correctly.

## Verification Results

```
pnpm exec vitest run test/transport/ test/connection/error.test.ts
  2 test files, 16 tests — ALL PASSED

pnpm typecheck  — EXIT 0
pnpm lint       — EXIT 0

grep -rn '.slice(' src/transport/ src/connection/error.ts  — NO OUTPUT (SETUP-07 OK)
grep -rn 'console\.' src/transport/ src/connection/error.ts  — Only in JSDoc @example comments, not library code
grep -n 'implements Transport' src/transport/net-transport.ts  — MATCHES line 39
```

## Known Stubs

None — all files deliver complete implementation.

## Threat Flags

No new security surface introduced. All three files are internal library implementation:
- `Transport` interface — pure TypeScript types, no I/O
- `NetTransport` — wraps caller-provided `net.Socket`; no new network endpoints opened
- `MllpConnectionError` — plain Error subclass; message composed from library internals only (T-03-01-03: mitigated per plan threat model)

## Self-Check: PASSED

Files created:
- FOUND: src/transport/index.ts
- FOUND: src/transport/net-transport.ts
- FOUND: src/connection/error.ts
- FOUND: test/transport/net-transport.test.ts
- FOUND: test/connection/error.test.ts

Commits:
- FOUND: 88b1dca (feat(03-01): Transport callback-bag interface)
- FOUND: 1d49d26 (feat(03-01): NetTransport wrapping net.Socket with tests)
- FOUND: ea8575f (feat(03-01): MllpConnectionError typed error with phase union)
