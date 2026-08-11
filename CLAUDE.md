# @cosyte/mllp: Project Guide for Claude

**The narrative lives in [`documentation/agent-notes.md`](documentation/agent-notes.md).** This file
is the cursor, the rules and the traps: one imperative line each, pointing into that file for the
incident, the measurement and the reasoning behind it. Split 2026-08-04; **nothing was deleted**. If
a rule below looks arbitrary, read its section before relaxing it. New narrative goes there, not
here.

**The pair is gated** (`pnpm check:agent-notes`, enforced by `test/scripts/agent-notes.test.ts`):
that file must be tracked, every section must have a body (a container's is its subsections), and
every pointer at it **in a file the gate opened** must resolve. **A NUL-bearing file is skipped: a disclosed miss, not a pass**; the
tell is the skipped count. It asserts **this repo's promise, not a universal** (`config`, `hl7` and
`workflow` carry no `agent-notes.md`), and **refuses (exit 2) rather than reporting green over a
corpus it never opened**, reconciling paths as sets against `git ls-files`. **Never clear a red by
deleting the pointer or the heading.** Why, and every disclosed miss:
`documentation/agent-notes.md#the-two-file-contract-and-why-this-gate-is-not-universal`

## Project

**`@cosyte/mllp`**: a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks, without reading the MLLP spec.

## Status

- **Phase 9 of 11.** Client / server / framing / connection / transport shipped; Phases 6, 7, 8
  and 9 are done. Next: `operations/roadmaps/mllp.md`. What each phase actually shipped:
  `documentation/agent-notes.md#shipped-phases-and-the-vendored-hl7-peer-tarball`
- **The `@cosyte/hl7` peer installs from npm**, like every other `@cosyte/*` dep. The vendored
  tarball is GONE: it pinned dev/test to a `0.0.0` snapshot and hid a FIXED MSA-2 correlation bug
  for ten releases. **Never re-vendor one:**
  `documentation/agent-notes.md#shipped-phases-and-the-vendored-hl7-peer-tarball`
- **This package is on the npm registry, and this file names no version, deliberately** (derive it:
  `npm view @cosyte/mllp version`). Never quote a version here, never move a published version
  backwards, and never infer repo visibility from publish state or the reverse: they are
  independent. The competing "not yet published to npm" claim is **closed, measured stale
  2026-08-06**, and the rename from `@cosyte/hl7-mllp` was free only because it predated the first
  publish; it would not be free now. Why both claims go stale:
  `documentation/agent-notes.md#the-package-rename-and-the-publish-state-claim`

### The em-dash brand gate is armed

`scripts/check-no-emdash.sh` (`pnpm check:no-emdash`) + `.github/workflows/no-emdash.yml` enforce the
founder ban on `U+2014` over **every tracked file AND the PR title, body and commit messages**.
Full rationale, measurements and residuals: `documentation/agent-notes.md#the-em-dash-brand-gate`

- **When it goes red, never re-encode the character.** Rewrite with a period, colon, comma or
  parentheses.
- **Never add `grep -I`.** Measured on GNU grep 3.8: it skips a text file whose bad byte shares a
  line with the em dash, in total silence, and the gate prints OK.
- **Never switch this copy to the text-only shape the other parsers run.** The tarball that forced
  it is gone; the shape stays. A binary carrying `E2 80 94` by coincidence is a red with no possible
  fix, which is a gate someone disables.
- **The NUL exclusion is a disclosed miss, not a pass**, and the tell is the excluded count on the OK
  line: **it reads 0 today**, 1 until the tarball left. If a NUL-bearing text fixture ever lands,
  revisit the partition, never the ban. The at-risk class exists, so do not call this hypothetical.
- **Never count over markdown alone.** A markdown-only count is what wrongly cleared `dicom`.
- **The script is composed from three sibling copies; understand the composition before editing it**,
  and fix shared limits in the script header, not here.

### The PHI scanner (`pnpm phi-scan`)

