# `phi-scan` parameters for `@cosyte/mllp`

**Status: DERIVATION ONLY. Nothing here is adopted, and `scripts/phi-scan.ts` is untouched.**
This file is the input to a `cosyte/config` change: it states what this repo's scanner IS, as data,
and what `@cosyte/script-utils/phi-scan` must parameterize before mllp can become a declaration.

Derived from `scripts/phi-scan.ts` at `fd04f57` (2,681 lines, cross-checked `wc -l` and `rg -c`)
against `@cosyte/script-utils@0.0.2` (1,543 lines; the published tarball is byte-identical to
`config/packages/script-utils/phi-scan.js`, verified by `diff`).

---

## 1. The root spelling, which was unclassified

**mllp does not have a root list.** It has TWO module-level absolute-path constants,
`TEST_ROOT` and `SRC_ROOT` (`join(REPO_ROOT, "test" | "src")`), each hand-threaded through a
separate `walkRoot(...)` call. **Two** attachments are measured per root:

| attachment | `test` | `src` | measured at |
|---|---|---|---|
| observed-nothing IDENTITY | tag `"test"` | tag `"src"` | `buildTargetsForAll:1034-1039` stamps `Target.root`; `main`'s `observedByRoot` block refuses on an EMPTIED walked root and leaves an ABSENT one legitimate |
| DETECTOR TIER | structured HL7 scan | cross-cutting floor only | `looksLikeHl7:1750` and `scanTarget:2357` |

🛑 **A READ FILTER IS NOT A THIRD ATTACHMENT ON THE WALK, AND A DRAFT OF THIS FILE SAID IT WAS.**
There are two root-named predicates, `isScannableTestFile` and `isScannableSrcFile`, but on the walk
route `buildTargetsForAll` applies only the first, and it removes nothing: `walk()` already drops
`.md` globally (`:922`, `:959`) and every entry it produced already carries the `test/` prefix.
`srcFiles` is passed through unfiltered. `isScannableSrcFile` is reached only by the staged route
(`:1273`, which is AXIS 3 and counted separately) and by the tier decision (`:2357`, which is row 2
above). So the two predicates differ **only by root prefix**, which means the engine's single global
`isWalkReadable` default expresses mllp's walk read filter exactly, with no loss. Do not build a
per-root read parameter on mllp's account.

A separate hand-written `isUnderScanRoot` carries the union of the two roots, and it is the boundary
the non-regular refusals key on (never a read filter, because a link's name is no evidence about the
other side of it).

So the spelling is: **N named roots, each carrying an identity and a detector tier.** It is not a
rename of `string[]`, and it is not a flatten of `{abs, rel}[]`.

### mllp and `ccda` are NOT the same shape

They were filed together as one unclassified spelling. They are two.

- **`ccda`** had **no root declaration at all**: its walk was called once on `process.cwd()`, so the
  repository root was the root, spelled as an absolute path rather than as a declaration. Arity 1,
  zero attachments. ⚖️ **That half is READ OFF `ccda`'s OWN DERIVATION, not measured here**, because
  one worker per submodule is absolute and this one owns `mllp`. The mllp half below is measured.
  If the two derivations disagree, `ccda`'s wins for `ccda`. `ncpdp` checked both halves of the pair
  independently and reports the same, so the evidence doc's pairing of the two is wrong.
- **`mllp`** is arity 2 with two attachments per root.

What actually unites them is narrower than the pairing claimed: **both express roots as absolute
paths built from `REPO_ROOT` rather than as declarations**, which is why neither carries the
`./`-prefix defect. Both collapse to `readonly string[]`.

Both land on `scanRoots: ["."]` in a 0.0.2-shaped adoption, but for **opposite** reasons: for `ccda`
that is a re-spelling of what it already did, and for `mllp` it is a **widening**, forced by an
engine limit rather than chosen (see §3.2). Treating them as one shape would hide that.

