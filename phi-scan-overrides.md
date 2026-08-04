# phi-scan bypass log

This file logs every `--allow-fixture <path>` bypass invocation of
`scripts/phi-scan.ts`. The scanner refuses to honor a `--allow-fixture <path>`
flag UNLESS this file contains an entry referencing the same path. The committed
log is intentionally annoying. It discourages bypass and creates an audit
trail. Prefer extending `scripts/phi-allow-list.txt` (a token-level, reviewed
declaration) over a whole-file bypass.

## How the scanner detects PHI

mllp is a TRANSPORT / framing library: it wraps HL7 v2 messages in MLLP frames
(`VT 0x0B + payload + FS 0x1C + CR 0x0D`). Its data fixtures are MLLP-framed HL7
v2 messages (`test/**/*.frame.bin`), so the PHI shapes inside them are IDENTICAL
to `@cosyte/hl7`'s. `scripts/phi-scan.ts` is therefore a direct port of hl7's
segment/field-position-aware detector, with **one transport-layer addition**: it
**unwraps the MLLP frame** (strips the leading `VT` start-block(s) and the
trailing `FS CR` end-block) BEFORE the HL7-aware scan (`unwrapMllpFrame`). A
framed fixture's HL7 payload then gets exactly the scan an un-framed `.hl7` file
would; the framing bytes cannot defeat delimiter/segment detection.

The unwrap only ever REMOVES framing bytes, never gates the scan on their
presence, so malformed frames cannot bypass detection:

- **Missing end-block** (`VT + payload`, no `FS CR`): the `VT` is stripped and
  the payload is still scanned.
- **Double-framing** (two leading `VT`s, or a trailing `FS CR FS CR`): all
  leading `VT`s are stripped and the outer `FS CR` removed; any residual
  mid-payload `FS`/`VT` byte clings to at most one field of one segment (segments
  are split on `CR`/`LF`), while every other field is still scanned.

After the unwrap, the scanner reads the message delimiters from `MSH-1` / `MSH-2`
(defaulting to `|^~\&` for a header-less message), splits segments → fields →
repetitions → components, and inspects only the fields that actually carry each
PHI category. A naive `Family^Given` text regex is deliberately NOT used. It
trips on coded values like `CBC^Complete Blood Count^LN` or `Boston^MA`, which
would be false confidence, not safety.

Two properties keep the structured scan from being silently bypassed (both were
caught by the conformance-refuter on the hl7 pilot and inherited here): a
**header-less** fixture (first segment not `MSH`) still gets the full structured
scan: any fixture-like file with a recognizable segment line is parsed, not just
one whose first byte is `MSH`; and segment ids are matched **case-insensitively**
(`pid` is normalized to `PID`), because the lenient parser accepts lowercase
segment ids and the scanner must not go blind where the parser stays tolerant.

Scope: `all`-mode sweeps EVERY data file under `test/` EXCEPT `.ts` sources (and
`.md` docs), plus all of `src/`. Test `.ts` SOURCES are deliberately excluded:
they carry intentional violator literals for the positive tests, so sweeping them
would be self-defeating (the hl7 pilot excludes test `.ts` for the same reason).
Every other `test/` file is dispatched by `looksLikeHl7`: a file that contains a
recognizable HL7 segment line after MLLP unwrap, whether a `.frame.bin` frame, a `.hl7`
file, OR a `.txt` / `.json` / extensionless live-adapter capture (the differential
README tells developers to drop real captures under
`test/differential/fixtures/`), gets the full STRUCTURED scan; a genuinely
non-HL7 binary blob falls through to the conservative dashed-SSN + email pass: no
crash, no binary-noise false positive. `src/` gets the conservative pass only.
It is hand-written code, and its `@example` HL7 snippets must not be parsed as
HL7. A real SSN/email committed in `src/` code is still caught there. This
extension-agnostic `test/` rule is deliberate: an earlier version restricted the
sweep to a `.bin` / `.hl7` allow-list, which silently dropped `.txt` /
extensionless captures from ALL scanning: the exact false negative this gate
exists to stop (caught by the conformance-refuter).

