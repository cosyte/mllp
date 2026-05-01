---
phase: 05-mllp-client
verified: 2026-05-01T15:42:00Z
status: passed
score: 5/5 success criteria verified, 22/22 REQ-IDs verified
gates:
  tests: 521/521 passing
  typecheck: green
  lint: green
  build: green
  coverage_client: 92.75% lines (≥ 90% gate)
---

# Phase 5: MLLP Client Verification Report

**Phase Goal:** A developer calling `createClient({ host, port }).connect()` can `send(buf)` and receive an ACK `Promise<Buffer>` with configurable timeout (timer at write-flush), FIFO or controlId-correlated ACK matching, automatic exponential-backoff reconnect, well-bounded backpressure, `pipeline: false` serialization, and a three-line `createStarterClient` helper. Full `AbortSignal` + `Symbol.asyncDispose` + frozen events + `client.getStats()`.

**Verified:** 2026-05-01
**Status:** PASSED
**Re-verification:** No (initial)

## Goal Achievement — Success Criteria

### SC-1: Typed rejections + write-flush ACK timer

| Aspect | Status | Evidence |
|--------|--------|----------|
| `client.send()` returns `Promise<Buffer>` resolving with framing-stripped ACK | VERIFIED | `src/client/client.ts:1249–1369` — `send()` signature, `_onAckMatched` resolves with `ackPayload` |
| `MllpTimeoutError` (with `messageControlId`, `elapsedMs`, `sentAt`) | VERIFIED | `src/client/error.ts:33–61`; rejection sites at `client.ts:651–660` (correlator timeout) and `1402–1413` (drain wait timeout) |
| `MllpConnectionError` rejections (e.g. send-before-connect, in-flight-orphan, fifo-unsafe) | VERIFIED | `client.ts:1262–1267`, `829–846` |
| `MllpBackpressureError` rejections | VERIFIED | `client.ts:1296–1306`; class at `error.ts:143–171` |
| `AbortError` (DOMException) on signal abort | VERIFIED | `client.ts:484, 556, 1255, 1346, 1424, 1492, 1537` |
| Timer starts at write-flush (NOT `send()` call) | VERIFIED | `client.ts:1362–1363` — `conn.send(frame)` then `correlator.markFlushed(key, Date.now())`; tests in `test/client/timeout-error.test.ts` and CLIENT-04 covered in `test/client/client-send-fifo.test.ts` |

### SC-2: controlId correlation + unmatched/late-ACK semantics

| Aspect | Status | Evidence |
|--------|--------|----------|
| `correlateByControlId` option triggers MSH-10 → MSA-2 keyed matching | VERIFIED | `client.ts:1271–1274` (extract MSH-10 outbound), `client.ts:1101–1115` (extract MSA-2 inbound), `correlator.ts:347–399` (keyed lookup branch) |
| Out-of-order ACKs match correctly | VERIFIED | `test/client/client-send-controlid.test.ts:80` Test 2 |
| `MLLP_ACK_UNMATCHED_CONTROL_ID` emitted on stray ACK | VERIFIED | `client.ts:629–650` (onUnmatchedAck → frozen `MllpFramingError` to `'error'`); `correlator.ts:394–397`; tests in `client-send-controlid.test.ts:134` Test 4 |
| `MLLP_ACK_AFTER_TIMEOUT` warning + ACK dropped | VERIFIED | `correlator.ts:380–392` (graveyard hit); tests at `client-send-controlid.test.ts:170` Test 5 + `:206` Test 6 (graveyard TTL) |
| Late-ACK graveyard with `2 * ackTimeoutMs` TTL | VERIFIED | `correlator.ts:474–479` `_evictGraveyardDue` |

### SC-3: Exponential backoff reconnect + classifier + in-flight handling

| Aspect | Status | Evidence |
|--------|--------|----------|
| Exponential backoff `100ms * 2^n` capped 30s ±20% jitter | VERIFIED | `client.ts:951–958` (`_defaultRetryStrategy`); defaults set in ctor `client.ts:434–437`; tests at `client-reconnect.test.ts:178` Test 3, `:388` Test 11 |
| Custom `retryStrategy` hook with frozen `RetryContext` (7 fields incl. `signal`) | VERIFIED | `client.ts:86–105` (`RetryContext` interface), `883–894` (frozen ctx); tests at `client-reconnect.test.ts:246` Test 5, `:261` Test 6 |
| `retryStrategy` returning `null` halts → CLOSED | VERIFIED | `client.ts:919–924`; test `client-reconnect.test.ts:288` Test 7 |
| Backoff-reset-on-recent-success | VERIFIED | `client.ts:870–877` (W-01 reset); `_lastSuccessAt` tracked at `1142`; test `client-reconnect.test.ts:201` Test 4 |
| Transient/permanent classifier (Composition A — runs first) | VERIFIED | `error.ts:94–118` (`isTransientConnectionError`); applied at `client.ts:855–864` (permanent → CLOSED before strategy); test `client-reconnect.test.ts:298` Test 8; full classifier table in `test/client/transient-classifier.test.ts` (16 cases) |
| FIFO mode: in-flight orphan + queued reject with distinct causes | VERIFIED | `client.ts:823–850` (orphan → `'in-flight-orphan'`, queued → `'fifo-unsafe'`); cause union `src/connection/error.ts:55`; test `client-reconnect.test.ts:444` Test 13 |
| controlId mode: idempotent retransmit on reconnect | VERIFIED | `client.ts:1041–1048` `_afterReconnectArmed`; test `client-reconnect.test.ts:402` Test 12 |

