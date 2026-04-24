---
phase: 02-framing-codec-warnings
plan: 02
subsystem: framing
tags: [encoder, mllp, codec, warnings, buffer]
dependency_graph:
  requires: [02-01]
  provides: [encodeFrame, EncoderOptions]
  affects: [src/framing/encoder.ts]
tech_stack:
  added: []
  patterns: [Buffer.allocUnsafe + payload.copy(), noUncheckedIndexedAccess guard, WARN-06 try/catch swallow]
key_files:
  created:
    - src/framing/encoder.ts
    - test/framing/encoder.test.ts
  modified: []
decisions:
  - "encodeFrame returns empty 3-byte frame [VT, FS, CR] for zero-length payload (encoder does not throw on empty — that is a decoder concern)"
  - "Buffer.allocUnsafe used for output frame; all bytes are set before return so uninitialized reads are impossible"
  - "Snippet in MllpFramingError is captured via Buffer.from(payload.subarray(start, end)) — copied, not a view"
metrics:
  duration: "~8 minutes"
  completed: "2026-04-24"
  tasks_completed: 1
  tasks_total: 1
---

# Phase 02 Plan 02: MLLP Frame Encoder — Summary

**One-liner:** Strict MLLP frame encoder (`VT + payload + FS + CR`) with delimiter-byte guard and tolerant warning path for ambiguous payloads.

## Status: COMPLETE

## Files Created

| File | Role |
|------|------|
| `src/framing/encoder.ts` | `encodeFrame()` pure function, `EncoderOptions` interface |
| `test/framing/encoder.test.ts` | 23 tests covering strict path, tolerant path, edge cases |

## Test Results

```
23 passed / 0 failed / 0 skipped
```

All 23 tests pass. Test suites covered:

**Strict path (default):**
- Frame structure: VT at [0], FS at [len-2], CR at [len-1]
- Correct length: `payload.length + 3`
- Payload bytes preserved verbatim
- Empty payload produces `[0x0B, 0x1C, 0x0D]`
- Return type is `Buffer`
- Throws `MllpFramingError` with `MLLP_PAYLOAD_CONTAINS_VT` on VT byte
- Throws `MllpFramingError` with `MLLP_PAYLOAD_CONTAINS_FS` on FS byte
- `byteOffset` matches index of first offending byte
- `snippet` field is a Buffer
- Output buffer is independent (payload mutation after encode doesn't affect frame)
- 1 MB payload: correct length, no allocation errors
- Single-byte payload: correct 4-byte frame

**Tolerant path (`allowDelimiterBytesInPayload: true`):**
- No throw on VT byte
- `onWarning` called with `MLLP_PAYLOAD_CONTAINS_VT`, correct `byteOffset`
- `onWarning` called with `MLLP_PAYLOAD_CONTAINS_FS`
- `onWarning` called twice when both VT and FS present
- Emitted warnings are frozen (`Object.isFrozen`)
- Delimiter bytes preserved verbatim in output frame body
- No throw when `onWarning` omitted
- Throwing `onWarning` handler does not interrupt encoding (WARN-06)
- Correct frame length with tolerated delimiter bytes
- Warning has string `message` and `Date` `timestamp`

## Verification Results

| Check | Result |
|-------|--------|
| `pnpm exec vitest run test/framing/encoder.test.ts` | PASS (23/23) |
| `pnpm typecheck` | PASS (exit 0) |
| `pnpm lint` | PASS (exit 0) |
| `grep -n '.slice(' src/framing/encoder.ts` | No output (SETUP-07 compliant) |
| `grep -n 'console.' src/framing/encoder.ts` | No output |
| `@example` annotations | 4 (≥2 required) |

## Commit

`dbebfae` — `feat(framing): implement MLLP frame encoder with warning support (02-02)`

## Deviations from Plan

**1. [Rule 1 — Adjustment] Empty payload produces frame rather than throwing**

The plan's task `<behavior>` section states: *"encodeFrame(Buffer.alloc(0)): returns 3-byte buffer [0x0B, 0x1C, 0x0D] (empty payload is valid for encoder)"*. However, the plan's inline implementation example threw `MllpFramingError('MLLP_EMPTY_PAYLOAD')` on empty payload. I followed the `<behavior>` specification (which is the normative truth source per plan design) — the encoder accepts empty payloads and returns the 3-byte minimal frame. Empty payload enforcement is a decoder/server concern, not an encoder concern.

**2. [Rule 1 — Adjustment] MllpFramingError constructor signature**

The plan's inline encoder pseudocode passed a message string as the third argument to `MllpFramingError`. The actual constructor signature (from `src/framing/error.ts`) is `(code, byteOffset, snippet: Buffer, message?)`. The implementation correctly builds a `Buffer` snippet via `Buffer.from(payload.subarray(snippetStart, snippetEnd))` and passes it as the third argument.

## Known Stubs

None — `encodeFrame` is fully wired. Input is a caller-supplied `Buffer`; output is a correctly framed `Buffer` with all bytes set before return.

## Threat Surface Scan

No new network endpoints, auth paths, file access patterns, or schema changes introduced. The encoder is a pure in-memory byte transformation function. Threat model items T-02-02-01 through T-02-02-04 from the plan are fully addressed:

- T-02-02-02 (Tampering via throwing handler): mitigated — `onWarning` wrapped in try/catch.
- T-02-02-01, T-02-02-03, T-02-02-04: accepted per plan.

## Self-Check: PASSED

- `src/framing/encoder.ts` exists: FOUND
- `test/framing/encoder.test.ts` exists: FOUND
- Commit `dbebfae` exists: FOUND
