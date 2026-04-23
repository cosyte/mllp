# @cosyte/hl7-mllp — Roadmap (v1)

North star: **A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.**

- **Granularity:** standard (8 phases, 3–5 plans each anticipated)
- **Mode:** yolo (auto-advance enabled)
- **Parallelization:** enabled — plans within a phase may run in parallel where they touch disjoint modules
- **Coverage:** 73/73 v1 REQ-IDs mapped to exactly one phase

---

## Phases

- [ ] **Phase 1: Project Foundation** — Scaffold the repo, build, lint, and TypeScript toolchain so any subsequent phase can iterate.
- [ ] **Phase 2: Framing Codec & Warnings** — Canonical `VT…FS+CR` encoder, stateful chunked-stream decoder, tolerance opt-ins, stable warning codes with byte offsets, and `MllpFramingError`.
- [ ] **Phase 3: Transport Abstraction & Connection Lifecycle** — `Transport` interface (`net.Socket` wrapper + `InMemoryTransport` for tests), 4-state connection FSM (`CONNECTING` / `CONNECTED` / `DRAINING` / `DISCONNECTED`), lifecycle events, and `MllpConnectionError`.
- [ ] **Phase 4: MLLP Server** — `createServer`, `listen`, per-connection message emission as `Buffer`, auto-ACK mode, manual-ACK mode, graceful shutdown with drain timeout, idle keepalive.
- [ ] **Phase 5: MLLP Client** — `createClient`, `connect`, `send` with ACK-awaiting (FIFO + controlId correlation), exponential-backoff reconnect, backpressure with high-water mark, dead-peer detection, `MllpTimeoutError` + `MllpBackpressureError`.
- [ ] **Phase 6: ACK Helpers & TLS** — `buildAckAA/AE/AR` via `@cosyte/hl7-mllp/ack-from-hl7` subpath (peer-dep optional), raw-ACK pass-through contract, and TLS support for both client and server.
- [ ] **Phase 7: Testing, Fixtures & Coverage** — Canonical round-trip fixtures, chunked-read fuzz suite, one fixture per warning code, lifecycle sequencing asserts, failure-mode fixtures, and the ≥ 90% coverage gate.
- [ ] **Phase 8: Examples, README & Publish** — Three runnable examples (server / client / TLS), the complete README + cookbook + warning-code reference, CHANGELOG / CONTRIBUTING, and a green `pnpm publish --dry-run`.

---

## Phase Details

### Phase 1: Project Foundation
**Goal**: A developer cloning the repo can install, build, typecheck, lint, and test with a single command sequence; downstream phases never have to revisit tooling.
**Depends on**: Nothing (first phase)
**Requirements**: SETUP-01, SETUP-02, SETUP-03, SETUP-04, SETUP-05, SETUP-06
**Success Criteria** (what must be TRUE):
  1. A developer can run `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` from a clean clone and every command exits 0 with zero warnings.
  2. A developer importing the package from an ESM project and another from a CJS project both resolve the correct entry through the `exports` map and receive typed intellisense; the `/testing` and `/ack-from-hl7` subpath exports resolve to distinct bundles.
  3. A developer inspecting `package.json` sees zero runtime `dependencies`, `@cosyte/hl7` listed under `peerDependencies` with `peerDependenciesMeta.optional = true`, `"type": "module"`, dual-build artifacts declared, and a Node 18+ engines field.
  4. A developer editing any `.ts` file gets strict-mode errors for `any`, unchecked index access, and missing types from their editor immediately.
**Plans**: 4 plans (anticipated)
  - 01-PLAN-01: package scaffold (`package.json`, `tsconfig.json`, `LICENSE`, `README.md` stub, `src/index.ts` stub, `src/testing/index.ts` stub, `src/ack-from-hl7/index.ts` stub)
  - 01-PLAN-02: dual ESM+CJS build via `tsup` with `.d.ts`, subpath entries, sourcemaps
  - 01-PLAN-03: ESLint flat config, Prettier, Vitest config, sanity test, `pnpm typecheck`/`lint`/`format:check` scripts
  - 01-PLAN-04: smoke verification — full pipeline end-to-end, lockfile commit, GitHub Actions CI workflow on Node 18/20/22
