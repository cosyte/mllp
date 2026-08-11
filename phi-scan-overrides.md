# phi-scan bypass log

This file logs every `--allow-fixture <path>` bypass invocation of
`scripts/phi-scan.ts`. The scanner refuses to honor a `--allow-fixture <path>`
flag UNLESS this file contains an entry referencing the same path.

**A LOGGED BYPASS IS NOW RECORDED AND THEN REFUSED, NOT HONORED, AND THAT
CHANGES WHAT THIS FILE IS FOR.** The scanner REFUSES (exit 2) over a target it
enumerated and never read, so `--allow-fixture` cannot reach exit 0 in any mode.
An entry here still gets a flag PAST the rejection gate above (an unlogged flag
is refused with a different message, before anything is read), and the run is
then refused for incompleteness instead. **A scan that did not open a file has
no clean verdict to give about it.** So this log is an audit trail of attempts,
never a mechanism for reaching a clean run.

**`scripts/phi-allow-list.txt` IS THE ONLY MECHANISM THAT REACHES A CLEAN RUN.**
It is a token-level, reviewed declaration that a fixture's identifiers are fake,
and it is what the scanner's own hit footer now points at. Do not restore a
footer, a doc line or a habit that offers the whole-file bypass as the remedy:
following it walks a developer out of exit 1 and into exit 2, which is the same
defect as following one into a false green, with the sign flipped.

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

Scope: `all`-mode sweeps EVERY file under `test/` except `.md` docs, plus all of
`src/`. **Test `.ts` SOURCES ARE SCANNED.** They were excluded until
`PHI-SCAN-WALK-ROOT-SCOPE`, which measured what that cost here: `test/` tracks 72
`.ts`, 3 `.frame.bin` and 1 `.md`, so the exclusion removed 72 of 76 tracked files
from BOTH routes and 12 of the 72 carried inline `PID|` literals. A `.ts` source
is dispatched to `extractEmbeddedHl7` rather than to the file-is-the-document
scan, because its HL7 lives inside string literals that every line-oriented
detector misses; the enumeration and the recogniser are two halves of one remedy
and neither works alone. The one deliberate-violator corpus
(`test/scripts/phi-scan.test.ts`, whose positive tests need unallowed values) is
exempt BY EXPLICIT PATH and totally, never by extension.
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
  (whatever its extension) containing a recognizable HL7 segment
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
carry over to a non-regular entry is the `.md` **name** exemption or the per-path
violator exemption: those
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

**A bad root and an unscannable entry under the other root come out in one
refusal.** A first version threw on the first bad root, which named `test`, left
`src` for a second run, and left the links under a healthy `test/` unreported as
well. A root whose `stat` itself fails is still reported alone.

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
than one that crashes, because it reads as actionable. All three exit 2 now.
The missing-allow-list route is answered where it arises; the two unreadable ones
reach the process-level guard, which turns anything still unaccounted for into
exit 2. That is the honest answer: the scan did not finish, so it proves
nothing.

## What a test source, an emptied root, and an unmerged path may do

Three more ways a sweep reported clean over content it never opened, all measured
on `3daf2e9` before anything was touched.

**A `.ts` source under `test/` reached neither route, and the enumeration was
only half of it.** The read filter dropped every `.ts` under the walked root, and
the measured cost here is 72 of 76 tracked files. But every detector in this
scanner assumes THE FILE IS THE DOCUMENT and works from a segment id at the START
of a line, so widening the enumeration alone would have bought the conservative
SSN/email floor and nothing else: a probe carrying a full `PID` in a string
literal exited 0 `OK, no hits` even when NAMED EXPLICITLY on argv, which bypasses
the enumeration entirely, while the identical payload written to a `.hl7` file
reported `PID-3` / `PID-5` / `PID-7` / `PID-11`. `extractEmbeddedHl7` recovers
segments out of string literals, resolving TypeScript escapes so a doubled
backslash in a header yields the real encoding characters, terminating a run at an
`\r` / `\n` escape (which is the HL7 segment separator), and replacing a template
placeholder with a non-letter, non-digit token rather than guessing at a runtime
value. **The `|` anchor is load-bearing and is not an arbitrary narrowing:**
accepting any delimiter, which is correct for a file that IS a message, matched
prose and identifiers (`ack-from-hl7`, `ERR_MODULE_NOT_FOUND`,
`net.createConnection`), which would have driven the unknown-segment name backstop
over English words. **No match count is recorded here, deliberately: that figure
was wrong four times and is not reproducible by an independent reader, because raw
anchor matches are an upper bound on extractor runs rather than the same
quantity.** The derivation command lives in `documentation/agent-notes.md`; run it
rather than trusting a number. On today's corpus every recovered id is a real
segment id, **which is an observation about the tree and not a property of the
rule**: the recogniser cannot tell a comment from a
literal, and a clean `\rZDS|1|<surname>^<given>` written in a comment does red.
What keeps it off ordinary documentation is that the unknown-segment backstop
needs adjacent components each holding exactly one name token, so a sentence does
not trip it.

