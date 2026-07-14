# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions and publishing are managed with [Changesets](https://github.com/changesets/changesets);
this file is maintained by hand (Changesets handles the version bump and publish only).

## [Unreleased]

The first pre-alpha release (`0.0.1`) will ship the v1 MLLP transport surface below. The package
begins its public history at `0.0.x`, per the cosyte version ladder (`0.0.x` until first alpha).

### Fixed

- **The MSH-10 scan ran past the segment terminator and returned the patient's MRN as the
  correlation key (MLLP-ACK-UTF8; found by the conformance gate).** `extractMshControlId` counted
  field separators without ever stopping at `CR`/`LF`. On a **truncated MSH** — one with fewer than
  10 fields, which is malformed, but is precisely what a broken peer sends — the count therefore ran
  *past the segment terminator* and kept counting inside the next segment. Given
  `MSH|^~\&|EPIC|HOSP|MIRTH|LAB` + `PID|1||MRN00042|…`, the "MSH-10" it returned was **`PID-3`: the
  patient's medical record number**. `MllpClient.send()` calls this on every outbound payload in
  controlId mode, so that value became the correlator's key, and was carried into
  `MllpTimeoutError.messageControlId` and the `MLLP_ACK_UNMATCHED_CONTROL_ID` /
  `MLLP_ACK_AFTER_TIMEOUT` warnings — **a patient identifier in a log line, and a mis-read one at
  that**, plus a correlation key that is not the control ID the peer will ACK. Present since Phase 5
  and untouched by MLLP-CORRELATOR-ASCII, which fixed the *decode* of this scan but not its
  *bounds*. Fixed: the scan is now `readMshSegment`, which bounds the MSH at its terminator before
  reading any field out of it. A field that does not exist reads as **absent**, never as the next
  segment's contents.
- **`ack-from-hl7` could not echo a control ID verbatim, so a cosyte client could not correlate a
  cosyte server's ACK (MLLP-ACK-UTF8).** `buildMllpAck` decoded the inbound through the peer
  parser's charset machinery and re-encoded the ACK through a hardcoded **`utf8`**. The two are not
  inverses. A control-ID byte `0x8B` — legal under an `MSH-18` of `8859/1`, and the exact case
  `MLLP-CORRELATOR-ASCII` had just fixed on the client — came back out of MSA-2 as the **two** bytes
  `0xC2 0x8B`: a *different* control ID, so HL7 v2.5.1 §2.9.2.2's verbatim-echo requirement was
  violated. The client keys its in-flight store on the raw bytes it sent, so it could not match that
  ACK: the send never settled → ACK timeout → resend → **duplicate clinical message**. This was the
  third and last of the three call sites that each re-derived "read the control ID" independently and
  each got it wrong differently.
  - `Buffer` input is now decoded as **`latin1`** and the ACK re-encoded with the same codec — one
    symmetric choice, so the round-trip is the exact identity for any inbound bytes. `latin1` is the
    only codec for which that holds: `ascii` masks the high bit, `utf8` folds invalid sequences onto
    `U+FFFD`, and a `TextDecoder`'s `iso-8859-1` label is aliased by the WHATWG Encoding Standard to
    **windows-1252** (`0x8B` → `U+2039`), which does not round-trip `0x80`–`0x9F` at all — so the
    decode had to be taken away from the charset-aware parser and done on the bytes directly.
    `string` / `Hl7Message` input keeps its `utf8` default (the caller already chose the decode).
  - The MSH read is now **one** implementation — `readMshSegment` in `src/internal/control-id.ts` —
    genuinely *called* by all three consumers: the client correlator, `buildRawAck`, and
    `buildMllpAck`'s verbatim check. `buildRawAck` previously re-derived its own read
    (`payload.toString("latin1").split(...)`, hunting for an `MSH` anywhere in the payload), and the
    two disagreed on real inputs: on a truncated MSH followed by a PID the correlator keyed on one
    string while `buildRawAck` echoed another, and on a payload with a leading `LF` the correlator
    gave up while `buildRawAck` happily ACKed. Every such disagreement is an ACK the sender cannot
    match. `MSH` must now **lead** the payload (§2.5.1) for any consumer to read it, so "unreadable"
    is one answer rather than three.