| Category                     | Where it looks                                                                                                                                                                                                   | Rule                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patient / person names       | PID-5/-6/-9, NK1-2/-30, GT1-3, IN1-16, MRG-7, STF-3 (XPN comp1-3); PV1-7/-8/-9/-17/-52, PD1-4, ORC-10/-11/-12/-19, OBR-10/-16/-28/-32..35, OBX-16/-25, DG1-16, PR1-11, AIP-3, TXA-9/-10/-11, ROL-4 (XCN comp2-4) | each significant name token must be in the `NAME` allow-list (case-insensitive). Single Latin initials are skipped; single CJK ideographs are kept (Chinese/Korean surnames are one character); HL7 degree/suffix codes (MD, JR, …) are ignored. |
| Date of birth                | PID-7, NK1-16                                                                                                                                                                                                    | the normalized `YYYYMMDD` / `YYYYMM` / `YYYY` (DTM precision) must be in the `DOB` allow-list. A DOB is indistinguishable from a real one by shape, so the allow-list is the only sound gate.                                                     |
| SSN                          | PID-19 (ST 9-digit); PID-3/-18 CX with identifier-type `SS`/`SSN`; dashed `\d{3}-\d{2}-\d{4}` anywhere                                                                                                           | a 9-digit SSN-shaped value must be in the `ID` allow-list; a dashed SSN anywhere is always a hit.                                                                                                                                                |
| MRN / account                | PID-3, PID-18 (CX comp1)                                                                                                                                                                                         | a bare 6-9 digit identifier is a real-looking MRN/account (or a misfiled SSN) and must be in the `ID` allow-list. Synthetic fixtures use prefixed shapes (`MRN…`, `ACCT…`, `FAKE…`) or the reserved `900000000` range, which pass once listed.    |
| Address                      | PID-11, NK1-4, GT1-5, IN1-19 (XAD comp1)                                                                                                                                                                         | a `<number> <word>` street line must be in the `ADDR` allow-list.                                                                                                                                                                                |
| Phone                        | PID-13/-14, NK1-5/-6/-7, GT1-6/-7 (XTN)                                                                                                                                                                          | a ≥10-digit number lacking the `555` fake-exchange convention is a hit.                                                                                                                                                                          |
| Email                        | anywhere (post-unwrap)                                                                                                                                                                                           | an email whose domain is not an `EMAILDOMAIN` (reserved/test) domain is a hit.                                                                                                                                                                   |
| Site-defined (`Z…`) segments | every field                                                                                                                                                                                                      | backstop: an adjacent pair of single-token name-shaped components (`Johnson^Maya`) whose tokens are not allow-listed. Runs ONLY on segments outside the known-segment set, so coded triples in `OBX`/`OBR` are not misread as names.             |

## Documented limitations (inherited from the hl7 pilot)

- **Free-text names.** OBX-5 / NTE narrative is scanned for identifier _shapes_
  (dashed SSN, email) but NOT for free-text personal names. A name in prose is
  not reliably separable from clinical vocabulary without NLP. Structured name
  fields (the table above) are the hard gate.
- **MRN heuristic is shape-based.** A synthetic MRN that is a bare 6-9 digit
  number is flagged until allow-listed, intentional (bare numerics are the
  real-MRN shape). A real but _alphanumeric_ MRN (e.g. `H0034521`) is not
  distinguishable from a synthetic prefixed id and is not flagged. The name /
  DOB / SSN gates are the backstop for a real message committed by mistake.
- **Phone `555` accept rule.** A ≥10-digit number containing `555` anywhere is
  treated as the fictional-exchange convention and accepted. A real DID
  containing `555` would pass; the synthetic corpus uses `555` numbers.
- **Name-component positions.** The name detectors read the standard XPN
  (family=comp1) / XCN (family=comp2) component positions across the field map
  above. A name in a non-standard slot, or in a name-bearing field not in the
  map, can be missed.
- **Common-name masking (residual, inherent).** The `NAME` allow-list contains
  common real surnames/givens the synthetic corpus uses (SMITH, JONES, DOE,
  JOHN, JANE, …). A real patient whose name is entirely common allow-listed
  tokens is invisible to the name detector: a structural consequence of a token
  allow-list. The DOB / SSN / MRN / address gates remain the backstop.
- **Un-framed vs framed parity.** The scanner treats a framed `.frame.bin` and a
  bare `.hl7` file identically after `unwrapMllpFrame`, and any `test/` data file
  (whatever its extension, `.ts` excepted) containing a recognizable HL7 segment
  line earns that same structured scan, so a real capture saved as `.txt` /
  `.json` / extensionless is scanned, not silently skipped. Only a `test/` file
  with no HL7 segment line at all (a genuinely non-HL7 blob) is limited to the
  conservative dashed-SSN + email pass.

## What a file that goes away mid-sweep may do