### SC-4: Backpressure + pipeline:false + drain

| Aspect | Status | Evidence |
|--------|--------|----------|
| `highWaterMark: number` (count, default 64) | VERIFIED | `client.ts:441–444`; `ClientOptions` interface `client.ts:208` |
| `highWaterMark: { bytes }` byte-only | VERIFIED | `client.ts:445–448` |
| `highWaterMark: { count, bytes }` stricter-of-two wins | VERIFIED | `client.ts:1284–1287` (`overCount \|\| overBytes`); test `backpressure.test.ts` (file present) + `backpressure-error.test.ts:37` Test 3 |
| `onBackpressure: 'reject'` (default) → `MllpBackpressureError` | VERIFIED | `client.ts:1296–1307` |
| `onBackpressure: 'wait'` → drain or timeout | VERIFIED | `client.ts:1381–1429` `_waitThenSend` |
| `pipeline: false` strict serialization (maxInFlight=1) | VERIFIED | `client.ts:611–612` (Correlator `maxInFlight: 1`); `correlator.ts:293`; `pipeline-serialization.test.ts` (file present) |
| `'drain'` event with frozen `{ queueDepth, queueBytes }` | VERIFIED | `client.ts:1158–1169` `_maybeEmitDrain` (Object.freeze) |

### SC-5: createStarterClient + getStats + isTransientConnectionError + destroy→CLOSED

| Aspect | Status | Evidence |
|--------|--------|----------|
| `createStarterClient` 3-line north-star, returns CONNECTED client | VERIFIED | `client.ts:1746–1801` (async, awaits `connect()`); JSDoc example at `1740–1744`; tests `starter-client.test.ts:88` Test 1, `:189` Test 6 (literal snippet present) |
| D-22 defaults: autoReconnect=true, ackTimeout=30000, FIFO, pipeline=true, hwm=64, reject, signals=false | VERIFIED | `client.ts:1750–1772`; tests `starter-client.test.ts:98` Test 2, `:160` Test 4b |
| `Symbol.asyncDispose` on `MllpClient` | VERIFIED | `client.ts:1640–1642`; test `starter-client.test.ts:175` Test 5 (await using triggers close → CLOSED) |
| `client.getStats()` JSON-serializable plain object — full D-26 shape (15 fields) | VERIFIED | `client.ts:271–304` (`ClientStats` interface 15 fields); `client.ts:1599–1628` (impl); test `get-stats.test.ts:106` Test 3 (JSON round-trip), Tests 1–12 cover all fields |
| `isTransientConnectionError` exported from main barrel | VERIFIED | `src/index.ts:62`; `src/client/index.ts:20`; `src/client/error.ts:94` |
| `client.destroy()` → CLOSED directly | VERIFIED | `client.ts:1564–1581` (`_userClosed = true`, `conn.destroy(reason)`); `client-lifecycle.test.ts` covers |
| Frozen event payloads on every public emit | VERIFIED | 13 `Object.freeze(...)` sites in `client.ts`; warning + error pass-throughs receive already-frozen Connection-layer payloads; full audit in `frozen-events.test.ts` |

**Score: 5/5 success criteria verified.**

---

## Requirements Coverage (22 REQ-IDs)

