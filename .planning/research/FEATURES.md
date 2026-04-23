# Feature Research — `@cosyte/hl7-mllp`

**Domain:** Node.js MLLP client + server (HL7 v2 transport layer only)
**Researched:** 2026-04-22
**Confidence:** HIGH on competitive surface (every library examined via GitHub README or docs); MEDIUM on weekly-download numbers (npmjs.com returned 403 during this session — cross-referenced via libraries.io/Snyk where available and flagged where unverified); HIGH on what real production teams ask for (corroborated via nextgenhealthcare/connect issue tracker, python-hl7 issues, Mirth Community forums).

**Scope of this audit:** Validate the 73 v1 REQ-IDs against (a) what existing Node MLLP libraries ship, (b) what Mirth / Rhapsody / Iguana / HAPI / python-hl7 ship as baseline, (c) what production healthcare teams surface as pain, and (d) what DX-leading adjacent libraries (`ioredis`, `undici`, `pg`) do that this package should adopt.

---

## Part 1 — Competitive Surface

### Existing Node MLLP libraries (2026)

| Library | Last publish / commit | License | TS? | Key features | Key gaps vs. our v1 |
|---|---|---|---|---|---|
| **`mllp-node`** (amida-tech/mllp) | v2.0.0, **Sep 2018** (abandoned) | Apache-2.0 | No (ambient `.d.ts` only) | `MLLPServer(host, port)`, `on('hl7')` event, `send(host, port, msg, cb)`. Event-driven minimal API. | No TLS, no reconnect, no ACK correlation, no backpressure, no typed errors, no state machine, no keepalive, no in-memory transport, no warnings. Framing tolerance is hardcoded in-source, not opt-in. |
| **`node-hl7-client`** (Bugs5382) | v3.2.0, **Jun 2025** — actively maintained (451 commits, 55 releases) | MIT | Yes, TS-first | Zero runtime deps, auto-reconnect + retry, TLS support, FHS/BHS batch builders, MSH/BHS/FHS segment builders, commented type defs, CJS+ESM dual-build. | Ships its own parser + builder (tight coupling). No stable warning-code system with byte offsets. No documented in-memory transport. No public FSM. No `AbortSignal` support documented. No documented backpressure policy. ACK correlation unclear from README. |
| **`node-hl7-server`** (Bugs5382) | Paired with above, 2025 | MIT | Yes, TS-first | TLS, reconnect, ACK customization (field-level override), graceful shutdown via `close()`, dot-notation message access. Depends on `node-hl7-client` for parse+build. | Minimal quickstart is **11 lines**, not 3 (see "Three lines test" below). Parser coupling is unavoidable. Same gaps as sibling client. |
| **`@caremesh/mllp`** | Fork / private publish | MIT (per Snyk) | No | Fork of `mllp-node`. Inherits minimal API. | Same as `mllp-node`. |
| **`@keepsolutions/mllp-node`** (keeps/mllp) | Fork of amida-tech | Apache-2.0 | No (45 commits on master; pure JS) | Fork of `mllp-node` with buffer-swap bugfix. Still event-driven minimal. | Same as `mllp-node`. |
| **`mllp-server`** (DIGI-UW) | v3.3.1, **Aug 2023** | Apache-2.0 | Yes (100% TypeScript per GH) | Fork lineage of amida-tech, re-written in TS. Same event-driven API. | No TLS, no reconnect, no ACK correlation, no backpressure, no typed errors, no FSM, no keepalive. |
| **`hl7-mllp`** (PantelisGeorgiadis) | v0.0.9, **Apr 2025** | MIT | Partial (JS + `index.d.ts`) | Work-in-progress per README. Client + server. | README explicitly says "not for production or clinical purposes." No TLS / reconnect / ACK correlation / state machine. |
| **`simple-hl7`** (hitgeek) | v2.2.1-a, **Dec 2018** (abandoned) | MIT | No | Express-style middleware; `req.msg` / `res.ack` / `res.end()`. Includes file-system interface. | No MLLP-spec'd tolerance. No TLS / reconnect / backpressure docs. |
| **`hl7v2`** (panates, monorepo with `hl7v2-net`) | v1.9.0, ~33 releases, actively maintained | MIT | Yes (98.5% TS) | Full parser + validator + TCP client/server. Dictionary pkg. | Monolithic — cannot use transport without parser. No documented opt-in framing tolerance or warning-code stability. |

**Patterns across the Node ecosystem:**
1. **Every pre-2025 library is effectively abandoned.** `mllp-node`, `simple-hl7`, all the forks. The churn is real.
2. **Every current library couples transport to a specific parser.** `node-hl7-server` hard-requires `node-hl7-client`. `hl7v2` is a monorepo. `simple-hl7` ships its own AST. Our peer-dep-optional design is genuinely differentiating.
3. **No Node MLLP library exposes stable warning codes with byte offsets** for the standard framing deviations (FS-without-CR, LF-after-FS, missing leading VT, leading whitespace, trailing bytes, embedded VT/FS, empty payload). Our WARN-01..08 surface is unique in the Node ecosystem.
4. **No Node MLLP library ships an in-memory transport for deterministic tests.** Everyone reaches for `supertest`-style port-allocation or `net.Socket` mocks. TRANS-02..04 is genuinely unique.
5. **Backpressure semantics are undocumented everywhere.** Every library's `send()` either silently queues or relies on the caller to ignore `write()` returning `false`. Our CLIENT-07 + ERR-04 contract is unique.
6. **No library exposes a 4-state FSM.** The closest is `node-hl7-client`'s event-based `connect`/`close`/`error` events — no inspectable `state` property, no `DRAINING` state for graceful shutdown. Our LIFE-01..05 design is unique.

