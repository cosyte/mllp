# PHI scanner rules

`CLAUDE.md` keeps the heading and points here. The section below moved out of that file whole when it went over its byte budget: unchanged, under its own heading, one imperative line per rule. The narrative, the three recorded defects and every measurement stay in [`agent-notes.md`](agent-notes.md); the contract and the residuals stay in `phi-scan-overrides.md` at the repo root.

### The PHI scanner (`pnpm phi-scan`)

Three defects are recorded in full at `documentation/agent-notes.md#the-phi-scanner-enumeration-and-its-refusals`, `documentation/agent-notes.md#phi-scan-symlink-blind-on-both-routes` and
`documentation/agent-notes.md#phi-scan-rename-blind-at-precommit`. Contract and residuals also live in `phi-scan-overrides.md`. The rules that came out of them:

- **▶ NEVER soften the refuse-a-scan-that-observed-nothing rule**, and never widen the ENOENT tolerance. Narrow the enumeration instead. **This repo is the one that can actually reach it**,
  because `test/scripts/phi-scan.test.ts` `mkdtemp`s inside `test/`, a walk root, twice per run. **Those tests must keep writing there: the `test/` prefix IS what they prove.**
- **▶ THE OBSERVED-NOTHING CHECK IS PER WALK ROOT, AND A GLOBAL COUNT CANNOT REPLACE IT** (`PHI-SCAN-OBSERVED-NOTHING-IS-GLOBAL`). Counting every root together only fires when ALL come
  back empty, so one healthy root masks an empty one: measured, `test/` emptied and `src/` intact printed `OK, no hits` at exit 0. **A denominator is not the remedy**, because a count counts the
  roots that DID exist. An **absent** root stays legitimate; an **EMPTIED** one refuses (exit 2). A synthetic-repo fixture must therefore plant something scannable under any root it creates.
- **Widening a walk root reintroduces the mid-sweep-deletion defect verbatim.** The roots are deliberately `test/` and `src/` and not the repo root. **What `test/` ADMITS is a separate
  question from what the ROOTS are, and the two must not be conflated.**
- **▶ A `.ts` SOURCE UNDER `test/` IS SCANNED, AND WIDENING IS TWO-SIDED** (`PHI-SCAN-WALK-ROOT-SCOPE`). **The enumeration half alone finds nothing**: every detector wants a
  segment id at the START of a line, so a `PID` in a string literal exited 0 even when NAMED EXPLICITLY on argv. `extractEmbeddedHl7` is the other half, its `|` anchor is load-bearing, and
  the violator exemption is **per-path and total** (`DELIBERATE_VIOLATOR_SOURCES`), never per-extension. **Never widen one half without the other, and never delete the extractor believing
  the walk covers it.** Figures, and why no match count is recorded: `documentation/agent-notes.md#phi-scan-walk-root-scope-and-phi-scan-observed-nothing-is-global`
- **`src/` KEEPS THE CONSERVATIVE PASS ONLY, and that is a decision, not an oversight.** Its JSDoc `@example` snippets are deliberately not held to the segment-aware detectors. Do not reverse it as
  a side effect of a change about `test/`.
- **▶ ONE `src/` PATH OPTS BACK IN, PER-PATH, AND THE RULE ABOVE IS OTHERWISE UNCHANGED** (`STRUCTURED_SCAN_SOURCES`). `src/differential/corpus.ts` is a SHIPPED FIXTURE CORPUS, not
  hand-written code: it has to live under `src/` because `files` publishes `dist` and four documents, so a corpus under `test/` reaches no consumer. Behind the flat rule it was the one HL7
  fixture here that nothing scanned structurally. **Never widen this to the root, to an extension, or to "every index entry"**, and **a listed file must keep its HL7 in STRING LITERALS** or
  `extractEmbeddedHl7` sees nothing and the entry is worth zero. Pinned in both directions (a planted identifier at that path reds; the identical bytes at another `src/` path still pass).
  Why, and the mutation that proves it: `documentation/agent-notes.md#phi-scan-structured-scan-sources-the-shipped-fixture-corpus-under-src`
- **▶ NEVER WRITE "NEITHER ROUTE FOLLOWS A LINK" FLAT.** `walk()` opens the ROOTS with `existsSync` + `readdirSync`, which both follow, so replacing `test/` or `src/` itself with a link is read
  straight through. Disclosed, not closed; never restate it as a promise.
- **An entry that REPLACES a root is judged with THAT ROOT'S OWN LIMITS** (`test` earns the structured scan, `src` the conservative pass), and both read predicates must admit the root's own
  path. Admitting the path is only half the remedy: `looksLikeHl7` decides what scan it earns. **The `.md` and per-path violator exemptions deliberately do NOT carry over to a non-regular entry**,
  because they judge bytes the route could read. (A `.ts` exemption is named here in no other form: the blanket one is gone.)
- **▶ `--diff-filter` MUST KEEP `T`, AND `--no-renames` STAYS.** Each was forced by a measurement at pre-commit, and the "admitting them needs a two-path record shape" framing was **FALSE and ported
  in from a sibling: do not restore it.** Both measurements: `documentation/agent-notes.md#phi-scan-rename-blind-at-precommit`
- **A refusal never reports the link target** (working-tree text that can itself carry PHI).
- **A refusal exits 2, never 1.** Exit 1 is reserved for "hits found", so an uncaught throw is a false finding, which reads as actionable and is worse than a crash. **`walk()` no longer lets any
  `readdir` failure leave the process**: `ENOENT` narrows the enumeration and every other code becomes an `InvocationError`. **Two documents disagree about the leftovers, neither is
  authoritative, and `phi-scan-overrides.md` is the stale one.** Re-measure before relying on either, and never restate "no failure can exit 1" as settled.
- **▶ ALL MODE ALSO READS THE BYTES GIT CARRIES, AS A UNION WITH THE WALK.** Decoys at the tracked names satisfy the walk alone: 8 states printed `OK, no hits` at exit 0. **The skip is a BYTE
  comparison, so never normalize EOL before comparing.** A tracked link/gitlink in the index refuses; **`--staged` stays UNCHANGED** (it decides what a commit is BLOCKED on).
  `documentation/agent-notes.md#phi-scan-index-corpus-the-bytes-git-carries`
- **Do not "resync" any of this to a sibling parser's scope, and do not soften it.**