Three defects are recorded in full at
`documentation/agent-notes.md#the-phi-scanner-enumeration-and-its-refusals`,
`documentation/agent-notes.md#phi-scan-symlink-blind-on-both-routes` and
`documentation/agent-notes.md#phi-scan-rename-blind-at-precommit`. Contract and residuals also live
in `phi-scan-overrides.md`. The rules that came out of them:

- **▶ NEVER soften the refuse-a-scan-that-observed-nothing rule**, and never widen the ENOENT
  tolerance. Narrow the enumeration instead. **This repo is the one that can actually reach it**,
  because `test/scripts/phi-scan.test.ts` `mkdtemp`s inside `test/`, a walk root, twice per run.
  **Those tests must keep writing there: the `test/` prefix IS what they prove.**
- **▶ THE OBSERVED-NOTHING CHECK IS PER WALK ROOT, AND A GLOBAL COUNT CANNOT REPLACE IT**
  (`PHI-SCAN-OBSERVED-NOTHING-IS-GLOBAL`). Counting every root together only fires when ALL come
  back empty, so one healthy root masks an empty one: measured, `test/` emptied and `src/` intact
  printed `OK, no hits` at exit 0. **A denominator is not the remedy**, because a count counts the
  roots that DID exist. An **absent** root stays legitimate; an **EMPTIED** one refuses (exit 2).
  A synthetic-repo fixture must therefore plant something scannable under any root it creates.
- **Widening a walk root reintroduces the mid-sweep-deletion defect verbatim.** The roots are
  deliberately `test/` and `src/` and not the repo root. **What `test/` ADMITS is a separate
  question from what the ROOTS are, and the two must not be conflated.**
- **▶ A `.ts` SOURCE UNDER `test/` IS SCANNED, AND WIDENING IS TWO-SIDED**
  (`PHI-SCAN-WALK-ROOT-SCOPE`). **The enumeration half alone finds nothing**: every detector wants a
  segment id at the START of a line, so a `PID` in a string literal exited 0 even when NAMED
  EXPLICITLY on argv. `extractEmbeddedHl7` is the other half, its `|` anchor is load-bearing, and
  the violator exemption is **per-path and total** (`DELIBERATE_VIOLATOR_SOURCES`), never
  per-extension. **Never widen one half without the other, and never delete the extractor believing
  the walk covers it.** Figures, and why no match count is recorded:
  `documentation/agent-notes.md#phi-scan-walk-root-scope-and-phi-scan-observed-nothing-is-global`
- **`src/` KEEPS THE CONSERVATIVE PASS ONLY, and that is a decision, not an oversight.** Its JSDoc
  `@example` snippets are deliberately not held to the segment-aware detectors. Do not reverse it as
  a side effect of a change about `test/`.
- **▶ NEVER WRITE "NEITHER ROUTE FOLLOWS A LINK" FLAT.** `walk()` opens the ROOTS with `existsSync` +
  `readdirSync`, which both follow, so replacing `test/` or `src/` itself with a link is read
  straight through. Disclosed, not closed; never restate it as a promise.
- **An entry that REPLACES a root is judged with THAT ROOT'S OWN LIMITS** (`test` earns the
  structured scan, `src` the conservative pass), and both read predicates must admit the root's own
  path. Admitting the path is only half the remedy: `looksLikeHl7` decides what scan it earns. **The
  `.md` and per-path violator exemptions deliberately do NOT carry over to a non-regular entry**,
  because they judge bytes the route could read. (A `.ts` exemption is named here in no other form:
  the blanket one is gone.)
- **▶ `--diff-filter` MUST KEEP `T`, AND `--no-renames` STAYS.** Each was forced by a measurement at
  pre-commit, and the "admitting them needs a two-path record shape" framing was **FALSE and ported
  in from a sibling: do not restore it.** Both measurements:
  `documentation/agent-notes.md#phi-scan-rename-blind-at-precommit`
- **A refusal never reports the link target** (working-tree text that can itself carry PHI).
- **A refusal exits 2, never 1.** Exit 1 is reserved for "hits found", so an uncaught throw is a
  false finding, which reads as actionable and is worse than a crash. **`walk()` no longer lets any
  `readdir` failure leave the process**: `ENOENT` narrows the enumeration and every other code
  becomes an `InvocationError`. **Two documents disagree about the leftovers, neither is
  authoritative, and `phi-scan-overrides.md` is the stale one.** Re-measure before relying on
  either, and never restate "no failure can exit 1" as settled.
