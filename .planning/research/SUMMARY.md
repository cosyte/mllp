# Research Synthesis — `@cosyte/hl7-mllp`

**Project:** `@cosyte/hl7-mllp` — Node.js MLLP client + server, transport-only sibling to `@cosyte/hl7`
**Synthesized:** 2026-04-22
**Input files:** `STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md` (all at `.planning/research/`)
**Baseline under review:** 73 REQ-IDs / 8 phases / ~30 plans in `REQUIREMENTS.md` + `ROADMAP.md`

This is the single reviewer-facing artifact. It is the deduplicated action list across the four parallel research dimensions. Approving this document unblocks a one-shot revision of `REQUIREMENTS.md` and `ROADMAP.md`.

---

## 1. TL;DR

- **Headline decision (scope):** Do we ship the `createStarterServer` + `createStarterClient` helpers (FEATURES proposal, new SERVER-08 / CLIENT-10)? They are the only way the PROJECT.md "three lines of code" north star is literally true; without them the north star stays aspirational. **Everything else is downstream of this call.**
- **Research materially improves the spec.** The four dimensions collectively propose **28 net-new REQ-IDs** and **10 amendments** across 8 existing phases, closing real DoS, correctness, and DX gaps without invalidating a single existing REQ-ID. Biggest single surface: a new **observability category (OBS-01..05)** and a **6-state FSM** (up from 4).
- **One Phase-1-blocking change:** `SETUP-05` must bump from "Node 18+" to "Node 20+". Node 18 is EOL (2025-04-30) and Node 20 reaches EOL 2026-04-30 (8 days after this research date). Shipping a healthcare TLS library advertising an EOL runtime is a no-go.
- **One phase split:** ARCHITECTURE recommends splitting **Phase 6** (ACK + TLS, currently 3 plans) into **4 plans** — plain-object ACK builders (needs only Phase 2), peer-dep adapter, TlsTransport class (needs only Phase 3), and integration. Current bundling understates parallelism.
- **Zero deletions, zero demotions.** Every one of the 73 existing REQ-IDs survives all four audits. The audit is purely additive/tightening.

---

## 2. Key Findings by Dimension

### STACK (confidence: HIGH)
Core tooling is locked by mirroring `@cosyte/hl7` at `../hl7-parser` — intentional, avoids a second tooling surface for the org. The MLLP-specific deltas are: (1) **drop Node 18** from `engines` and the CI matrix (EOL), target Node 20/22/24; (2) expand CI to **3×3 Linux/macOS/Windows × Node 20/22/24** because `net`/`tls` has real cross-OS edge cases (Windows half-close, macOS keepalive defaults, IPv6 dual-stack); (3) add exactly two MLLP-specific devDeps — **`selfsigned@^6.0.0`** (pure-JS TLS cert generation at `pretest` time, gitignored) and **`mitata@^0.1.x`** (benchmarking, not in CI). Every existing npm MLLP library is either abandoned (`mllp-node` 2018, `@keepsolutions/mllp-node` 2020) or a monolithic parser+transport (`node-hl7-server`, `hl7v2-net`) — none meet SETUP-03 and none share our parser/transport split. Confirms "build, don't depend."

### FEATURES (confidence: HIGH on surface, MEDIUM on download numbers)
Every table-stakes feature is already covered by the 73 v1 REQ-IDs. The audit surfaces **two DX gaps that are 2026 table stakes**: `AbortSignal` on all async methods (matches `undici` / `fetch` / `setTimeout`) and `Symbol.asyncDispose` (`await using`). The competitive minimum-viable server quickstart is **11 lines** (`node-hl7-server`); the PROJECT.md "three lines" claim only becomes honest with starter helpers. 12 new REQ-IDs proposed, predominantly in Phase 4 (Server) and Phase 5 (Client).

### ARCHITECTURE (confidence: HIGH)
The proposed layering (`framing/` → `transport/` → `connection/` → `server/` + `client/` → `ack-from-hl7/` + `testing/`) matches `ws`, `mysql2`, `ioredis`, `undici` exactly. Three structural changes: (1) **Split `connection/` out of `transport/`** — Connection owns the FSM, Transport is the byte carrier; (2) **Expand the FSM from 4 → 6 states** by adding `RECONNECTING` (so auto-reconnect backoff has a home distinct from `DISCONNECTED`) and `CLOSED` (terminal, distinct from transient `DISCONNECTED`) — mirrors ioredis's `close` vs `end`; (3) Add **`maxFrameSizeBytes` cap** (default 16 MB) on `FrameReader` — currently unbounded, a DoS vector. Phase 6 should split into 4 plans.

