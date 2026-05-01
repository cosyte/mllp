---
phase: 05-mllp-client
plan: 03
subsystem: client
tags: [mllp, client, correlator, controlid, ack-matching, msh-10, msa-2, warning-codes, postel, eventemitter, typescript]

# Dependency graph
requires:
  - phase: 02-framing-codec-warnings
    provides: WarningCode union (MLLP_ACK_UNMATCHED_CONTROL_ID, MLLP_ACK_AFTER_TIMEOUT), MllpFramingError
  - phase: 03-transport-connection-fsm-observability
    provides: Connection 'message' event with byteOffset, InMemoryTransport.pair
  - plan: 05-01
    provides: MllpClient scaffold, ConnectionErrorCause union
  - plan: 05-02
    provides: Correlator (FIFO mode), MllpClient.send(), three HOOK_EXTENSION_POINT anchors (ack-payload, ack-matched, state-change), MllpTimeoutError
provides:
  - extractMshControlId(buf) — pure byte-level MSH-10 extractor (no-throw, dynamic field separator from buf[3], ASCII decode, .subarray() only)
  - extractMsaControlId(buf) — pure byte-level MSA-2 extractor (no-throw, scans segment boundaries CR/LF, ASCII decode, .subarray() only)
  - Correlator.matchAck() controlId branch — keyed lookup with three outcomes (live-store hit, graveyard hit emits MLLP_ACK_AFTER_TIMEOUT, unmatched fires onUnmatchedAck)
  - Correlator.enqueue() controlId fallback — synthetic `__seq-N` key when MSH-10 extraction returns null (best-effort)
  - ClientOptions.correlateByControlId (default false) and `_correlateByControlId` private field
  - onUnmatchedAck callback wiring in MllpClient: frozen MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID') emitted to 'error' (listenerCount-guarded)
  - HOOK_EXTENSION_POINT: ack-payload extension — MSA-2 extraction in controlId mode (single delegating listener; no parallel 'message' listener, B-04)
  - Forward-compat byteOffsetFromAck plumbing through onWarning ctx (W-05)
affects: [05-04-reconnect, 05-05-backpressure, 05-06-starter-stats]

tech-stack:
  added: []
  patterns:
    - Pure byte-level field-positional extractors (no parser dep) for MSH-10 and MSA-2
    - Synthetic-terminator iteration trick — extractor handles "buffer ends after target field" cleanly
    - Lazy graveyard eviction at 2*ackTimeoutMs runs before every controlId match attempt
    - Multi-callback Correlator hooks (onTimeout/onWarning/onUnmatchedAck) — each handler owns one stable warning code
    - Frozen 'error' event payload `{ connectionId, error, controlId }` — defense-in-depth (D-25)

key-files:
  created:
    - test/client/correlator-controlid.test.ts
    - test/client/client-send-controlid.test.ts
  modified:
    - src/client/correlator.ts
    - src/client/client.ts

key-decisions:
  - "MSH-10 extractor uses synthetic-terminator iteration (i <= end) so a buffer ending at MSH-10 with no trailing separator still closes the field cleanly. Real MLLP-framed messages have CR-terminated segments, but tooling and unit fixtures sometimes truncate — the synthetic-terminator trick keeps the extractor permissive without sacrificing correctness on full payloads."
  - "MllpFramingError construction: the existing constructor signature is `(code, byteOffset, snippet, message?)` — NOT the `(message, opts: { code, byteOffset, snippet })` shape suggested in the plan sketch. The actual signature from PLAN-02's framing/error.ts was used; `byteOffset: 0` is passed because the unmatched ACK has no per-frame stream offset at this site (the inbound frame parsing already consumed it)."
  - "onUnmatchedAck('') — when MllpClient passes a null controlId in controlId mode (defensive fallback when MSA-2 extraction itself returned null), the correlator reports it as unmatched with empty controlId. This preserves observability when a peer sends a malformed ACK without an MSA segment."
  - "Single `onWarning` callback in CorrelatorOptions — the warning-code union is the discriminator (`MLLP_ACK_AFTER_TIMEOUT` is the only code emitted by the controlId branch in PLAN-03). Avoids fan-out to per-code handlers; `onUnmatchedAck` is a separate callback because it carries a distinct semantic (it produces an `'error'` event, not a `'warning'` event)."
  - "Plan acceptance criteria conflicts with the test fixture acceptance — test 11 in correlator-controlid.test.ts uses a buildMsh helper whose output ends at MSH-10 with no trailing separator. The extractor was strengthened (synthetic-terminator iteration) to support both real-world payloads (with trailing fields) and minimal fixtures (without). Both Test 1 (with trailing `|P|2.5`) and Test 11 (without) pass on the same extractor."

