# Release 0.1.0 readiness

Internal record. It says what the pending changeset set actually contains, what the public API is,
what could break a working `0.0.11` integration, and what the checks reported at the release commit.
It is not published: `documentation/` is outside `scripts/check-no-internal-refs.sh`'s scan surface
(`README.md`, `TRADEMARKS.md`, `LICENSE`, `docs-content/` and the npm metadata), and it is outside
`files` in `package.json`, so it reaches no consumer and may carry internal detail.

**Nothing here performs a release.** `package.json` still declares `0.0.11`, `VERSION` in
`src/index.ts` and the declared release in `docs-content/conformance.md` are untouched, and
`CHANGELOG.md` is unchanged. `scripts/sync-version.mjs`, driven by `pnpm run version` inside the
shared release pipeline, is the only writer of those three, and `test/sanity.test.ts` plus
`test/conformance/statement.test.ts` go red on purpose if that step is skipped or pre-empted.

**The release commit** is the head of the branch that carries this file. Its base is `origin/main`
at `9959dc1`, which is the merge of the package-description rewrite.

## The version ladder this relied on, and the policy that has not landed

Two files in this checkout carried the guidance, and both said the same thing before this change.

`CLAUDE.md`, "Standing disciplines (every change)", item 2:

> **Version + changelog every meaningful change.** Add a Changeset (`pnpm changeset`, `patch`);
> stay on `0.0.x` until first alpha. **The changeset summary IS the changelog entry**

`.changeset/README.md`, as it stood before this change:

> During pre-alpha, pick **patch**: that keeps the package on the `0.0.x` ladder until its first
> alpha. See the cosyte version ladder in the meta-repo's `documentation/conventions.md`.

Both defer to a file that is not in this checkout and was not read for this record. What is in the
checkout is the instruction to pick `patch` unconditionally, and that instruction is what produced a
pending set of ten changesets all declaring `patch` while forty five names were added to the root
subpath. `.changeset/README.md` is reconciled to the `0.1.x` ladder by this change. `CLAUDE.md` is
not: it is outside this change's scope, so its item 2 still reads "stay on `0.0.x` until first
alpha" and now disagrees with `.changeset/README.md`. **That contradiction is a residual of this
change and is the first thing to fix next**, in its own change, by the writer who owns `CLAUDE.md`
and its gated pair `documentation/agent-notes.md`.

**The ecosystem-wide release frequency policy this batch depends on had not landed when this record
was written.** It is owned by the shared workflow repository, not by this one, and at the time of
writing it was recorded as blocked. Nothing here asserts a release date and nothing here asserts a
cadence. If that policy lands a ladder rule that contradicts a `0.1.0` target, the classification
below is re-derived and the pending changesets are edited again; that stays cheap right up until the
"Version Packages" pull request merges, and impossible after it.

## Classification of the pending set

Every file under `.changeset/` other than `README.md` and `config.json`, by filename.

**The rule applied.** A changeset stays `patch` unless its own summary introduces either (a) a newly
exported symbol, option, event or stable code on a published code subpath, or (b) a new published
artifact of independent standing, meaning one a consumer or integrator uses as an input to their own
work rather than reads to understand a surface that already shipped. Anything else, including
documentation of what already ships and contributor-only tooling, stays `patch`.

