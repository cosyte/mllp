# @cosyte/mllp: Project Guide for Claude

## Project

**`@cosyte/mllp`**: a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks, without reading the MLLP spec.

## Status

- **Phase 9 of 11**: client/server/framing/connection/transport shipped; Phase 6 (fail-safe ACK
  commit contract), Phase 7 (`ack-from-hl7`: real helpers over `@cosyte/hl7`'s `buildAck`, stub
  removed), Phase 8 (TLS/MLLPS hardening: `TlsTransport`, mutual TLS via `ClientAuth`, the
  `'securityWarning'`/`'tlsClientError'` events, bind-safety default `127.0.0.1` + gated wildcard
  bind), and Phase 9 (real-world interop: differential harness vs the Google Cloud MLLP adapter +
  Mirth/NextGen (`test/differential/`, `MLLP_DIFF_ADAPTER`-gated live tier), the §3 quirk corpus
  (`test/conformance/`), and a PHI/observability audit that closed the `MLLP_FRAME_TOO_LARGE`
  `snippet` payload-slice leak) done. Next: see `operations/roadmaps/mllp.md` for what follows Phase 9.
  For dev/test the
  unpublished `@cosyte/hl7` peer is consumed as a **vendored packed
  tarball** (`vendor/cosyte-hl7-0.0.0.tgz`, a devDependency): an interim mechanism until the
  cross-repo consumption decision (umbrella `PW-5` gate) lands; refresh it by re-running
  `pnpm -C ../hl7 build && pnpm -C ../hl7 pack --out ../mllp/vendor/cosyte-hl7-0.0.0.tgz`
  (`--out` resolves relative to the `-C` directory) then `pnpm remove @cosyte/hl7 &&
  pnpm add -D @cosyte/hl7@file:vendor/cosyte-hl7-0.0.0.tgz`. Note `pnpm remove` also
  strips the `peerDependencies` entry; restore it (`"@cosyte/hl7": ">=0.0.0"`) after.
- Migrated onto the shared `@cosyte/*` engineering standard (Phase E) and **renamed
  `@cosyte/hl7-mllp` → `@cosyte/mllp`**. Not yet published, so the rename is free.
- Sibling package: `@cosyte/hl7` (optional peer dep, not a runtime dep).

## Tech Stack (the shared `@cosyte/*` standard)

mllp inherits the canonical toolchain by depending on the published `@cosyte/*` config packages, not
by copying files. The source of truth is the meta-repo's `documentation/conventions.md`. This is a
summary.

- **Language:** TypeScript (strict, full rigor set incl. `noUncheckedIndexedAccess`) via
  `@cosyte/tsconfig`. **Target ES2023**, `NodeNext`.
- **Build:** dual ESM + CJS + `.d.ts` via `tsup` (`@cosyte/tsup-config`); `attw` is a publish gate
  (per-condition types: `.d.ts` for `import`, `.d.cts` for `require`) across all three subpaths
  (root, `/testing`, `/ack-from-hl7`).
- **Node:** **>= 22** (CI matrix 22 + 24).
- **Package manager:** `pnpm@10`.
- **Lint/format:** **ESLint 10** + unified `typescript-eslint` (type-checked) via
  `@cosyte/eslint-config`; Prettier via `@cosyte/prettier-config`. Lint at `--max-warnings=0`.
- **Testing:** **Vitest 4** + v8 coverage (`@cosyte/vitest-config`), per-directory >= 90 gates on
  `src/framing|client|connection|server|transport`.
