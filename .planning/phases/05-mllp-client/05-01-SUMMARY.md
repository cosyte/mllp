---
phase: 05-mllp-client
plan: 01
subsystem: client
tags: [mllp, client, lifecycle, fsm, eventemitter, abortsignal, typescript]

# Dependency graph
requires:
  - phase: 03-transport-connection-fsm-observability
    provides: Connection (6-state FSM), NetTransport, MllpConnectionError, ConnectionErrorPhase, InMemoryTransport
  - phase: 04-mllp-server
    provides: EventEmitter monolith pattern, frozen-payload pattern, AbortSignal pattern, Symbol.asyncDispose pattern, listenerCount('error') guard
provides:
  - MllpClient class composing one Connection (D-02, D-20)
  - createClient() factory + ClientOptions interface
  - connect()/close()/destroy() lifecycle with AbortSignal on connect+close
  - Symbol.asyncDispose delegating to close() (await using support)
  - Frozen re-emission of Connection events (stateChange, connect, disconnect, reconnecting, close, message, warning, error)
  - ConnectionErrorCause stable public union ('fifo-unsafe' | 'in-flight-orphan')
  - MllpConnectionError.connectionCause optional field (D-09)
  - src/client/error.ts stub with PLAN-02/PLAN-04/PLAN-05 sentinel markers
  - Top-level Phase 5 client export block in src/index.ts
  - _attachExistingConnection internal seam for InMemoryTransport-driven tests
affects: [05-02-correlator-send, 05-03-controlid, 05-04-reconnect, 05-05-backpressure, 05-06-starter-stats, 06-tls, 07-testing-docs]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - EventEmitter monolith for public Client API (D-01 mirrors Phase 4 D-01)
    - Compose-not-inherit Connection (D-02, D-20)
    - Phase 6 TLS seam comment at transport branch point
    - Frozen event payloads with shallow spread (defense-in-depth on already-frozen Connection events)
    - Stable cause-code union pattern for MllpConnectionError extras (D-09)

key-files:
  created:
    - src/client/client.ts
    - src/client/index.ts
    - src/client/error.ts
    - test/client/client-lifecycle.test.ts
  modified:
    - src/connection/error.ts
    - src/connection/index.ts
    - src/index.ts
    - test/connection/error.test.ts

key-decisions:
  - "MllpClient.connect() rejects when already connected with MllpConnectionError(phase: 'connect') — explicit contract over silent no-op"
  - "_attachExistingConnection chosen over a public _testTransport option to keep ClientOptions clean of test-only knobs"
  - "Frozen event re-emission uses Object.freeze({ ...e }) — defense-in-depth even though Connection already freezes, harmless"
  - "Pre-aborted AbortSignal on connect() short-circuits before createConnection — no socket leak on the abort path"
  - "Mid-attempt abort destroys the in-flight Connection via conn.destroy(new Error('aborted')) before rejecting"
  - "ConnectionErrorCause adopted as a new sibling type alongside ConnectionErrorPhase rather than coercing the existing 'cause' Error field — preserves backward compatibility for existing FIFO-unsafe call sites"

patterns-established:
  - "Pattern: connect() -> createConnection -> NetTransport -> new Connection -> _attachConnection — exact mirror of server's _onSocketAccepted reverse-direction"
  - "Pattern: client.close() with AbortSignal uses Promise.race against a sentinel abort promise that destroys the Connection on abort — server precedent"
  - "Pattern: error event re-emission guarded by this.listenerCount('error') > 0 — prevents ERR_UNHANDLED_ERROR (T-05-01-03)"
  - "Pattern: optional ConnectionOptions fields built conditionally (drainTimeoutMs, framing) — preserves Connection's existing default semantics rather than passing undefined"

requirements-completed:
  - CLIENT-01
  - CLIENT-02
  - CLIENT-09
  - CLIENT-13
  - LIFE-01
  - LIFE-02
  - LIFE-03
  - LIFE-04
  - LIFE-05

# Metrics
duration: ~30 min
completed: 2026-05-01
---

# Phase 5 Plan 01: MLLP Client Scaffold Summary

**MllpClient lifecycle scaffold composed over Phase 3 Connection — `connect()`, `close()`, `destroy()`, `Symbol.asyncDispose`, AbortSignal on every awaitable, frozen event re-emission, and the new `ConnectionErrorCause` stable union ready for PLAN-04's FIFO reconnect rejections.**