`all` mode lists `test/` + `src/`, then reads each file. Anything created and
removed inside that window makes a read throw `ENOENT`. The refusal was never
wrong; the enumeration was, so the fix is scoped to the enumeration rather than
to what a failed read means.

**Exactly one case is tolerated:** a file the walk enumerated **itself**, that
**git does not track**, failing with **`ENOENT`**. It is reported on stderr as
skipped, naming the path, and is never silent.

**Everything else still refuses (exit 2):** a tracked file that cannot be read,
any non-`ENOENT` failure (`EACCES`, `EISDIR`, …), a tolerated file that is back
on disk when the sweep ends, a `git` that cannot report the tracked set, and an
**empty** tracked set (a removed `.git/index` makes `git ls-files` exit 0 with no
output, which would make every file untracked and quietly delete the tracked-file
bound; a corrupt one exits 128 and was always caught). `all` mode additionally
refuses when it observed **no** files, so the tolerance can never decay into a
clean report of nothing. **Do not soften that rule.** `--staged` reads blobs out
of the index (`git show :path`) and never depends on any of this; a path named on
the CLI is read as named and is never tolerated.

This repo reaches the window through its **own suite**, which is what separates
it from the sibling parsers: `test/scripts/phi-scan.test.ts` `mkdtemp`s capture
directories inside `test/`, a walk root, and removes them again (measured: two
directories, about 510 ms each per suite run). They are not moved elsewhere
because what they exist to prove is that a capture whose repo-relative path
starts with `test/` earns the structured scan, so the path **is** the fixture.
A repo-root build transient (`tsup.config.bundled_<hash>.mjs`) is not enumerated
here only because neither walk root is the repo root. **Widening a walk root
removes that accident**, and the file is gitignored in none of the parsers.

Three residuals, stated rather than hidden:

- **The back-on-disk re-check is unpinned**, and that is deliberate. Stubbing it out leaves the
  whole suite green. Reaching it needs a timed re-create against a deliberately slowed sweep, and a
  load-sensitive sleep guarding a load-dependent race is the failure mode this defect teaches. It
  has been driven by hand and behaves as described; losing it would lose the re-check, never the
  tolerance's bounds.
- **The post-sweep re-check is keyed on the enumerated PATH, not on content.** An
  untracked file renamed inside the window is `ENOENT` at the old path and was
  never enumerated under the new one, so its bytes go unscanned under a clean
  report. Bounded: the file must be untracked, and committing it means `git add`,
  after which it is tracked and untolerable. Closing it needs a content-addressed
  sweep, a different design, not a wider bound.
- **`walk()`'s own `existsSync` -> `readdirSync` race, one phase earlier.** A
  directory removed inside that window throws a plain `SystemError` that `main()`
  does not convert, so Node exits **1**, the code the contract reserves for "hits
  found". It matters more here than in the siblings, because this repo's
  transient is a **directory**, removed wholesale. Untouched by this gate and
  unpinned: nothing runs before the walk, so there is no deterministic hook.

## What a non-regular entry under a scan root may do

**Nothing. It refuses the scan (exit 2), on both routes.** It is never silently
skipped, because both enumerating routes were blind to it in a way that read as
clean. Measured on `d854e81` with a synthetic name-bearing payload kept outside
both walk roots:

- the walk enumerates `Dirent.isFile()`, an **lstat** answer, so a symbolic link
  is neither a file nor a directory and fell out of the loop whatever it pointed
  at. `isDirectory()` is an lstat answer too, so a **linked directory** took its
  whole subtree with it. A link to the payload under `test/` gave exit 0, "OK, no
  hits"; a link to its directory did the same.
- `--staged` read content with `git show :<path>`, and git stores a symbolic link
  as its **target path** under mode `120000`, so that route was handed the path
  text and never the target's bytes. Exit 0 after `git add`. That route is this
  repo's pre-commit gate.

Naming the target explicitly exited 1 with every hit throughout. The payload was
always detectable; the two routes never looked at it.

**Neither route follows a link it finds INSIDE a scan root.** Following would read
bytes the enumeration does not control (outside the repo, a loop, a device, a
FIFO that blocks the gate forever), and git does not carry those bytes anyway, so
a hit on them would be a claim about something no commit contains. Refusing
states the only true thing available: there is an entry here the scan cannot
account for, so the scan is not clean.

