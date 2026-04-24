# @cosyte/hl7-mllp — Roadmap (v1)

North star: **A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.**

- **Granularity:** standard (8 phases, 3–6 plans each)
- **Mode:** yolo (auto-advance enabled)
- **Parallelization:** enabled — plans within a phase may run in parallel where they touch disjoint modules
- **Coverage:** 101 / 101 v1 REQ-IDs mapped to exactly one phase
- **Revised 2026-04-22** — post-research accept-all: 28 new REQ-IDs + 10 amendments + Phase 6 plan-split

---

## Phases

- [x] **Phase 1: Project Foundation** — Scaffold the repo, build, lint, and TypeScript toolchain (Node 20+ floor, 3×3 OS×Node CI matrix, `selfsigned` cert-gen, `.subarray`-only lint rule) so any subsequent phase can iterate. *(Complete 2026-04-24)*
- [ ] **Phase 2: Framing Codec & Warnings** — Canonical `VT…FS+CR` encoder, stateful chunked-stream decoder with `maxFrameSizeBytes` DoS cap, tolerance opt-ins, stable warning-code union (incl. `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_*`), and `MllpFramingError`.
- [x] **Phase 3: Transport Abstraction, Connection FSM & Observability** *(Complete 2026-04-24)* — `Transport` interface (`net.Socket` wrapper + `InMemoryTransport` for tests), `Connection` in its own module with a **6-state FSM** (`CONNECTING` / `CONNECTED` / `DRAINING` / `RECONNECTING` / `DISCONNECTED` / `CLOSED`), per-connection warning stream, `connection.getStats()`, and `MllpConnectionError`.
- [ ] **Phase 4: MLLP Server** — `createServer`, `listen`, per-connection message emission as `Buffer`, auto-ACK mode, manual-ACK mode, graceful shutdown with drain timeout, idle keepalive, `createStarterServer`, `AbortSignal` + `Symbol.asyncDispose`, frozen event payloads, server-level framing tolerance opts, `server.getStats()`.
- [ ] **Phase 5: MLLP Client** — `createClient`, `connect`, `send` with ACK-awaiting (FIFO + controlId correlation), exponential-backoff reconnect (with backoff reset + retryStrategy callback + transient/permanent classification), backpressure (count + byte watermarks, wait/reject policy, drain event), dead-peer detection, `pipeline: false` serialization mode, unmatched-ACK + late-ACK semantics, queued-sends-across-reconnect policy, `createStarterClient`, `AbortSignal` + `Symbol.asyncDispose`, frozen event payloads, `client.getStats()`, `MllpTimeoutError` + `MllpBackpressureError`.
- [ ] **Phase 6: ACK Helpers & TLS** — `buildAckAA/AE/AR` plain-object builders (depend on Phase 2 only), `@cosyte/hl7-mllp/ack-from-hl7` peer-dep adapter, `TlsTransport` class with SNI default (depends on Phase 3 only), and end-to-end integration test (depends on Phases 2 / 3 / 4 / 5). Plan-split (was 3 plans → now 4) exposes true parallelism.
- [ ] **Phase 7: Testing, Fixtures & Coverage** — Canonical round-trip fixtures, chunked-read fuzz suite, one fixture per warning code (11 codes), byte-fidelity round-trip test, lifecycle sequencing asserts across 6-state FSM, failure-mode fixtures (incl. reconnect / pipeline / TLS SNI / byte-watermark), and the ≥ 90 % per-directory coverage gate.
- [ ] **Phase 8: Examples, README & Publish** — Three runnable examples (server / client / TLS with `pnpm certs:gen`), the complete README with "Three lines" quickstart + cookbook + operational playbook + anti-feature-alternatives table + warning-code reference, CHANGELOG / CONTRIBUTING, `@arethetypeswrong/cli` publish-gate, and a green `pnpm publish --dry-run`.

---

## Phase Details

