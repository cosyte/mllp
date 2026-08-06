# @cosyte/mllp: agent notes

The narrative half of this repo's `CLAUDE.md`, relocated here on 2026-08-04 under the
`CLAUDE-MD-AUDIT` item so that `CLAUDE.md` stays a cursor plus rules plus traps and this file
carries the reasoning. **Nothing was deleted.** Every section below is the text that used to sit
in `CLAUDE.md`, **verbatim**, under a heading `CLAUDE.md` now links to. Each section is still a
bullet because that is how it was written; the leading `- ` is part of the original text.

Read this when a one-line rule in `CLAUDE.md` is not enough, when you are about to change the
thing a rule guards, or when you are tempted to relax one. Every paragraph here cost a defect.
**Add to it, never trim it.**

## Shipped phases and the vendored hl7 peer tarball

- **Phase 9 of 11**: client/server/framing/connection/transport shipped; Phase 6 (fail-safe ACK
  commit contract), Phase 7 (`ack-from-hl7`: real helpers over `@cosyte/hl7`'s `buildAck`, stub
  removed), Phase 8 (TLS/MLLPS hardening: `TlsTransport`, mutual TLS via `ClientAuth`, the
  `'securityWarning'`/`'tlsClientError'` events, bind-safety default `127.0.0.1` + gated wildcard
  bind), and Phase 9 (real-world interop: differential harness vs the Google Cloud MLLP adapter +
  Mirth/NextGen (`test/differential/`, `MLLP_DIFF_ADAPTER`-gated live tier), the §3 quirk corpus
  (`test/conformance/`), and a PHI/observability audit that closed the `MLLP_FRAME_TOO_LARGE`
  `snippet` payload-slice leak) done. Next: see `operations/roadmaps/mllp.md` for what follows Phase 9.
  For dev/test the
  `@cosyte/hl7` peer is consumed as a **vendored packed
  tarball** (`vendor/cosyte-hl7-0.0.0.tgz`, a devDependency): an interim mechanism until the
  cross-repo consumption decision (umbrella `PW-5` gate) lands; refresh it by re-running
  `pnpm -C ../hl7 build && pnpm -C ../hl7 pack --out ../mllp/vendor/cosyte-hl7-0.0.0.tgz`
  (`--out` resolves relative to the `-C` directory) then `pnpm remove @cosyte/hl7 &&
  pnpm add -D @cosyte/hl7@file:vendor/cosyte-hl7-0.0.0.tgz`. Note `pnpm remove` also
  strips the `peerDependencies` entry; restore it (`"@cosyte/hl7": ">=0.0.0"`) after.

## The em-dash brand gate

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

## The PHI scanner enumeration and its refusals

- **The PHI scanner's enumeration is narrowed, and the refusal is not softened.** `all` mode lists
  `test/` + `src/`, then reads; a file removed inside that window used to refuse the whole sweep.
  **Exactly one case is tolerated** now: a file the walk enumerated **itself**, that **git does not
  track**, failing with **`ENOENT`**, reported on stderr as skipped, never silent. Still refusing: a
  tracked file that cannot be read, any non-`ENOENT` failure, a tolerated file back on disk at
  sweep end, a `git` that cannot report the tracked set, and an **empty** tracked set. `all` mode
  also refuses when it observed **no** files. **▶ NEVER soften the refuse-a-scan-that-observed-
  nothing rule** and never widen the tolerance; narrow the enumeration instead. **This repo is the
  one that could actually reach it**, because `test/scripts/phi-scan.test.ts` `mkdtemp`s capture
  directories inside `test/`, a walk root, twice per suite run. Those tests must keep writing
  there, the `test/` prefix IS what they prove. A repo-root `tsup`
  transient is out of scope only because neither walk root is the repo root, so **widening a walk
  root reintroduces this verbatim**. **The test technique is the reusable part:** the scanner runs
  `git` between the walk and the first read, so a `git` shim first on `PATH` is a deterministic
  hook into exactly that gap, with **no sleep and no real build** (five of the eight tests use it).
  Contract and residuals are in `phi-scan-overrides.md`: a path-keyed re-check misses a mid-sweep
  rename; the **back-on-disk re-check is unpinned** (stubbing it leaves the suite green, and pinning
  it needs the load-sensitive sleep this defect argues against); and
  `walk()`'s own `existsSync`->`readdirSync` race exits **1**, the code reserved for "hits found".

## PHI-SCAN-SYMLINK-BLIND-ON-BOTH-ROUTES