- **`buildRawAck` assumed `|` was the field separator instead of reading MSH-1
  (MLLP-ACK-UTF8, sibling).** MSH-1 *is* the field separator (HL7 v2.5.1 §2.5.4) — the byte at
  offset 3 of the MSH segment defines it — and the client-side scanners had always read it
  dynamically. `buildRawAck` split on a hardcoded `|`, so a `!`-delimited message yielded one field
  and **every** echoed field came back empty: the ACK went out as `MSA|AA|` with **no correlation id
  at all**, unmatchable by construction. It now reads MSH-1 and echoes the inbound's own MSH-1/MSH-2,
  which also keeps the echoed field *content* and the delimiters that define it together (re-emitting
  `ID#X` under `^~\&` silently turns two components into one). Segment splitting now tolerates `LF`
  and `CRLF` as well as `CR`, matching the scanners: an `LF`-terminated inbound previously left the
  whole message as one "MSH" segment and emitted the ACK's MSH-12 as `2.5.1\nPID`, embedding a raw
  `LF` and a stray segment id in the ACK. A framing byte (`VT`/`FS`) or segment terminator declared
  as MSH-1 is refused and falls back to a minimal ACK, so the ACK can always be framed.

- **The client's ACK correlator masked the high bit out of the correlation key
  (MLLP-CORRELATOR-ASCII).** `extractMshControlId` / `extractMsaControlId` decoded MSH-10 / MSA-2
  with `ascii` (`byte & 0x7f`) — the same class of bug the Phase 10 entry below fixed in
  `buildRawAck`, left behind on the client side since Phase 5, so the server's MSH-10 → MSA-2 echo
  and the client's read-back did not agree on what a control ID *is*. The extracted string **is**
  the correlator's key (live store, graveyard, ACK lookup), so a lossy decode is a lossy key: the
  two legal, distinct control IDs `MSGÉ1` and `MSGI1` (`0xC9 & 0x7F === 0x49`) collapsed onto one
  key, the second `enqueue()` overwrote the first in the `Map`, and the first send could never be
  settled by its own ACK. The masked ID was also what reached `MLLP_ACK_UNMATCHED_CONTROL_ID` /
  `MLLP_ACK_AFTER_TIMEOUT` observers and `MllpTimeoutError.messageControlId` — an ID that was never
  on the wire, misdirecting the operator tracing a lost message. Reachable when MSH-18 declares a
  non-ASCII charset (e.g. `8859/1`). Fixed: both extractors decode `latin1` (1:1 byte↔code-unit, so
  distinct bytes stay distinct keys and no VT/FS can be synthesized). Six tests added under
  `test/client/correlator-controlid.test.ts`, each failing under the old decode, one of them a
  cross-path round-trip pinning `buildRawAck`'s echo and the client extractors to the same key.
  Pure-ASCII control IDs are unaffected. **Scope at the time:** the two paths agreed byte-for-byte
  only for the `|`-delimited messages `buildRawAck` supported — it still hardcoded `|` where the
  extractors read the separator from MSH-1, and the `ack-from-hl7` subpath still round-tripped
  control IDs through `utf8`. Both of those were left pre-existing then, and are **closed by
  MLLP-ACK-UTF8** (above); the scanners are now a single shared implementation.

- **A peer could crash the server with one high-bit byte, and corrupt the ACK control ID
  (Phase 10).** `buildRawAck` decoded the inbound message with `ascii`, which masks the high bit
  (`byte & 0x7f`). Two consequences, both serious. **Spec:** MSA-2 must echo the inbound MSH-10
  **verbatim** (HL7 v2.5.1 §2.9.2.2), but a control-ID byte `0x8B` silently became `0x0B` — a
  *different* id — breaking the sender's own ACK correlation for any non-ASCII charset. **Safety:**
  `0x8B → 0x0B` is a **VT** and `0x9C → 0x1C` is an **FS**, so `ascii` *synthesized framing
  delimiters* from ordinary payload bytes; a peer sending one high-bit byte in an echoed MSH field
  made the ACK payload contain a real VT/FS, which `encodeFrame` (strict) rejected — and that throw
  escaped the `void`-ed `_sendCommitAck`, **crashing the whole server on peer-controlled input with
  no consumer bug at all**, and suppressing the fail-safe ACK. Fixed: `buildRawAck` uses `latin1`
  (byte-exact; a delivered payload cannot itself contain VT/FS, and `latin1` cannot synthesize
  one), and `_dispatchAck` is now **total** — a frame failure (still reachable via a caller's
  `autoAck: fn`) surfaces as a connection `'error'` and the message goes un-ACKed (fail-safe: the
  sender resends), never a process kill. New suite `test/server/ack-serialization-safety.test.ts`.