| REQ-ID | Description | Status | Evidence |
|--------|-------------|--------|----------|
| CLIENT-01 | `createClient` + `connect()` resolves on CONNECTED + `close()` resolves after drain | VERIFIED | `client.ts:1658–1660`, `:479–586`, `:1483–1553`; `client-lifecycle.test.ts` |
| CLIENT-02 | `send()` returns `Promise<Buffer>` resolving with ACK or rejecting with typed errors | VERIFIED | `client.ts:1249–1369`; `client-send-fifo.test.ts` |
| CLIENT-03 | FIFO + `correlateByControlId` MSH-10/MSA-2 modes | VERIFIED | `client.ts:1271–1274, 1101–1115`; `correlator.ts:347–399`; `client-send-controlid.test.ts` |
| CLIENT-04 | Per-message `ackTimeoutMs`, timer at write-flush, AbortSignal | VERIFIED | `client.ts:1362–1363` flush-mark; `correlator.ts:320–327` markFlushed; `timeout-error.test.ts` |
| CLIENT-05 | Auto-reconnect with exponential backoff + reconnecting events + reset-on-success | VERIFIED | `client.ts:810–945`; `client-reconnect.test.ts` |
| CLIENT-06 | Queue continues during reconnect; `autoReconnect:false` rejects pending sends | VERIFIED | `client.ts:1212–1222`; `client-reconnect.test.ts:472` Test 14 |
| CLIENT-07 | Backpressure highWaterMark count/bytes + drain mechanism | VERIFIED | `client.ts:441–450, 1280–1311`; `backpressure.test.ts` |
| CLIENT-08 | `keepaliveIntervalMs` (TCP) + `deadPeerTimeoutMs` (idle) | VERIFIED | `client.ts:519–522, 769–789`; `dead-peer.test.ts` (16 tests) |
| CLIENT-09 | `destroy()` distinct from `close()`; rejects pending; → CLOSED | VERIFIED | `client.ts:1564–1581`; `client-lifecycle.test.ts` |
| CLIENT-10 | `createStarterClient` batteries-included | VERIFIED | `client.ts:1746–1801`; `starter-client.test.ts` |
| CLIENT-11 | `connect/send/close` accept `signal: AbortSignal` | VERIFIED | `client.ts:479, 1249, 1483`; `abort-signal-coverage.test.ts` |
| CLIENT-12 | `retryStrategy` hook | VERIFIED | `client.ts:111`, `:898–917`; `client-reconnect.test.ts:246` |
| CLIENT-13 | All event payloads `Object.freeze`'d | VERIFIED | 13 freeze sites in `client.ts`; `frozen-events.test.ts` |
| CLIENT-14 | `Symbol.asyncDispose` enables `await using` | VERIFIED | `client.ts:1640–1642`; `starter-client.test.ts:175` |
| CLIENT-15 | Unmatched ACK → `MLLP_ACK_UNMATCHED_CONTROL_ID` to `error` | VERIFIED | `client.ts:629–650`; `client-send-controlid.test.ts:134` Test 4 |
| CLIENT-16 | Late ACK → `MLLP_ACK_AFTER_TIMEOUT` warning + drop | VERIFIED | `correlator.ts:380–392`; `client-send-controlid.test.ts:170` Test 5 |
| CLIENT-17 | Reconnect: controlId resends, FIFO rejects with `fifo-unsafe`/`in-flight-orphan` | VERIFIED | `client.ts:813–850, 1041–1048`; `client-reconnect.test.ts:402, 444` |
| CLIENT-18 | Transient/permanent classifier; `isTransientConnectionError` exported | VERIFIED | `error.ts:94–118`; `index.ts:20`, root `index.ts:62`; `transient-classifier.test.ts` |
| CLIENT-19 | `pipeline: false` strict serialization | VERIFIED | `client.ts:611–612, 450`; `pipeline-serialization.test.ts` |
| OBS-01 | `client.getStats()` JSON-serializable, D-26 shape | VERIFIED | `client.ts:271–304, 1599–1628`; `get-stats.test.ts` (12 tests, JSON round-trip verified) |
| ERR-02 | `MllpTimeoutError` shape + thrown on timeout | VERIFIED | `error.ts:33–61`; `timeout-error.test.ts` |
| ERR-04 | `MllpBackpressureError` with queueDepth/queueBytes/highWaterMark | VERIFIED | `error.ts:143–171`; `backpressure-error.test.ts` |

**Score: 22/22 REQ-IDs verified.**

---

## Engineering Guardrails Audit