| file | before | after | the sentence from its own summary that decides it |
|---|---|---|---|
| `chilled-donuts-repeat.md` | patch | **minor** | "`MllpNeverDeliveredError` is new and is the safe half: the message was still held inside the client, no bytes were written for it, and resending it cannot duplicate anything." |
| `fresh-pugs-invite.md` | patch | patch | "No runtime code, framing, acknowledgement, transport or TLS behaviour changes here. Documentation only." |
| `lucky-otters-describe.md` | patch | patch | "No source changed. No public surface, warning code, option name, per-role default or conformance verdict moved, and the conformance statement's verdicts, tables and declared version are untouched." |
| `olive-hills-declare.md` | patch | **minor** | "`docs-content/conformance.md` is that missing artifact, published as a navigable page." |
| `olive-hounds-reconcile.md` | patch | patch | "Internal PHI-scan tooling: the all-mode sweep now reads the bytes git carries, not only the working tree. No runtime, API or published behaviour change." |
| `olive-mountains-install.md` | patch | patch | "No runtime behaviour of this package changes: `@cosyte/hl7` remains an optional peer dependency referenced only from the `@cosyte/mllp/ack-from-hl7` subpath, and the emitted framing, ACK and warning-code surfaces are untouched." |
| `proud-moons-refuse.md` | patch | **minor** | "**`tls.atnaTransportSecurity`, on the client and on the server, off by default.** Selecting it offers exactly the four TLS 1.2 cipher suites ITI TF-2 §3.19.6.2.3 names and nothing else." |
| `quiet-moons-observe.md` | patch | **minor** | "New exports on the root subpath, all additive: `runDifferential`, `canonicalExchanges`, `canonicalAcknowledgement`, `resolveDifferentialPeer`, `MllpDifferentialConfigurationError`, `MLLP_DIFF_PEER_UNPARSEABLE`, `differentialConfigurationMessage`, and the report and option types." |
| `tidy-hounds-explain.md` | patch | patch | "Metadata only: no API, no behaviour and no dependency change." |
| `wild-pears-repeat.md` | patch | **minor** | "New error identities: `MllpApplicationAckError` and `MllpCommitRejectedError`." |
| `sweet-pandas-classify.md` | not present, added by this change | patch | "No runtime, API or published behaviour changes: this is release bookkeeping." |

**Only the frontmatter bump-type line moved.** Every summary is byte-identical to what it was, and
the diff for the five corrected files is one line each. A summary is the changelog entry for its
release, so a summary that is wrong is recorded here and left alone rather than edited.

### Nothing was unclassifiable

Every one of the eleven files carries exactly one frontmatter line, and that line is exactly
`"@cosyte/mllp": <patch|minor|major>`. None had to be left unedited for want of a readable bump
type, and none had a bump type inferred for it. The check that establishes it:

```bash
node -e '
const fs=require("fs");
for(const f of fs.readdirSync(".changeset").sort()){
  if(!f.endsWith(".md")||f==="README.md") continue;
  const m=fs.readFileSync(".changeset/"+f,"utf8").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if(!m){console.log(f,"UNCLASSIFIABLE: no frontmatter");continue;}
  const lines=m[1].split(/\r?\n/).filter(l=>l.trim().length);
  const hits=lines.filter(l=>/^"@cosyte\/mllp":\s*(patch|minor|major)\s*$/.test(l));
  console.log(f,"frontmatterLines="+lines.length,"bumpLines="+hits.length);
}'
```

If a future run reports `bumpLines` other than 1, or `UNCLASSIFIABLE`, that file is named here and
left unedited rather than guessed at.

### What forced each correction

Five changesets declared `patch` while their own summaries introduce a consumer-visible capability
or a newly exported symbol.

- **`chilled-donuts-repeat.md`.** `MllpNeverDeliveredError` and `MllpUnknownFateError`. Both are new
  exports of the package root, both absent from `0.0.11` (see the inventory below), and both were
  introduced under a `patch` changeset. Its own summary calls the second one out in the same
  paragraph: "`MllpUnknownFateError` is new and is the ambiguous half, reported as ambiguous: the
  bytes went out and no acknowledgement came back, so the peer may hold the message." The capability
  behind them is new too: `close()` now waits for outstanding acknowledgements, bounded by
  `drainTimeoutMs`, where before it rejected everything pending at once.
- **`proud-moons-refuse.md`.** The `tls.atnaTransportSecurity` option on the client and the server,
  the `'tlsNegotiated'` event on both, the `MllpTlsConfigurationError` identity, and the
  `MLLP_TLS_CIPHER_LIST_REJECTED` and `MLLP_TLS_CIPHER_OPTION_CONFLICT` codes, plus the
  `ATNA_CIPHER_LIST`, `ATNA_CIPHER_SUITES`, `TLS13_DEFAULT_CIPHER_SUITES`,
  `readNegotiatedTlsParameters` and `resolveTlsCipherPolicy` exports.
- **`quiet-moons-observe.md`.** `runDifferential`, `canonicalExchanges`, `canonicalAcknowledgement`,
  `resolveDifferentialPeer`, `MllpDifferentialConfigurationError`, `MLLP_DIFF_PEER_UNPARSEABLE` and
  `differentialConfigurationMessage`, with their report and option types. A verification harness that
  only existed inside this repository now ships in the published package.