The anchor is four spellings: an opening quote, an `\r` or `\n` escape, and a real
newline. The last covers the idiomatic multi-line template literal, where the
segments sit on their own source lines; without it only the header run was
recovered and `scanHl7` skips header segments, so a full patient identity on the
following lines reported clean. It costs nothing measurable, the recovered set
over the tracked sources being identical with and without it. A run ends on the quote that OPENED it rather
than on any quote, because ending on any quote truncated a name at an apostrophe
and silently dropped every field after it.

**Disclosed cost, and it is three things rather than one:** a message written with
a CUSTOM field separator is not recovered at all and gets the conservative pass
only; a run anchored on an ESCAPE does not know which quote opened the enclosing
literal, so it still ends at the first quote of any kind; and a segment split
across a CONCATENATION is recovered only as far as the first operand. A FILE that
is such a message is unaffected in every case. **`src/` keeps the
conservative pass only**, on purpose: its `@example` snippets are deliberately not
held to the segment-aware detectors, and `src/` was never this defect.

**The observed-nothing guard counted every root together.** So it could only fire
when ALL roots came back empty, and one healthy root masked an empty one
indefinitely: with `test/` emptied and `src/` intact the sweep printed `OK, no
hits` and exited 0, directly beneath a comment asserting that `all` mode "always
reaches the committed fixture corpus under `test/`". Nothing checked that
assertion. **A denominator is not the remedy and would have looked like one**,
because a count counts the roots that DID exist (32, which reads healthy). The
check is per root now and keyed on the roots the walk actually ENTERED, so an
absent root stays legitimate while an emptied one refuses at exit 2, naming it.

**An unmerged path was enumerated by nothing.** `U` has no stage-0 entry, so
`--diff-filter=AMT` deletes the record: `--staged` exited 0 over a conflicted
fixture whose both stages carried live-shaped `PID-3` / `PID-5` / `PID-7` values.
Scanning a stage is refused as the remedy, because neither side of a conflict is
what a commit would contain, so a hit on one would be a claim about content that
may never exist. **Scoped honestly as minor:** `git commit` refuses an unmerged
index BEFORE the pre-commit hook runs, so this is not a route by which PHI reaches
a commit. What it fixes is the gate answering a question it cannot answer when
`--staged` is run directly mid-conflict.

## What the INDEX corpus reads, and what it still does not

`all` mode reads the bytes git carries at every path in the index, as a **union** with the walk over
`test/` and `src/`. Before this, the walk was the only thing the sweep asked, so every state in
which the working tree stopped standing for the committed corpus reported `OK, no hits` at exit 0.
**Eight were measured on `6eb1615` and all eight are now caught or refused**; the list, the controls,
the mutants that kill each control and the full reasoning live at
`documentation/agent-notes.md#phi-scan-index-corpus-the-bytes-git-carries`.

**The contract, stated once here so a reader does not have to infer it from the code:**

- **A union, never a replacement.** No walk root was narrowed and no clause was dropped. A file the
  walk reads is still read off disk and still earns exactly the tiers it had.
- **The skip is a BYTE comparison** (`Buffer.equals`), never a stat, an mtime or a hash. Those are
  what a decoy defeats. A path whose committed bytes differ from the file on disk is scanned **both**
  ways and reported under two headings, because they are two different findings about one path.
- **Markdown is excluded**, which is `walk()`'s own rule copied rather than invented.
- **Gitignore is NOT consulted** on this route: an entry in the index is commit-eligible content by
  construction, whatever a pattern says about it.
- **A non-regular index entry refuses the whole sweep (exit 2)** and is named by KIND only. For a
  mode-`120000` link git carries the target PATH and for a mode-`160000` gitlink it carries another
  repository's commit id; neither is content. The target is never printed, because a link target is
  working-tree text that can itself carry PHI.
- **An unmerged entry refuses (exit 2).** Neither side of a conflict is what a commit would contain.
  **This now includes an unmerged `*.md`**, because the refusals deliberately run before the name
  filter. Named because it has a local cost: a conflict on `CHANGELOG.md` makes `pnpm phi-scan` exit
  2 until it is resolved. `--staged` (the pre-commit hook) is unaffected, and CI never has an
  unmerged index.
