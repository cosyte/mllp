# @cosyte/hl7-mllp

## What This Is

An open-source, developer-focused MLLP (Minimal Lower Layer Protocol) client and server for Node.js and TypeScript, published under the Cosyte brand. It is the transport-layer sibling to `@cosyte/hl7` (the parser): this package owns the wire, not the message. A developer can stand up an MLLP listener or client in three lines and trust that framing, ACK round-trips, reconnects, backpressure, and TLS are handled correctly under load and under flaky real-world networks — without reading the MLLP spec or Chapter 2 of HL7 v2.

The package is both a credibility asset for Cosyte's healthcare integration practice and a production tool used internally on client projects. Together with `@cosyte/hl7` it forms a complete, audit-friendly HL7 v2 toolkit — parser and transport as composable peers, not a monolith.

## Core Value

**A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.** Everything else (framing tolerance, warning codes, TLS, in-memory transport, graceful shutdown) exists to support that north star.

## Requirements

### Validated

**Phase 1 — Project Foundation (2026-04-24):** SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06, SETUP-07 — all satisfied. Toolchain scaffold (dual ESM+CJS build, strict TypeScript, ESLint flat-config with no-buffer-slice rule, Vitest 90% gates, 3×3 CI matrix, TLS cert-gen script) verified green on a clean clone.

**Phase 3 — Transport, Connection FSM & Observability (2026-04-24):** TRANS-01, TRANS-02, TRANS-03, TRANS-04, LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, WARN-10, OBS-03, OBS-04, OBS-05, ERR-03 — all satisfied. Transport interface + NetTransport + InMemoryTransport delivered; 6-state FSM (CONNECTING/CONNECTED/DRAINING/RECONNECTING/DISCONNECTED/CLOSED) with correct terminal-state routing; connection.getStats() + MllpConnectionError; 230 tests, 0 TS errors. Gap-closure plan fixed CR-01 (ReconnectingEvent interface), WR-01/WR-02 (FSM dead-state transitions), WR-03 (drain idempotency).

### Active

See `REQUIREMENTS.md` for the full categorized list with REQ-IDs.

**Top-level capabilities:**

- [ ] Canonical VT (0x0B) + payload + FS (0x1C) + CR (0x0D) framing on emit, always _(FRAME-01..03)_
- [ ] Partial-read assembly across arbitrary TCP chunk boundaries with bounded `maxFrameSizeBytes` _(FRAME-04..06, FRAME-11)_
- [ ] Opt-in tolerance for common framing deviations (FS-only, FS+LF, missing leading VT, embedded VT/FS) with stable warning codes _(FRAME-07..10, WARN-01..10)_
- [ ] MLLP server: listen, accept, emit framed messages as `Buffer`, graceful shutdown, `createStarterServer` for three-line setup _(SERVER-01..12)_
- [ ] MLLP client: connect, send, await ACK with timeout, auto-reconnect (transient/permanent classification, custom `retryStrategy`), count+byte backpressure, `pipeline: false` mode, `createStarterClient` for three-line setup _(CLIENT-01..19)_
- [ ] Explicit, inspectable 6-state connection machine (`CONNECTING` / `CONNECTED` / `DRAINING` / `RECONNECTING` / `DISCONNECTED` / `CLOSED`) with lifecycle events incl. `drain` / `reconnecting` / `close` _(LIFE-01..05)_
- [ ] `AbortSignal` on every awaitable, `Symbol.asyncDispose` on client + server, frozen event payloads _(CLIENT-11/13/14, SERVER-09/10/11)_
- [ ] ACK helpers: build `AA` / `AE` / `AR` from a parsed inbound message or a plain-object MSH descriptor, plus raw pass-through _(ACK-01..05)_
- [ ] TLS support for both client and server (including SNI default, mTLS) _(TLS-01..05)_
- [ ] In-memory transport adapter for deterministic, socket-free tests _(TRANS-01..04)_
- [ ] Observability surface — `client.getStats()` / `server.getStats()` / `connection.getStats()` returning JSON-serializable state for 3 AM debugging _(OBS-01..05)_
- [ ] Typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) with stable codes _(ERR-01..04)_
- [ ] Zero runtime dependencies; `@cosyte/hl7` is a peer dep, not a hard dep _(SETUP-02/03)_
- [ ] ≥ 90% line coverage on `src/framing/`, `src/server/`, `src/client/` _(TEST-01)_
- [ ] Three runnable examples + comprehensive README with "Three lines" quickstart + anti-feature alternatives table _(DOCS-01..07)_