### PITFALLS (confidence: HIGH)
30 named pitfalls with concrete bug citations. The 73 existing REQ-IDs cover most critical surface but have blind spots in three clusters: **ACK correlation robustness** (unmatched / late / post-reconnect ACKs under-specified), **reconnect classification** (no distinction between transient `ECONNRESET` and permanent `ENOTFOUND` / bad cert — tight-loop risk), and **observability at 3 AM** (no `getStats()` surface). Proposes a new `OBS-*` category, a TLS SNI default, a framing-tolerance opt-in on the server ingress, and three tightening amendments to existing REQs.

---

## 3. Consolidated Action List

Legend — **Source**: `S` = STACK, `F` = FEATURES, `A` = ARCHITECTURE, `P` = PITFALLS. **Rec**: Accept / Amend / Defer(v2) / Reject.

### 3.1 New REQ-IDs (collision-resolved numbering)

| # | REQ-ID | Category | Phase | Behavior (one line) | Rationale | Source | Rec |
|---|--------|----------|-------|---------------------|-----------|--------|-----|
| 1 | **FRAME-11** | FRAME | 2 | `FrameReader` enforces `maxFrameSizeBytes` (default 16 MB); overflow throws `MllpFramingError('MLLP_FRAME_TOO_LARGE')`. | DoS prevention; accumulator currently unbounded. | A | Accept |
| 2 | **FRAME-12** | FRAME | 7 | Bytes-in/bytes-out round-trip guarantee: every byte value 0x00–0xFF plus 1 MB random corpus passes untouched. | Proves buffer-first promise at the test level. | P | Accept |
| 3 | **WARN-09** | WARN | 2 | `MLLP_FRAME_TOO_LARGE` added to exported `WarningCode` union. | Paired with FRAME-11. | A | Accept |
| 4 | **WARN-10** | WARN | 3 | Each `Connection` exposes its own `onWarning(fn)` + `warnings` snapshot; server/client `onWarning` stays as aggregate stream. | Per-connection attribution for a server with many peers. | F | Accept |
| 5 | **SETUP-07** | SETUP | 1 | ESLint rule forbids `Buffer.prototype.slice()` in `src/framing/`, `src/server/`, `src/client/`; must use `.subarray()`. | Catches the pitfall at lint time; 3-line rule. | P | Accept |
| 6 | **SERVER-08** | SERVER | 4 | `createStarterServer({ port, onMessage, host?, tls?, autoAck? })` — auto-ACK `AA`, 30 s drain, `Symbol.asyncDispose`, opt-in SIGTERM handler. | Makes the "three lines" north-star literally true. **Headline decision.** | F | Accept |
| 7 | **SERVER-09** | SERVER | 4 | `listen()` / `close()` accept `{ signal?: AbortSignal }`. | 2026 Node baseline. | F | Accept |
| 8 | **SERVER-10** | SERVER | 4 | Event payloads (`message`, `error`, `connection`, `stateChange`, `disconnect`) are `Object.freeze()`'d. | Consistency with WARN-01; prevents subscriber cross-mutation. | F | Accept |
| 9 | **SERVER-11** | SERVER | 4 | `server[Symbol.asyncDispose]()` delegates to `close()`. | 2026 idiom; trivial. | F | Accept |
| 10 | **SERVER-12** | SERVER | 4 | `createServer({ framing: FrameReaderOptions })` exposes tolerance opt-ins server-side; default permissive-with-warnings, `strict: true` rejects. | Real-world devices emit non-canonical frames. | P | Accept |
| 11 | **CLIENT-10** | CLIENT | 5 | `createStarterClient({ host, port, tls? })` — auto-reconnect on, 30 s ACK timeout, FIFO correlation, `Symbol.asyncDispose`. | Mirror of SERVER-08. | F | Accept |
| 12 | **CLIENT-11** | CLIENT | 5 | `connect()`, `send()`, `close()` accept `{ signal?: AbortSignal }`; abort rejects with `AbortError`. | 2026 Node baseline. Also flagged by STACK. | F, S | Accept |
| 13 | **CLIENT-12** | CLIENT | 5 | `{ retryStrategy?: (attempt) => number \| null }` overrides default backoff; `null` halts reconnect. | Matches `ioredis`; enables circuit-breaker integration. | F | Accept |
| 14 | **CLIENT-13** | CLIENT | 5 | Client event payloads (`message`, `ack`, `error`, `stateChange`, `disconnect`, `reconnecting`) are frozen. | Mirror of SERVER-10. | F | Accept |
| 15 | **CLIENT-14** | CLIENT | 5 | `client[Symbol.asyncDispose]()` delegates to `close()`. | Mirror of SERVER-11. | F | Accept |
| 16 | **CLIENT-15** | CLIENT | 5 | Under `correlateByControlId`, unknown inbound MSA-2 → `onError(MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID'))`; no send resolves/rejects; pending sends wait their own timeout. | Closes specified-but-undefined edge in CLIENT-03. | P | Accept |
| 17 | **CLIENT-16** | CLIENT | 5 | Late-arriving ACK after its `send()` timed out emits `MLLP_ACK_AFTER_TIMEOUT` warning with elapsed-since-send. | Operational forensics. | P | Accept |
| 18 | **CLIENT-17** | CLIENT | 5 | Queued sends across reconnect: re-transmitted only in `correlateByControlId` mode; FIFO mode rejects with `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })`. | FIFO cannot be safely resumed — different server state = ACK ambiguity. | P | Accept |
| 19 | **CLIENT-18** | CLIENT | 5 | Transient vs permanent error classification; permanent (`ENOTFOUND`, TLS cert errors, `EACCES`) halts auto-reconnect; `isTransientConnectionError(err)` exported. | Prevents tight-loop reconnect against permanent failure. | P | Accept |
| 20 | **CLIENT-19** | CLIENT | 5 | `{ pipeline: false }` enforces strict send → await-ACK → send serialization for BizTalk-style peers. | Real-world peer requirement; default preserves current behavior. | P | Accept |
| 21 | **TLS-05** | TLS | 6 | `tls.servername` defaults to `tls.host` when unset; refuses to connect if neither is resolvable. | Prevents wrong-tenant-cert bugs against SNI-multiplexed peers. | P | Accept |
| 22 | **OBS-01** | **OBS (new)** | 5 | `client.getStats()` → `{ state, connectionId, queueDepth, inFlight, warningsByCode, bytesIn/Out, lastByte*At, reconnectAttempts }`. | Enables 3 AM debugging. | P | Accept |
| 23 | **OBS-02** | **OBS (new)** | 4 | `server.getStats()` → `{ listening, connections, totalBytesIn/Out, activeConnectionCount }`. | Server-side equivalent. | P | Accept |
| 24 | **OBS-03** | **OBS (new)** | 3 | `Connection.getStats()` → `{ state, connectionId, remoteAddress, remotePort, warningsByCode, bytesIn/Out, lastByte*At, connectedAt }`. | Per-connection; the unit of observation. | P | Accept |
| 25 | **OBS-04** | **OBS (new)** | 3 | All `getStats()` return JSON-serializable plain objects (no Buffers, no class instances). | `JSON.stringify(stats)` required by log pipelines. | P | Accept |
| 26 | **OBS-05** | **OBS (new)** | 3 | Per-connection warning array capped at 100 most-recent with `warningsTruncated: boolean`; `warningsByCode` retains full counts. | Prevents unbounded memory growth on noisy peers. | P | Accept |
| 27 | **DOCS-06** | DOCS | 8 | README "What this package does not do" table maps each anti-feature to a recommended alternative (parser → `@cosyte/hl7`; integration → Mirth; FHIR → fhir-kit-client; queue → BullMQ). | Reduces drive-by issues for years. | F | Accept |
| 28 | **DOCS-07** | DOCS | 8 | README "Three lines" section literally shows a 3-line server + 3-line client; examples executable and match DOCS-01 / DOCS-02. | Proves north-star claim on landing page. Depends on SERVER-08 / CLIENT-10. | F | Accept (conditional on SERVER-08 / CLIENT-10) |