### Phase 1: Project Foundation
**Goal**: A developer cloning the repo can install, build, typecheck, lint, and test with a single command sequence; downstream phases never have to revisit tooling. CI runs on Ubuntu + macOS + Windows × Node 20 / 22 / 24 for the test job.
**Depends on**: Nothing (first phase)
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06, SETUP-07
**Success Criteria** (what must be TRUE):
  1. A developer can run `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` from a clean clone and every command exits 0 with zero warnings.
  2. A developer importing the package from an ESM project and another from a CJS project both resolve the correct entry through the `exports` map and receive typed intellisense; the `/testing` and `/ack-from-hl7` subpath exports resolve to distinct tree-shakeable bundles, each with its own types condition block.
  3. A developer inspecting `package.json` sees zero runtime `dependencies`, `@cosyte/hl7` listed under `peerDependencies` with `peerDependenciesMeta.optional = true`, `"type": "module"`, dual-build artifacts declared, and `"engines": { "node": ">=20.0.0" }`.
  4. A developer editing any `.ts` file gets strict-mode errors for `any`, unchecked index access, missing types, and attempts to use `Buffer.prototype.slice()` inside `src/framing|server|client` (forbidden by the SETUP-07 ESLint rule).
  5. CI runs the test job on Ubuntu / macOS / Windows × Node 20 / 22 / 24 (9 cells); lint / typecheck / coverage run on Ubuntu only.
**Plans**: 5 plans
  - [x] 01-01-PLAN.md — package scaffold (package.json, tsconfig.json, LICENSE, README stub, stub barrels)
  - [x] 01-02-PLAN.md — dual ESM+CJS build via tsup with .d.ts, three subpath entries, sourcemaps, external:@cosyte/hl7
  - [x] 01-03-PLAN.md — ESLint flat config (SETUP-07 no-buffer-slice rule), Prettier, Vitest + coverage-v8 with 90% gates
  - [x] 01-04-PLAN.md — GitHub Actions CI workflow (3x3 matrix), @arethetypeswrong/cli step, TLS cert gen script, pipeline smoke test
  - [x] 01-05-PLAN.md — gap closure: delete .eslintignore (redundant in ESLint v9 flat config) to satisfy SETUP-06 zero-warnings
**UI hint**: no

