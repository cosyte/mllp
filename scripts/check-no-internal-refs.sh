#!/usr/bin/env bash
# scripts/check-no-internal-refs.sh
#
# Founder directive, 2026-07-27: NO INTERNAL PROJECT BOOKKEEPING ON A PUBLIC SURFACE.
# Anything a consumer reads (a GitHub release body, README.md, docs-content/, the npm
# package description) describes what the software does and what changed. It must never
# carry our internal bookkeeping: item identifiers (`MLLP-9`, `CLIENT-04`, `D-23`), "Phase
# 8" / "Plan 05" / "roadmap SC-5", ADR numbers, internal repo paths, or process commentary
# about how the artifact came to exist. Source of truth: the meta-repo's
# `documentation/conventions.md`, "No internal project bookkeeping on a public surface".
# The founder's words: "The releases should also not speak on anything regarding phases,
# etc. That has no relevance to the user consuming it. This goes for readmes and
# documentation as well."
#
# WHY THIS IS A GATE AND NOT A MEMORY NOTE. Founder, same day: "it needs to not just be a
# memory note, but something that is addressed in the workflow accordingly. This needs to
# not happen again." A one-time sweep regresses the first time someone writes `(CLIENT-20)`
# into a doc comment. A documented rule governs whoever reads it; a gate governs everyone.
#
# WHERE THE IDENTIFIERS DO BELONG, and therefore what this gate deliberately does NOT scan:
# the changeset, CHANGELOG.md, commit messages, the PR title and body, CLAUDE.md, source
# `//` comments, and the meta-repo. The traceability is real and worth keeping; it just
# belongs on the inside. So this is a translation at the boundary, not a deletion, and the
# boundary is what SCAN SURFACE below defines.
#
# ---------------------------------------------------------------------------
# WHAT IS LIFTED FROM WHERE, AND WHAT IS DELIBERATELY NOT.
#
#   * THE SHAPE is `ncpdp`'s `scripts/check-no-internal-refs.sh`, NOT `hl7`'s. `hl7` is the
#     original reference, but the ncpdp copy carries three fixes it lacks and all three
#     matter here: the `src/` STRING-LITERAL fourth pass, the PLURAL phase stem (`phases?`),
#     and `/` in the ADR separator class. THE SHAPE, NOT THE FILE: hl7's `CSP` Clinical
#     Study Phase field names, its `PKG` Item Packaging guard and its `HL7-\d{3,4}` table
#     exclusion are HL7-parser machinery, and ncpdp's `SYNTH` omission and pharmacy field
#     references are pharmacy machinery. What is carried across verbatim because it is
#     genuinely cross-repo: the shared prefix list, the paragraph-join second pass, the
#     doc-comment third pass, the string-literal fourth pass, the silent-green route
#     closures, and the NEGATIVE self-tests. What is re-derived for MLLP: the scan surface,
#     the whole REPO-LOCAL identifier vocabulary (which is this repo's dominant class and
#     exists in no sibling), the standards-designation exclusions, and every self-test
#     sample.
#
#   * RULE 7 IS LIFTED FROM `cli`, which is the only sibling that has it. See RULE_NAME[6].
#
#   * THE DETECTION RULES ultimately come from `cosyte/.github`
#     `scripts/release-notes.mjs` (its `CONTENT_RULES`), which is validated against every
#     published release body across the org. This file transcribes the prefix-keyed set to
#     PCRE. THE REASONING IS KEPT WITH THEM ON PURPOSE. Every one of the traps recorded here
#     shipped a public defect before it was caught, and a reader who has not hit them will
#     tidy the guard away as over-complication.
#
# ---------------------------------------------------------------------------
# THE FIVE TRAPS THAT BREAK A NAIVE DETECTOR. All five are why this file is not a one-line
# grep. Do not "simplify" past them.
#
#   (1) KEY ON KNOWN PROJECT PREFIXES, NEVER ON THE `WORD-N` SHAPE. THIS REPO IS THE
#       SHARPEST INSTANCE OF THAT TRAP IN THE WHOLE ECOSYSTEM, and the reason is worth
#       reading before touching a pattern below. `@cosyte/mllp` is an HL7-v2-over-MLLP
#       transport package, so `WORD-N` IS THE NOTATION OF ITS ENTIRE SUBJECT MATTER:
#         * HL7 v2 segment-field references. `MSH-10` (Message Control ID), `MSA-2`
#           (Message Control ID echo), `MSH-1`, `MSH-2`, `MSH-7`, `MSH-9`, `MSH-15`,
#           `MSH-18`, `MSA-1`, `MSA-3`, `PID-3`, `BTS-1`, and the range form `MSH-3..6`.
#           Measured on this tree: MSH/MSA references alone are the single most frequent
#           `WORD-N` token on the public surface. A shape rule deletes the reference
#           material this package exists to explain.
#         * IHE transaction and volume designations. `ITI-19` (Authenticate Node) and
#           `TF-2` (Technical Framework Volume 2), which the TLS page cites throughout.
#         * Character-encoding names. `UTF-8`, `UTF-16`, `UTF-32`, `ISO-8859-1`.
#         * The sibling standards' designations, listed in STANDARDS_DESIGNATION below.
#       Every one of those is asserted in this rule's NEGATIVE sample. The cost of keying
#       on prefixes is that A NEW PROGRAMME OR REQUIREMENT PREFIX MEANS ADDING IT BY HAND
#       and nothing catches it until someone does. That is the cheaper of the two mistakes.
#
#   (2) DECAPITATION, which is a rule for the person REMEDIATING a hit, not for the
#       scanner. Stripping an identifier off the FRONT leaves the fragment behind: "Phase 7
#       (thirteenth slice): builder emits X (CCDA-P7)" became "(thirteenth slice): builder
#       emits X" across 17 lines of ccda's published release notes, which is worse than the
#       text it replaced. Repair the head: drop a leading orphan parenthetical, strip
#       leading punctuation, recapitalise. Same mid-sentence: "(of the v2.4 capability arc)"
#       reads worse than no parenthetical at all.
#
#   (3) CASE SENSITIVITY. The identifier rule is case-SENSITIVE and the segment after the
#       hyphen must start uppercase or with a digit, which is what lets `FHIR-bridge` and
#       `docs-content/` through. HERE IT ALSO KEEPS THIS PACKAGE'S OWN HYPHENATED PROSE
#       INTACT: `MLLP-framed`, `HL7-defined`, `TLS-terminated` and `ACK-correlated` all read
#       as violations under a case-insensitive rule. Leading digits are fine too.
#
#   (4) PHASE PATTERNS NEED A LETTER SUFFIX (`Phase 5b`) AND A LETTER-ONLY FORM (`Phase W`):
#       a digits-only pattern misses both. Ordinal `slice` and `wave` are ours too
#       ("thirteenth slice", "second wave"): "slice" is our word for a unit of work and a
#       reader does not have it. In prose it should read "change".
#
#   (5) THE REMEDIATION PROSE IS ITSELF A DEFECT SURFACE. On ncpdp a refuter's second run
#       found three majors, ALL of them in prose the worker had just written to replace
#       stripped identifiers, and the worst STRENGTHENED A GUARANTEE WHILE DELETING THE LEG
#       THAT GROUNDED IT. THE REMEDY IS TO CUT, NOT TO REWRITE: delete the claim rather than
#       replace it. But the rule inverts, and deid proved it: cutting "(MLLP-10)" off "this
#       is a permanent failure per MLLP-10" is a deletion; cutting the QUALIFIER that BOUNDS
#       a claim upgrades it into a capability the code lacks. CUT THE CLAIM, NOT THE
#       QUALIFIER THAT BOUNDS IT, and verify the remaining sentence against the code twice.
#
# ---------------------------------------------------------------------------
# SCAN SURFACE. This gate scans the PUBLIC surface only, which is the one substantive
# difference from check-no-emdash (that one scans every tracked file, because the em-dash
# ban has no inside/outside distinction: it covers commit messages too). Here the same
# identifier is REQUIRED on the inside and BANNED on the outside, so scanning every tracked
# file would red on CHANGELOG.md, `.changeset/`, CLAUDE.md and source comments, where the
# convention explicitly says the identifiers belong. A gate that reds on correct content is
# a gate someone deletes.
#
# In scope:
#   * README.md            the repo's front page, and shipped inside the npm tarball
#   * TRADEMARKS.md        shipped inside the npm tarball (`files` in package.json)
#   * LICENSE              shipped inside the npm tarball
#   * docs-content/        every tracked file, including sidebars.json: this is the content
#                          published to docs.cosyte.com
#   * package.json         the npm-visible metadata ONLY (`description`, `keywords`),
#                          extracted and scanned as text. Named explicitly by the
#                          convention. The rest of package.json is not public prose, and
#                          scanning it whole would red on a future dependency or script name
#                          that happens to match.
#
# Out of scope, each for a stated reason:
#   * CHANGELOG.md         SHIPS INSIDE THE NPM TARBALL, so it is genuinely public surface,
#                          and it currently carries internal identifiers across its history.
#                          It is excluded anyway because the convention names CHANGELOG.md
#                          as one of the places identifiers BELONG, and because rewriting a
#                          released changelog's history destroys the traceability the same
#                          convention preserves. That is a LIVE CONTRADICTION IN THE
#                          STANDARD, it is ECOSYSTEM-WIDE (every parser has it), hl7 and
#                          ncpdp exclude it on exactly this reasoning, and it is not for one
#                          repo to settle alone. Recorded here, and queued on
#                          PUBLIC-SURFACE-HYGIENE in the meta-repo, rather than silently
#                          decided in either direction.
#   * phi-scan-overrides.md
#                          the audit log for fixture-level PHI-scan bypasses. Internal
#                          compliance bookkeeping, not consumer documentation, and not in
#                          package.json `files`.
#   * CLAUDE.md, .github/, .changeset/, scripts/, test/, vendor/
#                          internal by definition, or code rather than prose.
#   * src/ DOC COMMENTS    IN SCOPE, as a THIRD PASS at the bottom of this file, with its
#                          own rule array (SRC_RULE_PATTERN), its own self-tests, and its
#                          own extractor. `src/` JSDoc IS public: it is compiled into the
#                          `.d.ts`/`.d.cts` of all THREE published entry points, `dist` is
#                          the first entry in package.json's `files`, and it is what a
#                          consumer's editor shows on hover.
#   * src/ STRING LITERALS IN SCOPE, as a FOURTH PASS. See STR_RULE_NAME below. This repo
#                          emits ACK text and error messages onto a WIRE PROTOCOL, so the
#                          string surface is first-class here, not an afterthought.
#   * src/ `//` COMMENTS   OUT of scope, because THE CONVENTION SAYS SO: it names source
#                          comments as one of the places identifiers BELONG. That is the
#                          whole reason, and it is deliberately the only one.
#                          DO NOT REASON ABOUT THIS BOUNDARY FROM WHAT REACHES `dist/`.
#                          Two drafts of the ncpdp file tried and both were false, each
#                          caught by a refuter. The measured fact, and the only one worth
#                          writing down: `dist` is `files[0]`, there is no `.npmignore`, the
#                          bundles carry source comments and `dist/*.map` carries every
#                          tracked source byte in `sourcesContent`. SO EVERYTHING IN `src/`
#                          IS IN THE TARBALL. This gate's line is therefore not "what
#                          reaches the consumer's disk" -- everything does -- but WHAT THE
#                          CONSUMER IS SHOWN: JSDoc their editor renders on hover, and
#                          message text their log prints. Those are passes three and four.
#                          A comment they would have to go digging for is not.
#   * dist/                NOT SCANNED, and this is the gate's stated ceiling rather than a
#                          hole that has been closed. `dist/` is untracked build output:
#                          neither this script nor CI can read it without building first,
#                          and this script does not build. What the third pass gates is
#                          dist's SOURCE, which is a proxy that holds only because the dts
#                          build copies doc text verbatim. A build that began transforming
#                          comments would decouple the two silently. THIS PACKAGE PUBLISHES
#                          THREE ENTRY POINTS (`.`, `./testing`, `./ack-from-hl7`), each
#                          with a `.d.ts` and a `.d.cts`, so "does it reach a declaration
#                          file" is six questions rather than one -- which is the argument
#                          for sweeping the source wholesale instead.
#
# ---------------------------------------------------------------------------
# NO STDIN / PR-TEXT MODE, deliberately, and this is the other difference from
# check-no-emdash. That gate scans the PR title, body and commit messages because the brand
# rule names commit messages explicitly. This rule says the opposite: identifiers BELONG in
# the commit, the PR and the changeset. A PR-text half here would red on correct work. If
# you are looking for the half that keeps identifiers out of a published RELEASE BODY, it
# exists and it is not here: `cosyte/.github` `scripts/release-notes.mjs assert` runs inside
# the shared release pipeline and refuses to publish a violating body.
#
# ---------------------------------------------------------------------------
# DISCLOSED RESIDUALS. Known and stated rather than discovered later.
#
#   (i)   THE SHARED PREFIX LIST IS DUPLICATED across every copy of this gate and against
#         release-notes.mjs, because a bash gate inside a parser repo cannot import from
#         `cosyte/.github` and vendoring a 900-line Node script into 11 repos is worse. So
#         the copies can drift. The cross-repo fix is one shared list, and it is ONE fix
#         across every copy rather than one per repo. Do not patch this copy alone; a
#         divergent variant is worse than a known shared limit. THE REPO-LOCAL LIST IS A
#         DIFFERENT THING and is deliberately a SEPARATE variable so the shared one stays
#         diffable against its siblings.
#   (ii)  The scan reads file CONTENTS, never file NAMES. A tracked path that itself carries
#         an identifier passes green. Shared with check-no-emdash.
#   (iii) An identifier inside a fenced code block, a URL, or a link target is treated
#         exactly like prose. That is deliberate (a reader sees it either way), but it means
#         a legitimate quotation of an internal path in an example would have to be
#         rewritten rather than escaped.
#   (iv)  This gate does not check the em dash. `scripts/check-no-emdash.sh` owns that rule
#         and scans a wider surface; duplicating it here would put the same red in two
#         places with two wordings.
#   (v)   IT CATCHES IDENTIFIERS, NOT PROSE ABOUT OUR PROCESS. The founder's rule bans both.
#         A heading reading "what this change models", a note that a quirk "has no
#         demonstrator yet", or a sentence describing which unit of work added a feature are
#         ordinary English whose only fault is that they describe how the artifact came to
#         exist. No pattern finds them. THE BY-HAND HALF IS NOT CLAIMED COMPLETE and should
#         not be.
#   (vi)  `phase` AT THE END OF A CLAUSE IS NOT CAUGHT. Rule 2 keys on `phase` plus a
#         following word, so `phase models` and `phase opens` red; `phase.` and `phase;` do
#         not. deid measured 17 of these in `src/` and 18 in public markdown, SEVEN OF WHICH
#         WERE FACTUALLY FALSE on published pages. A ZERO FROM A RULE SET IS NOT A ZERO:
#         check truth, not just tidiness. A rule for the determiner form was written,
#         measured and REMOVED in the hl7 copy because of what it cost in clinical phrasing;
#         that verdict is inherited rather than re-litigated. The paragraph-joined second
#         pass narrows it: `phase` at a line end followed by more prose in the same
#         paragraph DOES red, because the join makes the next word adjacent.
#  (vii)  A BARE SECTION CITATION (`§4.7`, `(§3.19.6.2.3)`) IS DELIBERATELY NOT RULED, and
#         in THIS repo that is not a close call. MEASURED ON THIS TREE: all 49 `§`
#         occurrences on the gated surface are REAL SPEC CITATIONS -- `HL7 v2.5.1 §2.9.2.2`
#         (the MSA-2-echoes-MSH-10 requirement this whole package is built around),
#         `RFC 8446 §4.4.2` (the TLS 1.3 client-certificate timing caveat), and
#         `ITI TF-2 §3.19.6.2.3` (the IHE ATNA TLS cipher-suite mandate). NOT ONE is an
#         internal roadmap pointer. Keying on `§` alone is therefore trap (1) arriving
#         through punctuation, and it would delete the normative citations a transport
#         library's docs exist to provide. transform had 28 bare `(§4.7)` and deid 19, both
#         cleared BY HAND for the same reason. PINNED BY A NEGATIVE SELF-TEST below, so
#         reopening this has to be deliberate.
# (viii)  A VIOLATION SPLIT BY INLINE MARKUP REJOINS IN NEITHER PASS. `phase **8**` and
#         `phase [8](...)` put markup between the two tokens, and neither the line scan nor
#         the paragraph join strips it, so a multi-token rule does not match. Closing it
#         needs a markdown renderer, not a bigger regex. REACHABLE HERE: this repo's docs
#         bold their emphasis heavily.
#   (ix)  THE THIRD PASS CANNOT SEE `dist/`, only its source. Stated at length in the pass
#         itself and in SCAN SURFACE above, and repeated here because it is the single most
#         important thing to know about what this gate does and does not prove.
#   (x)   A DOC COMMENT THAT DOES NOT OPEN ITS OWN LINE IS INVISIBLE TO THE THIRD PASS. The
#         extractor enters a block only on `^[[:space:]]*/**`, so `const x = 1; /** ... */`
#         is scanned by neither pass 3 (never entered) nor pass 4 (not a string literal).
#         Not fixed because entering mid-line means tracking whether the `/**` is itself
#         inside a string or a regex, which is a tokenizer. Prettier puts a doc comment on
#         its own line and `format:check` runs ahead of this gate on the ladder.
#   (xi)  `ERR-0\d` IS A FALSE *NEGATIVE* ON ANY NON-ZERO-PADDED `ERR-N` OF OUR OWN, NOT A FALSE
#         POSITIVE ON HL7'S. The arm requires a literal `0` after the hyphen, so it matches
#         `ERR-02`..`ERR-09` and structurally CANNOT match HL7 v2's `ERR-3`, `ERR-4`, `ERR-10`,
#         `ERR-11` or `ERR-12`. That is the right direction for safety (reference material is
#         never destroyed) and the wrong direction for coverage: the day this repo mints an
#         `ERR-10`, or any `ERR-N` it does not zero-pad, of its own, the gate will not see
#         it. Stated in the correct direction
#         because an earlier draft of this comment asserted the opposite and a refuter
#         measured it. A disclosure that names the wrong failure mode is worse than none: it
#         sends the next reader hunting a collision that cannot occur, and leaves the gap that
#         does exist unwatched.
#  (xii)  MEASURE ON THE REFLOWED TEXT, NOT LINE BY LINE, when you sweep by hand. hl7's
#         `Plan N` sweep was done with a line scan and reported itself complete while one
#         instance survived where `Plan` ended a line and `04` began the next; it shipped
#         into `dist/`. Also: QUOTE A COUNT WITH THE TREE IT WAS TAKEN ON, OR NOT AT ALL.
#  (xiii) A CITATION *OF* `CLAUDE.md` FROM A PUBLIC SURFACE IS CAUGHT BY NOTHING. `CLAUDE.md`
#         is excluded as a scanned INPUT (it is internal by definition), but RULE 5 keys on
#         meta-repo paths, so a doc comment reading "(CLAUDE.md stable-codes guardrail ...)"
#         passes green and compiles into the declarations. Measured on this tree: TWO such
#         citations ship, in `dist/index.d.ts` and `.d.cts`, from `src/client/client.ts` and
#         `src/server/ack.ts`, plus two more in `src/internal/control-id.ts` that do not.
#         All four are PRE-EXISTING and are left standing rather than rewritten, because the
#         sentences around them are load-bearing API-stability statements and this item has
#         already shipped several defects by rewriting prose it meant only to trim.
#         THE COST OF CLOSING IT IS NOT ONE TOKEN, and an earlier draft of this note said it
#         was. Adding `|\bCLAUDE\.md\b` to RULE_PATTERN[4] is one alternative and breaks no
#         self-test, but it REDS THIS TREE IMMEDIATELY on those four citations, which is
#         exactly the rewrite this note declines to do. So closing it is a remediation, not a
#         rule edit, and it belongs in its own change with its own measurement.
#
# Run it locally with `pnpm check:no-internal-refs`.
set -euo pipefail

