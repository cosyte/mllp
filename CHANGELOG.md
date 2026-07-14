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
- **Docs accuracy (Phase 10).** `docs-content/intro.md` described the decoder as liberal outright.
  It is **strict by default** — tolerance is opt-in per flag, and it is `MllpServer` that ships
  tolerant defaults (`allowFsOnly`, `allowLfAfterFs`, `allowLeadingWhitespace`;
  `allowMissingLeadingVt` stays off even there).

### Added

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