### Scope measurements, anchored to the ref they were taken on

Command, so an independent reader gets the same numbers:
`git ls-tree -r --name-only <ref>` piped through `grep -cE '^(test|src)/'`. Counts cross-checked with
a second tool (`wc -l` against `node`, `grep -c` against `rg -c`), because `grep -c` has returned NO
MATCH in this lineage on a file `rg` read fine.

| ref | tracked | under `test/`+`src/` | outside | outside and `.md` | **outside and NOT `.md`** |
|---|---|---|---|---|---|
| `origin/main` (`fd04f57`) | 158 | 110 | 48 | 17 | **31** |
| this branch HEAD | 159 | 110 | 49 | 18 | **31** |

**31 is the load-bearing figure and 48 is not.** The engine bounds its index union by
`isUnderScanRoot`, so keeping the two narrow roots under 0.0.2 puts 48 tracked paths outside every
route, but 17 of those are `.md`, which no sweeping route reads on either side (`scripts/phi-scan.ts`
`:1646-1648`; the engine's default `isWalkReadable` is `exemptsMarkdown`). The paths that actually
lose coverage number 31, and the figure is stable across both refs because the file this branch adds
is itself `.md`. Two of the 31 are `package.json` and `scripts/phi-scan.ts`, which are the two that
this repo's own `scripts/phi-allow-list.txt` records finding real tokens in when the union half
landed. That is the escape the union was built to close.

---

## 2. The five axes, as data

```yaml
exitCodes: { clean: 0, hits: 1, refuse: 2 }   # AXIS 1. No default exists, deliberately.

roots:                                        # AXIS 2, additive half
  - path: test
    shape: directory
    read:  { excludeExtensions: [".md"], includeRootPathItself: true }
    tier:  fixtures
  - path: src
    shape: directory
    read:  { excludeExtensions: [".md"], includeRootPathItself: true }
    tier:  code

excludedPaths:                                # AXIS 2, subtractive half. LITERAL PATHS ONLY.
  - test/scripts/phi-scan.test.ts             # the scanner's own suite: a deliberate violator corpus

unionScope: repository                        # the index union is NOT bounded by the roots
stagedScope: { roots: [test, src], excludeExtensions: [".md"] }   # AXIS 3
regularBlobModes: ["100644", "100755"]        # AXIS 4. Identical to the engine default; nothing to set.
eolNormalization: none                        # AXIS 5. Dedupe is BY CONTENT; framing fixtures are byte exact.
```

Two axis notes that are decisions, not defaults:

- **`stagedScope` must not widen when the roots widen.** `--staged` decides what a COMMIT is
  BLOCKED on, which is a hook decision this repo has taken separately and declined three times. The
  two keys are independent and nothing relates them.
- **`excludedPaths` is not the same mechanism as the `DELIBERATE_VIOLATOR_SOURCES` it would
  replace, and it differs on BOTH accounting and coverage.** That set is applied at the SCAN
  (`scripts/phi-scan.ts:2341`): the file is still enumerated, still read, and still counted as
  observed, with every detector skipped, **on every route including argv**. The engine consults
  `excludedPaths` on the two sweeping routes and on `--staged`, and **`buildTargetsForPaths` consults
  it nowhere** (`node_modules/@cosyte/script-utils/phi-scan.js:978-985`), after which
  `scanCommonShapes` runs unconditionally at `:1239`.
  **Measured argv delta:** `test/scripts/phi-scan.test.ts` carries an `@realhospital.org` address
  that no `EMAILDOMAIN` line allows. Today
  `npx tsx scripts/phi-scan.ts test/scripts/phi-scan.test.ts` prints `OK, no hits` at **exit 0**
  (run on this tree). Under adoption the same argv reports the hit. Do not ask `config` to "finish
  the job" by making the exclusion total: `ccda`'s derivation records that turning a sweeping-route
  exclusion into a total one is a real hole rather than a tidy-up. What this repo owes is a decision
  about whether that argv should red, not an engine change.

### Both pre-checks, run rather than asserted

1. **No scan root is `./`-prefixed.** The roots are `join(REPO_ROOT, ...)`, so absolute and already
   normalized; the declared spelling is `test` / `src`. Checked the way the failure actually
   presents (a root that walks correctly while matching no index path): the normalized roots match
   110 of 158 index paths, so the union is non-empty and neither index refusal is silently empty.
2. **`isStagedReadable` admits nothing outside `scanRoots`.** The predicate is
   `(p === "test" || p.startsWith("test/") || p === "src" || p.startsWith("src/")) && !p.endsWith(".md")`,
   which is a strict subset of the two roots by construction. Probed over all 158 tracked paths plus
   these 11 adversarial spellings, named rather than counted: `test`, `src`, `testicle/x.ts`,
   `srcs/x.ts`, `docs/test/x.ts`, `test/a.md`, `src/a.md`, `package.json`, `scripts/phi-scan.ts`,
   `documentation/agent-notes.md`, `test/fixtures/link`. 166 distinct paths probed, **zero** admitted
   outside. The mode-120000 escape this check exists to catch is therefore not reachable here through
   configuration. Reproduce by applying the predicate above and
   `["test","src"].some((r) => p === r || p.startsWith(r + "/"))` to
   `git ls-tree -r --name-only origin/main` plus that list.

---

## 3. What the engine must parameterize

Ordered by whether adoption is blocked on it.

### 3.1 BLOCKING: `AllowList` has no address dimension

`scripts/phi-allow-list.txt` documents **five** tags and carries `ADDR` lines. The engine's
`loadAllowList` knows four (`NAME`, `DOB`, `ID`, `EMAILDOMAIN`) and drops an unrecognised tag
**silently** (`default: break`), so every address declaration in this repo vanishes without a word
and the street-address detector reds the committed corpus with nothing able to declare it away.

- **Parameter:** `AllowList.addresses: Set<string>`, filled from `ADDR <value>` lower-cased,
  mirroring the four that exist. Additive, so no default is needed.
- **Pair it with:** a refusal (or at minimum a named report) on an unrecognised tag. The silent drop
  is what makes this invisible, and it will be invisible in the next repo too.
- **Why a caller cannot cover it:** the allow-list file, its path and its parse are engine-owned.
  Re-reading the same file locally to recover one tag is re-growing the machinery this item deletes.

### 3.2 BLOCKING: the index union's scope is not a parameter

The engine bounds the union by `isUnderScanRoot`. mllp's pre-adoption behaviour is a deliberate
combination the engine cannot express: **walk two narrow roots, union over the WHOLE index.**

- **Parameter:** `unionScope?: "scanRoots" | "repository"`, default `"scanRoots"` (today's
  behaviour, so no consumer changes).
- **Why it matters beyond mllp:** without it, every repo whose walk is narrower than its tracked
  corpus must widen its roots to keep the union, which silently drags the TOCTOU surface and the
  per-root reasoning along with it. That is a scope decision being made by a coupling rather than by
  an author.

### 3.3 NOT BLOCKING for mllp: a general root type, offered rather than required

🛑 **A DRAFT OF THIS SECTION WAS LABELLED BLOCKING AND IT IS NOT.** mllp's roots are expressible with
`scanRoots: readonly string[]` exactly as shipped. What forces `["."]` here is §3.2, not the root
type, and the "per-root read filter" argument the draft leaned on was false (see the tripwire in §1).
This section is therefore a **proposal a `config` worker may take or leave**, and it must not be
counted as a thing mllp is waiting on.

⚖️ **NO COUNT OF SPELLINGS IS WRITTEN HERE AND THE REPOS COLUMN IS GONE.** A draft said "seven",
which was inherited from the evidence doc and was already stale: repos have been adopting during
this run, so a repo's spelling now depends on which ref you read. Read each repo's own derivation.
What is offered is a type, with the shapes it must be able to express:

```ts
type ScanRoot =
  | string                                   // sugar for { path }
  | {
      path: string;                          // repo-relative or absolute; normalized as today
      shape?: "directory" | "file" | "auto"; // default "auto": derived by lstat, as today
      exclude?: { extensions?: readonly string[]; paths?: readonly string[] };
      tier?: string;                         // a NAME the detector vocabulary keys on
    };
```

| shape | expressed as |
|---|---|
| plain or renamed `string[]` | unchanged (sugar) |
| a pair carrying an absolute path beside the relative one | `{ path }`; the absolute half is derivable and is dropped |
| a declared `{ rel, shape }` | `{ path, shape }` |
| an implicit root from `process.cwd()` | `["."]` |
| mllp's named constants plus a per-root tier | `{ path, tier }` |

Two consequences that would make it more than tidiness, each scoped to what is measured:

- the **per-root observed-nothing refusal** could become engine process keyed on declared roots.
  Today it has no engine equivalent at any arity. mllp stops needing it only because widening to
  `["."]` leaves one root, and that is arithmetic, not coverage: a repo that declares several roots
  does not get the guard back by adopting;
- a per-root `exclude` answers `dicom`'s measured `README.md` file-root problem (a `.md` file root
  reads nothing under the default read filter, which the engine's own docblock names at
  `phi-scan.js:744-748`). **That justification is `dicom`'s, not mllp's.**

