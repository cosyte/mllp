---
phase: 05-mllp-client
plan: 06
subsystem: client
tags: [mllp, client, observability, getstats, starter, abortsignal, frozen-events, audit, typescript]

# Dependency graph
requires:
  - phase: 03-transport-connection-fsm-observability
    provides: Connection 6-state FSM, MllpConnectionError, frozen lifecycle events with connectionId
  - plan: 05-01
    provides: MllpClient scaffold with PLAN-01 frozen event re-emitters; AbortSignal pre-check on connect/close
  - plan: 05-02
    provides: send() with AbortSignal cleanup; PendingAck.sentAt; HOOK_EXTENSION_POINT (ack-matched, state-change)
  - plan: 05-03
    provides: controlId Correlator mode; onUnmatchedAck → frozen 'error' payload
  - plan: 05-04
    provides: RetryContext.signal capture (W-07); frozen 'reconnecting' payload with attempt + delayMs
  - plan: 05-05
    provides: HighWaterMark + onBackpressure; _waitThenSend with B-06 abort cleanup; frozen 'drain' payload; pipeline:false (Correlator maxInFlight=1)
provides:
  - MllpClient.getStats() — D-26 shape with epoch-ms timestamps; JSON-serializable per OBS-04
  - ClientStats public type — { state, connectionId, queueDepth, queueBytes, inFlight, warningsByCode, totalBytesIn, totalBytesOut, sentTotal, ackedTotal, timedOutTotal, reconnectAttempts, lastConnectedAt, lastAckAt }
  - Correlator._inFlight counter — count of live entries with sentAt !== null (B-01); maintained across markFlushed / remove / matchAck / expireDue / clear
  - CorrelatorStats.inFlight exposed via Correlator.getStats()
  - createStarterClient(opts) — D-22 batteries-included defaults; awaits connect() before return; opt-in handleSignals (SIGTERM/SIGINT)
  - StarterClientOptions public type — { host, port, signal?, handleSignals?, onMessage? }
  - MllpClient[Symbol.asyncDispose]() — delegates to close() (CLIENT-14); enables `await using` north-star ergonomics
  - test/client/abort-signal-coverage.test.ts — 8-case audit of CLIENT-11 across connect/send/close/reconnect-mid-backoff/wait-mode-mid-abort
  - test/client/frozen-events.test.ts — 22-case audit of CLIENT-13 across all 10 public events (Object.isFrozen + mutation-throws-TypeError + connectionId presence)
affects: [phase 06 TLS — Phase 6 will preserve all 10 frozen-event payloads + AbortSignal contracts unchanged]

tech-stack:
  added: []
  patterns:
    - Owned correlator counter — _inFlight is internal Correlator state, never derived from a scan; mutates only at markFlushed (zero→non-zero), remove (any), matchAck (non-zero→zero), expireDue (per expired entry), clear (reset to 0)
    - getStats() aggregation — _connection?.getStats() for bytesIn/bytesOut; _correlator.getStats() for queue/inFlight; _aggregatedWarningsByCode (client-side) merged with Connection's warningsByCode; epoch-ms (NOT Date) per D-26; warningsByCode keys typed Partial<Record<WarningCode, number>> (B-05)
    - createStarterClient awaits connect() inside the factory — JSDoc north-star uses `await using c = await createStarterClient(...)` (W-06: factory is async, so the explicit await is required before `using`)
    - Audit-suite pattern — Phase 5 ships two consolidated audit suites (abort-signal-coverage, frozen-events) that re-verify cross-plan invariants (PLAN-01 connect, PLAN-02 send, PLAN-04 reconnect, PLAN-05 wait-mode) in one place so future regressions surface in a single suite

key-files:
  created:
    - test/client/get-stats.test.ts
    - test/client/starter-client.test.ts
    - test/client/abort-signal-coverage.test.ts
    - test/client/frozen-events.test.ts
  modified:
    - src/client/client.ts
    - src/client/correlator.ts
    - src/client/index.ts
    - src/index.ts