- **▶ ALL MODE ALSO READS THE BYTES GIT CARRIES, AS A UNION WITH THE WALK.** Decoys at the tracked
  names satisfy the walk alone: 8 states printed `OK, no hits` at exit 0. **The skip is a BYTE
  comparison, so never normalize EOL before comparing.** A tracked link/gitlink in the index
  refuses; **`--staged` stays UNCHANGED** (it decides what a commit is BLOCKED on).
  `documentation/agent-notes.md#phi-scan-index-corpus-the-bytes-git-carries`
- **Do not "resync" any of this to a sibling parser's scope, and do not soften it.**

## Tech Stack (the shared `@cosyte/*` standard)

Inherited by depending on the published `@cosyte/*` config packages, never by copying files. Source
of truth: the meta-repo's `documentation/conventions.md`. This is a summary.

- **Language:** TypeScript (strict, full rigor set incl. `noUncheckedIndexedAccess`) via
  `@cosyte/tsconfig`. **Target ES2023**, `NodeNext`.
- **Build:** dual ESM + CJS + `.d.ts` via `tsup` (`@cosyte/tsup-config`); `attw` is a publish gate
  (per-condition types: `.d.ts` for `import`, `.d.cts` for `require`) across all three subpaths
  (root, `/testing`, `/ack-from-hl7`). **The `attw` script is `node scripts/attw.mjs --profile
  node16`, NOT the bare CLI** (see the guardrail below); the CLI reports a tarball with no
  declarations as "does not contain types" and **exits 0**.
- **Node:** **>= 22** (CI matrix 22 + 24).
- **Package manager:** `pnpm@10`.
- **Lint/format:** **ESLint 10** + unified `typescript-eslint` (type-checked) via
  `@cosyte/eslint-config`; Prettier via `@cosyte/prettier-config`. Lint at `--max-warnings=0`.
- **Testing:** **Vitest 4** + v8 coverage (`@cosyte/vitest-config`), per-directory >= 90 gates on
  `src/framing|client|connection|server|transport`.
  **A slow case states its own budget at its own site; the suite-wide `testTimeout` is not for
  widening**, because raising the global buys a false green everywhere to spend a false red in one
  place. **No list of those sites is kept anywhere: read them off the tests, and know there are two
  spellings** (the options object and a bare trailing number on `it`), because every list two drafts
  kept was wrong. **A budget equal to the framework default is a no-op** (Vitest 4.1.4: 5,000 ms per
  test, 10,000 ms per hook), and **trim before you
  bound**. Method, conditions, figures and the repo-specific caveat that does not port:
  `documentation/agent-notes.md#test-timeouts-measured-not-read`
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

### Framing and ACK correlation (the clinical-safety core)

- **Tolerate terminator noise; NEVER skip DATA** (MLLP-ACK-UTF8). `buildMllpAck` strips *leading
  `CR`/`LF` only* before `parseHL7`; those bytes carry no data. **It must NOT re-base on the located
  `MSH`**, because that skips an `FHS`/`BHS` batch envelope (§2.10.3) and returns a positive `AA`
  correlated to message 1 with zero warnings while messages 2..N go unread. An `FHS`/`BHS` envelope
  **must keep** falling through to the warned, non-positive `AE` fallback. **Batch ACK is its own feature: do
  not arrive at it by accident, and do not "fix" the `AE` into an `AA`.**
  Why: `documentation/agent-notes.md#tolerate-terminator-noise-never-skip-data-mllp-ack-utf8`
