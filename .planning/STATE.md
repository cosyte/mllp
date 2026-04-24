---
gsd_state_version: 1.0
milestone: v1.0
milestone_name: milestone
status: Phase 3 complete 2026-04-24 — 5 plans executed, all gaps closed. Ready to execute Phase 4 (MLLP Server).
last_updated: "2026-04-24T17:43:00.000Z"
progress:
  total_phases: 8
  completed_phases: 3
  total_plans: 35
  completed_plans: 14
  percent: 37
---

# @cosyte/hl7-mllp — STATE

Project memory for session-to-session continuity. Updated at phase/plan boundaries.

---

## Project Reference

- **Name:** `@cosyte/hl7-mllp`
- **Core value:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.
- **Current focus:** Phase 4 (MLLP Server) — `createServer`, `listen`, per-connection message emission as `Buffer`, auto-ACK / manual-ACK, graceful shutdown, idle keepalive, `createStarterServer`, `AbortSignal` + `Symbol.asyncDispose`, frozen event payloads, server-level framing tolerance opts, `server.getStats()`.
- **Workflow config:** standard granularity, yolo mode, parallelization enabled, plan-check + verifier + Nyquist validation on, auto-advance on, commit_docs on, research off-by-default (but invoked on-demand for this milestone).
- **Sibling package:** `@cosyte/hl7` (at `../hl7-parser`) — peer dep, not runtime dep. ACK-helper subpath `@cosyte/hl7-mllp/ack-from-hl7` is the only module that references it.

## Current Position

Phase: 3 complete 2026-04-24 — all 5 plans executed, all gaps closed.
Next Step: `/gsd-discuss-phase 4` (no CONTEXT.md yet for Phase 4)
Resume file: None

- **Milestone:** v1 (initial release — transport-only MLLP client + server)
- **Phase:** 3 complete — Transport, Connection FSM, InMemoryTransport, getStats(), close/destroy, gap closure (CR-01/WR-01/WR-02/WR-03)
- **Plans (milestone total):** 14 / ~35 complete
- **Status:** Phase 3 complete 2026-04-24 — 230 tests, 0 TS errors, all 14 REQ-IDs delivered

```
[#####               ] 37 %   (3 / 8 phases shipped)
```

## Phase Summary

| # | Phase | REQs | Plans | Status |
|---|-------|-----:|------:|--------|
| 1 | Project Foundation | 7 | 5 | Complete 2026-04-24 |
| 2 | Framing Codec & Warnings | 21 | 4 | Complete 2026-04-24 |
| 3 | Transport, Connection FSM & Observability | 14 | 5 | Complete 2026-04-24 |
| 4 | MLLP Server | 13 | 4 | Pending |
| 5 | MLLP Client | 22 | 6 | Pending |
| 6 | ACK Helpers & TLS | 10 | 4 | Pending |
| 7 | Testing, Fixtures & Coverage | 7 | 4 | Pending |
| 8 | Examples, README & Publish | 7 | 3 | Pending |
| **Total** | | **101** | **33** | |

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

**2026-04-24 — Phase 3 gap closure (03-05)**

- CR-01: `ReconnectingEvent.connectionId` is the required field; `attempt` and `delayMs` are optional (Phase 5 will populate). Interface now matches runtime emission.
- WR-01/WR-02: Both CONNECTING and RECONNECTING route to CLOSED (terminal) on unexpected peer close or transport error — not DISCONNECTED, which has no incoming edge from these states in LEGAL_TRANSITIONS.
- WR-03: `_drainPromise` field caches in-flight drain; second concurrent `close()` call joins existing promise without invoking `beforeClose` a second time.
- 230 tests passing, 0 TypeScript errors after gap closure; Phase 4 unblocked.

## Deviations Log

(Plan-level deviations captured during execution land here.)