# LOCALE PIN, load-bearing, and inherited from check-no-emdash for the same measured reason:
# `grep -P` compiles PCRE in UTF-8 mode only when the locale says so. Under LC_CTYPE=POSIX
# (a bare container, cron, `sh -c`) GNU grep's handling of non-ASCII in the input and of
# `\w` in the pattern changes, and the docs scanned here contain non-ASCII (`§`, `≤`, the
# box-drawing rules in source banners, curly quotes). A gate whose matching depends on an
# inherited environment is a gate that reports green somewhere and red elsewhere.
export LC_ALL=C.UTF-8

# ---------------------------------------------------------------------------
# THE BANNED SET, transcribed from release-notes.mjs CONTENT_RULES
# ---------------------------------------------------------------------------

# Known project and programme prefixes, SHARED ACROSS THE ECOSYSTEM. THE KEYING IS ON THESE,
# NEVER ON THE `WORD-N` SHAPE: see trap (1). Kept in the same order as the source list so a
# diff between the copies is legible.
#
# `PKG` is deliberately absent, for hl7's reason rather than one of ours: `PKG-1` and `PKG-4`
# are HL7 v2 Chapter 17 Item Packaging segment-field references, and this is an HL7 package.
# `SYNTH` IS PRESENT here and is absent from the ncpdp copy, where `SYNTH-MSG-0001` is
# example data in every runnable sample. Measured on this tree: `SYNTH` appears zero times on
# the gated surface, so carrying it costs nothing and keeps this copy diffable against hl7
# and cli.
PROJECT_PREFIXES='PARSERS-PUBLIC|DOCS-CONTENT|KNOWLEDGEBASE|TERMINOLOGY|PATHWAYS|TRANSFORM|WEBSITE|STAGING|SUPPLY|NCPDP|ASSETS|EMDASH|README|CONFIG|DICOM|DEID|CCDA|ASTM|MLLP|FHIR|CREW|DOCS|PERF|SYNC|VERSION|PUBLIC|SYNTH|HL7|X12|IAC|CLI|KB|PW|PUB|CI|REAL|TERM|WF|VERIFY'

# STANDARDS DESIGNATIONS THAT COLLIDE WITH THE PREFIX LIST, excluded explicitly. Eight of the
# prefixes above (`MLLP`, `HL7`, `NCPDP`, `X12`, `DICOM`, `FHIR`, `CCDA`, `ASTM`) name
# standards this ecosystem parses as well as our own projects.
#
# `MLLP` IS THE ONE THAT MATTERS HERE, and the answer is measured rather than assumed: HL7
# writes the protocol's own versions as "MLLP Release 1" and "MLLP R1", with no hyphen, and
# on this tree EVERY hyphenated `MLLP-<CAPS>` token is ours (`MLLP-9`, `MLLP-10`,
# `MLLP-BATCH`, and the `MLLP-ACK-*` case identifiers). So no `MLLP-` exclusion is carried,
# and that is a finding, not an oversight -- unlike ncpdp, where `NCPDP-SCRIPT` and
# `NCPDP-TELECOM` are the standards themselves. If HL7 ever mints a hyphenated MLLP
# designation, it goes here.
#
# HL7's `HL7-\d{3,4}` ARM IS DELIBERATELY DROPPED even though this is an HL7 package. In the
# hl7 copy it exempts HL7 v2 TABLE numbers (Table 0396, Table 0003) written with a hyphen.
# This package is TRANSPORT-ONLY -- it frames bytes and echoes MSH-10; `@cosyte/hl7` owns
# message content and the tables that go with it. Measured on this tree: `HL7-` followed by
# digits appears zero times on the gated surface. Carrying the arm would exempt a shape this
# repo never writes while weakening the rule against a real `HL7-<digits>` item identifier
# leaking in from a sibling's release note. That is porting the FILE rather than the SHAPE.
STANDARDS_DESIGNATION='HL7-(?:V2|V3|CDA|FHIR|OMG)|FHIR-R\d[A-Z]?|DICOM-(?:SR|RT|SEG|DIR|PS\d)|X12-\d{3}[A-Z]?|X12-\d{6}|CCDA-R\d(?:\.\d)?|ASTM-E\d+|NCPDP-(?:SCRIPT|TELECOM|D\.\d|F\d)'