### Phase 2: Framing Codec & Warnings
**Goal**: A developer calling `encodeFrame(buf)` or feeding arbitrary TCP chunks into a `FrameReader` receives spec-correct output; every tolerated deviation surfaces as a stable, positional warning, every unrecoverable problem throws a typed `MllpFramingError`, and frame-size overflow is bounded by `maxFrameSizeBytes` to prevent DoS.
**Depends on**: Phase 1
**Requirements**: FRAME-01, FRAME-02, FRAME-03, FRAME-04, FRAME-05, FRAME-06, FRAME-07, FRAME-08, FRAME-09, FRAME-10, FRAME-11, WARN-01, WARN-02, WARN-03, WARN-04, WARN-05, WARN-06, WARN-07, WARN-08, WARN-09, ERR-01
**Success Criteria** (what must be TRUE):
  1. A developer calling `encodeFrame(payload)` always receives `VT + payload + FS + CR`; payloads containing `VT` or `FS` bytes either throw `MllpFramingError` with the correct stable code or (with `allowDelimiterBytesInPayload: true`) pass through with a warning.
  2. A developer feeding `N` complete frames in any combination of chunk boundaries (including 1-byte chunks, chunks splitting delimiters, chunks with multiple frames) into `FrameReader` receives exactly `N` payload `Buffer`s in the same order, with identical bytes.
  3. A developer opting into a tolerance (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`, `allowLeadingWhitespace`) sees the matching behavior emit a frozen `MllpWarning` with the correct `code`, `byteOffset`, and a stable `message`; without the opt-in, the same input throws `MllpFramingError` with the same code.
  4. A developer enabling `{ strict: true }` on the reader has every leading-VT / FS-CR / LF-after-FS tolerance escalated to a thrown `MllpFramingError` regardless of individual opt-ins; `MLLP_EMPTY_PAYLOAD` / `MLLP_TRAILING_BYTES` remain warnings even in strict mode.
  5. A developer feeding a frame whose payload exceeds `maxFrameSizeBytes` (default 16 MB) receives `MllpFramingError('MLLP_FRAME_TOO_LARGE')` at the byte offset where the cap was reached; the reader does not further accumulate bytes. Subscribing via `{ onWarning: fn }` receives every warning as it is emitted; a throwing handler does not corrupt reader state.
**Plans**: 4 plans
  - [ ] 02-01-PLAN.md — warning registry (11 codes incl. `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`) + `MllpFramingError` with `{ code, byteOffset, snippet }` + `MllpWarning` frozen factory
  - [ ] 02-02-PLAN.md — `encodeFrame()` + payload-byte guard (`allowDelimiterBytesInPayload`) + round-trip encoder tests
  - [ ] 02-03-PLAN.md — `FrameReader` state machine — `SCANNING_FOR_VT` / `READING_PAYLOAD` / `EXPECTING_CR` — with byte-offset tracking, chunked-input accumulator, `maxFrameSizeBytes` enforcement, and tolerance opt-ins
  - [ ] 02-04-PLAN.md — strict-mode escalation chokepoint + `onWarning` try/catch wrapper + `src/index.ts` barrel update
**UI hint**: no

### Phase 3: Transport Abstraction, Connection FSM & Observability
**Goal**: A developer using either a real `net.Socket`-backed transport or the in-memory test transport gets an identical `Transport` interface, an inspectable **6-state** connection FSM (`CONNECTING`/`CONNECTED`/`DRAINING`/`RECONNECTING`/`DISCONNECTED`/`CLOSED`), per-connection warning streams, `connection.getStats()` observability, and a consistent lifecycle-event contract that every downstream phase (server/client) builds on. Connection lives in its own `src/connection/` module, peer to `src/transport/`.
**Depends on**: Phase 2
**Requirements**: TRANS-01, TRANS-02, TRANS-03, TRANS-04, LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, WARN-10, OBS-03, OBS-04, OBS-05, ERR-03
**Success Criteria** (what must be TRUE):
  1. A developer writing generic code against the `Transport` interface can swap between `NetTransport` (TCP), `TlsTransport` (stub here, wired in Phase 6), and `InMemoryTransport` without touching call sites.
  2. A developer calling `InMemoryTransport.pair()` receives two connected ends and can drive a send → receive round-trip in a single process with no sockets; `split(bytesPerChunk)` forces chunked reads; `pause()/resume()` simulates backpressure; `destroy(reason)` simulates abrupt disconnect.
  3. A developer inspecting any `Connection` sees `.state` as one of exactly the 6 states, subscribes to `'stateChange'` with `{ from, to, reason }`, and sees transitions fire along the LIFE-02 edge graph with a stable `connectionId` on every event. Events `onConnect` / `onMessage` / `onAck` / `onWarning` / `onError` / `onReconnecting` / `onDrain` / `onDisconnect` / `onClose` fire in the documented order.
  4. A developer calling `close()` during `CONNECTING` or `RECONNECTING` cancels the attempt without leaking timers; during `CONNECTED` it transitions through `DRAINING` and resolves once in-flight work completes or the drain timeout elapses; `destroy()` from any non-terminal state transitions directly to `CLOSED`.
  5. A developer calling `connection.getStats()` receives a JSON-serializable object with `state`, `connectionId`, `remoteAddress`/`Port`, `warningsByCode`, byte counters, timestamps, and `warningsTruncated` when the per-connection warning buffer has exceeded 100 entries; the `warningsByCode` count map remains accurate regardless of truncation. Per-connection `onWarning(fn)` receives only that connection's warnings.
**Plans**: 5 plans
  - [x] 03-PLAN-01: `Transport` interface + `NetTransport` wrapper around `net.Socket` with event plumbing + `MllpConnectionError` typed error (now with `'reconnect'` in the `phase` union)
  - [x] 03-PLAN-02: `InMemoryTransport` with `pair()` / `split()` / `pause()` / `destroy()` and deterministic event-queue semantics
  - [x] 03-PLAN-03: `Connection` class in `src/connection/` — 6-state FSM with full LIFE-02 transition graph, `connectionId` generator, lifecycle events (incl. `'drain'` / `'reconnecting'` / `'close'`), `stateChange` event, per-connection `onWarning` (WARN-10), `getStats()` (OBS-03/04/05) with capped warning buffer
  - [x] 03-PLAN-04: `close()` / `destroy()` semantics across the 6 states, drain timeout, CONNECTING-cancellation + RECONNECTING-cancellation with timer cleanup, barrel updates
  - [x] 03-05-PLAN.md — gap closure: fix CR-01 (ReconnectingEvent interface), WR-01/WR-02 (FSM stuck on transport close/error in CONNECTING/RECONNECTING), WR-03 (concurrent drain idempotency), plus RECONNECTING test coverage
**UI hint**: no

### Phase 4: MLLP Server
**Goal**: A developer calling `createServer(opts).listen(port)` can accept inbound MLLP connections, receive every framed message as a raw `Buffer` with positional warnings, respond with either auto-ACK or manual ACK, gracefully drain on shutdown, and use the `createStarterServer` helper for a three-line batteries-included server; TypeScript consumers get `AbortSignal` + `Symbol.asyncDispose` throughout, frozen event payloads, server-level framing-tolerance opts, and `server.getStats()` for ops.
**Depends on**: Phase 3
**Requirements**: SERVER-01, SERVER-02, SERVER-03, SERVER-04, SERVER-05, SERVER-06, SERVER-07, SERVER-08, SERVER-09, SERVER-10, SERVER-11, SERVER-12, OBS-02
**Success Criteria** (what must be TRUE):
  1. A developer calling `const server = createServer({ onMessage: (payload, meta, conn) => conn.send(ackBuf), framing: { allowFsOnly: true } }); await server.listen(2575, { signal })` receives every framed inbound message as a `Buffer` (framing stripped) with `meta.connectionId`, `meta.byteOffset`, and `meta.warnings`; server-level framing tolerance opts flow to every accepted connection; `signal.abort()` aborts a pending `listen()` cleanly.
  2. A developer enabling `{ autoAck: 'AA' }` sees every inbound message auto-acknowledged with a minimal `AA` ACK synthesized from the MSH header (using the parser-coupled helper when the peer dep is available, otherwise a plain-object-MSH path derived from MSH field positions); `{ autoAck: fn }` accepts a custom ACK builder; the default (`autoAck: undefined`) disables auto-ACK.
  3. A developer calling `server.close({ drainTimeoutMs: 5000 })` sees the server stop accepting new connections immediately, in-flight messages and their ACKs complete, and any connection that has not drained within 5 s is forcibly closed with `MllpConnectionError({ phase: 'close' })`; `await using server = createServer(...)` invokes the same path via `Symbol.asyncDispose`.
  4. A developer writing `const server = createStarterServer({ port, onMessage })` gets a listening server in three lines with auto-ACK `AA`, 30 s drain, `Symbol.asyncDispose`, and opt-in SIGTERM handling out of the box; every event payload (`connection`, `message`, `error`, `stateChange`, `disconnect`, `close`) is `Object.freeze`'d.
  5. A developer calling `server.getStats()` receives a JSON-serializable object with `listening`, `port`, `host`, `connections`, `activeConnections`, `totalBytesIn/Out`, `acceptedTotal`, `closedTotal`; per-connection idle-keepalive (`keepaliveIntervalMs` / `deadPeerTimeoutMs`) works as configured.
**Plans**: 4 plans
  - [ ] 04-01-PLAN.md — `createServer` + `listen`/`close` skeleton + per-connection wiring (`Connection` from Phase 3 + `FrameReader` from Phase 2) + `MessageMeta` type + `src/server/index.ts` barrel
  - [ ] 04-02-PLAN.md — auto-ACK synthesis (`_buildAutoAck` plain-object-MSH path without peer dep) + `autoAck: fn` custom builder + manual-ACK pass-through
  - [ ] 04-03-PLAN.md — graceful shutdown with drain timeout (`_drainAll`) + `AbortSignal` on `listen`/`close` + idle-keepalive wiring + `src/index.ts` Phase 4 barrel block
  - [ ] 04-04-PLAN.md — `createStarterServer` helper + `Symbol.asyncDispose` + frozen-event audit + full `server.getStats()` with live byte aggregation (OBS-02) + SIGTERM opt-in
**UI hint**: no

### Phase 5: MLLP Client
**Goal**: A developer calling `createClient({ host, port }).connect()` can `send(buf)` and receive an ACK `Promise<Buffer>` with configurable timeout (timer starting at write-flush), FIFO or controlId-correlated ACK matching, automatic exponential-backoff reconnect with backoff-reset and transient-vs-permanent classification, well-bounded backpressure semantics (count + bytes), and use the `createStarterClient` helper for a three-line batteries-included client; TypeScript consumers get `AbortSignal` + `Symbol.asyncDispose` throughout, frozen event payloads, a custom `retryStrategy` hook, `pipeline: false` serialization mode, late-ACK / unmatched-ACK observability, and `client.getStats()` for ops.
**Depends on**: Phase 3
**Requirements**: CLIENT-01, CLIENT-02, CLIENT-03, CLIENT-04, CLIENT-05, CLIENT-06, CLIENT-07, CLIENT-08, CLIENT-09, CLIENT-10, CLIENT-11, CLIENT-12, CLIENT-13, CLIENT-14, CLIENT-15, CLIENT-16, CLIENT-17, CLIENT-18, CLIENT-19, OBS-01, ERR-02, ERR-04
**Success Criteria** (what must be TRUE):
  1. A developer calling `const c = createClient({ host, port }); await c.connect({ signal }); const ack = await c.send(payload, { signal })` receives the inbound ACK payload (framing stripped) as a `Buffer`, with typed rejections for `MllpTimeoutError` (clock started at write-flush, not at `send()` call), `MllpConnectionError`, `MllpBackpressureError`, and `AbortError`.
  2. A developer configuring `correlateByControlId: true` sees out-of-order ACKs matched against outgoing messages by MSH-10 → MSA-2; an ACK whose MSA-2 matches no outgoing send emits `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to `onError`; a late-arriving ACK whose `send()` already timed out emits `MLLP_ACK_AFTER_TIMEOUT` warning and drops the ACK.
  3. A developer whose connection drops with `autoReconnect: true` sees the client transition `CONNECTED → RECONNECTING → CONNECTING → CONNECTED` with exponential backoff (default `100 ms * 2^n`, capped 30 s, ±20 % jitter, or overridden by `retryStrategy(attempt)`); backoff resets to `initialDelayMs` after any disconnect preceded by at least one successful ACK; permanent errors (`ENOTFOUND`, TLS cert errors, `EACCES`) halt reconnect and transition to `CLOSED`. In `correlateByControlId: true` mode queued sends are re-transmitted on reconnect (idempotent via stable MSH-10); in FIFO mode they reject with `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })`.
  4. A developer sending into a saturated socket sees well-defined backpressure: `highWaterMark` accepts a message count (default 64) or `{ bytes }` (stricter-of-two wins); `onBackpressure: 'reject'` (default) rejects with `MllpBackpressureError({ queueDepth, queueBytes, highWaterMark })`; `onBackpressure: 'wait'` awaits a `'drain'` event or the per-message timeout. `{ pipeline: false }` enforces strict send → await-ACK → send serialization.
  5. A developer writing `await using c = createStarterClient({ host, port })` gets a three-line client with auto-reconnect, 30 s ACK timeout, FIFO correlation, `Symbol.asyncDispose`, and frozen event payloads; `c.getStats()` returns a JSON-serializable object with `state`, `queueDepth`, `queueBytes`, `inFlight`, `warningsByCode`, byte counters, timestamps, and `reconnectAttempts`. `isTransientConnectionError(err)` is exported from the main barrel. `client.destroy()` transitions directly to `CLOSED`.
**Plans**: 6 plans (anticipated)
  - 05-PLAN-01: `createClient` + `connect()` + `close()`/`destroy()` lifecycle over the 6-state `Connection` FSM
  - 05-PLAN-02: `send()` with per-message `ackTimeoutMs` (timer starts at write-flush per CLIENT-04), FIFO ACK matching, `MllpTimeoutError` on expiry
  - 05-PLAN-03: controlId correlation (`correlateByControlId`) — MSH-10 extraction on outbound, MSA-2 matching on inbound, CLIENT-15 unmatched-ACK path, CLIENT-16 late-ACK path
  - 05-PLAN-04: exponential-backoff auto-reconnect with jitter + backoff-reset-on-recent-success + `retryStrategy` hook + CLIENT-17 queued-sends policy + CLIENT-18 transient-vs-permanent classifier + `isTransientConnectionError` export
  - 05-PLAN-05: backpressure (count + `{bytes}` dual watermark, `drain` event, reject/wait policy) + `MllpBackpressureError` with `queueBytes` + `pipeline: false` serialization mode + keepalive / dead-peer detection
  - 05-PLAN-06: `createStarterClient` helper + `AbortSignal` on all awaitables + `Symbol.asyncDispose` + frozen event payloads + `client.getStats()` (OBS-01)
**UI hint**: no

### Phase 6: ACK Helpers & TLS
**Goal**: A developer using `@cosyte/hl7` as a peer dep can build and return spec-clean `AA` / `AE` / `AR` ACKs with a single helper; a developer using any other parser (or none) can still use the helpers via a plain-object MSH descriptor. Both client and server transparently support TLS via a `tls` options object without changing the public API — including SNI default to `tls.host` and explicit refusal to connect without a servername. The plan split exposes true parallelism: the plain-object ACK builder needs only Phase 2; the TlsTransport class needs only Phase 3; the peer-dep adapter needs Phase 2 + 6a; end-to-end integration needs Phases 4 + 5 + 6a + 6b + 6c.
**Depends on**: Phase 2 (for ACK helpers), Phase 3 (for TLS transport), Phase 4 + Phase 5 (for integration only — 06-PLAN-04)
**Requirements**: ACK-01, ACK-02, ACK-03, ACK-04, ACK-05, TLS-01, TLS-02, TLS-03, TLS-04, TLS-05
**Success Criteria** (what must be TRUE):
  1. A developer without `@cosyte/hl7` installed calls `buildAckAA({ controlId, sendingApp, sendingFacility, receivingApp, receivingFacility, timestamp, version })` and receives a `Buffer` containing a valid HL7 ACK with MSA-1 = `AA`, MSA-2 = inbound MSH-10, and MSH-3..7 swapped correctly; no runtime import of `@cosyte/hl7` happens in this path.
  2. A developer with `@cosyte/hl7` installed calls `buildAckAA(parseHL7(inbound))` (from `@cosyte/hl7-mllp/ack-from-hl7`) and receives the same `AA` ACK bytes as the plain-object path; `buildAckAE(msg, err)` and `buildAckAR(msg, err)` produce `AE`/`AR` ACKs with MSA-3 and an `ERR` segment when structured details are provided. A developer using `{ awaitAck: false }` on `send()` resolves on flush (no ACK wait).
  3. A developer configuring `createServer({ tls: { key, cert } })` or `createClient({ tls: { host, ca, servername, rejectUnauthorized } })` sees TCP replaced by TLS transparently; the `Connection` FSM fires `CONNECTING → CONNECTED` only after the TLS handshake completes; handshake failures surface as `MllpConnectionError({ phase: 'connect', cause: <TLS error> })`.
  4. A developer configuring `createClient({ tls: { host: 'mllp.example.com', ca } })` without an explicit `servername` sees `tls.servername` default to `'mllp.example.com'`; configuring `createClient({ tls: { ca } })` with neither `host` nor `servername` set refuses to connect with `MllpConnectionError({ phase: 'connect', cause: new Error('TLS servername required') })`.
  5. A developer handling `'message'` manually and calling `conn.send(rawAckBuffer)` sees their exact bytes framed and sent — the server never rewrites a caller-supplied ACK payload; the end-to-end integration test spins up a real (or in-memory) TLS-wrapped server, a real TLS client, and round-trips a message with an auto-ACK.
**Plans**: 4 plans — **split from 3 per ARCHITECTURE research**
  - 06-PLAN-01 (*needs Phase 2 only*): plain-object ACK builders — `buildAckAA` / `buildAckAE` / `buildAckAR` from plain-object MSH descriptor + `ERR` segment builder; no peer dep
  - 06-PLAN-02 (*needs 06-PLAN-01 + peer-dep type shape*): `@cosyte/hl7-mllp/ack-from-hl7` adapter that accepts `@cosyte/hl7`'s `Hl7Message` and delegates to Plan 01 builders
  - 06-PLAN-03 (*needs Phase 3 only*): `TlsTransport` wrapping `tls.Socket` + SNI default (TLS-05) + TLS handshake-error mapping to `MllpConnectionError`
  - 06-PLAN-04 (*needs Phase 4 + Phase 5 + 06-PLAN-03*): integration — `createServer({ tls })` + `createClient({ tls })` wiring; end-to-end mutual-TLS round-trip test; `createStarterServer`/`createStarterClient` TLS pass-through
**UI hint**: no

### Phase 7: Testing, Fixtures & Coverage
**Goal**: A developer running the test suite sees ≥ 90 % coverage on framing/server/client plus concrete evidence — canonical round-trip fixtures, exhaustive chunked-read coverage, one fixture per warning code (11 codes), byte-fidelity round-trip, lifecycle sequencing asserts across the full 6-state FSM, and failure-mode fixtures covering every newly-added path — that the library behaves as specified end to end.
**Depends on**: Phase 2, Phase 3, Phase 4, Phase 5, Phase 6
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06, FRAME-12
**Success Criteria** (what must be TRUE):
  1. A developer running `pnpm test --coverage` sees ≥ 90 % line coverage on `src/framing/`, `src/server/`, and `src/client/`, with a green test suite and a CI workflow step that enforces the gate on the Ubuntu matrix cell.
  2. A developer reviewing `test/fixtures/` finds at least one canonical fixture per message type (ADT^A01, ORU^R01, SIU^S12, MDM^T02) plus a 1 MB synthetic payload; every fixture round-trips over `InMemoryTransport` with deterministic event ordering; a byte-fidelity test (FRAME-12) drives every byte value 0x00–0xFF plus a 1 MB random-byte corpus through the codec unchanged.
  3. A developer reviewing `test/framing/chunked-read.test.ts` finds a fuzz-style suite that partitions every canonical fixture byte-stream into 1-byte chunks, random chunk sizes, and chunks deliberately splitting delimiter bytes — every partition yields the exact same sequence of payload `Buffer`s.
  4. A developer reviewing `test/framing/tolerance.test.ts` finds one fixture per `WarningCode` (11 codes including `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`) that (a) fires with the matching opt-in / path and produces exactly one matching warning, (b) throws `MllpFramingError` with the same code under `{ strict: true }` where applicable, and (c) produces no warning at all when the deviation is absent.
  5. A developer reviewing `test/lifecycle.test.ts` + `test/failure-modes.test.ts` finds fixtures for: the full 6-state transition sweep (`CONNECTING → CONNECTED → RECONNECTING → CONNECTING → CONNECTED → DRAINING → DISCONNECTED` and a separate `… → CLOSED` path via `destroy()`); abrupt mid-frame disconnect; ACK timeout; ACK-controlId mismatch (`MLLP_ACK_UNMATCHED_CONTROL_ID`); late-arriving ACK after timeout (`MLLP_ACK_AFTER_TIMEOUT`); backpressure overflow (both count-mode and byte-mode); FIFO-unsafe reject on reconnect; controlId resume on reconnect; transient-vs-permanent classification (tight-loop guard); `pipeline: false` serialization; TLS handshake failure (expired cert + missing-SNI).
**Plans**: 4 plans
  - 07-PLAN-01: canonical message fixtures + round-trip harness over `InMemoryTransport` + lifecycle sequencing asserts across full 6-state FSM
  - 07-PLAN-02: chunked-read fuzz suite (1-byte, random, delimiter-splitting partitions) across all canonical fixtures + FRAME-12 byte-fidelity sweep
  - 07-PLAN-03: tolerance fixtures (one per 11 `WarningCode`s) × strict-mode sweep
  - 07-PLAN-04: failure-mode fixtures (abrupt disconnect, ACK timeout + late-ACK + unmatched-ACK, backpressure overflow count/bytes, reconnect FIFO-reject + controlId-resume, transient-vs-permanent, `pipeline: false`, TLS SNI / expired-cert) + coverage gate CI step
**UI hint**: no

### Phase 8: Examples, README & Publish
**Goal**: A developer can read the README in five minutes, run three standalone examples, understand every stable warning code, see an anti-feature → alternative map so the drive-by "does this do X?" issues are preempted, and `pnpm publish --dry-run` produces a clean tarball ready to ship to npm (with an `@arethetypeswrong/cli` publish-gate verifying dual-publish + subpath types).
**Depends on**: Phase 7
**Requirements**: DOCS-01, DOCS-02, DOCS-03, DOCS-04, DOCS-05, DOCS-06, DOCS-07
**Success Criteria** (what must be TRUE):
  1. A developer cloning the repo, `cd examples/server-basic && pnpm install && pnpm start` sees a listening MLLP server using `createStarterServer`; the companion `examples/client-basic` uses `createStarterClient`, connects, sends a fixture, logs the returned ACK, and exits 0.
  2. A developer running `pnpm certs:gen && cd examples/tls && pnpm install && pnpm start` sees the server and client complete a mutual-TLS handshake with locally-generated (gitignored) test certs, exchange one message, and shut down cleanly; committed-cert rot is impossible because certs are never committed.
  3. A developer reading `README.md` finds at the top a "Three lines" section with a three-line server and a three-line client (DOCS-07; these code blocks are extracted from `examples/` by a CI script so they can't drift); a cookbook section (auto-ACK, manual ACK, auto-reconnect, backpressure, TLS, testing via `InMemoryTransport`, `AbortSignal` cancellation, `pipeline: false`); the full stable warning-code table (11 codes); an operational-playbook section (AE/AR-are-ACKs, k8s SIGTERM, never `rejectUnauthorized: false`, when to set `pipeline: false`, VPN half-open tuning); an anti-feature → alternative table (DOCS-06) pointing at `@cosyte/hl7`, Mirth Connect, `fhir-kit-client`, BullMQ, etc.
  4. A developer running `pnpm publish --dry-run` sees a clean tarball with `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`; no `test/`, `examples/`, `src/`, or dotfiles leak in; the tarball size and contents are captured in the Phase 8 summary; `@arethetypeswrong/cli` CI step confirms dual-publish + all three subpath types resolve correctly on both ESM and CJS consumers.
  5. A developer reading `CONTRIBUTING.md` + `CHANGELOG.md` finds the same engineering bar mirrored from `@cosyte/hl7`: zero runtime deps policy, strict TypeScript policy, coverage gate, warning-code stability policy, the Postel's Law framing rule, and the `.subarray()`-only rule (SETUP-07).
**Plans**: 3 plans (anticipated)
  - 08-PLAN-01: three examples (server-basic, client-basic, tls) with self-contained `package.json` + `scripts/generate-test-certs.mjs` + gitignored `examples/tls/certs/` + `pnpm start` wiring
  - 08-PLAN-02: README with "Three lines" quickstart + cookbook + operational playbook + warning-code reference + anti-feature-alternatives table (DOCS-06) + CHANGELOG + CONTRIBUTING + CI script for README code-block extraction from `examples/`
  - 08-PLAN-03: `pnpm publish --dry-run` verification + tarball audit + `@arethetypeswrong/cli` publish-gate CI step + final Phase 8 summary
**UI hint**: no

---

## Progress

| Phase | REQs | Plans | Status |
|-------|-----:|------:|--------|
| 1. Project Foundation | 7 | 5 | Complete 2026-04-24 |
| 2. Framing Codec & Warnings | 21 | 4 | Complete 2026-04-24 |
| 3. Transport, Connection FSM & Observability | 14 | 5 | Complete 2026-04-24 |
| 4. MLLP Server | 13 | 4 | Pending |
| 5. MLLP Client | 22 | 6 | Pending |
| 6. ACK Helpers & TLS | 10 | 4 | Pending |
| 7. Testing, Fixtures & Coverage | 7 | 4 | Pending |
| 8. Examples, README & Publish | 7 | 3 | Pending |
| **Total** | **101** | **35** | **37 % (3/8 phases)** |

## Coverage Validation

Every v1 REQ-ID from `REQUIREMENTS.md` is mapped to exactly one phase above. **101 / 101 mapped. No duplicates.**

Arithmetic: 7 + 21 + 14 + 13 + 22 + 10 + 7 + 7 = 101 ✓

## Parallelization Notes

- **Phase 6 plan split** exposes three independent streams: `06-PLAN-01` (ACK builders) needs Phase 2 only; `06-PLAN-03` (TlsTransport) needs Phase 3 only; both can start in parallel with Phase 4 and Phase 5. `06-PLAN-04` (integration) is the serialization point that needs 4 + 5 + 6a + 6b + 6c.
- **Phase 4** and **Phase 5** both depend on Phase 3 and are otherwise independent; the two phases may run in parallel.
- **Within Phase 2**, Plans 02-02 (encoder) and 02-03 (decoder state machine) operate on disjoint modules and can parallelize.
- **Within Phase 5**, Plans 05-02 / 05-03 / 05-04 / 05-05 / 05-06 touch disjoint client-side concerns (ACK timeout, controlId correlation, reconnect, backpressure+pipeline, starter+stats) once Plan 05-01 lands the skeleton.
- **Phase 7** plans can be parallelized by fixture-category (canonical / chunked-read / tolerance / failure) once Phase 6 lands.

## Dependencies

```
Phase 1 → Phase 2 ─┬─→ Phase 3 ─┬─→ Phase 4 ─────┐
                  │             │                 │
                  │             ├─→ Phase 5 ─────┤
                  │             │                 │
                  │             └─→ Phase 6-PLAN-03 (TlsTransport)
                  │                                  │
                  └─→ Phase 6-PLAN-01 (plain-obj ACK)┤
                  └─→ Phase 6-PLAN-02 (peer-dep adapter — after 01)
                                                     │
                                Phase 6-PLAN-04 (integration) ┘
                                        │
                                        ▼
                                 Phase 7 → Phase 8
```