### 3.4 BLOCKING: a detector cannot recover the undecorated path

`DetectContext.path` is the reported LOCUS, and a target from the index union carries an origin
label appended to it (`test/foo.ts (as git carries it)`). Every prefix test still works; every
**extension** test silently stops working, and the failure is live in both directions:

- a `.ts` source arriving through the union is no longer recognised as TypeScript, so it falls
  through to the message scan, where any line of three word characters and a delimiter reads as a
  segment and prose is reported as person names. A gate that reds on prose is a gate someone turns
  off;
- a `.hl7` or `.bin` fixture outside `test/` arriving the same way is no longer fixture-like, so it
  loses the structured scan and can report clean.

It is reachable in ordinary use: any tracked file whose working-tree bytes differ from the index
produces both a walk target (bare locus) and a union target (decorated locus).

- **Parameter:** an undecorated `relPath: string` on `DetectContext`, documented as the SCOPE key
  and never a hit locus, beside the existing `path`. Additive.
- **Not mllp-specific:** `hl7` tiers on `.hl7`, `ncpdp` routes on `.ncpdp` versus `.xml`.
- **Under the "declare the tier as data" design (§4) this becomes internal**, because the engine
  applies the declared tier itself and never hands the question to a caller. Either resolution
  closes it; only one of them also needs the field exported.