**Decision on the OBS category:** keep as **new top-level category**, not folded into LIFE / CLIENT / SERVER. The five OBS REQ-IDs describe one cohesive surface; scattering them hurts discoverability.

### 3.2 Amendments to existing REQ-IDs (tightening, not new IDs)

| # | REQ-ID | Amendment | Rationale | Source | Rec |
|---|--------|-----------|-----------|--------|-----|
| A1 | **SETUP-05** | "Node 18+" → "**Node 20+**"; update `engines.node` to `>=20.0.0`. | Node 18 EOL 2025-04-30. | S | Accept |
| A2 | **LIFE-01** | State enum expands 4 → 6: add `RECONNECTING` and `CLOSED`. Existing 4 names preserved. | Without `RECONNECTING`, auto-reconnect backoff has no home; without `CLOSED`, consumer can't tell "temporarily down" from "destroyed forever." | A | Accept |
| A3 | **LIFE-02** | Add transitions: `CONNECTED/CONNECTING → RECONNECTING`, `RECONNECTING → CONNECTING`, `DRAINING → CLOSED`, `DISCONNECTED → CLOSED`, any non-terminal → `CLOSED` on `destroy()`. | Pairs with A2. | A | Accept |
| A4 | **LIFE-03** | Event list adds `'drain'` (low-water reached), `'reconnecting'` (per attempt), `'close'` (terminal `CLOSED`). | `'drain'` needed by CLIENT-07 `wait` policy; other two pair with A2. | A | Accept |
| A5 | **CLIENT-04** | Clarify: `ackTimeoutMs` clock starts at write-flush callback, not at `send()` call. Add `{ signal?: AbortSignal }` to `send()` options (pairs with CLIENT-11). | Pre-flush queue time is not the peer's fault. | P, S | Accept |
| A6 | **CLIENT-05** | Wording updated to `CONNECTED/CONNECTING → RECONNECTING` on drop; `RECONNECTING → CONNECTING` on backoff elapse. Exponential backoff resets to `initialDelayMs` after any disconnect preceded by a successful ACK. | Pairs with A2; reset-on-recent-success matches ioredis. | A, P | Accept |
| A7 | **CLIENT-07** | `highWaterMark` accepts either a message count or `{ bytes: number }`; stricter of the two triggers backpressure. | 64 in-flight × 20 MB OBX = 1.3 GB queued — byte cap is a second safety belt. | P, A | Accept |
| A8 | **CLIENT-09** | `destroy()` transitions directly to `**CLOSED**` (not `DISCONNECTED`). | Pairs with A2. | A | Accept |
| A9 | **DOCS-03** | Clarify: test certs are generated at `pretest` via `pnpm certs:gen` (using `selfsigned`) into a gitignored `examples/tls/certs/`, never committed. | Committed certs rot silently and trip secret scanners. | S | Accept |
| A10 | **DOCS-04** | Cookbook addendum covers: (a) `AE` / `AR` are ACKs; (b) k8s SIGTERM wiring; (c) never `rejectUnauthorized: false` in prod; (d) pipeline vs serialized mode; (e) half-open VPN tuning. | Each item is a documented real-world footgun. | P | Accept |