- **`wild-pears-repeat.md`.** `MllpApplicationAckError` and `MllpCommitRejectedError`, the per-send
  `onCommitAck` hook, the `applicationAckTimeoutMs` option, the server's `'ackModeWarning'` event and
  seven new stable codes. Enhanced acknowledgement mode is a capability a consumer can now use.
- **`olive-hills-declare.md`.** No new symbol: this one is corrected on limb (b) of the rule. It adds
  `docs-content/conformance.md`, a declaration an integrator hands to a conformance reviewer or
  enters in a self-declared registry statement. The tell that it is a release artifact rather than
  commentary is that the release itself rewrites it: `scripts/sync-version.mjs` generates the release
  the statement declares, alongside the `VERSION` export, and it is the only page in the published
  set that the pipeline writes to.

**Why the other two documentation changesets stay `patch`.** `fresh-pugs-invite.md` rewrites
`README.md`, and `lucky-otters-describe.md` gives the published documentation set a page contract, a
testing page and a validating test. Both describe surfaces that already shipped: the README is the
front page for a package that existed, and `@cosyte/mllp/testing` and `runDifferential` were already
exported before either page was written. Neither adds an artifact whose declared release the pipeline
generates, and each says in its own summary that no public surface moved. They fail limb (b), so they
stay `patch`.

## Public API inventory at the release commit

Every name exported from each of the three published code subpaths, marked present or absent in
`0.0.11`. `./package.json` is a fourth entry in `exports` but is the manifest itself, not a code
subpath, so it carries no names.

### How this list is regenerated

The names come from the trailing `export { ... }` statement of each built declaration file, which is
where `tsup` collects the whole surface of an entry point, type-only exports included:

```bash
pnpm build && node -e '
const fs=require("fs");
const subs={".":"dist/index.d.ts","./ack-from-hl7":"dist/ack-from-hl7/index.d.ts","./testing":"dist/testing/index.d.ts"};
for(const [sub,f] of Object.entries(subs)){
  const m=fs.readFileSync(f,"utf8").match(/export \{([^}]*)\};\s*$/);
  const names=m[1].split(",").map(s=>s.trim()).filter(Boolean).sort();
  console.log(sub+" ("+names.length+")\n"+names.join(" ")+"\n");
}'
```

The `0.0.11` column is the same extraction run against the **published** `0.0.11` tarball rather than
against a rebuild of the tag, so the comparison is against the bytes a consumer actually installed.
The tarball was fetched from `https://registry.npmjs.org/@cosyte/mllp/-/mllp-0.0.11.tgz`
(sha256 `6c84eda9ffc086d730d1730d71115c0ddb714777ced4c7d779249370e95984e3`, 505378 bytes) and its
`dist/**/*.d.ts` read with the same regular expression.

### Is anything removed or renamed

**No.** Across all three published code subpaths, every name exported by `0.0.11` is still exported
at the release commit, spelled exactly as it was, and with the same kind (value or type). Nothing was
removed and nothing was renamed. That is what makes the release additive, and it is why `minor` is
the correct type rather than `major`.

The root subpath goes from 60 names to 105, so forty five are added. `./ack-from-hl7` is unchanged at
17 and `./testing` unchanged at 1.

#### `.`

105 names at the release commit, 60 in 0.0.11: 45 added, 0 removed or renamed.