## Performance

- **Duration:** ~30 minutes
- **Started:** 2026-05-01T12:00:00Z (approx)
- **Completed:** 2026-05-01T12:32:00Z
- **Tasks:** 3 (all PLAN-01 tasks complete)
- **Files created:** 4 (`src/client/{client,error,index}.ts`, `test/client/client-lifecycle.test.ts`)
- **Files modified:** 4 (`src/connection/{error,index}.ts`, `src/index.ts`, `test/connection/error.test.ts`)

## Accomplishments

- **Foundational scaffold for the entire Phase 5 client.** Every later plan in Phase 5 (PLAN-02 correlator + send, PLAN-03 controlId, PLAN-04 reconnect, PLAN-05 backpressure, PLAN-06 starter+stats) extends the class produced here.
- **`ConnectionErrorCause` public union plumbed end-to-end** — sequenced first so PLAN-04 can reject in-flight FIFO sends with `connectionCause: 'in-flight-orphan'` (D-09, healthcare at-most-once semantics).
- **AbortSignal contract honored on connect() and close()** — DOMException AbortError on pre-aborted signals AND mid-attempt cancellation, with no socket / Connection leaks on the abort paths.
- **All Connection lifecycle events re-emitted with frozen payloads** — subscribers cannot mutate shared state (T-05-01-01 mitigation).
- **`await using` ergonomics ready** for the three-line north star — Symbol.asyncDispose delegates to close().
- **Coverage**: src/client/client.ts at 99.42% lines / 100% functions / 90.62% branches (CLAUDE.md ≥90% src/client/ gate satisfied).

## Task Commits

Each task was committed atomically (multi-step TDD where applicable):

1. **Task 1: Extend ConnectionErrorCause stable union (D-09)** — `8a3aa68` (feat)
   - Single feat commit; tests written first against the new types, then types implemented (RED → GREEN cycle within the same author session). The plan's `tdd="true"` flag was honored by writing the 4 new test cases before the source change, but they were committed together to keep the cause-code addition atomic with its test surface.
2. **Task 2: Scaffold src/client/error.ts stub** — `9fdd2b6` (feat)
   - Empty-but-valid ESM module with PLAN-02/04/05 sentinel comments.
3. **Task 3: Build MllpClient class skeleton with connect/close/destroy lifecycle** — `8cd8fe0` (feat) + `998284a` (test)
   - Initial 11-test scaffold passed (`8cd8fe0`).
   - Coverage strengthening additions (`998284a`) brought client.ts to 99.42% lines / 90.62% branches to satisfy CLAUDE.md's per-directory ≥90% gate.

**Plan metadata:** SUMMARY.md committed in the final task on this branch.

## Files Created/Modified

### Created
- `src/client/client.ts` — `MllpClient` class + `createClient` factory; `ClientOptions` interface; the `_attachExistingConnection` internal test seam.
- `src/client/index.ts` — Public client barrel re-exporting `MllpClient`, `createClient`, `ClientOptions`. Sentinel comments mark where PLAN-02/04/05/06 will append.
- `src/client/error.ts` — Empty-but-valid ESM module with file-level JSDoc and PLAN-02/04/05 sentinel markers. Compiles cleanly today; PLAN-02 fills `MllpTimeoutError`, PLAN-04 fills `isTransientConnectionError`, PLAN-05 fills `MllpBackpressureError`.
- `test/client/client-lifecycle.test.ts` — 21 tests covering all 10 PLAN-01 behaviors plus 11 coverage-strengthening tests for production net.Socket path, abort branches, and double-attach guard.

### Modified
- `src/connection/error.ts` — Added `ConnectionErrorCause` exported union (`'fifo-unsafe' | 'in-flight-orphan'`) with public-API JSDoc stability warning. Extended `MllpConnectionError` constructor with optional `connectionCause` field (additive, non-breaking).
- `src/connection/index.ts` — Re-exported `ConnectionErrorCause` type alongside `ConnectionErrorPhase`.
- `src/index.ts` — Added `type ConnectionErrorCause` to Phase 3 export block; appended Phase 5 client export block (`MllpClient`, `createClient`, `type ClientOptions`).
- `test/connection/error.test.ts` — Added 4 new test cases covering backwards-compat (no `connectionCause`), both stable members, and a `// @ts-expect-error` compile-time test for invalid members.