**The root itself is the exception, and the flat sentence "neither route follows
a link" was false.** `walk()` opens `test/` and `src/` with `existsSync` +
`readdirSync`, and both follow, so replacing a walk root with a link to a
directory outside the repo makes the walk read straight through it.
Pre-existing, and the precise reading is **not** "its PHI is reported": the tree
beyond the link is scanned exactly as the root it replaced would have been, **with
that root's own limits**. A fixture-like payload behind a linked `test/` is
reported (measured, exit 1); the same payload behind a linked `src/` gets only the
conservative pass and can read clean, exactly as it would through a real `src/`.
It is link-**neutral**, which is why it is disclosed rather than closed: refusing
a linked root is a decision about repo layout, not this defect.

**That sentence is now bounded on one side, and the bound is narrow: it holds for
a root that resolves to a DIRECTORY.** A root that resolves to anything else, or
to nothing, refuses (see the next section). Nothing about the linked-directory
case changed, and it is pinned by a test so that changing it stays a decision
rather than a side effect.

**"In scope" is each route's own existing root, not a new boundary.** The walk
still exempts a gitignored entry (the same rule that already exempts a gitignored
file), and `--staged` still only looks under `test/` and `src/`. What does **not**
carry over to a non-regular entry is the `.ts` / `.md` **name** exemptions: those
are judgements about a file whose bytes the route could have read, and a link's
name is no evidence at all about the other side. Dropping them also keeps the two
routes agreeing on what they refuse.

**A refusal names the entry's own repo-relative path and an engine-owned token
for its kind, never the link target.** The target is text off the working tree
and can itself carry PHI: a target path of the shape
`../captures/<surname>-<given>-<dob>.hl7` is the whole reason. The shape is
written out rather than an example, because a diagnostic about a PHI leak is
itself a PHI surface, and that applies to the prose explaining it too.

`--staged` reads `git diff --cached --raw -z --diff-filter=AMT`. **`T`
(typechange) is load-bearing:** replacing a **tracked** regular file with a link
is neither an add nor a modify, so under the old `AM` filter the record died
before any mode could be read and the hook passed a mode-`120000` blob green
(measured on git 2.39.5: with `AM` the raw output for that stage is empty).
Admitting `T` also scans the reverse typechange, a link replaced by a real file
that bears PHI.

Residuals here, stated rather than hidden. **No count is written down**, because a list with a tally
on the front gets read as complete, and the tally that used to sit here was read that way and was
wrong:

- **A non-regular entry that goes away mid-sweep still REFUSES**, unlike a regular file. The
  vanished-transient tolerance above is scoped to the READ, and a non-regular entry is refused on the
  strength of what `readdir` reported, without a re-check. (The one exception is the `DT_UNKNOWN`
  branch in the next bullet, which resolves with an `lstat` and skips an entry that has gone.) The asymmetry is deliberate in direction (fail-closed is the correct
  way for a PHI gate to be wrong) and is not reachable in this repo: nothing here creates a
  non-regular entry under `test/` or `src/`, and the tests that create them confine every one to a
  throwaway repo under `tmpdir()`. **Do not close it by widening the tolerance** (the standing rule
  is to narrow the enumeration, never to soften the refusal).
- **A `Dirent` whose every predicate is false is resolved with one `lstat`, and that branch is
  unpinned.** `readdir` may return no type for an entry (`DT_UNKNOWN`, which some filesystems do),
  which leaves `isFile()`, `isDirectory()` and the whole closed set all false. That is an **absent
  answer**, not evidence of a non-regular entry, and refusing on it would red every sweep on such a
  filesystem: a gate that refuses with no fix available is a gate someone turns off. It is not
  reachable on the filesystem this repo is developed and tested on, so nothing pins it. If that
  `lstat` finds the entry gone, the entry is skipped, which narrows the **enumeration** one phase
  earlier and does not soften what a failed **read** means.
- **Explicit-path mode still reads THROUGH a link**, because `statSync` follows
  it. Unchanged and deliberate: that mode reads exactly what the caller named, and
  a caller naming a path is not the enumeration reporting clean over one.

The gitlink (mode `160000`) arm is **not** a hole this closes, and saying so
would be false here: `--staged`'s scope already reaches a staged submodule under
**both** roots, and `git show :<path>` on one fails with `bad object`, so the base
commit already refused it. What changed is the diagnostic, from an incidental read
failure to a named kind. The `.gitignore` note about orphan agent-worktree
gitlinks is why the arm is worth keeping legible.

## What a rename, a root-replacing blob, and a non-directory root may do

**Nothing any more, and all three used to exit 0 or publish a finding they had
not made.** All three were found by the gate on the slice above, all three were
live on `2252d33`, and the first two sit on `--staged`, which is this repo's
**pre-commit** gate.

