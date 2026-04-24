---
phase: 02-framing-codec-warnings
verified: 2026-04-24T11:35:00Z
status: gaps_found
score: 4/5 must-haves verified
overrides_applied: 0
gaps:
  - truth: "A developer running pnpm test --coverage sees a fully green suite (FRAME-12 byte-fidelity test does not fail under instrumentation)"
    status: failed
    reason: "The 1 MiB corpus test in byte-fidelity.test.ts has no per-test timeout override. Without coverage instrumentation it passes in ~4.5s. With --coverage (v8 instrumentation) it times out at the default 5000ms threshold. pnpm test runs clean (99/99); pnpm test --coverage fails 1/99."
    artifacts:
      - path: "test/framing/byte-fidelity.test.ts"
        issue: "Line 84: '1 MiB random corpus' test needs { timeout: 30000 } (or similar) as a third argument to it() so it passes under --coverage instrumentation"
    missing:
      - "Add timeout option to the 1 MiB corpus test: it('...', async () => { ... }, 30_000)"
---

# Phase 2: Framing Codec & Warnings — Verification Report

**Phase Goal:** A developer calling `encodeFrame(buf)` or feeding arbitrary TCP chunks into a `FrameReader` receives spec-correct output; every tolerated deviation surfaces as a stable, positional warning, every unrecoverable problem throws a typed `MllpFramingError`, and frame-size overflow is bounded by `maxFrameSizeBytes` to prevent DoS.
**Verified:** 2026-04-24T11:35:00Z
**Status:** gaps_found (1 gap — test timeout under coverage instrumentation)
**Re-verification:** No — initial verification

---

## Goal Achievement

### Observable Truths (from ROADMAP.md Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `encodeFrame(payload)` always produces `VT + payload + FS + CR`; VT/FS in payload throws or warns | VERIFIED | `encoder.ts` strict path + tolerant path; 23 encoder tests pass; `encodeFrame(Buffer.from([0x0b]))` throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_VT')` |
| 2 | `FrameReader` handles any chunk boundaries and yields N payloads in order with identical bytes | VERIFIED | 3-state FSM in `decoder.ts`; 40 decoder tests pass including 1-byte chunk, N-frames-in-one-chunk, back-to-back frames; payload copy isolation confirmed |
| 3 | Tolerance opt-ins emit frozen `MllpWarning` with correct code/byteOffset/message; without opt-in same input throws | VERIFIED | All 4 tolerance paths tested: `allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`, `allowLeadingWhitespace`; `Object.isFrozen` confirmed; throw behavior without opt-in confirmed |
| 4 | `{ strict: true }` escalates tolerance deviations to thrown `MllpFramingError`; `MLLP_EMPTY_PAYLOAD` / `MLLP_TRAILING_BYTES` stay warnings | VERIFIED | `strict-mode.test.ts` — 8 tests covering all 4 escalation paths plus the two carve-outs; `decoder.ts` checks `strict` before emitting warning in every tolerance branch |
| 5 | Frame exceeding `maxFrameSizeBytes` throws `MllpFramingError('MLLP_FRAME_TOO_LARGE')`; `onWarning` callback is guarded; `pnpm test --coverage` is fully green | FAILED | MLLP_FRAME_TOO_LARGE logic verified (throws, never warns — WARN-09). `onWarning` try/catch guard verified. But: the 1 MiB corpus test in `byte-fidelity.test.ts` times out under `--coverage` instrumentation (5 s default). `pnpm test` (without `--coverage`) passes 99/99. |

**Score:** 4/5 truths verified

---

## Required Artifacts