## Decisions Made

1. **`_attachExistingConnection` over `_testTransport: Transport` option.** The plan offered both as equally acceptable. Chose the internal method because it doesn't pollute the public `ClientOptions` shape with test-only knobs. Marked `@internal` in JSDoc.
2. **`already connected` rejects rather than no-ops.** Plan offered either. Chose the explicit-contract path with a `MllpConnectionError({ phase: 'connect' })`. Once a Connection has reached `CLOSED` or `DISCONNECTED`, the next `connect()` is allowed (the reference is dropped semantically by the state check).
3. **Optional Connection fields built conditionally.** `drainTimeoutMs` and `framing` are only added to the `ConnectionOptions` payload when the caller provided them — avoids passing `undefined` and lets Connection's own default code path (`opts.drainTimeoutMs ?? 30_000`) run unchanged.
4. **Defense-in-depth `Object.freeze({ ...e })` on event re-emit.** Connection already freezes its emitted payloads. The shallow spread + freeze in MllpClient is a no-op when payload is already frozen but guarantees the contract holds even if a future Connection regression slipped through.
5. **`onSocketError` wraps the OS error before rejecting connect()'s promise.** Without this, callers awaiting `connect()` would see the raw `Error` from `net.Socket`. Wrapping in `MllpConnectionError({ phase: 'connect' })` matches the contract Phase 3 establishes for transport-level errors and keeps callers' `instanceof MllpConnectionError` checks working uniformly.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 — Missing Critical Quality Gate] Coverage strengthening on client.ts**