### 3.3 Deferrals / Rejections
**None.** Every proposal is recommended Accept. The most scope-bloat risk is SERVER-08 / CLIENT-10 (starter helpers), flagged as the headline decision.

### 3.4 Collision Map (audit trail)

| Proposed ID | FEATURES | PITFALLS | ARCHITECTURE | Resolution |
|-------------|----------|----------|--------------|------------|
| FRAME-11 | — | Bytes-in/out fidelity | `maxFrameSizeBytes` cap | **A wins FRAME-11** (structural); P → **FRAME-12** |
| WARN-09 | Per-connection warning stream | — | `MLLP_FRAME_TOO_LARGE` code | **A wins WARN-09** (paired with FRAME-11); F → **WARN-10** |
| SERVER-08 | `createStarterServer` | Server framing tolerance opt-ins | — | **F wins SERVER-08** (north-star dependency); P → **SERVER-12** |
| CLIENT-10 | `createStarterClient` | Unmatched-ACK semantics | — | **F wins CLIENT-10**; P → **CLIENT-15** |
| CLIENT-11 | `AbortSignal` | Late-arriving ACK warning | — | **F wins CLIENT-11** (more fundamental); P → **CLIENT-16** |
| CLIENT-12 | `retryStrategy` | Queued-sends-across-reconnect | — | **F wins CLIENT-12**; P → **CLIENT-17** |
| CLIENT-13 | Frozen event payloads | Transient vs permanent classification | — | **F wins CLIENT-13**; P → **CLIENT-18** |
| CLIENT-14 | `Symbol.asyncDispose` | `pipeline: false` | — | **F wins CLIENT-14**; P → **CLIENT-19** |

After resolution, no REQ-ID appears twice.

---

## 4. ROADMAP Phase Changes

Current: 8 phases, ~30 plans. Proposed: 8 phases, **~33 plans** (Phase 4 +1, Phase 5 +1, Phase 6 +1 via split).