| name | kind | in 0.0.11 |
|---|---|---|
| `ATNA_CIPHER_LIST` | value | absent (new) |
| `ATNA_CIPHER_SUITES` | value | absent (new) |
| `AckCode` | type | present |
| `AckCorrelationCode` | type | present |
| `AckCorrelationWarning` | type | present |
| `AckModeCode` | type | absent (new) |
| `AckModeWarning` | type | absent (new) |
| `AckModeWarningEvent` | type | absent (new) |
| `ApplicationAckFailure` | type | absent (new) |
| `CanonicalExchange` | type | absent (new) |
| `ClientAuth` | type | present |
| `ClientOptions` | type | present |
| `ClientStats` | type | present |
| `CommitAckReport` | type | absent (new) |
| `Connection` | value | present |
| `ConnectionErrorCause` | type | present |
| `ConnectionErrorPhase` | type | present |
| `ConnectionOptions` | type | present |
| `ConnectionState` | type | present |
| `ConnectionStats` | type | present |
| `DifferentialConfigurationErrorCode` | type | absent (new) |
| `DifferentialConnect` | type | absent (new) |
| `DifferentialCorrelationOutcome` | type | absent (new) |
| `DifferentialDeviation` | type | absent (new) |
| `DifferentialExchangeOutcome` | type | absent (new) |
| `DifferentialExchangeReport` | type | absent (new) |
| `DifferentialParityOutcome` | type | absent (new) |
| `DifferentialPeer` | type | absent (new) |
| `DifferentialReport` | type | absent (new) |
| `DifferentialReportPeer` | type | absent (new) |
| `DifferentialRunOptions` | type | absent (new) |
| `DifferentialRunResult` | type | absent (new) |
| `DifferentialSkipReason` | type | absent (new) |
| `EncoderOptions` | type | present |
| `FrameReader` | value | present |
| `FrameReaderOptions` | type | present |
| `MLLP_BIND_ALL_INTERFACES` | value | present |
| `MLLP_DIFF_PEER_UNPARSEABLE` | value | absent (new) |
| `MLLP_TLS_CIPHER_LIST_REJECTED` | value | absent (new) |
| `MLLP_TLS_CIPHER_OPTION_CONFLICT` | value | absent (new) |
| `MLLP_TLS_VERIFY_DISABLED` | value | present |
| `MessageMeta` | type | present |
| `MllpAckError` | value | present |
| `MllpApplicationAckError` | value | absent (new) |
| `MllpBackpressureError` | value | present |
| `MllpClient` | value | present |
| `MllpCommitRejectedError` | value | absent (new) |
| `MllpConnectionError` | value | present |
| `MllpDifferentialConfigurationError` | value | absent (new) |
| `MllpFramingError` | value | present |
| `MllpNeverDeliveredError` | value | absent (new) |
| `MllpServer` | value | present |
| `MllpTimeoutError` | value | present |
| `MllpTlsConfigurationError` | value | absent (new) |
| `MllpUnknownFateError` | value | absent (new) |
| `MllpWarning` | type | present |
| `NackAckCode` | type | absent (new) |
| `NackEvent` | type | present |
| `NackReason` | type | present |
| `NegativeAckCode` | type | present |
| `NegotiatedTlsParameters` | type | absent (new) |
| `NetTransport` | value | present |
| `PemInput` | type | present |
| `ReconnectingEvent` | type | present |
| `ResolvedTlsCipherPolicy` | type | absent (new) |
| `RetryContext` | type | present |
| `RetryStrategy` | type | present |
| `SecurityWarning` | type | present |
| `SecurityWarningCode` | type | present |
| `ServerOptions` | type | present |
| `ServerStats` | type | present |
| `ServerTlsOptions` | type | present |
| `StarterClientOptions` | type | present |
| `StarterServerOptions` | type | present |
| `StateChangeEvent` | type | present |
| `TLS13_DEFAULT_CIPHER_SUITES` | value | absent (new) |
| `TlsCipherPolicyInput` | type | absent (new) |
| `TlsConfigurationErrorCode` | type | absent (new) |
| `TlsOptions` | type | present |
| `TlsTransport` | value | present |
| `Transport` | value | present |
| `VERSION` | value | present |
| `WarningCode` | type | present |
| `ackDiagnosticMessage` | value | present |
| `ackModeDiagnosticMessage` | value | absent (new) |
| `buildRawAck` | value | present |
| `canonicalAcknowledgement` | value | absent (new) |
| `canonicalExchanges` | value | absent (new) |
| `createClient` | value | present |
| `createServer` | value | present |
| `createStarterClient` | value | present |
| `createStarterServer` | value | present |
| `createWarning` | value | present |
| `differentialConfigurationMessage` | value | absent (new) |
| `encodeFrame` | value | present |
| `isTlsProtocolError` | value | present |
| `isTlsVerificationErrorCode` | value | present |
| `isTransientConnectionError` | value | present |
| `rawAckUncorrelatable` | value | present |
| `readNegotiatedTlsParameters` | value | absent (new) |
| `resolveDifferentialPeer` | value | absent (new) |
| `resolveNackCode` | value | present |
| `resolveTlsCipherPolicy` | value | absent (new) |
| `runDifferential` | value | absent (new) |
| `tlsConfigurationMessage` | value | absent (new) |