### Out of Scope (v1)

- **HL7 v2 message parsing / serialization** — delegate to `@cosyte/hl7` (peer dep) or any other parser; this package is transport-only.
- **HL7 v3 / CDA / FHIR transports** — different protocols entirely.
- **File-based ingestion (FHS/BHS disk batches)** — not a transport concern.
- **Persistent message queue / store-and-forward** — that is an integration engine, not MLLP.
- **Routing, fan-out, transformation** — out of scope; compose with a higher-level framework.
- **HTTP-based HL7** — rare; roadmap item if demand emerges.
- **Built-in metrics/observability backend** — expose event hooks; caller wires their own.

## Context

- **Sibling package:** `@cosyte/hl7` (at `../hl7-parser`) ships the parser, model, helpers, and profile system. This package is deliberately transport-only and loosely coupled — users can combine the two, use this with any other parser, or use it with no parser at all (Buffers in, Buffers out).
- **MLLP is dead-simple on paper, consistently misimplemented in practice.** Most off-the-shelf Node MLLP libraries leak raw bytes across message boundaries, silently swallow partial reads, or hardcode delimiter tolerance without exposing warnings. The credibility bar is: get framing exactly right, handle every real-world edge case (partial reads, embedded VT/FS, half-open sockets, ACK timeouts, TLS, backpressure), and stay small enough to audit in an afternoon.
- **Postel's Law is the operating principle.** The decoder is liberal (accepts FS-only, FS+LF, missing VT, with warnings); the encoder is strict (always emits canonical VT…FS+CR). Tolerance is opt-in per deviation so silent bug-shaped behavior never ships.
- **Buffer-first API, not string.** HL7 v2 is nominally ASCII but real messages declare charsets in MSH-18 and carry latin-1 / UTF-8 / CP1252 bytes. Decoding is the caller's job — this package never touches the payload beyond framing.
- **Dogfooding:** Cosyte uses this internally on client integrations, so production hardening isn't theoretical — the library's credibility matches the company's.
- **License choice:** MIT, to maximize adoption. This is a library, not a product.

## Constraints

