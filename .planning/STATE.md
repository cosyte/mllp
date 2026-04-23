---
gsd_state_version: 1.0
milestone: v1
milestone_name: milestone
status: "v1 milestone initialized 2026-04-22; research-revised same day — 4 parallel researchers (STACK/FEATURES/ARCHITECTURE/PITFALLS) + synthesizer landed SUMMARY.md with 28 new REQ-IDs + 10 amendments, all accepted. 8 phases, 101 v1 REQ-IDs, ~33 plans. Node floor bumped 18 → 20. Phase 6 split 3→4 plans. New OBS observability category. Next: /gsd-plan-phase 1 (Project Foundation)."
last_updated: "2026-04-22T00:00:00Z"
progress:
  total_phases: 8
  completed_phases: 0
  total_plans: 33
  completed_plans: 0
  percent: 0
---

# @cosyte/hl7-mllp — STATE

Project memory for session-to-session continuity. Updated at phase/plan boundaries.

---

## Project Reference

- **Name:** `@cosyte/hl7-mllp`
- **Core value:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.
- **Current focus:** v1 milestone initialized 2026-04-22; research-phase revision applied same day (73 → 101 REQ-IDs, ~30 → ~33 plans, 4-state → 6-state FSM, Node 18 → Node 20). Nothing built yet. Next step is Phase 1 (Project Foundation) — scaffold pnpm + tsup dual-build (3 subpath entries) + strict TypeScript + Vitest + ESLint (incl. SETUP-07 no-`.slice()` rule) + CI on 3×3 OS × Node matrix.
- **Workflow config:** standard granularity, yolo mode, parallelization enabled, plan-check + verifier + Nyquist validation on, auto-advance on, commit_docs on, research off-by-default (but invoked on-demand for this milestone).
- **Sibling package:** `@cosyte/hl7` (at `../hl7-parser`) — peer dep, not runtime dep. ACK-helper subpath `@cosyte/hl7-mllp/ack-from-hl7` is the only module that references it.

## Current Position

Phase: 0 (pre-phase) — scaffolding artifacts and research synthesis both landed.
Next Step: Run `/clear` then `/gsd-plan-phase 1` to start Phase 1 (Project Foundation).

- **Milestone:** v1 (initial release — transport-only MLLP client + server)
- **Phase:** none in-flight
- **Plans (milestone total):** 0 / ~33 complete
- **Status:** bootstrap + research-revision complete; planning starts at Phase 1

```
[                    ] 0 %   (0 / 8 phases shipped)
```

## Phase Summary

| # | Phase | REQs | Plans | Status |
|---|-------|-----:|------:|--------|
| 1 | Project Foundation | 7 | 4 | Pending |
| 2 | Framing Codec & Warnings | 21 | 4 | Pending |
| 3 | Transport, Connection FSM & Observability | 14 | 4 | Pending |
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

## Deviations Log

(Plan-level deviations captured during execution land here.)