### Non-Node baselines (for differentiator-hunting)

| Implementation | Relevant baseline features |
|---|---|
| **Mirth Connect** (NextGen) | TCP Listener has `Receive Timeout`, `Keep Connection Open` toggle. MLLP Sender has `Send timeout`, `Keep connection open`, `Retry count`, `Reconnect interval`, `ACK Timeout`. Production teams configure each knob independently per channel. |
| **Rhapsody** (Lyniate) | Comparable baseline (ACK timeout, reconnect interval, per-channel TLS, idle timeout). Native FHIR bridge is the differentiator. |
| **Iguana** (iNTERFACEWARE) | Per-channel retry, ACK timeout, keepalive, and TLS are baseline. Lua-scripted ACK generation is the differentiator. |
| **HAPI (Java)** | Per-MLLP-connection timeout (default 120s in examples), ACK waiters, TLS, application-level ACK builders (`AA`/`AE`/`AR`). Throws `Timeout waiting for response to message` as a typed exception. |
| **python-hl7** | `hl7.mllp` is asyncio streams-based: `open_hl7_connection()` returns `(reader, writer)`. ACK is manual via `writemessage(create_ack(...))`. No built-in reconnect; no backpressure policy; no FSM. |

**Baseline-feature gap:** Every non-Node engine ships **configurable ACK timeout**, **configurable reconnect interval**, **idle keepalive**, and **TLS** as core MLLP knobs. The Node ecosystem has never had all four in a single library with a disciplined API. We do.

---

## Part 2 — The "Three Lines" Test

### North-star claim
> "A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code."

### Real quickstart line counts from the competitive set

| Library | Minimal server quickstart | Minimal client quickstart |
|---|---|---|
| `mllp-node` | 4 lines (instantiate + event listener + log) | 2 lines (`.send(host, port, msg, cb)`) |
| `node-hl7-server` | **11 lines** (import, `new Server()`, `createInbound`, callback, `getMessage()`, `sendResponse('AA')`, `close()`) | Paired with `node-hl7-client`, similar 8–10 lines |
| `hl7v2-net` (panates) | 8+ lines (class-based) | 6+ lines |
| `simple-hl7` | 6+ lines (middleware chain) | 4+ lines (builder + `.send()`) |

**Verdict: the claim is aspirational, not literal — and that's fine as long as we say so.** A "production-grade" server needs: framing + ACK + connection handling + graceful shutdown at minimum. `mllp-node` fits in 4 lines but fails most of those. `node-hl7-server` needs 11 lines to stand up a real server. A hand-rolled 3-line server that also auto-ACKs requires sensible defaults.

### Proposal: make "three lines" honest with a high-level starter helper

Add a `createStarterServer({ port, onMessage })` and `createStarterClient({ host, port })` pair that:
- Applies production-safe defaults (auto-ACK `AA`, 30s ACK timeout, exponential-backoff reconnect on client, graceful shutdown on SIGTERM on server).
- Returns a disposable resource (`[Symbol.asyncDispose]`) so a single `await using` line handles teardown.

Three-line server:
```ts
import { createStarterServer } from '@cosyte/hl7-mllp';
await using server = await createStarterServer({ port: 2575,
  onMessage: (msg) => console.log(msg.toString('utf8')) });
```

Three-line client:
```ts
import { createStarterClient } from '@cosyte/hl7-mllp';
await using client = await createStarterClient({ host, port: 2575 });
const ack = await client.send(Buffer.from(msh));
```

This is honest — it's still 3 lines, it delegates to `createServer`/`createClient` internally, and it makes the "three lines for production-grade" claim defensible.

**Proposed new REQ-IDs:**
- **SERVER-08** — `createStarterServer({ port, onMessage, host?, tls?, autoAck? })` returns a server with `AA` auto-ACK, 30s shutdown drain, `Symbol.asyncDispose`, and SIGTERM handler; three-line quickstart verifiable in `DOCS-04` and `DOCS-01`.
- **CLIENT-10** — `createStarterClient({ host, port, tls? })` returns a client with auto-reconnect enabled, 30s ACK timeout, FIFO ACK correlation, `Symbol.asyncDispose`; three-line quickstart verifiable in `DOCS-04` and `DOCS-02`.

**Rationale:** We already own all the underlying knobs via `createServer` / `createClient`. The starter helpers are a thin layer that make the north-star defensible and give the README its first-example hook. Without them, the three-line claim in PROJECT.md is marketing, not engineering.

---