- **Language:** TypeScript strict (`"strict": true`, `"noUncheckedIndexedAccess": true`). No `any`, no unjustified `as` casts.
- **Target:** ES2022, dual package (ESM + CJS) via `tsup`. **Node 20+** (`engines.node": ">=20.0.0"`; Node 18 is EOL since 2025-04-30).
- **Runtime deps:** Zero. Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`). Dev deps (Vitest, TypeScript, linters, `selfsigned` for TLS-test-cert generation, `mitata` for local benchmarks) fine.
- **CI:** 3×3 matrix — Ubuntu / macOS / Windows × Node 20 / 22 / 24 for the test job. Lint / typecheck / coverage run on Ubuntu only.
- **Peer deps:** `@cosyte/hl7` is a **peer dep**, not a runtime dep. The ACK-helper code path is allowed to reference `@cosyte/hl7` types but must fail gracefully when the peer is not installed, or be isolated behind a subpath import the caller opts into.
- **Package manager:** pnpm. Package name: `@cosyte/hl7-mllp`. License: MIT.
- **Test coverage:** ≥ 90% line coverage on `src/framing/`, `src/server/`, `src/client/`.
- **Performance expectation:** Framing encoder/decoder handles a 50-segment message in < 1 ms on a modern laptop; server sustains ≥ 1,000 messages/sec on localhost loopback in the in-memory benchmark (documented, not a CI gate).
- **No console logging in library code.** Throw typed errors or emit warning events with stable codes and positional context.
- **Immutable warning objects.** Every warning carries `{ code, message, byteOffset, connectionId, timestamp }` and is frozen on emission.
- **No hidden state.** The connection state machine is the only source of truth for "are we connected?" — never infer from socket properties directly in the public API.

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| Buffer-first public API (never string) | HL7 v2 is technically ASCII but real payloads carry MSH-18 charset declarations and mixed latin-1 / UTF-8 / CP1252 bytes. Decoding the payload is the caller's job; forcing a string API would corrupt bytes silently. | — Pending |
| Postel's Law: liberal decoder, strict encoder | The encoder always emits canonical `VT + payload + FS + CR`. The decoder accepts common deviations (FS-only, FS+LF, missing VT, leading whitespace) but every deviation surfaces as a warning with a stable code. Prevents quirks from propagating downstream. | — Pending |
| Framing tolerance is opt-in per deviation | A lenient default is pragmatic, but silent-by-default is a bug magnet. Each tolerance (`allowFsOnly`, `allowLeadingWhitespace`, etc.) is a boolean on the reader/writer options, and every tolerated deviation emits a warning regardless of opt-in. | — Pending |
| Stable warning codes with byte offsets | Developers need to programmatically react to specific deviations (e.g., fail over to a different upstream, log a ticket, alert). Human-readable messages alone are not enough. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_EMPTY_PAYLOAD`. | — Pending |
| Explicit connection state machine, not socket flags | Node's `net.Socket` has half-open states, `writable`/`readable` flags that drift, and no built-in concept of "draining in-flight ACKs before close." We expose a **6-state FSM** (`CONNECTING` / `CONNECTED` / `DRAINING` / `RECONNECTING` / `DISCONNECTED` / `CLOSED`) with transition events. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal and distinct from the transient `DISCONNECTED` — an ioredis-shaped distinction that prevents "is this down forever?" ambiguity for callers. | — Pending |
| `@cosyte/hl7` is a peer dep, not a runtime dep | A developer using a different parser (or no parser) must not pay the dependency cost. ACK-helper code that needs parsed MSH fields is behind a subpath import `@cosyte/hl7-mllp/ack-from-hl7` that the caller opts into. | — Pending |
| ACK construction is a helper, not a requirement | Integration engines often build ACKs with their own controlId / processingId / segment structures. The primary send/receive path accepts and returns raw `Buffer`s; `buildAckAA(msg)` / `buildAckAE(msg, err)` / `buildAckAR(msg, err)` are optional utilities. | — Pending |
| In-memory transport is a first-class deliverable | Socket-based tests are slow, flaky in CI, and hard to reason about at scale. `InMemoryTransport` implements the same interface `net.Socket` does for our purposes and lets test suites drive both sides deterministically in a single process. | — Pending |
| Auto-reconnect uses exponential backoff with jitter, bounded | Tight-loop reconnects hammer struggling servers. Defaults: `initialDelayMs: 100`, `maxDelayMs: 30_000`, `multiplier: 2`, `jitter: 0.2`. Configurable and cancellable. | — Pending |
| Backpressure respects `socket.write()` return value | When `write()` returns `false`, the client queues subsequent sends up to a configurable high-water mark (default: 64 in-flight messages). Overflow either rejects the `send()` promise with `MllpBackpressureError` or blocks, based on an option. | — Pending |
| Zero runtime dependencies | Healthcare integrations are vetted carefully; every dep is a supply-chain concern. Also forces clean implementation against Node stdlib only. | — Pending |
| Bounded frame size (`maxFrameSizeBytes`, default 16 MB) | An unbounded accumulator is a DoS vector — a hostile peer can trickle bytes forever. Every production MLLP implementation needs a cap; we make it an explicit option with a named code (`MLLP_FRAME_TOO_LARGE`). | — Pending |
| `createStarterServer` / `createStarterClient` helpers | The "three lines" north star requires all defaults (auto-ACK `AA`, 30 s drain, auto-reconnect with exponential backoff, FIFO ACK, `Symbol.asyncDispose`, opt-in SIGTERM) to live in helpers — not pushed onto the caller. The helpers are thin wrappers over `createServer` / `createClient`; advanced users compose the primitives directly. | — Pending |
| `AbortSignal` on every awaitable, `Symbol.asyncDispose` on client + server | 2026 Node baseline — `fetch`, `undici`, `setTimeout`, `stream/promises` all accept `AbortSignal`; `await using` is TC39-stable and supported by Node 22+. Not shipping them now would be a v2-break we can avoid. | — Pending |
| First-class observability surface (`getStats()`) | Operators debug MLLP integrations at 3 AM. If the library does not expose `queueDepth`, `inFlight`, `warningsByCode`, byte counters, and `reconnectAttempts` without instrumentation, every user reinvents it. Exposed on client, server, and per-connection; JSON-serializable so it drops into log pipelines. | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-04-24 — Phase 3 complete (Transport, Connection FSM & Observability). 14/14 must-haves verified. Phase 4 (MLLP Server) is next.*
