# Standing disciplines: the long form

`CLAUDE.md` keeps `## Standing disciplines (every change)` and points here. The section moved out of that file whole when it went over its byte budget: unchanged and under its own heading. The narrative behind each discipline stays in [`agent-notes.md`](agent-notes.md).

## Standing disciplines (every change)

These bind every change in this repo (mirrored from the cosyte meta-repo's `documentation/conventions.md`):

1. **Documentation follows code.** A public-surface / stack / status change isn't done until its docs are: this package's own docs (`docs-content/` + JSDoc), and (in the meta-repo) its
   `documentation/repos/<repo>.md` and the `ecosystem-map.md` status table.
2. **Version + changelog every meaningful change.** Add a Changeset (`pnpm changeset`) and pick the bump from what the change does to the PUBLISHED package, on the **`0.1.x` ladder**
   `.changeset/README.md` states: **minor** for anything a consumer gains (a newly exported symbol, a new option, a new event, a new stable code, a new published artifact), **patch** for a fix, for
   documentation of a surface that already ships, and for contributor-only tooling, **major** only when you mean to declare `1.0.0`, so until then a breaking change is a **minor** whose summary
   spells the break out. **There is no `0.0.x` rung left to stay on.** Why, and the ten-`patch` batch the old instruction produced:
   `documentation/agent-notes.md#the-version-ladder-and-the-pre-alpha-instruction-it-replaced`
   **The changeset summary IS the changelog entry**: a generator
   is on, so the RELEASE writes everything above `## Released before this file was generated`. **Never hand-edit it, never reintroduce `[Unreleased]`, keep only the H1 above the first heading,
   and never resync `"prettier"` (`false` on purpose).** **An UNCHANGED changelog after release is a swallowed write failure, not a reverted flag.**
   Why: `documentation/agent-notes.md#changelog-generation`
3. **Crew + knowledgebase feedback loop.** When a standard, decision, or public surface changes, flag whether a `crew` skill or `knowledgebase` doc needs creating/updating. Never silently skip.
4. **No internal project bookkeeping on a public surface** (founder directive, 2026-07-27). What a consumer reads (`README.md`, `docs-content/`, the npm `description`, a release body, and the JSDoc
   their editor renders on hover) says what the software does and what changed. Item identifiers, phase and plan language, ADR numbers, meta-repo paths and "how this got built" commentary belong
   in the changeset, `CHANGELOG.md`, the commit, the PR and the roadmap. It is a **translation** at the boundary, not a deletion: **when you strip an identifier off the front of a line, repair the
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