### 3.5 The detector half, as kinds plus vocabulary

The five detector KINDS are universal and only their vocabularies differ. Everything below is
already standard-agnostic and belongs in the engine:

| kind | recogniser to hoist | allow dimension |
|---|---|---|
| name | unicode-letter tokenizer, drop tokens under 2 characters unless CJK, strip escape sequences | `names` |
| dob | normalize to `YYYYMMDD` / `YYYYMM` / `YYYY`, month 1..12, day 1..31 | `dobs` |
| id | 9-digit SSN shape; bare 6..9-digit MRN / account shape | `ids` |
| address | street-line shape `^\d+\s+\p{L}` | `addresses` (§3.1) |
| phone | 10-or-more digits, `555` fake-exchange convention | `ids` |

mllp's vocabulary, which is what the repo should be left declaring. ⚖️ **This is AT LEAST what the
declaration must carry, and it is not offered as exhaustive.** A first draft omitted two entries and
both were fail-safe misses (case-insensitive record ids, and the recognisable-record gate), so read
`scripts/phi-scan.ts` beside it rather than treating the list as complete:

```yaml
documentModel:
  kind: delimited-records
  recordSeparators: ["\r\n", "\r", "\n"]
  recordIdLength: 3
  recordIdMatching: case-insensitive        # 🛑 LOAD-BEARING, AND A DRAFT OMITTED IT. The parser is
                                            # lenient about segment case, so the scanner normalizes
                                            # before every lookup (scripts/phi-scan.ts:1708, :2256).
                                            # An engine built with case-SENSITIVE lookups reports
                                            # clean on a `pid|...` feed carrying live PID-3/-5/-7.
                                            # Every id below is written uppercase; that is the
                                            # canonical form, never the match rule.
  delimiterDiscovery:                       # HL7 v2 declares its own delimiters in the header
    headerRecordIds: [MSH, FHS, BHS]
    fieldSeparatorAt: 3                     # MSH-1
    encodingCharactersFrom: 4               # MSH-2 -> component, repetition, escape
  defaults: { field: "|", component: "^", repetition: "~", escape: "\\" }
  skipRecordIds: [MSH, FHS, BHS]            # routing metadata only; the field offset differs

framing:                                    # THE ONLY DELTA BETWEEN mllp AND hl7
  stripBom: true
  stripLeadingBytes: [0x0B]                 # MLLP VT start-block, repeated
  stripTrailingBytes: [0x1C, 0x0D, 0x0A]    # FS end-block, optional CR / LF

fieldMap:                                   # kind -> record -> field positions
  name:
    familyAtComponent1: { PID: [5,6,9], NK1: [2,30], GT1: [3], IN1: [16], MRG: [7], STF: [3] }
    familyAtComponent2: { PV1: [7,8,9,17,52], PD1: [4], ORC: [10,11,12,19],
                          OBR: [10,16,28,32,33,34,35], OBX: [16,25], DG1: [16],
                          PR1: [11], AIP: [3], TXA: [9,10,11], ROL: [4] }
  dob:     { PID: [7], NK1: [16] }
  address: { PID: [11], NK1: [4], GT1: [5], IN1: [19] }
  phone:   { PID: [13,14], NK1: [5,6,7], GT1: [6,7] }
  id:
    codedList: { PID: [3,18] }              # CX: component 1 is the id, component 5 the type code
    plain:     { PID: [19] }                # ST: a bare number

knownRecords: [ the standard HL7 v2 segment ids, verbatim from `KNOWN_SEGMENTS` in scripts/phi-scan.ts ]
                                            # NO COUNT IS WRITTEN HERE. A draft of this file said
                                            # 101; two tools reading the same constant answered 91
                                            # and 81, which is the trap this lineage keeps paying
                                            # for. Copy the members, never a number.
unknownRecordBackstop: adjacent-single-token-name-pair
nameNoiseTokens: [MD, DO, DR, MR, MRS, MS, JR, SR, II, III, IV, RN, NP, PA, PHD, DDS, DMD, ESQ, PROF, FNP, APRN]

documentRecognition:                        # which targets earn the structured scan
  tiers: [fixtures]
  extensions: [".hl7", ".bin"]
  requiresRecognisableRecord: true          # 🛑 ALSO LOAD-BEARING AND ALSO OMITTED BY A DRAFT.
                                            # `looksLikeHl7:1750-1755` admits a target only when a
                                            # recognisable record line survives the framing strip.
                                            # Without it a fixture-like target that is not a message
                                            # is handed to the record scan, where three word
                                            # characters and a delimiter read as a record id and the
                                            # unknown-record backstop reports prose as person names.
                                            # A gate that reds on prose is a gate someone turns off.

embeddedInSource:                           # HL7 written into a `.ts` literal
  appliesToExtensions: [".ts"]
  anchor: quote-or-escape-or-newline, then optional space, then a 3-character id, then "|"
  interpolationPlaceholder: "_"
```