- **CI/CD:** thin callers of the reusable `cosyte/.github` workflows.
- **Runtime deps:** **Zero.** Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`).
- **Peer deps:** `@cosyte/hl7` as an **optional** peer dep, referenced only from the
  `@cosyte/mllp/ack-from-hl7` subpath (tsup `external`, never bundled).
- **TLS test certs:** generated via `selfsigned` (`pnpm certs:gen`) into gitignored
  `examples/tls/certs/`; never committed.
- **License:** MIT

## Engineering Guardrails

- No `any`. No unjustified `as` casts. Use `unknown` and narrow.
- JSDoc (with `@example`) on every public export: feeds IntelliSense.
- **Buffer-first API** on every public surface, never string. HL7 v2 payloads are raw bytes with caller-managed charset decoding.
- **`Buffer.prototype.slice()` is forbidden** in `src/framing|server|client` (enforced by the local `no-restricted-syntax` ESLint rule in `eslint.config.js`). Use `.subarray()`. `.slice()` copies in modern Node.
- **Postel's Law:** decoder is liberal (tolerance opt-ins + warnings with stable codes + byte offsets), encoder is strict (always emits canonical `VT + payload + FS + CR`).
- **Stable warning codes** are a public API. Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`, `MLLP_ACK_INBOUND_UNPARSEABLE`, `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`, `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` (14 total; the last **three** are `ack-from-hl7`-scoped: emitted in `MllpAck.warnings`, not through the framing registry). `NOT_VERBATIM` is a *proof of mismatch* (a `Buffer` inbound, checked byte-for-byte); `UNVERIFIABLE` is its text-path counterpart: a `string`/`Hl7Message` inbound whose non-ASCII echo *cannot* be verified because the wire bytes were decoded before the adapter saw them (MLLP-ACK-STRING-DOUBLE-ENCODE). The two are deliberately distinct: the text path must never claim a proof it cannot run.
- **The MSH is read ONCE, in one place** (MLLP-ACK-UTF8). `src/internal/control-id.ts` owns `readMshSegment` and the MSH-10 / MSA-2 scanners built on it: `latin1` decode, MSH-1 taken from the MSH segment's 4th byte per §2.5.4 (never assumed to be `|`), the MSH **located** (the first `CR`/`LF`-delimited segment starting with `MSH`, never demanded at byte 0), and the field scan **bounded at that segment's terminator**. Three call sites must agree byte-for-byte on what a control ID *is* (the client's correlator keys its in-flight store on it, `buildRawAck` echoes it into MSA-2, and `buildMllpAck` **verifies** its own output against it) because any disagreement between two of them is an ACK the sender cannot match: timeout → resend → **duplicate clinical message**. All three now call `readMshSegment`; none re-derives the read. They each did once, and each got it wrong differently: `ascii` masking (MLLP-10 / MLLP-CORRELATOR-ASCII), a hardcoded `|` and an unbounded scan (`buildRawAck`), and a `utf8` round-trip (`buildMllpAck`). **Do not re-implement a fourth.** Two rules in it are load-bearing in opposite directions, and the gate caught a violation of each. **Bound the scan at the segment terminator**: the unbounded version returned **PID-3 (the patient's MRN)** as the "control ID" of a truncated MSH, and put it in the correlation key, in `MllpTimeoutError.messageControlId`, and in a warning message. **But locate the MSH; never demand it at byte 0**: an interim fix did, to force the three into agreement, and thereby made `buildRawAck` emit a positive `AA` with an empty MSA-2, *silently*, for a leading-`CR` or `FHS`/`BHS`-batch payload whose MSH-10 was plainly present. That is the duplicate-message failure, manufactured by the fix for it. Tightening a reader to make consumers agree is a trap: **agree at the tolerant fixed point**, because a lenient reader must never drop data that is there (Postel's Law).
- **Tolerate terminator noise; never skip DATA** (MLLP-ACK-UTF8). `buildMllpAck` strips *leading `CR`/`LF` only* before handing the payload to `parseHL7`. Those bytes carry no data, so dropping them hides nothing. It must **not** re-base on the located `MSH`, because that skips an `FHS`/`BHS` batch envelope (§2.10.3), and a batch is a **sequence** of messages: the builder then parses message 1, silently discards every later `MSH` and the `BTS`/`FTS`, and returns a positive `AA` correlated to message 1 **with zero warnings**, telling the sender the whole batch was accepted while messages 2..N went unread. An `FHS`/`BHS` envelope must keep falling through to the warned, non-positive `AE` fallback. **Batch ACK is its own feature.** Do not arrive at it by accident on the way to fixing something else, and do not "fix" the `AE` into an `AA`.
- **A warning message is a log line, so it carries no field content, ever** (MLLP-ACK-UTF8). `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` reports byte *lengths* and withholds MSH-10/MSA-2 themselves. "It's only a control ID, that's routing metadata not clinical content" is exactly the reasoning that put an MRN in a log line. The field a scanner *returns* is not always the field you asked for. Report shape, not content; the caller already holds the bytes.
- **Stable security-warning codes** (Phase 8, separate from the framing `WarningCode` union above) are also a public API: `MLLP_TLS_VERIFY_DISABLED` (client, every `secureConnect` while `tls.allowUnverified: true`) and `MLLP_BIND_ALL_INTERFACES` (server, once at `listen()` when a wildcard host is bound via `allowWildcardBind: true`). Both are emitted as a frozen `'securityWarning'` event AND via `process.emitWarning`.
- **`MllpConnectionError.connectionCause`** (public union) gained two Phase 8 values: `'tls-verify'` (certificate-verification failure) and `'tls-handshake'` (TLS-**protocol**-shaped pre-`secureConnect` failures only: `ERR_SSL_*`/`EPROTO`/OpenSSL alert-bearing, per the exported `isTlsProtocolError`; pure TCP failures on a TLS connection carry no `connectionCause`). Both classes are classified **permanent** for the reconnect classifier, never auto-reconnect-looped; plain network blips stay transient. TLS 1.3 caveat (RFC 8446 §4.4.2): `connect()` resolving does not guarantee a `clientAuth: 'MUST'` server accepted the client cert. A rejection surfaces as a typed permanent post-connect error; ACK correlation is the delivery guarantee. Phase 10 added `'framing-fatal'` (a fatal decoder throw, see the receive-path rule below), also **permanent**: a peer that is not speaking MLLP would otherwise be reconnected into forever. Existing values: `'fifo-unsafe'`, `'in-flight-orphan'`.
- **No `emit()` reachable from a callback we do not own may go uncontained, in ANY class** (MLLP-10). `EventEmitter.emit()` calls listeners **synchronously**, so a throwing subscriber unwinds the whole stack it was invoked from. When that stack bottoms out in a socket's `'data'`/`'error'`/`'secureConnect'` listener, a `net.Server`'s `'connection'` listener, a `tls.Server`'s `'tlsClientError'` listener, or the `catch` of a `void`-ed async task, the throw becomes an **uncaught exception / unhandled rejection that kills the process**, every other connection and every in-flight durable commit with it. A consumer's broken metrics tap must not be able to take down an MLLP interface. The helpers are `src/internal/safe-emit.ts` (`safeEmit` / `safeEmitError`), used by `Connection._dispatchContained`, `MllpServer._emitContained`, and `MllpClient._emitContained`; **every `this.emit(` in `src/` is inside a containment wrapper** (`Connection._dispatchContained`/`_emitErrorIfListened`, `MllpServer`/`MllpClient._emitContained`, `safeEmit`/`safeEmitError`, or an inline `try`/`catch`), with exactly one disclosed exception, the deliberate fail-loud accept-loop forwarder described at the end of this note. The gate refuted this fix **four times**, each round on a route the previous scope had missed: the decoder throw; the unlistened `'error'` emit raising `ERR_UNHANDLED_ERROR` *from inside the catch block that was the fix*; the `'message'`/`'warning'` subscribers; the five lifecycle emits reached via `destroy()` → `_transition()`; and finally the whole of `MllpServer`/`MllpClient`, because the rule had been scoped to `Connection` when **the hazard belongs to the call stack, not to a class**. Two corollaries are load-bearing beyond crash-safety: a throwing `'nack'` subscriber used to **suppress the fail-safe negative ACK** (it sat in the `catch` before `_dispatchAck`), and a throwing `'message'` subscriber used to **break ACK correlation** on the client (it ran before `_onAckPayload`, so `send()` hung forever). The structural tests in `test/connection/receive-containment.test.ts` and `test/server/framing-error-containment.test.ts` attach a throwing subscriber to **every event of all three classes at once**. A new event emitted uncontained fails them. **One deliberate exception survives:** `MllpServer`'s `net.Server` error forwarder still re-emits *unguarded* when there is **no** `'error'` listener **and** the server is serving, keeping Node's fail-loud convention for accept-loop errors (`EMFILE`/`ENFILE`). A silent accept outage on a healthcare listener must be impossible.
- **`MllpConnectionError.connectionCause`** gains `'framing-fatal'` (MLLP-10): a fatal decoder throw. Classified **permanent** by `isTransientConnectionError` (which now treats every `MLLP_*` code as permanent), so a client never auto-reconnects into a peer that is not speaking MLLP: an HTTP probe or a wrong-port misconfiguration used to produce an unbounded reconnect storm, because the classifier's `default:` branch returned *transient* and `createStarterClient` defaults `autoReconnect: true`.
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Server bind-safety (Phase 8, BREAKING pre-publish).** `MllpServer.listen()` / `createStarterServer` default host is `'127.0.0.1'` (was `'0.0.0.0'`). Binding a wildcard host requires `ServerOptions.allowWildcardBind: true`, **enforced against the OS-normalized bound address**: literal spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`, `'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`) reject pre-bind; resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, …) are caught post-bind via `server.address()` (the just-bound server closes and `listen()` rejects; no listening state, no `'listening'` event). `listen()` is **single-flight**: concurrent calls (or a call while already listening) reject with a typed error instead of racing the post-bind checks; `close()` before re-listening.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.
- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances: log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % per-directory on `src/framing/`, `src/client/`, `src/connection/`, `src/server/`, `src/transport/` (enforced by `pnpm test:coverage`).
- **In-memory transport is a first-class deliverable** (`@cosyte/mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.

## Standing disciplines (every change)

These three bind every change in this repo (mirrored from the cosyte meta-repo's
`documentation/conventions.md`):

1. **Documentation follows code.** A public-surface / stack / status change isn't done until its
   docs are: this package's own docs (`docs-content/` + JSDoc), and (in the meta-repo) its
   `documentation/repos/<repo>.md` and the `ecosystem-map.md` status table.
2. **Version + changelog every meaningful change.** Add a Changeset (`pnpm changeset`, `patch`
   during pre-alpha) and keep `CHANGELOG.md`'s `[Unreleased]` current. Stay on `0.0.x` until first alpha.
3. **Crew + knowledgebase feedback loop.** When a standard, decision, or public surface changes,
   flag whether a `crew` skill or `knowledgebase` doc needs creating/updating. Never silently skip.

Build, lint, format, and TypeScript settings come from the shared `@cosyte/*` config packages
(`@cosyte/tsconfig` · `@cosyte/eslint-config` · `@cosyte/prettier-config`; see
`documentation/conventions.md` → "Canonical toolchain (enforced)"). Node ≥ 22.