# ---------------------------------------------------------------------------
# THE REPO-LOCAL IDENTIFIER VOCABULARY. THIS IS THIS REPO'S DOMINANT CLASS AND IT EXISTS IN
# NO SIBLING COPY -- adding it is most of what makes this a port of the SHAPE rather than of
# the FILE.
# ---------------------------------------------------------------------------
#
# The shared list above catches `MLLP-9` and `MLLP-BATCH`. It catches NONE of what this
# repo's roadmap actually mints, which is a per-area requirement vocabulary threaded through
# almost every doc comment in `src/`:
#
#   PLAN-01..06     the client build plan            CLIENT-02..19  client requirements
#   SERVER-03..12   server requirements              FRAME-03..11   framing requirements
#   LIFE-01..05     connection-lifecycle states      OBS-01..05     observability
#   WARN-05..10     warning-behaviour requirements   ERR-02..04     error-type requirements
#   SC-5            a roadmap section pointer        D-02..26       design decisions
#   W-01..07        warning-code decisions           B-01..06       behaviour decisions
#   T-NN-NN-NN      threat-model identifiers         D-CR-01        a change-request decision
#
# THREE SHAPE DECISIONS, each measured on this tree and each protecting reference material:
#
#   * A DIGIT IS REQUIRED AFTER THE HYPHEN for every local prefix. Without it, `FRAME-FATAL`
#     (a real internal branch name in `src/connection/connection.ts` doc comments, and NOT an
#     identifier) reds, and so would any future `CLIENT-SIDE` or `SERVER-NAME` compound. The
#     local vocabulary is prefix-plus-number without exception; the English compounds are
#     prefix-plus-word. That is a clean structural split, so take it.
#
#   * `ERR` IS RESTRICTED TO THE ZERO-PADDED FORM `ERR-0\d`, AND THIS IS THE SHARPEST TRAP-1
#     CALL IN THE FILE. `ERR` is simultaneously one of our requirement prefixes (`ERR-02`
#     ACK timeout, `ERR-03` connection errors, `ERR-04` backpressure) and THE HL7 v2 ERROR
#     SEGMENT, whose fields `ERR-3` (Error Code) and `ERR-4` (Severity) this package's own
#     `ack-from-hl7` surface documents and tests. There is no semantic shape that separates
#     them, but there is a TYPOGRAPHIC one that holds across the whole ecosystem: OUR
#     identifiers are zero-padded two-digit (`ERR-02`, `D-06`, `W-01`) and HL7 FIELD NUMBERS
#     ARE NEVER ZERO-PADDED (`MSH-10`, `MSA-2`, `PID-3`, `ERR-3`, `BTS-1`). So `ERR-0\d`
#     takes all six of ours and structurally cannot take `ERR-3` or `ERR-4`. THE RESIDUAL IS
#     REAL AND IS DISCLOSED AS (xi), BUT IT RUNS THE OPPOSITE WAY TO THE OBVIOUS GUESS:
#     because the arm needs a LITERAL `0`, HL7's `ERR-3`, `ERR-4`, `ERR-10`, `ERR-11` and
#     `ERR-12` are all safe from it, and what the gate would MISS is ANY NON-ZERO-PADDED
#     `ERR-N` OF OUR OWN. `ERR-20` and `ERR-100` are unambiguous examples; HL7's ERR has
#     exactly 12 fields, so anything above that is ours by construction. `ERR-3` and
#     `ERR-4` are asserted in NEGATIVE[0] so a widening to `ERR-\d+` reds here instead of
#     deleting a field reference from a consumer's editor tooltip.
#
#   * SINGLE-LETTER PREFIXES (`D`, `W`, `B`, `T`) REQUIRE EXACTLY TWO DIGITS PER GROUP AND A
#     WORD BOUNDARY AFTER. ncpdp declines to catch `D-NN` at all, for a clinical reason:
#     legacy SNOMED RT codes are axis-prefixed in exactly that shape (`D-13000` topography,
#     `T-32000`, `M-80003`). THAT REASON DOES NOT REACH THIS PACKAGE -- it is transport-only
#     and never touches a clinical code -- but the pattern is written so it would be safe
#     even if it did: `\bD-\d{2}\b` cannot match `D-13000`, because the boundary after two
#     digits fails against the third. Both SNOMED RT samples are asserted in NEGATIVE[0].
#     Without this arm the gate misses `D-02..26`, `W-01..07`, `B-01..06` and every
#     threat-model `T-NN-NN-NN`, which together are a large fraction of this repo's mass.
MLLP_LOCAL_IDENT='\b(?:PLAN|CLIENT|SERVER|FRAME|LIFE|OBS|WARN|SC)-\d{1,2}\b|\bERR-0\d\b|\bD-CR-\d{2}\b|\b[DWBT]-\d{2}(?:-\d{2})*\b'

# Rule 1: internal project identifier. CASE SENSITIVE, and the segment after the hyphen must
# start with an uppercase letter or a digit, which is what lets `FHIR-bridge`, `MLLP-framed`
# and `HL7-defined` through (trap 3). The second alternative is our internal priority label,
# and it matches its own trailing word rather than looking ahead for one: an earlier version
# keyed on `P\d+` followed by end-of-string or a comma, which is the shape rule this file
# exists to avoid. It deleted the ICD-10-CM code in "Map ICD-10 P07, P22 and P29 to SNOMED
# CT" and truncated the code range "P00-P96". The third alternative is the repo-local
# vocabulary above.
RULE_NAME[0]='internal project identifier'
RULE_PATTERN[0]='\b(?!(?:'"$STANDARDS_DESIGNATION"')\b)(?:'"$PROJECT_PREFIXES"')(?:-[A-Z0-9][A-Z0-9.]*)+\b|\bP\d+ (?:safety|documentation)\b|'"$MLLP_LOCAL_IDENT"

# Rule 2: phase, plan and wave language. CASE INSENSITIVE via the inline `(?i)`, because the
# rules do not share a case policy and one `grep -i` for all of them would break trap (3).
# `Phase 5b` and `Phase W` are both covered (trap 4). The negative lookahead keeps ordinary
# English off the list, so "in phase with the source system" and "out of phase" survive --
# and those are REACHABLE HERE, because "in phase" is ordinary protocol-timing prose.
#
# THE CLINICAL LOOKBEHINDS ARE KEPT VERBATIM from the ncpdp copy even though this package is
# transport-only and reaches for none of them (measured: zero occurrences of study, clinical,
# trial, acute, chronic, luteal, follicular, liquid or gas before `phase`). They only ever
# EXCLUDE, so they cannot cause a miss of our jargon, and diverging from the sibling copies
# to delete an unused alternation would make the copies harder to diff for no safety gained
# (residual (i)). hl7's `identifier|start|end|evaluability` lookahead IS dropped: it exempts
# the field names of the Chapter 7 `CSP` Clinical Study Phase segment, which is message
# CONTENT vocabulary that a transport package does not carry, and carrying it would widen
# residual (vi) for a construction this repo cannot write.
#
# `where|are|was|were|during|at` ARE AN MLLP ADDITION TO THE ORDINARY-ENGLISH LOOKAHEAD, and
# they are trap (1) landing on this package's PUBLIC API. `ConnectionErrorPhase` is an exported
# union (`'connect' | 'send' | 'receive' | 'close' | 'reconnect'`) surfaced as
# `MllpConnectionError.phase`, it is documented on docs.cosyte.com, and @cosyte/mllp is
# PUBLISHED at 0.0.2, so the name cannot be changed. Its own doc comment necessarily reads
# "Connection lifecycle PHASE WHERE the error occurred" and "All 5 PHASES ARE defined", and the
# base rule matched both. These are the same class of English function word the lookahead
# already carried (`of`, `with`, `is`, `the`), not a special case carved for one file: no
# internal identifier is ever spelled `Phase where` or `Phase are`. Asserted in NEGATIVE[1] and
# SRC_NEGATIVE[1] with the real doc text, so a future narrowing reds here rather than forcing a
# rename of a published field.
# `phase[ -]` rather than `phase ` is kept: `Phase-L` was live in hl7's docs and slipped a
# space-only rule. `phases?` (the plural stem) is ncpdp's fix and is carried.
#
# `\bplans? \d+` IS AN MLLP ADDITION, and it is measured rather than copied. This repo's
# client was built to a numbered PLAN, and its doc comments cite it BOTH ways: `PLAN-01`
# (caught by rule 1) and, far more often, `Plan 04` / `Plan 05` / `plan 05` with a space,
# which rule 1 cannot see and no sibling's rule 2 covers. Twenty-plus live instances on this
# tree, all in `src/` doc comments that compile into all three entry points' `.d.ts`. The
# accepted false positive is a consumer-facing sentence containing "plan 5"; there is no such
# construction in a transport library's docs, and NEGATIVE[1] pins the ordinary-English uses
# ("a migration plan", "the plan is") that must keep passing.
ORDINAL='(?:first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|twenty-first|twenty-second|twenty-third|twenty-fourth|\d+(?:st|nd|rd|th))'
# THE COMPOUND-ADJECTIVE GUARD IS AN MLLP ADDITION, AND IT IS TRAP (1) ARRIVING THROUGH RULE 2
# RATHER THAN RULE 1. Found twice by this gate's own runs over this tree, both on live text:
#   * `docs-content/acks.md` reads "No enhanced-mode TWO-PHASE sequencing", and HL7 v2 enhanced
#     acknowledgement mode genuinely IS a two-phase protocol (an accept ACK, then an
#     application ACK). That is the exact protocol vocabulary a consumer comes to an MLLP
#     library to read, and rule 2 matched it as `phase sequencing`.
#   * `src/client/client.ts` reads "Wrap a CONNECT-PHASE socket error", where "connect-phase"
#     is ordinary English for the TCP phase the error happened in.
# The remedy is the guard, NOT a rewrite: "two-stage" would be less accurate than the term the
# standard uses, and "connect-phase" has no better synonym. THE GUARD IS A SHAPE, NOT A WORD
# LIST, and that is deliberate: a first draft enumerated `two-|three-|multi-|single-|bi-|dual-`
# and the second false positive walked straight past it, which is the enumeration telling you
# it is the wrong tool. ANY letter-hyphen immediately before `phase` is the English
# compound-adjective shape and is never our bookkeeping: ours is `Phase 5`, `Phase 5b`,
# `Phase W`, `Phase-L` and `phase-by-phase`, none of which is preceded by `<letter>-`. Note it
# does NOT weaken `phase-by-phase`, whose FIRST `phase` has nothing before it. Asserted in
# NEGATIVE[1] and SRC_NEGATIVE[1] in both directions.
PHASE_NOT_COMPOUND='(?<![A-Za-z]-)'
PHASE_NOT_CLINICAL='(?<!study )(?<!clinical )(?<!trial )(?<!acute )(?<!chronic )(?<!luteal )(?<!follicular )(?<!liquid )(?<!gas )'
PHASE_NOT_ENGLISH='(?!of\b|with\b|in\b|out\b|the\b|and\b|is\b|for\b|to\b|where\b|are\b|was\b|were\b|during\b|at\b|(?:I{1,3}|IV)\s+(?:trial|stud|clinical|oncolog))'
RULE_NAME[1]='phase, plan or wave language'
RULE_PATTERN[1]='(?i)\b(?:roadmap phases?\b[ ]?[A-Za-z0-9]*|'"$PHASE_NOT_COMPOUND$PHASE_NOT_CLINICAL"'phases?[ -]'"$PHASE_NOT_ENGLISH"'[A-Za-z0-9]+[a-z]?\b|plans? \d+\b|wave \d+\b|the \w+ and final phase\b|documentation residual\b|'"$ORDINAL"' (?:slice|wave)\b)'

# Rule 3: ADR references. An ADR number is a pointer into a decision record the reader did
# not come here for. Measured zero instances on this tree; the rule is carried because the
# convention that produces them is shared across the parsers and because this repo's own
# CLAUDE.md cites ADRs, so the temptation to cite one from a doc comment is live. Cite what
# the decision WAS, not the number it has.
#
# `/` IS IN THE SEPARATOR CLASS. That is ncpdp's fix and hl7's copy does not have it: hl7
# cites ADRs in prose ("Decided in ADR 0015"), which a space-or-hyphen class covers, while an
# ADR cited by PATH (`documentation/decisions/0015-x.md`, `docs/adr/0001-x.md`) slips a
# space-or-hyphen rule entirely. Three live citations survived a whole gate in ncpdp because
# of that gap, and a refuter found them. The path form is asserted ALONE below.
#
# THE `\d{3,4}` FLOOR IS INHERITED AND IS A KNOWN GAP: `ADR 7` and `ADR-12` are not caught.
# Every ADR in this ecosystem is written four-digit, and lowering the floor to `\d{1,4}` would
# start matching ordinary two-digit numbers after any three letters that happen to spell
# `adr`.
RULE_NAME[2]='ADR reference'
RULE_PATTERN[2]='(?i)\bADR[ \-/]?\d{3,4}\b'

# Rule 4: `slice`, our internal word for a unit of work. It is ALSO real clinical vocabulary
# elsewhere in this ecosystem (a DICOM study has slices, with a slice thickness, a slice
# location and slice spacing) AND, far more reachably here, it is a TypeScript method: this
# package calls `.slice()` on Buffers on almost every hot path and its doc comments describe
# "the slice after the block header". So this keys on the determiner forms that are
# unambiguously ours ("this slice", "the final slice") and excludes the imaging nouns. A bare
# `slice` is deliberately NOT flagged.
#
# THE IMAGING-NOUN EXCLUSION IS KEPT VERBATIM even though this package frames TCP bytes and
# reaches for none of it. It only ever EXCLUDES, so it cannot cause a miss of our jargon;
# diverging from the sibling copies to delete an unused alternation would make the copies
# harder to diff for no safety gained (residual (i)). A modifier may sit between the
# determiner and the noun ("the misfiling-prevention slice") but a preposition may not: "the
# Number of Slices" is a DICOM attribute, not one of our units of work.
#
# THE KNOWN FALSE POSITIVE IS `the slice of Y` IN CODE PROSE, where `slice` means portion and
# is nobody's jargon. The preposition guard sits between the determiner and the noun, so it
# does not reach a preposition AFTER it, and "the slice of the buffer after VT" reds. ncpdp hit
# exactly this, REWROTE both instances ("portion", "substring") and DELIBERATELY DID NOT NARROW
# THE RULE, on the grounds that a narrowing has no self-test to hold it and the plainer word is
# clearer anyway. That verdict is inherited here rather than re-litigated, and it is why the
# NEGATIVE sample below asserts the CODE-CALL form (`buf.slice(0, 3)`) and not the determiner
# form: asserting a phrasing the rule genuinely matches would be writing a self-test that
# demands the rule be broken. If a third instance appears where no rewrite reads well, that is
# the signal to narrow the rule and assert the phrasing, not to widen an exclusion quietly.
IMAGING_NOUNS='thickness|location|spacing|position|interval|order|number|index|gap|count|data|pixel|orientation|plane|direction|width|vector|sensitivity|progression|factor'
RULE_NAME[3]='internal jargon ("slice")'
RULE_PATTERN[3]='(?i)\b(?:this|that|the|each|another|previous|next|final|current)\s+(?:(?!(?:of|in|on|between|per|for|to|with|at)\s)[\w-]+\s+){0,2}slices?\b(?!\s+(?:'"$IMAGING_NOUNS"'))'