- **A non-regular entry under a scan root refuses the scan, on BOTH routes, and follows nothing.** A
  symbolic link read CLEAN on both: `walk()` enumerates `Dirent.isFile()`, an **lstat** answer, so a
  link is neither a file nor a directory (and `isDirectory()` is lstat too, so a **linked directory**
  took its whole subtree with it), while `--staged` read `git show :<path>`, which for mode `120000`
  hands back the **target path text**, never the target's bytes. Measured on `d854e81`: both exited
  0 "OK, no hits" over a name-bearing payload that exited 1 when named explicitly. Following a link
  was refused as the remedy (bytes the enumeration does not control, and git carries none of them);
  the enumeration is narrowed instead, and every offender is named. **A refusal never reports the
  link target** (working-tree text that can itself carry PHI). **▶ NEVER WRITE "NEITHER ROUTE FOLLOWS
  A LINK" FLAT: `walk()` opens the ROOTS with `existsSync` + `readdirSync`, which both follow**, so
  replacing `test/` or `src/` itself with a link is read straight through. Pre-existing and
  link-NEUTRAL: the tree beyond it is scanned exactly as the root it replaced would have been, with
  that root's own limits (so a payload behind a linked `test/` is reported, exit 1, while the same
  payload behind a linked `src/` gets only the conservative pass). Disclosed, not closed, and never
  restate it as a promise that a linked root is always caught. The
  scope test matches the roots' own NAMES as well as the prefix, because an entry named exactly
  `test` or `src` replaces a root instead of sitting in one. **That last sentence was only half
  true until `PHI-SCAN-RENAME-BLIND-AT-PRECOMMIT`: the REFUSAL matched the root's name and the
  READ set did not**, so a mode-`100644` blob staged at exactly `test` was scanned by nothing and
  `--staged` exited 0 over live `PID-5`/`PID-7`/`PID-3`. Both read predicates now admit the root's
  own path, and **admitting it is only half the remedy**: `looksLikeHl7` decides what scan a
  target earns, and a path named `test` matches no fixture-like extension, so a draft read the
  blob and still reported clean. An entry that REPLACES a root is judged with THAT ROOT'S OWN
  LIMITS: `test` earns the structured scan, `src` keeps the conservative pass. **▶ `--diff-filter`
  MUST KEEP `T`:**
  replacing a **tracked** file with a link is neither add nor modify, so `AM` deleted the record
  before any mode was read and the hook passed mode `120000` green (measured on git 2.39.5: `AM`
  yields an empty raw stage). **"In scope" is each route's own ROOT** (`test/`, `src/`); the
  `.ts`/`.md` **name** exemptions deliberately do NOT carry over to a non-regular entry, because they
  are judgements about bytes. Disclosed, not fixed: explicit-path mode still reads **through** a
  link. (`R`/`C` rename/copy were disclosed here too, and are **CLOSED** by the bullet below.)
  Mode `160000` gitlinks were **already** refused here (`git show` fails `bad object`); only the
  diagnostic changed. **Do not "resync" this to a sibling parser's scope** and do not soften it.

## PHI-SCAN-WALK-ROOT-SCOPE and PHI-SCAN-OBSERVED-NOTHING-IS-GLOBAL

- **A `.ts` source under `test/` reached NEITHER route, and this repo is the extreme case of it.**
  The walk covered all of `test/`, then the read filter dropped every `.ts` under it. Measured on
  `3daf2e9`: `test/` tracked **72 `.ts`, 3 `.frame.bin`, 1 `.md`**, so the exclusion removed **72 of
  76** tracked files and the gate stood on **three framed binaries**; **12** of the 72 carried inline
  `PID|` literals. **Do not read the old exclusion as merely conservative.** For a transport package
  whose subject is HL7 v2, a message written into a test source is the ORDINARY fixture shape, and
  the exclusion removed the majority of the corpus rather than a corner of it.

- **▶ THE WIDENING IS TWO-SIDED, AND THE ENUMERATION HALF FINDS NOTHING ON ITS OWN.** Every detector
  in the scanner assumes **the file IS the document**: `findHeaderLine` and `splitSegments` work
  line-by-line and want a segment id at the START of a line. A `.ts` line starts with `const` or with
  a quote, so it matches nothing. **Measured, and this is the number that settles it:** a probe file
  carrying a full `PID` in a string literal exited **0** `OK, no hits` even when **named explicitly
  on argv**, which bypasses the enumeration entirely, while the IDENTICAL payload written to a
  `.hl7` file reported all five fields. The bytes were always detectable; nothing ever looked at them
  as HL7. **Never widen the enumeration here without `extractEmbeddedHl7`, and never delete the
  extractor believing the walk covers it. Removing either half restores the false green.**

