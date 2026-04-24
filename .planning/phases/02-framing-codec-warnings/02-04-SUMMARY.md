---
phase: 02-framing-codec-warnings
plan: "04"
subsystem: framing
tags: [strict-mode, barrel, round-trip, byte-fidelity, WARN-08, FRAME-12]
dependency_graph:
  requires: [02-02, 02-03]
  provides: [src/framing/index.ts, src/index.ts Phase-2 surface]
  affects: [Phase 3 Transport imports, Phase 4/5 Server/Client imports]
tech_stack:
  added: []
  patterns:
    - Strict-mode escalation guard before tolerance warning emission
    - Named barrel re-exports (no wildcard) for tree-shaking
    - LCG deterministic PRNG for corpus generation in tests (no crypto dep)
key_files:
  created:
    - src/framing/index.ts
    - test/framing/strict-mode.test.ts
    - test/framing/byte-fidelity.test.ts
  modified:
    - src/framing/decoder.ts
    - src/index.ts
decisions:
  - "strict checks placed BEFORE tolerance warning emission in every FSM branch — cannot be bypassed by combining with opt-ins (T-02-04-01)"
  - "MLLP_EMPTY_PAYLOAD and MLLP_TRAILING_BYTES intentionally excluded from strict escalation per WARN-08 spec"
  - "1 MiB corpus tested with full push; 8 KiB corpus used for 1-byte chunk test to avoid O(n) slowness"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-24"
  tasks_completed: 2
  files_created: 3
  files_modified: 2
---

# Phase 2 Plan 04: Strict Mode, Barrel Exports, and Round-Trip Tests Summary

**One-liner:** Strict mode escalation (WARN-08) in FrameReader, `src/framing/index.ts` barrel, Phase 2 re-exports in `src/index.ts`, and FRAME-12 byte-fidelity round-trip tests.

## Status: COMPLETE

## What Was Built

### Task 1: Strict mode in FrameReader + barrel exports

Added `strict?: boolean` to `FrameReaderOptions` in `src/framing/decoder.ts`. When `strict: true`, all four FSM tolerance paths escalate to `MllpFramingError` instead of emitting warnings:

| Path | FSM method | Escalated code |
|------|------------|----------------|
| `allowLeadingWhitespace` + whitespace byte | `_scanForVt` | `MLLP_MISSING_LEADING_VT` |
| `allowMissingLeadingVt` + non-VT byte | `_scanForVt` | `MLLP_MISSING_LEADING_VT` |
| `allowLfAfterFs` + LF byte | `_expectCr` | `MLLP_LF_AFTER_FS` |
| `allowFsOnly` + VT byte after FS | `_expectCr` | `MLLP_FS_WITHOUT_CR` |
| `allowFsOnly` + stray byte after FS | `_expectCr` | `MLLP_FS_WITHOUT_CR` |

`MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` deliberately remain warnings (WARN-08 spec).

Created `src/framing/index.ts` with named re-exports:
- `WarningCode`, `MllpWarning` (types), `createWarning`
- `MllpFramingError`
- `encodeFrame`, `EncoderOptions` (type)
- `FrameReader`, `FrameReaderOptions` (type)

Updated `src/index.ts` to re-export all Phase 2 framing public surface via `./framing/index.js`.

### Task 2: FRAME-12 byte-fidelity round-trip tests

`test/framing/byte-fidelity.test.ts` covers:
- All 254 safe byte values (0x00–0xFF excluding 0x0B/0x1C) survive encode→decode unchanged
- 0x0B (VT) in payload throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_VT')` — FRAME-02 guard
- 0x1C (FS) in payload throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_FS')` — FRAME-02 guard
- 254-byte multi-byte payload (all safe bytes concatenated) round-trips unchanged
- 1 MiB deterministic LCG corpus (VT/FS replaced with 0x41) round-trips unchanged
- 8 KiB corpus round-trips correctly in 1-byte chunks

## Test Results

```
test/framing/ — 7 files, 97 tests, all passed

  constants.test.ts    5 tests
  registry.test.ts     6 tests
  error.test.ts        9 tests
  strict-mode.test.ts  8 tests  ← new
  encoder.test.ts     23 tests
  decoder.test.ts     40 tests
  byte-fidelity.test.ts 6 tests ← new
```

`pnpm typecheck` — exit 0  
`pnpm lint` — exit 0  
`pnpm build` — exit 0 (ESM + CJS + DTS, `dist/index.d.ts` = 13.48 KB with framing exports)

## Deviations from Plan

None — plan executed exactly as written. The plan's `<action>` blocks matched the actual decoder.ts interface found in the source.

## Threat Flags

None — no new network endpoints, auth paths, or trust-boundary surface introduced. All changes are pure in-memory codec logic and barrel wiring.

## Self-Check: PASSED

Files created:
- src/framing/index.ts — FOUND
- test/framing/strict-mode.test.ts — FOUND
- test/framing/byte-fidelity.test.ts — FOUND

Files modified:
- src/framing/decoder.ts — FOUND
- src/index.ts — FOUND

Commit f7de874 — FOUND (`git log --oneline -1` confirms)
