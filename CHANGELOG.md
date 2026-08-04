# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Versions and publishing are managed with [Changesets](https://github.com/changesets/changesets);
this file is maintained by hand (Changesets handles the version bump and publish only).

## [Unreleased]

`@cosyte/mllp` is published on npm and stays on the `0.0.x`-until-first-alpha ladder, so the API can
change with no deprecation cycle. The sentence this replaces said the first pre-alpha release "will
ship" the surface below, which stopped being true the day the package first published and had been
false ever since. **No version literal is written here, on purpose**: what is published is a fact
about the registry (`npm view @cosyte/mllp version`) and about `package.json`, and a number copied
into prose here is a claim that goes stale on its own.

### Added

- **Public-surface gate (`scripts/check-no-internal-refs.sh`, `pnpm check:no-internal-refs`, and
  `.github/workflows/no-internal-refs.yml`, check-run context `no-internal-refs`).** Enforces the
  founder directive of 2026-07-27 (meta-repo `documentation/conventions.md`, "No internal project
  bookkeeping on a public surface"): a consumer surface says what the software does and what
  changed, never our item identifiers, phase and plan language, ADR numbers, meta-repo paths or
  process commentary. `PUBLIC-SURFACE-HYGIENE`.
  Ported from `ncpdp`'s copy rather than `hl7`'s, which carries three fixes the original lacks
  (the `src/` string-literal fourth pass, the plural `phases?` stem, and `/` in the ADR separator
  class), plus rule 7 (prose roadmap citation) from `cli`, the only sibling that has it.
  **The recorded figure for this repo was "mllp 4" and was wrong by two orders of magnitude.**
  Measured on the base commit `a34998a` with the final rule set, over four surfaces: public
  markdown + npm metadata **4**, `src/` doc comments **389 rows / 376 locations across 18 of the
  29 tracked source files the gate scans**, `src/` string literals **0**, and the built
  declarations **440 rows across all eight `.d.ts`/`.d.cts` files** of the three published entry
  points plus the shared type chunk. All four are now **0**, re-derived on both trees after the
  rule set was final. The "4" was the public-markdown surface alone.
  Three rule additions are this repo's own, each forced by a measured false positive rather than
  by taste: a repo-local identifier vocabulary (`PLAN`/`CLIENT`/`SERVER`/`FRAME`/`LIFE`/`OBS`/
  `WARN`/`ERR`/`SC` plus the single-letter `D`/`W`/`B`/`T` decision labels) that no sibling has
  and that was the overwhelming majority of the mass; a compound-adjective guard on the phase
  rule, because `two-phase` (HL7 enhanced acknowledgement mode) and `connect-phase` are ordinary
  vocabulary; and `where|are|was|were|during|at` on the ordinary-English lookahead, because
  `ConnectionErrorPhase` is a **published** API field whose own doc comment reads "phase where
  the error occurred".
  A **scanner-blindness self-test** refuses the run if the `grep` on `PATH` silently skips a file
  (the `-I` / `--ignore-files` behaviour of `ugrep` and of any wrapper forcing them), which is the
  fourth distinct mechanism by which gates of this family have reported OK over live violations.
  **Each surface figure above counts rows these seven rules match**, which is not the same as a
  claim that no internal reference of any kind survives. The gate reads this repository's sources
  and published docs; it does not read the built declarations it protects, and no rule detects
  prose that merely describes how the software came to exist.

- **Em-dash brand gate (`scripts/check-no-emdash.sh`, `pnpm check:no-emdash`, and
  `.github/workflows/no-emdash.yml`).** Enforces the founder directive that bans `U+2014`
  outright (`knowledgebase/06-brand/voice-and-tone.md`: "No em dashes. Ever."), which names
  commit messages explicitly. It covers both halves of the rule: every tracked file, and the
  PR title, body, and commit messages, the latter on the non-default `edited` trigger so
  retitling a PR re-checks it. Its own CI workflow rather than a job in `ci.yml`, because
  `edited` would otherwise re-run the whole Node 22 + 24 matrix on a typo fix.
  **mllp was already clean, measured over all 152 tracked files byte by byte rather than over
  markdown alone** (a markdown-only count is what wrongly cleared `dicom`, which held six live
  em dashes in four non-markdown files), so this gate changed no content and exists purely to
  stop a regression.
  The script is **composed** from three sibling copies, not taken from one: `website`'s
  NUL-exclusion shape as the base, `ncpdp`'s two route fixes (a tracked file named `-` was read
  as standard input and never opened; `-d skip` silently passed a tracked symlink to a
  directory), and `dicom`'s binary-match diagnostic branch. `website`'s shape is the right base
  here because this repo tracks one binary, `vendor/cosyte-hl7-0.0.0.tgz`, and a compressed
  stream can contain the em dash bytes by coincidence, which would red the text-only shape with
  no remediation available. **The disclosed cost, stated rather than implied: a tracked *text*
  file holding a NUL byte would be silently exempt, and seeding the tarball itself with a live
  em dash leaves the gate green. That is a miss, not a pass.** mllp has no NUL-bearing text
  file today, so the exclusion currently exempts exactly one file and that file is a genuine
  binary. The at-risk fixture class is not hypothetical, though: git calls the three
  `test/differential/fixtures/*.frame.bin` captures binary too (lone-CR HL7 v2 framing), they
  hold no NUL so they stay in scope, and each was seeded with a live em dash to prove the gate
  actually reads them. Every route by which the scan could print OK without reading its input
  was checked red before this landed, with a seeded fixture per route; the full account is in
  the script header.

### Security