## Part 3 — Feature Landscape

### Table Stakes (users expect these; missing = product feels incomplete)

| Feature | Why Expected | Current Coverage | Status |
|---|---|---|---|
| Canonical `VT…FS+CR` framing on send | Every HL7 receiver expects it; wrong framing = zero-ACK | FRAME-01..03 | COVERED |
| Partial-read assembly across TCP chunk boundaries | Real networks fragment — `mllp-node` and `hl7-mllp` both have issue reports for exactly this | FRAME-04..06 | COVERED |
| ACK round-trip with timeout | `send()` must resolve with the ACK or reject | CLIENT-02, CLIENT-04, ERR-02 | COVERED |
| Auto-reconnect with backoff | Networks drop; manual reconnect = nobody picks this lib | CLIENT-05, CLIENT-06 | COVERED |
| TLS (client + server) | Healthcare demands it | TLS-01..04 | COVERED |
| Buffer-first API (not string) | MSH-18 charsets break string APIs — HL7 payloads carry latin-1/UTF-8/CP1252 | FRAME-01, SERVER-03, CLIENT-02 | COVERED |
| Typed errors with discriminator | Caller has to branch on `ECONNRESET` vs. `ACK_TIMEOUT` vs. framing fail | ERR-01..04 | COVERED |
| Graceful shutdown with drain timeout | Rolling deploys / SIGTERM — `mllp-node` and friends just `destroy()` | SERVER-06, LIFE-02, CLIENT-01 | COVERED |
| Stable TypeScript types with IntelliSense | 2026 baseline for any npm library | SETUP-04 | COVERED |
| Zero runtime deps | Supply-chain scrutiny in healthcare | SETUP-03 | COVERED |
| Dual ESM+CJS | 2026 baseline | SETUP-02 | COVERED |
| ACK-controlId correlation | **Real prod bug:** Mirth issue #1441 — ACK returned after timeout gets matched to next queued message | CLIENT-03 | COVERED |
| Configurable ACK timeout | Every non-Node engine ships it; `node-hl7-client` has auto-reconnect but ACK timeout is undocumented | CLIENT-04 | COVERED |
| Strict-mode escalation for CI | Parallel to `@cosyte/hl7`'s `strict: true`; users with validators need it | WARN-08 | COVERED |
| Auto-ACK mode for hello-world | Required for any 3-line demo to be meaningful | SERVER-04 | COVERED |

**Table-stakes gaps identified: 0. The v1 REQ-IDs cover every table-stakes feature the competitive set or non-Node baselines would expect.**

### Table-stakes adjacencies we should add (new REQ-IDs)

Even though the core functionality is covered, the following are table-stakes **in 2026** that deserve explicit REQ-IDs:

- **CLIENT-11 (NEW) — `AbortSignal` support for `connect()`, `send()`, and `close()`.** Every modern Node socket library accepts an `AbortSignal` (fetch, undici, node:test, readline). Without it, users can't integrate with their own cancellation scopes. Currently implicit in `client.destroy()` but not composable. Low-cost add; thread `signal?: AbortSignal` through three public methods and reject pending promises with `{ name: 'AbortError' }` on signal. *(Proposed wording: "`connect(opts?)`, `send(payload, opts?)`, and `close(opts?)` accept `{ signal?: AbortSignal }`. On `signal.aborted`, pending promises reject with `DOMException('...', 'AbortError')` and state transitions to `DISCONNECTED` (for `connect`) or the send is dropped from the in-flight queue (for `send`).")*
- **SERVER-09 (NEW) — `AbortSignal` support on `listen()` and `close()`.** Same pattern for the server side.
- **CLIENT-12 (NEW) — Configurable retry policy (not just exponential backoff).** `node-hl7-client` ships auto-reconnect with fixed semantics; Mirth lets operators configure retry count + interval separately. Model after `ioredis`'s `retryStrategy: (attempt: number) => number | null`. Let the caller return `null` to stop reconnecting (e.g., after circuit-breaker trip). Current CLIENT-05 hardcodes exponential backoff; add a `retryStrategy?: (attempt: number) => number | null` option that, when present, overrides the default. *(Proposed wording: "`{ retryStrategy: (attempt: number) => number | null }` overrides the default exponential-backoff delay. Returning `null` stops reconnection and transitions to `DISCONNECTED` with a `reason` of `'retry-exhausted'`; returning a number uses that as the next delay in ms.")*
- **WARN-09 (NEW) — Per-connection warning stream, not just global emitter.** WARN-06 provides `onWarning` at the reader/server/client level, but a server instance with 50 live connections needs **per-connection** warning subscription for attribution and backpressure on warning handlers. Without this, a single misbehaving peer floods the global handler. *(Proposed wording: "Each `Connection` exposes its own `onWarning(fn)` subscriber and `warnings: readonly MllpWarning[]` snapshot; warnings are also mirrored to the server/client-level `onWarning` for logging aggregation.")*
- **CLIENT-13 / SERVER-10 (NEW) — Event payloads are frozen.** PROJECT.md's constraints already say "Immutable warning objects" and frozen `MllpWarning` is covered by WARN-01. Extend: `MessageEvent`, `StateChangeEvent`, and `AckEvent` payloads are `Object.freeze()`'d on emission. Prevents one subscriber mutating state another subscriber observes. *(Proposed wording: "Every event payload delivered to an `onMessage` / `onAck` / `onStateChange` / `onError` / `onWarning` / `onDisconnect` subscriber is frozen; attempts to mutate the payload throw in strict mode and are no-ops otherwise.")*