Two claims that must survive into whatever the engine ships, because each was paid for here:

- **the `|` anchor on the embedded recogniser is load-bearing.** Anchoring on "any non-alphanumeric
  delimiter" matched ordinary prose and identifiers all over this suite, which would have driven the
  unknown-record name backstop over English words.
- **the enumeration half alone finds nothing.** Every record-oriented detector wants an id at the
  START of a line, so a `PID` in a string literal reported clean even when the file was named
  EXPLICITLY on argv. Widening enumeration without the recogniser ships a false green.

### 3.6 Two behaviour changes adoption causes here, both accepted

Neither is a request for a parameter. Both are recorded so nobody reads them as regressions found
later.

- **The vanish tolerance goes away, and this is the repo that can actually reach it.**
  `Target.tolerateVanish` reports an `ENOENT` on an untracked file the walk enumerated itself as
  skipped-and-disclosed; the engine REFUSES. This repo's own suite `mkdtemp`s inside `test/` twice
  per run, and a whole-repository root also enumerates a build's `tsup.config.bundled_*.mjs`
  transient. A sweep racing `pnpm test` or `pnpm build` will exit 2 where it used to print a skip
  line. Accepted: it is loud, it is never a false clean, and the standing rule here is to narrow the
  enumeration rather than widen the tolerance. **Do not ask for a tolerance parameter.**