| Guardrail | Result | Evidence |
|-----------|--------|----------|
| No `Buffer.slice()` in `src/client/` (SETUP-07) | PASS | `grep '.slice(' src/client/*.ts` returns no source matches; ESLint passes |
| No `console.*` in library code | PASS | `grep 'console\.(log\|warn\|error\|info\|debug)' src/client/*.ts` returns no matches |
| Zero runtime deps preserved | PASS | Imports limited to `node:net`, `node:events`, and project-internal modules |
| Frozen events on every public emit | PASS | 13 `Object.freeze(...)` payload sites; 14 `this.emit(` sites — 12 emit freshly-frozen payloads, 2 (`'warning'`, `'error'`) re-emit pre-frozen Connection-layer payloads (defense-in-depth acceptable) |
| `AbortSignal` honored on every public awaitable | PASS | `connect()` (`client.ts:479`), `send()` (`:1249`), `close()` (`:1483`); abort cleanup paths verified at 482–484, 1255, 1490 |
| `Symbol.asyncDispose` present | PASS | `client.ts:1640–1642` |
| Stable cause-code `'in-flight-orphan'` added to `ConnectionErrorCause` union | PASS | `src/connection/error.ts:55` `type ConnectionErrorCause = 'fifo-unsafe' \| 'in-flight-orphan'` |
| Public barrel re-exports complete | PASS | `src/index.ts:50–63` exports `MllpClient`, `createClient`, `createStarterClient`, `ClientOptions`, `ClientStats`, `StarterClientOptions`, `RetryContext`, `RetryStrategy`, `MllpTimeoutError`, `MllpBackpressureError`, `isTransientConnectionError` (11 symbols) |
| `MllpFramingError` re-exported | PASS | `src/index.ts:21` |
| `getStats()` returns JSON-serializable plain object (no Buffers/classes) | PASS | `client.ts:1599–1628`; `get-stats.test.ts` Test 3 round-trips through `JSON.stringify` |
| `noUncheckedIndexedAccess` strict mode | PASS | `pnpm typecheck` green |
| `pnpm test` (521/521) | PASS | 36 test files, 521 tests, ~9.5s |
| `pnpm typecheck` | PASS | green |
| `pnpm lint` | PASS | green |
| `pnpm build` (dual ESM + CJS + DTS) | PASS | green |
| `src/client/` coverage ≥ 90% lines | PASS | 92.75% lines / 91.00% branches / 95.45% functions (client/ subtree); `client.ts` at 90.32% lines |

### Notes (informational, not blocking)

- The verification focus mentioned "no `PLAN-0[1-6]` sentinels remaining". The `PLAN-0X` strings present in `src/client/*.ts` are all in **JSDoc/comment cross-references** (e.g. "Plan 04 — preserve correlator state…", "PLAN-06 (OBS-01, D-26) — observability counters"), not unfilled sentinels or `// PLAN-XX FILL ME` markers. They serve as traceability tags pointing to the plan documents and are not anti-patterns. The PLAN-XX-fills regression test in `timeout-error.test.ts:58` and `backpressure-error.test.ts:75` explicitly verifies that the original blank fill-in markers were removed.

---

## Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Test suite green | `pnpm exec vitest run --reporter=dot` | 521 passed (521) in 5.79s | PASS |
| Typecheck | `pnpm typecheck` | exit 0, no output | PASS |
| Lint | `pnpm lint` | exit 0, no output | PASS |
| Build | `pnpm build` | ESM + CJS + DTS bundles produced; "Build success" | PASS |
| Coverage gate | `pnpm exec vitest run --coverage` | client/ 92.75% lines (≥ 90% gate) | PASS |
| Public exports resolvable | `grep` of `src/index.ts` for Phase 5 symbols | 11 client symbols re-exported | PASS |

---

## Anti-Pattern Scan

| File | Pattern | Result |
|------|---------|--------|
| `src/client/client.ts` | `TODO`/`FIXME`/`XXX`/`HACK` | None found |
| `src/client/client.ts` | `Buffer.prototype.slice` | None found |
| `src/client/client.ts` | `console.*` | None found |
| `src/client/client.ts` | `as any` / unjustified casts | None found (one `as { error?: unknown }` at 729 used safely with instanceof guard) |
| `src/client/correlator.ts` | All above | None found |
| `src/client/error.ts` | All above | None found |
| `src/client/index.ts` | All above | None found |

---

## Gaps Summary

**None.** Every Phase 5 success criterion has direct codebase evidence; every REQ-ID has a typed signature, an implementation site, and at least one explicit test. The 6 plans (`05-01..05-06-PLAN.md`) all delivered their declared deliverables, the SUMMARY claims hold up under codebase inspection, and all four CI gates (test / typecheck / lint / build) pass cleanly with the per-directory coverage gate satisfied at 92.75% on `src/client/`.

The phase goal — *"a developer calling `createClient({ host, port }).connect()` can `send(buf)` and receive an ACK Promise<Buffer> with configurable timeout, FIFO/controlId correlation, exponential-backoff reconnect, well-bounded backpressure, pipeline:false serialization, and a three-line `createStarterClient` helper, with full `AbortSignal` + `Symbol.asyncDispose` + frozen events + `client.getStats()`"* — is fully achieved.

**Recommendation:** Proceed to `/gsd-validate-phase 5` for Nyquist test-coverage audit, then `/gsd-transition` to Phase 6.

---

*Verified: 2026-05-01T15:42:00Z*
*Verifier: Claude (gsd-verifier, Opus 4.7)*