### Differentiators (competitive advantage — why someone switches)

Validated against the competitive set. Every differentiator below names a library that doesn't have it.

| Differentiator | Value Proposition | Competitor gap |
|---|---|---|
| **In-memory transport (`TRANS-02..04`)** | Deterministic, socket-free round-trip tests; `pair()`, `split(n)`, `pause()/resume()`, `destroy(reason)` | **None** of `mllp-node`, `node-hl7-client/server`, `hl7v2-net`, `hl7-mllp`, `simple-hl7`, `mllp-server` ships one. Testing MLLP libs today requires port allocation + timing assumptions. |
| **Stable warning codes with byte offsets (`WARN-01..08`)** | Programmatic reaction to specific deviations; audit-friendly logs | No Node library has stable codes for `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, etc. `@cosyte/hl7` has 13 parse-side warning codes; we extend the model to transport. |
| **Opt-in tolerance per deviation (`FRAME-07..10`)** | Silent tolerance is a bug magnet; every Cosyte lib makes deviation visible | `mllp-node` has hardcoded tolerance in-source with no knob. `node-hl7-client`'s framing behavior is undocumented. |
| **Inspectable 4-state FSM (`LIFE-01..05`)** | Debuggability at 3 AM; half-open detection via explicit `DRAINING` state | `ioredis` has a `status` string; `undici` has Dispatcher state events. **No Node MLLP library exposes state.** |
| **Peer-dep-optional ACK helpers (`ACK-01..05`, subpath `/ack-from-hl7`)** | Works without parser, works with `@cosyte/hl7`, works with any other parser via plain object | `node-hl7-server` hard-requires `node-hl7-client`; `hl7v2-net` requires `hl7v2`. No parser-agnostic MLLP library exists in Node. |
| **Postel's Law framing (liberal decoder, strict encoder, never both)** | Clean wire output + tolerance inward — same discipline as `@cosyte/hl7` | No Node MLLP library documents this asymmetry. `mllp-node` is liberal both directions (silent tolerance on write). |
| **Buffer-first throughout, never string** | MSH-18 charset declarations mean string APIs corrupt silently; most bugs in `mllp-node` issues trace back to this | `simple-hl7` string-handles. `node-hl7-client` handles bytes but returns parsed messages. No library publicly commits to Buffer-in / Buffer-out. |
| **High-water-mark backpressure policy (`CLIENT-07`, `ERR-04`)** | `onBackpressure: 'reject' \| 'wait'` — explicit policy, typed error | No Node MLLP library has a documented backpressure contract. |
| **Starter helpers make 3-line quickstart honest** (proposed new SERVER-08 / CLIENT-10) | PROJECT.md promises it; no existing library delivers it in <8 lines with production defaults | `node-hl7-server` minimal example is 11 lines. |

### Anti-features (deliberately NOT in v1 — validate "Out of Scope")

| Anti-feature | Do users expect it? | Validation | Action |
|---|---|---|---|
| **HL7 v2 parsing** | No — users of MLLP libraries have a parser or build their own | `node-hl7-server` bundling a parser is criticized implicitly by download/issue patterns; a transport-only lib is a feature not a gap | Keep out of scope. DOCS-04 already says "what this package does not do" — add explicit pointer to `@cosyte/hl7`. |
| **FHIR / HL7v3 / CDA transports** | Some — search results show confusion between "HL7 transport" and "FHIR" | Common enough that the README should redirect | Keep out of scope. Add one-line README redirect to FHIR libraries (e.g., `node-fhir-server-core`, `fhir-kit-client`). |
| **HTTP-based HL7** | Rare — exists but not expected from an MLLP library | PROJECT.md already flags it as roadmap-if-demand-emerges | Keep out of scope. No README pointer needed. |
| **Store-and-forward / persistent queue** | Yes, frequently — users conflate MLLP with an integration engine | Mirth/Rhapsody/Iguana all bundle it; Node MLLP libraries never have | Keep out of scope. Add README section "If you need store-and-forward, you need an integration engine, not an MLLP library — see Mirth Connect / NextGen Connect, or use BullMQ + `@cosyte/hl7-mllp` as a send driver." |
| **Routing / fan-out / transformation** | Yes — same confusion | Same as store-and-forward | Keep out of scope. Same README redirect. |
| **Prometheus / OTel adapters** | Maybe — modern teams want observability | Event-hook surface is correct; adapter is not library's responsibility | Keep out of scope. README cookbook entry: "How to emit Prometheus metrics from MLLP events" showing the hook pattern. |
| **File-based FHS/BHS batch ingestion** | No for an MLLP library — yes for an integration engine | `simple-hl7` has it; it doesn't belong on the wire | Keep out of scope. BHS framing awareness is already v2-deferred. |
| **Browser / Deno / Bun runtimes** | No for v1 — maybe later | Node 18+ only is fine; TCP sockets not in browsers anyway | Keep out of scope. |

**Proposed new REQ-ID for "anti-feature pointers":**
- **DOCS-06 (NEW) — README "Not In Scope" section explicitly directs readers to alternatives.** Points at: `@cosyte/hl7` for parsing; Mirth Connect / NextGen Connect for integration-engine features (store-and-forward, routing, fan-out); FHIR libraries for FHIR; BullMQ / pg-boss for queuing on top of this library. Without this, users file "can you add routing?" issues for years. *(Proposed wording: "README contains a `## What this package does not do` section with a table: each anti-feature (parsing, FHIR, routing, store-and-forward, HTTP-based HL7, metrics backend) maps to a recommended alternative library or tool; every user-visible v2-deferred item links forward to the relevant GitHub milestone.")*