- **Anything throwing on the receive path crashed the whole process — four routes, all closed
  (Phase 10).** `FrameReader.push()` runs synchronously inside the transport's data callback, which
  on a real socket **is** the `'data'` listener, so any throw there is an **uncaught exception** that
  kills the process — every other connection and every in-flight durable commit with it. The
  conformance gate refuted the fix three times, each round surfacing a route the previous fix had
  missed — **four** in total:
  1. **The decoder's own throw** — `Connection` fed `push(chunk)` with no `try`/`catch`. Reachable on
     a **default server from a single byte**: `SERVER_DEFAULT_FRAMING` leaves `allowMissingLeadingVt`
     off, so any non-whitespace byte where a `VT` was expected threw `MLLP_MISSING_LEADING_VT`
     (`MLLP_FRAME_TOO_LARGE` reached the same path). One stray keepalive character from a real
     interface engine was enough.
  2. **`emit('error')` with no listener** — Node raises `ERR_UNHANDLED_ERROR`, and that throw happened
     *inside the catch block added for (1)*, escaping by the identical route. `MllpServer`/
     `MllpClient` each attach an `'error'` listener, which masked it; `Connection` is a public export
     and need not.
  3. **A throwing `'message'`/`'warning'` subscriber** — `onFrame` dispatches synchronously inside
     `push()`, so an ordinary consumer bug (a metrics tap, a logger) unwound through the socket
     handler too.
  4. **The five lifecycle emits** — `destroy()` → `_transition()` → `emit('stateChange'|'close'|…)`
     runs *inside* the catch block added for (1), and a throw raised inside a `catch` is **not**
     caught by that block. A throwing `'close'` subscriber plus one stray byte still killed the
     process, four frames up.

  Enumerating routes one at a time is what produced a fourth, so the rule is now **structural: no
  `emit()` in `Connection` may reach a transport callback.** All eight events dispatch through
  containment, pinned by a test that attaches a throwing subscriber to every one of them at once.

  Now: a fatal framing error surfaces as a frozen `'error'` event (`phase: 'receive'`,
  `connectionCause: 'framing-fatal'`, the `MllpFramingError` preserved as `cause` so the stable
  `code`/`byteOffset` survive) and **only that connection** is destroyed — a server drops the one bad
  peer and keeps serving. Every `'error'` emit is guarded by `listenerCount` and wrapped. Subscriber
  throws are contained per-subscriber at the dispatch site — what WARN-06 always promised but only
  half-implemented (the `onWarning` *option* was guarded; the event broadcast was not). A fatal
  framing error is also reported **exactly once** now — `destroy(err)` forwards the reason to
  `transport.destroy(err)`, which made a real socket echo it back through `_onTransportError` and
  emit a second, causeless `'error'`, double-counting on an alerting dashboard. The
  connection is destroyed rather than resynchronized deliberately: after a throw the reader's position
  in the byte stream is untrustworthy, and guessing where the next frame begins is how a clinical
  message gets silently mis-split. The existing suites missed all of this because the in-memory
  transport wraps delivery in `try`/`finally`, re-routing the throw to the *writer*; only a real
  socket reproduces it. New suites: `test/server/framing-error-containment.test.ts` (real loopback
  sockets) and `test/connection/receive-containment.test.ts` (drives the data callback directly) —
  both verified to fail without the fixes.
- **A fatal framing error triggered an unbounded reconnect storm (Phase 10).**
  `isTransientConnectionError` switches on `err.code` and fell through to `default: return true`, so a
  `MllpFramingError` was classified **transient**. `createStarterClient` (where `autoReconnect`
  defaults **on**) therefore retried forever against a peer that was not speaking MLLP — an HTTP probe,
  a health check, a wrong-port misconfiguration — with the backoff hammering an interface engine that
  was already misconfigured. `MLLP_*` codes are now **permanent**, alongside the TLS classes and for
  the same reason: every reconnect meets the same bytes.
- **A throwing `'message'` observer suppressed the ACK (Phase 10).** `MllpServer` emits `'message'` to
  observers *before* ACK dispatch (D-03), so an observer that threw aborted the handler before the ACK
  was sent — one broken logger silently turned every message into a no-ACK, and every sender resent
  forever with nothing to diagnose it by. The emit is now contained: the throw surfaces on `'error'`
  and the commit contract proceeds untouched. The ACK decision belongs to `ServerOptions.onMessage`
  (the durable-commit step), not to a metrics tap.