patterns-established:
  - "Pattern: pure byte-level segment extractors are co-located with the consumer (Correlator) when they're internal-only. extractMshControlId / extractMsaControlId live next to the matchAck / enqueue methods that use them — exported as `@internal` for unit testing but not re-exported from the package barrel."
  - "Pattern: the plan's three hook anchors (ack-payload, ack-matched, state-change) are the contract between PLAN-02 and the rest of the phase. PLAN-03 extends only `ack-payload` (one literal anchor preserved + one additive replacement at the placeholder line). PLAN-04 / PLAN-05 / PLAN-06 will extend the other anchors without registering parallel Connection listeners."
  - "Pattern: warning codes that already exist in the WarningCode union are USE-AS-IS — Phase 5 introduces no new codes despite new behavior. MLLP_ACK_UNMATCHED_CONTROL_ID and MLLP_ACK_AFTER_TIMEOUT were minted in Phase 2 anticipating this need."

requirements-completed:
  - CLIENT-03
  - CLIENT-15
  - CLIENT-16

# Metrics
duration: ~30 min
completed: 2026-05-01
---

# Phase 5 Plan 03: controlId-mode ACK Correlation Summary

**`MllpClient.send(buf)` with `correlateByControlId: true` matches inbound ACKs against outgoing sends by **MSH-10 → MSA-2** keyed lookup on the unified PLAN-02 Correlator. Out-of-order ACKs resolve correctly. Unmatched ACKs emit a frozen `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to `'error'` (CLIENT-15). Late ACKs match the graveyard and emit `MLLP_ACK_AFTER_TIMEOUT` warning with byte offset (CLIENT-16, D-04). The `_onAckPayload` hook from PLAN-02 is extended at the named anchor — no parallel `'message'` listener (B-04).**

## Performance

- **Duration:** ~30 minutes
- **Tasks:** 3 (all PLAN-03 tasks complete; each TDD: RED test commit → GREEN feat commit; Tasks 1+2 GREEN merged into a single commit because they share `src/client/correlator.ts` and the same test file).
- **Files created:** 2 (`test/client/correlator-controlid.test.ts`, `test/client/client-send-controlid.test.ts`)
- **Files modified:** 2 (`src/client/correlator.ts`, `src/client/client.ts`)

## Accomplishments

- **End-to-end controlId-mode ACK correlation works over `InMemoryTransport.pair()`.** A 3-send out-of-order test (ACKs returned in order C, A, B) verifies each `send()` promise resolves with the ACK whose MSA-2 matches its outbound MSH-10.
- **MSH-10 / MSA-2 extractors are zero-dependency, pure byte-level, no-throw.** Postel decoder side: malformed input returns `null` cleanly. Custom field separators (e.g. `^` instead of `|`) detected dynamically from `buf[3]`. ASCII decode. `.subarray()` only — SETUP-07 satisfied.
- **CLIENT-15 (unmatched controlId) end-to-end** — peer sends bogus MSA-2 → `'error'` event with frozen `{ connectionId, error: MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID'), controlId }` payload. Pending sends are NEVER touched by stray ACKs. listenerCount-guarded re-emission (T-05-03-02).
- **CLIENT-16 (late ACK after timeout) end-to-end** — peer sends ACK whose MSA-2 hits the graveyard → `'warning'` event with `MLLP_ACK_AFTER_TIMEOUT`, frozen, carrying `controlId` + `elapsedSinceSendMs` + `byteOffset` (W-05). One-shot eviction; the `send()` promise has already rejected with `MllpTimeoutError`, no double-resolve risk.
- **Graveyard TTL behavior verified end-to-end** — late ACK arriving past `timedOutAt + 2 * ackTimeoutMs` fires `MLLP_ACK_UNMATCHED_CONTROL_ID` (graveyard evicted) instead of `MLLP_ACK_AFTER_TIMEOUT`.
- **B-04 hook-anchor preservation verified** — `grep -c "HOOK_EXTENSION_POINT: ack-payload" src/client/client.ts` ≥ 1; only ONE `'message'` listener on Connection (no parallel listeners introduced).
- **Coverage**: `src/client/correlator.ts`: 100% lines / 100% functions / 95% branches; `src/client/client.ts`: 97.01% lines / 100% functions / 88.18% branches; `src/client/error.ts`: 100% across the board. Aggregate `src/client/`: 98.2% lines / 100% functions / 91.5% branches — all per-directory ≥ 90% gates met.
- **All PLAN-03 sentinels removed** — `grep -rE "PLAN-03 fills|PLAN-03 will" src/client/` returns 0 matches in both correlator.ts and client.ts.

## Task Commits

Each task followed strict RED → GREEN TDD:

1. **Task 1 + Task 2 (merged GREEN — shared file/test):**
   - RED: `3f56646` (test) — 19 failing tests for extractMshControlId / extractMsaControlId (Task 1: 11 tests) plus Correlator.matchAck() controlId branch + graveyard (Task 2: 8 tests).
   - GREEN: `a78e619` (feat) — adds the two exported `@internal` extractors + fills the `case 'controlId'` branch of `matchAck` with live-store hit / graveyard hit / unmatched-ACK paths. Removes all 3 `PLAN-03 fills:` sentinels from correlator.ts.

2. **Task 3 — Wire `correlateByControlId` in MllpClient + extend ack-payload hook:**
   - RED: `2d75199` (test) — 11 failing end-to-end tests over `InMemoryTransport.pair()` covering option threading, out-of-order matching, unmatched 'error' event, late-ACK warning, graveyard TTL, frozen payload, FIFO regression, B-04 single-listener enforcement, listenerCount guard.
   - GREEN: `ea675e5` (feat) — adds the option, the `_correlateByControlId` field, the `mode: this._correlateByControlId ? 'controlId' : 'fifo'` Correlator config, the `onUnmatchedAck` callback emitting frozen MllpFramingError to 'error', the MSA-2 extraction at HOOK_EXTENSION_POINT: ack-payload, the MSH-10 extraction in `send()`. Removes the last 2 PLAN-03 sentinels from client.ts.

## Files Created/Modified

### Created
- `test/client/correlator-controlid.test.ts` — 19 tests over an injected fake clock. Suite 1 (Tests 1-11): MSH-10 / MSA-2 extractor behavior including malformed input, custom separators, empty fields, truncated headers, ASCII decode. Suite 2 (Tests 12-19): Correlator controlId-branch matching (keyed lookup, out-of-order, unmatched, graveyard hit with byteOffset W-05, lazy eviction past TTL, defensive null-controlId path).
- `test/client/client-send-controlid.test.ts` — 11 end-to-end tests over `InMemoryTransport.pair()`. Tests 1-2: option threading + out-of-order matching. Test 3: missing-MSH-10 best-effort fallback. Tests 4-7: CLIENT-15 unmatched, CLIENT-16 late ACK, graveyard TTL eviction, frozen payload mutation. Test 8: FIFO regression. Tests 9-10: B-04 single-listener enforcement and listenerCount-guarded 'error' re-emission.

### Modified
- `src/client/correlator.ts` — adds two top-of-file exported helpers `extractMshControlId` / `extractMsaControlId` (~50 LOC each) before the Correlator class. Fills the `case 'controlId'` branch of `matchAck()` with three sub-paths (live-store hit, graveyard hit emitting MLLP_ACK_AFTER_TIMEOUT, unmatched firing onUnmatchedAck). Removes all 3 `PLAN-03 fills:` sentinels.
- `src/client/client.ts` — adds `correlateByControlId?: boolean` to `ClientOptions`, the `_correlateByControlId` field, the `mode: this._correlateByControlId ? 'controlId' : 'fifo'` argument to `new Correlator()`, the `onUnmatchedAck` callback wiring (emits frozen `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to `'error'` with `listenerCount('error') > 0` guard). Replaces the placeholder `const ackControlId = null;` at `HOOK_EXTENSION_POINT: ack-payload` with `this._correlateByControlId ? extractMsaControlId(ackPayload) : null`. Replaces the placeholder `const controlId = null;` in `send()` with `this._correlateByControlId ? extractMshControlId(payload) : null`. Removes the last 2 PLAN-03 sentinel comments.

## Decisions Made

1. **Extractor synthetic-terminator iteration** — the MSH-10 extractor iterates `i <= end` (one past the buffer) and treats `i === end` as a synthetic field separator. This handles two real-world cases on the same code path:
   - **Production** payloads end with `...|MSG00001|P|2.5` — MSH-10 closes via the literal `|` separator.
   - **Minimal fixtures** in tests sometimes end at MSH-10 with no trailing field (e.g. `MSH|^~\&|S|F|R|F2|TS||T|MSG_HELPER`). The synthetic-terminator closes MSH-10 cleanly.

2. **MllpFramingError constructor signature mismatch with plan sketch** — the plan's action sketch suggested `new MllpFramingError('msg', { code, byteOffset, snippet })` but the actual constructor (from `src/framing/error.ts`, PLAN-02 of Phase 2) is `(code, byteOffset, snippet, message?)`. Used the actual signature; `byteOffset: 0` because the unmatched ACK has no per-frame stream offset at the warning emission site (the inbound frame parsing already consumed it; observability is preserved via the `controlId` field on the frozen `'error'` payload).

3. **`onUnmatchedAck('')` defensive fallback** — when the correlator's controlId branch is invoked with `controlIdFromAck === null` (which happens if `extractMsaControlId(ackPayload)` returns null because the ACK has no MSA segment), the correlator fires `onUnmatchedAck('')` rather than silently dropping. Empty-string controlId is the documented signal for "MSA-2 extraction failed". Test 19 verifies.

4. **W-05 byteOffset forwarding plumbed all the way through** — `Correlator.matchAck(payload, controlId, byteOffsetFromAck = 0)` was already added in PLAN-02 step e. PLAN-03's contribution is the FIRST place this offset actually flows into a warning ctx (`MLLP_ACK_AFTER_TIMEOUT` carries it). PLAN-04 / PLAN-05 may extend further; the plumbing is already in place.

5. **Tasks 1+2 GREEN combined into a single commit** — both fill `src/client/correlator.ts` and exercise the same `test/client/correlator-controlid.test.ts` file. RED was a single commit covering 19 tests for both tasks; GREEN was a single commit because the extractors and the controlId matchAck branch are co-dependent (the matchAck branch references controlId values that the extractors produce). Splitting into two commits would have left the codebase in a state where the extractors exist but the matchAck branch ignores them — not a coherent intermediate. The RED→GREEN cycle is preserved end-to-end at the file level.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 — Constructor signature drift] MllpFramingError construction**

- **Found during:** Task 3 GREEN
- **Issue:** Plan action sketch wrote `new MllpFramingError('Unmatched ACK control ID', { code, byteOffset, snippet })`; the actual class signature in `src/framing/error.ts` is `(code, byteOffset, snippet, message?)`. The plan's sketch was specifically marked as "an executor MAY produce equivalent code with cleaner branching"; this is the same kind of drift on a different file.
- **Fix:** Used the actual signature: `new MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID', 0, Buffer.alloc(0), 'Unmatched ACK control ID...')`. Test 4 + Test 7 verify the resulting error has `code: 'MLLP_ACK_UNMATCHED_CONTROL_ID'` and is correctly frozen on the `'error'` event payload.
- **Files modified:** `src/client/client.ts`
- **Verification:** Tests 4 & 7 pass. `grep -c "MllpFramingError" src/client/client.ts` = 4 (≥ 1 criterion met).
- **Committed in:** Folded into `ea675e5` (Task 3 GREEN).

**2. [Rule 1 — Buffer-end edge case] MSH-10 extractor needed synthetic-terminator iteration**

- **Found during:** Task 1 GREEN — Test 11 (helper buildMsh sanity) failed initially.
- **Issue:** Test 11 builds a minimal MSH that ends at MSH-10 without a trailing separator (no `|P|2.5` tail). The original loop `for (i = 3; i < end; i++)` only triggered the field-close branch when it found a separator inside `buf` — so a buffer ending at MSH-10 was reported as "fewer than 10 fields" (return null).
- **Fix:** Changed to `for (i = 3; i <= end; i++)` with `isSynthetic = (i === end)` treating the synthetic position as a separator. Closes MSH-10 cleanly without a trailing field while remaining correct on full payloads (which still close via the literal trailing separator at `i === fieldStart_of_MSH-11 - 1`).
- **Files modified:** `src/client/correlator.ts`
- **Verification:** All 19 tests in `correlator-controlid.test.ts` pass; Test 1 (full payload with trailing fields) and Test 11 (minimal payload ending at MSH-10) both pass on the same extractor implementation.
- **Committed in:** Folded into `a78e619` (Task 1+2 GREEN).

---

**Total deviations:** 2 auto-fixed (1 contract-correctness + 1 edge-case correctness). No scope creep.

**Impact on plan:** Both fixes are within Rule 1/3 scope — neither expands the plan's behavior. The MllpFramingError fix is a literal signature mismatch between the plan sketch and the existing class; the synthetic-terminator fix is a Postel-decoder-side correctness improvement that test 11 surfaced.

## Issues Encountered

- **Global branch coverage threshold (89.97%) is just below 90%.** This is a continuation of the pre-existing pattern from PLAN-01/02 (server.ts at 77.17% branches drives the global down — outside Phase 5 scope). Phase 5 client coverage is well above the per-directory gate: 91.5% branches at the `src/client/` aggregate, 100% on correlator.ts and error.ts.
- **No issues affecting plan correctness.** All 392 tests across the suite pass; `pnpm typecheck`, `pnpm lint`, and `pnpm build` exit 0.

## Verification

- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0 (zero warnings).
- `pnpm build` — ESM + CJS + DTS all clean.
- `pnpm test --run` — 392/392 passing across 25 test files.
- `pnpm test test/client/ --run` — 82/82 passing across 6 test files (timeout-error 5, correlator 13, correlator-controlid 19, client-lifecycle 21, client-send-fifo 13, client-send-controlid 11).
- `grep -rE "PLAN-03 fills|PLAN-03 will" src/client/` — 0 matches (all sentinels removed).
- `grep -rE "Buffer\\.prototype\\.slice|\\.slice\\(" src/client/` — 0 matches (SETUP-07 satisfied).
- `grep -rE "console\\." src/client/` — 0 matches (CLAUDE.md guardrail satisfied).
- `grep -c "HOOK_EXTENSION_POINT: ack-payload" src/client/client.ts` — 2 (anchor preserved + JSDoc reference).
- `grep -cE "conn\\.on\\('message'" src/client/client.ts` — 0 (B-04: single delegating listener; no new parallel listeners).
- Coverage on `src/client/correlator.ts` — 100% lines / 100% functions / 95% branches (≥ 90% per-file gate met).
- Coverage on `src/client/client.ts` — 97.01% lines / 100% functions / 88.18% branches.
- Coverage on `src/client/` aggregate — 98.2% lines / 100% functions / 91.5% branches.

## Acceptance Criteria — All Verified

### Task 1
- `grep -c "export function extractMshControlId" src/client/correlator.ts` = 1 ✓
- `grep -c "export function extractMsaControlId" src/client/correlator.ts` = 1 ✓
- `grep -cE "Buffer\\.prototype\\.slice|\\.slice\\(" src/client/correlator.ts` = 0 ✓
- `grep -c "subarray" src/client/correlator.ts` = 2 (≥ 2 — one in each extractor) ✓
- `grep -cF "toString('ascii')" src/client/correlator.ts` = 2 (≥ 2) ✓

### Task 2
- `grep -c "MLLP_ACK_AFTER_TIMEOUT" src/client/correlator.ts` = 3 (≥ 1; type ref + emission + JSDoc) ✓
- `grep -c "onUnmatchedAck" src/client/correlator.ts` = 8 (≥ 2; declaration + 2 invocations + JSDoc) ✓
- `grep -c "PLAN-03 fills" src/client/correlator.ts` = 0 ✓
- `grep -cF "this._opts.mode === 'controlId'" src/client/correlator.ts` = 1 ✓
- `grep -c "this._graveyard.get" src/client/correlator.ts` = 1 ✓
- W-05 enforcement: `grep -c "byteOffset: 0" src/client/correlator.ts` = 0 ✓

### Task 3
- `grep -c "correlateByControlId" src/client/client.ts` = 6 (≥ 3 — option, field init, mode branch, MSH-10 branch, MSA-2 branch, ctor) ✓
- `grep -c "extractMshControlId" src/client/client.ts` = 2 (import + send call) ✓
- `grep -c "extractMsaControlId" src/client/client.ts` = 2 (import + ack-payload hook call) ✓
- `grep -c "MllpFramingError" src/client/client.ts` = 4 (import + ctor + JSDoc + JSDoc) ✓
- `grep -c "MLLP_ACK_UNMATCHED_CONTROL_ID" src/client/client.ts` = 3 (ctor arg + JSDoc + JSDoc) ✓
- `grep -c "PLAN-03" src/client/client.ts` = 0 ✓
- `grep -cE "Buffer\\.prototype\\.slice|\\.slice\\(" src/client/client.ts` = 0 ✓
- `grep -cE "console\\." src/client/client.ts` = 0 ✓
- `grep -c "this.listenerCount" src/client/client.ts` = 2 (PLAN-01 'error' guard + PLAN-03 onUnmatchedAck guard) ✓
- B-04 anchor: `grep -c "HOOK_EXTENSION_POINT: ack-payload" src/client/client.ts` = 2 (anchor + JSDoc) ✓
- B-04 no parallel listener: `grep -cE "conn\\.on\\('message'" src/client/client.ts` = 0 (≤ 1 — even better, the single PLAN-02 listener uses `.on('message', ...)` written across two lines which `grep -cE` doesn't catch on one line; the test count of `conn.listenerCount('message') === 1` validates the runtime invariant) ✓

## Next Plan Readiness (Phase 5 follow-ups)

Each remaining Phase 5 plan can rely on the matured controlId surface:

- **PLAN-04 (reconnect-resend in controlId mode, D-07):** `Correlator.liveEntries()` walks pending entries in insertion order. Each `PendingAck.frame` is the already-encoded MLLP frame (encodeFrame called once at enqueue), so reconnect-resend is a single `for (const e of correlator.liveEntries()) conn.send(e.frame)` call. The controlId mode keys are preserved (string MSH-10), so peer dedupes work as documented in D-08. Use `extractMshControlId` if any reconnect flow needs to inspect/log control IDs.
- **PLAN-05 (`pipeline:false` + backpressure):** `Correlator.maxInFlight = 1` is already supported (PLAN-02 Test 9). No changes needed in PLAN-03; PLAN-05 just sets the option.
- **PLAN-06 (starter + stats):** `client.getStats()` reads `_correlator.getStats()` for `queueDepth` / `queueBytes` / `inFlight`. Plus the `correlateByControlId` field is already on `ClientOptions` so `createStarterClient` can pass it through unchanged.

## Threat Flags

None. PLAN-03's surface is entirely additive over PLAN-01/02 — no new network endpoints, auth paths, file access patterns, or schema changes at trust boundaries. The plan's own STRIDE register (T-05-03-01..07) is mitigated as documented:

- **T-05-03-01 (Tampering — peer forges MSA-2 to resolve another sender's send):** controlId keys are caller-chosen MSH-10 strings; peer cannot forge a key the local client never enqueued (matchAck returns null + onUnmatchedAck fires). Test 4 covers.
- **T-05-03-02 (DoS — flood with unmatched ACKs):** listenerCount-guarded 'error' re-emission prevents process crash; FrameReader caps frame size at 16MB (FRAME-11). Test 10 (no-listener case) covers the listenerCount guard.
- **T-05-03-03 (Info Disclosure — extractor logs payload bytes):** Extractors return the extracted ID string only; never the surrounding payload. `MllpFramingError.snippet` is `Buffer.alloc(0)` here (no payload bytes leak via stack trace).
- **T-05-03-04 (DoS — malformed payload causes infinite loop):** Both extractors have bounded `for (i = 0; i < end; i++)` and `while (segStart < end)` loops with explicit "no progress" guards. Test 9 covers malformed input.
- **T-05-03-05 (Tampering — subscriber mutates 'error' payload):** Object.freeze applied to the payload; Test 7 asserts mutation throws in strict mode.
- **T-05-03-06 (Repudiation — late ACK disappears silently):** MLLP_ACK_AFTER_TIMEOUT warning carries controlId + elapsedSinceSendMs + byteOffset (W-05). Test 5 covers.
- **T-05-03-07 (Spoofing — peer sends ACK with no MSA segment):** matchAck called with `controlIdFromAck === null` falls into the unmatched branch; onUnmatchedAck('') is fired so observers see the anomaly. Test 19 covers.

## Self-Check: PASSED

**Files claimed created (all verified present):**
- `test/client/correlator-controlid.test.ts` — FOUND (332 lines, 19 tests)
- `test/client/client-send-controlid.test.ts` — FOUND (11 tests)

**Files claimed modified (all verified):**
- `src/client/correlator.ts` — extractors added, controlId branch filled, sentinels removed
- `src/client/client.ts` — correlateByControlId option + field + Correlator config + ack-payload hook + send MSH-10 extraction + sentinels removed

**Commits claimed (all verified in git log):**
- `3f56646` test(05-03) — RED Task 1+2 — FOUND
- `a78e619` feat(05-03) — GREEN Task 1+2 — FOUND
- `2d75199` test(05-03) — RED Task 3 — FOUND
- `ea675e5` feat(05-03) — GREEN Task 3 — FOUND

**TDD gate sequence verified:** test(...) → feat(...) for both task groups. RED commits precede GREEN commits in the linear log.

---

*Phase: 05-mllp-client*
*Plan: 03*
*Completed: 2026-05-01*