| Phase | Current Name | Current Plans | Proposed Plans | Change | Driving REQ-IDs |
|-------|--------------|--------------:|---------------:|--------|-----------------|
| 1 | Project Foundation | 4 | 4 | Content-only: Node 20 matrix, Windows/macOS CI, add SETUP-07 lint rule | SETUP-05 (A1), SETUP-07 |
| 2 | Framing Codec & Warnings | 4 | 4 | Content-only: FRAME-11 + WARN-09 slot into existing 02-PLAN-03 (FrameReader FSM) | FRAME-11, WARN-09 |
| 3 | Transport & Lifecycle | 4 | 4 | Content: 6-state FSM replaces 4-state; OBS-03/04/05 and WARN-10 slot into 03-PLAN-03 (Connection class) | LIFE-01..03 amendments, OBS-03/04/05, WARN-10 |
| 4 | MLLP Server | 3 | **4** | Add **04-PLAN-04: starter helper + `Symbol.asyncDispose` + `AbortSignal` + frozen events + server-level framing opts + `server.getStats()`** | SERVER-08/09/10/11/12, OBS-02 |
| 5 | MLLP Client | 5 | **6** | Add **05-PLAN-06: starter helper + `AbortSignal` + frozen events + `retryStrategy` + ACK edge-cases (CLIENT-15/16/17) + transient-vs-permanent + `pipeline: false` + `client.getStats()`**. 05-PLAN-02 amended for CLIENT-04 clock; 05-PLAN-04 for backoff reset; 05-PLAN-05 for byte-watermark. | CLIENT-10..19, OBS-01, CLIENT-04/05/07/09 amendments |
| 6 | ACK Helpers & TLS | 3 | **4** | **Split per ARCHITECTURE #10:** (a) plain-object ACK builders (needs Phase 2); (b) peer-dep adapter; (c) TlsTransport class (needs only Phase 3 — parallelizable with Phase 4/5); (d) integration (needs 4 + 5). Update `Depends on` to list Phase 2 (helpers), Phase 3 (TLS), Phase 4 + Phase 5 (integration only). | TLS-05 + existing TLS-01..04, ACK-01..05 |
| 7 | Testing, Fixtures & Coverage | 4 | 4 | Content: add FRAME-12 (byte-fidelity fixture) into 07-PLAN-01 or 07-PLAN-03 | FRAME-12 |
| 8 | Examples, README & Publish | 3 | 3 | Content: DOCS-06 + DOCS-07 into 08-PLAN-02; DOCS-04 cookbook addendum; DOCS-03 clarification + `pnpm certs:gen` | DOCS-03/04 amendments, DOCS-06, DOCS-07 |

No phases added or removed. Parallelization: Phase 6's 4-plan structure exposes real parallelism that was hidden in the 3-plan form.

---

## 5. STACK Decisions Needing Human Sign-Off

| # | Decision | Recommendation | Affects | Rec |
|---|----------|----------------|---------|-----|
| S1 | **Node engines floor** | Bump to `>=20` now; bump to `>=22` at Node 20 EOL (2026-04-30, 8 days away). | SETUP-05 (A1), `package.json`, CI | Accept |
| S2 | **CI OS matrix** | 3×3 (ubuntu/macos/windows × Node 20/22/24) for `test` job; lint/typecheck/coverage stay Ubuntu-only. | `.github/workflows/ci.yml` | Accept — MLLP is socket-heavy; Windows half-close is non-trivial |
| S3 | **TLS test cert strategy** | `selfsigned@^6.0.0` devDep + `pretest` script generating short-lived certs into gitignored dirs; never commit. | DOCS-03 (A9), `scripts/generate-test-certs.mjs`, `.gitignore` | Accept |
| S4 | **Coverage provider** | Mirror parent: `@vitest/coverage-v8` with per-dir 90% gates on `src/framing/`, `src/server/`, `src/client/`. | `vitest.config.ts` | Accept |
| S5 | **Benchmarking** | `mitata@^0.1.x` devDep, `bench/`, `pnpm bench` local-only (not CI). | `package.json`, `bench/*.ts` | Accept |
| S6 | **Release tooling** | Bare `pnpm publish` via `workflow_dispatch` + npm provenance. No Changesets / Release Please / semantic-release. | `.github/workflows/publish.yml` | Accept — mirror of parent |
| S7 | **No socket-mocking devDep** | `InMemoryTransport` (TRANS-01..04) is our mock; do not add `mock-net` / `mock-socket`. | — | Accept (confirmation) |
| S8 | **`@arethetypeswrong/cli` publish gate** | Add as a CI step after `pnpm publish --dry-run` to verify dual-publish + subpath types. | DOCS-05 sub-check | Accept — cheap, high signal |

