# @cosyte/hl7-mllp — Project Guide for Claude

This repo is managed with the **GSD (Get Shit Done)** workflow. Planning artifacts live in `.planning/` and are committed with the code.

## Project

**`@cosyte/hl7-mllp`** — a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.

See `.planning/PROJECT.md` for full context, requirements, constraints, and key decisions.

## Status

- **Phase 0 — Initialized (research-revised 2026-04-22).** Next: `/gsd-plan-phase 1`
- Roadmap: 8 phases, **101** v1 REQ-IDs mapped, ~33 plans → see `.planning/ROADMAP.md`
- Sibling package: `@cosyte/hl7` at `../hl7-parser` (peer dep, not runtime dep)
- Research synthesis: `.planning/research/SUMMARY.md` (single source of truth for the post-research deltas)

## GSD Workflow

**Config** (`.planning/config.json`):

- Mode: `yolo` (auto-approve plans/execution)
- Granularity: `standard` (5–8 phases, 3–5 plans each)
- Parallelization: enabled
- Plan Check + Verifier + Nyquist Validation: enabled
- Commit docs: yes

**Typical phase loop:**

1. `/gsd-plan-phase N` — decompose phase into plans (with plan-check agent)
2. `/gsd-execute-phase N` — execute plans in parallel where possible, atomic commits
3. `/gsd-verify-work N` — verifier confirms deliverables match phase goal
4. `/gsd-validate-phase N` — Nyquist validation audits test coverage
5. `/gsd-transition` — update PROJECT.md, advance state

**Commands most likely needed:**

- `/gsd-progress` — status + routing
- `/gsd-next` — auto-advance to next logical step
- `/gsd-plan-phase N` — plan a specific phase
- `/gsd-execute-phase N` — execute a planned phase
- `/gsd-discuss-phase N --auto` — clarify context before planning

## Tech Stack (locked)

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Target:** ES2022, dual ESM + CJS via `tsup`
- **Node:** **20+** (`engines.node >=20.0.0`; Node 18 EOL 2025-04-30)
- **Package manager:** pnpm
- **Testing:** Vitest + `@vitest/coverage-v8` with per-directory 90% gates on `src/framing|server|client`
- **Linting:** ESLint + Prettier
- **Runtime deps:** **Zero.** Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`).
- **Peer deps:** `@cosyte/hl7` as an **optional** peer dep, referenced only from the `@cosyte/hl7-mllp/ack-from-hl7` subpath (tsup `external`).
- **TLS test certs:** generated at `pretest` via `selfsigned` into gitignored `examples/tls/certs/`; never committed.
- **Benchmarking (local only):** `mitata`; not a CI gate.
- **CI matrix:** Ubuntu / macOS / Windows × Node 20 / 22 / 24 for the test job; Ubuntu-only for lint / typecheck / coverage. `@arethetypeswrong/cli` is a publish-gate.
- **License:** MIT

## Engineering Guardrails

- No `any`. No unjustified `as` casts. Use `unknown` and narrow.
- JSDoc (with `@example`) on every public export — feeds IntelliSense.
- **Buffer-first API** on every public surface — never string. HL7 v2 payloads are raw bytes with caller-managed charset decoding.
- **`Buffer.prototype.slice()` is forbidden** in `src/framing|server|client` (enforced by the SETUP-07 ESLint rule). Use `.subarray()` — `.slice()` copies in modern Node.
- **Postel's Law:** decoder is liberal (tolerance opt-ins + warnings with stable codes + byte offsets), encoder is strict (always emits canonical `VT + payload + FS + CR`).
- **Stable warning codes** are a public API. Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT` (11 total).
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.
- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances — log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % on `src/framing/`, `src/server/`, `src/client/`.
- **In-memory transport is a first-class deliverable** (`@cosyte/hl7-mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.

## Key Files

- `.planning/PROJECT.md` — vision, requirements, constraints, decisions
- `.planning/REQUIREMENTS.md` — **101** v1 REQ-IDs with phase traceability
- `.planning/ROADMAP.md` — 8-phase breakdown with success criteria (~33 plans)
- `.planning/STATE.md` — current state (what's next)
- `.planning/research/SUMMARY.md` — consolidated research synthesis (accepted actions)
- `.planning/research/{STACK,FEATURES,ARCHITECTURE,PITFALLS}.md` — source research
- `.planning/config.json` — GSD workflow settings

When in doubt, read `.planning/ROADMAP.md` first to understand the phase structure and which phase a change belongs to.