**UI hint**: no

### Phase 2: Framing Codec & Warnings
**Goal**: A developer calling `encodeFrame(buf)` or feeding arbitrary TCP chunks into a `FrameReader` receives spec-correct output; every tolerated deviation surfaces as a stable, positional warning and every unrecoverable problem throws a typed `MllpFramingError`.
**Depends on**: Phase 1
**Requirements**: FRAME-01, FRAME-02, FRAME-03, FRAME-04, FRAME-05, FRAME-06, FRAME-07, FRAME-08, FRAME-09, FRAME-10, WARN-01, WARN-02, WARN-03, WARN-04, WARN-05, WARN-06, WARN-07, WARN-08, ERR-01
**Success Criteria** (what must be TRUE):
  1. A developer calling `encodeFrame(payload)` always receives `VT + payload + FS + CR`; payloads containing `VT` or `FS` bytes either throw `MllpFramingError` with the correct stable code or (with `allowDelimiterBytesInPayload: true`) pass through with a warning.
  2. A developer feeding `N` complete frames in any combination of chunk boundaries (including 1-byte chunks, chunks splitting delimiters, chunks with multiple frames) into `FrameReader` receives exactly `N` payload `Buffer`s in the same order, with identical bytes.
  3. A developer opting into a tolerance (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`, `allowLeadingWhitespace`) sees the matching behavior emit a frozen `MllpWarning` with the correct `code`, `byteOffset`, and a stable `message`; without the opt-in, the same input throws `MllpFramingError` with the same code.
  4. A developer enabling `{ strict: true }` on the reader has every leading-VT / FS-CR / LF-after-FS tolerance escalated to a thrown `MllpFramingError` regardless of individual opt-ins.
  5. A developer subscribing via `{ onWarning: fn }` receives every warning as it is emitted; a throwing handler does not corrupt reader state, and `MLLP_EMPTY_PAYLOAD` / `MLLP_TRAILING_BYTES` produce warnings (not errors) even in strict mode.
**Plans**: 4 plans (anticipated)
  - 02-PLAN-01: warning registry + `MllpFramingError` with `{ code, byteOffset, snippet }` + `MllpWarning` frozen factory
  - 02-PLAN-02: `encodeFrame()` + payload-byte guard (`allowDelimiterBytesInPayload`) + round-trip encoder tests
  - 02-PLAN-03: `FrameReader` state machine — `SCANNING_FOR_VT` / `READING_PAYLOAD` / `EXPECTING_CR` — with byte-offset tracking, chunked-input accumulator, and tolerance opt-ins
  - 02-PLAN-04: strict-mode escalation chokepoint + `onWarning` try/catch wrapper + `src/index.ts` barrel update
**UI hint**: no

### Phase 3: Transport Abstraction & Connection Lifecycle
**Goal**: A developer using either a real `net.Socket`-backed transport or the in-memory test transport gets an identical `Transport` interface, a single inspectable 4-state connection FSM, and a consistent lifecycle-event contract that every downstream phase (server/client) builds on.
**Depends on**: Phase 2
**Requirements**: TRANS-01, TRANS-02, TRANS-03, TRANS-04, LIFE-01, LIFE-02, LIFE-03, LIFE-04, LIFE-05, ERR-03
**Success Criteria** (what must be TRUE):
  1. A developer writing generic code against the `Transport` interface can swap between `NetTransport` (TCP), `TlsTransport` (TLS — stub in this phase, wired in Phase 6), and `InMemoryTransport` without touching call sites.
  2. A developer calling `InMemoryTransport.pair()` receives two connected ends and can drive a send → receive round-trip in a single process with no sockets; `split(bytesPerChunk)` forces chunked reads; `pause()/resume()` simulates backpressure; `destroy(reason)` simulates abrupt disconnect.
  3. A developer inspecting any `Connection` sees `.state` as one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'DISCONNECTED'`, subscribes to `'stateChange'` with `{ from, to, reason }`, and sees transitions fire in the documented order with a stable `connectionId` on every event.
  4. A developer calling `close()` during `CONNECTING` cancels the attempt without leaking timers; during `CONNECTED` it transitions through `DRAINING` and resolves once in-flight work completes or the drain timeout elapses.
  5. A developer whose socket fails to connect or is reset mid-session receives `MllpConnectionError({ phase, cause })` either via `onError` or as a `send()` rejection, with the original `Error` preserved in `cause`.
**Plans**: 4 plans (anticipated)
  - 03-PLAN-01: `Transport` interface + `NetTransport` wrapper around `net.Socket` with event plumbing + `MllpConnectionError` typed error
  - 03-PLAN-02: `InMemoryTransport` with `pair()` / `split()` / `pause()` / `destroy()` and deterministic event-queue semantics
  - 03-PLAN-03: `Connection` class — 4-state FSM, `connectionId` generator, lifecycle events (`onConnect`/`onMessage`/`onAck`/`onWarning`/`onError`/`onDisconnect`), `stateChange` event
  - 03-PLAN-04: `close()` / `destroy()` semantics, drain timeout, CONNECTING-cancellation with timer cleanup, barrel updates
**UI hint**: no

### Phase 4: MLLP Server
**Goal**: A developer calling `createServer(opts).listen(port)` can accept inbound MLLP connections, receive every framed message as a raw `Buffer` with positional warnings, respond with either auto-ACK or manual ACK, and gracefully drain on shutdown.
**Depends on**: Phase 3
**Requirements**: SERVER-01, SERVER-02, SERVER-03, SERVER-04, SERVER-05, SERVER-06, SERVER-07
**Success Criteria** (what must be TRUE):
  1. A developer calling `const server = createServer({ onMessage: (payload, meta, conn) => conn.send(ackBuf) }); await server.listen(2575)` receives every framed inbound message as a `Buffer` (framing stripped) with `meta.connectionId`, `meta.byteOffset`, and `meta.warnings`, and can write framed responses via `conn.send(buf)` without doing their own framing.
  2. A developer enabling `{ autoAck: 'AA' }` sees every inbound message auto-acknowledged with a minimal `AA` ACK synthesized from the MSH header (using the parser-coupled helper when the peer dep is available, otherwise a minimal raw-bytes ACK derived from the inbound MSH fields); `{ autoAck: fn }` accepts a custom ACK builder; the default (`autoAck: undefined`) disables auto-ACK.
  3. A developer calling `server.close({ drainTimeoutMs: 5000 })` sees the server stop accepting new connections immediately, in-flight messages and their ACKs complete, and any connection that has not drained within 5 s is forcibly closed with `MllpConnectionError({ phase: 'close' })`.
  4. A developer configuring `keepaliveIntervalMs` / `deadPeerTimeoutMs` on the server sees idle connections emit TCP keepalive probes and/or close with `MllpConnectionError({ phase: 'receive', cause })` when no bytes have arrived for the configured interval.
  5. A developer driving an end-to-end send → receive → ACK round-trip over `InMemoryTransport` sees deterministic event ordering (`connection` → `onConnect` → `onMessage` → `conn.send()` resolves → `onDisconnect`) and a stable `connectionId` on every event for that pair.
**Plans**: 3 plans (anticipated)
  - 04-PLAN-01: `createServer` + `listen`/`close` + per-connection wiring (`Connection` from Phase 3 + `FrameReader` from Phase 2)
  - 04-PLAN-02: auto-ACK synthesis (raw-bytes path without peer dep + parser-coupled path when available) + manual-ACK pass-through contract
  - 04-PLAN-03: graceful shutdown with drain timeout + server-side keepalive + barrel updates
**UI hint**: no

### Phase 5: MLLP Client
**Goal**: A developer calling `createClient({ host, port }).connect()` can `send(buf)` and receive an ACK `Promise<Buffer>` with configurable timeout, FIFO or controlId-correlated ACK matching, automatic exponential-backoff reconnect, and well-bounded backpressure semantics.
**Depends on**: Phase 3
**Requirements**: CLIENT-01, CLIENT-02, CLIENT-03, CLIENT-04, CLIENT-05, CLIENT-06, CLIENT-07, CLIENT-08, CLIENT-09, ERR-02, ERR-04
**Success Criteria** (what must be TRUE):
  1. A developer calling `const c = createClient({ host, port }); await c.connect(); const ack = await c.send(payload)` receives the inbound ACK payload (framing stripped) as a `Buffer`, with typed rejections for `MllpTimeoutError`, `MllpConnectionError`, and `MllpBackpressureError`.
  2. A developer configuring `correlateByControlId: true` sees out-of-order ACKs matched against outgoing messages by MSH-10 → MSA-2; mismatched or unknown MSA-2 values emit `MllpFramingError` → `onError` and the affected send resolves per policy (default: wait until its own timeout and reject).
  3. A developer whose connection drops with `autoReconnect: true` sees the client transition `DISCONNECTED → CONNECTING` after an exponential-backoff delay (`100 ms * 2^n`, capped at 30 s, ±20 % jitter), with a `'reconnecting'` event per attempt; queued sends remain queued up to `highWaterMark`.
  4. A developer sending into a saturated socket sees well-defined backpressure behavior: `onBackpressure: 'reject'` (default) rejects with `MllpBackpressureError({ queueDepth, highWaterMark })`; `onBackpressure: 'wait'` blocks until the queue drains or the per-message timeout elapses.
  5. A developer calling `client.destroy()` has every pending `send()` reject with `MllpConnectionError({ phase: 'close' })` and the client transitions directly to `DISCONNECTED` without draining; `client.close()` follows the graceful-drain path instead.
**Plans**: 5 plans (anticipated)
  - 05-PLAN-01: `createClient` + `connect()` + `close()`/`destroy()` lifecycle over the `Connection` FSM
  - 05-PLAN-02: `send()` with per-message `ackTimeoutMs`, FIFO ACK matching, `MllpTimeoutError` on expiry
  - 05-PLAN-03: controlId correlation (`correlateByControlId`) — MSH-10 extraction on outbound, MSA-2 matching on inbound, mismatch handling
  - 05-PLAN-04: exponential-backoff auto-reconnect with jitter + `reconnecting` event + queued-send policy across reconnects
  - 05-PLAN-05: backpressure (high-water mark + `onBackpressure` policy) + `MllpBackpressureError` + keepalive / dead-peer detection
**UI hint**: no

### Phase 6: ACK Helpers & TLS
**Goal**: A developer using `@cosyte/hl7` as a peer dep can build and return spec-clean `AA` / `AE` / `AR` ACKs with a single helper; a developer using any other parser (or none) can still use the helpers via a plain-object MSH descriptor. Both client and server transparently support TLS via a `tls` options object without changing the public API.
**Depends on**: Phase 2, Phase 4, Phase 5
**Requirements**: ACK-01, ACK-02, ACK-03, ACK-04, ACK-05, TLS-01, TLS-02, TLS-03, TLS-04
**Success Criteria** (what must be TRUE):
  1. A developer with `@cosyte/hl7` installed calls `buildAckAA(parseHL7(inbound))` (from `@cosyte/hl7-mllp/ack-from-hl7`) and receives a `Buffer` containing a valid HL7 ACK with MSA-1 = `AA`, MSA-2 = inbound MSH-10, and MSH-3..7 swapped correctly; `buildAckAE(msg, err)` and `buildAckAR(msg, err)` produce `AE` / `AR` ACKs with MSA-3 and an `ERR` segment when structured details are provided.
  2. A developer without `@cosyte/hl7` installed calls `buildAckAA({ controlId, sendingApp, sendingFacility, receivingApp, receivingFacility, timestamp, version })` and receives the same `AA` ACK bytes; no runtime import of `@cosyte/hl7` happens in this path.
  3. A developer configuring `createServer({ tls: { key, cert } })` or `createClient({ tls: { host, ca, servername, rejectUnauthorized } })` sees TCP replaced by TLS transparently; the `Connection` FSM fires `CONNECTING → CONNECTED` only after the TLS handshake completes, and handshake failures surface as `MllpConnectionError({ phase: 'connect', cause: <TLS error> })`.
  4. A developer using `{ awaitAck: false }` on a `send()` call receives a promise that resolves on flush (no ACK wait); the default (`awaitAck: true`) preserves Phase 5 behavior.
  5. A developer handling `'message'` manually and calling `conn.send(rawAckBuffer)` sees their exact bytes framed and sent — the server never rewrites a caller-supplied ACK payload.
**Plans**: 3 plans (anticipated)
  - 06-PLAN-01: `buildAckAA` / `buildAckAE` / `buildAckAR` from plain-object MSH descriptor + `ERR` segment builder (no peer dep)
  - 06-PLAN-02: peer-dep-aware `@cosyte/hl7-mllp/ack-from-hl7` adapter that accepts `@cosyte/hl7`'s `Hl7Message` and delegates to Plan 01 builders
  - 06-PLAN-03: `TlsTransport` wrapping `tls.Socket` + `createServer({ tls })` + `createClient({ tls })` wiring + TLS handshake-error mapping
**UI hint**: no

### Phase 7: Testing, Fixtures & Coverage
**Goal**: A developer running the test suite sees ≥ 90 % coverage on framing/server/client plus concrete evidence — canonical round-trip fixtures, exhaustive chunked-read coverage, one fixture per warning code, lifecycle sequencing asserts, and failure-mode fixtures — that the library behaves as specified end to end.
**Depends on**: Phase 2, Phase 3, Phase 4, Phase 5, Phase 6
**Requirements**: TEST-01, TEST-02, TEST-03, TEST-04, TEST-05, TEST-06
**Success Criteria** (what must be TRUE):
  1. A developer running `pnpm test --coverage` sees ≥ 90 % line coverage on `src/framing/`, `src/server/`, and `src/client/`, with a green test suite and a CI workflow step that enforces the gate across Node 18/20/22.
  2. A developer reviewing `test/fixtures/` finds at least one canonical fixture per message type (ADT^A01, ORU^R01, SIU^S12, MDM^T02) plus a 1 MB synthetic payload; every fixture round-trips over `InMemoryTransport` with deterministic event ordering.
  3. A developer reviewing `test/framing/chunked-read.test.ts` finds a fuzz-style suite that partitions every canonical fixture byte-stream into 1-byte chunks, random chunk sizes, and chunks deliberately splitting delimiter bytes — every partition yields the exact same sequence of payload `Buffer`s.
  4. A developer reviewing `test/framing/tolerance.test.ts` finds one fixture per `WarningCode` that (a) decodes with the matching opt-in and produces exactly one matching warning, (b) throws `MllpFramingError` with the same code under `{ strict: true }`, and (c) produces no warning at all when the deviation is absent.
  5. A developer reviewing the failure-mode suite finds fixtures for abrupt mid-frame disconnect, ACK timeout, ACK-controlId mismatch, backpressure overflow, reconnect with queued sends, and TLS handshake failure — each yields the expected typed error with matching `phase` and `cause`.
**Plans**: 4 plans (anticipated)
  - 07-PLAN-01: canonical message fixtures + round-trip harness over `InMemoryTransport` + lifecycle sequencing asserts
  - 07-PLAN-02: chunked-read fuzz suite (1-byte, random, delimiter-splitting partitions) across all canonical fixtures
  - 07-PLAN-03: tolerance fixtures (one per `WarningCode`) × strict-mode sweep
  - 07-PLAN-04: failure-mode fixtures (abrupt disconnect, ACK timeout, controlId mismatch, backpressure overflow, reconnect, TLS handshake failure) + coverage gate CI step
**UI hint**: no

### Phase 8: Examples, README & Publish
**Goal**: A developer can read the README in five minutes, run three standalone examples, understand every stable warning code, and `pnpm publish --dry-run` produces a clean tarball ready to ship to npm.
**Depends on**: Phase 7
**Requirements**: DOCS-01, DOCS-02, DOCS-03, DOCS-04, DOCS-05
**Success Criteria** (what must be TRUE):
  1. A developer cloning the repo, `cd examples/server-basic && pnpm install && pnpm start` sees a listening MLLP server; the companion `examples/client-basic` connects, sends a fixture, logs the returned ACK, and exits 0.
  2. A developer running `examples/tls` sees the server and client complete a mutual-TLS handshake with shipped test certs, exchange one message, and shut down cleanly.
  3. A developer reading `README.md` finds at the top a three-line "hello world" for both client and server, a cookbook section (auto-ACK, manual ACK, auto-reconnect, backpressure, TLS, testing via `InMemoryTransport`), the full stable warning-code table with descriptions, and an explicit "what this package does not do" section pointing at `@cosyte/hl7` for parsing.
  4. A developer running `pnpm publish --dry-run` sees a clean tarball with `dist/`, `README.md`, `LICENSE`, `CHANGELOG.md`, and `package.json`; no `test/`, `examples/`, `src/`, or dotfiles leak in; the tarball size and contents are captured in the Phase 8 summary.
  5. A developer reading `CONTRIBUTING.md` + `CHANGELOG.md` finds the same engineering bar mirrored from `@cosyte/hl7`: zero runtime deps policy, strict TypeScript policy, coverage gate, warning-code stability policy, and the Postel's Law framing rule.
**Plans**: 3 plans (anticipated)
  - 08-PLAN-01: three examples (server-basic, client-basic, tls) with self-contained `package.json` + test certs + `pnpm start` wiring
  - 08-PLAN-02: README with hello-world + cookbook + warning-code reference + "not in scope" pointer + CHANGELOG + CONTRIBUTING
  - 08-PLAN-03: `pnpm publish --dry-run` verification + tarball audit + final Phase 8 summary
**UI hint**: no

---

## Progress

| Phase | REQs | Plans | Status |
|-------|------|-------|--------|
| 1. Project Foundation | 6 | 4 | Pending |
| 2. Framing Codec & Warnings | 19 | 4 | Pending |
| 3. Transport & Lifecycle | 10 | 4 | Pending |
| 4. MLLP Server | 7 | 3 | Pending |
| 5. MLLP Client | 11 | 5 | Pending |
| 6. ACK Helpers & TLS | 9 | 3 | Pending |
| 7. Testing, Fixtures & Coverage | 6 | 4 | Pending |
| 8. Examples, README & Publish | 5 | 3 | Pending |
| **Total** | **73** | **30** | **0 %** |

## Coverage Validation

Every v1 REQ-ID from `REQUIREMENTS.md` is mapped to exactly one phase above. 73 / 73 mapped. No duplicates.

## Parallelization Notes

- Phase 4 (Server) and Phase 5 (Client) both depend on Phase 3 and are otherwise independent; the two phases may run in parallel if the workstream bandwidth allows.
- Within Phase 2, Plans 02-02 (encoder) and 02-03 (decoder state machine) operate on disjoint modules and can parallelize.
- Within Phase 5, Plans 05-02 / 05-03 / 05-04 / 05-05 touch disjoint client-side concerns (ACK timeout, controlId correlation, reconnect, backpressure) once Plan 05-01 lands the skeleton.
- Phase 7 plans can be parallelized by fixture-category (canonical / chunked-read / tolerance / failure) once Phase 6 lands.

## Dependencies

```
Phase 1 → Phase 2 → Phase 3 ─┬─→ Phase 4 ─┐
                             │             │
                             └─→ Phase 5 ─┤
                                          │
                             Phase 2 ─────┼─→ Phase 6 → Phase 7 → Phase 8
                             Phase 4 ─────┤
                             Phase 5 ─────┘
```