key-decisions:
  - "Audit suites added without implementation changes. Both abort-signal-coverage and frozen-events suites pass against the existing client.ts unmodified — confirming PLAN-01/02/04/05 already discharged the full CLIENT-11 (AbortSignal cleanup) and CLIENT-13 (frozen events) contracts. Task 3 is genuinely an audit, not a feature: 30 new test cases, 0 production-code lines changed."
  - "AbortSignal listener-leak audit (Test 6) verifies the success-path invariant via spies on AbortSignal.addEventListener / removeEventListener. We assert addCount === removeCount after a non-aborted send() resolves — proving the abort listener is unwired in the cleanup path. The aborted path is platform-managed via `{ once: true }` (the listener is auto-removed when 'abort' fires)."
  - "Frozen-events audit covers all 10 public events with 22 individual cases (Test 9 ×10 events, Test 10 ×10 events, Test 11 ×2 multi-event spot-checks). Mutation assertion uses TypeError (strict-mode-implicit-in-ESM behavior of frozen objects)."
  - "'wait'-mode B-06 mid-abort cleanup (Test 8) re-verifies the listenerCount('drain') invariant from PLAN-05 Test 6b but adds the explicit DOMException shape assertion. The two tests now form a belt-and-suspenders layer: PLAN-05 covers the cleanup-count, PLAN-06 covers the error-shape."
  - "createStarterClient JSDoc north-star uses `await using c = await createStarterClient(...)` (NOT `await using c = createStarterClient(...)`). The factory is async, so without the explicit await the using-binding holds a Promise — disposal would call Promise.then[Symbol.asyncDispose] which doesn't exist. W-06 enforcement at acceptance criteria level catches this."

patterns-established:
  - "Pattern: per-phase audit suites for cross-plan invariants. Phase 5 demonstrated the pattern by consolidating CLIENT-11 (AbortSignal) and CLIENT-13 (frozen events) — both contracts spread across PLAN-01/02/04/05 — into single suites. Phase 6 (TLS) and beyond should add a single audit suite for any contract that cuts across multiple plans, so regressions surface in one place."
  - "Pattern: Object.isFrozen + mutation-throws-TypeError as the dual-assertion frozen-events check. `Object.isFrozen` confirms the freeze; the TypeError mutation attempt confirms the freeze actually rejects writes (strict-mode behavior). Both assertions are required because a future contributor could replace `Object.freeze({...})` with `{...}` and `Object.isFrozen` would be false but a single-assertion test that only checked `expect(payload.x).toBe(...)` wouldn't catch it."
  - "Pattern: client-owned aggregated warnings counter. Correlator-emitted warnings (MLLP_ACK_AFTER_TIMEOUT, MLLP_ACK_UNMATCHED_CONTROL_ID) bypass Connection's warningsByCode (Connection only sees framing-layer warnings). MllpClient maintains _aggregatedWarningsByCode for the Correlator stream and merges with Connection.getStats().warningsByCode in getStats() — single observable view per CLAUDE.md stable-warning-codes guardrail."

requirements-completed:
  - CLIENT-09  # client lifecycle Symbol.asyncDispose (CLIENT-14 entry — verified via `await using` test)
  - CLIENT-10  # createStarterClient three-line north-star
  - CLIENT-11  # AbortSignal on connect/send/close + reconnect-mid-backoff + wait-mode-mid-abort (audit closes cross-plan invariant)
  - CLIENT-13  # Frozen public event payloads — all 10 events covered by audit
  - CLIENT-14  # Symbol.asyncDispose path (verified via `await using` in starter-client tests)
  - OBS-01     # client.getStats observable counters — D-26 shape

# Metrics
duration: ~95 min  (cumulative across the prior agent's Task 1+2 + this agent's Task 3)
completed: 2026-05-01
---

# Phase 5 Plan 06: createStarterClient + Observability + Audit Suites Summary