- **The PHI scanner enumerates a staged rename, reads a blob that replaced a walk root, and
  refuses a root that is not a directory (`PHI-SCAN-RENAME-BLIND-AT-PRECOMMIT`).** Three holes, two
  of them on `--staged`, which is this repo's **pre-commit** gate. All three were reproduced on
  `2252d33` before anything was touched, with a synthetic name-bearing payload kept outside both
  walk roots.

  **The rename hole.** `R` (rename) and `C` (copy) are the only `--raw` statuses carrying a second
  path, and `--diff-filter=AMT` deletes such a record outright, so the route never saw one.
  Measured: `git mv <link> test/<name>` staged as `:120000 120000 <sha> <sha> R100` and `--staged`
  printed `OK, no hits` with a mode-`120000` entry sitting under a scan root; a rename that also
  substituted a real name staged as a scored rename and passed the same way, over live `PID-5` / `PID-7` /
  `PID-3` values in the destination blob. The remedy is **`--no-renames`**, and it needs no work on
  the record shape at all: the destination arrives as an ordinary single-path `A` and the source as a
  `D` the filter already drops. The enumeration is a strict **superset** of the previous one (a
  stage with no rename in it is byte-identical, pinned by a negative control), and the two-field
  stride becomes **structural** rather than conditional, because with detection off git cannot emit
  an `R` or a `C` at all. Verified under `diff.renames` set to `true`, `copies`, `false` and `1`,
  and under `diff.renameLimit=1`, so the caller's own configuration cannot reopen it. **The earlier
  disclosure that admitting these "needs the two-path record shape handled, which is a scope
  decision" was wrong**, and it was wrong because it was carried in from a sibling rather than
  measured here.

  **The root-replacing blob.** The refusal path already matched a scan root's own name, because an
  entry at exactly `test` REPLACES the root instead of sitting in it. The read filter did not: it
  wanted the `test/` prefix. So a mode-`100644` blob staged at exactly `test` was in scope for one
  and out of scope for the other, and `--staged` exited 0 over the same three fields. Both read
  predicates now admit the root's own path. **Admitting it to the read set was only half of it**:
  `looksLikeHl7` decides what scan a target earns and a path named `test` matches none of the
  fixture-like extensions, so a draft read the blob and still reported clean over a `PID`. An entry
  that replaces a root is judged with **that root's own limits**, so `test` earns the structured
  HL7 scan while `src` keeps the conservative dashed-SSN + email pass, exactly as a file inside
  either root would. Both directions are pinned.

  **The non-directory root.** A walk root that resolves to a **file** (a regular file at `test`, or
  a link to one) threw `ENOTDIR` straight out of `readdirSync`, uncaught. Node exits **1** on an
  uncaught throw, which is the code this contract reserves for "hits found", so the gate published
  a finding it had never made: a false positive that reads as actionable, which is a different and
  worse failure than a crash. A **dangling** link at a root was the silent half of the same shape,
  because `existsSync` follows: the walk returned and the sweep reported `OK` over the entire
  corpus that root stands for, with the `observed === 0` backstop unable to fire while the other
  root still had files. Both refuse now (exit 2), naming the root and its kind and **never the link
  target**. Reading whatever sits there instead was refused as the remedy: what is missing in the
  working tree is a **tree**, and one file read in its place is evidence about that file rather
  than about the corpus it replaced. `staged` mode does read such a blob, because the index holds
  no directories to lose. `walk()` also no longer lets any `readdir` failure leave the process:
  everything but `ENOENT` is now a refusal that names the directory.

  **Two more routes into the same false finding, both `PRE-EXISTING`, both closed here.** A
  **missing** allow-list threw its refusal past every `catch` in `main`, and an **unreadable**
  allow-list or override log threw a raw `EACCES`: both exited 1. Nothing ever passed the gate that
  way, because non-zero still blocks the commit, but the code said the wrong thing. Each site is
  fixed and a process-level guard now turns anything still unaccounted for into exit 2. Refusals
  also name **every** offender in one message now, roots and non-regular entries together, which is
  the rule the non-regular refusal already stated and the root refusal did not follow.

  **What did not change, deliberately, and is pinned so it stays a decision.** A root that is a
  link to a **directory** is still followed and is still link-neutral (the tree beyond it is
  scanned as the root it replaced would have been, with that root's own limits). An **absent** root
  is still legitimate and still exits 0, which is the control that separates it from a dangling
  one. Explicit-path mode still reads through a link. And the `test/` walk still excludes `.ts`
  sources, which is a separate open question about walk-root scope and is not touched here.

  16 new cases; **12 of them run red against the base scanner** and the other four are deliberate
  controls (an ordinary stage, an absent root, a linked-directory root, and the record-identity
  comparison, which is a statement about git and holds on both trees). Negative-controlled across packages too: the identical stage reports
  four HL7 field hits through this scanner and nothing through a sibling's, so the evidence is
  about this package rather than about the harness.

- **The PHI scanner refuses a non-regular entry under a scan root, on both routes
  (`PHI-SCAN-SYMLINK-BLIND-ON-BOTH-ROUTES`).** A symbolic link under `test/` or `src/` read CLEAN on
  **both** enumerating routes, so a link pointing at a PHI-bearing file passed the gate twice over.
  Reproduced on `d854e81` with a synthetic name-bearing payload kept outside both walk roots: a link
  to it under `test/` gave `all` mode exit 0 "OK, no hits"; a link to its **directory** did the same
  and took the whole subtree with it; `--staged`, which is this repo's pre-commit gate, exited 0
  after `git add`; and naming the target explicitly exited 1 with every hit. The payload was always
  detectable, the two routes never looked at it.

  Two mechanisms, two fixes. `walk()` enumerates `Dirent.isFile()`, an **lstat** answer, so a link is
  neither a file nor a directory and fell out of the loop; `isDirectory()` is an lstat answer too,
  which is how a linked directory vanished wholesale. `--staged` read content with
  `git show :<path>`, and git stores a symbolic link as its **target path** under mode `120000`, so
  it scanned the path text.

  **Neither route follows a link it finds INSIDE a scan root.** Following would read bytes the
  enumeration does not control (outside the repo, a loop, a device, a FIFO that blocks the gate
  forever), and git does not carry those bytes anyway, so a hit on them would be a claim about
  something no commit contains. The enumeration is narrowed instead: a non-regular in-scope entry
  **refuses the scan** (exit 2, the existing "could not complete" code), naming **every** offender.
  `--staged` now reads `git diff --cached --raw -z` so the destination mode is visible. The scan
  roots' own names are matched as well as the prefix, because an entry named exactly `test` or `src`
  does not sit inside a root, it **replaces** one, and a prefix test alone let a staged mode-`120000`
  blob named `test` through at exit 0.

  **The root itself is the one thing still followed, and a flat "neither route follows a link" would
  be false.** `walk()` opens `test/` and `src/` with `existsSync` + `readdirSync`, and both follow,
  so replacing a walk root with a link to a directory outside the repo makes the walk read straight
  through it. Pre-existing, and the precise reading is **not** "its PHI is reported": the tree beyond
  the link is scanned exactly as the root it replaced would have been, **with that root's own
  limits**. A fixture-like payload behind a linked `test/` is reported (measured, exit 1); the same
  payload behind a linked `src/` gets only the conservative pass and can read clean, exactly as it
  would through a real `src/`. It is link-**neutral**, which is why it is disclosed rather than
  closed: refusing a linked root is a decision about repo layout, not this defect.

  **`--diff-filter` admits `T` (typechange), and leaving it out would have made the mode check
  unreachable whenever the file being replaced was already tracked.** Replacing a **tracked** regular
  file with a link is neither an add nor a modify; git raises it as `T`, so `--diff-filter=AM` deleted
  the record before any mode could be read and the hook passed a mode-`120000` blob green. Measured on
  git 2.39.5 against a tracked `test/differential/fixtures/*.frame.bin`: with `AM` the raw output for
  that stage is **empty**. Admitting `T` also scans the reverse typechange, a link replaced by a real
  file bearing PHI. Both premises are asserted in the tests rather than trusted.

  A refusal names the entry's own repo-relative path and an engine-owned kind token, **never the link
  target**, which is working-tree text that can itself carry PHI. Pinned with a synthetic name-bearing
  payload whose target **filename** also carries a name, so the never-echo assertion is not a claim
  about an empty string. 10 of the 14 new cases are red on `d854e81`; the other four are boundary
  controls that must stay green (a gitignored entry stays exempt, an entry outside both roots is not
  refused, the committed corpus still passes, a staged regular file still scans).

  **Scope, stated rather than left to be read charitably.** "In scope" is each route's own existing
  **root**; the `.ts` / `.md` **name** exemptions deliberately do not carry over to a non-regular
  entry, because they are judgements about a file whose bytes the route could have read. `R`/`C`
  rename and copy are still not enumerated by `--staged` at all: **pre-existing** (`AM` excluded them
  too), disclosed rather than fixed. Explicit-path mode still reads **through** a link and is
  unchanged. The gitlink (mode `160000`) arm is **not** a hole this closes: `--staged`'s scope already
  reached a staged submodule under both roots and `git show` on one fails with `bad object`, so the
  base commit already refused it, and what changed is that the diagnostic now says what the entry is.
  The refuse-a-sweep-that-observed-nothing rule and the vanished-transient tolerance are untouched:
  a non-regular entry that goes away mid-sweep therefore still **refuses**, because that tolerance is
  scoped to the read and these entries are refused at enumeration. That asymmetry is deliberate in
  direction, fail-closed being the correct way for a PHI gate to be wrong, and it is not reachable
  here: nothing in this repo creates a non-regular entry under a scan root, and every one the tests
  create lives in a throwaway repo under `tmpdir()`.

  **This corrects a claim made under this same heading by the previous scanner change**, which called
  the symlink gap "bounded, because git cannot commit content through a symlink and `--staged` reads
  the index". The first half is true and the conclusion does not follow: the gate's promise is that it
  observed what is under its roots, and both routes reported clean over an entry neither had read.

- **BREAKING: ACK-correlation diagnostics no longer carry the control ID (`PHI-WARNING-MESSAGE-LEAK`).**
  The opt-in `correlateByControlId` path built its diagnostics by interpolation, and both ends were
  consumer-controlled and unbounded. The unmatched-ACK path read the **peer's** MSA-2 straight off an
  inbound frame into `MllpFramingError.message` and onto a `controlId` field of the frozen `'error'`
  payload; measured against a peer sending a 1,000,000-byte MSA-2, that produced a 1,000,026-byte
  `Error.message` and an equally large event field, both headed for a log. `MLLP_ACK_AFTER_TIMEOUT`
  did the same with the timed-out send's own MSH-10, and `MllpTimeoutError.messageControlId` carried
  it on an `Error`, whose `stack` is what an error reporter ships off the box.
  The fix is the frozen-registry shape: `src/client/ack-diagnostics.ts` holds one literal per code and
  `ackDiagnosticMessage(code)` takes **no value parameter**, so no caller can widen it into an
  interpolation site. The `Correlator` withholds the string at the source: `onWarning` now receives
  `controlIdBytes` and `onUnmatchedAck` receives a byte length (or `null` when no MSA-2 could be read
  at all), so nothing downstream of it has a control ID to interpolate.
  Breaking field changes, all pre-alpha: `MllpTimeoutError.messageControlId: string | undefined` is
  now `messageControlIdBytes: number | undefined`; the `'error'` event's `controlId` is now
  `controlIdBytes`; the `'warning'` payload for the two correlation codes is the new exported
  `AckCorrelationWarning` (`MllpWarning` plus `controlIdBytes` and `elapsedSinceSendMs`). Warning
  codes are unchanged. A truncated ID was considered and rejected, as was a hex rendering: both still
  grow the diagnostic with the input and both still disclose the bytes. This is the same answer the
  ACK adapter's verbatim-echo warning already reached.
- **A diagnostic-surface PHI gate that instantiates a client (`test/phi/diagnostic-phi-leak.test.ts`).**
  Binds the shared `assertNoDiagnosticPhiLeak` runner (`@cosyte/test-utils`, pin raised to `^0.0.2`;
  a caret on a `0.0.x` version resolves to that version exactly, so without the bump the runner is not
  even installed). Nineteen declared slots, each naming the diagnostic code it must reach, covering
  the message control ID through correlation, an ACK's own MSH-10 and MSA-3, the outbound payload
  body, embedded VT and FS bytes inbound and outbound, an oversized frame, missing leading VT,
  leading whitespace, FS without CR, LF after FS, an empty payload after a marker-bearing frame, the
  in-flight orphan on disconnect, and all three of the ACK adapter's control-ID paths (unparseable
  inbound, a provably non-verbatim echo, and an unverifiable text echo). The suite it supplements
  scoped itself to the framing layer and never instantiated a client, which is exactly why the three
  correlation surfaces were the three it could not reach. Verified red on the base commit on three
  slots before any fix existed, and re-verified by four mutations afterwards, one of which is a
  hex-encoded echo that a verbatim match cannot see and `checkLengthInvariance` catches.
  `checkLengthInvariance` is decided **per slot and by measurement**: 8 of the 19 hold it, and the
  other 11 give it up because a byte offset or a byte count is the prescribed report there and
  growth is correct. A first draft split the table in two by argument and was wrong about four
  slots, which were giving up the re-encoded-echo check for nothing.
  Scope, stated precisely rather than generously: this closes **unbounded** consumer-controlled input
  on the `correlateByControlId` path. The slot table covers three surfaces (the client, framing via
  `Connection`, and `ack-from-hl7`) and **no slot instantiates `MllpServer`**; the server's diagnostic
  surfaces were read and carry static strings, counts, or Node's own TLS and socket text, so that gap
  holds no HL7 payload today, which is why it was not urgent rather than why the table is complete.
  Two framing codes still render the hex of a **single** byte, and
  `MllpFramingError.snippet` still carries one, both bounded by design and both now described
  accurately on `MllpWarning.message` (whose doc comment claimed the opposite, and shipped that claim
  into the published declarations).
- **Repo-side PHI commit-scanner (`scripts/phi-scan.ts`), matching the `@cosyte/hl7` pilot.**
  mllp transports HL7 v2 payloads (MLLP wraps HL7 in `VT … FS CR`), so its data fixtures
  (`test/**` `.frame.bin` frames) carry the same PHI shapes hl7's do. The scanner is a direct
  port of hl7's HL7 v2 segment/field-position-aware detector (names, DOB, SSN, MRN/account,
  address, phone, email, and a site-defined `Z…`-segment name backstop) with one transport-layer
  addition: it **unwraps the MLLP frame** (strips the `VT` start-block and trailing `FS CR`
  end-block) before the HL7-aware scan, so a framed fixture's payload is scanned exactly as an
  un-framed `.hl7` file and the framing bytes cannot defeat delimiter/segment detection. The
  unwrap only ever removes framing bytes, so malformed frames (missing end-block, double-framing)
  cannot bypass it; non-HL7 binary byte/buffer fixtures fall through to a conservative dashed-SSN
  + email pass: no crash, no false positive. Anything not in the synthetic allow-list
  (`scripts/phi-allow-list.txt`) is a hit. Wired like hl7: `pnpm phi-scan`, a `simple-git-hooks`
  `pre-commit` running `phi-scan --staged`, and `run-phi-scan: true` on the CI caller; adds
  `phi-scan-overrides.md` (the audited bypass log) and `test/scripts/phi-scan.test.ts`. Tooling /
  safety only: no runtime or public-API change.

### Documentation

- **`docs-content/` brought to the full canonical Diátaxis spine.** The sidebar was a flat list
  (`intro`, `framing`, `acks`, `reliability`, `tls`, `limitations`); it is now the canonical spine
  every `@cosyte/*` package shares: Overview → Installation → Quickstart → Core Concepts (`framing`,
  `acks`) → Guides (`reliability`, `tls`) → API Reference (resolver-injected) → Troubleshooting
  (`limitations`). So a developer moving between `@cosyte/hl7` and `@cosyte/mllp` gets one
  navigation. Adds two new tutorials: **Installation** (prerequisites, the optional `@cosyte/hl7`
  peer, a runnable smoke test) and **Quickstart** (the framing round-trip, opt-in tolerance with
  stable warning codes, and the client/server surface). Every example honors the "transport, not
  parsing" boundary. Runnable snippets are now gated by the shared doc/code-agreement harness
  (`docSnippetSuite` from `@cosyte/vitest-config/snippets`, wired in `test/docs-content.test.ts`),
  which extracts each ` ```ts runnable ` block, executes it against the built package, and asserts its
  `// =>` results. A documented example can never silently drift from the shipped surface. Also
  corrects two `intro.md` snippets that referenced non-existent API (`createInMemoryTransport` →
  `InMemoryTransport.pair()`; the receive example's fictional `respond`/`buildAck` → the real
  `createServer({ onMessage })`). Bumps the `@cosyte/vitest-config` devDependency to `^0.0.2` for the
  `/snippets` export. Docs and tests only: no runtime or public-API change.
