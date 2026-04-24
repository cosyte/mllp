---
phase: 02-framing-codec-warnings
plan: "01"
subsystem: framing
tags: [constants, warning-codes, error-types, tdd]
dependency_graph:
  requires: []
  provides:
    - src/framing/constants.ts
    - src/framing/registry.ts
    - src/framing/error.ts
  affects:
    - All subsequent Phase 2 plans (02-02, 02-03, 02-04)
    - Phase 3+ Transport/Connection/Server/Client layers
tech_stack:
  added: []
  patterns:
    - Object.freeze() for immutable warning objects
    - Buffer.from(snippet.subarray(0, 64)) for safe copied snippet
    - override readonly name in Error subclass (noImplicitOverride)
    - Error.captureStackTrace for clean stack traces in V8
key_files:
  created:
    - src/framing/constants.ts
    - src/framing/registry.ts
    - src/framing/error.ts
    - test/framing/constants.test.ts
    - test/framing/registry.test.ts
    - test/framing/error.test.ts
  modified: []
decisions:
  - "MllpFramingError constructor takes snippet as positional param (not optional) to match ERR-01 contract; message is the optional param — consistent with test expectations in plan"
  - "OnWarning type exported from registry.ts as a convenience alias (not in plan spec but useful for downstream typed callbacks)"
  - "Error.captureStackTrace applied inside MllpFramingError constructor for clean V8 stack frames"
metrics:
  duration: "~10 minutes"
  completed: "2026-04-24T15:19:33Z"
  tasks_completed: 2
  files_created: 6
  tests_passed: 20
---

# Phase 02 Plan 01: MLLP Constants, Warning Registry, and Framing Error — Summary

**One-liner:** Foundational type layer — 11-code WarningCode union, frozen MllpWarning factory, and MllpFramingError with copied snippet Buffer.

## Status: COMPLETE

## Tasks Completed

| Task | Name | Status | Commit |
|------|------|--------|--------|
| 1 | MLLP byte constants module | PASS | 3c473c8 |
| 2 | WarningCode registry + MllpFramingError class | PASS | 3c473c8 |

## Files Created

| File | Purpose |
|------|---------|
| `src/framing/constants.ts` | VT=0x0B, FS=0x1C, CR=0x0D, LF=0x0A, DEFAULT_MAX_FRAME_SIZE=16MiB |
| `src/framing/registry.ts` | WarningCode (11 codes), MllpWarning, OnWarning, createWarning() |
| `src/framing/error.ts` | MllpFramingError with code, byteOffset, snippet (copied ≤64 bytes) |
| `test/framing/constants.test.ts` | 5 tests — byte value assertions |
| `test/framing/registry.test.ts` | 6 tests — frozen objects, all 11 codes, connectionId undefined |
| `test/framing/error.test.ts` | 9 tests — instanceof, name, snippet copy, cap at 64 bytes |

## Test Results

```
Test Files: 3 passed (3)
     Tests: 20 passed (20)
```

All verifications passed:
- `pnpm exec vitest run test/framing/` — 20/20 pass
- `pnpm typecheck` — exits 0 (no TypeScript errors)
- `pnpm lint` — exits 0 (no ESLint errors)
- `grep -rn '\.slice(' src/framing/` — no output (SETUP-07 compliant)
- `grep -rn 'console\.' src/framing/` — no output
- `grep -c 'MLLP_' src/framing/registry.ts` — 14 matches (all 11 codes covered)

## TDD Gate Compliance

- RED: Tests written and confirmed failing before implementation
- GREEN: All 20 tests passing after implementation
- REFACTOR: No refactor step needed — code was clean on first pass

## Deviations from Plan

### Minor additions (Rule 2 — missing utility export)

**1. [Rule 2 - Missing Export] Added `OnWarning` type to `registry.ts`**
- **Found during:** Task 2 implementation
- **Issue:** Plan specified `MllpWarning`, `WarningCode`, `createWarning` exports only, but downstream consumers (Phase 3+ Connection, Phase 4 Server, Phase 5 Client) all need a typed callback alias
- **Fix:** Added `export type OnWarning = (warning: MllpWarning) => void;` — a one-line addition
- **Files modified:** `src/framing/registry.ts`
- **Commit:** 3c473c8

**2. [Plan adaptation] `MllpFramingError` constructor parameter order**
- The plan overview shows `(code, byteOffset, message, snippet?)` but the plan action block and test expectations use `(code, byteOffset, snippet, message?)`. The test expectations in the plan are the authoritative contract — `snippet` is the third positional param and `message` is optional fourth. Implemented per test expectations.

## Threat Mitigations Applied

| Threat ID | Mitigation | Location |
|-----------|------------|----------|
| T-02-01-01 | Object.freeze() on every MllpWarning | `createWarning()` in registry.ts |
| T-02-01-03 | snippet capped at MAX_SNIPPET_BYTES (64) | `MllpFramingError` constructor |
| T-02-01-04 | snippet copied via Buffer.from(source.subarray(...)) | `MllpFramingError` constructor |

## Known Stubs

None — all exports are fully implemented. `connectionId: undefined` in `createWarning()` is intentional per D-07, not a stub; Phase 3 enriches it.

## Threat Flags

None — no new network endpoints, auth paths, file access patterns, or schema changes introduced. All code is pure in-memory type and factory definitions.

## Self-Check

- [x] `src/framing/constants.ts` exists
- [x] `src/framing/registry.ts` exists
- [x] `src/framing/error.ts` exists
- [x] `test/framing/constants.test.ts` exists
- [x] `test/framing/registry.test.ts` exists
- [x] `test/framing/error.test.ts` exists
- [x] Commit 3c473c8 exists in git log

## Self-Check: PASSED
