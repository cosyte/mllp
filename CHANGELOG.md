# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions and publishing are managed with [Changesets](https://github.com/changesets/changesets);
this file is maintained by hand (Changesets handles the version bump and publish only).

## [Unreleased]

The first pre-alpha release (`0.0.1`) will ship the v1 MLLP transport surface below. The package
begins its public history at `0.0.x`, per the cosyte version ladder (`0.0.x` until first alpha).

### Added

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

### Security

[Unreleased]: https://github.com/cosyte/mllp/commits/main