- **▶ THE EMBEDDED RECOGNISER ANCHORS ON `|`, AND THAT IS NOT AN ARBITRARY NARROWING.** The
  file-level rule (`SEGMENT_LINE_RE`) accepts ANY non-alphanumeric delimiter, which is right for a
  file that IS a message and catastrophic inside source code: measured, it matched `ack-from-hl7`,
  `not-an-error-object`, `ERR_MODULE_NOT_FOUND` and `net.createConnection`, which would drive the
  unknown-segment NAME backstop over English words. **A gate that reds on prose is a gate someone
  turns off.** **NO MATCH COUNT IS WRITTEN DOWN HERE, DELIBERATELY, AND YOU MUST NOT ADD ONE** (see
  the standing note at the end of this section). Derive the comparison instead, in one command:
  ```sh
  node -e '
  const {readFileSync}=require("fs"), {execFileSync}=require("child_process");
  const files=execFileSync("git",["ls-files","test","src"],{encoding:"utf8"}).split("\n").filter(f=>f.endsWith(".ts"));
  for (const [name,re] of [["pipe anchor  ",/(["\x27`]|\\r|\\n|\n)[ \t]*[A-Za-z][A-Za-z0-9]{2}\|/g],
                           ["any-delimiter",/(["\x27`]|\\r|\\n|\n)[ \t]*[A-Za-z][A-Za-z0-9]{2}[^A-Za-z0-9\s]/g]]) {
    let runs=0, hits=0;
    for (const p of files) { const s=readFileSync(p,"utf8"); re.lastIndex=0; let k=0; while(re.exec(s)!==null)k++; if(k)hits++; runs+=k; }
    console.log(name, runs+" runs /", hits+" files");
  }'
  ```
  Note what it measures: RAW ANCHOR MATCHES, which are an UPPER BOUND on extractor runs and not the
  same quantity, because `extractEmbeddedHl7` advances `lastIndex` past each consumed run. **But the `|` narrows the ANCHOR, it does not make a recovered run trustworthy, and
  the difference matters**: the recogniser cannot tell a comment from a literal, and one comment in
  the tree is already parsed as `MSA-3`. It is harmless only because `MSA` has no field map, and a
  clean `\rZDS|1|<surname>^<given>` in a comment DOES red. **Never write down that the recogniser
  only ever sees real segments.** What saves it from redding on documentation is the unknown-segment
  backstop needing ADJACENT components each holding EXACTLY ONE name token, so an English sentence
  does not trip it. Both halves are pinned by tests.

- **The anchor set is four spellings, and each is one the corpus uses:** an opening quote, an `\r` /
  `\n` ESCAPE, and a REAL NEWLINE. The last was missing at first and the refuter caught it: the
  idiomatic multi-line template
  ```ts
  const inbound = `MSH|^~\&|...
  PID|1||447281^^^HOSP^MR||HALVORSEN^INGRID^M||19620914|F`;
  ```
  recovered only the `MSH` run, and `scanHl7` SKIPS header segments, so a full patient identity on
  the following lines reported **clean, exit 0**. Adding the newline anchor costs nothing measurable:
  over the tracked `.ts` sources the recovered set is IDENTICAL with and without it, so it closes a
  shape rather than widening the net. Re-derive that with the command above rather than trusting a
  number written here.

- **A run ends on the quote that OPENED it, not on any quote.** Ending on any quote truncated a name
  at an apostrophe: `"PID|1||||O'HALLORAN^SIOBHAN||19620914|F"` cut at the apostrophe, leaving PID-5
  component 1 as a single letter, which `nameTokens` drops, and silently discarded the DOB and every
  field after. Both were exit 0 before and are exit 1 now.

- **THE DISCLOSED COST IS THREE THINGS, NOT ONE**, and the first draft named only the first: a
  CUSTOM field separator is not recovered at all; a run anchored on an ESCAPE does not know which
  quote opened the enclosing literal, so it still ends at the first quote of any kind; and a segment
  split across a CONCATENATION (`"PID|1||" + mrn + "^^^HOSP^MR"`) is recovered only as far as the
  first operand. A FILE that is such a message is unaffected in every case. Each needs a real
  TypeScript literal parser, never a wider anchor.

- **The violator exemption is PER-PATH and must stay so.** An extension cannot tell a file that
  carries violator literals ON PURPOSE from one that carries them BY ACCIDENT, which is the whole
  distinction the gate exists to make. `DELIBERATE_VIOLATOR_SOURCES` names
  `test/scripts/phi-scan.test.ts` alone, and the exemption is **total**, not just the structured
  half: that suite also asserts the CONSERVATIVE pass fires, so it holds a non-test-domain email the
  shape pass reports on sight. **Allow-listing that value instead is refused and must stay refused**,
  because an `EMAILDOMAIN` entry is global and would switch the email detector off for the whole
  corpus to green one file. **The residual, stated rather than hidden:** a real SSN or email
  committed into that ONE path is not reported. It is bounded by the list being explicit and short;
  widening the list is what would make it unbounded.

- **Five synthetic tokens became visible for the first time** and are now declared: `SYNTH` (the
  corpus-wide fabrication marker), `ATTEND` (an XCN family-slot ROLE, not a person), and
  `SECRETLAST` / `SECRETFIRST` / `ID 999888777`, which are a deliberate **leak canary**: the property
  test builds them into a `PID` and then asserts the ACK does not echo them. None is new content;
  all were already in the tree, unscanned.

- **▶ A DENOMINATOR DOES NOT DETECT THE OBSERVED-NOTHING HALF.** The refuse-an-empty-sweep guard
  counted every root TOGETHER, so it could only fire when ALL roots came back empty, and one healthy
  root masked an empty one indefinitely. Measured on `3daf2e9`: with `test/` emptied and `src/`
  intact the sweep printed `OK, no hits` and exited **0**, directly under a comment ASSERTING that
  `all` mode "always reaches the committed fixture corpus under `test/`" that nothing checked.
  Printing a count would have looked like the fix and changed nothing, **because a count counts the
  roots that DID exist** (32, a perfectly healthy-looking number). The check is per root now and
  keyed on the roots the walk actually ENTERED, so an **absent** root stays legitimate (a repo need
  not have both) while an **emptied** one refuses with exit 2, naming it. **Consequence for
  fixtures:** a synthetic repo whose `src/` exists but holds nothing scannable is not a shape the
  real repo can be in, so `srcRoot()` plants one benign source; do not "fix" a future red there by
  weakening the guard.

- **An unmerged path was enumerated by nothing, and it is a MINOR.** `U` has no single staged blob,
  so `--diff-filter=AMT` deletes the record: measured, `--staged` exited **0** over a conflicted
  fixture whose BOTH stages carried live-shaped `PID-3` / `PID-5` / `PID-7`. It refuses now, and
  **scanning a stage is refused as the remedy**, because neither side of a conflict is what a commit
  would contain. **Do not inflate this one:** `git commit` refuses an unmerged index BEFORE the
  pre-commit hook runs, so it is not a route by which PHI reaches a commit. What it fixes is the gate
  ANSWERING A QUESTION IT CANNOT ANSWER when `--staged` is run directly mid-conflict.

- **▶ THE SCOPE WAS RE-DERIVED FOR THIS REPO AND A RESIDUAL LIST MUST NEVER BE PORTED IN.** Measured
  here: this repo roots at **`test/` + `src/`** while a sibling roots at `test/fixtures/` + `src/`,
  so the same item has a different shape in each. And the two refusal defects a sibling still
  carries are **NOT open here**: a regular-file root, a dangling link at a root and a missing
  allow-list all already exit **2**, closed by the previous slice. Porting a sibling's exit-1
  residual into this repo would have been wrong. **Exit codes here are 0 clean / 1 hits / 2 refusal,
  and every refusal added by this work exits 2.**

- **▶ STANDING NOTE: THE ANCHOR MATCH COUNT IS DELETED, NOT CORRECTED, AND MUST NOT COME BACK.** It
  was written down as 289, then 297, then 252, then 943-vs-252, and an independent reader could not
  reproduce the last of them: raw anchor matches are an UPPER BOUND on extractor runs, not the same
  quantity, because `extractEmbeddedHl7` advances past each consumed run, and the excluding-exempt
  ceiling for that file set is BELOW the number that was published. Four wrongs is where you stop
  correcting and start deleting. **Keep the derivation command, never the output.** The one figure
  worth quoting from that family is directional and survived independent measurement: the
  any-delimiter anchor lands in a band well above the `|` anchor, which is all the rationale needs.

- **▶ AND NOTE WHICH FIGURES SURVIVED, BECAUSE THE DISTINCTION IS THE LESSON.** These were
  re-derived by a second party and matched every time: `test/` tracks **72 `.ts`, 3 `.frame.bin`, 1
  `.md`**; the old exclusion removed **72 of 76** tracked files; **12** of them carry inline `PID|`.
  A figure that is a COUNT OF TRACKED FILES survives re-derivation because the derivation is
  unambiguous. A figure that is a COUNT OF REGEX MATCHES does not, because the methodology is a free
  variable and every measurer picks a different one. Prefer the first kind; delete the second.

- **▶ THE DEFECT CLASS THAT BIT THIS SLICE TWICE, ONCE INSIDE ITS OWN FIX.** Pass 1's headline
  finding was a STALE SENTENCE SURVIVING UNDER A REWRITTEN ONE: the block above
  `isScannableTestFile` was updated to say `.ts` is included while three lines below it still said
  the filter "must EXCLUDE .ts", in this file's imperative trap voice. The fix for the LATER
  findings then reintroduced exactly that class in this very file: the retraction "never write down
  that the recogniser only ever sees real segments" was added three sentences BELOW a surviving
  sentence asserting "every recovered id is a real HL7 segment id", and both shipped in one bullet.
  **It survived two refutation passes, and the reason is worth knowing: a `grep` for `289 runs`
  cannot see `**289** runs`, because the markdown bold markers sit inside the phrase.** So when you
  retract a claim, DELETE THE SENTENCE, never append a correction after it, and when you grep to
  confirm a figure is gone, grep for the BARE NUMBER, never the number plus its prose.

- **▶ WHAT THIS DELIBERATELY DID NOT DO: `src/` KEEPS THE CONSERVATIVE PASS ONLY.** A draft applied
  the recogniser to every `.ts` and thereby reversed a standing decision through a change whose
  subject is a different root. `src/` is refused the structured scan on purpose, because its JSDoc
  `@example` snippets carry illustrative names and MRNs that are not held to the segment-aware
  detectors, and `src/` **was never this defect**: it was enumerated and read by both routes all
  along. Measured, three `src/` files carry six recoverable runs and all six are clean today, so the
  restriction costs nothing now and is a scope decision rather than a workaround. Widening `src/` is
  its own slice with its own argument. **The residual, disclosed:** an embedded `PID|` in `src/` is
  still seen only by the SSN/email floor.

- **No walk ROOT was widened**, which is what keeps the mid-sweep-deletion bound intact: the roots
  are still `test/` and `src/`, never the repo root. What changed is what `test/` ADMITS. The
  transients that make this repo able to reach the tolerance are `mkdtemp`'d `.txt` captures, so
  their exposure class is unchanged.

## PHI-SCAN-RENAME-BLIND-AT-PRECOMMIT

- **`--staged` enumerates a rename now, and a walk root that is not a directory refuses instead of
  publishing a finding it never made** (`PHI-SCAN-RENAME-BLIND-AT-PRECOMMIT`). `R`/`C` carry two
  paths, so `--diff-filter=AMT` deleted the record outright: `git mv <link>` into a scan root
  staged as **`R100` at mode `120000`** and `--staged` exited **0** over it, and a rename that also
  substituted a real name staged as a SCORED rename and passed the same way. (No score is written
  down: it is a function of how similar the two blobs are, so it belongs to the fixture and not to
  the defect. `R100` above is different, an exact rename always scores 100.) **THE REMEDY IS
  `--no-renames`
  AND IT COSTS NO STRIDE WORK**: the destination arrives as a single-path `A`, the source as a `D`
  the filter drops, the enumeration is a strict SUPERSET of the previous one, and the two-field
  stride becomes STRUCTURAL because git cannot emit an `R` or a `C` with detection off. Verified
  under `diff.renames` = `true`/`copies`/`false`/`1` and `diff.renameLimit=1`, so the caller's own
  config cannot reopen it. **The earlier "admitting them needs the two-path record shape, a scope
  decision" framing was FALSE and was ported in from a sibling; do not restore it.**
  A walk ROOT that resolves to a FILE threw `ENOTDIR` out of `readdirSync` **uncaught**, and an
  uncaught throw exits **1**, the code reserved for "hits found", a false finding, which is worse
  than a crash because it reads as actionable. A **dangling** link at a root was the silent half:
  `existsSync` FOLLOWS, so the walk returned and the sweep reported OK over the whole corpus that
  root stands for, with `observed === 0` unable to fire while the other root had files. Both refuse
  (exit 2) via `walkRoot`, and the refusal never names the link target. **A root that resolves to a
  DIRECTORY is still followed, unchanged and deliberately** (link-neutral, pinned by a test); an
  ABSENT root is still legitimate and still exits 0, which is the control that isolates it from a
  dangling one. **`walk()` no longer lets any `readdir` failure leave the process**: every one
  other than `ENOENT` is an InvocationError, so the exit code says refusal and not finding.

## The package rename and the publish-state claim

- Migrated onto the shared `@cosyte/*` engineering standard (Phase E) and **renamed
  `@cosyte/hl7-mllp` → `@cosyte/mllp`**. The rename was free because it predates the first
  publish. **It is published now, and this file names no version** (derive it: `npm view
  @cosyte/mllp version`). The sentence that stood here read "Not yet published", which had been
  false for as long as the package has been on the registry, and it is the same defect class the
  CHANGELOG preamble carried.
- **Closed 2026-08-06, re-measured rather than recalled.** The umbrella carried a competing report
  that this repo's `CLAUDE.md` still claimed the package was "not yet published to npm". Checked:
  that sentence is in neither `CLAUDE.md` nor any other live text here, and the registry serves this
  package across a run of `0.0.x` versions. The report was stale, and the only surviving hits in
  this repo are archival entries (this one, and the CHANGELOG's) describing the correction rather
  than making the claim. **Publish state and repo visibility are still independent facts, and
  neither is derivable from the other.**

## Changelog generation

**`CHANGELOG.md` is written by the release, and the changeset summary is the entry.** This section
is the reasoning behind the one-line rule in `CLAUDE.md`; the enforcement is
`test/scripts/changelog-generation.test.ts`, which runs the **real** `changeset version` against the
real changelog and the real config in a throwaway package.

**The defect it replaced.** `.changeset/config.json` set `"changelog": false`, which is a legal
value that makes Changesets bump the version and write no changelog at all. So no release ever wrote
a version heading here, and nothing ever rolled `[Unreleased]` over: the whole published history of
this package carried a changelog with **zero version headings**, one `[Unreleased]` heading spanning
everything, and a preamble in the future tense about a release that had already gone out.
`CHANGELOG.md` is in `package.json` `files`, so that text was on the disk of everyone who installed
the package. **The fix was the flag, not the prose.** Correcting the sentence by hand leaves the
mechanism that wrote it and it drifts again on the next release.

**Five mechanism traps, each of which costs a wedged or corrupted release to rediscover.**

- **Exactly ONE line may sit above generated output.** Changesets prepends a release by replacing
  the FIRST newline in the document. The old preamble sat on line 3, so turning the flag on alone
  would have spliced every release between the H1 and the preamble and cut the header in half. The
  hand-written history therefore moved under `## Released before this file was generated`.
- **State the rule as "nothing but the H1 above the first heading", never as "the archive heading
  comes second".** The first real release puts `## <version>` exactly there, so the narrower phrasing
  reds the first Version PR this configuration ever opens, and `prepublishOnly` runs the same suite
  under `changeset publish`: a Version PR merged without a green run fails the publish **after** the
  changeset is consumed on `main`. Assert it on the released document too, not only the committed one.
- **`## 0.0.1` is a PREFIX of `## 0.0.10`, and this package is on that ladder.** Any `indexOf` or
  substring `toContain` over a version heading reports a heading the document does not have. Compare
  whole headings against the heading list. Relatedly, a changeset summary may QUOTE the archive
  heading and the quoted copy lands *above* the real one; anchor on a whole line, which is safe
  because `getReleaseLine` indents every continuation line of a summary by two spaces. **State that
  reason precisely: it is NOT "no line in a release section starts at column 0"**, which is plainly
  false (the version heading, `### Patch Changes` and the entry's own `- ` bullet all do). What holds
  is narrower and is the only thing the anchor needs: no line a SUMMARY contributes, other than its
  first, reaches column 0, and the generator's own lines are headings and bullets that never spell
  the archive heading.
- **🔴 THE RELEASE'S PRETTIER PASS IS OFF, AND THAT IS THIS PACKAGE'S OWN ANSWER, NOT A PORTED ONE.**
  Changesets runs the document it writes through Prettier unless `.changeset/config.json` sets
  `"prettier": false`. **This repo's markdown is deliberately NOT Prettier-managed: `.prettierignore`
  lists `*.md`**, so despite `format:check`'s glob naming root `*.md` it reads **none** of them
  (`npx prettier --file-info CHANGELOG.md` reports `"ignored": true`), and the archived history has
  never been Prettier-canonical. Leaving the pass on therefore does not tidy the file, it **rewrites
  already-published text on every release**: measured on this archive, emphasis markers, list bullets
  and continuation indents all move, and the paragraph whose bold span contains
  `` `test/tls/**` `` comes back with the spaces around that literal **eaten**, which is corruption
  inside a shipped tarball. **Neither obvious remedy is available.** Turning the pass back on is
  refuted by the measurement above. Deleting `*.md` from `.prettierignore` to make the coverage real
  reds `format:check` on the archived history immediately (measured:
  `npx prettier --check CHANGELOG.md --ignore-path /dev/null` warns). **`hl7` does Prettier-manage
  its markdown and needs the OPPOSITE setting, so do not resync this value to a sibling.**
- **🔴 Changesets SWALLOWS a changelog-write failure with `console.warn`.** A tree whose declared
  Prettier config cannot be resolved bumps the version, consumes the changeset, and writes **no
  changelog at all**. Reproduced on this repo's own inputs. **So a release that publishes with an
  unchanged changelog is THAT failure and not a flag that reverted.** Say why, because the bare
  claim is not self-evident and a reverted flag produces the identical symptom: the flag is already
  ruled out by the time you are looking, since the suite reds on `changelog: false` and
  `prepublishOnly` runs that suite under `changeset publish`. So read the run's warnings, not
  `config.json`. `"prettier": false` happens to close that particular route by removing the
  resolution, which is a side benefit and **not** why the setting is there. The test's throwaway
  trees still link this repo's Prettier and `@cosyte/prettier-config` in, because the control that
  runs a release with the pass back ON has to exercise the formatter and config a release would
  really have used, not the copy Changesets bundles as a fallback.

**The entry line is `- <short-sha>: <summary>`, not the summary alone.** The default generator calls
`getCommitThatAddsFile` and prefixes each entry with the sha of the commit that added the changeset,
so "the changeset summary IS the changelog entry" is exactly true of the **text** and one prefix
short of the **line**. That sha ships in the tarball, which is fine here (`CHANGELOG.md` is out of
scope for `check-no-internal-refs`, deliberately). **The consequence for the test is not cosmetic:**
the lookup returns nothing in a tree with no git history, so a throwaway package that was not a git
repo would quietly exercise a line shape no release produces. The harness therefore `git init`s and
commits each temp tree, and pins the line shape, so a generator swap that drops or changes the
prefix is caught here rather than in a published tarball.

**What was dropped from the archived half, and what was not.** Four pieces of hand-workflow
scaffolding: the `[Unreleased]` heading, its link definition at the foot of the file, and the two
empty section stubs (`### Deprecated`, and the final `### Security`). **No entry was reworded or
re-sorted.** The history is not split into version sections because the file never recorded which
release any entry went out in, and because that text is already on disk in published copies. The
repeated `### Added` / `### Fixed` headings in the archived half are a fossil of that: entries were
appended in waves the file never separated.

**Temp trees go in the OS temp directory here.** `test/scripts/phi-scan.test.ts` `mkdtemp`s inside
`test/` because the walk root is exactly what that file proves; the changelog test has nothing to say
to the PHI walk roots, and planting trees under `test/` for it would only widen what the sweep has to
tolerate.

## Test timeouts, measured not read

  **A slow case states its own budget; the suite-wide `testTimeout` is not for widening.** Raising
  the global buys a false green everywhere to spend a false red in one place, so a case that needs
  more than the ceiling says so at its own site, with the reason. **No list of those sites is kept,
  here or anywhere; read them off the tests, and know there are two spellings** (the options object
  `{ timeout: N }` and a **bare trailing number** on `it`, which the `attw` gate uses through a
  named constant, so a `timeout:` search misses it and finds `spawnSync`'s unrelated kill timeout
  instead). Two drafts of this slice kept three such lists between them and every one was wrong.
  Two rules learned by measuring rather than
  reading, and both apply to the next repo that tries this: **a budget equal to the framework
  default is a no-op** (Vitest 4.1.4's own defaults are 5,000 ms per test and 10,000 ms per hook,
  which is what made the old `hookTimeout` line do nothing), and **trim before you bound**. On this
  suite the two dominant costs were a `tsx` start paid per subprocess spawn and `toEqual` walking a
  megabyte of `Buffer` element by element in JS; both were cost, not subject, and removing them beat
  every candidate number. The method, conditions and figures are in `CHANGELOG.md`. **Measure under
  concurrent suites and interleave base with head, or you are timing the box.** Measure under
  `pnpm test:coverage` because **CI runs both `pnpm test` and `pnpm test:coverage`**, not because
  coverage is slower: measured here the two are within noise, since the critical path is
  `attw-gate`'s real `npm pack` subprocesses, which v8 coverage does not instrument. **That last
  point is repo-specific and does not port** to a sibling whose critical path is in-process.

## Stable warning codes, NOT_VERBATIM and UNVERIFIABLE

- **Stable warning codes** are a public API. Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`, `MLLP_ACK_INBOUND_UNPARSEABLE`, `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`, `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` (14 total; the last **three** are `ack-from-hl7`-scoped: emitted in `MllpAck.warnings`, not through the framing registry). `NOT_VERBATIM` is a *proof of mismatch* (a `Buffer` inbound, checked byte-for-byte); `UNVERIFIABLE` is its text-path counterpart: a `string`/`Hl7Message` inbound whose non-ASCII echo *cannot* be verified because the wire bytes were decoded before the adapter saw them (MLLP-ACK-STRING-DOUBLE-ENCODE). The two are deliberately distinct: the text path must never claim a proof it cannot run.

## The MSH is read ONCE (MLLP-ACK-UTF8)

- **The MSH is read ONCE, in one place** (MLLP-ACK-UTF8). `src/internal/control-id.ts` owns `readMshSegment` and the MSH-10 / MSA-2 scanners built on it: `latin1` decode, MSH-1 taken from the MSH segment's 4th byte per §2.5.4 (never assumed to be `|`), the MSH **located** (the first `CR`/`LF`-delimited segment starting with `MSH`, never demanded at byte 0), and the field scan **bounded at that segment's terminator**. Three call sites must agree byte-for-byte on what a control ID *is* (the client's correlator keys its in-flight store on it, `buildRawAck` echoes it into MSA-2, and `buildMllpAck` **verifies** its own output against it) because any disagreement between two of them is an ACK the sender cannot match: timeout → resend → **duplicate clinical message**. All three now call `readMshSegment`; none re-derives the read. They each did once, and each got it wrong differently: `ascii` masking (MLLP-10 / MLLP-CORRELATOR-ASCII), a hardcoded `|` and an unbounded scan (`buildRawAck`), and a `utf8` round-trip (`buildMllpAck`). **Do not re-implement a fourth.** Two rules in it are load-bearing in opposite directions, and the gate caught a violation of each. **Bound the scan at the segment terminator**: the unbounded version returned **PID-3 (the patient's MRN)** as the "control ID" of a truncated MSH, and put it in the correlation key, in the ACK timeout error, and in a warning message. **But locate the MSH; never demand it at byte 0**: an interim fix did, to force the three into agreement, and thereby made `buildRawAck` emit a positive `AA` with an empty MSA-2, *silently*, for a leading-`CR` or `FHS`/`BHS`-batch payload whose MSH-10 was plainly present. That is the duplicate-message failure, manufactured by the fix for it. Tightening a reader to make consumers agree is a trap: **agree at the tolerant fixed point**, because a lenient reader must never drop data that is there (Postel's Law).

## Tolerate terminator noise, never skip DATA (MLLP-ACK-UTF8)

- **Tolerate terminator noise; never skip DATA** (MLLP-ACK-UTF8). `buildMllpAck` strips *leading `CR`/`LF` only* before handing the payload to `parseHL7`. Those bytes carry no data, so dropping them hides nothing. It must **not** re-base on the located `MSH`, because that skips an `FHS`/`BHS` batch envelope (§2.10.3), and a batch is a **sequence** of messages: the builder then parses message 1, silently discards every later `MSH` and the `BTS`/`FTS`, and returns a positive `AA` correlated to message 1 **with zero warnings**, telling the sender the whole batch was accepted while messages 2..N went unread. An `FHS`/`BHS` envelope must keep falling through to the warned, non-positive `AE` fallback. **Batch ACK is its own feature.** Do not arrive at it by accident on the way to fixing something else, and do not "fix" the `AE` into an `AA`.

## A warning message is a log line (PHI-WARNING-MESSAGE-LEAK)

- **A warning message is a log line, so it carries no field content, ever** (MLLP-ACK-UTF8). `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` reports byte *lengths* and withholds MSH-10/MSA-2 themselves. "It's only a control ID, that's routing metadata not clinical content" is exactly the reasoning that put an MRN in a log line. The field a scanner *returns* is not always the field you asked for. Report shape, not content; the caller already holds the bytes.
  **The same answer now binds ACK CORRELATION, and it took a second defect to get there** (`PHI-WARNING-MESSAGE-LEAK`). The `correlateByControlId` path was writing `controlId=${...}` into a warning message and `Unmatched ACK control ID: ${...}` into an `MllpFramingError`, the second built from the **peer's** MSA-2 read off an inbound frame: measured, a 1,000,000-byte MSA-2 produced a 1,000,026-byte `Error.message`. `MllpTimeoutError` carried the ID on a field of its own, on an `Error`, whose `stack` is what an error reporter ships off the box. **The distinguishing property is not the wording, it is whether the factory takes a value parameter at all.** `src/client/ack-diagnostics.ts` is a frozen registry, one literal per code, and `ackDiagnosticMessage(code)` takes only a code; the `Correlator` hands its consumers `controlIdBytes` and never the string, so nothing downstream of it *has* an ID to interpolate. Do not add a value parameter to either. A truncated ID is not a middle ground and neither is a hex rendering: both still grow the diagnostic with the input and both still disclose the bytes.
  **And the test has to reach the client.** `test/property/phi-safety.property.test.ts` was green over this the whole time because it constructs a `FrameReader` and never a client, so the three surfaces `src/internal/control-id.ts` names as where a control ID travels were the three it could not reach. `test/phi/diagnostic-phi-leak.test.ts` binds the shared `assertNoDiagnosticPhiLeak` runner, stands up a real client over `InMemoryTransport.pair()`, and declares a code per slot so a probe that never entered the branch fails instead of passing. **`@cosyte/test-utils` must stay pinned at `^0.0.2` or higher**: a caret on a `0.0.x` version resolves to that version *exactly*, so `^0.0.1` installs a kit with no runner in it and the suite passes for the wrong reason.

## MllpConnectionError.connectionCause

- **`MllpConnectionError.connectionCause`** (public union) gained two Phase 8 values: `'tls-verify'` (certificate-verification failure) and `'tls-handshake'` (TLS-**protocol**-shaped pre-`secureConnect` failures only: `ERR_SSL_*`/`EPROTO`/OpenSSL alert-bearing, per the exported `isTlsProtocolError`; pure TCP failures on a TLS connection carry no `connectionCause`). Both classes are classified **permanent** for the reconnect classifier, never auto-reconnect-looped; plain network blips stay transient. TLS 1.3 caveat (RFC 8446 §4.4.2): `connect()` resolving does not guarantee a `clientAuth: 'MUST'` server accepted the client cert. A rejection surfaces as a typed permanent post-connect error; ACK correlation is the delivery guarantee. Phase 10 added `'framing-fatal'` (a fatal decoder throw, see the receive-path rule below), also **permanent**: a peer that is not speaking MLLP would otherwise be reconnected into forever. Existing values: `'fifo-unsafe'`, `'in-flight-orphan'`.

## No uncontained emit (MLLP-10)

- **No `emit()` reachable from a callback we do not own may go uncontained, in ANY class** (MLLP-10). `EventEmitter.emit()` calls listeners **synchronously**, so a throwing subscriber unwinds the whole stack it was invoked from. When that stack bottoms out in a socket's `'data'`/`'error'`/`'secureConnect'` listener, a `net.Server`'s `'connection'` listener, a `tls.Server`'s `'tlsClientError'` listener, or the `catch` of a `void`-ed async task, the throw becomes an **uncaught exception / unhandled rejection that kills the process**, every other connection and every in-flight durable commit with it. A consumer's broken metrics tap must not be able to take down an MLLP interface. The helpers are `src/internal/safe-emit.ts` (`safeEmit` / `safeEmitError`), used by `Connection._dispatchContained`, `MllpServer._emitContained`, and `MllpClient._emitContained`; **every `this.emit(` in `src/` is inside a containment wrapper** (`Connection._dispatchContained`/`_emitErrorIfListened`, `MllpServer`/`MllpClient._emitContained`, `safeEmit`/`safeEmitError`, or an inline `try`/`catch`), with exactly one disclosed exception, the deliberate fail-loud accept-loop forwarder described at the end of this note. The gate refuted this fix **four times**, each round on a route the previous scope had missed: the decoder throw; the unlistened `'error'` emit raising `ERR_UNHANDLED_ERROR` *from inside the catch block that was the fix*; the `'message'`/`'warning'` subscribers; the five lifecycle emits reached via `destroy()` → `_transition()`; and finally the whole of `MllpServer`/`MllpClient`, because the rule had been scoped to `Connection` when **the hazard belongs to the call stack, not to a class**. Two corollaries are load-bearing beyond crash-safety: a throwing `'nack'` subscriber used to **suppress the fail-safe negative ACK** (it sat in the `catch` before `_dispatchAck`), and a throwing `'message'` subscriber used to **break ACK correlation** on the client (it ran before `_onAckPayload`, so `send()` hung forever). The structural tests in `test/connection/receive-containment.test.ts` and `test/server/framing-error-containment.test.ts` attach a throwing subscriber to **every event of all three classes at once**. A new event emitted uncontained fails them. **One deliberate exception survives:** `MllpServer`'s `net.Server` error forwarder still re-emits *unguarded* when there is **no** `'error'` listener **and** the server is serving, keeping Node's fail-loud convention for accept-loop errors (`EMFILE`/`ENFILE`). A silent accept outage on a healthcare listener must be impossible.
- **`MllpConnectionError.connectionCause`** gains `'framing-fatal'` (MLLP-10): a fatal decoder throw. Classified **permanent** by `isTransientConnectionError` (which now treats every `MLLP_*` code as permanent), so a client never auto-reconnects into a peer that is not speaking MLLP: an HTTP probe or a wrong-port misconfiguration used to produce an unbounded reconnect storm, because the classifier's `default:` branch returned *transient* and `createStarterClient` defaults `autoReconnect: true`.

## Server bind-safety

- **Server bind-safety (Phase 8, BREAKING pre-publish).** `MllpServer.listen()` / `createStarterServer` default host is `'127.0.0.1'` (was `'0.0.0.0'`). Binding a wildcard host requires `ServerOptions.allowWildcardBind: true`, **enforced against the OS-normalized bound address**: literal spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`, `'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`) reject pre-bind; resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, …) are caught post-bind via `server.address()` (the just-bound server closes and `listen()` rejects; no listening state, no `'listening'` event). `listen()` is **single-flight**: concurrent calls (or a call while already listening) reject with a typed error instead of racing the post-bind checks; `close()` before re-listening.

## The attw wrapper, and why the bare CLI is not a gate

- **▶ `attw` SAYS "does not contain types" AND EXITS 0, SO THE `attw` SCRIPT IS A WRAPPER, NOT THE
  BARE CLI.** `getExitCode.js` in `@arethetypeswrong/cli@0.18.4` opens with `if (!analysis.types)
  return 0`, so the problem list is never consulted and no `--profile`, `--ignore-rules` or config
  setting reaches that early return. For a package that ships types it means the declarations were
  **not in the tarball**, which is a broken publish reported as a pass. **Measured on this package at
  `0.0.6`, with ZERO concurrency**, under the old `attw --pack . --profile node16`: `rm -rf dist &&
  pnpm attw` printed the sentence and exited **0**. **The race only supplies the condition**, so the
  answer is **not** a lock, a lease or a build queue: the gate must be able to say its own inputs were
  missing, whatever removed them.
  **▶ THE EXIT-0 PATH NEEDS THE TARBALL TO CARRY NO DECLARATION AT ALL, AND THAT BOUNDARY IS SPECIFIC
  TO THIS PACKAGE. NEVER RESTATE IT AS "MISSING DECLARATIONS EXIT 0".** `tsup` emits a shared type
  chunk (`dist/index-<hash>.d.ts`) beside the three entry declarations. Measured: deleting only the
  six entry `.d.ts`/`.d.cts` files leaves that chunk in the tarball, `analysis.types` is truthy, the
  problem list IS consulted, and attw reds honestly (`❌ No types`, UntypedResolution, **exit 1**);
  the same removal **plus** `dist/index-*.d.*ts` is what prints the sentence and exits **0**. A draft
  of this entry claimed the six-file removal exited 0 and was wrong. The die message therefore refuses
  to promise which way attw would have gone, and `test/scripts/attw-gate.test.ts` reds if the promise
  is restored. The build window lands squarely in the exit-0 state anyway, because `tsup` writes JS in
  one pass and **every** declaration in a later one, so no moment exists where only some are present:
  polling two real clean builds here for `dist/index.mjs` and then the **first declaration of any
  kind** gave windows of **4.25s and 3.31s**, holding JS and zero declarations throughout. **Do not
  write a single figure down as the window** (the absolute timings move run to run and with load); the
  stable and sufficient claim is that the gap is **seconds, not milliseconds**, which is wide enough
  for a concurrent build or `pnpm clean` to land `attw` in it.
  `scripts/attw.mjs` carries **two nets that catch different things**: a preflight that every relative
  path `package.json` promises (`main`, `module`, `types`, `typings`, every string leaf of `exports`)
  exists and is non-empty, which catches the build window and **names the missing file**; and a
  post-check on the untyped sentence, which catches what the preflight structurally cannot, namely
  declarations present on disk but excluded from the tarball by `files`/`.npmignore`. **No instance of
  that second case is on record here.** **This package has three subpaths, so the preflight has twelve
  artifact paths to check**, and `test/scripts/attw-gate.test.ts` pins that it reaches a subpath's
  `require` branch and not just the root. **The one disclosed hole in net 1:** `tsup` emits a shared
  type chunk (`dist/index-<hash>.d.ts`) that `package.json` names nowhere, so the preflight cannot see
  it go missing; that is left to net 2 and to `attw` itself rather than papered over with a glob.
  **The post-check reads a string, so what would hide that string is refused**, by option name and
  wholesale rather than by value. **Three routes were re-measured here**, on this package's own
  untyped pack and under its own `--profile node16`, each handing back exit 0 with the sentence
  unreadable: `--quiet`, `--format json`, and a `.attw.json` setting either (`readConfig()` applies it
  after argv). `--config-path` is refused too, but **by inference, not measurement**.
  **`--profile node16` is deliberate here and is forwarded, not dropped** (this repo does not support
  the node10 resolution); a fixture that is red under the default profile and green under `node16`
  pins that through the wrapper, so dropping the flag reds the suite. `scripts/verify.sh` in the
  meta-repo needs no change and must not be touched for this. The test file also pins **the upstream
  exit-0 itself**, so an `attw` upgrade that reworks the wording or fixes the exit code reds the suite
  instead of letting the net go quietly slack, plus a **negative control** on a well-formed package
  and that a **real `attw` failure still fails**: a gate that only ever fails is not a gate, and one
  that swallows the status is not one either.

## No internal bookkeeping on a public surface, and the WORD-N trap

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