# Rule 5: internal repo paths. A docs page carries citations, and a reader who installs
# @cosyte/mllp has no meta-repo and no such file. Keyed on the known meta-repo paths, not on
# a `dir/file.md` shape, for exactly the reason trap (1) gives -- this package's own pages
# legitimately cite `docs-content/limitations.md`, which a shape rule would take with it.
# The `roadmap §` arm is synth's widening, where that arm ALONE found 171 of 288 rows.
RULE_NAME[4]='internal repo path'
RULE_PATTERN[4]='\boperations/(?:BACKLOG\.md|roadmaps/|plans/)|\bdocumentation/(?:decisions/|ecosystem-map\.md|conventions\.md)|\bBACKLOG\.md\b|\broadmap §'

# Rule 6: internal traceability markers. Bracketed spec-trace tags that key into a roadmap
# traceability table, and "Open-question #12" pointers into a decision log the reader cannot
# open. Zero instances measured on this tree; the rule is carried because the convention that
# produces them is shared across the parsers and a page copied from a sibling would bring
# them along. Both are DELIMITER-ANCHORED rather than shape-keyed, which is the only reason
# they are safe: the tag rule requires a literal `[S-` opening bracket and at least two
# characters after it, so a documented character range like `[S-Z]` does not match.
RULE_NAME[5]='internal traceability marker'
RULE_PATTERN[5]='\[S-[A-Z][A-Z0-9]+(?:-[A-Z0-9]+)*\]|(?i:\bopen[- ]question #?\d+\b)'

# Rule 7: A PROSE CITATION OF THE ROADMAP. THIS RULE EXISTS IN ONLY ONE SIBLING (`cli`), and
# it is lifted here because it is measurement, not taste: in cli it found 30 of 61 violations
# and rules 1 through 6 could not see one of them. `hl7` and `ncpdp` cite the roadmap by PATH
# (`operations/roadmaps/<repo>.md`), which rule 5 already catches; a repo that cites it in
# PROSE is invisible to every copy that did not port this rule.
#
# WHAT IT KEYS ON, and why each arm is drawn where it is:
#   * `<repo> roadmap`, keyed on the KNOWN REPO NAMES rather than on a `<word> roadmap`
#     shape. Same bargain as trap (1): a new repo means adding its name here. That keeps "a
#     product roadmap", "the vendor's roadmap" and any consumer-facing use of the ordinary
#     English word out of scope.
#   * `the|this|our roadmap`, which cli added because two of its thirty were written that
#     way and a rule keyed on repo names alone walked past both.
#   * `roadmap §`, the section-pointer form, which survives even if the qualifier changes.
#   * `roadmap <IDENT>`, WHICH IS THIS REPO'S ADDITION AND ITS ONLY LIVE FORM. Measured on
#     this tree, `roadmap` appears exactly three times on the gated surface and all three
#     read `ROADMAP SC-5` -- an unqualified, uppercased pointer at a roadmap SECTION,
#     attached to the doc comments of two exported members. cli's three arms catch none of
#     them, and rule 1 catches only the `SC-5` half, which would leave a decapitated
#     `(ROADMAP)` behind under trap (2). Keyed on `roadmap` followed by an identifier-shaped
#     token so a BARE `Roadmap` HEADING STILL PASSES: a README section describing upcoming
#     capability in consumer terms is legitimate content and this rule must not ban it.
ROADMAP_OWNERS='mllp|hl7|fhir|cli|dicom|x12|ccda|ncpdp|astm|transform|terminology|synth|deid|pathways|docs|website|iac|crew|knowledgebase|config|the|this|our'
RULE_NAME[6]='internal roadmap citation'
RULE_PATTERN[6]='(?i)\b(?:'"$ROADMAP_OWNERS"') roadmap(?:'"'"'s)?\b|\broadmaps?(?:'"'"'s)?[ ]?§|\broadmaps?[ ]+[A-Z]{1,8}-\d'

RULE_COUNT=7

# ---------------------------------------------------------------------------
# THE `src/` DOC-COMMENT RULE SET, deliberately a SEPARATE ARRAY
# ---------------------------------------------------------------------------
#
# WHY A SECOND SURFACE EXISTS AT ALL. The block above scans markdown a reader browses. This
# one scans the JSDoc a consumer's EDITOR renders: `src/` doc comments are compiled into
# `dist/index.d.ts`, `dist/testing/index.d.ts` and `dist/ack-from-hl7/index.d.ts` (and each
# one's `.d.cts` twin) by tsup, `dist` is the first entry in package.json's `files`, and
# every `npm i @cosyte/mllp` receives them.
#
# IN THIS REPO IT IS THE FIRST SURFACE, NOT THE SECOND, BY AN ORDER OF MAGNITUDE. Measured on
# the base commit of the change that added this file, the `src/` doc-comment surface carried
# more than twenty times what the whole public markdown surface carried, because this
# package's roadmap vocabulary (`CLIENT-04`, `D-23`, `Plan 05`, `OBS-01`) is threaded through
# the doc comment of almost every exported option, event and error. Three repos running this
# item before this one found the same thing.
#
# WHY A SEPARATE ARRAY RATHER THAN REUSING RULE_PATTERN. Code comments are not markdown. The
# two surfaces have different collision profiles (TypeScript prose says `.slice()` and "the
# slice after the block header"; markdown says "the thirteenth slice"), different wrap shapes,
# and different self-test material. Sharing one array would mean a fix for one surface
# silently retunes the other, and the negative self-test that caught it would be in the wrong
# file's language. They START identical. They are ALLOWED to diverge, and when they do, each
# side's NEGATIVE sample is what stops the divergence from being a widening.
#
# WHAT IS SCANNED, precisely: only text inside `/** ... */` blocks. NOT `//` line comments and
# NOT `/* */` block comments, and that boundary is the whole point rather than a convenience.
# `/** */` is what the dts build carries into `dist`; `//` is not. The convention names source
# comments as a place identifiers BELONG. So the line this draws is exactly the founder's
# line: what a CONSUMER receives is public and is swept; what only a maintainer reads stays
# internal.
#
# REMOVING A DOC COMMENT TO SATISFY THIS PASS IS A REGRESSION, NOT A FIX. JSDoc with an
# `@example` on every public export is a hard guardrail in CLAUDE.md and the JSDoc lint rule
# is an error, but neither lint nor coverage notices prose deleted from the middle of a block.
# Rewrite the sentence to say what the software does.
SRC_RULE_NAME[0]="${RULE_NAME[0]}"; SRC_RULE_PATTERN[0]="${RULE_PATTERN[0]}"
SRC_RULE_NAME[1]="${RULE_NAME[1]}"; SRC_RULE_PATTERN[1]="${RULE_PATTERN[1]}"
SRC_RULE_NAME[2]="${RULE_NAME[2]}"; SRC_RULE_PATTERN[2]="${RULE_PATTERN[2]}"
SRC_RULE_NAME[3]="${RULE_NAME[3]}"; SRC_RULE_PATTERN[3]="${RULE_PATTERN[3]}"
SRC_RULE_NAME[4]="${RULE_NAME[4]}"; SRC_RULE_PATTERN[4]="${RULE_PATTERN[4]}"
SRC_RULE_NAME[5]="${RULE_NAME[5]}"; SRC_RULE_PATTERN[5]="${RULE_PATTERN[5]}"
SRC_RULE_NAME[6]="${RULE_NAME[6]}"; SRC_RULE_PATTERN[6]="${RULE_PATTERN[6]}"
SRC_RULE_COUNT=7

# ---------------------------------------------------------------------------
# THE `src/` STRING-LITERAL RULE SET: the fourth pass, and the one hl7 does not have
# ---------------------------------------------------------------------------
#
# WHY IT EXISTS. A library's most widely read text is not its README and not its JSDoc: it is
# its ERROR AND WARNING MESSAGES. In ncpdp, where this pass was invented, six runtime warning
# messages carried "this phase" into a consumer's log and the three passes above walked
# straight past every one of them.
#
# IT IS FIRST-CLASS HERE, NOT AN AFTERTHOUGHT, AND THE REASON IS THE SUBJECT MATTER. This
# package does not merely log: IT PUTS TEXT ON A WIRE PROTOCOL. `buildMllpAck` composes the
# MSA-3 text field of an HL7 ACK, and the typed errors (`MllpTimeoutError`,
# `MllpBackpressureError`, `MllpFramingError`) carry `message` strings that a consumer prints,
# shows in a UI, or pastes into a support ticket. An internal requirement identifier inside
# one of those does not just read badly in a log; it can be transmitted to a remote system.
#
# THE FALSE-POSITIVE RISK IS THE REASON TO MEASURE BEFORE ADDING, because a rule over code
# strings is the obvious place for one. In ncpdp all six rules over all 2,528 double-quoted
# and backtick literals matched ZERO times on the remediated tree. The rules are therefore
# reused whole rather than trimmed: a narrowed copy would have no measurement behind it.
#
# WHAT IS SCANNED, precisely: double-quoted and backtick literals on lines that are NOT
# whole-line comments. Four boundaries, each deliberate:
#   * WHOLE-LINE COMMENTS ARE SKIPPED (`//`, `/*`, `/**`, and a continuation ` *`). Pass
#     three owns doc comments, and `//` comments are deliberately out of scope for the whole
#     gate. Without this skip, a `//` comment containing a backticked symbol would be scanned
#     as a string and the stated boundary would quietly move.
#   * A TRAILING COMMENT ON A CODE LINE IS STILL SCANNED. Accepted rather than solved:
#     splitting a trailing comment off needs a tokenizer, and the failure mode is an
#     over-report on a line a maintainer can read in one second.
#   * SINGLE-QUOTED LITERALS ARE NOT SCANNED. Prettier (`@cosyte/prettier-config`) emits
#     double quotes, `format:check` runs ahead of this gate on the verify ladder, and tracked
#     `src/` contains no single-quoted string. Including `'` would instead capture comment
#     prose between two apostrophes, dragging `//` comments into scope through the back door.
#   * A MULTI-LINE TEMPLATE LITERAL IS SCANNED PER LINE, so a violation split across its line
#     breaks is missed. Under-reports rather than over-reports.
STR_RULE_NAME[0]="${RULE_NAME[0]}"; STR_RULE_PATTERN[0]="${RULE_PATTERN[0]}"
STR_RULE_NAME[1]="${RULE_NAME[1]}"; STR_RULE_PATTERN[1]="${RULE_PATTERN[1]}"
STR_RULE_NAME[2]="${RULE_NAME[2]}"; STR_RULE_PATTERN[2]="${RULE_PATTERN[2]}"
STR_RULE_NAME[3]="${RULE_NAME[3]}"; STR_RULE_PATTERN[3]="${RULE_PATTERN[3]}"
STR_RULE_NAME[4]="${RULE_NAME[4]}"; STR_RULE_PATTERN[4]="${RULE_PATTERN[4]}"
STR_RULE_NAME[5]="${RULE_NAME[5]}"; STR_RULE_PATTERN[5]="${RULE_PATTERN[5]}"
STR_RULE_NAME[6]="${RULE_NAME[6]}"; STR_RULE_PATTERN[6]="${RULE_PATTERN[6]}"
STR_RULE_COUNT=7

# ---------------------------------------------------------------------------
# SELF-TESTS. A gate is believed only after it has shown it can still see.
# ---------------------------------------------------------------------------
#
# Two halves, and the second is the one that is unusual. POSITIVE samples prove each rule
# still matches what it bans (the check-no-emdash property: refuse to report a clean tree from
# a scanner that cannot see). NEGATIVE samples prove each rule still lets through the
# reference material it was most likely to destroy, which is trap (1) turned into an
# assertion: if someone "simplifies" the identifier rule to a `WORD-N` shape, the negative
# self-test reds here instead of silently deleting `MSH-10` and `ITI-19` from an HL7 transport
# library's docs on the next sweep. Both halves run on every invocation, local and CI, and
# both refuse rather than warn.

self_test_fail() {
  echo "ERROR: check-no-internal-refs - SELF-TEST FAILED: $1" >&2
  echo "       The scanner is not behaving as specified, so no result from it can be" >&2
  echo "       believed. Refusing to report on the tree." >&2
  exit 1
}

# rule index -> text that MUST match. Every sample is written in THIS repo's own vocabulary,
# so a reader can tell what the rule is for without opening another package.
POSITIVE[0]='Item MLLP-9 is done, MLLP-BATCH is not, and CLIENT-04, SERVER-12, FRAME-11, LIFE-02, OBS-01, WARN-06, ERR-02, PLAN-06, SC-5, D-23, D-CR-01, W-07, B-05 and T-05-04-09 all track it'
POSITIVE[1]='Phase 5b closes it (Phase W, Phase-L and the thirteenth slice landed earlier, in wave 2); Plan 04 and plan 05 preceded it, Phases 6 and 7 before that, and it was reviewed phase-by-phase'
POSITIVE[2]='Decided in ADR 0015, restated in ADR-0021, and recorded in documentation/decisions/0001-x.md'
POSITIVE[3]='This slice adds the correlator and the final slice removes it'
POSITIVE[4]='Roadmap operations/roadmaps/mllp.md and documentation/decisions/0015-x.md'
POSITIVE[5]='Repeating [S-FRAME], and Open-question #12 resolves the direction'
POSITIVE[6]='See the mllp roadmap, our roadmap, roadmap §4 and ROADMAP SC-5'