Exported by 0.0.11 and now removed or renamed: **none**.

#### `./ack-from-hl7`

17 names at the release commit, 17 in 0.0.11: 0 added, 0 removed or renamed.

| name | kind | in 0.0.11 |
|---|---|---|
| `BuildMllpAckOptions` | type | present |
| `Hl7Peer` | type | present |
| `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` | value | present |
| `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` | value | present |
| `MLLP_ACK_INBOUND_UNPARSEABLE` | value | present |
| `MllpAck` | type | present |
| `MllpAckWarning` | type | present |
| `MllpPeerMissingError` | value | present |
| `buildAckAA` | value | present |
| `buildAckAE` | value | present |
| `buildAckAR` | value | present |
| `buildAckCA` | value | present |
| `buildAckCE` | value | present |
| `buildAckCR` | value | present |
| `buildMllpAck` | value | present |
| `detectMode` | value | present |
| `loadHl7Peer` | value | present |

Exported by 0.0.11 and now removed or renamed: **none**.

#### `./testing`

1 names at the release commit, 1 in 0.0.11: 0 added, 0 removed or renamed.

| name | kind | in 0.0.11 |
|---|---|---|
| `InMemoryTransport` | value | present |

Exported by 0.0.11 and now removed or renamed: **none**.

## The published tarball

**The check ran.** The registry was reachable and `pnpm publish:dry` produced the file set below.

```bash
pnpm build && pnpm publish:dry
```

**It exited 1, and the reason is not the tarball.** `package.json` still declares `0.0.11`,
deliberately, because nothing here may pre-empt the release pipeline's `pnpm run version` step. npm
therefore refused the dry publish with "You cannot publish over the previously published versions:
0.0.11" **after** it had already packed and listed the tarball. The file set below is that listing.
The version guard is expected here and disappears once `pnpm run version` bumps the manifest to
`0.1.0` inside the "Version Packages" pull request.

`pnpm publish:dry` is not in the pre-flight chain and is not one of the four gates, so this exit
status is not a pre-flight red. Every command that is in either set exited 0; see below.

**25 files, 682.5 kB packed, 2.5 MB unpacked**, from the five `files` entries in `package.json`
(`dist`, `README.md`, `LICENSE`, `TRADEMARKS.md`, `CHANGELOG.md`):

```
CHANGELOG.md
LICENSE
README.md
TRADEMARKS.md
dist/ack-from-hl7/index.cjs
dist/ack-from-hl7/index.cjs.map
dist/ack-from-hl7/index.d.cts
dist/ack-from-hl7/index.d.ts
dist/ack-from-hl7/index.mjs
dist/ack-from-hl7/index.mjs.map
dist/index-CD8V2Mtk.d.cts
dist/index-CD8V2Mtk.d.ts
dist/index.cjs
dist/index.cjs.map
dist/index.d.cts
dist/index.d.ts
dist/index.mjs
dist/index.mjs.map
dist/testing/index.cjs
dist/testing/index.cjs.map
dist/testing/index.d.cts
dist/testing/index.d.ts
dist/testing/index.mjs
dist/testing/index.mjs.map
package.json
```

`dist/index-CD8V2Mtk.*` is the shared declaration chunk `tsup` emits for types both entry points
reference. `package.json` names it nowhere, which is the disclosed hole in the first of the two nets
in `scripts/attw.mjs`; the second net, the untyped-sentence post-check, is what covers it.

The published `0.0.11` tarball carries the same 25 paths, chunk hash included, so the release adds no
file and removes none. Only the bytes inside them move.

## Consumer break candidates

Every consumer-visible behaviour change in the pending set that could break a working `0.0.11`
integration, with the symptom the consumer observes and a verdict.

