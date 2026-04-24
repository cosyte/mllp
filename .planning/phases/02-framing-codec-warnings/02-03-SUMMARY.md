---
phase: 02-framing-codec-warnings
plan: "03"
subsystem: framing/decoder
tags: [fsm, decoder, mllp, framing, streaming, tolerance, dos-prevention]
dependency_graph:
  requires:
    - 02-01 (constants.ts, registry.ts, error.ts)
  provides:
    - src/framing/decoder.ts (FrameReader class, FrameReaderOptions interface)
  affects:
    - 02-04 (framing barrel — will re-export FrameReader, FrameReaderOptions)
    - Phase 3 (Transport/Connection wires reader.push on socket data events)
tech_stack:
  added: []
  patterns:
    - 3-state FSM (SCANNING_FOR_VT / READING_PAYLOAD / EXPECTING_CR) via byte-by-byte loop
    - Dynamic accumulator doubling (4 KiB initial, doubles on full, capped at maxFrameSizeBytes)
    - Buffer.from(subarray()) copy pattern for payload isolation
    - try/catch guard on onWarning callback per WARN-06
key_files:
  created:
    - src/framing/decoder.ts
    - test/framing/decoder.test.ts
  modified: []
decisions:
  - reset() resets byteOffset to 0 (plan specifies this explicitly for connection reuse)
  - VT mid-payload treated as MLLP_TRAILING_BYTES warning + fresh payload start (not a throw)
  - whitespace accumulated silently with allowLeadingWhitespace; warning emitted at VT sight
  - MLLP_EMPTY_PAYLOAD and MLLP_TRAILING_BYTES always warnings, never errors (per WARN-05)
  - Initial accumulator size 4 KiB (plan shows 4096 in reference implementation)
metrics:
  duration: "~10 minutes"
  completed: "2026-04-24"
  tasks_completed: 1
  files_created: 2
---

# Phase 2 Plan 3: FrameReader Streaming FSM Decoder Summary

## One-liner

Byte-by-byte 3-state FSM decoder that handles arbitrary TCP chunk boundaries, 4 tolerance opt-ins, 16 MiB DoS cap, and safe onWarning dispatch.

## Status: COMPLETE

## Files Created

| File | Purpose |
|------|---------|
| `src/framing/decoder.ts` | `FrameReader` class with `push()` / `reset()`, `FrameReaderOptions` interface |
| `test/framing/decoder.test.ts` | 40 tests covering all FSM paths, tolerance variants, chunking, reset, and warning shape |

## Test Results

```
Test Files  1 passed (1)
     Tests  40 passed (40)
  Duration  ~100ms
```

Full framing suite (all 5 test files): 83 tests passed.

## Verification Checklist

- [x] `pnpm exec vitest run test/framing/decoder.test.ts` — 40/40 pass
- [x] `pnpm typecheck` — exits 0 (no type errors)
- [x] `pnpm lint` — exits 0 (no ESLint errors)
- [x] `grep -n '.slice(' src/framing/decoder.ts` — no output (SETUP-07 compliant)
- [x] `grep -n 'console.' src/framing/decoder.ts` — no output
- [x] `grep -c 'subarray' src/framing/decoder.ts` — 3 uses (accumulator copy, snippet extraction, payload delivery)

## Commit

`faccfd9` — `feat(framing): implement MLLP FrameReader streaming FSM decoder (02-03)`

## Implementation Notes

### FSM Design

The decoder uses a strict 3-state FSM processed byte-by-byte. There is no regex, no `indexOf`, no string conversion. Every byte is processed individually so chunk boundaries are transparent:

- `SCANNING_FOR_VT`: skips/warns on pre-VT bytes based on tolerance opts; transitions to `READING_PAYLOAD` on 0x0B
- `READING_PAYLOAD`: accumulates bytes; handles FS (transitions to `EXPECTING_CR`), VT mid-payload (TRAILING_BYTES warning, restart), maxFrameSizeBytes cap (throw)
- `EXPECTING_CR`: expects 0x0D; handles LF (MLLP_LF_AFTER_FS), VT (MLLP_FS_WITHOUT_CR with allowFsOnly), other (MLLP_FS_WITHOUT_CR)

### Accumulator Strategy

Starts at 4 KiB, doubles on full. The maxFrameSizeBytes check fires BEFORE appending (`_writePos >= max`), so the cap is enforced at exactly the byte that would exceed it. At the 16 MiB default, the accumulator may hold up to ~32 MiB temporarily (T-02-03-02 accept).

### Leading Whitespace Tracking

When `allowLeadingWhitespace` is true, whitespace bytes are counted silently. The `MLLP_LEADING_WHITESPACE` warning is emitted the moment VT is seen (reporting the offset of the *first* whitespace byte). This matches FRAME-10 acceptance criteria.

### Payload Isolation

`_deliverFrame()` calls `Buffer.from(this._accumulator.subarray(0, this._writePos))` — the `Buffer.from()` copies the content. Caller mutations or subsequent `push()` calls cannot retroactively corrupt a previously delivered frame (T-02-03-03).

## Deviations from Plan

None — plan executed exactly as written. The plan's reference implementation was followed faithfully with one clarification applied as described in the `<action>` block: the `MLLP_LEADING_WHITESPACE` warning is emitted inside the `byte === VT` branch of `_scanForVt` (not only when a non-whitespace non-VT byte is seen), ensuring the warning fires on the normal whitespace→VT path.

## Threat Flags

None — all threats listed in plan's threat model are mitigated by the implementation:
- T-02-03-01: maxFrameSizeBytes enforced byte-by-byte before append
- T-02-03-03: payload isolated via Buffer.from() copy
- T-02-03-04: onWarning wrapped in try/catch
- T-02-03-05: FS-without-CR throws without allowFsOnly

## Self-Check: PASSED

- `src/framing/decoder.ts` exists: FOUND
- `test/framing/decoder.test.ts` exists: FOUND
- Commit `faccfd9` exists: FOUND (confirmed via git log)
- All 40 tests pass: CONFIRMED
- typecheck clean: CONFIRMED
- lint clean: CONFIRMED
