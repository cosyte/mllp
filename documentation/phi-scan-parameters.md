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
separate `walkRoot(...)` call, and each carrying **three** distinct attachments:

| attachment | `test` | `src` | what it is |
|---|---|---|---|
| READ filter | `isScannableTestFile` | `isScannableSrcFile` | per-root, both "under the root (its own path included), not `.md`" |
| observed-nothing IDENTITY | tag `"test"` | tag `"src"` | stamped onto `Target.root`; an EMPTIED walked root refuses, an ABSENT one is legitimate |
| DETECTOR TIER | structured HL7 scan | cross-cutting floor only | `looksLikeHl7` reads `isScannableTestFile` directly so the set that EARNS the scan cannot drift from the set that is READ |

A fourth, hand-written `isUnderScanRoot` carries the union of the two, and it is the boundary the
non-regular refusals key on (never the read filter, because a link's name is no evidence about the
other side of it).

So the spelling is: **N named roots, each carrying a read filter, an identity, and a detector tier.**
It is not a rename of `string[]`, and it is not a flatten of `{abs, rel}[]`.

### mllp and `ccda` are NOT the same shape

They were filed together as one unclassified spelling. They are two.

- **`ccda`** had **no root declaration at all**: its walk was called once on `process.cwd()`, so the
  repository root was the root, spelled as an absolute path rather than as a declaration. Arity 1,
  zero attachments. ⚖️ **That half is READ OFF `ccda`'s OWN DERIVATION, not measured here**, because
  one worker per submodule is absolute and this one owns `mllp`. The mllp half below is measured.
  If the two derivations disagree, `ccda`'s wins for `ccda`.
- **`mllp`** is arity 2 with three attachments per root.

Both land on `scanRoots: ["."]` in a 0.0.2-shaped adoption, but for **opposite** reasons: for `ccda`
that is a re-spelling of what it already did, and for `mllp` it is a **widening**, forced by an
engine limit rather than chosen (see §3.2). Treating them as one shape would hide that.

### Scope measurements taken on this tree (2026-08-11)

- `git ls-files -s` reports **158** stage-0 entries.
- **110** of them are under `test/` + `src/`. Keeping the two narrow roots under 0.0.2 therefore
  drops **48** tracked paths out of every route, because the engine bounds its index union by
  `isUnderScanRoot`. Two of the 48 are `package.json` and `scripts/phi-scan.ts`, which are exactly
  the two that this repo's own `scripts/phi-allow-list.txt` records finding real tokens in when the
  union half landed. That is the escape the union was built to close.

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
- **`excludedPaths` is a narrower mechanism than the `DELIBERATE_VIOLATOR_SOURCES` it would
  replace, and the difference is accounting rather than coverage.** That set is applied at the SCAN:
  the file is still enumerated, still read, and still counted as observed, with every detector
  skipped. The engine's `excludedPaths` drops it from every route, so it is not enumerated and the
  completeness rule has nothing to say about it. The verdict on the corpus is unchanged; what
  changes is that the run no longer claims to have opened that file.

### Both pre-checks, run rather than asserted

1. **No scan root is `./`-prefixed.** The roots are `join(REPO_ROOT, ...)`, so absolute and already
   normalized; the declared spelling is `test` / `src`. Checked the way the failure actually
   presents (a root that walks correctly while matching no index path): the normalized roots match
   110 of 158 index paths, so the union is non-empty and neither index refusal is silently empty.
2. **`isStagedReadable` admits nothing outside `scanRoots`.** The predicate is
   `(p === "test" || p.startsWith("test/") || p === "src" || p.startsWith("src/")) && !p.endsWith(".md")`,
   which is a strict subset of the two roots by construction. Probed over all 158 tracked paths plus
   11 adversarial spellings (`testicle/x.ts`, `srcs/x.ts`, `docs/test/x.ts`, the bare root names,
   `.md` under each root): **zero** admitted outside. The mode-120000 escape this check exists to
   catch is therefore not reachable here through configuration.

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

### 3.3 BLOCKING under the "all process is parameterized" directive: the root type

The seven observed spellings are one type with optional fields. Proposed:

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

| spelling | repos | expressed as |
|---|---|---|
| plain `string[]` | template | unchanged (sugar) |
| renamed `string[]` | `astm`, `transform`, `deid`, `fhir` | unchanged (sugar) |
| `{ abs, rel }[]` | `x12`, `cli` | `{ path }`; `abs` is derivable and is dropped |
| `{ rel, shape }[]` | `dicom` | `{ path, shape }` |
| implicit `process.cwd()` | `ccda` | `["."]` |
| named constants + attachments | `mllp` | `{ path, exclude, tier }` |

Three consequences that make this more than tidiness:

- the **per-root read filter** stops being a single global `isWalkReadable`, which is what forced
  mllp's two filters to be flattened into one and its two roots into one;
- the **per-root observed-nothing refusal** becomes engine process keyed on declared roots. Today it
  has no engine equivalent at any arity. mllp only stops needing it because widening to `["."]`
  leaves one root, and that is arithmetic, not coverage: a repo that declares several roots does not
  get the guard back by adopting;
- `dicom`'s measured `README.md` file-root problem (a `.md` file root reads nothing under the
  default read filter) is answered by `exclude` being per-root instead of global.

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

mllp's vocabulary, which is what the repo should be left declaring:

```yaml
documentModel:
  kind: delimited-records
  recordSeparators: ["\r\n", "\r", "\n"]
  recordIdLength: 3
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
directive every structural thing in it is engine process, and **all of it is already in
`@cosyte/script-utils@0.0.2`**:

- the completeness rule itself (a target enumerated and never read refuses, in every mode, as a SET
  DIFFERENCE and never a size comparison, naming every offender);
- `--allow-fixture` unioned into the target list unconditionally, so the flag means the same thing
  in every argv, and a bypass naming a path the run does not enumerate refusing separately;
- splitting the hit report from the clean line so a run that is both incomplete and carrying hits
  prints both, with the refusal still winning the exit code.

What is worth carrying forward is one **claim**, not code: the branch found that
`checkPhoneField` took no allow-list parameter at all and the dashed-SSN branch pushed
unconditionally, so those two classes had **no declaration of any kind** and `--allow-fixture` had
been their only audited remedy. The engine has since fixed half of it (its SSN floor consults
`allow.ids`). The other half is a reason to prefer the kinds-plus-vocabulary design in §3.5: **every
kind gets a dimension by construction**, so a detector with no remedy stops being expressible.

The branch's arithmetic is not relied on anywhere above. Every figure in this file was measured on
this tree, and each is stated beside the members or the command that produces it.