# rule index -> text that must NOT match. Every entry is real reference material from an HL7
# v2, IHE, TLS or character-encoding context, real prose from this package's own docs, or
# ordinary English that collides with our jargon.
NEGATIVE[0]='MSH-10 and MSA-2 and MSH-1 and MSH-2 and MSH-7 and MSH-9 and MSH-15 and MSH-18 and MSA-1 and MSA-3 and PID-3 and BTS-1 and the range MSH-3..6, the HL7 error segment fields ERR-3 and ERR-4, IHE ITI-19 and ITI TF-2, UTF-8 and UTF-16 and UTF-32 and ISO-8859-1, the internal branch names FRAME-FATAL and ACCEPT-SAFE and FAIL-SAFE and POST-BIND and PRE-ENCODE and SINGLE-FLIGHT and OS-NORMALIZED, MLLP-framed bytes and HL7-defined tables and TLS-terminated sockets, legacy SNOMED RT D-13000 and T-32000 and M-80003, ICD-10-CM P00-P96, FHIR-bridge stability, docs-content/ layout, HL7-V2 and HL7-CDA, FHIR-R4, DICOM-SR, X12-837P and X12-005010, NCPDP-SCRIPT'
NEGATIVE[1]='A Phase III oncology trial and a Phase II study; the clinical phases of a drug programme; the acute phase reactant; the liquid phase; the sender stays in phase with the receiver and is out of phase; enhanced-mode two-phase sequencing, a three-phase handshake, single-phase commit, a dual-phase codec and a connect-phase socket error; a migration plan, the plan is to reconnect, and plans for TLS; the connection lifecycle phase where the error occurred, and all 5 phases are defined even though one is only exercised by the client'
NEGATIVE[2]='ADR is not a segment identifier, and 0015 alone is a value'
NEGATIVE[3]='The slice thickness and the number of slices are DICOM attributes, each slice location is too; buf.slice(0, 3) and payload.slice(start, end) are TypeScript'
NEGATIVE[4]='Transport operations are documented in the README, and documentation for the API is generated'
NEGATIVE[5]='A character range like [S-Z], a value set written [SNOMED], and open questions about the feed'
NEGATIVE[6]='A product roadmap, the vendor roadmap page, and a section simply headed Roadmap'

# THE BARE SECTION CITATION IS PINNED IN THE NEGATIVE DIRECTION, ACROSS EVERY RULE. This is
# residual (vii) turned into an assertion, and it is the most important negative test in the
# file for THIS repo. All 49 `§` occurrences on this tree are normative spec citations: the
# HL7 v2.5.1 clause that requires MSA-2 to echo MSH-10 verbatim (which is the correctness
# property this entire package is built around), the RFC 8446 clause behind the TLS 1.3
# client-certificate caveat, and the IHE ATNA cipher-suite mandate. A rule keyed on `§` would
# delete all of them, which is trap (1) arriving through punctuation. transform cleared 28
# bare `(§4.7)` by hand and deid 19, both declining to write the rule for the same reason.
# Reopening this must therefore be a DECISION, not a side effect of widening rule 5 or 7.
SECTION_CITATION_SAMPLE='HL7 v2.5.1 §2.9.2.2 requires MSA-2 to echo MSH-10 verbatim; RFC 8446 §4.4.2 covers the TLS 1.3 case; ITI TF-2 §3.19.6.2.3 mandates four cipher suites; an HL7 batch (§2.10.3) is out of scope'
i=0
while [ "$i" -lt "$RULE_COUNT" ]; do
  if printf '%s\n' "$SECTION_CITATION_SAMPLE" | grep -qP -e "${RULE_PATTERN[$i]}"; then
    hit=$(printf '%s\n' "$SECTION_CITATION_SAMPLE" | grep -oP -e "${RULE_PATTERN[$i]}" | head -1)
    self_test_fail "rule '${RULE_NAME[$i]}' now matches a NORMATIVE SPEC CITATION (matched: '${hit}'). Bare section citations are deliberately unruled in this repo: every one of the 49 on this tree is HL7 v2.5.1, RFC 8446 or IHE ITI TF-2, and they are the reference material a transport library's docs exist to provide. If you meant to close that hole, it needs a decision and a re-measurement, not a widened rule."
  fi
  i=$((i + 1))
done

# RULE 3'S `/` ARM GETS ITS OWN ASSERTION, separate from the array loop. The array sample
# carries BOTH the prose form ("ADR 0015") and the path form, so it still matches under the
# narrower hl7 pattern the widening replaced: it proves the rule works, it does NOT prove it
# still has the arm ncpdp added. A "resync with hl7" that reverts RULE_PATTERN[2] would leave
# the whole suite green and silently reopen the exact hole the widening exists to close --
# three live ADR citations that a refuter found after that gate had reported OK over them.
#
# THE SAMPLE IS THE `adr/NNNN` PATH FORM, which is what the `/` separator actually buys. This
# repo has no `docs/adr/` directory of its own, so the reachable citation here is a sibling's
# or the meta-repo's; the meta-repo's own `documentation/decisions/NNNN-*.md` form is caught by
# RULE 5 instead, and both are asserted, each on the rule that owns it. Written down because
# the first draft of this file asserted the meta-repo form against rule 3, and the self-test
# refused the run rather than let a mis-aimed assertion pass as coverage.
ADR_PATH_SAMPLE='Ratified in docs/adr/0004-submodules.md'
if ! printf '%s\n' "$ADR_PATH_SAMPLE" | grep -qP -e "${RULE_PATTERN[2]}"; then
  self_test_fail "rule 'ADR reference' no longer matches an ADR cited as a PATH, which is the form a space-or-hyphen rule misses. Three live citations survived a whole gate in ncpdp because of that gap. Do not drop '/' from the separator class."
fi

# RULE 7 GETS A STANDALONE EXISTENCE ASSERTION, asserted BY COUNT rather than by pattern,
# because the count is what a resync changes. The array loops run `while i < RULE_COUNT`, so a
# "resync with hl7" or "resync with ncpdp" that restores `RULE_COUNT=6` DELETES THIS RULE WITH
# EVERY OTHER SELF-TEST STILL GREEN: samples 0 through 5 all still pass and nothing reds.
if [ "$RULE_COUNT" -lt 7 ] || [ -z "${RULE_PATTERN[6]:-}" ]; then
  self_test_fail "rule 7 ('internal roadmap citation', RULE_PATTERN index 6) is missing or RULE_COUNT was lowered below 7. Only 'cli' among the siblings carries it, where it found 30 of 61 violations that rules 1 through 6 could not see. If a resync with hl7 or ncpdp dropped it, restore it rather than accepting the lower count."
fi
if [ "$SRC_RULE_COUNT" -lt 7 ] || [ "$STR_RULE_COUNT" -lt 7 ]; then
  self_test_fail "the src doc-comment or string-literal rule set no longer carries all 7 rules. The doc-comment surface is where the overwhelming majority of this repo's violations lived, so a short rule set there is the gate silently covering less than it reports."
fi

# THE REPO-LOCAL VOCABULARY GETS ITS OWN EXISTENCE ASSERTION, for the same reason rule 7 does
# and with more at stake. `MLLP_LOCAL_IDENT` is the arm no sibling has, it is where the
# overwhelming majority of this repo's violations lived, and a "resync" that restores the
# sibling RULE_PATTERN[0] verbatim would drop every `CLIENT-`, `D-`, `PLAN-` and `T-` hit while
# POSITIVE[0]'s `MLLP-9` keeps the sample green. Asserted on a sample containing ONLY the
# local forms, so nothing else in the rule can satisfy it.
LOCAL_ONLY_SAMPLE='CLIENT-04 SERVER-12 FRAME-11 LIFE-02 OBS-01 WARN-06 ERR-02 PLAN-06 SC-5 D-23 D-CR-01 W-07 B-05 T-05-04-09'
for token in CLIENT-04 SERVER-12 FRAME-11 LIFE-02 OBS-01 WARN-06 ERR-02 PLAN-06 SC-5 D-23 D-CR-01 W-07 B-05 T-05-04-09; do
  if ! printf '%s\n' "$token" | grep -qP -e "${RULE_PATTERN[0]}"; then
    self_test_fail "the repo-local identifier arm no longer matches '${token}'. That vocabulary (PLAN/CLIENT/SERVER/FRAME/LIFE/OBS/WARN/ERR/SC and the single-letter D/W/B/T decisions) is this repo's dominant class and exists in NO sibling copy, so a resync with hl7 or ncpdp deletes it with every other sample still green. Restore MLLP_LOCAL_IDENT rather than accepting the smaller rule."
  fi
done
if [ -z "$LOCAL_ONLY_SAMPLE" ]; then self_test_fail "local sample empty"; fi

i=0
while [ "$i" -lt "$RULE_COUNT" ]; do
  if ! printf '%s\n' "${POSITIVE[$i]}" | grep -qP -e "${RULE_PATTERN[$i]}"; then
    self_test_fail "rule '${RULE_NAME[$i]}' no longer matches its own positive sample."
  fi
  if printf '%s\n' "${NEGATIVE[$i]}" | grep -qP -e "${RULE_PATTERN[$i]}"; then
    hit=$(printf '%s\n' "${NEGATIVE[$i]}" | grep -oP -e "${RULE_PATTERN[$i]}" | head -1)
    self_test_fail "rule '${RULE_NAME[$i]}' now matches legitimate reference material (matched: '${hit}'). This is the WORD-N trap: in an HL7-over-MLLP package it destroys the segment-field references (MSH-10, MSA-2, ERR-3), the IHE designations (ITI-19, TF-2) and the encoding names (UTF-8, ISO-8859-1) the docs exist to provide."
  fi
  i=$((i + 1))
done

# The `src/` set gets its OWN self-tests, in the language of the surface it guards. The
# NEGATIVE samples are built from material actually present in this package's source: HL7
# field references in doc comments, the internal branch names that are English compounds
# rather than identifiers, and TypeScript that reads like our jargon (`buf.slice(0, 3)`).
SRC_POSITIVE[0]='Item MLLP-10 is done, and CLIENT-04, SERVER-12, FRAME-11, OBS-01, ERR-02, D-23, W-07, B-05 and T-05-04-09 track it'
SRC_POSITIVE[1]='Phase 5b closes it (Phase W and the thirteenth slice landed earlier, in wave 2); Plan 04 and plan 05 preceded it'
SRC_POSITIVE[2]='Decided in ADR 0015, restated in ADR-0021, and recorded in documentation/decisions/0001-x.md'
SRC_POSITIVE[3]='This slice adds the correlator and the final slice removes it'
SRC_POSITIVE[4]='Roadmap operations/roadmaps/mllp.md and documentation/decisions/0015-x.md'
SRC_POSITIVE[5]='Repeating [S-FRAME], and Open-question #12 resolves the direction'
SRC_POSITIVE[6]='See the mllp roadmap, our roadmap, roadmap §4 and ROADMAP SC-5'

SRC_NEGATIVE[0]='MSH-10 and MSA-2 and MSH-1 and MSH-9 and MSH-15 and MSH-18 and MSA-1 and MSA-3 and PID-3 and BTS-1 and MSH-3..6, the HL7 error segment fields ERR-3 and ERR-4, ITI-19 and TF-2, UTF-8 and UTF-16 and ISO-8859-1, the internal branch names FRAME-FATAL and ACCEPT-SAFE and FAIL-SAFE and POST-BIND and PRE-ENCODE and SINGLE-FLIGHT and OS-NORMALIZED, MLLP-framed bytes, HL7-defined tables, SNOMED RT D-13000 and T-32000, FHIR-bridge stability, HL7-V2, FHIR-R4, DICOM-SR, X12-837P'
SRC_NEGATIVE[1]='A Phase III oncology trial; the acute phase reactant; the sender stays in phase with the receiver and is out of phase; enhanced-mode two-phase sequencing, a three-phase handshake and a connect-phase socket error; a migration plan and the plan is to reconnect; the connection lifecycle phase where the error occurred, and all 5 phases are defined'
SRC_NEGATIVE[2]='ADR is not a segment identifier, and 0015 alone is a value'
SRC_NEGATIVE[3]='The slice thickness and the number of slices are DICOM attributes; buf.slice(0, 3) and payload.slice(start, end) are TypeScript'
SRC_NEGATIVE[4]='Transport operations are documented in the README, and documentation for the API is generated'
SRC_NEGATIVE[5]='A character range like [S-Z], a value set written [SNOMED], and open questions about the feed'
SRC_NEGATIVE[6]='A product roadmap, the vendor roadmap page, and a section simply headed Roadmap'

# The STRING-LITERAL set gets its own samples too, in the language of an error message or an
# ACK text field. The NEGATIVE ones are real strings from this package's source: the warning
# codes (underscored, so rule 1's hyphen requirement never fires), event names, import
# specifiers, and the HL7 field references its ACK-verification messages quote, so a widening
# that starts flagging correct wire text reds here instead of on the next pull request.
STR_POSITIVE[0]='MLLP-9 shipped this reader, tracked as CLIENT-04 and D-23'
STR_POSITIVE[1]='Added in Phase 9, reworked in phase 10b, and planned as Plan 05'
STR_POSITIVE[2]='Behaviour fixed by ADR 0001, recorded in documentation/decisions/0001-x.md'
STR_POSITIVE[3]='Added by the final slice of the reader'
STR_POSITIVE[4]='See operations/roadmaps/mllp.md'
STR_POSITIVE[5]='Traced as [S-FRAME]'
STR_POSITIVE[6]='See the mllp roadmap and ROADMAP SC-5'