| Artifact | Purpose | Exists | Substantive | Wired | Status |
|----------|---------|--------|-------------|-------|--------|
| `src/framing/constants.ts` | VT=0x0B, FS=0x1C, CR=0x0D, LF=0x0A, DEFAULT_MAX_FRAME_SIZE | Yes | Yes (5 exports) | Imported by encoder, decoder | VERIFIED |
| `src/framing/registry.ts` | `WarningCode` (11 codes), `MllpWarning`, `OnWarning`, `createWarning()` | Yes | Yes (type union + factory) | Imported by encoder, decoder, framing/index | VERIFIED |
| `src/framing/error.ts` | `MllpFramingError` with code, byteOffset, snippet ≤ 64 bytes | Yes | Yes (class with copied snippet) | Imported by encoder, decoder, framing/index | VERIFIED |
| `src/framing/encoder.ts` | `encodeFrame()` + `EncoderOptions` | Yes | Yes (strict + tolerant paths, 136 lines) | Exported from framing/index + src/index | VERIFIED |
| `src/framing/decoder.ts` | `FrameReader` class + `FrameReaderOptions` | Yes | Yes (3-state FSM, 469 lines) | Exported from framing/index + src/index | VERIFIED |
| `src/framing/index.ts` | Framing sub-module barrel | Yes | Yes (6 named re-exports) | Re-exported from src/index.ts | VERIFIED |
| `src/index.ts` | Main package barrel | Yes | Phase 2 surface added | Package entry point | VERIFIED |
| `test/framing/constants.test.ts` | 5 tests | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/registry.test.ts` | 6 tests | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/error.test.ts` | 9 tests | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/encoder.test.ts` | 23 tests | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/decoder.test.ts` | 40 tests | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/strict-mode.test.ts` | 8 tests (WARN-08) | Yes | Yes | Runs in CI | VERIFIED |
| `test/framing/byte-fidelity.test.ts` | 6 tests (FRAME-12) | Yes | Yes — logic correct | Runs in CI | PARTIAL — 1 MiB test times out under --coverage |

---

## Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `src/index.ts` | `src/framing/index.ts` | `export ... from './framing/index.js'` | WIRED | All Phase 2 types and functions re-exported |
| `src/framing/index.ts` | `registry.ts` + `error.ts` + `encoder.ts` + `decoder.ts` | Named re-exports (no wildcard) | WIRED | Tree-shakeable |
| `encoder.ts` | `constants.ts` (VT, FS, CR) | `import { VT, FS, CR }` | WIRED | Line 19 |
| `encoder.ts` | `error.ts` (MllpFramingError) | `import { MllpFramingError }` | WIRED | Line 20 |
| `encoder.ts` | `registry.ts` (createWarning, MllpWarning) | `import { createWarning }` + `import type { MllpWarning }` | WIRED | Lines 21-22 |
| `decoder.ts` | `constants.ts` (VT, FS, CR, LF, DEFAULT_MAX_FRAME_SIZE) | `import { VT, FS, CR, LF, DEFAULT_MAX_FRAME_SIZE }` | WIRED | Line 26 |
| `decoder.ts` | `error.ts` (MllpFramingError) | `import { MllpFramingError }` | WIRED | Line 27 |
| `decoder.ts` | `registry.ts` (createWarning, WarningCode) | `import { createWarning }` + `import type { MllpWarning, WarningCode }` | WIRED | Lines 28-29 |

---

## REQ-ID Coverage Table

| REQ-ID | Requirement | Status | Evidence |
|--------|-------------|--------|----------|
| FRAME-01 | `encodeFrame(payload: Buffer): Buffer` wraps in canonical VT+payload+FS+CR | SATISFIED | `encoder.ts:90-135`; encoder tests verify VT at [0], FS at [len-2], CR at [len-1] |
| FRAME-02 | Throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_VT/FS')` or warns with `allowDelimiterBytesInPayload` | SATISFIED | Both paths tested; warning frozen; WARN-06 handler guard present |
| FRAME-03 | Encoder never emits non-canonical framing — no option to loosen emit path | SATISFIED | Output always `VT+payload+FS+CR`; `allowDelimiterBytesInPayload` only controls throw vs warn, not frame shape |
| FRAME-04 | `FrameReader` handles any chunk sizes and yields complete payloads in order | SATISFIED | 3-state byte-by-byte FSM; tested with 1-byte chunks, N-frame chunks, mid-delimiter splits |
| FRAME-05 | N complete frames in one chunk, 1 frame split N ways, leading/trailing bytes, back-to-back frames | SATISFIED | All 4 patterns in `decoder.test.ts` |
| FRAME-06 | Internal byte offset; every warning/error includes absolute stream position | SATISFIED | `_byteOffset` increments per byte; tested across multiple `push()` calls |
| FRAME-07 | `{ allowFsOnly: true }` tolerates FS without CR; emits `MLLP_FS_WITHOUT_CR` | SATISFIED | `decoder.ts:_expectCr`; tested in decoder and strict-mode tests |
| FRAME-08 | `{ allowLfAfterFs: true }` tolerates FS+LF; emits `MLLP_LF_AFTER_FS` | SATISFIED | `decoder.ts:_expectCr` LF branch; tested in decoder and strict-mode tests |
| FRAME-09 | `{ allowMissingLeadingVt: true }` tolerates missing VT; emits `MLLP_MISSING_LEADING_VT` | SATISFIED | `decoder.ts:_scanForVt` non-VT non-whitespace branch; tested |
| FRAME-10 | `{ allowLeadingWhitespace: true }` tolerates SP/TAB/LF/CR before VT; emits `MLLP_LEADING_WHITESPACE` with skip count | SATISFIED | `decoder.ts:_scanForVt` whitespace accumulator; warning offset is first whitespace byte; tested |
| FRAME-11 | `maxFrameSizeBytes` (default 16 MB) overflow throws `MllpFramingError('MLLP_FRAME_TOO_LARGE')` at cap byte | SATISFIED | Check fires before `_appendByte`; `MLLP_FRAME_TOO_LARGE` never emitted as warning (WARN-09); tested |
| FRAME-12 | All bytes 0x00-0xFF (excluding VT/FS) plus 1 MiB corpus round-trip unchanged | PARTIAL | Logic correct — passes in 31ms standalone. Test times out under `--coverage` due to missing `timeout` annotation. `pnpm test` (no coverage) passes all 6 byte-fidelity tests. |
| WARN-01 | Every tolerated deviation emits frozen `MllpWarning { code, message, byteOffset, connectionId, timestamp }` | SATISFIED | `createWarning()` wraps with `Object.freeze()`; `connectionId: undefined` at framing layer (D-07); `timestamp: new Date()` |
| WARN-02 | Warning codes are stable exported union type with all 11 codes | SATISFIED | `WarningCode` union in `registry.ts` has all 11 codes including `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT` |
| WARN-03 | Consumer subscribing to `onWarning` receives every warning as emitted | SATISFIED (Phase 2 scope) | `onWarning` callback passed to `FrameReader` and `encodeFrame`; Phase 3+ wires server/client-level aggregate. Registry and decoder both invoke it. |
| WARN-04 | Without tolerance enabled, same condition throws `MllpFramingError` with same code | SATISFIED | Verified for all 4 tolerance paths; default is strict-throw |
| WARN-05 | Trailing bytes between CR and next VT emit `MLLP_TRAILING_BYTES`; empty payloads emit `MLLP_EMPTY_PAYLOAD` and yield zero-length Buffer | SATISFIED | Both paths always emit warning, never throw; tested in decoder tests |
| WARN-06 | `{ onWarning: fn }` handler wrapped in try/catch; throwing handler does not corrupt stream | SATISFIED | `_emitWarning()` wraps in try/catch; encoder `onWarning` also try/catch; tested in decoder and encoder tests |
| WARN-07 | Warning `message` is stable human-readable text, never payload bytes/secrets, only positional metadata | SATISFIED | All messages use offset numbers and byte hex codes, not payload contents; reviewed in encoder and decoder |
| WARN-08 | `{ strict: true }` escalates VT/FS/CR/LF tolerance warnings to `MllpFramingError`; `MLLP_EMPTY_PAYLOAD` / `MLLP_TRAILING_BYTES` stay warnings | SATISFIED | Strict check placed before warning emission in every branch; carve-outs for EMPTY_PAYLOAD and TRAILING_BYTES confirmed; 8 strict-mode tests pass |
| WARN-09 | `MLLP_FRAME_TOO_LARGE` is a first-class error, never a warning | SATISFIED | `decoder.ts:_readPayload` throws directly without calling `_emitWarning`; test confirms warning array never contains `MLLP_FRAME_TOO_LARGE` |
| ERR-01 | `MllpFramingError` carries `{ code: WarningCode, byteOffset: number, snippet: Buffer }` where snippet is ≤ 64 bytes copied | SATISFIED | `error.ts`: `Buffer.from(snippet.subarray(0, MAX_SNIPPET_BYTES))` copies and caps at 64; all 3 fields typed and tested |