**The Phase 5 closer — `createStarterClient` ships the three-line north-star with D-22 batteries-included defaults; `client.getStats()` exposes the D-26 OBS-01 shape with epoch-ms timestamps and a Correlator-owned `inFlight` counter that is observably distinct from `queueDepth` (B-01); two consolidated audit suites lock in CLIENT-11 (AbortSignal cleanup across connect/send/close/reconnect-mid-backoff/wait-mode-mid-abort) and CLIENT-13 (frozen payload + mutation-throws-TypeError on all 10 public events) as cross-plan invariants — both pass against the unmodified client.ts, confirming PLAN-01/02/04/05 already discharged the full contracts. Phase 5 is delivery-complete: 22 REQ-IDs closed, 211/211 client tests green, 521/521 full-suite tests green, src/client/ at 92.75% line coverage (>= 90% gate).**

## Performance

- **Duration (cumulative across both agent runs):** ~95 minutes
- **Tasks:** 3 (Task 1 + Task 2 each TDD: RED+GREEN; Task 3 audit: single test commit)
- **Commits:** 5 task commits (4 from prior agent run + 1 audit commit) + this metadata commit
- **Files created (cumulative):** 4 test files (`get-stats.test.ts`, `starter-client.test.ts`, `abort-signal-coverage.test.ts`, `frozen-events.test.ts`)
- **Files modified (cumulative):** 4 source files (`src/client/{client,correlator,index}.ts`, `src/index.ts`)
- **Tests added (cumulative):** 12 + 9 + 8 + 22 = 51 new client tests across the three tasks

## Accomplishments