STR_NEGATIVE[0]='MLLP_LEADING_WHITESPACE and MLLP_TRAILING_BYTES and MLLP_MAX_FRAME_EXCEEDED, ./decoder.js and ../internal/control-id.js, ACK does not echo the inbound MSH-10 verbatim, MSA-2 must carry MSH-10, the ERR-3 code and ERR-4 severity, MSH-9 message type, UTF-8 and ISO-8859-1 codecs, the connect and stateChange events'
STR_NEGATIVE[1]='No ACK arrived within the configured timeout; the sender stays in phase with the receiver. A Phase III trial and the acute phase reactant are out of scope, and the migration plan is unrelated.'
STR_NEGATIVE[2]='ADR is not a segment identifier, and 0001 alone is a value'
STR_NEGATIVE[3]='The frame carries 3 concatenated messages; only the first is decoded. The slice thickness and the number of slices are DICOM attributes.'
STR_NEGATIVE[4]='Transport operations are documented in the README, and documentation for the API is generated'
STR_NEGATIVE[5]='A character range like [S-Z], a value set written [SNOMED], and open questions about the feed'
STR_NEGATIVE[6]='A product roadmap and the vendor roadmap page'

i=0
while [ "$i" -lt "$STR_RULE_COUNT" ]; do
  if ! printf '%s\n' "${STR_POSITIVE[$i]}" | grep -qP -e "${STR_RULE_PATTERN[$i]}"; then
    self_test_fail "string-literal rule '${STR_RULE_NAME[$i]}' no longer matches its own positive sample."
  fi
  if printf '%s\n' "${STR_NEGATIVE[$i]}" | grep -qP -e "${STR_RULE_PATTERN[$i]}"; then
    hit=$(printf '%s\n' "${STR_NEGATIVE[$i]}" | grep -oP -e "${STR_RULE_PATTERN[$i]}" | head -1)
    self_test_fail "string-literal rule '${STR_RULE_NAME[$i]}' now matches a legitimate runtime string (matched: '${hit}'). This package puts text on a WIRE PROTOCOL: an ACK's MSA-3 text and every typed error message must survive this gate. Only our bookkeeping must not."
  fi
  i=$((i + 1))
done

i=0
while [ "$i" -lt "$SRC_RULE_COUNT" ]; do
  if ! printf '%s\n' "${SRC_POSITIVE[$i]}" | grep -qP -e "${SRC_RULE_PATTERN[$i]}"; then
    self_test_fail "src rule '${SRC_RULE_NAME[$i]}' no longer matches its own positive sample."
  fi
  if printf '%s\n' "${SRC_NEGATIVE[$i]}" | grep -qP -e "${SRC_RULE_PATTERN[$i]}"; then
    hit=$(printf '%s\n' "${SRC_NEGATIVE[$i]}" | grep -oP -e "${SRC_RULE_PATTERN[$i]}" | head -1)
    self_test_fail "src rule '${SRC_RULE_NAME[$i]}' now matches legitimate reference material (matched: '${hit}'). This is the WORD-N trap arriving through the source-comment surface: it destroys the HL7 segment-field references an MLLP library's IntelliSense exists to provide."
  fi
  i=$((i + 1))
done

# ---------------------------------------------------------------------------
# THE SCANNER-BLINDNESS SELF-TEST: prove `grep` will not silently skip a FILE
# ---------------------------------------------------------------------------
#
# THE SELF-TESTS ABOVE PROVE THE PATTERNS MATCH. THEY DO NOT PROVE THE SCANNER OPENS ITS
# INPUT, and those are different failures. Every sample above is fed on STDIN, so a `grep`
# that silently skips FILES passes all of them and then reports OK over a dirty tree.
#
# THIS IS NOT HYPOTHETICAL AND IT IS NOT ABOUT A HYPOTHETICAL MACHINE. The container this
# gate was written in ships a shell FUNCTION named `grep` that execs `ugrep` with
# `-I --ignore-files --hidden --exclude-dir=.git` forced on. Both forced flags are fatal to a
# gate like this one:
#   * `-I` skips any file the tool judges binary, AT EXIT 1, WITH NOTHING ON STDERR. That
#     defeats refuse_if_incomplete below, whose whole design assumes an unread file announces
#     itself on stderr (GNU grep >= 3.5 prints "binary file matches"). Measured on this box:
#     GNU grep 3.8 over a NUL-bearing file with a seeded hit exits 0 and writes
#     "binary file matches" to stderr; the shim exits 1 and writes nothing at all.
#   * `--ignore-files` honours `.gitignore`. `dist/` is gitignored in every repo in this
#     ecosystem, so a RECURSIVE sweep of the built declarations through that tool reports
#     zero over a surface it never opened. Verified on this tree: `grep -rc` over `dist`
#     returns 0 for files GNU grep scores 22.
#
# MEASURED, so the risk is scoped rather than guessed: the function is NOT exported, so
# `bash scripts/check-no-internal-refs.sh` and `pnpm check:no-internal-refs` both get
# /usr/bin/grep, and this gate's numbers were taken with GNU grep 3.8 and re-taken with the
# binary explicitly pinned, identical both ways. So this test defends a hole that is currently
# CLOSED. It is here because "currently closed" is exactly what was said about the four
# silent-green routes that later shipped defects, and because one `export -f grep`, one CI
# image change, or one `grep` earlier on PATH reopens it with no error and no warning.
#
# WHY A BEHAVIOURAL PROBE RATHER THAN PINNING /usr/bin/grep: pinning an absolute path is not
# portable (BSD/macOS put GNU grep elsewhere, and some CI images have no /usr/bin/grep at
# all) and it would still not notice a PINNED binary that behaves wrongly. This asserts the
# PROPERTY the gate depends on instead: over a file the scanner cannot read as text, a hit
# must produce EITHER a match on stdout OR a diagnostic on stderr. Silence is the one answer
# that makes every other refusal in this file unreliable.
BLINDPROBE=$(mktemp)
BLINDERR=$(mktemp)
printf 'seeded MLLP-9 violation\n\000\nsecond line\n' > "$BLINDPROBE"
probe_hit=$(grep -H -nP -e "${RULE_PATTERN[0]}" -- "$BLINDPROBE" 2>"$BLINDERR" || true)
if [ -z "$probe_hit" ] && [ ! -s "$BLINDERR" ]; then
  rm -f "$BLINDPROBE" "$BLINDERR"
  self_test_fail "the 'grep' on PATH SILENTLY SKIPPED a file containing a seeded violation: no match on stdout and no diagnostic on stderr. That is the -I / --ignore-files behaviour of ugrep (and of any grep wrapper that forces -I), and under it this gate reports OK over files it never opened, because refuse_if_incomplete can only refuse what announces itself on stderr. Run the gate with GNU grep (\`pnpm check:no-internal-refs\` from a non-interactive shell already does; an exported shell function named 'grep' is the usual cause when it does not)."
fi
rm -f "$BLINDPROBE" "$BLINDERR"

# ---------------------------------------------------------------------------
# Refusals. Anything the scanner writes to stderr means it did not read everything it was
# given, and an incomplete scan must never print OK. Exit status cannot carry that signal:
# grep exits 1 on "no match", which xargs reports as 123, so "clean" and "died part way
# through the batch" are indistinguishable by code. A match inside input grep classifies as
# binary also arrives on stderr with empty stdout.
# ---------------------------------------------------------------------------
ERRLOG=$(mktemp)
FILELIST=$(mktemp)
SCANLIST=$(mktemp)
NPMBUF=$(mktemp)
REFLOWBUF=$(mktemp)
RAWBUF=$(mktemp)
SRCLIST=$(mktemp)
SRCSCAN=$(mktemp)
DOCLINES=$(mktemp)
DOCMAP=$(mktemp)
DOCFLOW=$(mktemp)
DOCFLOWMAP=$(mktemp)
STRLINES=$(mktemp)
STRMAP=$(mktemp)
trap 'rm -f "$ERRLOG" "$FILELIST" "$SCANLIST" "$NPMBUF" "$REFLOWBUF" "$RAWBUF" \
      "$SRCLIST" "$SRCSCAN" "$DOCLINES" "$DOCMAP" "$DOCFLOW" "$DOCFLOWMAP" \
      "$STRLINES" "$STRMAP"' EXIT

refuse_if_incomplete() {
  [ -s "$ERRLOG" ] || return 0
  cat "$ERRLOG" >&2
  echo "" >&2
  # GNU grep >= 3.5 prints "grep: FILE: binary file matches" on STDERR with nothing on
  # stdout, so a match in input it cannot read as text arrives here rather than in the hit
  # list. Name that case, or the run reds blaming an I/O failure that never happened and
  # sends a reader hunting it. This branch only chooses the wording; every path exits 1.
  if grep -qi 'binary file' "$ERRLOG"; then
    echo "ERROR: check-no-internal-refs - the input named above MATCHED a banned pattern," >&2
    echo "       but grep classifies it as binary, so the hit has no line number. Treat it" >&2
    echo "       as a real violation, and repair the file's encoding (it should be UTF-8)." >&2
  fi
  if grep -qiv 'binary file' "$ERRLOG"; then
    echo "ERROR: check-no-internal-refs - the scan reported errors, so it did not read all" >&2
    echo "       of its input. Refusing to report green from an incomplete scan." >&2
  fi
  exit 1
}