- **The MSH is read ONCE, in one place** (MLLP-ACK-UTF8): `src/internal/control-id.ts` owns
  `readMshSegment` and every MSH-10 / MSA-2 scanner built on it. Three call sites (the client's
  correlator, `buildRawAck`, `buildMllpAck`) must agree byte-for-byte on what a control ID is, or you
  get timeout -> resend -> **duplicate clinical message**. All three call it; each re-derived it once
  and each got it wrong differently. **Do not re-implement a fourth.**
  Two rules inside it pull in opposite directions and the gate caught a violation of each:
  **bound the field scan at the segment terminator** (unbounded, it returned PID-3, the patient's
  MRN, as the "control ID" and put it in the correlation key, an error and a warning), **but locate
  the MSH and never demand it at byte 0** (demanding it made `buildRawAck` emit a silent positive
  `AA` with an empty MSA-2 for a leading-`CR` or batch payload: the duplicate-message failure,
  manufactured by the fix for it). **Agree at the TOLERANT fixed point.**
  Why: `documentation/agent-notes.md#the-msh-is-read-once-mllp-ack-utf8`
- **Stable warning codes are a public API.** Renaming or removing one is a breaking change. Codes:
  `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`,
  `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`,
  `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`,
  `MLLP_ACK_AFTER_TIMEOUT`, `MLLP_ACK_INBOUND_UNPARSEABLE`, `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`,
  `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` (14 total; the last **three** are `ack-from-hl7`-scoped, emitted
  in `MllpAck.warnings`, not through the framing registry). **`NOT_VERBATIM` and `UNVERIFIABLE` are
  deliberately distinct and must stay so: the text path must never claim a proof it cannot run.**
  Why: `documentation/agent-notes.md#stable-warning-codes-not_verbatim-and-unverifiable`
- **A warning message is a log line, so it carries no field content, EVER** (MLLP-ACK-UTF8, then
  `PHI-WARNING-MESSAGE-LEAK`). Report shape, not content: the caller already holds the bytes.
  "It's only a control ID, that's routing metadata" is exactly the reasoning that put an MRN in a log
  line. **The distinguishing property is not the wording, it is whether the factory takes a value
  parameter at all**: `src/client/ack-diagnostics.ts` is a frozen registry and `ackDiagnosticMessage(code)`
  takes only a code, and the `Correlator` hands out `controlIdBytes`, never the string. **Do not add a
  value parameter to either.** A truncated ID and a hex rendering are not middle grounds. **And the
  test has to reach the CLIENT** (`test/phi/diagnostic-phi-leak.test.ts` over a real client on
  `InMemoryTransport.pair()`); a `FrameReader`-only property test was green over this the whole time.
  **`@cosyte/test-utils` must stay pinned at `^0.0.2` or higher**: a caret on `0.0.x` resolves
  exactly, so `^0.0.1` installs a kit with no runner and the suite passes for the wrong reason.
  Why: `documentation/agent-notes.md#a-warning-message-is-a-log-line-phi-warning-message-leak`

### Connection, transport and TLS

- **No `emit()` reachable from a callback we do not own may go uncontained, in ANY class** (MLLP-10).
  `EventEmitter.emit()` is synchronous, so a throwing subscriber unwinds to a socket/server listener
  and kills the process, every other connection and every in-flight durable commit with it. Use
  `src/internal/safe-emit.ts` via `Connection._dispatchContained` / `MllpServer._emitContained` /
  `MllpClient._emitContained`: **every `this.emit(` in `src/` is inside a containment wrapper**, with
  exactly one disclosed exception, bounded: the `net.Server` error forwarder re-emits unguarded only
  when there is **no** `'error'` listener **and** the server is serving, because a silent accept
  outage on a healthcare listener must be impossible. **The hazard belongs to the CALL STACK, not to
  a class**: scoping it to `Connection` is what the gate refuted, across four rounds. Two corollaries
  are load-bearing beyond crash-safety: a throwing `'nack'` subscriber suppressed the fail-safe
  negative ACK, and a throwing `'message'` subscriber broke ACK correlation so `send()` hung forever.
  The structural tests attach a throwing subscriber to **every event of all three classes at once**,
  so a new uncontained event fails them. Why: `documentation/agent-notes.md#no-uncontained-emit-mllp-10`