- **Found during:** Task 3 verification — initial 11-test suite hit only 74.56% line coverage on `src/client/client.ts`, below the CLAUDE.md `src/client/` ≥90% gate.
- **Issue:** The initial test set covered the `_attachExistingConnection` path (deterministic over InMemoryTransport) but left the production `net.createConnection` path largely uncovered, plus several abort-branch and no-Connection-attached paths.
- **Fix:** Added 10 additional tests in a separate `describe('MllpClient additional coverage')` block: production net.Socket connect (success + ECONNREFUSED + mid-attempt abort), close() no-op when no Connection, close() pre-aborted AbortError, close() mid-drain abort force-destroy, destroy() no-op, double-attach throw, reconnecting frozen re-emission, already-connected rejection.
- **Files modified:** `test/client/client-lifecycle.test.ts`
- **Verification:** Coverage rose to 99.42% lines / 100% functions / 90.62% branches on client.ts. Global suite branch coverage rose from 86.94% → 89.97% (still below 90% global gate, but that's a pre-existing pattern in this codebase: server.ts at 77.17% branches drives the global down, unrelated to PLAN-01 scope).
- **Committed in:** `998284a` (separate `test:` commit for clean history).

**2. [Rule 1 — Bug: connect() promise leak path] OS errors before NetTransport handoff would not surface as MllpConnectionError**

- **Found during:** Task 3 — writing the ECONNREFUSED test
- **Issue:** When the underlying `net.Socket` emits `'error'` BEFORE the `Connection` layer attaches its own `_onTransportError` handler (which wraps in `MllpConnectionError`), the connect() promise would reject with the raw OS `Error`. Callers' `instanceof MllpConnectionError` checks would then fail spuriously.
- **Fix:** The `connect()` Promise's `onSocketError` handler explicitly wraps the OS error in `new MllpConnectionError(err.message, { cause: err, phase: 'connect' })` before rejecting. This matches Connection's own wrap shape, so the contract is uniform regardless of which layer caught the error first.
- **Files modified:** `src/client/client.ts` (the wrap was authored as part of Task 3 implementation, not retrofitted)
- **Verification:** "connect() rejects with MllpConnectionError on socket error (ECONNREFUSED)" test asserts `name: 'MllpConnectionError'` and `phase: 'connect'`.
- **Committed in:** `8cd8fe0` (Task 3)

---

**Total deviations:** 2 auto-fixed (1 quality gate, 1 contract correctness)
**Impact on plan:** Both were correctness-level fills, not scope creep. The coverage strengthening is testing-only; the connect-error wrap formalizes the contract that PLAN-04 will rely on for transient/permanent classification.

## Issues Encountered

- **Coverage tooling reports global thresholds.** The `pnpm test --coverage` run flagged `branches (89.97%) does not meet global threshold (90%)`. Verified this is a pre-existing condition (was 86.94% before PLAN-01) primarily driven by `src/server/server.ts` at 77.17% branches; outside PLAN-01 scope. Logged for the verifier to confirm acceptance.
- **`net.createConnection` 'connect' vs 'error' race.** Mid-attempt abort tests are inherently timing-sensitive — used `setImmediate(() => ac.abort())` against a TEST-NET-1 (RFC 5737, `192.0.2.1`) destination so the abort consistently fires before the (impossible) connect resolves.
- **No issues affecting plan correctness.**

## Next Plan Readiness (Phase 5 follow-ups)

Each Phase 5 follow-up plan can rely on the following scaffolding from PLAN-01:

- **PLAN-02 (Correlator + send):** `MllpClient` class skeleton, frozen event-emit pattern, `_connection` field, `_opts` field. Adds `_correlator` instance, `send(buf)` method, `'ack'` event, `MllpTimeoutError` (fills `src/client/error.ts` PLAN-02 sentinel).
- **PLAN-03 (controlId):** Builds on PLAN-02's correlator. Extends `ClientOptions.correlateByControlId`, adds MSH-10 extraction in send path. Uses the existing `MLLP_ACK_UNMATCHED_CONTROL_ID` warning code (already in WarningCode union).
- **PLAN-04 (reconnect):** Extends `ClientOptions` with `autoReconnect`, `retryStrategy`, backoff knobs. Implements CLIENT-17 reconnect-rejection using the `ConnectionErrorCause` union plumbed by PLAN-01: `connectionCause: 'fifo-unsafe'` for queued sends, `connectionCause: 'in-flight-orphan'` for in-flight sends. Adds `RetryContext` + `RetryStrategy` types, fills `isTransientConnectionError` (PLAN-04 sentinel in error.ts).
- **PLAN-05 (backpressure):** Adds `highWaterMark`, `onBackpressure`, `pipeline`, keepalive + dead-peer timer wiring to `ClientOptions`. Fills `MllpBackpressureError` (PLAN-05 sentinel in error.ts).
- **PLAN-06 (starter + stats):** Adds `createStarterClient`, `client.getStats()`, completes the public surface. Builds on PLAN-04/05 defaults per D-22.

## Verification

- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0 (zero warnings).
- `pnpm build` — ESM + CJS + DTS all clean.
- `pnpm test` — 321/321 passing across 20 test files.
- `pnpm test test/client/client-lifecycle.test.ts test/connection/error.test.ts -- --run` — 30/30 passing.
- `grep -rE "Buffer\\.prototype\\.slice|\\.slice\\(" src/client/` — 0 matches (SETUP-07 satisfied).
- `grep -c "Object.freeze" src/client/client.ts` — 8 (≥5 threshold met).
- Coverage on `src/client/client.ts`: 99.42% lines, 100% functions, 90.62% branches (≥90% per-file gate met).

## Threat Flags

None. The PLAN-01 surface is entirely additive over the Phase 3 Connection FSM; no new network endpoints, auth paths, or schema changes at trust boundaries. Threat register entries from the plan (T-05-01-01 through T-05-01-07) are all mitigated or accepted as documented.

## Self-Check: PASSED

**Files claimed created (all verified present):**
- `src/client/client.ts` — FOUND (435 lines)
- `src/client/index.ts` — FOUND
- `src/client/error.ts` — FOUND (sentinel markers present)
- `test/client/client-lifecycle.test.ts` — FOUND (21 tests)

**Commits claimed (all verified in git log):**
- `8a3aa68` — FOUND (feat: Task 1)
- `9fdd2b6` — FOUND (feat: Task 2)
- `8cd8fe0` — FOUND (feat: Task 3)
- `998284a` — FOUND (test: coverage strengthening)

**Acceptance criteria spot checks:**
- `grep -c "export class MllpClient extends EventEmitter" src/client/client.ts` = 1 ✓
- `grep -c "// Phase 6: wire TlsTransport here when opts.tls is provided" src/client/client.ts` = 1 ✓
- `grep -c "Symbol.asyncDispose" src/client/client.ts` = 2 ✓
- `grep -c "type ConnectionErrorCause" src/connection/index.ts` = 1 ✓
- `grep -c "type ConnectionErrorCause" src/index.ts` = 1 ✓

---

*Phase: 05-mllp-client*
*Plan: 01*
*Completed: 2026-05-01*