- **Release pipeline could not have released (Phase 10).** The shared `cosyte/.github` release
  workflow drives Changesets with `version: pnpm run version`, but no `version` script existed —
  it failed with `ERR_PNPM_NO_SCRIPT`, so the "Version Packages" PR could never be opened. Added
  `version` (`changeset version` → `scripts/sync-version.mjs` → `prettier --write`).
- **The `VERSION` export would have lied about the release (Phase 10).** `VERSION` was hardcoded
  `"0.0.0"` in `src/index.ts`, while `changeset version` bumps only `package.json` — the published
  `0.0.1` would have exported `"0.0.0"`. `scripts/sync-version.mjs` now rewrites the constant from
  `package.json` inside the `version` script, and `test/sanity.test.ts` compares the export against
  `package.json` rather than asserting a hardcoded literal against a hardcoded literal (the old
  test would have stayed green through precisely this drift).
- **`VERSION` had a literal type in the published `.d.ts` (Phase 10).** It declared
  `const VERSION = "0.0.0"`, leaking the current release into consumers' types and turning an
  equality check against any other version into a compile error. Now `VERSION: string`.
- **Docs accuracy (Phase 10).** Found by the conformance gate, which refuted the first cut of the
  new guide:
  - `docs-content/intro.md` described the decoder as liberal outright. It is **strict by default** —
    tolerance is opt-in per flag, and it is `MllpServer` that ships tolerant defaults (`allowFsOnly`,
    `allowLfAfterFs`, `allowLeadingWhitespace`; `allowMissingLeadingVt` stays off even there).
  - `MLLP_TRAILING_BYTES` is **not** benign junk between frames. It fires on a `VT` appearing
    *mid-payload* — which **discards the accumulated partial payload**, i.e. a **truncated**
    message — and on a stray byte after `FS` under `allowFsOnly`. Now documented as something to
    alert on rather than ignore.
  - **`close()` does not drain in-flight messages** — it *rejects* them with
    `MllpConnectionError({ phase: 'close' })`. No drain hook is wired to the `DRAINING` state, so
    `drainTimeoutMs` does not currently bound an in-flight ACK wait on the client. A message in
    flight at shutdown is an **unknown**, not a failure: the receiver may have committed it. Now
    stated honestly in the reliability guide and the limitations page, with the "await your sends,
    then close" pattern.
  - The absolute PHI claim ("never echoes message content") is now precise: diagnostics never echo a
    *run* of content, but the single-byte `snippet` on `MLLP_MISSING_LEADING_VT` is by definition the
    first byte of unframed content.

### Added

- **`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` (MLLP-ACK-UTF8).** A new stable warning code —
  `ack-from-hl7`-scoped, emitted in `MllpAck.warnings`, not through the framing registry (13 codes
  total now). `buildMllpAck` **verifies** every ACK it builds against the very byte-level scanners the
  `@cosyte/mllp` client uses to correlate, and warns when MSA-2 is not byte-identical to the inbound
  MSH-10 (HL7 v2.5.1 §2.9.2.2). The warning reports the two byte **lengths** and withholds the
  field values — MSH-10 is inbound payload content and a warning goes to a log. The ACK is still
  emitted — a
  mismatched ACK beats silence — but the mismatch can no longer pass unremarked, because a
  non-verbatim MSA-2 *is* an ACK the sender cannot match. It fires for an `encoding` override that
  cannot round-trip the inbound bytes, and for an inbound declaring non-default delimiters or a
  whitespace-padded control ID — cases `@cosyte/hl7`'s builder structurally cannot represent (it
  always emits `|^~\&`, and trims field whitespace). `buildRawAck` is parser-free and has neither
  limit, so it remains the answer for a non-default-delimiter peer.
- **`ConnectionErrorCause` gains `'framing-fatal'` (Phase 10).** Public union. Attached to the
  `'error'` event when the decoder throws; classified **permanent** by `isTransientConnectionError`,
  so a client never auto-reconnects into a peer that is not speaking MLLP.