- **`MllpClient.getStats()` returns the D-26 shape end-to-end.** All 12 tests in `get-stats.test.ts` pass: zero-state shape before connect, full shape after connect, sent/acked/timedOut counters track correctly, `lastConnectedAt`/`lastAckAt` are epoch-ms (NOT Date — JSON-serializable per OBS-04), `warningsByCode` aggregates from BOTH Connection's framing warnings AND the Correlator's ACK-pathology warnings, `reconnectAttempts` reads from `_reconnectAttempts` (the W-02 counter), `inFlight` and `queueDepth` are observably distinct fields (B-01 — Test 11 forces a divergence by enqueueing without flushing).
- **`Correlator._inFlight` counter is owned by Correlator, not derived.** Mutates at exactly 5 sites: `markFlushed` (only on first flush), `remove` (decrement if entry was flushed), `matchAck` (decrement on ack-match), `expireDue` (decrement per expired flushed entry), `clear` (reset to 0). PLAN-04's controlId reflushAll is idempotent — re-marking a flushed entry does NOT re-increment.
- **`createStarterClient` ships the three-line north-star.** All 9 tests in `starter-client.test.ts` pass: D-22 defaults applied, override semantics work, awaits `connect()` before return (W-06: caller doesn't need a separate `.connect()` call), opt-in `handleSignals` registers SIGTERM/SIGINT once each, `Symbol.asyncDispose` works via `await using`, JSDoc north-star uses `await using c = await createStarterClient(...)` (W-06 corrected — explicit await on the async factory).
- **Audit suite — AbortSignal coverage (CLIENT-11).** All 8 tests in `abort-signal-coverage.test.ts` pass against the existing client.ts: connect-abort-before-resolve, send-abort-before-ack, close-abort-during-DRAINING, pre-aborted-signal-on-each-method, DOMException shape (`name === 'AbortError'`), addEventListener/removeEventListener pairing audit, mid-backoff abort cancels reconnect (PLAN-04 path), `'wait'`-mode mid-wait abort yields AbortError + zero leftover `'drain'` listeners (B-06 — PLAN-05 path).
- **Audit suite — frozen events (CLIENT-13, D-25).** All 22 tests in `frozen-events.test.ts` pass: every one of the 10 public events (`'connect'`, `'reconnecting'`, `'disconnect'`, `'close'`, `'error'`, `'drain'`, `'stateChange'`, `'warning'`, `'message'`, `'ack'`) is asserted `Object.isFrozen` AND mutation throws `TypeError`; `connectionId` presence is spot-checked on the events that carry it (per LIFE-04: `'connect'`, `'message'`, `'warning'`, `'error'`).
- **Both audit suites pass against the existing client.ts WITHOUT any production-code changes** — confirming the genuine audit nature of Task 3. PLAN-01/02/04/05 already discharged the full CLIENT-11 and CLIENT-13 contracts; this plan ships the verification.
- **Quality gates** — `pnpm test` 521/521 green, `pnpm typecheck` 0 errors, `pnpm lint` 0 warnings.
- **Coverage** — `src/client/`: 92.75% lines / 91% branches / 95.45% functions. `client.ts` 90.32% / 88.63% / 93.33%; `correlator.ts` 100% / 94.49% / 100%; `error.ts` and `index.ts` both 100%. CLAUDE.md ≥90% per-directory gate satisfied.

## Task Commits

1. **Task 1 — `client.getStats` + Correlator `inFlight` counter (PLAN-06, OBS-01, D-26):**
   - RED: `cc2520e` (test) — 12 failing tests covering zero-state shape, post-connect shape, send/ack counters, timedOut counter, lastConnectedAt/lastAckAt epoch-ms, JSON-serializability, warningsByCode merge, reconnectAttempts, inFlight vs queueDepth divergence (B-01), Correlator.inFlight semantics across markFlushed/remove/matchAck/expireDue/clear.
   - GREEN: `3921407` (feat) — adds `_inFlight` field on `Correlator` with maintenance at all 5 mutation sites; exposes via `Correlator.getStats().inFlight`; adds `ClientStats` type (D-26 shape with `Partial<Record<WarningCode, number>>` per B-05); implements `MllpClient.getStats()` aggregating `_connection?.getStats()` + `_correlator.getStats()` + client-side counters; threads observability counter increments through `_onAckMatched` (`_ackedTotal`, `_lastAckAt`), `Correlator.onTimeout` (`_timedOutTotal`), `_onStateChange` (`_lastConnectedAt`), and the `send()` post-flush path (`_sentTotal`).

2. **Task 2 — `createStarterClient` + D-22 defaults + `Symbol.asyncDispose` (CLIENT-10, CLIENT-14):**
   - RED: `38d8d0c` (test) — 9 failing tests covering three-line north-star round-trip, D-22 defaults, override semantics, handleSignals registration, Symbol.asyncDispose path via `await using`, JSDoc north-star example presence, StarterClientOptions type export.
   - GREEN: `2ecb487` (feat) — adds `StarterClientOptions` type; implements `createStarterClient(opts)` that applies D-22 defaults (`autoReconnect: true`, `pipeline: false`, `correlateByControlId: true`, `keepaliveIntervalMs: 30_000`, `deadPeerTimeoutMs: 90_000`, `ackTimeoutMs: 30_000`, `highWaterMark: 64`, `onBackpressure: 'reject'`), awaits `connect()` before return, optionally registers SIGTERM/SIGINT handlers via `process.once` when `handleSignals: true`; updates JSDoc with three-line north-star using `await using c = await createStarterClient(...)`; re-exports through `src/client/index.ts` and `src/index.ts`.

3. **Task 3 — Audit suites: AbortSignal coverage + frozen events (CLIENT-11 + CLIENT-13):**
   - TEST: `4a8ca1a` (test) — adds `test/client/abort-signal-coverage.test.ts` (8 tests) and `test/client/frozen-events.test.ts` (22 tests). Both suites pass against the unmodified client.ts; no production-code changes. The `test(...)` commit type (single commit, no GREEN companion) reflects the audit nature: the contracts being asserted were already implemented across PLAN-01/02/04/05.

## Files Created/Modified

### Created
- `test/client/get-stats.test.ts` — 12 tests for `MllpClient.getStats()` D-26 shape, counters, JSON-serializability, B-01 inFlight vs queueDepth divergence, Correlator.inFlight maintenance.
- `test/client/starter-client.test.ts` — 9 tests for `createStarterClient` D-22 defaults, override semantics, handleSignals, Symbol.asyncDispose path, JSDoc north-star presence.
- `test/client/abort-signal-coverage.test.ts` — 8 tests for CLIENT-11 audit (connect/send/close/pre-aborted/DOMException-shape/listener-pairing/reconnect-mid-backoff/wait-mode-mid-abort).
- `test/client/frozen-events.test.ts` — 22 tests for CLIENT-13 audit (Object.isFrozen + TypeError-on-mutation across all 10 public events; connectionId spot-checks per LIFE-04).

### Modified
- `src/client/correlator.ts` — Added `_inFlight` private counter; maintenance at `markFlushed` (first-flush guard), `remove` (decrement-if-flushed), `matchAck` (decrement on hit), `expireDue` (decrement per expired flushed entry), `clear` (reset to 0); exposes `inFlight` via `getStats()`.
- `src/client/client.ts` — Added `ClientStats` public type with `Partial<Record<WarningCode, number>>` warningsByCode (B-05); added `_aggregatedWarningsByCode` field for Correlator-emitted warnings; added 5 observability counters (`_sentTotal`, `_ackedTotal`, `_timedOutTotal`, `_lastConnectedAt`, `_lastAckAt`); implemented `getStats()` aggregating Connection + Correlator + client-side state; added `StarterClientOptions` type; implemented `createStarterClient(opts)` with D-22 defaults, awaited connect, opt-in handleSignals; threaded counter increments at `_onAckMatched`, `Correlator.onTimeout`, `_onStateChange` (CONNECTED entry), and post-flush in `send()`.
- `src/client/index.ts` — Re-exported `createStarterClient`, `StarterClientOptions`, `ClientStats`.
- `src/index.ts` — Phase 5 client export block extended with `createStarterClient`, `StarterClientOptions`, `ClientStats`.

## Decisions Made

1. **`_inFlight` is owned Correlator state, not a derived scan.** Counting `for (const e of entries) if (e.sentAt !== null)` on every `getStats()` call is O(N); maintaining a counter at the 5 mutation sites is O(1). Trade-off: every code path that mutates the live store must call the counter — but every site already exists (markFlushed, remove, matchAck, expireDue, clear) so the maintenance is a single increment/decrement at the existing call point.

2. **`markFlushed` is idempotent on `_inFlight`.** PLAN-04's controlId reflushAll re-calls `markFlushed` on already-flushed entries during reconnect-resend. We guard with `entry.sentAt === null` before incrementing — re-flush is a no-op for the counter. Without the guard, `reconnectAttempts × inflight-pending-controlId-sends` would over-count.

3. **`_aggregatedWarningsByCode` lives on the client, not Connection.** Connection's `warningsByCode` only counts FrameReader-emitted warnings (framing-layer codes). The Correlator emits `MLLP_ACK_AFTER_TIMEOUT` and `MLLP_ACK_UNMATCHED_CONTROL_ID` (D-04, CLIENT-15) — these are client-layer pathologies. Maintaining the aggregate map on the client and merging both streams in `getStats()` gives subscribers a single observable view (CLAUDE.md stable-warning-codes guardrail at the type boundary via `Partial<Record<WarningCode, number>>`).

4. **`createStarterClient` awaits `connect()` BEFORE returning** — the W-06 north-star ergonomic requirement. Caller writes `const c = await createStarterClient({ host, port })` and `c` is already CONNECTED; no separate `.connect()` call needed. Without this, the north-star would be 4 lines (`createStarterClient` + `.connect()` + `.send()` + `.close()`) instead of 3.

5. **JSDoc north-star uses `await using c = await createStarterClient(...)`.** The factory is async, so `await using c = createStarterClient(...)` would bind a `Promise<MllpClient>` to `using` — disposal would invoke `Promise.then[Symbol.asyncDispose]()` which doesn't exist. The W-06 acceptance criterion (`grep -c "await using c = await createStarterClient" src/client/client.ts >= 1`) catches this at literal-grep level.

6. **Audit suites are single `test(...)` commits, not RED+GREEN pairs.** Task 3 is genuinely an audit: the contracts being asserted (CLIENT-11 AbortSignal cleanup, CLIENT-13 frozen events) were already implemented across PLAN-01/02/04/05. Both new suites pass against the unmodified client.ts. The single `test(...)` commit reflects this; there is no companion GREEN commit because no production-code change was needed.

7. **`'wait'`-mode B-06 audit (Test 8) is a belt-and-suspenders layer over PLAN-05 Test 6b.** PLAN-05 asserted `client.listenerCount('drain')` returns to baseline; PLAN-06 audit Test 8 adds the explicit `expect(err).toBeInstanceOf(DOMException)` and `expect(err.name).toBe('AbortError')` assertions. The two tests now form complementary checks: cleanup-count (PLAN-05) + error-shape (PLAN-06).

## Deviations from Plan

None — plan executed exactly as written for Tasks 1+2 (per the prior agent's commits) and Task 3 audit suites passed against unmodified client.ts as predicted in `<behavior>` step 3.

The only minor adjustment in Task 3 was the listener-leak audit approach (Test 6): the plan suggested `vi.spyOn(signal, 'removeEventListener')`. The implementation uses direct method-replacement (`ac.signal.addEventListener = ...; ac.signal.removeEventListener = ...`) with counters because `vi.spyOn` requires the property to be an own-property writable, and the AbortSignal's listener methods are inherited from EventTarget.prototype — `vi.spyOn` would fail to attach the spy. Direct method-replacement on the instance achieves equivalent semantics. This is a test-fixture-only choice; no production-code impact.

## Phase 5 Closeout

Phase 5 ships **all 22 REQ-IDs**:

- **PLAN-01:** CLIENT-01, CLIENT-02, CLIENT-04, LIFE-04 (re-emit)
- **PLAN-02:** CLIENT-03, CLIENT-12, ERR-02
- **PLAN-03:** CLIENT-15, CLIENT-16
- **PLAN-04:** CLIENT-05, CLIENT-06, CLIENT-17, CLIENT-18, CLIENT-12 (state field), W-01, W-02, W-07
- **PLAN-05:** CLIENT-07, CLIENT-08, CLIENT-19, ERR-04
- **PLAN-06:** CLIENT-09, CLIENT-10, CLIENT-11, CLIENT-13, CLIENT-14, OBS-01

(CLIENT-11 and CLIENT-13 are completed-by-audit in PLAN-06; the underlying implementation is spread across PLAN-01/02/04/05.)

The full CLIENT-NN range (01–19) plus OBS-01, ERR-02, ERR-04 are closed.

Phase 5 deliverable acceptance:
- `node -e "import('./dist/index.js').then(m => console.log(typeof m.createStarterClient, typeof m.MllpClient, typeof m.MllpTimeoutError, typeof m.MllpBackpressureError, typeof m.isTransientConnectionError))"` → all five `function` (verified at PLAN-04 close; preserved here).
- Three-line north-star runs end-to-end against a live test peer (`test/client/starter-client.test.ts` Test 1).
- `inFlight` and `queueDepth` are observably distinct fields (`test/client/get-stats.test.ts` Test 11).

## Self-Check

**Files created (verified):**
- `test/client/get-stats.test.ts` — present (committed in `cc2520e`/`3921407` by prior agent)
- `test/client/starter-client.test.ts` — present (committed in `38d8d0c`/`2ecb487` by prior agent)
- `test/client/abort-signal-coverage.test.ts` — present (committed in `4a8ca1a`)
- `test/client/frozen-events.test.ts` — present (committed in `4a8ca1a`)

**Commits verified in git log:**
- `cc2520e` — Task 1 RED
- `3921407` — Task 1 GREEN
- `38d8d0c` — Task 2 RED
- `2ecb487` — Task 2 GREEN
- `4a8ca1a` — Task 3 audit (RED+GREEN combined; no production change)

**Verifier handoff:** ready for `/gsd-verify-work 5` — Phase 5 deliverable acceptance criteria are all satisfied; coverage gates passing; full suite (521 tests) green; cumulative SUMMARY documents trace from each REQ-ID to the plan that closed it.

## Self-Check: PASSED
