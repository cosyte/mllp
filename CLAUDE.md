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
- **Em-dash brand gate armed.** `scripts/check-no-emdash.sh` (`pnpm check:no-emdash`) plus
  `.github/workflows/no-emdash.yml` enforce the founder directive banning `U+2014` outright
  (`knowledgebase/06-brand/voice-and-tone.md`, "No em dashes. Ever."). It scans **both** halves the
  rule covers: every tracked file, **and** the PR title, body, and commit messages, on the
  non-default `edited` trigger so retitling a PR re-checks it. What lands on `main` here is a repo
  setting, read rather than assumed: `squash_merge_commit_title: COMMIT_OR_PR_TITLE` and
  `squash_merge_commit_message: COMMIT_MESSAGES`, with squash the only merge method enabled, so
  the subject comes from the PR title (or from the lone commit's subject, when the branch has
  exactly one) and the body from the branch commit messages. The PR body does **not** land; the
  gate scans it anyway, as deliberate over-strictness on a surface that costs nothing to cover.
  mllp was already clean when this landed, **measured over all 152 tracked files byte by byte, not
  over markdown alone** (a markdown-only count is what wrongly cleared `dicom`, which held six live
  em dashes in four non-markdown files including its npm `description`), so the gate changed no
  content and exists purely to stop a regression.
  **The script is composed from three copies, and the composition is the thing to understand
  before editing it.** Base: `website`'s **NUL-exclusion** shape, because this repo tracks one
  binary. Plus `ncpdp`'s two route fixes (a tracked file named exactly `-` was read as **standard
  input** and never opened, so the gate printed OK over a live em dash; `-d skip` silently passed a
  tracked **symlink to a directory**). Plus `dicom`'s **binary-match diagnostic branch**. This copy
  applies the `./` prefix in the list-building loop instead of through `sed -z`, so the scan is a
  single command with the stderr capture bound to all of it, which closes a residual the `ncpdp`
  and `dicom` copies still carry.
  **Why not the text-only shape the other parsers run, since `vendor/cosyte-hl7-0.0.0.tgz` has no
  em dash in it today:** the reason is durability, not a present-day red. That tarball is a
  compressed stream, it is re-vendored by hand (see the Phase 9 note above), and a compressed
  stream can contain `E2 80 94` by coincidence. Measured both ways against the real file: `dicom`'s
  copy is green on today's bytes and **red, unremediably, on a copy seeded with those three bytes**.
  You cannot rewrite a compressed byte stream with a period, and a red with no fix is a gate
  someone disables.
  **The disclosed cost, said plainly: a tracked TEXT file holding a NUL byte is silently exempt,
  and seeding the tarball itself with a live em dash leaves this gate green. That is a miss, not a
  pass.** mllp has no NUL-bearing text file today, so the exclusion currently exempts exactly one
  file and that file is a genuine binary. **Do not round that off to "hypothetical here": the
  at-risk fixture class already exists.** `git ls-files --eol` calls **four** files binary, not
  one: the tarball plus the three `test/differential/fixtures/*.frame.bin` captures, which git
  classifies on its lone-CR branch because an HL7 v2 segment terminator is `CR` with no `LF`.
  Those three hold **zero** NUL bytes, so they stay in scope, and that was **proved, not
  assumed**: each was seeded with a live em dash in turn and the gate went red naming the file.
  But `test/differential/fixtures/README.md` invites replacing any of them with a real capture
  from a live adapter run, and a capture carrying a NUL would leave the scan silently. **The tell
  is the excluded count on the OK line: it reads 1 today.** If a NUL-bearing text fixture ever
  lands, revisit the partition (the `.gitattributes` declaration `pathways` prefers), never the
  ban. One disclosed property of a red on those fixtures: the hit echoes the matching *line*, and
  a CR-delimited frame is one line, so a whole message lands in a public CI log. Acceptable and
  deliberately un-truncated, because the fixtures are synthetic by policy and `pnpm phi-scan`
  gates that policy over the same files. **Do not add `grep -I`**: measured on GNU grep 3.8, a text
  file whose bad byte sits on the same line as the em dash is skipped by `-I` in total silence, and
  the gate prints OK. When the gate goes red the fix is never to re-encode the character: rewrite
  with a period, colon, comma, or parentheses. Remaining known limits are in the script header and
  are shared across every copy, so fix them there, not here.