fail_with_hits() {
  local what="$1" hits="$2"
  echo "$hits" >&2
  echo "" >&2
  echo "ERROR: check-no-internal-refs - internal project bookkeeping found in ${what}." >&2
  echo "       A consumer reads this surface. Item identifiers, phase, plan and wave" >&2
  echo "       language, ADR numbers and meta-repo paths belong in the changeset," >&2
  echo "       CHANGELOG.md, the commit, the PR and the roadmap. Translate at the boundary:" >&2
  echo "       say what the software does and what changed." >&2
  echo "       When you strip an identifier off the FRONT of a line, repair the head too:" >&2
  echo "       drop a leading orphan parenthetical, strip leading punctuation, recapitalise." >&2
  echo "       Leaving the fragment behind is worse than the text it replaced." >&2
  echo "       And CUT THE CLAIM, NOT THE QUALIFIER THAT BOUNDS IT: deleting a pointer can" >&2
  echo "       upgrade a bounded statement into a guarantee the code does not provide." >&2
  echo "       Rule: documentation/conventions.md, 'No internal project bookkeeping on a" >&2
  echo "       public surface'." >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Build the scan list
# ---------------------------------------------------------------------------
#
# `git ls-files` is relative to the working directory, so from a subdirectory it lists a
# subtree and the scan would report OK having skipped the rest of the surface. Anchor at the
# top level.
cd "$(git rev-parse --show-toplevel)"

# The public surface, as paths. Each is justified in the SCAN SURFACE note at the top.
SURFACE_PATHS=(README.md TRADEMARKS.md LICENSE docs-content)

# Every named surface path must still be tracked. Without this, renaming or deleting
# README.md makes the gate scan less and still print OK, which is the same silent-green
# failure the routes below close, arriving through the file list instead of through grep.
for p in "${SURFACE_PATHS[@]}"; do
  if [ -z "$(git ls-files -- "$p")" ]; then
    echo "ERROR: check-no-internal-refs - the public surface path '$p' is not tracked." >&2
    echo "       Either it was renamed or removed (update SURFACE_PATHS in this script," >&2
    echo "       deliberately), or the scan is about to cover less than it claims." >&2
    echo "       Refusing to report green from a shrunken surface." >&2
    exit 1
  fi
done

# DRIFT TRIPWIRE on the npm tarball. `files` in package.json decides what a consumer actually
# receives, so anything added there is new public surface this gate would not know about.
# Rather than let that pass silently, refuse until someone puts it in SURFACE_PATHS or names
# it below as deliberately excluded.
#
# EVERY entry is checked, not just the prose-looking ones. Filtering `files` down to
# `*.md`/`LICENSE` first would discard `dist` before checking, and so structurally could not
# see the tarball's largest prose payload: the compiled JSDoc in the three entry points'
# declaration files. A tripwire that cannot see the thing it was built to catch is not a
# tripwire. The two standing exclusions are named with their reasons in SCAN SURFACE above:
# `CHANGELOG.md` (contested, queued) and `dist` (untracked build output this script cannot
# read; its SOURCE is gated by the third and fourth passes instead).
command -v node >/dev/null || {
  echo "ERROR: check-no-internal-refs - node is required (to read package.json) and is not" >&2
  echo "       on PATH. Refusing to skip the npm-surface half of this gate." >&2
  exit 1
}
UNKNOWN_TARBALL_DOCS=$(node -e '
  const pkg = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
  // Scanned by this gate:            README.md, TRADEMARKS.md, LICENSE
  // Excluded deliberately, reasons in SCAN SURFACE: CHANGELOG.md, dist
  const known = new Set(["README.md", "TRADEMARKS.md", "LICENSE", "CHANGELOG.md", "dist"]);
  process.stdout.write((pkg.files ?? []).filter((f) => !known.has(f)).join(" "));
')
if [ -n "$UNKNOWN_TARBALL_DOCS" ]; then
  echo "ERROR: check-no-internal-refs - package.json 'files' ships something this gate does" >&2
  echo "       not cover: $UNKNOWN_TARBALL_DOCS" >&2
  echo "       That is public surface a consumer receives in the tarball. Add it to" >&2
  echo "       SURFACE_PATHS, or record it as a deliberate exclusion in this script." >&2
  exit 1
fi

git ls-files -z -- "${SURFACE_PATHS[@]}" > "$FILELIST"

if [ ! -s "$FILELIST" ]; then
  echo "ERROR: check-no-internal-refs - no tracked public-surface files to scan. Refusing" >&2
  echo "       to report green from a scan that read nothing." >&2
  exit 1
fi

# THE SILENT-GREEN ROUTES, all closed here. This list is NOT a claim of exhaustiveness:
# route (9) was found by a refuter against an hl7 copy whose own comment implied it was
# already complete.
#
#   (1) THE SCANNER CANNOT SEE. Closed by the locale pin and the positive self-tests above,
#       plus the negative self-tests, which are stronger than the em-dash gate's single
#       sample: they also catch a rule widened into the trap (1) shape.
#   (2) AN EMPTY FILE LIST. `xargs` without `-r` runs grep anyway, and grep with no file
#       operand reads STDIN, finds nothing, and exits 0. Closed by `-r` AND by refusing an
#       empty list outright, above and again after the loop.
#   (3) `git ls-files` FAILS (unreadable or corrupt index) AND ITS STATUS IS ERASED. The list
#       is built as its OWN command, not as the head of the pipeline: piped, its status is
#       swallowed by the `|| true` the no-match case needs, and the scan reports OK over an
#       empty list.
#   (4) A PATH THE SCANNER NEVER RECEIVES. `git ls-files` C-quotes any path holding a space,
#       a quote or a non-ASCII byte, so unseparated, grep is handed a name no file has.
#       Closed by `-z` here and `-0` on xargs.
#   (5) A FILENAME PARSED AS AN OPTION. A tracked file named `-q` would silence the whole
#       batch and the gate would print OK. Closed by `-e` before the pattern and `--` after.
#   (6) A FILENAME READ AS STANDARD INPUT, which `--` does NOT close. `--` stops `-` being
#       parsed as an OPTION; grep then reads the bare operand `-` as STDIN, and xargs points
#       its child's stdin at /dev/null, so a tracked file literally named `-` (a `cmd > -`
#       typo, which `git add -A` stages without complaint) is NEVER OPENED and the gate
#       prints OK and exits 0 over a live violation. Closed by `./`-prefixing every path AS
#       THE LIST IS BUILT, in the loop below rather than through `sed -z`, so the scan stays
#       a single command with the stderr capture bound to all of it and there is no GNU-only
#       stage that has no self-test of its own. This is the shape this repo's own
#       check-no-emdash.sh uses and it is the preferred one in this ecosystem.
#       BE PRECISE ABOUT REACHABILITY: grep treats only a BARE `-` operand as stdin, and
#       every path this gate scans is emitted by `git ls-files` under a listed surface path.
#       None of those is the repo root today, so the worst a file named `-` can produce is
#       `docs-content/-`, which grep opens normally. The route becomes live the moment
#       SURFACE_PATHS gains a root-level glob or `.`. The prefix is therefore kept as the
#       thing that makes widening the surface safe, not as decoration.
#   (7) AN UNREAD ENTRY THAT IS NOT A MISSED MATCH. `-d skip` silently skips a tracked
#       symlink to a directory: no stderr, so nothing refuses, and the gate goes green having
#       never opened it. `-d skip` is NOT used. The loop refuses a tracked entry that is not
#       a regular file BY NAME instead, which is louder. The `! -L` guard matters: `-d`
#       follows symlinks, so a symlink to a directory tests true and would be skipped as if
#       it were a gitlink.
#   (8) A SCAN THAT DIED PART WAY THROUGH AND REPORTED CLEAN. grep's exit status cannot
#       distinguish that from no-match. Closed by capturing stderr and refusing on any of it.
#   (9) A VIOLATION THAT STRADDLES A LINE WRAP. Not inherited from the em-dash family at all:
#       that gate matches a single character, so line anchoring costs it nothing. Every rule
#       here except the bare identifier is multi-token, and this repo hard-wraps its markdown,
#       so a phase sentence broken across two lines reads perfectly on the rendered page and
#       is invisible to a line scan. Closed by the paragraph-joined second pass below.
#  (10) A `grep` THAT SILENTLY SKIPS A FILE. Distinct from every route above: those are about
#       what the scan is HANDED, this is about what the scanner CHOOSES TO OPEN. A `grep`
#       with `-I` forced (ugrep, or any wrapper) drops a file it judges binary at exit 1 with
#       NOTHING on stderr, so refuse_if_incomplete never fires; with `--ignore-files` it also
#       honours `.gitignore`. Closed by the behavioural probe in THE SCANNER-BLINDNESS
#       SELF-TEST below, which is asserted in both directions (green under GNU grep 3.8, red
#       under a grep that forces `-I`). This is the FOURTH mechanism by which gates of this
#       family have reported OK over live violations, after routes (6), (8) and the NUL
#       suppression named just below.
#
# Also, and not a route so much as a standing choice: NO `-I`. `-I` skips anything grep's
# heuristic calls binary, which includes a genuine TEXT file with a broken encoding, so a
# violation inside one would be skipped in silence. This gate's surface is markdown, JSON and
# TypeScript with no binaries (CHECKED ON THIS TREE: no tracked file under any scanned path
# holds a NUL byte; the repo's one vendored tarball lives under `vendor/`, which this gate
# does not scan), so losing `-I` makes a future binary a loud red instead of a silent miss.
# Fail closed, not open. `-H` is set so every hit carries its filename: grep omits the name
# when handed exactly one file, which an xargs batch boundary can produce.
: > "$SCANLIST"
gitlinks=0
scanned=0
while IFS= read -r -d '' f; do
  if [ -d "$f" ] && [ ! -L "$f" ]; then
    gitlinks=$((gitlinks + 1))
    continue
  fi
  if [ ! -r "$f" ]; then
    echo "ERROR: check-no-internal-refs - tracked file is not readable: $f" >&2
    echo "       Refusing to report green from a scan that could not open its input." >&2
    exit 1
  fi
  if [ ! -f "$f" ]; then
    echo "ERROR: check-no-internal-refs - tracked entry is not a regular file: $f" >&2
    echo "       Refusing to report green from a scan that skipped one of its inputs." >&2
    exit 1
  fi
  printf './%s\0' "$f" >> "$SCANLIST"
  scanned=$((scanned + 1))
done < "$FILELIST"

if [ ! -s "$SCANLIST" ]; then
  echo "ERROR: check-no-internal-refs - no public-surface files survived list building." >&2
  echo "       Refusing to report green from a scan that read nothing." >&2
  exit 1
fi

# The npm metadata is public surface that is not a file of its own. Extract the two fields
# the convention names and scan them as text. Written with a real newline between fields so a
# hit reports a usable line number.
node -e '
  const pkg = JSON.parse(require("fs").readFileSync("package.json", "utf8"));
  const lines = ["description: " + (pkg.description ?? ""), "keywords: " + (pkg.keywords ?? []).join(", ")];
  process.stdout.write(lines.join("\n") + "\n");
' > "$NPMBUF"
if [ ! -s "$NPMBUF" ]; then
  echo "ERROR: check-no-internal-refs - could not read the npm metadata from package.json." >&2
  echo "       Refusing to report green from a scan that read nothing." >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Scan, one rule at a time so a hit can name the rule it broke
# ---------------------------------------------------------------------------
#
# Each rule is its own single command with its own stderr capture, rather than one merged
# pattern: a merged pattern cannot report WHICH rule fired, and "phase language" and
# "internal identifier" want different remediation advice. The cost is N passes over a
# handful of files, which is nothing.
ALL_HITS=""
i=0
while [ "$i" -lt "$RULE_COUNT" ]; do
  : > "$ERRLOG"
  HITS=$(xargs -0 -r grep -H -nP -e "${RULE_PATTERN[$i]}" -- < "$SCANLIST" 2>>"$ERRLOG" || true)
  refuse_if_incomplete

  : > "$ERRLOG"
  NPM_HITS=$(grep -H -nP -e "${RULE_PATTERN[$i]}" -- "$NPMBUF" 2>>"$ERRLOG" || true)
  refuse_if_incomplete
  # Report the npm metadata under a name a reader can act on, not a temp path.
  [ -n "$NPM_HITS" ] && NPM_HITS=$(printf '%s\n' "$NPM_HITS" | sed "s|^${NPMBUF}|package.json (npm metadata)|")

  for block in "$HITS" "$NPM_HITS"; do
    [ -n "$block" ] || continue
    ALL_HITS="${ALL_HITS}[${RULE_NAME[$i]}]"$'\n'"${block}"$'\n'
  done
  i=$((i + 1))
done

# ---------------------------------------------------------------------------
# Second pass: the same rules over PARAGRAPH-JOINED text
# ---------------------------------------------------------------------------
#
# WHY THIS EXISTS. Every rule above except the bare identifier is MULTI-TOKEN (`phase X`,
# `plan N`, `wave N`, `this slice`, `mllp roadmap`), grep matches within a line, and this repo
# hard-wraps its markdown by house style. So a violation that straddles a wrap is invisible to
# the line scan, while a reader of the rendered page sees it plainly, because markdown folds a
# soft line break into a space. In the hl7 copy this was not hypothetical: a spec-notes page
# read "... A future phase" / "may add opt-in decode ...", and the gate printed OK over it.
#
# So the file is joined the way markdown renders it (consecutive non-blank lines in a
# paragraph become one line, blank lines stay blank) and scanned again. Line numbers are lost
# by construction, so this pass reports the FILE and the MATCHED TEXT, and it reports only
# matches the line pass did not already produce, which keeps a wrapped hit from being printed
# twice in the same run.
while IFS= read -r -d '' f; do
  # WHITESPACE IS SQUEEZED, and that is the whole difference between this pass working and
  # this pass looking as though it works. Joining lines verbatim leaves the continuation
  # line's own indentation in the joined text: an indented wrap produces `phase   may`, and
  # every rule here is written with single spaces, so it does not match. Indented
  # continuations are the DOMINANT wrap shape in this corpus, because the pages are mostly
  # bulleted, so the pass would miss the very case it was added for while reporting that it
  # had run. Squeezing runs of whitespace to one space is also what markdown itself does to a
  # paragraph, so this models the rendered page rather than approximating it.
  : > "$ERRLOG"
  awk '
    /^[[:space:]]*$/ { print ""; next }
    { line = $0; gsub(/[[:space:]]+/, " ", line); sub(/^ /, "", line); printf "%s ", line }
    END { print "" }
  ' "$f" > "$REFLOWBUF" 2>>"$ERRLOG"
  refuse_if_incomplete

  i=0
  while [ "$i" -lt "$RULE_COUNT" ]; do
    : > "$ERRLOG"
    grep -oP -e "${RULE_PATTERN[$i]}" -- "$f" > "$RAWBUF" 2>>"$ERRLOG" || true
    refuse_if_incomplete

    : > "$ERRLOG"
    FLOW_HITS=$(grep -oP -e "${RULE_PATTERN[$i]}" -- "$REFLOWBUF" 2>>"$ERRLOG" || true)
    refuse_if_incomplete

    if [ -n "$FLOW_HITS" ]; then
      # Only what the line pass could not see. An empty RAWBUF means no line-pass match, and
      # `grep -f` with no patterns selects nothing, so -v then keeps every wrapped hit.
      EXTRA=$(printf '%s\n' "$FLOW_HITS" | grep -Fxv -f "$RAWBUF" | sort -u || true)
      if [ -n "$EXTRA" ]; then
        while IFS= read -r m; do
          [ -n "$m" ] || continue
          ALL_HITS="${ALL_HITS}[${RULE_NAME[$i]} / wrapped across lines]"$'\n'"${f}: ${m}"$'\n'
        done <<< "$EXTRA"
      fi
    fi
    i=$((i + 1))
  done
done < "$SCANLIST"

# ---------------------------------------------------------------------------
# THIRD PASS: `src/` DOC COMMENTS, the prose that compiles into `dist/`
# ---------------------------------------------------------------------------
#
# THE CEILING, STATED FIRST, because it is the honest frame for everything below. `dist/` is
# UNTRACKED BUILD OUTPUT. No checked-in gate can scan it without building first, and this
# script deliberately does not build. So the thing a consumer actually receives is NOT what is
# checked here. What is checked is its SOURCE: the `/** */` blocks the dts build copies
# verbatim. That is a PROXY, and it is a good one only because the copy is verbatim -- tsup
# rewrites declarations, not doc text. A rewrite of the build that started transforming
# comments would silently decouple the two, and nothing here would notice. This pass therefore
# raises the floor on `dist/`; it does not observe `dist/`.
#
# Two consequences worth naming rather than discovering:
#   * A doc comment that never reaches an exported declaration is swept anyway. That is
#     deliberate: which comments survive the dts rollup is a property of the BUILD, not of the
#     source, and gating on it would make the gate's answer depend on tsup's inlining
#     decisions. It matters here: this package has THREE entry points (`.`, `./testing`,
#     `./ack-from-hl7`), each with a `.d.ts` and a `.d.cts`, so "does it reach a declaration
#     file" is six questions, not one.
#   * `dist/*.d.cts` is the same text as `dist/*.d.ts`, so one clean source covers both
#     conditions.

# The `src/` surface must still be tracked, for the same reason SURFACE_PATHS is checked: a
# rename that empties this list must red, not shrink the scan in silence.
git ls-files -z -- 'src/*.ts' 'src/**/*.ts' > "$SRCLIST"
if [ ! -s "$SRCLIST" ]; then
  echo "ERROR: check-no-internal-refs - no tracked src/*.ts files to scan for doc" >&2
  echo "       comments. Either the source moved (update this pass, deliberately) or the" >&2
  echo "       scan is about to cover less than it claims. Refusing to report green." >&2
  exit 1
fi

# Same list-building discipline as the public-surface pass: `./`-prefixed as the list is built
# (route 6), a non-regular-file entry refused by name rather than skipped (route 7), an
# unreadable entry refused (not silently missed).
: > "$SRCSCAN"
src_scanned=0
while IFS= read -r -d '' f; do
  if [ -d "$f" ] && [ ! -L "$f" ]; then continue; fi
  if [ ! -r "$f" ]; then
    echo "ERROR: check-no-internal-refs - tracked source file is not readable: $f" >&2
    echo "       Refusing to report green from a scan that could not open its input." >&2
    exit 1
  fi
  if [ ! -f "$f" ]; then
    echo "ERROR: check-no-internal-refs - tracked source entry is not a regular file: $f" >&2
    echo "       Refusing to report green from a scan that skipped one of its inputs." >&2
    exit 1
  fi
  printf './%s\0' "$f" >> "$SRCSCAN"
  src_scanned=$((src_scanned + 1))
done < "$SRCLIST"

if [ ! -s "$SRCSCAN" ]; then
  echo "ERROR: check-no-internal-refs - no source files survived list building." >&2
  echo "       Refusing to report green from a scan that read nothing." >&2
  exit 1
fi

# EXTRACT THE DOC COMMENTS. Two buffers per pass, and the reason for the second one is line
# numbers: the rules must run over doc text ALONE (so a rule cannot match a line number, a
# path, or the code on the far side of a `*/`), which means the location has to travel beside
# the text rather than inside it. DOCLINES holds one doc line of text per line; DOCMAP holds
# `file:lineno` at the SAME line index. A hit at index N in one is located by index N in the
# other.
#
# The leaders are stripped the way an IDE strips them: `/**`, a leading `*`, and `*/`
# disappear, because none of them is part of what the reader sees on hover. `//` and plain
# `/* */` are NOT extracted -- see the boundary argument at SRC_RULE_NAME above.
: > "$DOCLINES"; : > "$DOCMAP"; : > "$DOCFLOW"; : > "$DOCFLOWMAP"
: > "$ERRLOG"
while IFS= read -r -d '' f; do
  awk -v file="$f" -v dl="$DOCLINES" -v dm="$DOCMAP" -v df="$DOCFLOW" -v dfm="$DOCFLOWMAP" '
    function emit() {
      gsub(/[[:space:]]+/, " ", joined); sub(/^ /, "", joined); sub(/ $/, "", joined)
      if (joined != "") { print joined >> df; print file ":" blockstart >> dfm }
      joined = ""
    }
    # End of a paragraph inside a block: emit it, keep the block open, keep reporting the
    # location as the block start (a paragraph index would be a number no reader can use).
    function flush2() { if (blockstart > 0) emit() }
    # End of the block.
    function flush() { if (blockstart > 0) emit(); blockstart = 0 }
    {
      line = $0
      if (!indoc) {
        if (line !~ /^[[:space:]]*\/\*\*/) { next }
        indoc = 1; blockstart = FNR; joined = ""
        sub(/^[[:space:]]*\/\*\*/, "", line)
      }
      # THE TERMINATOR IS TESTED BEFORE THE LEADER IS STRIPPED, and that ordering is the whole
      # correctness of this extractor. Stripping first turns a closing " */" into "/" (the
      # leader pattern eats the asterisk of the terminator), the block never closes, and every
      # `//` comment and line of CODE after it is scanned as doc text. That is not
      # hypothetical: it is what the first draft of the hl7 pass did, and it reported 60
      # violations that were all real bookkeeping sitting in `//` comments this surface
      # deliberately does not cover. A gate that over-reports is not "safe": it would have
      # forced a sweep of the wrong lines.
      # TESTING THE TERMINATOR AGAINST DOC TEXT IS CORRECT, NOT A SHORTCUT: a doc comment
      # whose prose contains `*/` (a glob like `src/**/*.ts`, a regex ending `*/`) would close
      # the block early and drop the rest of it from the scan. THE CONSTRUCT IS UNREACHABLE IN
      # VALID TYPESCRIPT: block comments do not nest and cannot contain `*/`, so the compiler
      # ends the comment at exactly the same character this does, and `typecheck` runs ahead
      # of this gate on the ladder. The extractor mirrors the language; it does not
      # approximate it.
      closed = 0
      if (line ~ /\*\//) { closed = 1; sub(/\*\/.*$/, "", line) }
      # Exactly ONE leading asterisk, never `\*+`: a greedy leader would swallow the opening
      # `**` of markdown bold ("* **Fail-safe:**") and alter the scanned text.
      sub(/^[[:space:]]*\*[[:space:]]?/, "", line)
      sub(/^[[:space:]]+/, "", line)
      # The LINE pass sees the doc text with its location beside it.
      print line >> dl; print file ":" FNR >> dm
      # The FLOW pass accumulates a PARAGRAPH, not the whole block, and squeezes it the way a
      # tooltip reflows one. A BLANK doc line is a paragraph break and ends the run, for the
      # same reason the markdown pass above prints an empty line rather than joining through
      # it: a list item ending "(this module)" followed by a blank line and a new sentence
      # starting "The ..." is not the text "(this module) The ...", and joining through the
      # break invents adjacencies that no reader ever sees.
      if (line ~ /^[[:space:]]*$/) { flush2() } else { joined = joined " " line }
      if (closed) { flush(); indoc = 0 }
    }
    END { if (indoc) flush() }
  ' "$f" 2>>"$ERRLOG"
done < "$SRCSCAN"
refuse_if_incomplete

# An extraction that produced nothing from a non-empty, JSDoc-heavy source tree means the
# extractor broke, not that the tree is clean. Same class as the empty-file-list refusal.
if [ ! -s "$DOCLINES" ]; then
  echo "ERROR: check-no-internal-refs - extracted no doc-comment text from ${src_scanned}" >&2
  echo "       tracked source file(s). Every public export in this package carries JSDoc," >&2
  echo "       so an empty extraction means the extractor is broken, not that the source" >&2
  echo "       is clean. Refusing to report green from a scan that read nothing." >&2
  exit 1
fi

# SCAN. Line pass first (it can name a file and a line), then the reflowed pass for violations
# that straddle a wrap. Wraps are not hypothetical here either: this package's doc comments
# are wrapped at the same column as its markdown, and a sentence ending "... this" / "phase
# models" is exactly as invisible to a line scan in JSDoc as it is in markdown. The reflow
# models a hover tooltip: whitespace squeezed, `*` leaders already gone.
SRC_HITS=""
i=0
while [ "$i" -lt "$SRC_RULE_COUNT" ]; do
  : > "$ERRLOG"
  LINE_IDX=$(grep -nP -e "${SRC_RULE_PATTERN[$i]}" -- "$DOCLINES" 2>>"$ERRLOG" | cut -d: -f1 || true)
  refuse_if_incomplete
  if [ -n "$LINE_IDX" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      loc=$(sed -n "${n}p" "$DOCMAP")
      txt=$(sed -n "${n}p" "$DOCLINES")
      SRC_HITS="${SRC_HITS}[${SRC_RULE_NAME[$i]} / src doc comment]"$'\n'"${loc}: ${txt}"$'\n'
    done <<< "$LINE_IDX"
  fi

  : > "$ERRLOG"
  FLOW_IDX=$(grep -nP -e "${SRC_RULE_PATTERN[$i]}" -- "$DOCFLOW" 2>>"$ERRLOG" | cut -d: -f1 || true)
  refuse_if_incomplete
  if [ -n "$FLOW_IDX" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      # Report only what the line pass could not see, so a wrapped hit is not printed twice.
      blockloc=$(sed -n "${n}p" "$DOCFLOWMAP")
      # DELIMITED, not a bare substring. An unanchored `*"$blockloc"*` makes `./src/x.ts:1` a
      # substring of an existing hit at `./src/x.ts:12`, so a real wrapped violation in the
      # block starting at line 1 is suppressed by an unrelated hit at line 12. It never loses
      # the RED (SRC_HITS is non-empty either way) but it loses the REPORT, which is the line
      # a remediator needs. The trailing ':' is what a location is always followed by.
      case "$SRC_HITS" in
        *"${blockloc}: "*|*"${blockloc} (block): "*) continue ;;
      esac
      m=$(sed -n "${n}p" "$DOCFLOW" | grep -oP -e "${SRC_RULE_PATTERN[$i]}" | head -1)
      SRC_HITS="${SRC_HITS}[${SRC_RULE_NAME[$i]} / src doc comment, wrapped across lines]"$'\n'"${blockloc} (block): ${m}"$'\n'
    done <<< "$FLOW_IDX"
  fi
  i=$((i + 1))
done

# ---------------------------------------------------------------------------
# FOURTH PASS: `src/` STRING LITERALS, the prose that reaches a consumer's LOG AND WIRE
# ---------------------------------------------------------------------------
#
# The argument for this pass and its four stated boundaries are at STR_RULE_NAME above. In
# short: a library's error and warning messages are read more often than its README, they are
# neither markdown nor doc comments, and in this package some of them are composed into an
# HL7 ACK's text field and transmitted to a remote system.
#
# The extractor keeps text ONLY, never the quotes, and records `file:line` beside each
# extracted line in the same index-aligned way the doc-comment pass does. Several literals on
# one source line are joined with a space, which is safe because a rule that matched across the
# join would have to span two adjacent literals in one expression; measured zero such matches,
# and an over-report there is a maintainer reading one line.
: > "$STRLINES"; : > "$STRMAP"
: > "$ERRLOG"
while IFS= read -r -d '' f; do
  awk -v file="$f" -v sl="$STRLINES" -v sm="$STRMAP" '
    # Whole-line comments are skipped: the doc-comment pass owns `/** */`, and `//` is
    # deliberately out of scope for this gate. Matches `//`, `/*`, `/**` and a ` *`
    # continuation line.
    /^[[:space:]]*(\/\/|\/\*|\*)/ { next }
    {
      line = $0
      out = ""
      while (match(line, /"([^"\\]|\\.)*"|`([^`\\]|\\.)*`/)) {
        out = out " " substr(line, RSTART + 1, RLENGTH - 2)
        line = substr(line, RSTART + RLENGTH)
      }
      if (out != "") { print out >> sl; print file ":" FNR >> sm }
    }
  ' "$f" 2>>"$ERRLOG"
done < "$SRCSCAN"
refuse_if_incomplete

# A source tree this size cannot contain zero string literals. An empty extraction means the
# extractor broke, not that the tree is clean; same class as every other refusal here.
if [ ! -s "$STRLINES" ]; then
  echo "ERROR: check-no-internal-refs - extracted no string literals from ${src_scanned}" >&2
  echo "       tracked source file(s). This package's warning codes, event names, error" >&2
  echo "       messages and import specifiers are all string literals, so an empty" >&2
  echo "       extraction means the extractor is broken, not that the source is clean." >&2
  echo "       Refusing to report green from a scan that read nothing." >&2
  exit 1
fi

STR_HITS=""
i=0
while [ "$i" -lt "$STR_RULE_COUNT" ]; do
  : > "$ERRLOG"
  STR_IDX=$(grep -nP -e "${STR_RULE_PATTERN[$i]}" -- "$STRLINES" 2>>"$ERRLOG" | cut -d: -f1 || true)
  refuse_if_incomplete
  if [ -n "$STR_IDX" ]; then
    while IFS= read -r n; do
      [ -n "$n" ] || continue
      loc=$(sed -n "${n}p" "$STRMAP")
      txt=$(sed -n "${n}p" "$STRLINES")
      STR_HITS="${STR_HITS}[${STR_RULE_NAME[$i]} / src string literal]"$'\n'"${loc}:${txt}"$'\n'
    done <<< "$STR_IDX"
  fi
  i=$((i + 1))
done

[ -n "$ALL_HITS" ] && fail_with_hits "the public surface listed above" "$ALL_HITS"
[ -n "$SRC_HITS" ] && fail_with_hits "src/ doc comments, which compile into all three entry points' .d.ts and .d.cts and render in every consumer's editor" "$SRC_HITS"
[ -n "$STR_HITS" ] && fail_with_hits "src/ string literals, which reach a consumer as error message text and, via buildMllpAck, as HL7 ACK content on the wire" "$STR_HITS"

echo "check-no-internal-refs: OK (${scanned} public-surface file(s) and the npm metadata scanned against ${RULE_COUNT} rules, line by line and paragraph-joined; ${src_scanned} source file(s) scanned against ${SRC_RULE_COUNT} rules for doc-comment bookkeeping, line by line and paragraph-reflowed, and against ${STR_RULE_COUNT} rules for string-literal bookkeeping; ${gitlinks} gitlink(s) skipped)"
