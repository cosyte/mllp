---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 5 executing 2026-05-01 — Wave 1 (05-01 lifecycle) starting; Wave 2 (05-02..05-05) sequential due to client.ts/correlator.ts/error.ts/index.ts overlap; Wave 3 (05-06 starter+stats).
last_updated: "2026-05-01T00:00:00.000Z"
progress:
  total_phases: 8
  completed_phases: 4
  total_plans: 36
  completed_plans: 19
  percent: 50
---

# @cosyte/hl7-mllp — STATE

Project memory for session-to-session continuity. Updated at phase/plan boundaries.

---

## Project Reference

- **Name:** `@cosyte/hl7-mllp`
- **Core value:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.
- **Current focus:** Phase 5 (MLLP Client) — `createClient`, `connect`, `send` with ACK-awaiting, exponential-backoff reconnect, backpressure, `createStarterClient`, `AbortSignal` + `Symbol.asyncDispose`, frozen event payloads, `client.getStats()`.
- **Workflow config:** standard granularity, yolo mode, parallelization enabled, plan-check + verifier + Nyquist validation on, auto-advance on, commit_docs on, research off-by-default (but invoked on-demand for this milestone).
- **Sibling package:** `@cosyte/hl7` (at `../hl7-parser`) — peer dep, not runtime dep. ACK-helper subpath `@cosyte/hl7-mllp/ack-from-hl7` is the only module that references it.

## Current Position

Phase: 5 planned 2026-04-30 — 6 plans across 3 waves, checker PASSED iter 2.
Next Step: `/gsd-execute-phase 5`
Resume file: `.planning/phases/05-mllp-client/05-01-PLAN.md`

- **Milestone:** v1 (initial release — transport-only MLLP client + server)
- **Phase:** 4 complete — MllpServer, createServer(), createStarterServer(), auto-ACK, graceful shutdown, keepalive, AbortSignal, Symbol.asyncDispose, frozen events, server.getStats(), byteOffset/warnings threading, _closedTotal guard
- **Plans (milestone total):** 19 / ~36 complete (6 new plans for Phase 5 ready to execute)
- **Status:** Phase 5 planned 2026-04-30 — 6 plans (05-01 lifecycle, 05-02 correlator+send, 05-03 controlId, 05-04 reconnect, 05-05 backpressure+dead-peer, 05-06 starter+stats) using shared hook anchors (ack-matched / state-change / ack-payload) for clean cross-plan extension. 22 CLIENT/OBS/ERR REQ-IDs covered. Ready for `/gsd-execute-phase 5`

```
[##########          ] 50 %   (4 / 8 phases shipped)
```

## Phase Summary

| # | Phase | REQs | Plans | Status |
|---|-------|-----:|------:|--------|
| 1 | Project Foundation | 7 | 5 | Complete 2026-04-24 |
| 2 | Framing Codec & Warnings | 21 | 4 | Complete 2026-04-24 |
| 3 | Transport, Connection FSM & Observability | 14 | 5 | Complete 2026-04-24 |
| 4 | MLLP Server | 13 | 5 | Complete 2026-04-24 |
| 5 | MLLP Client | 22 | 6 | Pending |
| 6 | ACK Helpers & TLS | 10 | 4 | Pending |
| 7 | Testing, Fixtures & Coverage | 7 | 4 | Pending |
| 8 | Examples, README & Publish | 7 | 3 | Pending |
| **Total** | | **101** | **36** | |

## Key Decisions Log

**2026-04-22 — Research-phase acceptance (post-init)**

- Accepted all 28 new REQ-IDs, 10 amendments, and Phase 6 plan-split from `.planning/research/SUMMARY.md`.
- Bumped Node floor 18 → 20 (SETUP-05 amendment); Node 18 EOL 2025-04-30.
- Expanded FSM from 4 → 6 states: added `RECONNECTING` (hosts auto-reconnect backoff) and `CLOSED` (terminal, distinct from transient `DISCONNECTED`).
- Added `createStarterServer` / `createStarterClient` helpers (SERVER-08 / CLIENT-10) to make the "three lines" north-star literally true.
- Added new **OBS** observability category with `getStats()` on client, server, and per-connection.
- Added `AbortSignal` + `Symbol.asyncDispose` + frozen event payloads across client and server (2026 Node baseline).
- Added `maxFrameSizeBytes` cap (FRAME-11) with `MLLP_FRAME_TOO_LARGE` warning code — DoS prevention.
- Split Phase 6 from 3 → 4 plans exposing parallelism (ACK builders need only Phase 2; TlsTransport needs only Phase 3).

**2026-04-30 — Phase 5 context (advisor mode, full_maturity tier)**

- D-03/A1: Unified `Map<key, PendingAck>` correlator with ES2015 insertion-order iteration; FIFO uses synthetic monotonic seq, controlId uses MSH-10. `pipeline:false` = `maxInFlight=1` guard on same store. ioredis/redis-py prior art.
- D-08/A2: Hybrid asymmetric in-flight reconnect rule. controlId mode resends in-flight (idempotent via MSH-10); FIFO mode rejects in-flight with NEW stable cause `'in-flight-orphan'` (distinct from queued's existing `'fifo-unsafe'`). Adds one new public-API cause code.
- D-11/A3: Mirror Phase 4 server's two-independent-options approach for dead-peer detection (`keepaliveIntervalMs` for TCP keepalive, `deadPeerTimeoutMs` for app-idle keyed on bytes/ACK received). FSM honors `autoReconnect` on trip; error phase `'receive'` matches server symmetry.
- D-15/A4: Rich `RetryContext` object signature for `retryStrategy` hook with `{attempt, lastError, lastDelayMs, totalElapsedMs, sinceLastSuccessMs, classifiedAs, signal}`. Composition A — CLIENT-18 classifier runs FIRST; hook only sees transient errors by default. `null`-return → terminal CLOSED. `ctx.signal: AbortSignal` from day one.

**2026-04-24 — Phase 3 gap closure (03-05)**

- CR-01: `ReconnectingEvent.connectionId` is the required field; `attempt` and `delayMs` are optional (Phase 5 will populate). Interface now matches runtime emission.
- WR-01/WR-02: Both CONNECTING and RECONNECTING route to CLOSED (terminal) on unexpected peer close or transport error — not DISCONNECTED, which has no incoming edge from these states in LEGAL_TRANSITIONS.
- WR-03: `_drainPromise` field caches in-flight drain; second concurrent `close()` call joins existing promise without invoking `beforeClose` a second time.
- 230 tests passing, 0 TypeScript errors after gap closure; Phase 4 unblocked.

## Deviations Log

(Plan-level deviations captured during execution land here.)