- **Release readiness for `0.0.1` (Phase 10).**
  - **Publish pipeline proven without burning a version.** New `publish:dry` script
    (`pnpm publish --dry-run --no-git-checks`). Verified end to end: the `prepublishOnly` chain
    (clean → typecheck → lint → test → build → `attw`) is green; `changeset version` consumes the
    pending changesets to exactly **`0.0.1`**; the dry-run packs 24 files (`dist/` + README +
    LICENSE + CHANGELOG) with public access and no `src/`, `test/`, or `vendor/` leakage;
    `pack:docs` produces both docs artifacts. **Nothing was published** — the first real publish
    is a human gate.
  - **Full `docs-content/` transport guide.** New pages: **Framing & tolerance** (wire format, the
    opt-in tolerance flags with a `FrameReader`-vs-`MllpServer` default table, the stable
    warning-code registry, bounded accumulators, the PHI contract on diagnostics); **ACKs & the
    commit contract** (fail-safe ACK semantics, the three `autoAck` modes, the transport-accept
    caveat, FIFO-vs-control-id correlation, `ack-from-hl7`); **Connection, reconnect &
    backpressure** (the 6-state machine, jittered exponential backoff, the transient-vs-permanent
    classifier, keepalive vs dead-peer timeout, high-water marks, graceful drain); and **Known
    limitations & non-goals** (at-least-once at best, no queue/replay, no MLLP R2, no Epic/Cerner
    differential verification, no PKI, not byte-transparent, pre-stable API). Sidebar updated; all
    examples synthetic.
  - **README** now documents the commit contract and the non-goals, not just the feature list.