- **README header swapped from the per-package banner to the shared Cosyte lockup.** Both sides of
  this swap happened inside one unreleased window, so no published version carries the banner and
  the release notes for this version describe only the lockup. It is recorded here, where build
  history belongs, rather than dropped. The banner
  (`cosyte-banner-mllp-1200x300.png`) baked the package name and its one line summary into the
  artwork, and the `# @cosyte/mllp` H1 and the blockquote directly beneath it repeat both, so the
  same two strings appeared three times in the first four lines of the page. The header is now a
  `<picture>` carrying the theme-aware Cosyte lockup tile (`cosyte-lockup-tile-on-dark-1200x300.png`
  and its `-on-light` counterpart), which reads "Cosyte" rather than the package name, so the
  duplication goes and the heading stays untouched. The `<picture>` element was deliberately avoided
  when the banner landed, on the grounds that npm sanitizer behaviour was unverified; that has since
  been verified rather than assumed. On GitHub in dark mode `currentSrc` resolves to the on-dark tile
  with parent element `PICTURE`, and on npm the `<img>` is hoisted out of the `<picture>` by GitHub's
  anchor wrapper so the light fallback renders, which is the correct cut there because npmjs.com has
  no dark mode. The block was copied programmatically out of `hl7`'s README rather than retyped, and
  both URLs were fetched live (`200 image/png`) rather than trusted from the stored
  `published-urls.json` declaration, since a typo in either is a 404 on a public package page. The
  alt text now describes the artwork rather than the package, because a screen reader on the npm page
  should hear what the image is and the package summary is already the next line. Docs only: no
  runtime or public-API change.
- **`docs-content/installation.md` publish-status note corrected (README-ORG-SWEEP).** The Status
  callout said the package was "not yet published to npm" and that the install command was "the shape
  it will take at first publish": stale now that `@cosyte/mllp` is published on npm at `0.0.1` and
  public. Rewritten to state it is published and public, still pre-alpha on the cosyte
  `0.0.x`-until-first-alpha ladder (no API-stability promise), and that `npm install @cosyte/mllp` is
  live. Docs only: no runtime or public-API change.

### Fixed