- **An EMPTY index refuses (exit 2)** rather than passing vacuously.
- **`--staged` is unchanged.** It is the pre-commit gate, so what it enumerates decides what a commit
  is BLOCKED on, which makes widening it a hook decision with its own argument. **The red-lock reason
  a sibling records for this class does NOT apply here**: `DELIBERATE_VIOLATOR_SOURCES` is applied in
  `scanTarget`, keyed on path and blind to mode, so this repo's suite is already in `--staged`'s
  scope and already exempt there.
- **The per-root observation rule is unchanged** and remains a statement about the WALK: a root
  emptied on disk still refuses even though the index holds every file under it.

**Residuals, stated rather than hidden:**

- **🛑 READING IS NOT TIERING, AND THIS ROUTE ONLY BUYS THE FIRST.** Every index entry is now READ,
  but WHICH detectors it earns is still `looksLikeHl7`'s decision, untouched here. Outside `test/`
  that gate wants a `.hl7` or `.bin` name, so a tracked capture at `examples/data/capture.txt`, or an
  extensionless one, gets the conservative SSN/email floor and nothing else. **Measured: the same
  bytes carrying PID-3 / PID-5 / PID-7 / PID-11 exit 1 at `capture.hl7` and 0 at `capture.txt`.**
  Pinned as a characterization case so the boundary is visible rather than surprising. **Do not close
  it by giving every index entry the structured scan**: handing `package.json`, `pnpm-lock.yaml` or a
  workflow YAML to `scanHl7` reports identifiers and prose as person names through
  `checkUnknownSegment`'s backstop, and it would silently reverse the standing `src/` decision.
  Enumeration alone buys the floor and nothing more; widening the TIER rule is its own slice.
- **Working-tree bytes at a path OUTSIDE every walk root are read by neither route**, tracked or not.
  A tracked file out there with unstaged edits is judged on its **staged** bytes. Closing it needs a
  third enumeration.
- **Markdown is swept by nothing.** Measured: dropping the `.md` exclusion reds nothing on this
  corpus today, so the exclusion costs no detection at present.
- **EOL normalization would double every count** under `eol=crlf` or `core.autocrlf` (neither is set
  here). **It must NOT be fixed by normalizing before comparing**: that compares a derived form, and
  a decoy differing only in what the normalizer erases would be skipped. Fail-safe, not fail-open.

**This is a DETECTIVE control, not a preventive one.** It runs after the write has landed in the
index. It is not a hook, it does not stop a `git add`, and it must not be described as preventing a
leak.

## What a target enumerated and never read may do

**A target this run ENUMERATED and never READ refuses (exit 2), naming the paths.** Before it, the
withdrawal happened at enumeration time, so a file READ AND FOUND CLEAN and a file NEVER OPENED were
the same state by the time anything counted. `cosyte/config`'s drift check is a CAPABILITY PROBE
that RUNS this scanner rather than reading it, and it measured the consequence on `fd04f57`: the
graded run reported only the hits code, which means **the same argv over a corpus whose ONLY
violator is withdrawn printed `OK, no hits` at exit 0**. Full measurements, both false-green argv
shapes and the mutation control:
`documentation/agent-notes.md#phi-scan-completeness-rule-a-target-enumerated-and-never-read`

**The contract, stated once here:**

- **The comparison is a SET DIFFERENCE, never a size.** A count counts the targets that DID get
  read, so `n read of n targets` hides precisely the paths that did not. The refusal names them.
- **`--allow-fixture` cannot reach exit 0 in ANY mode.** It is recorded here and then refused.
  `scripts/phi-allow-list.txt` is the only remedy that reaches a clean run, and the scanner's hit
  footer says so.
- **A bypass naming a path the run does not ENUMERATE refuses too**, as a separate claim: such a
  flag subtracts nothing, and honoring it silently is how a stale entry in this log drifts unnoticed.
- **The bypass is unioned into the target list unconditionally** in `paths` mode, deduped by
  repo-relative path. The old conditional seed made the flag a **silent no-op** whenever a positional
  path was also given.
- **The one exception is the tolerated-vanish class**, built from targets that ACTUALLY vanished
  (self-enumerated, untracked, `ENOENT`) and only after the came-back re-check, which refuses.
- **Hits are printed first.** The three end-of-run refusals (an emptied walk root, an unenumerated
  bypass, an unread target) fire after the LAST read and are accumulated into one report, so a run
  that is both incomplete and carrying hits prints everything once, at exit 2.

**Residual, stated rather than hidden:** `"in every mode"` describes the RULE, which is not
mode-gated, and **not** a claim that every mode reaches it. The only live way to withdraw a target is
`--allow-fixture`, and a bypass always resolves to `paths` or `--staged`, so `all` mode's `allowed`
set is empty in every argv today. The skip in its read loop is a **guard, not a route**; do not
delete it as dead code, and do not upgrade this paragraph into a claim that an all-mode sweep
exercises the rule.

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