---

## 6. Open Questions

1. **Scope: starter helpers (SERVER-08 / CLIENT-10)?** Biggest scope call. If No, DOCS-07 also drops and the "three lines" claim in PROJECT.md must be softened. Recommendation: **Accept** — without this the north star is marketing, not engineering.
2. **OBS category placement.** New top-level `OBS-*` category vs folding into LIFE / CLIENT / SERVER. Recommendation: **new category** — the surface is cohesive and deserves its own README cookbook section.
3. **SETUP-07 (ESLint no-`.slice()` rule).** Marked LOW priority by PITFALLS researcher. Recommendation: **Accept** — 3-line rule, catches the pitfall automatically.
4. **Phase 6 split to 4 plans.** Cosmetic for single-threaded execution; unlocks real parallelism for two-stream work. Recommendation: **Accept** — plan-level DAG honestly describes the work.
5. **Node-20 transition window.** Ship `>=20` now and bump to `>=22` in a 1.x minor, OR skip directly to `>=22`. Recommendation: **(a) `>=20`** — extra LTS in matrix costs little and aids early-adopter discovery.
6. **CLIENT-16 warning code listing.** `MLLP_ACK_AFTER_TIMEOUT` — add to the `WarningCode` union (WARN-02) or a separate CLIENT-category code? Recommendation: **add to WARN-02 union** for consistency (sub-amendment to WARN-02).

---

## 7. Bottom-Line Count (Before → After)

### REQ-IDs

| Category | Before | Accept-all | If headline (starter helpers + DOCS-07) rejected | If SETUP-07 rejected |
|----------|-------:|-----------:|----------------------------------------------:|-------------------:|
| SETUP | 6 | 7 | 7 | 6 |
| FRAME | 10 | 12 | 12 | 12 |
| WARN | 8 | 10 | 10 | 10 |
| ERR | 4 | 4 | 4 | 4 |
| TRANS | 4 | 4 | 4 | 4 |
| LIFE | 5 | 5 *(amended only)* | 5 | 5 |
| SERVER | 7 | 12 | 11 *(drop SERVER-08)* | 12 |
| CLIENT | 9 | 19 | 18 *(drop CLIENT-10)* | 19 |
| ACK | 5 | 5 | 5 | 5 |
| TLS | 4 | 5 | 5 | 5 |
| TEST | 6 | 6 | 6 | 6 |
| DOCS | 5 | 7 | 6 *(drop DOCS-07)* | 7 |
| **OBS (new)** | 0 | **5** | 5 | 5 |
| **Total** | **73** | **101** (+28) | **98** (+25) | **100** (+27) |

Arithmetic check (Accept-all): 1 + 2 + 2 + 0 + 0 + 0 + 5 + 10 + 0 + 1 + 0 + 2 + 5 = **28 net-new**. 73 + 28 = **101**. ✓

### Phases / Plans

| | Before | After (Accept-all) |
|---|-----:|------:|
| Phases | 8 | **8** (unchanged) |
| Plans | ~30 (4+4+4+3+5+3+4+3) | **~33** (4+4+4+**4**+**6**+**4**+4+3) |

### Amendments

10 amendments touch existing REQs without adding IDs: SETUP-05, LIFE-01, LIFE-02, LIFE-03, CLIENT-04, CLIENT-05, CLIENT-07, CLIENT-09, DOCS-03, DOCS-04. All tightening; none remove behavior.

---

## 8. Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Locked by parent mirror + authoritative Node schedule + direct npm registry queries |
| Features | HIGH on surface, MEDIUM on download numbers (npm 403 during research) | Every library examined via GitHub README |
| Architecture | HIGH | Cross-checked vs `ws`, `mysql2`, `ioredis`, `undici`, `pg`; FSM modeled on ioredis |
| Pitfalls | HIGH | Every pitfall carries a real bug citation |
| **Overall** | **HIGH** | Zero dimensions returned LOW; zero existing REQ-IDs invalidated |

**Residual gaps:** (a) OS matrix CI minutes cost may need `if:` gating on free-tier Actions; (b) `mitata` over `tinybench` is over-engineering if absolute throughput numbers don't matter to users; (c) CLIENT-17 FIFO-mode reject-on-reconnect may surface a v2 `{ unsafeResumeFifoOnReconnect: true }` escape hatch.