- **The test suite stopped assuming an idle machine, and the fix was mostly to make it cheaper
  rather than to move a number.** `vitest.config.ts` carried `testTimeout: 10_000` and
  `hookTimeout: 10_000`; the shared `@cosyte/vitest-config` sets neither. Test-only change: no
  runtime, public API or published artifact is affected. `PARSER-TESTTIMEOUT-ASSERTS-AN-IDLE-BOX`.

  **What the numbers below were measured under, because the condition is the finding.** Every
  figure comes from `pnpm test:coverage`, run on a shared box that had other repos' suites on it
  throughout, with base and head **interleaved** (alternating within the same minutes, three rounds
  each) so contention cancels instead of being attributed to the change. The load-sensitive figures
  additionally come from **four concurrent coverage suites**, which is what a parallel session here
  actually does. Single figures are medians; peaks are called peaks.

  **The headline, and it is a pass/fail rather than a stopwatch reading: under four concurrent
  coverage suites the base commit FAILED three runs out of three, on correct code, and head passed
  three out of three.** Base red on `test/framing/byte-fidelity.test.ts` (the 1 MiB corpus, 31.1 s,
  over its **own** 30 s budget), on `test/conformance/quirk-corpus.test.ts` (§3.7 large payload,
  10.7 s and 14.2 s) and on `test/scripts/phi-scan.test.ts` (`--staged` negative control, 14.6 s).
  All three were spending that time on **cost rather than subject**, which is why the remedy is the
  trim and not a number.

  **`hookTimeout: 10_000` was a verbatim no-op and is gone.** Vitest 4.1.4 resolves
  `hookTimeout ??= 1e4` and `testTimeout ??= 5e3` for a non-browser run, read out of this repo's own
  installed copy. The line restated the default exactly.

  **`testTimeout: 10_000` stays, and the reason is not the one this change set out to give.** After
  the trim, the slowest case in the suite that carries **no budget of its own** is a `fast-check`
  property sweep at **2.6 s peak** under four concurrent coverage suites, and across three loaded
  runs **not one** unbudgeted case passed 5 s. (Every `attw` gate case is budgeted for this count,
  in the bare-trailing-number form described later in this entry, which is why the suite's
  slowest cases are not in it.) So neither 10,000 nor Vitest's 5,000 is what stands
  between this suite and a false red any more, and an earlier draft of this entry was wrong to say
  the framework default would sit close to reddening correct code. The literal is left alone because
  no measurement asks it to move: halving a documented ceiling with nothing near it is churn, and
  `PARSER-TESTTIMEOUT-ASSERTS-AN-IDLE-BOX` is satisfied by removing what was near it. The literal was
  never what asserted an idle box.

  **Two sites gain a budget, and no pre-existing number changes value.** The larger is `test/tls/**`,
  where every case generates an RSA key pair and completes a real TLS handshake, both CPU-bound and
  proportional to machine load, while what each case asserts is an outcome (a classification, a
  flag, a frame delivered) and never a duration. Over 96 TLS case-runs under four concurrent
  coverage suites the WANT-authorized regression **peaked at 9.70 s**, against the 10 s ceiling it
  used to run under. No TLS case was observed timing out, and the budget is not claimed to fix an
  observed red: a 3 % margin on a load-proportional case is a coin flip, and the budget is what buys
  it out of the shared ceiling. The smaller is the one case this slice adds, the `tsx`/`node` parity
  check below: it is the only case in the suite still paying a `tsx` cold start, and it **peaked at
  9.20 s** under the same four concurrent suites, which is the same argument at 92 % of the ceiling.
  On a quiet box it runs in under 2 s, so the budget looks gratuitous there and is not.

  **Trim first: the phi-scan suite was paying a `tsx` start per case.** It spawns the scanner dozens
  of times through two helpers, and on this scanner `tsx` costs **466 ms** against **137 ms** for a
  bare `node` (medians of seven, same clean fixture). The suite now spawns `node` directly and relies
  on node's native type stripping; the file went from **29.7 s to 12.4 s** **while gaining a test**.
  The gained test is the backstop: `pnpm phi-scan` still runs `tsx scripts/phi-scan.ts`, so one case
  spawns both runners on a framed violator and on a clean file and requires they agree on exit code,
  stdout and stderr byte for byte. Without it the cheap runner would be testing something the commit
  gate does not run.

  **Trim second, and this one was the surprise: `expect(a).toEqual(b)` on a megabyte of Buffer was
  the whole cost of the framing corpus test.** `toEqual` walks two Buffers element by element in JS.
  Timed around the assertion alone on a 1 MiB pair it took **8.46 s under coverage** (4.32 s without
  it), against **0.5 ms** for `Buffer.equals` on the same pair and tens of milliseconds for the
  encode and decode round trip the test exists to exercise. The two large-payload assertions (the
  1 MiB byte-fidelity corpus and the quirk corpus's accumulator-growth case) now use a native
  `Buffer.equals` through `test/helpers/bytes.ts`, which reports the first differing offset and both
  bytes on failure, so the diagnostic is better than the truncated structural diff it replaced. Those
  two files together went from **14.9 s to 1.2 s**. The helper's failure paths are pinned by their
  own tests, since a byte comparison that cannot fail is worse than the assertion it replaced.

  **Said plainly, because it is easy to oversell:** the whole-suite wall moved only from **33.3 s to
  27.8 s** (median of three interleaved rounds). The suite's critical path is
  `test/scripts/attw-gate.test.ts`, which runs a real `npm pack` per case, peaked at 43.9 s in one
  case under four concurrent suites, was not touched here, and already carries a 120 s per-case
  budget. The per-file cuts are large; the total is bounded by a file this change deliberately left
  alone.

  **One assumption carried in from a sibling repo was measured here and is false here.**
  `pnpm test:coverage` is **not** materially slower than a bare `pnpm test` on this suite: four
  interleaved rounds put the two within noise of each other, because the critical path is
  `attw-gate`'s real `npm pack` subprocesses, which v8 coverage does not instrument. Coverage is
  still the right thing to measure under, for the different reason that CI runs **both** `pnpm test`
  and `pnpm test:coverage`, so the suite is paid for twice per matrix leg.

  **The rule this leaves behind, stated once:** a case that needs more than the shared ceiling
  states its own budget at its own site and says why. **No list of those sites is kept anywhere,
  because three drafts of this entry kept one and all three named the wrong set.** Read them off the
  tests, and note there are **two spellings**: the options object (`it(name, { timeout: N }, fn)`,
  `describe(name, { timeout: N }, fn)`) and a **bare trailing number** (`it(name, fn, N)`, and the
  same on `describe`), which is
  the form the `attw` gate uses through a named constant. A search for `timeout:` alone finds
  neither the second form nor the constant, and does turn up `spawnSync`'s unrelated child-process
  kill timeout. The quirk corpus's large-payload case was briefly given a budget and then had it
  taken away again, because after the trim it no longer needed one, and a budget that changes
  nothing is the same defect as the `hookTimeout` line above.

  **Disclosed, not fixed, and it outranks everything above: the tightest idle-box assumption in
  `test/tls/**` is not a test budget at all.** Both TLS files poll with a local
  `waitFor(cond, timeoutMs = 3000)` helper, and two cases pass 5,000 ms explicitly. Those are
  wall-clock ceilings on a loaded box exactly the way `testTimeout` was, they are unchanged here and
  unchanged from base, and no per-suite budget relaxes them. They did not red in any run measured
  for this slice. Tightening them is its own slice; widening them is not obviously right either,
  since a poll ceiling is also what stops a hung case from burning the whole 60 s budget.

  **Disclosed, not fixed.** `engines.node` says `>=22.0.0`, while node's type stripping is on by
  default only from 22.18, so the phi-scan suite now needs the newer 22 that CI's 22 and 24 matrix
  already resolves to. Narrowing `engines` is a consumer-facing change and belongs in its own slice.

- **The `attw` publish gate no longer passes on a tarball that carries no types.** `pnpm attw` was
  `attw --pack . --profile node16`, and `@arethetypeswrong/cli@0.18.4`'s `getExitCode.js` opens with
  `if (!analysis.types) return 0`, so the problem list is never read and no `--profile`,
  `--ignore-rules` or config setting reaches that early return. For a package that ships types, "does
  not contain types" means the declarations were not in the tarball, which is a broken publish
  reported as a pass. A false red costs an hour; a false green merges.
  `ATTW-FALSE-GREEN-PORT`, porting the remedy that shipped in `terminology#28` (`bf153cb`).

  **Measured on this package at `0.0.6` with zero concurrency**, under the old invocation:
  `rm -rf dist && pnpm attw` printed "This package does not contain types." and exited **0**.
  Concurrency supplies only the condition, so the remedy is not a lock, a lease or a build queue: the
  gate has to be able to say its own inputs were missing, whatever removed them.

  **The exit-0 path needs the tarball to carry no declaration at all**, which is a boundary specific
  to how this package is built and is stated here because it is easy to get wrong. `tsup` emits a
  shared type chunk (`dist/index-<hash>.d.ts`) beside the three entry declarations, so deleting only
  the six entry `.d.ts`/`.d.cts` files leaves that chunk in the tarball and `attw` reds honestly
  (`❌ No types`, UntypedResolution, exit 1); the same removal **plus** `dist/index-*.d.*ts` is what
  exits 0. The build window lands in the exit-0 state regardless, because `tsup` writes JS in one
  pass and every declaration in a later one, so no moment exists where only some are present: polling
  two real clean builds here for `dist/index.mjs` and then the first declaration of any kind gave
  windows of **4.25s and 3.31s**, holding JS and zero declarations throughout. The absolute timings
  move run to run, so no single figure is quoted as "the" window; the stable claim is that the gap is
  seconds rather than milliseconds, which is wide enough for a concurrent build or `pnpm clean` to
  land `attw` in it.

  `pnpm attw` is now `node scripts/attw.mjs --profile node16`. The wrapper hardcodes `--pack .` and
  forwards the rest, so **`--profile node16` is preserved**, not dropped. Two nets, which catch
  different things: a **preflight** that every relative path `package.json` promises (`main`,
  `module`, `types`, `typings`, and every string leaf of `exports`) exists and is non-empty, which
  catches the build window and names the missing file; and a **post-check** that promotes `attw`'s
  untyped sentence to a failure, which catches declarations present on disk but excluded from the
  tarball by `files`/`.npmignore` (no instance of that is on record here). This package declares
  three subpaths, so the preflight has **twelve** artifact paths to check. Because the post-check
  reads a string, the options that would hide it are refused by name and wholesale rather than by
  value: `--quiet`/`-q`, `--format`/`-f`, `--config-path`, and a `.attw.json` setting `quiet` or
  `format`. The first three of those were re-measured here, on this package's own untyped pack and
  under its own `--profile node16`, each handing back exit 0 with the sentence unreadable;
  `--config-path` is refused by inference, not measurement.

  **Disclosed gap:** the preflight cannot see that shared type chunk go missing, because
  `package.json` names it nowhere. It is left to the post-check and to `attw` itself rather than
  papered over with a glob. For the same reason the preflight's failure message does not promise
  which way `attw` would have gone, since it cannot tell the two states apart.

  `test/scripts/attw-gate.test.ts` pins both nets against the real binary, including **the upstream
  exit 0 itself** (so an `attw` upgrade that rewords the sentence or fixes the exit code reds the
  suite rather than letting the net go slack), that the preflight reaches a **subpath's `require`
  branch** and not just the root entry, **the boundary above** (a tarball keeping a shared chunk reds
  on `attw`'s own account, so the failure message must not claim the exit-0 counterfactual), that
  **`--profile node16` survives the wrapper** (the fixture is red under the default profile and green
  under `node16`), a **negative control** on a well-formed package, and that a **real `attw` failure
  still fails** with `attw`'s own exit status. Build and
  packaging only: no runtime, framing, transport, or public-API change.

- **The PHI scanner no longer refuses an entire sweep because a transient file went away while it
  was reading.** `all` mode lists `test/` + `src/`, then reads each file; anything created and
  removed inside that window made a read throw `ENOENT` and took the whole scan down with it
  (exit 2, the invocation-error code). The refusal was never wrong, the **enumeration** was, so the
  enumeration is what changed. `PHI-SCAN-ENUMERATE-THEN-READ-CLASS`, porting the remedy that
  shipped in `ccda#80`.

  **This repo is genuinely reachable, and that was measured rather than read off the code.** With a
  `git` shim first on `PATH` (the scanner runs `git` between the walk and the first read, so the
  shim is a deterministic hook into exactly that gap), a `test/phi-scan-cap-*/capture.txt` removed
  in the window made `pnpm phi-scan` on this checkout exit 2. Those directories are not
  hypothetical: `test/scripts/phi-scan.test.ts` `mkdtemp`s two of them inside `test/`, which IS a
  walk root, and polling the tree during a suite run measured each existing for about **510 ms**
  (about 1.03 s of exposure per `pnpm test`). The siblings are spared only because their walk roots
  are not the repo root, which is where a build transient lands. **The exposure is real but not
  self-triggering:** nothing in this repo runs an `all`-mode sweep beside the suite (CI runs
  `pnpm phi-scan` as a step strictly before `pnpm test` in one sequential job, the pre-commit hook
  runs `--staged` and reads blobs from the index, and inside the test file the sweep is ordered
  before both capture tests), so what is live is a hand-run or agent-run sweep during a test run.
  Racing 88 sweeps against 6 suite runs produced 0 refusals, which is consistent with the measured
  duty cycle: walk 2-4 ms, `git check-ignore` 6-9 ms, reads 11-19 ms, inside a ~4 s process.

  **Exactly one case is now tolerated:** a file the walk enumerated **itself**, that **git does not
  track**, failing with **`ENOENT`**. It is reported on stderr as skipped, naming the path, and is
  never silent. **Still refusing:** a tracked file that cannot be read, any non-`ENOENT` failure, a
  tolerated file back on disk at sweep end, a `git` that cannot report the tracked set, and an
  **empty** tracked set (a removed `.git/index` exits 0 with no output, which would make every file
  untracked and quietly delete the tracked-file bound; a corrupt one exits 128 and was already
  caught). `all` mode additionally refuses when it observed **no** files, so the tolerance can never
  decay into a clean report of nothing.

  **Which bounds are pinned, and which are only disclosed.** Pinned by eight tests in
  `test/scripts/phi-scan.test.ts`, each against a throwaway tree under `tmpdir()` (seven of them a
  git repo, one deliberately not) and **five** of them driven by the `git`-shim technique, with no
  sleep and no real build: the tolerance itself; the tracked-file bound; the `ENOENT`-only bound
  (`EISDIR` via a decoy replaced by a directory); git unable to answer; the empty tracked set;
  `observed no files`; a violator in an untracked file that does not vanish; and a violator inside a
  transient that is still there when the read arrives. Each bound was **mutation-tested**: widening
  `tolerateVanish` to `true` fails three of them, dropping the `ENOENT` check fails one, dropping
  the `size > 0` guard fails one, and dropping the `observed === 0` refusal fails one. **Not pinned,
  and measured as not pinned:** the back-on-disk re-check. Stubbing it out leaves all 40 tests
  green. Reaching it needs a timed re-create against a deliberately slowed sweep, and a
  load-sensitive sleep guarding a load-dependent race is the failure mode this defect itself
  teaches; losing that branch loses the re-check, never the tolerance's bounds. **The gate drove
  that branch by hand** (shim anchored on the second git call, `git ls-files`, against a 20,000-file
  read loop with a tuned re-create delay) and confirmed the code right at all three delays, so the
  branch is measured-correct and unpinned rather than unknown.

  **Two residuals carried, not closed.** The post-sweep re-check is keyed on the enumerated PATH,
  not on content, so an untracked file RENAMED inside the window goes unscanned under a clean
  report; it is bounded (committing the file means `git add`, after which it is tracked and
  untolerable) and closing it needs a content-addressed sweep, a different design rather than a
  wider bound. And `walk()`'s own `existsSync` -> `readdirSync` race, one phase earlier, is
  untouched: a directory removed in that window throws a plain `SystemError` `main()` does not
  convert, so Node exits **1**, the code the contract reserves for "hits found". It matters more
  here than in the siblings because this repo's transient is a **directory**, removed wholesale, and
  it is unpinnable by the same technique because nothing runs before the walk.

  **The suite keeps writing inside the walk root, deliberately.** The two capture tests exist to
  prove that a file whose repo-relative path starts with `test/` earns the structured scan, so the
  path is the fixture and moving them would delete what they test.

  **Three things the gate checked hardest and could not break, recorded so they are not re-derived.**
  The tracked-set spelling comparison holds: instrumented against this checkout, **zero** files come
  out `tolerateVanish: true`, so the tolerance is inert on a clean tree, and a purpose-built repo of
  15 adversarial tracked filenames (space, tab, newline, quote, backslash, `$`, `*`, `;`, non-ASCII,
  CJK, emoji, plus an invalid-UTF-8 name) never marked a tracked file untracked, because `-z`
  suppresses `core.quotePath` on both sides. The tolerance cannot reach `paths` or `staged` mode,
  and `--allow-fixture` forces `mode = "paths"`, so an allow-list subtraction can never be used to
  drive `all` mode to zero observed files. And in `all` mode `report()` is unreachable while
  `observed === 0`, while in every mode a sweep that observed nothing has no hits to publish.
  (`staged` legitimately reaches `report()` at `observed === 0` and prints `OK, no hits` when a
  commit stages nothing in scope, which is why the refusal is scoped to `all`.)

  **Two scope notes surfaced by the same review, one pre-existing and one introduced here.**
  PRE-EXISTING: `walk()` tests `e.isFile()`, which is false for a symlink Dirent, so a symlinked
  file under `test/` or `src/` is never swept in `all` mode. **The "bounded" reading recorded here
  was wrong and is corrected under Security above (`PHI-SCAN-SYMLINK-BLIND-ON-BOTH-ROUTES`): git
  not committing content through a link does not make a route that reports clean over an unread
  entry safe, and `--staged` reading the index is exactly how the link's target path text got
  scanned in place of any content.** INTRODUCED by this change: a
  tolerated skip exits **0** with only a stderr line, including in CI, where the tree is at rest and
  a skip is therefore anomalous by definition. On the base commit that same input exited 2. Both are
  stated rather than changed: the first is not this defect, and the second **is** the shipped design
  under review.

- **Three doc comments that had outlived the code they described**, all of which shipped into the
  published type declarations. The `'reconnecting'` payload was documented as carrying
  `connectionId` only, while `MllpClient` populates `attempt` and `delayMs` when it schedules a
  reconnect; a bare `Connection` does emit `connectionId` alone, which is why the false sentence
  was CUT rather than replaced with a blanket promise. `MllpServer.getStats()` was documented as
  returning 0 for `totalBytesIn`/`totalBytesOut`, which it aggregates across live connections; and
  `createStarterServer` was documented as a stub while being fully implemented. The `createClient`
  examples also showed `send()` commented out as not yet available. `PUBLIC-SURFACE-HYGIENE`.

- **`docs-content/installation.md` said the package is published at `0.0.1`.** It was `0.0.2`,
  verified against the registry. The number is now gone from that status line rather than
  corrected: a pinned version on a live page has a one-release half-life, and the changeset in this
  very change bumps the package again, so writing today's number back would have reproduced the
  defect. The ladder statement beside it already tells a reader what they need. A stale claim on a
  page published to docs.cosyte.com, and a reminder that no pattern finds a statement that was true
  when it was written. `PUBLIC-SURFACE-HYGIENE`.

- **`Connection.beforeClose` no longer claims the server and client register drain logic through
  it.** They do not: `MllpServer` assigns an explicit no-op and `MllpClient` never assigns the hook
  at all, and its `close()` REJECTS pending sends rather than draining them. The doc now describes
  the hook as what it is: a replaceable pre-close step, promising no drain. **The falsehood is older
  than this change** (it read as a phase-labelled plan before), but stripping the phase label turned
  a plan into a flat present-tense assertion about two exported classes, which is worse; a refuter
  caught it. On a healthcare transport the difference matters, because it told a consumer `close()`
  drains in-flight ACKs. Fixed alongside it, and PRE-EXISTING: a missing separator between an
  internal design label and the following clause on the exported `isTransientConnectionError` JSDoc,
  which left a malformed sentence in the shipped declarations. `PUBLIC-SURFACE-HYGIENE`.

- **`ack-from-hl7`: a non-text `encoding` override is now rejected on a `Buffer` inbound too, not just
  the text path, and this fixes a flaky `verify` failure (MLLP-ACK-NONTEXT-CODEC-BUFFER).**
  MLLP-ACK-NONTEXT-CODEC-FRAME (below) spared the `Buffer` path on the belief that a lossy `Buffer`
  override was already caught loudly by the byte-level `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` check. That
  holds for a lossy **charset** codec (`ascii` masking a high bit) but not for a genuinely non-text one.
  A non-text codec (`base64`/`base64url`/`hex`/`utf16le`/`ucs2`) garbles the **inbound** decode:
  `buf.toString("base64")` never begins with `MSH`, so it always routes to the unparseable fallback,
  whose MSA-2 is empty and whose `verifyVerbatimEcho` short-circuits before the NOT_VERBATIM proof can
  run, and then serializes that fallback ACK with the same codec, decoding the ACK text to random
  bytes that ~3–4 % of the time contain a `VT`/`FS` byte and make the strict `encodeFrame` throw a
  nondeterministic `MllpFramingError`. So the path was neither the "loud AE" it was documented to be
  nor caught by any falsifiable check. It was an unreadable frame that sometimes crashed. It surfaced
  as CI flake: the `verify` test asserting a reliable `AE` tripped `encodeFrame` on **both** Node 22
  and Node 24 (the base64 decode is byte-identical across the two: never a runtime divergence, only a
  coin-flip draw of the fallback's generated MSH-10 that landed differently on the two matrix legs of
  one run). `buildMllpAck` now throws a `TypeError` at the boundary for a non-text codec on **any**
  input shape, deterministically. The legitimate byte-level escape hatch is preserved untouched:
  `latin1` (byte-verbatim default for a `Buffer`), `ascii`, `utf8`, and `binary` are still accepted,
  and a lossy charset override on a `Buffer` is still caught loudly by
  `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. No warning code or other public type changes.
- **`ack-from-hl7`: a non-text `encoding` override on a text inbound is rejected at the boundary
  instead of emitting a garbage frame (MLLP-ACK-NONTEXT-CODEC-FRAME).** On a `string` / `Hl7Message`
  inbound the resolved codec is used only to serialize the ACK back to bytes. A **text** codec
  (`utf8`/`ascii`/`latin1`) writes the ACK's characters as a byte stream a peer reads back as HL7; a
  **non-text** one does not: `base64`/`base64url`/`hex` reinterpret the ACK *string* as encoded data
  and decode it to unrelated bytes, and `utf16le`/`ucs2` NUL-pad every byte, so the emitted frame is
  wholesale garbage the receiver cannot parse. This was never the silent-corruption class the
  `ascii`-override bleed (above) was: a garbage frame has no readable MSA-2, so the receiver's
  `extractMsaControlId` returns `null` and the ACK-FAILSAFE path already downgrades to a loud `AE`.
  The gap was ergonomic: the unusable ACK was handed back to be written to a socket and found broken
  a round trip later. `buildMllpAck` now throws a `TypeError` at the boundary for a non-text codec on
  a text inbound (exactly as it already does for an unknown `code`), naming the remedy: use a text
  codec, or pass the raw `Buffer`. Scoped to the text path only: on a `Buffer` inbound a codec
  override remains the documented escape hatch, and a lossy one there is still caught loudly by the
  byte-level `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` check. Default `utf8`/`latin1` paths and all-ASCII
  control IDs are unaffected; no warning code or other public type changes.
- **`scripts/sync-version.mjs` hardened against two latent defects, and gated in CI
  (SYNC-VERSION-HARDENING).** Follow-up hardening on the VERSION-SYNC script; ported byte-identically
  across `hl7`, `x12`, and `mllp`. (1) The version was spliced into `src/index.ts` via
  `String.prototype.replace` with a _replacement string_, which interprets `$&`, `$1`, `` $` ``, etc.,
  so a version like `1.2.3-$&x` would inject the matched text and corrupt the `VERSION` constant while
  exiting 0. The replacement is now a replacer _function_, whose return value is inserted literally.
  (2) The declaration regex was non-global, so `.replace` silently rewrote the _first_ match; a
  column-0 decoy (e.g. inside a comment) ahead of the real declaration could be edited instead. The
  script now matches globally, asserts exactly one declaration, and exits non-zero loudly otherwise.
  Neither defect is reachable through Changesets today and both previously failed loud rather than
  shipping a lying `VERSION`, so this is hardening, not a fix for an observed break. The
  `format`/`format:check` globs now cover `scripts/**/*.mjs` so the script is prettier-gated in CI (it
  was matched by no glob before); widening the gate also reformatted the pre-existing
  `scripts/generate-test-certs.mjs` (cosmetic quote/wrap only). Build tooling only: no runtime or
  public-API change.
- **`ack-from-hl7`: a lossy `{ encoding: "ascii" }` override on a text inbound can no longer corrupt a
  control ID silently (MLLP-ACK-ASCII-OVERRIDE-BLEED).** The residual path the double-encode fix below
  did not close. `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` originally flagged a text inbound by inspecting the
  **emitted** MSA-2 bytes for a non-ASCII value, a proxy with a blind spot on a lossy override. Node's
  `ascii` codec truncates a code unit to its low 8 bits, so a control-ID code unit above `0xFF`, e.g.
  `U+0153` (`œ`, what a windows-1252 decode yields for a `0x9C` wire byte), is masked *into* the ASCII
  byte range (`0x53`, `'S'`). The emitted MSA-2 is then all-ASCII, the proxy stayed silent, and a
  positive `AA` went out echoing a **different** control ID the sender cannot correlate (ACK timeout →
  resend → **duplicate clinical message**). The check now reads the MSA-2's **pre-encoding code units**
  instead of the emitted bytes, so a non-ASCII code unit is flagged whatever the codec did to the byte,
  a strict superset of the old test (encoding ASCII code units can never produce a non-ASCII byte), so
  the default `utf8` text path is unchanged and all-ASCII control IDs stay quiet. No public-surface
  change; the warning still carries byte/code-unit lengths only (PHI discipline) and names the same
  remedy: pass the raw `Buffer`.

- **`ack-from-hl7`: the `string`/`Hl7Message` overload no longer double-encodes a high-bit control ID
  silently.** `buildMllpAck` re-encodes a decoded-text inbound with the JS-native `utf8` default, so
  `buildAckAA(payload.toString("latin1"))` on a control ID of `A <0x8B> B` (legal under `MSH-18` =
  `8859/1`) emitted MSA-2 as `A <0xC2 0x8B> B`, a *different* control ID. The sender keyed its
  in-flight store on `0x8B`, could not match the ACK, timed out, and resent a **duplicate clinical
  message**. The `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` guard could not see it: on a text inbound it
  re-derives the inbound bytes from the same text with the same codec, so the comparison is a
  tautology. The encoding cannot be fixed from decoded text (a string does not remember its codec), so
  this is an **API-shape** fix: the text path now emits a new, distinct warning code,
  **`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`** (exported from `@cosyte/mllp/ack-from-hl7`), whenever the
  emitted MSA-2 holds a non-ASCII byte on a `string`/`Hl7Message` inbound, a *cannot-verify* signal,
  deliberately separate from the `Buffer`-path *proof-of-mismatch*. An all-ASCII control ID stays
  quiet; the warning carries byte lengths only (PHI discipline) and names the remedy: pass the raw
  `Buffer`. Found by the 4th MLLP-ACK-UTF8 conformance-refuter.

- **Removed ten orphan gitlinks from `.claude/worktrees/`.** A commit captured local agent worktree
  state as ten mode-`160000` gitlinks with no `.gitmodules` entry, pointing at objects that never
  existed in this repo. This is the ADR 0004 failure mode that `iac` and `pathways` each produced;
  it went unnoticed here. `.claude/worktrees/` is now gitignored so it cannot recur. Repo hygiene
  only: nothing in `src/`, `test/`, or the published tarball is affected.

- **The Release workflow can actually start.** `.github/workflows/release.yml` calls the shared
  `cosyte/.github` pipeline, which requests `contents`/`id-token`/`pull-requests: write`, but declared
  no `permissions:` of its own, so it inherited the repo default of `contents: read`. A called
  workflow may only downgrade the caller's `GITHUB_TOKEN`, never escalate it, so GitHub rejected the
  workflow at startup (~1s, no jobs, no logs). Every Release run from June 2026 until now failed this
  way, unnoticed, because a `startup_failure` produces no logs to read. The caller job now declares
  the three scopes explicitly. CI-only: no runtime or API change.

- **`buildRawAck` and the server's auto-ACK path said "AA, I've got it" for messages they could not
  correlate (MLLP-ACK-FAILSAFE).** A positive acknowledgement tells the sender it may forget the
  message; when the ACK names a control ID the sender cannot match (or names one of several messages
  it never read), the sender times out and resends, committing a **duplicate clinical message** (or
  believes a destroyed message was delivered). `buildMllpAck` already downgraded and warned; the raw
  builder and the default `autoAck: 'AA'` path did not, and four peer-reachable inputs (all
  pre-existing on `main`) produced a positive `MSA|AA|`: (1) an inbound with an empty MSH-10, (2)
  **two concatenated `MSH` messages** in one frame (an `AA` naming only the first, message 2 silently
  unacknowledged), (3) a **`BOM`/`SP`/`TAB` before `MSH`** (the junk shares the MSH's segment line, so
  `MSH` heads no segment → unreadable → `MSA|AA|` with an empty MSA-2, no warning), and (4) worst,
  verified over a real socket, a **raw `VT` inside a payload**: the decoder discards the accumulated
  bytes (`MLLP_TRAILING_BYTES`) and delivers only the *fragment* after it, which the server auto-ACKed
  `MSA|AA|`: the clinical message destroyed and positively acknowledged. A requested positive code
  (`AA`/`CA`) is now **downgraded** to `AE`/`CE` whenever the payload cannot carry a correlatable
  positive ACK: no readable `MSH`, an empty MSH-10, a batch/concatenated-message shape
  (`FHS`/`BHS`/`BTS`/`FTS` or a second `MSH`), or, on the server path, a frame the decoder flagged
  with discarded bytes. This is a **refusal**, not a widened reader: it never makes an unreadable
  message readable, re-bases on a located `MSH`, or parses a batch. Batch ACK stays its own unbuilt
  feature (`MLLP-BATCH`), a loud non-positive answer. The wire downgrade in `buildRawAck` protects any
  direct caller (defense in depth); the server re-checks the same condition so the downgrade is
  **observable**, emitting a PHI-safe `'nack'` event with a new `reason`
  (`'handler-rejected' | 'uncorrelatable-inbound' | 'discarded-bytes'`), never the payload or control
  ID. New exports: `rawAckUncorrelatable(payload)` and the `NackReason` type. As part of this,
  `MLLP_TRAILING_BYTES` is now **reserved for the mid-payload `VT` discard** (a frame-scoped signal)
  and is no longer emitted (nor mis-attributed to the *next* frame) for an inter-frame stray byte
  under `allowFsOnly`, which `MLLP_FS_WITHOUT_CR` already reports; without that, a good message
  pipelined after a stray-byte frame would have been wrongly downgraded to `AE` (caught by the
  conformance gate).
- **The MSH-10 scan ran past the segment terminator and returned the patient's MRN as the
  correlation key (MLLP-ACK-UTF8; found by the conformance gate).** `extractMshControlId` counted
  field separators without ever stopping at `CR`/`LF`. On a **truncated MSH** (one with fewer than
  10 fields, which is malformed, but is precisely what a broken peer sends), the count therefore ran
  *past the segment terminator* and kept counting inside the next segment. Given
  `MSH|^~\&|EPIC|HOSP|MIRTH|LAB` + `PID|1||MRN00042|…`, the "MSH-10" it returned was **`PID-3`: the
  patient's medical record number**. `MllpClient.send()` calls this on every outbound payload in
  controlId mode, so that value became the correlator's key, and was carried into
  `MllpTimeoutError.messageControlId` and the `MLLP_ACK_UNMATCHED_CONTROL_ID` /
  `MLLP_ACK_AFTER_TIMEOUT` warnings: **a patient identifier in a log line, and a mis-read one at
  that**, plus a correlation key that is not the control ID the peer will ACK. Present since Phase 5
  and untouched by MLLP-CORRELATOR-ASCII, which fixed the *decode* of this scan but not its
  *bounds*. Fixed: the scan is now `readMshSegment`, which bounds the MSH at its terminator before
  reading any field out of it. A field that does not exist reads as **absent**, never as the next
  segment's contents.
- **`ack-from-hl7` could not echo a control ID verbatim, so a cosyte client could not correlate a
  cosyte server's ACK (MLLP-ACK-UTF8).** `buildMllpAck` decoded the inbound through the peer
  parser's charset machinery and re-encoded the ACK through a hardcoded **`utf8`**. The two are not
  inverses. A control-ID byte `0x8B` (legal under an `MSH-18` of `8859/1`, and the exact case
  `MLLP-CORRELATOR-ASCII` had just fixed on the client) came back out of MSA-2 as the **two** bytes
  `0xC2 0x8B`: a *different* control ID, so HL7 v2.5.1 §2.9.2.2's verbatim-echo requirement was
  violated. The client keys its in-flight store on the raw bytes it sent, so it could not match that
  ACK: the send never settled → ACK timeout → resend → **duplicate clinical message**. This was the
  third and last of the three call sites that each re-derived "read the control ID" independently and
  each got it wrong differently.
  - `Buffer` input is now decoded as **`latin1`** and the ACK re-encoded with the same codec, one
    symmetric choice, so the round-trip is the exact identity for any inbound bytes. `latin1` is the
    only codec for which that holds: `ascii` masks the high bit, `utf8` folds invalid sequences onto
    `U+FFFD`, and a `TextDecoder`'s `iso-8859-1` label is aliased by the WHATWG Encoding Standard to
    **windows-1252** (`0x8B` → `U+2039`), which does not round-trip `0x80`–`0x9F` at all, so the
    decode had to be taken away from the charset-aware parser and done on the bytes directly.
    `string` / `Hl7Message` input keeps its `utf8` default (the caller already chose the decode).
  - The MSH read is now **one** implementation, `readMshSegment` in `src/internal/control-id.ts`,
    genuinely *called* by all three consumers: the client correlator, `buildRawAck`, and
    `buildMllpAck`. `buildRawAck` previously re-derived its own read
    (`payload.toString("latin1").split("\r")`, hunting for an `MSH` anywhere in the payload), and
    the two disagreed on real inputs: on a truncated MSH followed by a `PID` the correlator keyed on
    the PID's MRN while `buildRawAck` echoed an empty MSA-2; on a payload with a **leading `CR`** (
    which the MLLP decoder passes straight through) `buildRawAck` echoed MSH-10 correctly while the
    correlator, requiring `MSH` at byte 0, gave up. Every such disagreement is an ACK the sender
    cannot match.
  - They now agree at the **tolerant** fixed point, not a lossy one: `readMshSegment` **locates** the
    `MSH` (the first `CR`/`LF`-delimited segment starting with `MSH`) instead of demanding it at byte
    0, so a leading `CR`/`LF` or an `FHS`/`BHS` batch header (§2.10.3) cannot hide a control ID that
    is plainly present, and *then* bounds the field scan at that segment's terminator. Both rules
    are needed and neither may be traded for the other. An interim version of this fix forced
    agreement by requiring `MSH` at byte 0 everywhere, which "resolved" the leading-`CR`
    disagreement by degrading the side that was **right**: `buildRawAck` began emitting a positive
    `AA` with an empty MSA-2, **silently**, for a message whose MSH-10 was there to read, a
    tolerance regression that manufactured the very duplicate-message failure this item exists to
    close. A lenient reader may never drop data that is present (Postel's Law). `buildMllpAck` strips **leading
    segment terminators only** before parsing, for the same reason and no further: `parseHL7` requires
    `MSH` to be the first segment, and a leading `CR`/`LF` is pure terminator noise carrying no data,
    so dropping it can hide nothing.
  - **An HL7 batch (§2.10.3) is still refused, loudly.** `buildMllpAck` does not implement batch ACK,
    so an `FHS`/`BHS` envelope falls through to `parseHL7`'s `NO_MSH_SEGMENT` and out into the
    warned, non-positive `AE` fallback, exactly as before this item. An interim version of the fix
    above re-based the payload on the *located* `MSH`, which skipped the batch envelope: the builder
    then parsed only message 1, silently discarded every later `MSH` and the `BTS`/`FTS`, and returned
    a positive **`AA` correlated to message 1 with zero warnings** for a batch whose messages 2..N it
    had never read, telling the sender the whole batch was accepted. A positive ACK for a message
    nobody looked at is what the commit contract exists to make structurally impossible. Batch ACK is
    its own feature; it is not something to arrive at by accident via a byte-offset helper.
- **`buildRawAck` assumed `|` was the field separator instead of reading MSH-1
  (MLLP-ACK-UTF8, sibling).** MSH-1 *is* the field separator (HL7 v2.5.1 §2.5.4), the byte at
  offset 3 of the MSH segment defines it, and the client-side scanners had always read it
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
  with `ascii` (`byte & 0x7f`), the same class of bug the Phase 10 entry below fixed in
  `buildRawAck`, left behind on the client side since Phase 5, so the server's MSH-10 → MSA-2 echo
  and the client's read-back did not agree on what a control ID *is*. The extracted string **is**
  the correlator's key (live store, graveyard, ACK lookup), so a lossy decode is a lossy key: the
  two legal, distinct control IDs `MSGÉ1` and `MSGI1` (`0xC9 & 0x7F === 0x49`) collapsed onto one
  key, the second `enqueue()` overwrote the first in the `Map`, and the first send could never be
  settled by its own ACK. The masked ID was also what reached `MLLP_ACK_UNMATCHED_CONTROL_ID` /
  `MLLP_ACK_AFTER_TIMEOUT` observers and `MllpTimeoutError.messageControlId`, an ID that was never
  on the wire, misdirecting the operator tracing a lost message. Reachable when MSH-18 declares a
  non-ASCII charset (e.g. `8859/1`). Fixed: both extractors decode `latin1` (1:1 byte↔code-unit, so
  distinct bytes stay distinct keys and no VT/FS can be synthesized). Six tests added under
  `test/client/correlator-controlid.test.ts`, each failing under the old decode, one of them a
  cross-path round-trip pinning `buildRawAck`'s echo and the client extractors to the same key.
  Pure-ASCII control IDs are unaffected. **Scope at the time:** the two paths agreed byte-for-byte
  only for the `|`-delimited messages `buildRawAck` supported: it still hardcoded `|` where the
  extractors read the separator from MSH-1, and the `ack-from-hl7` subpath still round-tripped
  control IDs through `utf8`. Both of those were left pre-existing then, and are **closed by
  MLLP-ACK-UTF8** (above); the scanners are now a single shared implementation.

- **A peer could crash the server with one high-bit byte, and corrupt the ACK control ID
  (Phase 10).** `buildRawAck` decoded the inbound message with `ascii`, which masks the high bit
  (`byte & 0x7f`). Two consequences, both serious. **Spec:** MSA-2 must echo the inbound MSH-10
  **verbatim** (HL7 v2.5.1 §2.9.2.2), but a control-ID byte `0x8B` silently became `0x0B` (a
  *different* id), breaking the sender's own ACK correlation for any non-ASCII charset. **Safety:**
  `0x8B → 0x0B` is a **VT** and `0x9C → 0x1C` is an **FS**, so `ascii` *synthesized framing
  delimiters* from ordinary payload bytes; a peer sending one high-bit byte in an echoed MSH field
  made the ACK payload contain a real VT/FS, which `encodeFrame` (strict) rejected, and that throw
  escaped the `void`-ed `_sendCommitAck`, **crashing the whole server on peer-controlled input with
  no consumer bug at all**, and suppressing the fail-safe ACK. Fixed: `buildRawAck` uses `latin1`
  (byte-exact; a delivered payload cannot itself contain VT/FS, and `latin1` cannot synthesize
  one), and `_dispatchAck` is now **total**: a frame failure (still reachable via a caller's
  `autoAck: fn`) surfaces as a connection `'error'` and the message goes un-ACKed (fail-safe: the
  sender resends), never a process kill. New suite `test/server/ack-serialization-safety.test.ts`.
- **Anything throwing on the receive path crashed the whole process, four routes, all closed
  (Phase 10).** `FrameReader.push()` runs synchronously inside the transport's data callback, which
  on a real socket **is** the `'data'` listener, so any throw there is an **uncaught exception** that
  kills the process, every other connection and every in-flight durable commit with it. The
  conformance gate refuted the fix three times, each round surfacing a route the previous fix had
  missed, **four** in total:
  1. **The decoder's own throw**: `Connection` fed `push(chunk)` with no `try`/`catch`. Reachable on
     a **default server from a single byte**: `SERVER_DEFAULT_FRAMING` leaves `allowMissingLeadingVt`
     off, so any non-whitespace byte where a `VT` was expected threw `MLLP_MISSING_LEADING_VT`
     (`MLLP_FRAME_TOO_LARGE` reached the same path). One stray keepalive character from a real
     interface engine was enough.
  2. **`emit('error')` with no listener**: Node raises `ERR_UNHANDLED_ERROR`, and that throw happened
     *inside the catch block added for (1)*, escaping by the identical route. `MllpServer`/
     `MllpClient` each attach an `'error'` listener, which masked it; `Connection` is a public export
     and need not.
  3. **A throwing `'message'`/`'warning'` subscriber**: `onFrame` dispatches synchronously inside
     `push()`, so an ordinary consumer bug (a metrics tap, a logger) unwound through the socket
     handler too.
  4. **The five lifecycle emits**: `destroy()` → `_transition()` → `emit('stateChange'|'close'|…)`
     runs *inside* the catch block added for (1), and a throw raised inside a `catch` is **not**
     caught by that block. A throwing `'close'` subscriber plus one stray byte still killed the
     process, four frames up.

  Enumerating routes one at a time is what produced a fourth, so the rule is now **structural: no
  `emit()` in `Connection` may reach a transport callback.** All eight events dispatch through
  containment, pinned by a test that attaches a throwing subscriber to every one of them at once.

  Now: a fatal framing error surfaces as a frozen `'error'` event (`phase: 'receive'`,
  `connectionCause: 'framing-fatal'`, the `MllpFramingError` preserved as `cause` so the stable
  `code`/`byteOffset` survive) and **only that connection** is destroyed. A server drops the one bad
  peer and keeps serving. Every `'error'` emit is guarded by `listenerCount` and wrapped. Subscriber
  throws are contained per-subscriber at the dispatch site, what WARN-06 always promised but only
  half-implemented (the `onWarning` *option* was guarded; the event broadcast was not). A fatal
  framing error is also reported **exactly once** now: `destroy(err)` forwards the reason to
  `transport.destroy(err)`, which made a real socket echo it back through `_onTransportError` and
  emit a second, causeless `'error'`, double-counting on an alerting dashboard. The
  connection is destroyed rather than resynchronized deliberately: after a throw the reader's position
  in the byte stream is untrustworthy, and guessing where the next frame begins is how a clinical
  message gets silently mis-split. The existing suites missed all of this because the in-memory
  transport wraps delivery in `try`/`finally`, re-routing the throw to the *writer*; only a real
  socket reproduces it. New suites: `test/server/framing-error-containment.test.ts` (real loopback
  sockets) and `test/connection/receive-containment.test.ts` (drives the data callback directly),
  both verified to fail without the fixes.
- **A fatal framing error triggered an unbounded reconnect storm (Phase 10).**
  `isTransientConnectionError` switches on `err.code` and fell through to `default: return true`, so a
  `MllpFramingError` was classified **transient**. `createStarterClient` (where `autoReconnect`
  defaults **on**) therefore retried forever against a peer that was not speaking MLLP (an HTTP probe,
  a health check, a wrong-port misconfiguration) with the backoff hammering an interface engine that
  was already misconfigured. `MLLP_*` codes are now **permanent**, alongside the TLS classes and for
  the same reason: every reconnect meets the same bytes.
- **A throwing `'message'` observer suppressed the ACK (Phase 10).** `MllpServer` emits `'message'` to
  observers *before* ACK dispatch (D-03), so an observer that threw aborted the handler before the ACK
  was sent. One broken logger silently turned every message into a no-ACK, and every sender resent
  forever with nothing to diagnose it by. The emit is now contained: the throw surfaces on `'error'`
  and the commit contract proceeds untouched. The ACK decision belongs to `ServerOptions.onMessage`
  (the durable-commit step), not to a metrics tap.
- **Release pipeline could not have released (Phase 10).** The shared `cosyte/.github` release
  workflow drives Changesets with `version: pnpm run version`, but no `version` script existed.
  It failed with `ERR_PNPM_NO_SCRIPT`, so the "Version Packages" PR could never be opened. Added
  `version` (`changeset version` → `scripts/sync-version.mjs` → `prettier --write`).
- **The `VERSION` export would have lied about the release (Phase 10).** `VERSION` was hardcoded
  `"0.0.0"` in `src/index.ts`, while `changeset version` bumps only `package.json`. The published
  `0.0.1` would have exported `"0.0.0"`. `scripts/sync-version.mjs` now rewrites the constant from
  `package.json` inside the `version` script, and `test/sanity.test.ts` compares the export against
  `package.json` rather than asserting a hardcoded literal against a hardcoded literal (the old
  test would have stayed green through precisely this drift).
- **`VERSION` had a literal type in the published `.d.ts` (Phase 10).** It declared
  `const VERSION = "0.0.0"`, leaking the current release into consumers' types and turning an
  equality check against any other version into a compile error. Now `VERSION: string`.
- **Docs accuracy (Phase 10).** Found by the conformance gate, which refuted the first cut of the
  new guide:
  - `docs-content/intro.md` described the decoder as liberal outright. It is **strict by default**:
    tolerance is opt-in per flag, and it is `MllpServer` that ships tolerant defaults (`allowFsOnly`,
    `allowLfAfterFs`, `allowLeadingWhitespace`; `allowMissingLeadingVt` stays off even there).
  - `MLLP_TRAILING_BYTES` is **not** benign junk between frames. It fires on a `VT` appearing
    *mid-payload* (which **discards the accumulated partial payload**, i.e. a **truncated**
    message) and on a stray byte after `FS` under `allowFsOnly`. Now documented as something to
    alert on rather than ignore.
  - **`close()` does not drain in-flight messages**: it *rejects* them with
    `MllpConnectionError({ phase: 'close' })`. No drain hook is wired to the `DRAINING` state, so
    `drainTimeoutMs` does not currently bound an in-flight ACK wait on the client. A message in
    flight at shutdown is an **unknown**, not a failure: the receiver may have committed it. Now
    stated honestly in the reliability guide and the limitations page, with the "await your sends,
    then close" pattern.
  - The absolute PHI claim ("never echoes message content") is now precise: diagnostics never echo a
    *run* of content, but the single-byte `snippet` on `MLLP_MISSING_LEADING_VT` is by definition the
    first byte of unframed content.

- **`buildRawAck` could emit an ACK whose MSH-2 collided with its MSH-1 (MLLP-ACK-UTF8).** When an
  inbound declared no usable MSH-2, the builder fell back to the HL7 default encoding characters
  `^~\&` **without checking them against MSH-1**. For an inbound declaring MSH-1 = `^` (or `~`, `\`,
  `&`), the fallback's first character *is* the field separator, so the emitted ACK read back with an
  **empty MSH-2** and every later MSH field shifted by one (§2.5.4, §2.16: the delimiters must be
  distinct). Fixed: `buildRawAck` substitutes only the one colliding **encoding character** and keeps
  the inbound's **field separator** unchanged.
  - Keeping the field separator is the load-bearing part. The field separator is the only byte that
    can truncate MSA-2, and MSH-10 provably cannot contain it (MSH-10 is a product of splitting the
    inbound MSH *on* it). An interim fix instead switched the ACK's field separator to `|`, and
    since a `|` inside an `^`-delimited message's MSH-10 is *ordinary data* (§2.5.4), an MSH-10 of
    `ID|X` went out as `MSA|AA|ID|X`, which a receiver reads back as **`ID`**: silently **truncated**.
    Truncated is worse than empty: `ID` is *plausible*, so it can match a **different** in-flight
    send and falsely settle it, losing one clinical message (its `send()` resolves though it was
    never acknowledged) and duplicating another (the one actually acknowledged stays in flight and
    resends). Substituting the encoding character avoids all of this: the ACK stays under the
    inbound's own delimiters, so the echo round-trips byte-for-byte whatever the control ID contains.
  - It deliberately does **not** fall through to the minimal ACK, which would drop the MSA-2 echo: an
    ACK that is well-formed but uncorrelatable is worse than one that correlates with an imperfect
    header. The control-ID echo is the thing being protected.

### Added

- **Trademark notice (`TRADEMARKS.md`).** This package names third-party systems to describe what it
  interoperates with; the notice records that cosyte is not affiliated with, endorsed by, or
  sponsored by any of them, that every reference is descriptive, and that the built-in profiles are
  authored from public sources only. Added to `files` so it ships inside the published tarball, not
  just on GitHub. Documentation only: no runtime or API change.


- **`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` (MLLP-ACK-UTF8).** A new stable warning code,
  `ack-from-hl7`-scoped, emitted in `MllpAck.warnings`, not through the framing registry (13 codes
  total now). `buildMllpAck` **verifies** every ACK it builds against the very byte-level scanners the
  `@cosyte/mllp` client uses to correlate, and warns when MSA-2 is not byte-identical to the inbound
  MSH-10 (HL7 v2.5.1 §2.9.2.2). The warning reports the two byte **lengths** and withholds the
  field values. MSH-10 is inbound payload content and a warning goes to a log. The ACK is still
  emitted. A
  mismatched ACK beats silence. But the mismatch can no longer pass unremarked, because a
  non-verbatim MSA-2 *is* an ACK the sender cannot match. It fires for an `encoding` override that
  cannot round-trip the inbound bytes, and for an inbound declaring non-default delimiters or a
  whitespace-padded control ID, cases `@cosyte/hl7`'s builder structurally cannot represent (it
  always emits `|^~\&`, and trims field whitespace). `buildRawAck` is parser-free and has neither
  limit, so it remains the answer for a non-default-delimiter peer.

  **The check is a `Buffer` guarantee, and the docs now say so.** On a `string`/`Hl7Message` inbound
  the wire bytes are decoded before `buildMllpAck` ever sees them, so it re-encodes the caller's text
  with the same codec it decoded it with: the codec cancels on both sides and a codec-induced
  mismatch is **structurally invisible**. `buildAckAA(payload.toString("latin1"))` on a high-bit
  control ID emits `0xC2 0x8B` (a different control ID) and warns about nothing. That double-encode
  is pre-existing (byte-identical on the previous release line) and is tracked separately; the guard
  cannot be grown to catch it, because by then the bytes are gone. What was *new* and is now fixed is
  the **claim** that it could not happen: `docs-content/acks.md`, `docs-content/limitations.md`, and
  the `BuildMllpAckOptions.encoding` JSDoc each asserted the echo was "never silently wrong". They now
  scope the guarantee to `Buffer` inbound and name `Buffer` as the byte-safe path, and a test pins the
  limitation so the claim cannot silently re-broaden.
- **`ConnectionErrorCause` gains `'framing-fatal'` (Phase 10).** Public union. Attached to the
  `'error'` event when the decoder throws; classified **permanent** by `isTransientConnectionError`,
  so a client never auto-reconnects into a peer that is not speaking MLLP.
- **Release readiness for `0.0.1` (Phase 10).**
  - **Publish pipeline proven without burning a version.** New `publish:dry` script
    (`pnpm publish --dry-run --no-git-checks`). Verified end to end: the `prepublishOnly` chain
    (clean → typecheck → lint → test → build → `attw`) is green; `changeset version` consumes the
    pending changesets to exactly **`0.0.1`**; the dry-run packs 24 files (`dist/` + README +
    LICENSE + CHANGELOG) with public access and no `src/`, `test/`, or `vendor/` leakage;
    `pack:docs` produces both docs artifacts. **Nothing was published**. The first real publish
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
    accumulated payload bytes into `snippet` (the too-large frame is a full HL7 message), now empty (the
    anomaly is the frame's *size*, not a byte). (2) The encoder's `MLLP_PAYLOAD_CONTAINS_VT`/`_FS` (strict,
    reachable from `client.send()`) copied up to 64 payload bytes around the offending delimiter, now
    just the single offending delimiter byte (a VT/FS control byte the `code` already names). Every
    framing throw now carries at most the single framing-boundary byte that broke the structure, never a
    payload run; the `snippet` PHI contract is documented on the field. No public-API change.
  - **Differential harness** (`test/differential/`): byte-parity with the Google Cloud Healthcare MLLP
    adapter and Mirth/NextGen Connect (both R1). Tier 1 (always on) asserts decode + `encodeFrame`
    byte-parity against canonical R1 golden frames and ACK correlation; Tier 2 (`MLLP_DIFF_ADAPTER`
    opt-in) checks a live adapter and skips cleanly when unset, so `verify` stays green.
  - **Quirk corpus** (`test/conformance/`): a realistic multi-segment HL7 message driven through each
    §3 real-world deviation, asserting the exact warning code/typed error and byte-identical payload
    recovery; the lenient decoder never throws except the sanctioned `MLLP_FRAME_TOO_LARGE`.
  - **PHI-safety property suite**: generative proof (mutation-checked) that no framing diagnostic ever
    echoes payload content, including the oversized path.
  - **Test-infra:** the pre-existing `test/server/*` suites now use the shared
    `test/helpers/tracked-servers.ts` (`must()` + `makeServerTracker()`) instead of copy-pasted helpers.
  - **Scope note:** the remaining Phase 9 roadmap acceptance items, (c) keepalive / half-open
    detection and (d) fuzz chunk-boundary adversaries, were already delivered in earlier phases
    (`socket.setKeepAlive` in `src/server/server.ts`; the byte-at-a-time `randomChunks` /
    `split(1)` generators in `test/property/fuzz.property.test.ts`), so Phase 9 legitimately
    narrows to the PHI snippet audit + differential harness + quirk corpus.
- **TLS / MLLPS hardening (Phase 8).** `TlsTransport` (wraps `tls.TLSSocket`, maps `onConnect` to
  `'secureConnect'`) joins `NetTransport` as a first-class `Transport`. Client: `ClientOptions.tls?:
  TlsOptions | true`: verification **on by default**; the only opt-out is the loud
  `allowUnverified` flag, which emits a frozen `'securityWarning'` (`MLLP_TLS_VERIFY_DISABLED`) +
  `process.emitWarning` on every `secureConnect` (initial connect and every reconnect). Server:
  `ServerOptions.tls?: ServerTlsOptions` with `clientAuth: 'NONE' | 'WANT' | 'MUST'` (ATNA ITI-19
  mutual node authentication): `'WANT'`/`'MUST'` surface a minimal, content-free `peerCertificate`
  (`{ subjectCN, issuerCN, validTo, authorized }`) on the `'connection'` event; `authorized`
  reports whether the chain was verified against `ca` (under `'WANT'` a certificate can be present
  yet unverified, never authorize on `subjectCN` alone); `'MUST'` additionally rejects
  unauthorized/missing client certificates. Failed handshakes (incl. rejected mTLS client certs)
  never crash the server: a frozen `'tlsClientError'` event (`{ remoteAddress, remotePort, message,
  code, timestamp }`) is emitted and the server keeps accepting other connections. Both `minVersion`
  default to `'TLSv1.2'`: the IHE ATNA ITI-19 "TLS 1.2 Floor" (BCP195) floor (ITI TF-2 §3.19.6.2.3);
  `'TLSv1.0'/'TLSv1.1'` are not expressible through this API. No bundled cipher list: `ciphers`
  passes through to Node's OpenSSL defaults, which already include both ATNA-mandated ECDHE suites.
  New typed failure modes on `MllpConnectionError.connectionCause`: `'tls-verify'` (certificate
  verification failure) and `'tls-handshake'` (TLS-**protocol**-shaped pre-`secureConnect` failures
  only: `ERR_SSL_*`, `EPROTO`, OpenSSL alert-bearing errors; pure TCP failures like `ECONNREFUSED`
  carry no `connectionCause`, same as plaintext). Both classes are **permanent** for the reconnect
  classifier (never auto-reconnect-looped into a misconfigured or MITM'd endpoint) while plain
  network blips stay transient. TLS 1.3 honesty note (RFC 8446 §4.4.2): `connect()` resolving does
  NOT guarantee a `clientAuth: 'MUST'` server accepted the client certificate. A rejection
  surfaces moments later as a typed post-connect error classified permanent; ACK correlation
  remains the delivery guarantee. New exported helpers `isTlsVerificationErrorCode(code)` and
  `isTlsProtocolError(err)`. New stats fields: `ClientStats.tls`, `ServerStats.tls`,
  `ServerStats.tlsClientErrorsTotal`. New root exports: `TlsTransport`, `TlsOptions`,
  `ServerTlsOptions`, `ClientAuth`, `SecurityWarning`, `MLLP_TLS_VERIFY_DISABLED`,
  `MLLP_BIND_ALL_INTERFACES`, `isTlsVerificationErrorCode`, `isTlsProtocolError`. See
  `docs-content/tls.md` for the full guide (mTLS table, TLS-1.3 client-cert-rejection note,
  known limitations).
- **`@cosyte/mllp/ack-from-hl7`: real helpers (Phase 7); stub removed.** A thin transport
  adapter over `@cosyte/hl7`'s `buildAck` (hl7 owns ACK content + the HL7 control tables;
  this package frames and correlates, O-1 boundary). New surface: `buildMllpAck(inbound,
  { code, error?, encoding?, allowDelimiterBytesInPayload? })` returning a frozen `MllpAck`
  (`frame` ready-to-write MLLP bytes, unframed `payload`, the built `ack` message,
  `requestedCode` vs emitted `code`, verbatim `correlationId`, detected `mode`, content-free
  `warnings`); the six Table-0008 conveniences `buildAckAA/AE/AR/CA/CE/CR`; `detectMode`
  (original-vs-enhanced from MSH-15/16); lazy peer loading with a typed
  `MllpPeerMissingError` (`MLLP_PEER_MISSING`) when `@cosyte/hl7` is absent; and the
  `loadHl7Peer` seam. Fail-safe by construction: a fatally-unparseable inbound never yields
  a positive ACK (`AA`→`AE`, `CA`→`CE` via the peer's `downgradePositiveAck`, no divergent
  copy of the pair), MSA-2 stays empty, and the result carries the new stable warning code
  **`MLLP_ACK_INBOUND_UNPARSEABLE`** (public API; 12 codes total). A parseable inbound with
  no MSH-10 rides the peer's own downgrade + `ACK_NO_CORRELATION_ID`. MSA-2 echoes the
  inbound MSH-10 whole: delimiter-bearing vendor-quirk ids (`ID^X`) byte-exact, matching
  this package's own raw-bytes client correlator (escape-bearing ids canonicalize; see the
  docs' known limitations).
- **Dev/test consumption of the unpublished `@cosyte/hl7` peer** via a vendored packed
  tarball (`vendor/cosyte-hl7-0.0.0.tgz`, devDependency) so the accuracy suite runs against
  the real peer in CI, an interim mechanism until the cross-repo consumption decision
  lands; the runtime peer stays optional and is never bundled (`external` in tsup).

### Security

- **Dev-dependency advisory remediation (no runtime impact: `@cosyte/mllp`
  ships zero runtime dependencies, so the published artifact is unchanged).**
  Added scoped `pnpm.overrides` pinning two transitive **dev/build-time**
  packages to their patched releases: `esbuild` (`>=0.27.3 <0.28.1` →
  `0.28.1`; GHSA dev-server path-traversal, not reachable here: the library
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

- **MLLP client + server**: production-grade client and server with framing
  (`VT + payload + FS + CR`), ACK correlation, auto-reconnect with backoff, and backpressure.
  Buffer-first API on every public surface.
- **Explicit 6-state connection machine**: `CONNECTING | CONNECTED | DRAINING | RECONNECTING |
  DISCONNECTED | CLOSED`, with `stateChange` events carrying `{ from, to, reason }`.
- **Framing**: `FrameReader` with a bounded 16 MB default accumulator (`MLLP_FRAME_TOO_LARGE` on
  overflow); strict encoder, lenient decoder (Postel's Law).
- **11 stable warning codes** with byte-offset context (`MLLP_MISSING_LEADING_VT`,
  `MLLP_FS_WITHOUT_CR`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, …).
- **TLS** support; `AbortSignal` on every awaitable and `Symbol.asyncDispose` on every closeable.
- **In-memory transport** (`@cosyte/mllp/testing`): a deterministic, socket-free test double.
- **`ack-from-hl7` subpath**: placeholder for building ACKs from parsed messages via the optional
  `@cosyte/hl7` peer (helpers not yet implemented; Phase 6).
- **Property + fuzz test layer** for the framing transport, built on the shared
  `@cosyte/test-utils` conformance kit and `fast-check` (both dev-only). Covers: codec round-trip
  byte fidelity (`encode → decode`) via `roundTripProperty`; lenient-decoder robustness
  (malformed-but-recoverable frames recover into warnings, only `MLLP_FRAME_TOO_LARGE` throws) via
  `lenientNeverThrowsProperty`; frozen-event-payload immutability via `immutabilityProperty`; a
  warning-code surface snapshot tripwire via `sortedCodeSet`; and a transport-robustness **fuzz**
  property feeding arbitrary random byte buffers and chunk-splits through `FrameReader` over the
  in-memory transport. Test-only: no public-surface change.

- **Fail-safe ACK semantics & the commit contract (Phase 6, HL7 v2.5.1 §2.9.2).** A positive
  acknowledgement (`AA`) can never precede a successful durable commit: with `autoAck: 'AA'` + an
  `onMessage` handler the server **awaits the handler (the commit step) then ACKs**: `AA` on resolve,
  a **negative** code on throw/reject (`AE` by default; `AR` via `MllpAckError`), never `AA` before
  commit. `autoAck: 'AA'` without a handler is a documented **transport-accept** (received+framed, not
  application-processed). New public surface: `buildRawAck` (parser-free byte-level ACK builder echoing
  inbound `MSH-10` into `MSA-2`, never throwing on malformed input), the HL7 Table 0008 `AckCode` /
  `NegativeAckCode` unions, `MllpAckError`, `resolveNackCode`, and a PHI-safe `'nack'` event
  (`{ connectionId, ackCode }`) with its `NackEvent` type. No payload content or thrown error text ever
  reaches the wire, logs, or events, only routing/control metadata and the static ack code.
- **Package metadata**: added `homepage` and `bugs` fields to `package.json` for npm completeness.

### Changed

- **Server bind-safety hardening (Phase 8; BREAKING pre-publish, free before first release).**
  `MllpServer.listen()` / `createStarterServer` default bind host changed `'0.0.0.0'` →
  `'127.0.0.1'`. Binding a wildcard host now requires `ServerOptions.allowWildcardBind: true`,
  **enforced against the OS-normalized bound address**, not the requested spelling. Literal
  wildcard spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`, `'0:0:0:0:0:0:0:0'`,
  `'::ffff:0.0.0.0'`) reject with a typed `MllpConnectionError` **before** binding;
  resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, …) are caught by a post-bind check
  on `server.address()`. The just-bound server closes immediately and `listen()` rejects,
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

- **`mitata` benchmark dependency and the `bench` script**: the script had no benchmark files.

### Deprecated

### Fixed

- **Bind errors no longer crash a server with no `'error'` listener (Phase 8 residuals, MLLP-8.1).**
  The constructor-time `net.Server`/`tls.Server` `'error'` forwarder ran before `listen()`'s own
  rejection handler and re-emitted unconditionally: on a server with no `'error'` listener, a plain
  bind error (`EADDRINUSE`, `EACCES`, …) crashed the process (unlistened `EventEmitter` `'error'`
  emissions throw) instead of rejecting the `listen()` promise. The forwarder is now guarded by
  **server state**, and the error contract is documented: with a listener attached, always
  forwarded; with none, a bind-window error rejects the `listen()` promise (the **primary** error
  surface, caveat: an `'error'` listener that synchronously calls `close()` during the bind window
  changes the rejection to the typed close-during-listen error), a stale error after `close()` is
  dropped, and a runtime error **while serving** (e.g. accept-loop `EMFILE`) deliberately keeps
  Node's fail-loud crash-on-unlistened-`'error'` convention. A silent accept outage is impossible.
  A throwing `'listening'`/`'securityWarning'` subscriber can no longer strand the `listen()`
  promise and wedge the single-flight guard: each emit is contained separately (a throw in one
  subscriber cannot suppress a later emission, in particular the `MLLP_BIND_ALL_INTERFACES`
  security warning always survives, with the operator-channel `process.emitWarning` fired first so
  no event listener can ever suppress it), the throw is surfaced via the guarded `'error'` tap
  (itself contained against a double throw), and `listen()` still resolves. Also consolidates `listen()`'s five hand-woven settle paths (abort,
  close-during-listen, no-address reject, post-bind wildcard reject, bind error) into one idempotent
  first-caller-wins settle helper (no path can leak a listener, strand the single-flight guard, or
  re-settle a settled promise) and documents three subtleties: the post-bind wildcard reject window
  is accept-safe (the check runs synchronously on `'listening'`, before any connection can be
  delivered); `close({ signal })` with an **already-aborted** signal is a no-op `AbortError`
  rejection that does **not** settle an in-flight `listen()` (which continues and settles on its own
  bind outcome); and once the bind has succeeded, an abort of the listen signal fired from inside a
  `'listening'`/`'securityWarning'` handler is deliberately **too late**: the bind wins and
  `listen()` resolves (use `close()` to shut down), so aborted-mid-emit can never strand
  `listening: true` on a closed socket.

### Security

[Unreleased]: https://github.com/cosyte/mllp/commits/main