- **Real-world interop, differential conformance & PHI/observability audit (Phase 9).**
  - **PHI hardening (framing).** `MllpFramingError.snippet` no longer carries a run of payload content
    bytes on **either** framing path. (1) The decoder's `MLLP_FRAME_TOO_LARGE` used to copy the last 32
    accumulated payload bytes into `snippet` (the too-large frame is a full HL7 message) — now empty (the
    anomaly is the frame's *size*, not a byte). (2) The encoder's `MLLP_PAYLOAD_CONTAINS_VT`/`_FS` (strict,
    reachable from `client.send()`) copied up to 64 payload bytes around the offending delimiter — now
    just the single offending delimiter byte (a VT/FS control byte the `code` already names). Every
    framing throw now carries at most the single framing-boundary byte that broke the structure, never a
    payload run; the `snippet` PHI contract is documented on the field. No public-API change.
  - **Differential harness** (`test/differential/`) — byte-parity with the Google Cloud Healthcare MLLP
    adapter and Mirth/NextGen Connect (both R1). Tier 1 (always on) asserts decode + `encodeFrame`
    byte-parity against canonical R1 golden frames and ACK correlation; Tier 2 (`MLLP_DIFF_ADAPTER`
    opt-in) checks a live adapter and skips cleanly when unset, so `verify` stays green.
  - **Quirk corpus** (`test/conformance/`) — a realistic multi-segment HL7 message driven through each
    §3 real-world deviation, asserting the exact warning code/typed error and byte-identical payload
    recovery; the lenient decoder never throws except the sanctioned `MLLP_FRAME_TOO_LARGE`.
  - **PHI-safety property suite** — generative proof (mutation-checked) that no framing diagnostic ever
    echoes payload content, including the oversized path.
  - **Test-infra:** the pre-existing `test/server/*` suites now use the shared
    `test/helpers/tracked-servers.ts` (`must()` + `makeServerTracker()`) instead of copy-pasted helpers.
  - **Scope note:** the remaining Phase 9 roadmap acceptance items — (c) keepalive / half-open
    detection and (d) fuzz chunk-boundary adversaries — were already delivered in earlier phases
    (`socket.setKeepAlive` in `src/server/server.ts`; the byte-at-a-time `randomChunks` /
    `split(1)` generators in `test/property/fuzz.property.test.ts`), so Phase 9 legitimately
    narrows to the PHI snippet audit + differential harness + quirk corpus.
- **TLS / MLLPS hardening (Phase 8).** `TlsTransport` (wraps `tls.TLSSocket`, maps `onConnect` to
  `'secureConnect'`) joins `NetTransport` as a first-class `Transport`. Client: `ClientOptions.tls?:
  TlsOptions | true` — verification **on by default**; the only opt-out is the loud
  `allowUnverified` flag, which emits a frozen `'securityWarning'` (`MLLP_TLS_VERIFY_DISABLED`) +
  `process.emitWarning` on every `secureConnect` (initial connect and every reconnect). Server:
  `ServerOptions.tls?: ServerTlsOptions` with `clientAuth: 'NONE' | 'WANT' | 'MUST'` (ATNA ITI-19
  mutual node authentication) — `'WANT'`/`'MUST'` surface a minimal, content-free `peerCertificate`
  (`{ subjectCN, issuerCN, validTo, authorized }`) on the `'connection'` event; `authorized`
  reports whether the chain was verified against `ca` (under `'WANT'` a certificate can be present
  yet unverified — never authorize on `subjectCN` alone); `'MUST'` additionally rejects
  unauthorized/missing client certificates. Failed handshakes (incl. rejected mTLS client certs)
  never crash the server: a frozen `'tlsClientError'` event (`{ remoteAddress, remotePort, message,
  code, timestamp }`) is emitted and the server keeps accepting other connections. Both `minVersion`
  default to `'TLSv1.2'` — the IHE ATNA ITI-19 "TLS 1.2 Floor" (BCP195) floor (ITI TF-2 §3.19.6.2.3);
  `'TLSv1.0'/'TLSv1.1'` are not expressible through this API. No bundled cipher list — `ciphers`
  passes through to Node's OpenSSL defaults, which already include both ATNA-mandated ECDHE suites.
  New typed failure modes on `MllpConnectionError.connectionCause`: `'tls-verify'` (certificate
  verification failure) and `'tls-handshake'` (TLS-**protocol**-shaped pre-`secureConnect` failures
  only — `ERR_SSL_*`, `EPROTO`, OpenSSL alert-bearing errors; pure TCP failures like `ECONNREFUSED`
  carry no `connectionCause`, same as plaintext). Both classes are **permanent** for the reconnect
  classifier — never auto-reconnect-looped into a misconfigured or MITM'd endpoint — while plain
  network blips stay transient. TLS 1.3 honesty note (RFC 8446 §4.4.2): `connect()` resolving does
  NOT guarantee a `clientAuth: 'MUST'` server accepted the client certificate — a rejection
  surfaces moments later as a typed post-connect error classified permanent; ACK correlation
  remains the delivery guarantee. New exported helpers `isTlsVerificationErrorCode(code)` and
  `isTlsProtocolError(err)`. New stats fields: `ClientStats.tls`, `ServerStats.tls`,
  `ServerStats.tlsClientErrorsTotal`. New root exports: `TlsTransport`, `TlsOptions`,
  `ServerTlsOptions`, `ClientAuth`, `SecurityWarning`, `MLLP_TLS_VERIFY_DISABLED`,
  `MLLP_BIND_ALL_INTERFACES`, `isTlsVerificationErrorCode`, `isTlsProtocolError`. See
  `docs-content/tls.md` for the full guide (mTLS table, TLS-1.3 client-cert-rejection note,
  known limitations).
- **`@cosyte/mllp/ack-from-hl7` — real helpers (Phase 7); stub removed.** A thin transport
  adapter over `@cosyte/hl7`'s `buildAck` (hl7 owns ACK content + the HL7 control tables;
  this package frames and correlates — O-1 boundary). New surface: `buildMllpAck(inbound,
  { code, error?, encoding?, allowDelimiterBytesInPayload? })` returning a frozen `MllpAck`
  (`frame` ready-to-write MLLP bytes, unframed `payload`, the built `ack` message,
  `requestedCode` vs emitted `code`, verbatim `correlationId`, detected `mode`, content-free
  `warnings`); the six Table-0008 conveniences `buildAckAA/AE/AR/CA/CE/CR`; `detectMode`
  (original-vs-enhanced from MSH-15/16); lazy peer loading with a typed
  `MllpPeerMissingError` (`MLLP_PEER_MISSING`) when `@cosyte/hl7` is absent; and the
  `loadHl7Peer` seam. Fail-safe by construction: a fatally-unparseable inbound never yields
  a positive ACK (`AA`→`AE`, `CA`→`CE` via the peer's `downgradePositiveAck` — no divergent
  copy of the pair), MSA-2 stays empty, and the result carries the new stable warning code
  **`MLLP_ACK_INBOUND_UNPARSEABLE`** (public API; 12 codes total). A parseable inbound with
  no MSH-10 rides the peer's own downgrade + `ACK_NO_CORRELATION_ID`. MSA-2 echoes the
  inbound MSH-10 whole — delimiter-bearing vendor-quirk ids (`ID^X`) byte-exact, matching
  this package's own raw-bytes client correlator (escape-bearing ids canonicalize; see the
  docs' known limitations).
- **Dev/test consumption of the unpublished `@cosyte/hl7` peer** via a vendored packed
  tarball (`vendor/cosyte-hl7-0.0.0.tgz`, devDependency) so the accuracy suite runs against
  the real peer in CI — an interim mechanism until the cross-repo consumption decision
  lands; the runtime peer stays optional and is never bundled (`external` in tsup).

### Security

