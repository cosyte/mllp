---
phase: 04-mllp-server
plan: "05"
subsystem: framing/connection/server
tags: [gap-closure, byteOffset, warnings, closedTotal, onMessage-type, dead-code]
dependency_graph:
  requires: [04-01, 04-02, 04-03, 04-04]
  provides: [SERVER-03, OBS-02]
  affects: [src/framing/decoder.ts, src/connection/connection.ts, src/server/server.ts]
tech_stack:
  added: []
  patterns:
    - per-frame warning accumulator field cleared after each _deliverFrame()
    - single-fire guard (let ended = false) on dual event listeners
    - local const narrowing to eliminate unjustified 'as' casts
key_files:
  created:
    - test/framing/decoder-byteoffset.test.ts
  modified:
    - src/framing/decoder.ts
    - src/connection/connection.ts
    - src/server/server.ts
    - test/server/server.test.ts
decisions:
  - FrameReaderOptions.onFrame now takes 3 arguments (payload, byteOffset, warnings) — breaking change from 1-arg form; all callsites updated
  - _frameWarnings accumulated unconditionally (before onWarning guard) so per-frame array works even without onWarning handler
  - _closedTotal single-fire guard uses closure variable (let ended = false) rather than removing listeners, since both 'close' and 'disconnect' are semantically valid removal triggers
  - autoAck as-cast replaced with local const + else-if narrowing (autoAck !== undefined) to satisfy TypeScript without unjustified casts
metrics:
  duration: "~7 minutes"
  completed: "2026-04-24"
  tasks_completed: 3
  files_modified: 4
  files_created: 1
---

# Phase 4 Plan 05: Gap Closure — byteOffset Threading, closedTotal Guard, onMessage void Type Summary

Closed three bugs identified in 04-VERIFICATION.md: FrameReader.onFrame threading byteOffset+warnings to server MessageMeta, _closedTotal double-counting on disconnect+close, and the misleading Buffer-returning onMessage type contract.

## What Was Built

### Task 1: Thread byteOffset + warnings through FrameReader and Connection (TDD)

**`src/framing/decoder.ts`**
- Added `_frameStartOffset: number = 0` — captures the stream byte offset of the VT that opens each frame
- Added `_frameWarnings: MllpWarning[] = []` — per-frame warning accumulator, cleared after each `_deliverFrame()`
- `_scanForVt`: records `this._frameStartOffset = this._byteOffset` when VT byte is found (and on the `allowMissingLeadingVt` path)
- `_emitWarning`: creates warning object unconditionally and pushes to `_frameWarnings` before (optionally) calling `onWarning` handler — ensures per-frame warnings work even without an `onWarning` subscriber
- `_deliverFrame`: captures `frameStart`/`frameWarnings` before clearing, resets `_frameWarnings = []`, calls `onFrame(payload, frameStart, frameWarnings)` (3 args instead of 1)
- `reset()`: resets `_frameStartOffset = 0` and `_frameWarnings = []`
- `FrameReaderOptions.onFrame` interface updated to `(payload: Buffer, byteOffset: number, warnings: readonly MllpWarning[]) => void` with full JSDoc on all three parameters

**`src/connection/connection.ts`**
- FrameReader construction wiring: `onFrame: (payload, byteOffset, warnings) => { this._onFrameDecoded(payload, byteOffset, warnings); }`
- `_onFrameDecoded` signature updated to `(payload: Buffer, byteOffset: number, warnings: readonly MllpWarning[]): void`
- `Object.freeze({ payload, connectionId, byteOffset, warnings })` — message event now carries all four fields

### Task 2: Fix server.ts (4 fixes + dead code removal)

**Fix 1 — Real byteOffset/warnings in message handler:**
Updated `conn.on('message', ...)` event type annotation to include `byteOffset: number` and `warnings: readonly MllpWarning[]`. Destructures and passes them directly to `MessageMeta` — removes the stubs (`byteOffset: 0`, `warnings: []`).

**Fix 2 — _closedTotal single-fire guard:**
Added `let ended = false` closure variable to `_onConnEnded`. Both `conn.once('close', _onConnEnded)` and `conn.once('disconnect', _onConnEnded)` remain registered, but only the first to fire increments `_closedTotal` and removes from `_connections`.

**Fix 3 — onMessage return type narrowed to void:**
`ServerOptions.onMessage` changed from `() => void | Buffer | Promise<Buffer>` to `() => void`. Updated JSDoc to direct callers to `conn.send()` for manual ACK.

**Fix 4 — Dead anonymous removeEventListener removed:**
`signal?.removeEventListener('abort', () => {/**/})` in the `connections.size === 0` early-return path removed entirely — the anonymous function reference never matched a registered handler, so this call was a no-op.

**Fix 5 — autoAck as-cast eliminated:**
`_sendAutoAck` refactored to use `const autoAck = this._opts.autoAck` and `else if (autoAck !== undefined)` branching, which TypeScript narrows to the function type without requiring an explicit `as` cast.

### Task 3: New tests in test/server/server.test.ts (6 tests, new describe block)

- `meta.byteOffset === 0` for first frame at stream start
- `meta.byteOffset === 5` when 5 SP preamble bytes precede the VT
- `meta.warnings` is empty array for canonical well-formed frame
- `meta.warnings` contains `MLLP_LF_AFTER_FS` for FS+LF terminated frame
- `closedTotal === 1` after peer close (single-fire guard prevents double-count)
- void-returning `onMessage` callback accepted by `createServer`

Also added `test/framing/decoder-byteoffset.test.ts` (8 tests, TDD RED committed first):
- byteOffset = 0 for first-byte VT
- byteOffset = 5 with 5-byte SP preamble
- consecutive frame offsets computed correctly
- reset() resets byteOffset to 0
- warnings empty for canonical frames
- warnings contains MLLP_LF_AFTER_FS for FS+LF frames
- per-frame warnings do not bleed across frames
- warnings collected even without onWarning handler

## Deviations from Plan

None — plan executed exactly as written. All 5 fixes applied in the order specified. The `autoAck` narrowing used `else if (autoAck !== undefined)` rather than the `Exclude<>` approach since TypeScript narrowed correctly through the local const.

## Test Results

- **Before:** 292 tests (19 test files)
- **After:** 306 tests (19 test files + 1 new decoder test file)
- `pnpm typecheck`: 0 errors
- `pnpm build`: success (dual ESM+CJS)
- Coverage: all 3 gap fixes verified by targeted tests

## Known Stubs

None — all stubs from Plan 04-04 (`byteOffset: 0`, `warnings: []`) have been replaced with real values.

## Threat Surface Scan

No new network endpoints, auth paths, or schema changes introduced. The `byteOffset` value is operational metadata (T-04-05-02: accepted disclosure). The per-frame warnings array reference is isolated by `_frameWarnings = []` reset before `onFrame` is called (T-04-05-01: mitigated — no shared mutable state).

## Self-Check: PASSED

| Item | Status |
|------|--------|
| src/framing/decoder.ts | FOUND |
| src/connection/connection.ts | FOUND |
| src/server/server.ts | FOUND |
| test/server/server.test.ts | FOUND |
| test/framing/decoder-byteoffset.test.ts | FOUND |
| 04-05-SUMMARY.md | FOUND |
| commit 56ee0a2 (RED tests) | FOUND |
| commit 1551d39 (GREEN implementation) | FOUND |
| commit b509e96 (server fixes) | FOUND |
| commit 3bac7ff (gap-closure tests) | FOUND |
| pnpm typecheck | 0 errors |
| pnpm test | 306/306 pass |
| pnpm build | success |