- **`MllpConnectionError.connectionCause` is a public union** whose members are classified
  **permanent** or transient for the reconnect classifier, and misclassifying one is a reconnect
  storm. `'tls-verify'` and `'tls-handshake'` (TLS-protocol-shaped pre-`secureConnect` only, per the
  exported `isTlsProtocolError`; pure TCP failures on a TLS connection carry no `connectionCause`)
  are permanent. `'framing-fatal'` (a fatal decoder throw) is permanent, and
  `isTransientConnectionError` now treats **every** `MLLP_*` code as permanent, because the old
  `default:` branch returned transient and an HTTP probe or wrong-port misconfiguration produced an
  unbounded reconnect storm under the `autoReconnect: true` default. Plain network blips stay
  transient. Existing values: `'fifo-unsafe'`, `'in-flight-orphan'`. **TLS 1.3 caveat (RFC 8446
  §4.4.2): `connect()` resolving does NOT guarantee a `clientAuth: 'MUST'` server accepted the client
  cert; ACK correlation is the delivery guarantee.**
  Why: `documentation/agent-notes.md#mllpconnectionerrorconnectioncause`
- **Stable security-warning codes** (Phase 8, separate from the framing `WarningCode` union above) are also a public
  API: `MLLP_TLS_VERIFY_DISABLED` (client, every `secureConnect` while `tls.allowUnverified: true`)
  and `MLLP_BIND_ALL_INTERFACES` (server, once at `listen()` when a wildcard host is bound via
  `allowWildcardBind: true`). Both emit as a frozen `'securityWarning'` event AND via
  `process.emitWarning`.
- **Server bind-safety: the default host is `'127.0.0.1'`, and a wildcard bind requires
  `ServerOptions.allowWildcardBind: true` enforced against the OS-NORMALIZED bound address.** Literal
  spellings reject pre-bind; resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, ...) are caught
  post-bind via `server.address()`, closing the just-bound server with no listening state and no
  `'listening'` event. `listen()` is **single-flight**, so concurrent calls reject rather than race
  the post-bind checks. Full spelling list and behaviour:
  `documentation/agent-notes.md#server-bind-safety`
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.

### General

- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances: log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % per-directory on `src/framing/`, `src/client/`, `src/connection/`, `src/server/`, `src/transport/` (enforced by `pnpm test:coverage`).
- **In-memory transport is a first-class deliverable** (`@cosyte/mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.
- **▶ `attw` SAYS "does not contain types" AND EXITS 0, SO THE `attw` SCRIPT IS A WRAPPER, NOT THE
  BARE CLI.** `getExitCode.js` in `@arethetypeswrong/cli@0.18.4` opens with `if (!analysis.types)
  return 0`, so the problem list is never consulted and no flag or config reaches it: a broken
  publish reported as a pass. **The race only supplies the condition**, so the answer is **not** a
  lock, a lease or a build queue: the gate must be able to say its own inputs were missing, whatever
  removed them.
  **▶ NEVER RESTATE THE BOUNDARY AS "MISSING DECLARATIONS EXIT 0".** It needs the tarball to carry
  **no declaration at all**, shared `tsup` type chunk included; removing only the six entry
  declarations reds honestly at exit 1. A draft claimed otherwise and was wrong, and
  `test/scripts/attw-gate.test.ts` reds if the promise is restored. **Do not write a single figure
  down as the build window**: the stable claim is seconds, not milliseconds.
  `scripts/attw.mjs` carries **two nets that catch different things** (a `package.json` path
  preflight over this package's **twelve** artifact paths, and a post-check on the untyped sentence);
  **keep both**, keep `--profile node16` forwarded, and keep refusing by option name and wholesale
  anything that would hide the sentence (`--quiet`, `--format json`, `.attw.json`, `--config-path`).
  The disclosed hole in net 1 is the shared type chunk `package.json` names nowhere.
  Why: `documentation/agent-notes.md#the-attw-wrapper-and-why-the-bare-cli-is-not-a-gate`

## Standing disciplines (every change)

These bind every change in this repo (mirrored from the cosyte meta-repo's
`documentation/conventions.md`):

1. **Documentation follows code.** A public-surface / stack / status change isn't done until its
   docs are: this package's own docs (`docs-content/` + JSDoc), and (in the meta-repo) its
   `documentation/repos/<repo>.md` and the `ecosystem-map.md` status table.
2. **Version + changelog every meaningful change.** Add a Changeset (`pnpm changeset`, `patch`);
   stay on `0.0.x` until first alpha. **The changeset summary IS the changelog entry**: a generator
   is on, so the RELEASE writes everything above `## Released before this file was generated`.
   **Never hand-edit it, never reintroduce `[Unreleased]`, keep only the H1 above the first heading,
   and never resync `"prettier"` (`false` on purpose).** **An UNCHANGED changelog after release
   is a swallowed write failure, not a reverted flag.**
   Why: `documentation/agent-notes.md#changelog-generation`
3. **Crew + knowledgebase feedback loop.** When a standard, decision, or public surface changes,
   flag whether a `crew` skill or `knowledgebase` doc needs creating/updating. Never silently skip.
4. **No internal project bookkeeping on a public surface** (founder directive, 2026-07-27). What a
   consumer reads (`README.md`, `docs-content/`, the npm `description`, a release body, and the JSDoc
   their editor renders on hover) says what the software does and what changed. Item identifiers,
   phase and plan language, ADR numbers, meta-repo paths and "how this got built" commentary belong
   in the changeset, `CHANGELOG.md`, the commit, the PR and the roadmap. It is a **translation** at
   the boundary, not a deletion: **when you strip an identifier off the front of a line, repair the
   head.** Gated by `pnpm check:no-internal-refs` (check-run context **`no-internal-refs`**).
   Full rule-by-rule reasoning: `documentation/agent-notes.md#no-internal-bookkeeping-on-a-public-surface-and-the-word-n-trap`
   - **Four surfaces, four answers.** `/** */` doc comments are **gated** (they compile into all
     three entry points' declarations). String literals are **gated too**, because this package puts
     text on a **wire protocol**. `//` and `/* */` comments are **not** gated and identifiers are
     welcome in them. **Do not justify that boundary from what reaches `dist/`**: everything in
     `src/` is in the tarball. The line is what the consumer is **shown**.
   - **▶ THIS REPO IS THE SHARPEST INSTANCE OF THE WORD-N TRAP IN THE ECOSYSTEM**, because `WORD-N`
     is the notation of its entire subject matter (`MSH-10`, `MSA-2`, `PID-3`, `ITI-19`, `UTF-8`).
     **Never re-key rule 1 on the `WORD-N` shape.** Three guards are load-bearing and each was forced
     by a measured false positive: `ERR` restricted to the zero-padded `ERR-0\d`; the phase rule's
     compound-adjective guard, which is a **shape, not a word list**; and
     `where|are|was|were|during|at` on the ordinary-English lookahead, because `ConnectionErrorPhase`
     is a **published** API field whose doc comment cannot be reworded. **The `ERR` residual runs the
     OTHER way from what an earlier draft claimed**: the arm needs a literal `0`, so HL7's
     `ERR-10..12` are safe and what the gate MISSES is any non-zero-padded `ERR-N` of our own.
   - **Bare `§` is deliberately NOT ruled.** All 49 on the gated surface are normative citations
     (`HL7 v2.5.1 §2.9.2.2`, `RFC 8446 §4.4.2`, `ITI TF-2 §3.19.6.2.3`). Keying on `§` is the WORD-N
     trap arriving through punctuation. Pinned by a negative self-test.
   - **A zero from a rule set is not a zero: check truth, not just tidiness.** Three doc comments here
     were **false** and all three shipped into the published declarations. **The remediation prose is
     itself a defect surface: cut the CLAIM, not the qualifier that bounds it**, or a deletion
     upgrades a bounded statement into a guarantee the code does not provide.
   - **The gate refuses to run under a blinded scanner** (`grep -I` / `--ignore-files`), which skips
     files silently and defeats every stderr-based refusal. A behavioural self-test seeds a violation
     in a NUL-bearing file and refuses on silence.
   - **`CHANGELOG.md` is deliberately out of scope**, a recorded ecosystem-wide contradiction, not for
     one repo to settle.