---

## Data-Flow Trace (Level 4)

Phase 2 produces no UI components or network-bound artifacts — it is pure byte transformation. All data flow is synchronous callbacks during `push()`. No dynamic data sources to trace.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `encodeFrame` produces canonical framing | `node -e "const {encodeFrame}=require('./dist/index.cjs'); const f=encodeFrame(Buffer.from([0x41])); console.log(f[0]===0x0b && f[2]===0x1c && f[3]===0x0d)"` | `true` | PASS |
| `FrameReader` decodes 1 MiB corpus in <100ms | Direct node execution: `Elapsed: 31 ms, Match: true` | 31ms | PASS |
| `MllpFramingError` thrown on VT in payload | Direct node execution confirmed | Throws with `code: 'MLLP_PAYLOAD_CONTAINS_VT'` | PASS |
| `pnpm test` (no coverage) | 99 tests, 8 test files | 99/99 pass | PASS |
| `pnpm typecheck` | `tsc --noEmit` | Exit 0, no errors | PASS |
| `pnpm lint` | `eslint src` | Exit 0, no errors | PASS |
| `pnpm test --coverage` | 99 tests | 98/99 pass — 1 MiB corpus test times out | FAIL |

---

## Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `test/framing/byte-fidelity.test.ts` | 84 | `it('1 MiB random corpus...', () => { ... })` — no timeout override | Warning | Test passes without `--coverage` (4.5s) but times out at 5s default with v8 instrumentation; breaks `pnpm test --coverage` |