---

## Part 4 — Operational features production teams ask for

From Mirth forums, python-hl7 issue tracker, `nextgenhealthcare/connect` issue tracker, and HL7 integration engineer chatter:

| Operational feature | Current coverage | Audit |
|---|---|---|
| **ACK-controlId correlation** | CLIENT-03 | COVERED. The `nextgenhealthcare/connect` issue #1441 ("ACK returned after destination timeout gets matched to next queued message") is the textbook case for this; our opt-in `correlateByControlId` is the correct design. |
| **Per-connection warning events vs. global emitter** | Partial — WARN-03/06 | Covered at server/client/reader level but **not per-connection**. See new **WARN-09** proposal above. |
| **Configurable retry policy (not just exponential)** | Partial — CLIENT-05 | Covered for the default case. See new **CLIENT-12** proposal (retry-strategy callback) above. |
| **Explicit drain on shutdown** | SERVER-06, LIFE-02, LIFE-05 | COVERED. `DRAINING` state + `drainTimeoutMs` (30s default) matches Mirth's "Keep Connection Open + close cleanly" operational pattern. |
| **Idle-connection probes (TCP keepalive + app-level)** | CLIENT-08, SERVER-07 | COVERED. Both expose `keepaliveIntervalMs` (TCP probe) and `deadPeerTimeoutMs` (app-level dead-peer forced close). Mirth forum #5238/#5251 confirms this is a real operational need. |
| **Half-open connection detection** | CLIENT-08 (via `deadPeerTimeoutMs`) | COVERED via dead-peer timeout. Explicit: if no bytes received for N ms, force-close + reconnect. |
| **Message-level metrics hooks** | Implicit via events (`onMessage`, `onAck`, `onWarning`, `onError`, `onDisconnect`) | COVERED. Caller wires their Prometheus/OTel. |
| **Structured error-ACK (AE/AR) with ERR segment** | ACK-02 | COVERED. `buildAckAE(msg, err)` / `buildAckAR(msg, err)` return framed Buffers with `ERR` segment when structured details provided. |
| **Per-connection rate limiting** | NOT COVERED | Gap, but intentionally out of scope — rate limiting is an application concern above MLLP (token bucket / leaky bucket on top of `send()`). Document in "not in scope" README section. No REQ-ID change. |
| **Backpressure policy (`reject` vs. `wait` vs. `buffer-to-disk`)** | CLIENT-07 covers `reject` + `wait`; `buffer-to-disk` is integration-engine territory | COVERED. `buffer-to-disk` stays v2-deferred (out of scope for a transport lib). |
| **Message control-ID generation on send** | NOT COVERED | Gap. In practice, callers hand the framed bytes in (they own controlId). We match on it. Don't generate. No REQ-ID change. |
| **ACK retry on transient failures** | NOT COVERED (CLIENT-04 explicitly does not retry) | Intentional gap — retry semantics belong at the caller's application layer because idempotency decisions are not ours to make. Mirth issue #734 ("retry when persistent queue ACK times out") is a famous footgun. Stay out of scope. Document explicitly in README cookbook. |

**Summary:** The operational-feature audit surfaces two gaps that deserve new REQ-IDs (**WARN-09** per-connection warning stream, **CLIENT-12** retry-strategy callback) and one table-stakes DX gap (**CLIENT-11/SERVER-09** `AbortSignal`).

---

## Part 5 — DX features distinguishing a 10x library

Audit against ours:

| DX feature | Pattern in `ioredis` / `undici` / `pg` | Our coverage | Status |
|---|---|---|---|
| **async/await-native, no callbacks** | `ioredis` returns Promises everywhere; `undici` same | CLIENT-01/02, SERVER-01, TRANS-01 all Promise-based | COVERED |
| **`AbortSignal` on all async methods** | `undici.fetch({ signal })`; `setTimeout({ signal })` | NOT COVERED | **Gap — see CLIENT-11 / SERVER-09 above** |
| **Type-level discriminated unions for errors** | `undici` uses error classes; `pg` uses `err.code` string codes | ERR-01..04 use typed error classes with `code` fields | COVERED; explicit union type of `code` values should be exported for exhaustive `switch` |
| **Frozen/immutable event payloads** | `undici` payloads are plain objects (not frozen); `ioredis` events are primitive strings | WARN-01 freezes `MllpWarning`; other events not explicitly frozen | **Gap — see CLIENT-13 / SERVER-10 above** |
| **Stable public vs. internal symbol separation** | `undici` exports `kClose` symbol for internal hooks | Implicit via barrel exports | Minor gap — pattern is "don't export internals." Document in CONTRIBUTING. No REQ-ID change needed. |
| **Subpath exports (`/testing`, `/ack-from-hl7`)** | `ioredis` has `/cluster`; `undici` has `/agent` etc. | SETUP-02 explicitly covers both | COVERED |
| **No singletons** | `ioredis` requires explicit `new Redis()`; `undici` has `setGlobalDispatcher()` opt-in | `createServer()` / `createClient()` return instances; no module-level state | COVERED |
| **Zero-config happy path** | `new Redis()` works on `localhost:6379` | Currently `createServer({ onMessage })` + `listen(2575)` works with auto-ACK | COVERED with auto-ACK default; the proposed `createStarterServer/Client` (SERVER-08/CLIENT-10) tightens this further |
| **Exposed `status`/`state` property** | `ioredis.status` is a string; `undici.Client` exposes `closed`/`destroyed` | LIFE-01 (`.state: 'CONNECTING' \| 'CONNECTED' \| 'DRAINING' \| 'DISCONNECTED'`) | COVERED, superior to `ioredis` (enum not magic string) |
| **`retryStrategy` callback, not just numeric options** | `ioredis.retryStrategy: (times) => delayMs \| null` | CLIENT-05 hardcodes exponential+jitter | **Gap — see CLIENT-12 above** |
| **`Symbol.asyncDispose` / `using` support** | Node 20+ pattern; not in `ioredis`/`pg` yet (2026) but becoming table stakes | Currently implicit via `await close()` | Minor gap — propose wiring in the starter helpers (SERVER-08/CLIENT-10 proposals above). Adding to `createClient`/`createServer` is cheap: a `[Symbol.asyncDispose]() { return this.close(); }` method on each. Could be folded into SERVER-08/CLIENT-10 or broken out as SERVER-11/CLIENT-14. |

### Failure-mode UX — what developers see at 3 AM

The `undici` model is the gold standard: connection-state events (`connect`, `disconnect`), structured error codes, and snippets of the last bytes seen. Our design mirrors this:

| Scenario | What developer sees today (in `mllp-node`) | What they see with `@cosyte/hl7-mllp` (per REQ-IDs) |
|---|---|---|
| `ECONNRESET` mid-send | Raw `Error: read ECONNRESET` bubbles up, no context | `MllpConnectionError({ phase: 'send', cause: <original>, connectionId })` — typed, phase-tagged, correlatable |
| ACK timeout | Generic timeout or silent hang | `MllpTimeoutError({ messageControlId, elapsedMs })` — actionable |
| Partial-frame corruption | Silent silent drop or cryptic parse error | `MllpFramingError({ code: 'MLLP_FS_WITHOUT_CR', byteOffset, snippet })` — 64-byte snippet for forensics |
| Backpressure overflow | Memory leak or crash | `MllpBackpressureError({ queueDepth, highWaterMark })` — load-signal |
| TLS handshake fail | Generic `Error: SSL routines:...` | `MllpConnectionError({ phase: 'connect', cause: <TLS error> })` — original preserved in `cause` |

The snippet (≤64 bytes) in `MllpFramingError` (ERR-01) is the key UX move — it's the direct analog of `undici`'s bytes-on-error, and **no other Node MLLP library provides it.** Validate the 64-byte limit doesn't leak PHI beyond what's reasonable — HL7 MSH/PID live in the first ~256 bytes of any message, so 64 bytes of "snippet around the anomaly" should rarely contain identifiable patient data unless the anomaly is inside PID. Document the redaction-is-caller's-job stance (same as `@cosyte/hl7`'s `Hl7ParseError.snippet`).

---

## Part 6 — Audit against REQUIREMENTS.md

### Missing features (table stakes to add to v1)