| # | change | symptom a `0.0.11` consumer observes | verdict |
|---|---|---|---|
| 1 | `close()` reports the fate of pending sends by population (`chilled-donuts-repeat.md`) | A pending send that previously rejected with a single `MllpConnectionError({ phase: 'close' })` now rejects with `MllpNeverDeliveredError` or `MllpUnknownFateError`. Replay logic that matched on `MllpConnectionError` plus `phase === 'close'`, or on that error's message, stops matching and falls to a default branch. | accepted-for-0.1.0 |
| 2 | `close()` now waits for outstanding acknowledgements (`chilled-donuts-repeat.md`) | A shutdown path that used to return as soon as it rejected everything now blocks until the last acknowledgement lands or `drainTimeoutMs` (default 30 s) expires. A caller with its own shorter shutdown budget, or a test asserting a prompt close, sees a timeout it did not see before. | accepted-for-0.1.0 |
| 3 | Sends parked inside the client now settle instead of hanging (`chilled-donuts-repeat.md`) | A send waiting for queue room under `onBackpressure: 'wait'`, or for the single in-flight slot under `pipeline: false`, used to leave its promise pending forever on `close()` and `destroy()`. It now rejects with `MllpNeverDeliveredError`. A consumer that never attached a rejection handler, because the promise never settled, can now see an unhandled rejection. | accepted-for-0.1.0 |
| 4 | An enhanced-mode send no longer settles on the first acknowledgement (`wild-pears-repeat.md`) | With `correlateByControlId: true` and a message carrying a non-null MSH-15 or MSH-16, a send that used to resolve on the `CA` now stays pending for the later application acknowledgement and can reject with `MllpApplicationAckError` after `applicationAckTimeoutMs`. A `CE` or `CR` now rejects at once with `MllpCommitRejectedError` where the send previously resolved. Pointing this client at this package's own server with both fields asking for acknowledgement ends at the application-acknowledgement timeout, because this server still sends only one. | accepted-for-0.1.0 |
| 5 | The server's auto-ACK answers in the half of Table 0008 the sender asked for (`wild-pears-repeat.md`) | A peer whose MSH-15 requests a commit acknowledgement used to receive `AA`, `AE` or `AR` and now receives `CA`, `CE` or `CR`. A peer that switches on MSA-1 for the application codes alone no longer recognises the answer. Original-mode traffic, and any message with both fields empty or a header this package cannot scan, is unaffected and pinned as such. | accepted-for-0.1.0 |
| 6 | `NackEvent.ackCode` can now be `CE` or `CR` (`wild-pears-repeat.md`) | A `'nack'` subscriber that switched exhaustively over the previous code set receives a value it has no branch for. | accepted-for-0.1.0 |

**Nothing is blocking.** Every entry is a correction whose old behaviour was itself the hazard:
entries 1 and 3 turn a signal a consumer could not act on safely, and a promise that never settled,
into reportable outcomes; entries 4, 5 and 6 stop a sender concluding success from a commit the
receiving application later rejected. All six are consumer-visible and none of them removes or
renames anything, which is why the release is `minor` and not `major`. Every one of them is named in
the changeset summary that introduces it, so each reaches `CHANGELOG.md` at release without anything
being added there by hand.

### Considered, and not listed as consumer break candidates

Recorded so the list above reads as complete rather than short.

- **The ATNA transport-security option** (`proud-moons-refuse.md`). Off by default, and with it off
  this package still imposes no cipher list and the server provides no Diffie-Hellman parameters, so
  the not-selected path offers exactly what it offered before. `MllpTlsConfigurationError` can only be
  reached by setting an option that did not exist in `0.0.11`. Turning it on can stop a link that
  worked, which is the point of it being opt-in, but no `0.0.11` integration can have turned it on.
- **The differential harness** (`quiet-moons-observe.md`). Purely additive, and its own summary
  records that no warning code was renamed, removed or repurposed and no decoder tolerance widened.
- **The conformance statement** (`olive-hills-declare.md`). No behaviour moved. It does correct a
  published claim: `docs-content/framing.md` read "There is no option to emit a malformed frame" while
  `encodeFrame`'s `allowDelimiterBytesInPayload` has always been able to pass a payload's raw `0x0B`
  or `0x1C` through with a warning. That is a documentation correction about behaviour that already
  shipped, not a change to it, so a consumer's code cannot break on it.
- **The `@cosyte/hl7` peer now installing from the registry** (`olive-mountains-install.md`). Dev and
  test resolution only. The peer stays optional and stays referenced only from the
  `@cosyte/mllp/ack-from-hl7` subpath, and which version of it a consumer installs is the consumer's
  own dependency decision, unchanged by this release.