- **A link AT a scan root stops being followed.** This scanner `statSync`s a root, which follows, so
  replacing `test/` or `src/` with a link to a directory outside the repository is read straight
  through: disclosed here, link-neutral, never closed. The engine `lstat`s a root and refuses a link
  there. The disclosure retires because the code changed, not because the sentence was reworded.

---

## 4. The parked branch `phi-scan-completeness-rule`

Graded NOT REFUTED at pass 2, then stopped for arithmetic. It was read; **nothing was
cherry-picked and nothing is proposed for this repo.** Under the "all process is parameterized"
directive every structural thing in it is engine process. **Three of its mechanisms are already in
`@cosyte/script-utils@0.0.2`. A draft said "all of it", which is a closure word over a list of
three:**

- the completeness rule itself (a target enumerated and never read refuses, in every mode, as a SET
  DIFFERENCE and never a size comparison, naming every offender);
- `--allow-fixture` unioned into the target list unconditionally, so the flag means the same thing
  in every argv, and a bypass naming a path the run does not enumerate refusing separately;
- splitting the hit report from the clean line so a run that is both incomplete and carrying hits
  prints both, with the refusal still winning the exit code.

**One property of that branch is NOT in the engine**, and it is a repo value stated at
`scripts/phi-scan.ts:1046-1049` ("a developer who has to re-run the gate to be told the second
offender learns to distrust it"): the branch accumulates every end-of-run refusal and prints them
together, while the engine returns at the first tier (`phi-scan.js:1394-1401` returns before any
target is read, so the unmatched-bypass refusal can never print beside the unread refusal at
`:1465`). Whether that matters enough to be an engine change is a `config` call, not mllp's.

What is worth carrying forward besides is one **claim**, not code: the branch found that
`checkPhoneField` took no allow-list parameter at all and the dashed-SSN branch pushed
unconditionally, so those two classes had **no declaration of any kind** and `--allow-fixture` had
been their only audited remedy. The engine has since fixed half of it (its SSN floor consults
`allow.ids`). The other half is a reason to prefer the kinds-plus-vocabulary design in §3.5: **every
kind gets a dimension by construction**, so a detector with no remedy stops being expressible.

The branch's arithmetic is not relied on anywhere above. Every figure in this file is anchored to the
ref it was taken on and stated beside the members or the command that produces it. A first draft was
not: it wrote a segment-id count two tools disagreed on, dated its scope figures to "this tree" while
they held only at `origin/main`, and reported 48 where the coverage-relevant figure is 31. Those were
caught by an adversarial review of this file rather than by its author, which is the argument for
grading a specification the same way a slice is graded.