| New REQ-ID | Category | Wording (proposed) | Phase suggestion |
|---|---|---|---|
| **CLIENT-11** | CLIENT | `connect()`, `send(payload)`, `close()` accept `{ signal?: AbortSignal }`. On abort: pending promises reject with `DOMException('...', 'AbortError')`; `connect()` transitions to `DISCONNECTED` with `reason: 'aborted'`; a `send()` abort drops that send from the in-flight queue without affecting others. | Phase 5 |
| **CLIENT-12** | CLIENT | `{ retryStrategy?: (attempt: number) => number \| null }` overrides the default exponential-backoff delay. Returning `null` stops reconnection (transition `DISCONNECTED` with `reason: 'retry-exhausted'`); a number is the next delay in ms. Default retryStrategy reproduces CLIENT-05 defaults exactly. | Phase 5 |
| **CLIENT-13** | CLIENT | Every event payload delivered to `onMessage` / `onAck` / `onStateChange` / `onError` / `onDisconnect` subscribers is `Object.freeze()`'d on emission. | Phase 5 |
| **CLIENT-14** | CLIENT | `client[Symbol.asyncDispose]()` delegates to `client.close()`; usable via `await using client = await createClient(...).connect()` in Node 20+. | Phase 5 |
| **SERVER-08** | SERVER | `createStarterServer({ port, onMessage, host?, tls?, autoAck? })` returns a server pre-configured for the three-line quickstart: auto-ACK `AA`, 30s drain, `Symbol.asyncDispose`, optional SIGTERM/SIGINT handler (opt-in; off by default to avoid process-global side effects). | Phase 4 |
| **SERVER-09** | SERVER | `listen()` and `close()` accept `{ signal?: AbortSignal }`; abort during `listen` cancels the bind and rejects; abort during `close` forces `destroy()` on any still-draining connection. | Phase 4 |
| **SERVER-10** | SERVER | Every event payload delivered to `onMessage` / `onError` / `onConnection` / `onStateChange` / `onDisconnect` subscribers is `Object.freeze()`'d on emission. | Phase 4 |
| **SERVER-11** | SERVER | `server[Symbol.asyncDispose]()` delegates to `server.close()`. | Phase 4 |
| **CLIENT-10** | CLIENT | `createStarterClient({ host, port, tls? })` returns a client with auto-reconnect enabled, 30s ACK timeout, FIFO correlation, and `Symbol.asyncDispose`. | Phase 5 |
| **WARN-09** | WARN | Each `Connection` exposes its own `onWarning(fn)` subscriber and `warnings: readonly MllpWarning[]` snapshot; the server/client-level `onWarning` continues to receive all warnings as an aggregate stream. | Phase 3 |
| **DOCS-06** | DOCS | README "What this package does not do" section links every anti-feature to a recommended alternative (parser → `@cosyte/hl7`; integration engine → Mirth Connect; FHIR → fhir-kit-client; queueing → BullMQ). | Phase 8 |
| **DOCS-07** | DOCS | README includes a "Three lines" section that literally shows a 3-line server and a 3-line client using `createStarterServer` / `createStarterClient`; the examples are executable and match `DOCS-01` / `DOCS-02`. | Phase 8 |

**Total new REQ-IDs: 12** — expanding from 73 to **85 v1 REQ-IDs**.

### Mispriced features

None detected. Every existing REQ-ID that addresses a table-stakes need is mapped to an early phase; every differentiator is mapped to a phase that depends on its prerequisites. The existing ROADMAP.md dependency graph already puts framing (Phase 2) before transport (Phase 3) before server (Phase 4) and client (Phase 5), which is correct.

### Unnecessary features

None detected. Every REQ-ID traces to a concrete user-visible behavior. Suspicions audited:

- **FRAME-10** (`allowLeadingWhitespace`) — pulled its weight? Yes. Mirth issue #5251 describes devices that send heartbeat signals with leading whitespace; this is a real-world deviation.
- **TEST-06** failure-mode fixtures — all scenarios listed are corroborated by the issue-tracker evidence (controlId mismatch = Mirth #1441, backpressure overflow = Node #47130, reconnect-with-queued-sends = Node #50403).
- **DOCS-03** (mutual TLS example) — real: most hospital-facing deployments are mTLS.

### Anti-patterns we might be drifting toward

Audited. Verdicts:

- **Exposing `net.Socket` directly** — TRANS-01 explicitly says "`Transport` interface, not a raw `net.Socket`." COVERED.
- **Singletons / module-level state** — no REQ-ID introduces them; `setDefaultProfile`-style globals not present. SAFE.
- **String-in / string-out API** — FRAME-01 is Buffer-typed; SERVER-03 and CLIENT-02 are Buffer-typed. SAFE.
- **Hidden tolerance** — FRAME-07..10 make every tolerance explicit and opt-in. SAFE.
- **Silent ACK semantics** — CLIENT-04 explicitly documents the no-automatic-retry stance; CLIENT-03 makes correlation opt-in rather than magical default. SAFE.
- **Peer dep that's actually a hidden runtime dep** — SETUP-03 + subpath export (`/ack-from-hl7`) ensures users who don't install `@cosyte/hl7` never pay the cost. SAFE — but add a test in TEST fixture set confirming the non-peer-dep code path can be imported and used with zero `@cosyte/hl7` on disk. *(Propose folding into **TEST-02** or adding as a small addendum to **SETUP-03** verification; not worth a new REQ-ID.)*

---

## Part 7 — Summary tables for ROADMAP.md revision

### Proposed REQ-ID additions (12 new)

| REQ-ID | Phase | Rationale |
|---|---|---|
| CLIENT-11 | 5 | `AbortSignal` — 2026 Node baseline |
| CLIENT-12 | 5 | `retryStrategy` callback — matches ioredis pattern, closes retry-policy gap |
| CLIENT-13 | 5 | Frozen event payloads — consistency with WARN-01 |
| CLIENT-14 | 5 | `Symbol.asyncDispose` — 2026 idiom |
| CLIENT-10 | 5 | Starter client — makes three-line claim honest |
| SERVER-08 | 4 | Starter server — makes three-line claim honest |
| SERVER-09 | 4 | `AbortSignal` |
| SERVER-10 | 4 | Frozen event payloads |
| SERVER-11 | 4 | `Symbol.asyncDispose` |
| WARN-09 | 3 | Per-connection warning stream (attribution + subscriber isolation) |
| DOCS-06 | 8 | Anti-feature README pointers |
| DOCS-07 | 8 | Three-line quickstart in README |

**Net effect:** 73 → 85 v1 REQ-IDs. Phase redistribution:
- Phase 3 (LIFE): +1 (WARN-09)
- Phase 4 (SERVER): +4 (SERVER-08..11)
- Phase 5 (CLIENT): +5 (CLIENT-10..14)
- Phase 8 (DOCS): +2 (DOCS-06..07)

### Demotion / removal candidates

**None.** Every v1 REQ-ID survives the audit.

### Validation of Out-of-Scope list

All 7 Out-of-Scope items in PROJECT.md validated as genuinely not-our-job. Add explicit README redirect (DOCS-06) so users don't file drive-by issues.

---

## Sources

- [mllp-node on npm](https://www.npmjs.com/package/mllp-node) (metadata via search)
- [amida-tech/mllp on GitHub](https://github.com/amida-tech/mllp) (README + API surface)
- [node-hl7-client on GitHub](https://github.com/Bugs5382/node-hl7-client) (commit history, feature list)
- [node-hl7-server on GitHub](https://github.com/Bugs5382/node-hl7-server) (11-line quickstart)
- [DIGI-UW/mllp-server on GitHub](https://github.com/DIGI-UW/mllp-server) (v3.3.1, Aug 2023)
- [keeps/mllp on GitHub](https://github.com/keeps/mllp) (Apache-2.0 fork)
- [PantelisGeorgiadis/hl7-mllp on GitHub](https://github.com/PantelisGeorgiadis/hl7-mllp) (v0.0.9, Apr 2025)
- [hitgeek/simple-hl7 on GitHub](https://github.com/hitgeek/simple-hl7) (v2.2.1-a, Dec 2018 — abandoned)
- [panates/hl7v2 on GitHub](https://github.com/panates/hl7v2) (TypeScript, monolithic)
- [python-hl7 MLLP docs](https://python-hl7.readthedocs.io/en/latest/mllp.html) (asyncio-based baseline)
- [python-hl7 issue #44: ACK not received full](https://github.com/johnpaulett/python-hl7/issues/44) (partial-read evidence)
- [nextgenhealthcare/connect #1441: ACK matched to wrong message](https://github.com/nextgenhealthcare/connect/issues/1441) (controlId correlation evidence)
- [nextgenhealthcare/connect #734: ACK timeout retry](https://github.com/nextgenhealthcare/connect/issues/734) (retry-policy evidence)
- [nextgenhealthcare/connect #5238: Keep connection open](https://github.com/nextgenhealthcare/connect/discussions/5238) (keepalive evidence)
- [nextgenhealthcare/connect #5251: Keep-alive errors flooding log](https://github.com/nextgenhealthcare/connect/discussions/5251) (app-level vs TCP keepalive distinction)
- [Mirth Connect issues & fixes](https://mirth.support/mirth-connect-issues-and-fixes) (operational baseline)
- [HCL Link MLLP Adapter docs](https://help.hcl-software.com/hcllink/1.1.5/adapters/mllp/concepts/c_mllp_overview.html) (enterprise baseline)
- [HL7 MLLP Transport Specification, Release 1 (Rene Spronk)](https://hl7.skyware-group.com/lib/exe/fetch.php?media=wiki:mllp.pdf) (wire format)
- [undici Client docs](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md) (state/error API reference)
- [ioredis README](https://ioredis.readthedocs.io/en/stable/README/) (retryStrategy, status property patterns)
- [AppSignal — AbortController in Node.js 2025](https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html) (AbortSignal baseline)
- [Covetus — What is HL7 MLLP, Limitations](https://www.covetus.com/blog/what-is-hl7-mllp-common-hl7-transports-applications-limitations) (fragmentation, VPN, timeout gotchas)
- [DEV — Surviving the HL7 Nightmare](https://dev.to/beck_moulton/surviving-the-hl7-nightmare-strategies-for-decoupling-modern-saas-from-legacy-hospital-systems-5bn0) (production-team perspective)
- [Mirth Connect vs Rhapsody vs Iguana 2026](https://nerdbot.com/2026/03/18/mirth-connect-vs-rhapsody-vs-cloverleaf-vs-iguana-choosing-the-right-hl7-integration-engine-in-2026/) (non-Node baseline)

---

*Feature research for: `@cosyte/hl7-mllp` v1 (Node.js MLLP client + server, transport-only)*
*Researched: 2026-04-22*
*Confidence: HIGH on competitive surface; MEDIUM on weekly-download numbers (npmjs.com returned 403); HIGH on operational evidence*