- **The PHI scanner's enumeration is narrowed, and the refusal is not softened.** `all` mode lists
  `test/` + `src/`, then reads; a file removed inside that window used to refuse the whole sweep.
  **Exactly one case is tolerated** now: a file the walk enumerated **itself**, that **git does not
  track**, failing with **`ENOENT`**, reported on stderr as skipped, never silent. Still refusing: a
  tracked file that cannot be read, any non-`ENOENT` failure, a tolerated file back on disk at
  sweep end, a `git` that cannot report the tracked set, and an **empty** tracked set. `all` mode
  also refuses when it observed **no** files. **▶ NEVER soften the refuse-a-scan-that-observed-
  nothing rule** and never widen the tolerance; narrow the enumeration instead. **This repo is the
  one that could actually reach it**, because `test/scripts/phi-scan.test.ts` `mkdtemp`s capture
  directories inside `test/`, a walk root (measured: ~510 ms each, twice per suite run). Those
  tests must keep writing there, the `test/` prefix IS what they prove. A repo-root `tsup`
  transient is out of scope only because neither walk root is the repo root, so **widening a walk
  root reintroduces this verbatim**. **The test technique is the reusable part:** the scanner runs
  `git` between the walk and the first read, so a `git` shim first on `PATH` is a deterministic
  hook into exactly that gap, with **no sleep and no real build** (five of the eight tests use it).
  Contract and residuals are in `phi-scan-overrides.md`: a path-keyed re-check misses a mid-sweep
  rename; the **back-on-disk re-check is unpinned** (stubbing it leaves the suite green, and pinning
  it needs the load-sensitive sleep this defect argues against); `walk()` skips symlinks; and
  `walk()`'s own `existsSync`->`readdirSync` race exits **1**, the code reserved for "hits found".
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
- **The MSH is read ONCE, in one place** (MLLP-ACK-UTF8). `src/internal/control-id.ts` owns `readMshSegment` and the MSH-10 / MSA-2 scanners built on it: `latin1` decode, MSH-1 taken from the MSH segment's 4th byte per §2.5.4 (never assumed to be `|`), the MSH **located** (the first `CR`/`LF`-delimited segment starting with `MSH`, never demanded at byte 0), and the field scan **bounded at that segment's terminator**. Three call sites must agree byte-for-byte on what a control ID *is* (the client's correlator keys its in-flight store on it, `buildRawAck` echoes it into MSA-2, and `buildMllpAck` **verifies** its own output against it) because any disagreement between two of them is an ACK the sender cannot match: timeout → resend → **duplicate clinical message**. All three now call `readMshSegment`; none re-derives the read. They each did once, and each got it wrong differently: `ascii` masking (MLLP-10 / MLLP-CORRELATOR-ASCII), a hardcoded `|` and an unbounded scan (`buildRawAck`), and a `utf8` round-trip (`buildMllpAck`). **Do not re-implement a fourth.** Two rules in it are load-bearing in opposite directions, and the gate caught a violation of each. **Bound the scan at the segment terminator**: the unbounded version returned **PID-3 (the patient's MRN)** as the "control ID" of a truncated MSH, and put it in the correlation key, in the ACK timeout error, and in a warning message. **But locate the MSH; never demand it at byte 0**: an interim fix did, to force the three into agreement, and thereby made `buildRawAck` emit a positive `AA` with an empty MSA-2, *silently*, for a leading-`CR` or `FHS`/`BHS`-batch payload whose MSH-10 was plainly present. That is the duplicate-message failure, manufactured by the fix for it. Tightening a reader to make consumers agree is a trap: **agree at the tolerant fixed point**, because a lenient reader must never drop data that is there (Postel's Law).
- **Tolerate terminator noise; never skip DATA** (MLLP-ACK-UTF8). `buildMllpAck` strips *leading `CR`/`LF` only* before handing the payload to `parseHL7`. Those bytes carry no data, so dropping them hides nothing. It must **not** re-base on the located `MSH`, because that skips an `FHS`/`BHS` batch envelope (§2.10.3), and a batch is a **sequence** of messages: the builder then parses message 1, silently discards every later `MSH` and the `BTS`/`FTS`, and returns a positive `AA` correlated to message 1 **with zero warnings**, telling the sender the whole batch was accepted while messages 2..N went unread. An `FHS`/`BHS` envelope must keep falling through to the warned, non-positive `AE` fallback. **Batch ACK is its own feature.** Do not arrive at it by accident on the way to fixing something else, and do not "fix" the `AE` into an `AA`.
- **A warning message is a log line, so it carries no field content, ever** (MLLP-ACK-UTF8). `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` reports byte *lengths* and withholds MSH-10/MSA-2 themselves. "It's only a control ID, that's routing metadata not clinical content" is exactly the reasoning that put an MRN in a log line. The field a scanner *returns* is not always the field you asked for. Report shape, not content; the caller already holds the bytes.
  **The same answer now binds ACK CORRELATION, and it took a second defect to get there** (`PHI-WARNING-MESSAGE-LEAK`). The `correlateByControlId` path was writing `controlId=${...}` into a warning message and `Unmatched ACK control ID: ${...}` into an `MllpFramingError`, the second built from the **peer's** MSA-2 read off an inbound frame: measured, a 1,000,000-byte MSA-2 produced a 1,000,026-byte `Error.message`. `MllpTimeoutError` carried the ID on a field of its own, on an `Error`, whose `stack` is what an error reporter ships off the box. **The distinguishing property is not the wording, it is whether the factory takes a value parameter at all.** `src/client/ack-diagnostics.ts` is a frozen registry, one literal per code, and `ackDiagnosticMessage(code)` takes only a code; the `Correlator` hands its consumers `controlIdBytes` and never the string, so nothing downstream of it *has* an ID to interpolate. Do not add a value parameter to either. A truncated ID is not a middle ground and neither is a hex rendering: both still grow the diagnostic with the input and both still disclose the bytes.
  **And the test has to reach the client.** `test/property/phi-safety.property.test.ts` was green over this the whole time because it constructs a `FrameReader` and never a client, so the three surfaces `src/internal/control-id.ts` names as where a control ID travels were the three it could not reach. `test/phi/diagnostic-phi-leak.test.ts` binds the shared `assertNoDiagnosticPhiLeak` runner, stands up a real client over `InMemoryTransport.pair()`, and declares a code per slot so a probe that never entered the branch fails instead of passing. **`@cosyte/test-utils` must stay pinned at `^0.0.2` or higher**: a caret on a `0.0.x` version resolves to that version *exactly*, so `^0.0.1` installs a kit with no runner in it and the suite passes for the wrong reason.
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

4. **No internal project bookkeeping on a public surface** (founder directive, 2026-07-27). What a
   consumer reads (`README.md`, `docs-content/`, the npm `description`, a release body, and the
   JSDoc their editor renders on hover) says what the software does and what changed. Item
   identifiers (`MLLP-9`, `CLIENT-04`, `D-23`, `T-05-04-09`), phase and plan language, ADR numbers,
   meta-repo paths and "how this got built" commentary belong in the changeset, `CHANGELOG.md`, the
   commit, the PR and the roadmap. It is a **translation** at the boundary, not a deletion, and
   when you strip an identifier off the front of a line, repair the head: a fragment reads worse
   than the text it replaced. Gated by `pnpm check:no-internal-refs`
   (`.github/workflows/no-internal-refs.yml`, check-run context **`no-internal-refs`**).

   **Four surfaces, four different answers.** `/** */` doc comments compile into the `.d.ts` and
   `.d.cts` of **all three** entry points (`.`, `/testing`, `/ack-from-hl7`) plus a shared type
   chunk, so they are **gated**, and in this repo they were the mass: 389 rows against 4 on the
   public markdown. String literals are **gated too**, because this package does not merely log,
   it puts text on a **wire protocol** (`buildMllpAck` composes an ACK's MSA-3). `//` and plain
   `/* */` comments are **not** gated and identifiers are **welcome** in them, because the
   convention says source comments are a place identifiers belong. **Do not justify that boundary
   from what reaches `dist/`** (two attempts in `ncpdp` did and both were false): everything in
   `src/` is in the tarball. The line is what the consumer is **shown**.

   **THIS REPO IS THE SHARPEST INSTANCE OF THE WORD-N TRAP IN THE ECOSYSTEM**, because `WORD-N` is
   the notation of its entire subject matter. `MSH-10`, `MSA-2`, `MSH-9`, `PID-3`, `BTS-1` and
   `MSH-3..6` are HL7 v2 segment-field references; `ITI-19` and `TF-2` are IHE designations;
   `UTF-8` and `ISO-8859-1` are encodings. All are the reference material a consumer came for.
   **Never re-key rule 1 on the `WORD-N` shape.** Three guards are load-bearing and each was
   forced by a measured false positive, not by taste:
   - **`ERR` is restricted to the zero-padded `ERR-0\d`.** `ERR-02`/`03`/`04` are ours; `ERR-3`
     and `ERR-4` are the HL7 **error segment's** fields, which `ack-from-hl7` documents and tests.
     HL7 field numbers are never zero-padded; ours always are. The residual runs the OTHER way
     from what an earlier draft claimed: the arm needs a literal `0`, so HL7's `ERR-10..12` are
     safe and what the gate would MISS is any non-zero-padded `ERR-N` of our own.
   - **The phase rule carries a compound-adjective guard `(?<![A-Za-z]-)`.** `two-phase` is HL7
     enhanced acknowledgement mode and `connect-phase` is ordinary English. It is a **shape, not a
     word list**: a first draft enumerated `two-|three-|multi-|...` and the second false positive
     walked straight past it.
   - **`where|are|was|were|during|at` are on the ordinary-English lookahead** because
     `ConnectionErrorPhase` is a **published** API field (`0.0.2`) whose doc comment necessarily
     reads "phase where the error occurred". The name cannot be changed.

   **Bare `§` is deliberately NOT ruled, and here that is not a close call.** All 49 `§` on the
   gated surface are normative citations: `HL7 v2.5.1 §2.9.2.2` (the MSA-2-echoes-MSH-10
   requirement this package is built around), `RFC 8446 §4.4.2`, `ITI TF-2 §3.19.6.2.3`. Keying on
   `§` is the WORD-N trap arriving through punctuation. Pinned by a negative self-test.

   **A zero from a rule set is not a zero: check truth, not just tidiness.** Three doc comments
   here were not merely untidy, they were **false**, and all three shipped into the published
   declarations (the `'reconnecting'` payload, `getStats()` byte totals, `createStarterServer`).
   And **the remediation prose is itself a defect surface**: cut the claim, never rewrite it, but
   **cut the CLAIM, not the qualifier that bounds it**, or a deletion upgrades a bounded statement
   into a guarantee the code does not provide.

   **`CHANGELOG.md` is deliberately out of scope** even though it ships inside the npm tarball,
   because the convention names it as a place identifiers belong. That contradiction is
   ecosystem-wide, is recorded rather than decided, and is not for one repo to settle.

   **The gate refuses to run under a blinded scanner.** A `grep` with `-I` or `--ignore-files`
   forced (ugrep, and the shell function this container ships) silently skips files at exit 1 with
   nothing on stderr, which defeats every stderr-based refusal in the script, and `--ignore-files`
   honours `.gitignore`, where `dist/` lives. A behavioural self-test seeds a violation in a
   NUL-bearing file and refuses on silence. Verified red under an `-I`-forcing grep and green
   under GNU grep 3.8.

Build, lint, format, and TypeScript settings come from the shared `@cosyte/*` config packages
(`@cosyte/tsconfig` · `@cosyte/eslint-config` · `@cosyte/prettier-config`; see
`documentation/conventions.md` → "Canonical toolchain (enforced)"). Node ≥ 22.