No `console.*` calls in any `src/framing/` file. No `.slice()` calls (SETUP-07 compliant — confirmed by grep returning empty). No `return null` or placeholder stubs.

---

## Human Verification Required

None — all behaviors are verifiable programmatically for a pure byte-manipulation layer.

---

## Gaps Summary

**1 gap blocking a fully green `pnpm test --coverage` run.**

The 1 MiB random corpus byte-fidelity test (`test/framing/byte-fidelity.test.ts`, line 84) lacks a per-test timeout override. Without coverage instrumentation the test completes in ~4.5s and passes. With `--coverage` enabled, v8 instrumentation adds enough overhead to push it past the 5 second default Vitest timeout.

The framing logic is correct — confirmed by direct Node.js execution completing in 31ms, and by all other corpus tests passing. The gap is purely in test configuration.

**Fix:** Add `30_000` as the third argument to the `it()` call:
```typescript
it('1 MiB random corpus (excluding VT/FS bytes) round-trips unchanged', () => {
  // ...
}, 30_000);
```

---

### Notable Observations (Non-Blocking)

- `OnWarning` type is exported from `registry.ts` but not re-exported from `src/framing/index.ts` or `src/index.ts`. Downstream phases that need the type alias will import it directly from `registry.ts`. This is a minor convenience gap, not a requirement gap — WARN-02 specifies the `WarningCode` union type, not `OnWarning`.
- VT/FS/CR/LF constants are not exported from the main barrel (`src/index.ts`). The `example` in `constants.ts` JSDoc mentions importing them from `@cosyte/hl7-mllp` but they are not currently wired to the main barrel. Phase 2 requirements do not specify exporting raw constants from the public surface, so this is not a gap.
- Coverage numbers without the failing test: **92.77% statements / 95.6% branches / 100% functions** — all above the 90% threshold.

---

_Verified: 2026-04-24T11:35:00Z_
_Verifier: Claude (gsd-verifier)_