**A staged RENAME or COPY was not enumerated at all.** `R` and `C` are the only
statuses carrying a second path, and `--diff-filter=AMT` deletes such a record
outright, so:

- `git mv <link> test/<name>` staged as `:120000 120000 <sha> <sha> R100` and
  `--staged` printed `OK, no hits`, with a mode-`120000` entry sitting under a
  scan root;
- a rename that also substituted a real name staged as a scored rename and passed the same
  way, over live `PID-5` / `PID-7` / `PID-3` values in the destination blob.

**The remedy is `--no-renames`, and it needs no two-path record shape and no
scope decision.** With detection off the destination arrives as an ordinary
single-path `A` (`:000000 120000 0000000 <sha> A`) and the source as a `D` the
filter already drops. The enumeration is a strict **superset** of the previous
one, and that is pinned on the RECORDS and not just on an exit code: a stage with
no rename in it hands the scanner byte-identical raw output either way, and a
stage with one gains exactly the record that used to vanish. It
also makes the two-field stride **structural** rather than conditional, because
with detection off git cannot emit an `R` or a `C` at all. Verified here under
`diff.renames` set to `true`, `copies`, `false` and `1`, and under
`diff.renameLimit=1`: the caller's own configuration cannot reopen it.

**A REGULAR blob staged at exactly `test` or `src` was read by nothing.** The
root's own name was already matched for the refusal, but the read filter wanted
the `test/` prefix, so a mode-`100644` blob at exactly `test` was in scope for one
and out of scope for the other and `--staged` exited 0 over the same three fields.
Both read predicates now admit the root's own path. **Admitting it to the read set
is only half the remedy**: `looksLikeHl7` decides what scan a target earns, and a
path named `test` matches none of the fixture-like extensions, so a first draft
read the blob and still reported clean over a `PID`. An entry that **replaces** a
root is judged with **that root's own limits**, so `test` earns the structured
HL7 scan and `src` keeps the conservative dashed-SSN + email pass, exactly as a
file inside either root would. The `src` half is a disclosed limit of that root,
unchanged here and pinned in both directions.

**A walk ROOT that is not a directory refuses (exit 2), and both halves of that
were failures of a different kind.** A root that resolves to a **file** (a
regular file at `test`, or a link to one) threw `ENOTDIR` out of `readdirSync`
**uncaught**, and an uncaught throw exits **1**, the code this contract reserves
for "hits found": a false finding, which is worse than a crash because it looks
actionable. A **dangling** link at a root was the silent half: `existsSync`
follows, so the walk returned and the sweep reported `OK` over the entire corpus
that root stands for, with the `observed === 0` backstop unable to see it while
the other root still had files.

Reading whatever sits there instead was refused as the remedy, and the reason is
the asymmetry with `--staged`: what is missing in the working tree is a **tree**,
and one file read in its place is evidence about that file rather than about the
corpus it replaced. The index has no directories in it to lose, so the staged
route reads such a blob instead. An **absent** root is still legitimate and still
exits 0 (a repo need not have both), which is the control that isolates dangling
from absent.

**Every offender is named in one refusal, roots and entries together.** A first
version threw on the first bad root, which named `test` and left `src` for a
second run, and left the links under a healthy `test/` unreported as well. That
is the rule this file already states for non-regular entries, and the reason is
the same: a developer who has to re-run the gate once per offender learns to
distrust it.

**The gitignore exemption stops at the root, and that is deliberate.** A
gitignored entry INSIDE a root is exempt, because saying a file is not
commit-eligible content is a statement about that file. A root is refused before
`git check-ignore` is consulted at all, because no such statement can be made
about a whole corpus that is missing.

**No failure of this scan may exit 1, because 1 means "hits found".** The
non-directory root was one route into that; the same gate found two more, both
`PRE-EXISTING` and both closed here: a **missing** allow-list threw past every
`catch` in `main`, and an **unreadable** allow-list or override log threw a raw
`EACCES`. Both exited 1. Nothing ever passed the gate that way, since non-zero
still blocks the commit, but a gate that names a finding it has not made is worse
than one that crashes, because it reads as actionable. Each site is fixed, and a
process-level guard now turns anything still unaccounted for into exit 2, which
is the honest answer: the scan did not finish, so it proves nothing.

## Format

Each entry is a markdown subsection:

```
### <path>

- **Date:** <YYYY-MM-DD>
- **Reason:** <one-line justification>
- **Approved by:** <committer name>
- **Expires:** <YYYY-MM-DD or "permanent">
```

## Entries

(none yet)