- **The package description** (`tidy-hounds-explain.md`) and the README rewrite
  (`fresh-pugs-invite.md`). Registry and front-page text. Nothing a consumer's code observes.

## Contributor-facing changes, kept out of the consumer list

These are observable only by someone working in this repository. They are recorded here and
deliberately excluded from the break-candidate table above, because a consumer installing
`@cosyte/mllp` cannot reach any of them.

- **`pnpm phi-scan` now exits 2 on an unmerged markdown file** (`olive-hounds-reconcile.md`). The
  all-mode sweep's refusals deliberately run before the name filter, so an unmerged `*.md` in the
  index refuses the sweep where it was previously skipped. Fail-safe and consistent, with a local
  cost: a merge conflict on `CHANGELOG.md` makes `pnpm phi-scan` exit 2 until it is resolved. The
  pre-commit route is unaffected and CI never has an unmerged index. Nothing about this reaches the
  published package.
- **The all-mode PHI sweep reads the git index as well as the working tree**
  (`olive-hounds-reconcile.md`). A contributor whose working tree diverges from the index now has
  both sets of bytes scanned, and two pre-existing tracked tokens are declared in the allow-list.
- **`docs-content/` is now covered by `format` and `format:check`, and a test validates the page set**
  (`lucky-otters-describe.md`). A contributor editing a page can now fail `format:check` or the page
  contract test where nothing checked those files before.
- **The conformance statement is checked against the code on every test run**
  (`olive-hills-declare.md`), and `scripts/sync-version.mjs` now rewrites the declared release
  alongside the `VERSION` export. A hand-edit of either declaration reds the suite; the release step
  does not.
- **`vendor/` is deleted and the `@cosyte/hl7` peer installs from the registry**
  (`olive-mountains-install.md`). A contributor's install and test run resolve differently.

## Pre-flight evidence

Every command below was run at the release commit, in this checkout, on Node v24.20.0 with pnpm
11.23.0. Each is reported with the status it actually returned.

| command | exit | what it reported |
|---|---|---|
| `pnpm install --frozen-lockfile` | 0 | 348 packages, lockfile unchanged |
| `pnpm typecheck` | 0 | `tsc --noEmit`, no diagnostics |
| `pnpm lint` | 0 | ESLint at `--max-warnings=0`, clean |
| `pnpm test` | 0 | 83 test files, 1392 tests, all passed |
| `pnpm build` | 0 | ESM, CJS and declaration builds for all three entry points |
| `pnpm attw` | 0 | node16 from CJS and from ESM, and bundler, green on all three code subpaths and on `./package.json`; the `node10` failures are the ignored profile this package does not target |
| `pnpm check:no-emdash` | 0 | no em dashes in tracked text files; 0 binary files excluded by the NUL rule |
| `pnpm check:no-internal-refs` | 0 | 14 public-surface files plus the npm metadata against 7 rules, and 41 source files against the doc-comment and string-literal rule sets |
| `pnpm check:agent-notes` | 0 | 22 sections, 24 pointers from 2 files all resolving, 196 tracked paths reconciled |
| `pnpm phi-scan` | 0 | OK, no hits |
| `pnpm format:check` | 0 | all matched files use Prettier code style |
| `pnpm publish:dry` | 1 | packed and listed the 25-file tarball, then refused to publish over the already-published `0.0.11`; see "The published tarball" above |

Nothing was relaxed, narrowed, allow-listed or edited to produce any of those results.

**The release is ready on the evidence above**, in the one sense this record claims: the pending set
resolves to a single `minor` release at `0.1.0`, the public surface is additive with nothing removed
or renamed, the type surface resolves on every profile this package targets, and every gate and
pre-flight command is green. It says nothing about when that release should be cut.

## Verifying this record

```bash
pnpm exec changeset status --output=/tmp/mllp-status.json
node -e "const s=require('/tmp/mllp-status.json'); console.log(JSON.stringify(s.releases,null,2))"
```

At the release commit that prints exactly one release for `@cosyte/mllp`, `"type": "minor"`,
`"oldVersion": "0.0.11"`, `"newVersion": "0.1.0"`, consuming all eleven pending changesets.