- **Dev-dependency advisory remediation (no runtime impact — `@cosyte/mllp`
  ships zero runtime dependencies, so the published artifact is unchanged).**
  Added scoped `pnpm.overrides` pinning two transitive **dev/build-time**
  packages to their patched releases: `esbuild` (`>=0.27.3 <0.28.1` →
  `0.28.1`; GHSA dev-server path-traversal — not reachable here: the library
  builds via `tsup`/`vitest` and never runs `esbuild serve`) and the
  `@changesets/parse` copy of `js-yaml` (`>=4.0.0 <4.2.0` → `4.2.0`;
  GHSA-h67p-54hq-rp68 merge-key DoS). The `js-yaml@3.14.2` pulled by
  `read-yaml-file@1.1.0` (via `@manypkg/get-packages` → `@changesets/cli`) is
  **intentionally left**: it calls `yaml.safeLoad`, removed/throwing in
  js-yaml 4, so it cannot be force-upgraded without breaking the release
  tooling, and it only parses trusted local repo YAML at release time. This is
  the shared canonical override block, enforced suite-wide by the
  `@cosyte/config` drift check.

### Added

- **MLLP client + server** — production-grade client and server with framing
  (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff, and backpressure.
  Buffer-first API on every public surface.
- **Explicit 6-state connection machine** — `CONNECTING | CONNECTED | DRAINING | RECONNECTING |
  DISCONNECTED | CLOSED`, with `stateChange` events carrying `{ from, to, reason }`.
- **Framing** — `FrameReader` with a bounded 16 MB default accumulator (`MLLP_FRAME_TOO_LARGE` on
  overflow); strict encoder, lenient decoder (Postel's Law).
- **11 stable warning codes** with byte-offset context (`MLLP_MISSING_LEADING_VT`,
  `MLLP_FS_WITHOUT_CR`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, …).
- **TLS** support; `AbortSignal` on every awaitable and `Symbol.asyncDispose` on every closeable.
- **In-memory transport** (`@cosyte/mllp/testing`) — a deterministic, socket-free test double.
- **`ack-from-hl7` subpath** — placeholder for building ACKs from parsed messages via the optional
  `@cosyte/hl7` peer (helpers not yet implemented; Phase 6).
- **Property + fuzz test layer** for the framing transport, built on the shared
  `@cosyte/test-utils` conformance kit and `fast-check` (both dev-only). Covers: codec round-trip
  byte fidelity (`encode → decode`) via `roundTripProperty`; lenient-decoder robustness
  (malformed-but-recoverable frames recover into warnings, only `MLLP_FRAME_TOO_LARGE` throws) via
  `lenientNeverThrowsProperty`; frozen-event-payload immutability via `immutabilityProperty`; a
  warning-code surface snapshot tripwire via `sortedCodeSet`; and a transport-robustness **fuzz**
  property feeding arbitrary random byte buffers and chunk-splits through `FrameReader` over the
  in-memory transport. Test-only — no public-surface change.

- **Fail-safe ACK semantics & the commit contract (Phase 6, HL7 v2.5.1 §2.9.2).** A positive
  acknowledgement (`AA`) can never precede a successful durable commit: with `autoAck: 'AA'` + an
  `onMessage` handler the server **awaits the handler (the commit step) then ACKs** — `AA` on resolve,
  a **negative** code on throw/reject (`AE` by default; `AR` via `MllpAckError`), never `AA` before
  commit. `autoAck: 'AA'` without a handler is a documented **transport-accept** (received+framed, not
  application-processed). New public surface: `buildRawAck` (parser-free byte-level ACK builder echoing
  inbound `MSH-10` into `MSA-2`, never throwing on malformed input), the HL7 Table 0008 `AckCode` /
  `NegativeAckCode` unions, `MllpAckError`, `resolveNackCode`, and a PHI-safe `'nack'` event
  (`{ connectionId, ackCode }`) with its `NackEvent` type. No payload content or thrown error text ever
  reaches the wire, logs, or events — only routing/control metadata and the static ack code.
- **Package metadata** — added `homepage` and `bugs` fields to `package.json` for npm completeness.

### Changed

- **Server bind-safety hardening (Phase 8; BREAKING pre-publish — free before first release).**
  `MllpServer.listen()` / `createStarterServer` default bind host changed `'0.0.0.0'` →
  `'127.0.0.1'`. Binding a wildcard host now requires `ServerOptions.allowWildcardBind: true` —
  **enforced against the OS-normalized bound address**, not the requested spelling. Literal
  wildcard spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`, `'0:0:0:0:0:0:0:0'`,
  `'::ffff:0.0.0.0'`) reject with a typed `MllpConnectionError` **before** binding;
  resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, …) are caught by a post-bind check
  on `server.address()` — the just-bound server closes immediately and `listen()` rejects,
  leaving no listening state and emitting no `'listening'` event. `listen()` is **single-flight**:
  a call while the server is already listening, or while another `listen()` is in flight, rejects
  with a typed `MllpConnectionError` instead of racing the first call's post-bind checks (a lost
  race could otherwise record listening state for a bind that no longer exists); `close()` before
  re-listening. When a wildcard host IS bound with the flag set, the server emits a one-time
  frozen `'securityWarning'` (`MLLP_BIND_ALL_INTERFACES`) + `process.emitWarning`, keyed off the
  bound address.
- **Renamed the package `@cosyte/hl7-mllp` → `@cosyte/mllp`.** Not yet published, so no deprecation
  path is needed; all imports, the `/testing` and `/ack-from-hl7` subpaths, and the optional
  `@cosyte/hl7` peer dependency are unchanged.
- **Adopted the shared `@cosyte/*` engineering standard (Phase E).** Build via `@cosyte/tsup-config`
  (`cosyteTsup`), tests via `@cosyte/vitest-config` (`cosyteVitest`), lint via `@cosyte/eslint-config`
  (ESLint 10 + `typescript-eslint`) at `--max-warnings=0`, Prettier 3.8. Exact-pinned dev tooling,
  canonical scripts (incl. `clean`, `attw --pack .`), per-condition `.d.cts` types on every `exports`
  subpath, and thin-caller `ci.yml` / `release.yml` over `cosyte/.github`. Target bumped ES2022 →
  ES2023.
- **Re-enabled the coverage gate** at per-directory >= 90 on
  `framing|client|connection|server|transport` (was disabled).
- **Restored the JSDoc `error` gate** (the local `warn` downgrade was removed) and reformatted the
  source to the shared Prettier config (double quotes); no behavior change.

### Removed

- **`mitata` benchmark dependency and the `bench` script** — the script had no benchmark files.

### Deprecated

### Fixed

- **Bind errors no longer crash a server with no `'error'` listener (Phase 8 residuals, MLLP-8.1).**
  The constructor-time `net.Server`/`tls.Server` `'error'` forwarder ran before `listen()`'s own
  rejection handler and re-emitted unconditionally — on a server with no `'error'` listener, a plain
  bind error (`EADDRINUSE`, `EACCES`, …) crashed the process (unlistened `EventEmitter` `'error'`
  emissions throw) instead of rejecting the `listen()` promise. The forwarder is now guarded by
  **server state**, and the error contract is documented: with a listener attached, always
  forwarded; with none, a bind-window error rejects the `listen()` promise (the **primary** error
  surface — caveat: an `'error'` listener that synchronously calls `close()` during the bind window
  changes the rejection to the typed close-during-listen error), a stale error after `close()` is
  dropped, and a runtime error **while serving** (e.g. accept-loop `EMFILE`) deliberately keeps
  Node's fail-loud crash-on-unlistened-`'error'` convention — a silent accept outage is impossible.
  A throwing `'listening'`/`'securityWarning'` subscriber can no longer strand the `listen()`
  promise and wedge the single-flight guard: each emit is contained separately (a throw in one
  subscriber cannot suppress a later emission — in particular the `MLLP_BIND_ALL_INTERFACES`
  security warning always survives, with the operator-channel `process.emitWarning` fired first so
  no event listener can ever suppress it), the throw is surfaced via the guarded `'error'` tap
  (itself contained against a double throw), and `listen()` still resolves. Also consolidates `listen()`'s five hand-woven settle paths (abort,
  close-during-listen, no-address reject, post-bind wildcard reject, bind error) into one idempotent
  first-caller-wins settle helper — no path can leak a listener, strand the single-flight guard, or
  re-settle a settled promise — and documents three subtleties: the post-bind wildcard reject window
  is accept-safe (the check runs synchronously on `'listening'`, before any connection can be
  delivered); `close({ signal })` with an **already-aborted** signal is a no-op `AbortError`
  rejection that does **not** settle an in-flight `listen()` (which continues and settles on its own
  bind outcome); and once the bind has succeeded, an abort of the listen signal fired from inside a
  `'listening'`/`'securityWarning'` handler is deliberately **too late** — the bind wins and
  `listen()` resolves (use `close()` to shut down), so aborted-mid-emit can never strand
  `listening: true` on a closed socket.

### Security

[Unreleased]: https://github.com/cosyte/mllp/commits/main
