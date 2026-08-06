#!/usr/bin/env tsx
/**
 * `@cosyte/mllp` two-file-contract gate.
 *
 * WHAT THIS REPO PROMISES, WHICH IS THE ONLY THING THIS GATE ASSERTS. On 2026-08-04 this
 * repo's guidance was split in two: `CLAUDE.md` became a cursor plus rules plus traps, and
 * `documentation/agent-notes.md` took the narrative, with `CLAUDE.md` pointing into it by
 * anchor. Nothing was deleted; the reasoning simply moved behind a link. That makes the link
 * load-bearing in a way it was not before. A rule in `CLAUDE.md` now reads "never do X. Why:"
 * followed by an anchor into the narrative file, and if that anchor does not exist the reader
 * gets an imperative with no grounding, which is exactly the "prose no test can check" shape
 * this repo's own text warns about. Three things can break silently and none of them had a
 * check:
 *
 *   1. the narrative file stops existing (a rename, a bad merge, a `git rm`);
 *   2. a section is emptied down to its heading, so a pointer resolves to nothing; and
 *   3. an anchor is edited on one side of the pair and not the other, so a pointer dangles.
 *
 * This gate checks those three, on this tree, and nothing else.
 *
 * ---------------------------------------------------------------------------
 * ▶ IT IS NAMED FOR WHAT IT CHECKS AND IS DELIBERATELY NOT A UNIVERSAL, AND THAT IS THE MOST
 * IMPORTANT LINE IN THIS FILE.
 *
 * The two-file split was applied across the cosyte tree, so the tempting framing is "every
 * repo has a `CLAUDE.md` and a `documentation/agent-notes.md`, and this gate enforces the
 * contract". MEASURED 2026-08-06, on the umbrella's own checkout: `config`, `hl7` and
 * `workflow` have NO `documentation/agent-notes.md` at all. So the ecosystem-wide contract is
 * either not universal or is violated in three places, and a gate written as though it were
 * universal would be asserting something three repos disprove. That is an OVERCLAIM, and an
 * overclaiming guard is worse than a narrow one: it invites a reader to trust a promise the
 * tree does not keep, and the first repo that trips it deletes it instead of fixing anything.
 *
 * So: this gate asserts `mllp`'s contract. `mllp` HAS an `agent-notes.md`, its `CLAUDE.md`
 * points into it by anchor throughout, and its `CLAUDE.md` sits at its byte budget with the
 * narrative already relocated, so here the pointer relationship is real and paid for. Whether
 * every OTHER repo owes the same thing is a question for whoever owns the convention,
 * and it is not answered by a script inside one package. DO NOT WIDEN THIS FILE TO CLAIM IT.
 *
 * The corollary, which is the same rule pointing the other way: this gate lives in `mllp`'s
 * own CI, so it costs the umbrella's capped automation plane nothing. Porting it to a sibling
 * means copying the SHAPE into that sibling and re-deriving its scan surface, exactly as
 * `check-no-internal-refs.sh` was ported here. It does not mean one shared script.
 *
 * ---------------------------------------------------------------------------
 * ▶ EXISTENCE IS NOT OBSERVATION, WHICH IS WHY THE OK LINE RECONCILES.
 *
 * The failure this gate is most likely to have is not a wrong answer, it is a right-looking
 * answer over a corpus it never opened. That is not hypothetical here: this repo's own PHI
 * scanner shipped a walk whose declared root had never existed, and it printed clean on every
 * run it ever made. A DENOMINATOR DOES NOT DETECT THAT, because a count counts the roots that
 * DID exist. The remedy `ncpdp` landed, and the one used here, is RECONCILIATION.
 *
 * BE PRECISE ABOUT WHICH PART OF THAT DOES THE WORK, because a first draft of this paragraph was
 * not and a refuter caught it. The property that actually prevents the defect is STRUCTURAL, not
 * arithmetic: THERE IS NO DECLARED ROOT TO BE WRONG ABOUT. The corpus is whatever `git ls-files`
 * returns, every path in it is opened or refused, and the ONLY silent skip is a NUL-bearing file,
 * which is counted and named on the OK line. A walk root that never existed cannot happen here
 * because there is no walk root.
 *
 * THE PRINTED ARITHMETIC IS A WEAKER THING AND IS NOT THE REMEDY. It is reconciled over SETS of
 * paths rather than a pair of counters, which does buy something a counter cannot: a counter
 * incremented once per iteration can only ever sum to the number of iterations, so comparing that
 * sum to the corpus size is a tautology. Sets catch a path enumerated twice and a path no branch
 * reached. But on a healthy `git ls-files` neither occurs, so treat the printed sum as SOMETHING
 * A READER CAN CHECK BY EYE -- above all the skip count, which is the tell for disclosed miss (v)
 * -- and not as evidence the scan was complete. Do not restate it as the central safeguard.
 *
 * Further refusals exist for the same reason, and each is a case where "no violations" would be
 * a lie rather than a result:
 *   * zero tracked paths (not a repo, or a `--root` pointed at an empty tree);
 *   * a tracked path that is missing, unreadable, a symlink, or not a regular file;
 *   * an UNMERGED path, which `git ls-files -s` reports three times and whose working-tree copy
 *     is conflict markers nobody has yet decided the contents of;
 *   * two tracked files carrying the contract basename, which makes every pointer ambiguous; and
 *   * ZERO POINTERS FOUND ANYWHERE. In THIS repo that cannot be a clean tree: `CLAUDE.md`'s
 *     opening sentence is a link into `agent-notes.md` and its rules cite it by anchor. Zero
 *     means the matcher stopped matching, so the pointer half proved nothing. This refusal is
 *     grounded in what THIS repo contains and is one of the things a port must re-derive.
 *
 * ---------------------------------------------------------------------------
 * EXIT CODES, matching `scripts/phi-scan.ts` so the two gates read the same way.
 *   0  the contract holds.
 *   1  the contract is broken: a missing file, an empty section, or a dangling pointer.
 *   2  REFUSAL. The gate could not observe what it claims to check. Never reported as clean.
 *
 * The split matters: exit 1 is a finding a human acts on, exit 2 is "believe nothing I said".
 * Collapsing them would turn a broken scanner into a list of false findings, which reads as
 * actionable and is worse than a crash.
 *
 * ---------------------------------------------------------------------------
 * DISCLOSED MISSES. Stated here rather than discovered later.
 *
 * WHICH OF THESE A TEST PINS IS MARKED PER ITEM, and that marking is itself a rule this change
 * paid for: a first draft of this block opened "each is pinned by a case in
 * `test/scripts/agent-notes.test.ts`" while four of them had no case at all. A DISCLOSURE THAT
 * NAMES A TEST MUST NAME ONE THAT EXISTS, or the disclosure is doing the same work the overclaim
 * it warns about does. [PINNED] means a case in that file exercises it IN THE DIRECTION IT
 * FAILS. [SCOPE] means it is a boundary of what this gate is for, with nothing to execute.
 *
 *  (i)   [PINNED] A POINTER SPLIT MID-ANCHOR ACROSS A LINE WRAP is matched only when the head
 *        fragment runs to the end of the line and the join with the next line resolves. The
 *        join is attempted ONLY after the line-pass anchor has already failed, so it can turn a
 *        false red into a pass but never a real red into a pass -- EXCEPT where the head
 *        fragment is ITSELF a valid anchor and the tail is garbage, which passes green. Closing
 *        that needs a markdown renderer, not a bigger regex, and `.prettierignore` lists `*.md`
 *        here so nothing reflows these lines behind a maintainer's back.
 *  (ii)  [PINNED] A PERCENT-ENCODED OR HTML-ENTITY ANCHOR IS NOT DECODED. `#a%20b` matches only
 *        up to the `%`, so it is checked as `#a` and reds. No such pointer exists on this tree.
 *  (iii) [PINNED] A POINTER AT ANY OTHER FILE'S ANCHOR IS OUT OF SCOPE, including
 *        `CLAUDE.md#...`. This gate is about the narrative file. A general markdown link
 *        checker is a different tool with a different failure surface, and writing half of one
 *        here would be the overclaim this file's second section refuses.
 *  (iv)  [PINNED] A POINTER INSIDE A FENCED CODE BLOCK IS TREATED EXACTLY LIKE PROSE.
 *        Deliberate: a reader follows it either way. Headings are the opposite, see (vi).
 *  (v)   [PINNED] A NUL-BEARING FILE IS SKIPPED WHOLE, SO ITS POINTERS ARE NEVER READ. This is
 *        the one that can print `all resolving` over a dangling pointer, and it is a disclosed
 *        miss rather than a pass. THE TELL IS THE SKIPPED COUNT ON THE OK LINE, exactly as
 *        `check-no-emdash.sh`'s NUL exclusion works and for the same reason: the one file it
 *        excludes today is the vendored `@cosyte/hl7` tarball, a compressed stream that cannot
 *        be read as markdown and cannot be edited to fix a red. If a NUL-bearing TEXT file ever
 *        lands here, revisit the partition rather than the rule. `CLAUDE.md` requires that
 *        exclusion be carried as a disclosed miss and says the at-risk class already exists, so
 *        do not round this off to hypothetical.
 *  (vi)  [PINNED] AN ATX HEADING INSIDE A FENCED CODE BLOCK IS NOT AN ANCHOR, and the fence
 *        tracker is why. Without it a `# comment` in a shell sample mints a phantom anchor and
 *        masks the dangling pointer this gate exists to catch. The tracker handles ``` and ~~~
 *        fences of three or more characters. It does NOT track an INDENTED code block as a
 *        block, but that is not reachable as a phantom anchor: `ATX_RE` bounds indentation at
 *        three spaces, so a four-space-indented `#` line is not a heading here either, which is
 *        what CommonMark does anyway. Both halves are asserted, because an earlier draft of
 *        this note claimed the opposite and was wrong: a disclosure that names the wrong
 *        failure mode sends the next reader hunting something that cannot happen.
 *  (vii) [PINNED] THE SLUGGER IS A TRANSCRIPTION OF github-slugger, NOT THE MODULE. It is
 *        verified against github-slugger@2.0.0 for the four shapes that diverge from the obvious
 *        implementation: a dropped LEADING character, a NON-ASCII space separator and a SOFTBREAK
 *        (all three in SLUG_CASES), and a REPEATED heading (the dedup block in `selfTest`, NOT
 *        SLUG_CASES, which holds no repeated-heading row). Each was got wrong by a draft of this
 *        file and each was false-green or false-red on a fixture link GitHub really resolves.
 *        TWO SHAPES ARE UNTESTED AND ARE NOT CLAIMED: combining marks and CJK, because none
 *        exists here; and CONNECTOR PUNCTUATION other than `_`, which `\p{Word}` keeps upstream
 *        (`a‿b` slugs `a‿b`) and this keep-class deletes. That last one is false-red only, since
 *        a pointer's anchor class cannot carry it either. A heading that needs any of them is the
 *        signal to test it, not to assume.
 *  (viii)[SCOPE] A SECTION WITH A BODY IS NOT A SECTION WITH THE RIGHT BODY. This gate proves a
 *        pointer lands somewhere non-empty. It cannot prove the prose there grounds the rule
 *        that cited it. That half stays human, and saying so is the point of writing it down.
 *  (ix)  [SCOPE] IT DOES NOT CHECK ANY BYTE BUDGET. `CLAUDE.md`'s ceiling is enforced by the
 *        umbrella's `.claude/hooks/doc-budget.mjs`, which holds the budget table; a script
 *        inside this package cannot see it and must not keep a second copy of a number.
 *
 * Run it locally with `pnpm check:agent-notes`. `pnpm test` runs it against this tree too
 * (`test/scripts/agent-notes.test.ts`), which is what puts it on the meta-repo's
 * `scripts/verify.sh mllp` ladder without that ladder needing to name it.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Heading {
  /** 1-based line number of the heading text (the underline line, for setext). */
  readonly line: number;
  readonly text: string;
  readonly slug: string;
  /** 1-based line the section body may start on. */
  readonly bodyFrom: number;
  /**
   * Depth: 1-6 for `#`..`######`, and for setext 1 for `===` and 2 for `---`. Carried ONLY so
   * `emptySections` can tell a CONTAINER from an emptied leaf; nothing else reads it, and it is
   * deliberately not part of the slug, which depends on the text alone.
   */
  readonly level: number;
}

interface Violation {
  readonly where: string;
  readonly what: string;
}

/** A refusal: the gate could not observe what it claims to check. Always exit 2. */
class RefusalError extends Error {}

/** A bad invocation. Also exit 2: the run proves nothing. */
class InvocationError extends Error {}

// ---------------------------------------------------------------------------
// The contract file, named once
// ---------------------------------------------------------------------------

/**
 * The basename this gate is about. Matched on BASENAME rather than on the full path, so a
 * pointer qualified with `documentation/`, one prefixed `./`, and a bare one all reach the same
 * target. Exactly one tracked file may carry this name: two would make every pointer ambiguous,
 * and the gate refuses rather than guessing.
 *
 * NOTE FOR ANYONE EDITING THE PROSE IN THIS FILE OR IN `test/scripts/agent-notes.test.ts`: this
 * gate scans EVERY tracked text file and carves out no exemption for its own source or its own
 * tests, so a literally-written pointer here is a pointer into this repo's narrative file and is
 * checked as one. That is deliberate. An exemption for the gate's own files is precisely where a
 * genuinely broken pointer would hide, and this repo's PHI scanner has already paid for one
 * blanket exemption that removed 72 of 76 files from a sweep. Sample pointers are therefore
 * assembled from a constant rather than written out, in both files.
 */
const CONTRACT_BASENAME = "agent-notes.md";

/** The cursor half of the pair. Its absence is a contract violation, not a refusal. */
const CURSOR_PATH = "CLAUDE.md";

// ---------------------------------------------------------------------------
// Slugging: a transcription of github-slugger, pinned by SLUG_CASES below
// ---------------------------------------------------------------------------

/**
 * Strip the one inline construct that changes a slug: a markdown link, whose URL must not
 * reach the slug while its text must. Nothing else needs stripping, and that is a measured
 * simplification rather than a shortcut: backticks, asterisks and underscores-as-emphasis are
 * all removed (or kept) by the punctuation filter below in exactly the way github-slugger
 * removes (or keeps) them, so pre-stripping them would be a second, divergent implementation
 * of the same rule. `_` in particular is KEPT by the filter, which is what makes the real
 * anchor `...codes-not_verbatim-and-unverifiable` resolve.
 */
function stripInline(text: string): string {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
}

/**
 * github-slugger's transformation: lowercase, drop everything that is not a letter, a number, a
 * space separator, a hyphen or an underscore, then replace each remaining space with a hyphen.
 *
 * TWO THINGS HERE ARE NOT COSMETIC.
 *
 * PER-SPACE, NOT PER-RUN: `a  b` becomes `a--b` on GitHub and must here too, or a heading with a
 * double space is reported dangling against a slug GitHub never mints.
 *
 * ▶ NO `.trim()`. A draft had one and it was a FALSE-GREEN divergence, not a tidy-up, caught by
 * the gate on this change. github-slugger does not trim: it deletes the disallowed character and
 * leaves the space behind, so `▶ The section` slugs as `-the-section` with a LEADING HYPHEN. A
 * trim here produced `the-section`, which meant a pointer written `#the-section` passed this gate
 * and resolved to nothing on GitHub. That is the exact shape this file exists to catch, and it is
 * reachable rather than exotic: `▶` is this repo's own marker for a load-bearing rule and it is
 * used throughout `CLAUDE.md` and in the narrative file's own sections, so a `▶`-led heading is
 * the likeliest next one anybody writes. Pinned by SLUG_CASES.
 *
 * ▶ THE KEPT SPACE IS THE ASCII SPACE ALONE, NOT `\p{Zs}`. Same rule, same direction of care: a
 * disallowed character is DELETED, and every space separator other than U+0020 is disallowed.
 * Measured, a heading holding U+00A0 or U+2009 between two letters slugs them together upstream.
 * A `\p{Zs}` keep-class left the
 * separator in the slug, which reds a pointer that works (nothing can match it, since a pointer's
 * anchor class cannot contain a space separator either). Caught alongside the softbreak below.
 *
 * ▶ A SOFTBREAK IS DELETED, NOT HYPHENATED, WHICH IS WHY THE SETEXT JOIN USES `\n`. A wrapped
 * setext heading is ONE heading whose text contains a newline, and `\n` is not a space separator,
 * so upstream removes it and the two halves RUN TOGETHER: `The long` / `section name` slugs
 * `the-longsection-name`, not `the-long-section-name`. A first remedy for the wrapped-heading case
 * joined the paragraph with a space and asserted the hyphenated form in the self-test, a vitest
 * case and three documents, which is the same false-green class as the `.trim()` above arriving
 * through its own fix. Derived twice: from github-slugger, and from GitHub's own
 * `[^\p{Word}\- ]` deletion rule. Pinned by SLUG_CASES and end to end in both directions.
 */
function slugify(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, "")
    .replace(/ /g, "-");
}

/**
 * github-slugger's DEDUPLICATION, transcribed as the loop it actually is rather than as the
 * counter it looks like.
 *
 * The obvious implementation (count occurrences of the base slug, suffix `-N`) is wrong on one
 * input and the difference is a false red: headings `Same`, `Same`, `Same-1` yield `same`,
 * `same-1`, `same-1-1` upstream, because the third heading's OWN slug collides with the second
 * heading's GENERATED one and the suffix is applied again. A counter yields `same-1` twice, so a
 * pointer at `#same-1-1` reds against a link GitHub resolves. Measured against
 * github-slugger@2.0.0 and pinned by a self-test.
 *
 * `occurrences` maps a slug to how many times it has been handed out, exactly as upstream does,
 * and the returned slug is itself recorded so the next collision sees it.
 */
function makeSlugger(): (text: string) => string {
  const occurrences = new Map<string, number>();
  return (text: string): string => {
    const original = slugify(text);
    let result = original;
    while (occurrences.has(result)) {
      occurrences.set(original, (occurrences.get(original) ?? 0) + 1);
      result = `${original}-${String(occurrences.get(original))}`;
    }
    occurrences.set(result, 0);
    return result;
  };
}

/**
 * The anchor character class, kept in lockstep with what `slugify` can EMIT. If this were the
 * ASCII `[A-Za-z0-9_-]` the obvious way, a pointer at a heading containing an accented letter
 * would be truncated mid-anchor by the matcher and reported as dangling -- a false red against
 * a link that works. Aligning the two is what makes the matcher's silence meaningful.
 */
const ANCHOR_CHARS = "[\\p{L}\\p{N}_-]";

function pointerPattern(): RegExp {
  return new RegExp(`agent-notes\\.md#(${ANCHOR_CHARS}+)`, "gu");
}

// ---------------------------------------------------------------------------
// Heading extraction
// ---------------------------------------------------------------------------

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
/**
 * ATX. Up to three leading spaces (CommonMark), one to six hashes, and then EITHER whitespace
 * or end of line -- `#hashtag` is not a heading. Trailing closing hashes are stripped.
 *
 * THE NCPDP LESSON IS BAKED INTO THIS LINE. `ncpdp#64`'s first attempt at a heading guard was
 * `/^#{1,6} /` and two bypasses were reproduced end to end against it: a single leading space,
 * and a setext underline. Both are handled here and both are asserted in the test file. A
 * guard that misses something the bar never required is an overclaim, not a failure -- but
 * these two ARE required, because a missed heading is a missing anchor and a missing anchor is
 * a FALSE RED on a pointer that works.
 */
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
/** Setext: a `=` or `-` run under a non-blank paragraph line. `=` is h1, `-` is h2. */
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

function stripTrailingHashes(text: string): string {
  return text.replace(/[ \t]+#+[ \t]*$/, "");
}

/**
 * Extract every heading GitHub would give an anchor, in document order, deduplicated by
 * `makeSlugger`.
 *
 * THREE BLOCK CONSTRUCTS ARE TRACKED, and each was added because leaving it out was a measured
 * divergence rather than a theoretical one:
 *
 *   * FENCED CODE. An ATX line inside ``` or ~~~ is a comment in a sample, not a heading.
 *     Without this a shell snippet mints a phantom anchor and a dangling pointer passes, which
 *     is the one direction this gate must never fail in.
 *   * YAML FRONT MATTER. A `---` fence at the very start of the file is front matter, and its
 *     CLOSING `---` sits directly under a non-blank line, so a setext reader mints an anchor
 *     from `title: x`. Reproduced: it passed a pointer at `#title-x` that GitHub cannot resolve.
 *   * THE SETEXT PARAGRAPH. An underline belongs to the WHOLE paragraph above it, not to its
 *     last line. `The long` / `section name` / `------` is ONE heading whose text carries a
 *     softbreak. Reading the last line alone slugged it `section-name` and reddened the pointer
 *     GitHub resolves. The lines are joined with `\n`, NOT a space, because a softbreak is
 *     DELETED by the slug rule rather than hyphenated: the anchor is `the-longsection-name`. See
 *     `slugify` for the measurement; joining with a space was itself a false-green defect.
 */
function extractHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  const slugger = makeSlugger();
  let inFence = false;
  let fenceMarker = "";

  const push = (line: number, rawText: string, bodyFrom: number, level: number): void => {
    const text = rawText.trim();
    headings.push({ line, text, slug: slugger(text), bodyFrom, level });
  };

  // Front matter, if any: a `---` on the very first line opens it and the next `---` or `...`
  // closes it. Everything between is metadata, never a heading and never a pointer surface.
  let start = 0;
  if ((lines[0] ?? "").trimEnd() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const t = (lines[i] ?? "").trimEnd();
      if (t === "---" || t === "...") {
        start = i + 1;
        break;
      }
    }
  }

  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i] ?? "";

    const fence = FENCE_RE.exec(line);
    if (fence) {
      const marker = (fence[1] ?? "")[0] ?? "";
      if (!inFence) {
        inFence = true;
        fenceMarker = marker;
      } else if (marker === fenceMarker) {
        inFence = false;
        fenceMarker = "";
      }
      continue;
    }
    if (inFence) continue;

    const atx = ATX_RE.exec(line);
    if (atx) {
      push(i + 1, stripTrailingHashes(atx[2] ?? ""), i + 2, (atx[1] ?? "#").length);
      continue;
    }

    // Setext. The underline is only a heading when it sits under a non-blank paragraph that is
    // not itself a heading and not a list item. A `---` after a blank line is a thematic break.
    const setext = SETEXT_RE.exec(line);
    if (setext && i > start) {
      const prev = lines[i - 1] ?? "";
      const prevIsText = prev.trim() !== "" && !ATX_RE.test(prev) && !/^ {0,3}[-*+>] /.test(prev);
      if (prevIsText) {
        // THE UNDERLINE BELONGS TO THE WHOLE PARAGRAPH, so walk back to its first line and join.
        // Reading only `lines[i - 1]` slugs a wrapped heading from its last line alone, which is
        // a false red on the pointer GitHub resolves.
        let first = i - 1;
        while (first > start) {
          const above = lines[first - 1] ?? "";
          if (above.trim() === "" || ATX_RE.test(above) || /^ {0,3}[-*+>] /.test(above)) break;
          first -= 1;
        }
        const paragraph = lines
          .slice(first, i)
          .map((l) => l.trim())
          .join("\n");
        // The anchor belongs to the paragraph; the body starts after the underline.
        // `===` is a level-1 heading and `---` a level-2 one, exactly as CommonMark reads them.
        push(first + 1, paragraph, i + 2, (setext[1] ?? "-").startsWith("=") ? 1 : 2);
      }
    }
  }

  return headings;
}

/**
 * A section is EMPTY when nothing but blank lines separates its heading from the next heading
 * or from the end of the file. That is the check the item asks for and it is deliberately the
 * weak form: see disclosed miss (viii). A heading whose only body is a fence or a single word
 * counts as non-empty, because judging sufficiency is not something a script can do honestly.
 *
 * ▶ A CONTAINER IS NOT AN EMPTIED SECTION, AND CONFLATING THEM IS A FALSE RED. A heading
 * immediately followed by a DEEPER one (`## Group` then `### Sub` with no prose between) is a
 * container whose body IS its subsections. A pointer at `#group` resolves on GitHub and the
 * reader lands on real content, so reporting it is a red against a link that works. Measured on
 * a fixture before the fix: `## Group` / `### Sub` / `real body here` exited 1 saying `#group`
 * "has no body".
 *
 * This is the item's own criterion read literally. The item asks for the case where a section is
 * "emptied down to its heading"; a container has not been emptied, it never held prose of its
 * own. It also matches the rule `ccda` shipped for the same gate ("no section is empty unless it
 * is a container for subsections"), and it is the direction of care this whole file is built
 * around: an overclaiming guard invites a reader to trust a promise the tree does not keep, and
 * the first false red is what gets a gate deleted rather than fixed.
 *
 * IT OPENS NO FALSE-GREEN HOLE, which is the only direction that would matter. The exemption
 * moves the obligation DOWN rather than removing it: the deeper heading is still checked, so an
 * emptied leaf still reds, and a container can only be exempt when something deeper exists to
 * carry the body. A trailing heading has no `next` at all and is therefore never a container.
 * Both directions are pinned in `test/scripts/agent-notes.test.ts`.
 */
function emptySections(lines: readonly string[], headings: readonly Heading[]): Heading[] {
  const empty: Heading[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const here = headings[h];
    if (!here) continue;
    const next = headings[h + 1];
    // A container: its body is the subsections beneath it, and the obligation moves to them.
    if (next && next.level > here.level) continue;
    const end = next ? next.line - 1 : lines.length;
    let hasBody = false;
    for (let i = here.bodyFrom; i <= end; i += 1) {
      if ((lines[i - 1] ?? "").trim() !== "") {
        hasBody = true;
        break;
      }
    }
    if (!hasBody) empty.push(here);
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Self-tests. A gate is believed only after it has shown it can still see.
// ---------------------------------------------------------------------------

/**
 * Slug transcription cases. Every one is a REAL heading from this repo's `agent-notes.md` or a
 * shape a future one is likely to take. If someone "simplifies" `slugify`, this table reds here
 * rather than turning every working pointer on the tree into a false red.
 *
 * ▶ DO NOT DESCRIBE THIS TABLE BY POSITION. An earlier version of this comment opened "the last
 * three are the leading-character cases", and the next commit appended three rows and made it
 * false without touching it. Each row below carries its own reason where it needs one; a
 * positional reference is a claim that goes stale on the next append, which is the same defect
 * class as the renumbered cross-reference two blocks above. Every row is verified against
 * github-slugger@2.0.0.
 */
const SLUG_CASES: ReadonlyArray<readonly [string, string]> = [
  ["The em-dash brand gate", "the-em-dash-brand-gate"],
  ["MllpConnectionError.connectionCause", "mllpconnectionerrorconnectioncause"],
  ["PHI-SCAN-SYMLINK-BLIND-ON-BOTH-ROUTES", "phi-scan-symlink-blind-on-both-routes"],
  ["The MSH is read ONCE (MLLP-ACK-UTF8)", "the-msh-is-read-once-mllp-ack-utf8"],
  [
    "Stable warning codes, NOT_VERBATIM and UNVERIFIABLE",
    "stable-warning-codes-not_verbatim-and-unverifiable",
  ],
  ["Test timeouts, measured not read", "test-timeouts-measured-not-read"],
  ["A `code` heading with **bold**", "a-code-heading-with-bold"],
  ["A [linked](https://example.test/x) heading", "a-linked-heading"],
  ["▶ The section", "-the-section"],
  ["▶ ▶ Doubled marker", "--doubled-marker"],
  ["A  double  space", "a--double--space"],
  // A SOFTBREAK IS DELETED, NOT HYPHENATED. The two halves run together. This is the wrapped
  // setext heading, and getting it wrong was a false green on a link that resolves to nothing.
  ["The long\nsection name", "the-longsection-name"],
  // Every space separator other than U+0020 is deleted too, for the same reason.
  ["a\u00a0b", "ab"],
  ["a\u2009b", "ab"],
];

function selfTest(): void {
  for (const [text, want] of SLUG_CASES) {
    const got = slugify(text);
    if (got !== want) {
      throw new RefusalError(
        `SELF-TEST FAILED: slugify(${JSON.stringify(text)}) produced ${JSON.stringify(got)}, ` +
          `expected ${JSON.stringify(want)}. The slug transcription no longer matches ` +
          `github-slugger, so every anchor this gate computes is suspect and no result from ` +
          `it can be believed.`,
      );
    }
  }

  // The heading detector must see every shape that mints an anchor and NONE of the shapes that
  // do not. The second half is the one that matters most: a phantom anchor lets a dangling
  // pointer pass, which is the single outcome this gate exists to prevent.
  // Blank lines separate the blocks, because that is what makes each shape unambiguous markdown.
  // Without them a `    ###` line is a lazy paragraph continuation rather than an indented code
  // block, and a setext underline swallows every line above it, which is correct behaviour on
  // input nobody writes. Keep the blanks.
  const sample = [
    "---",
    "title: front matter",
    "---",
    "",
    "# Top",
    "body",
    "",
    "  ## Indented by two",
    "body",
    "",
    "    ### Indented by four",
    "",
    "Setext one",
    "==========",
    "body",
    "",
    "A wrapped setext",
    "heading over two lines",
    "----------------------",
    "body",
    "",
    "#hashtag",
    "",
    "```sh",
    "# not a heading",
    "```",
    "body",
  ];
  const got = extractHeadings(sample).map((h) => h.slug);
  const want = ["top", "indented-by-two", "setext-one", "a-wrapped-setextheading-over-two-lines"];
  if (got.length !== want.length || got.some((s, i) => s !== want[i])) {
    throw new RefusalError(
      `SELF-TEST FAILED: the heading detector produced [${got.join(", ")}], expected ` +
        `[${want.join(", ")}]. A missed heading is a false red on a working pointer; a ` +
        `phantom one lets a dangling pointer through. Refusing to report on the tree.`,
    );
  }

  // Deduplication is a LOOP, not a counter: the third heading's own slug collides with the
  // second heading's GENERATED one, so the suffix applies again. A counter yields `same-1`
  // twice and reds a pointer at `#same-1-1` that GitHub resolves.
  const dedup = extractHeadings(["## Same", "a", "## Same", "b", "## Same-1", "c"]).map(
    (h) => h.slug,
  );
  const wantDedup = ["same", "same-1", "same-1-1"];
  if (dedup.length !== wantDedup.length || dedup.some((s, i) => s !== wantDedup[i])) {
    throw new RefusalError(
      `SELF-TEST FAILED: duplicate headings slugged as [${dedup.join(", ")}], expected ` +
        `[${wantDedup.join(", ")}]. GitHub disambiguates by re-suffixing until the slug is ` +
        `free, and a pointer at a repeated heading depends on it.`,
    );
  }

  const empty = emptySections(["## A", "## B", "body"], extractHeadings(["## A", "## B", "body"]));
  if (empty.length !== 1 || empty[0]?.slug !== "a") {
    throw new RefusalError(
      `SELF-TEST FAILED: the empty-section detector found ${String(empty.length)} empty ` +
        `section(s) in a sample with exactly one. Refusing to report on the tree.`,
    );
  }

  const re = pointerPattern();
  const hits = [
    ...`see documentation/${CONTRACT_BASENAME}#a-b, ./${CONTRACT_BASENAME}#c_d.`.matchAll(re),
  ].map((m) => m[1]);
  if (hits.length !== 2 || hits[0] !== "a-b" || hits[1] !== "c_d") {
    throw new RefusalError(
      `SELF-TEST FAILED: the pointer matcher found [${hits.join(", ")}] in a sample holding ` +
        `exactly two pointers, one path-qualified and one relative. A matcher that stopped ` +
        `matching reports a clean tree it never read.`,
    );
  }
}

// ---------------------------------------------------------------------------
// The corpus: enumerate with git, account for every path
// ---------------------------------------------------------------------------

interface Corpus {
  readonly tracked: readonly string[];
  readonly gitlinks: readonly string[];
}

function gitCorpus(root: string): Corpus {
  let raw: string;
  try {
    raw = execFileSync("git", ["ls-files", "-s", "-z"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new RefusalError(
      `could not enumerate tracked files under ${root} with \`git ls-files\`: ` +
        `${err instanceof Error ? err.message : String(err)}. A gate that cannot list its ` +
        `corpus has not observed it.`,
    );
  }

  const tracked: string[] = [];
  const gitlinks: string[] = [];
  for (const record of raw.split("\0")) {
    if (record === "") continue;
    // `<mode> <sha> <stage>\t<path>`
    const tab = record.indexOf("\t");
    if (tab < 0) {
      throw new RefusalError(
        `unparseable \`git ls-files -s\` record: ${JSON.stringify(record)}. Refusing rather ` +
          `than dropping a path from the corpus silently.`,
      );
    }
    const mode = record.slice(0, 6);
    const path = record.slice(tab + 1);
    // AN UNMERGED PATH IS REFUSED, NOT COUNTED. `git ls-files -s` emits stages 1, 2 and 3 for a
    // conflicted path, so the same path arrives three times. Reading the working-tree copy of a
    // conflicted file means scanning conflict markers and reporting on a tree nobody has yet
    // decided the contents of, and counting it three times is what would make the
    // reconciliation below balance while the SET of paths did not. `scripts/phi-scan.ts`
    // refuses unmerged paths for the same reason.
    const stage = record.slice(tab - 1, tab);
    if (stage !== "0") {
      throw new RefusalError(
        `tracked path is unmerged (stage ${stage}): ${path}. Resolve the conflict before ` +
          `running this gate; a scan of a half-merged tree reports on nothing anyone has ` +
          `decided yet.`,
      );
    }
    // A gitlink (mode 160000) is a submodule pointer with no bytes here to read. Counted and
    // reported, never silently skipped: the OK line's arithmetic has to account for it.
    if (mode === "160000") gitlinks.push(path);
    else tracked.push(path);
  }

  if (tracked.length === 0) {
    throw new RefusalError(
      `\`git ls-files\` under ${root} listed no readable tracked file. There is nothing here ` +
        `to observe, so "the contract holds" would be a statement about an empty set. This ` +
        `is the control case: a gate pointed at nothing must refuse, never report OK.`,
    );
  }

  return { tracked, gitlinks };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

interface Args {
  readonly root: string;
}

function parseArgs(argv: readonly string[]): Args {
  let root = process.cwd();
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--root") {
      const next = argv[i + 1];
      if (next === undefined) throw new InvocationError("--root requires a directory argument");
      root = isAbsolute(next) ? next : resolve(process.cwd(), next);
      i += 2;
    } else if (a !== undefined && a.startsWith("--")) {
      throw new InvocationError(`Unknown flag: ${a}`);
    } else if (a !== undefined) {
      throw new InvocationError(`Unexpected positional argument: ${a}`);
    } else {
      i += 1;
    }
  }
  return { root };
}

function readTracked(root: string, path: string): Buffer {
  const abs = join(root, path);
  let st;
  try {
    st = lstatSync(abs);
  } catch (err) {
    throw new RefusalError(
      `tracked path is missing from the working tree: ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}). A scan that could not open ` +
        `one of its inputs has not observed the corpus it is about to report on.`,
    );
  }
  if (st.isSymbolicLink()) {
    throw new RefusalError(
      `tracked path is a symbolic link: ${path}. Reading through it would scan bytes from ` +
        `somewhere else under this path's name. Refused by name rather than skipped, so the ` +
        `reconciliation below stays honest. The link target is deliberately not printed.`,
    );
  }
  if (!st.isFile()) {
    throw new RefusalError(
      `tracked path is not a regular file: ${path}. Refusing to report green from a scan ` +
        `that skipped one of its inputs.`,
    );
  }
  try {
    return readFileSync(abs);
  } catch (err) {
    throw new RefusalError(
      `tracked path is not readable: ${path} ` +
        `(${err instanceof Error ? err.message : String(err)}).`,
    );
  }
}

function main(argv: readonly string[]): number {
  selfTest();

  const { root } = parseArgs(argv);
  const { tracked, gitlinks } = gitCorpus(root);

  const violations: Violation[] = [];

  // ---- 1. The pair exists ------------------------------------------------
  const contractPaths = tracked.filter(
    (p) => p === CONTRACT_BASENAME || p.endsWith(`/${CONTRACT_BASENAME}`),
  );
  if (contractPaths.length > 1) {
    throw new RefusalError(
      `${String(contractPaths.length)} tracked files are named ${CONTRACT_BASENAME} ` +
        `(${contractPaths.join(", ")}). Every pointer would be ambiguous, so no verdict on ` +
        `them is meaningful. Refusing rather than guessing which one a pointer meant.`,
    );
  }

  const cursorTracked = tracked.includes(CURSOR_PATH);
  if (!cursorTracked) {
    violations.push({
      where: CURSOR_PATH,
      what: `the cursor half of the pair is not tracked. The contract is two files; one of them is gone.`,
    });
  }

  const contractPath = contractPaths[0];
  if (contractPath === undefined) {
    violations.push({
      where: `documentation/${CONTRACT_BASENAME}`,
      what:
        `the narrative half of the pair is not tracked. Every rule in ${CURSOR_PATH} that ` +
        `cites it is now an imperative with no grounding. Restore the file or move the ` +
        `narrative back; do not delete the pointers.`,
    });
  }

  // ---- 2. Anchors and sections ------------------------------------------
  let anchors = new Set<string>();
  let sectionCount = 0;
  if (contractPath !== undefined) {
    const buf = readTracked(root, contractPath);
    if (buf.includes(0)) {
      throw new RefusalError(
        `${contractPath} contains a NUL byte, so it is not the markdown this gate parses. ` +
          `Refusing rather than reporting on bytes it cannot read as text.`,
      );
    }
    const text = buf.toString("utf8");
    if (text.trim() === "") {
      violations.push({
        where: contractPath,
        what: `the narrative file is empty. Its existence is not the contract; its content is.`,
      });
    }
    const lines = text.split("\n");
    const headings = extractHeadings(lines);
    sectionCount = headings.length;
    anchors = new Set(headings.map((h) => h.slug));

    if (headings.length === 0 && text.trim() !== "") {
      throw new RefusalError(
        `extracted no headings from ${contractPath}, which is ${String(lines.length)} line(s) ` +
          `long and not empty. Every anchor this gate resolves comes from that extraction, so ` +
          `an empty one means the extractor broke, not that the file has no sections.`,
      );
    }

    for (const h of emptySections(lines, headings)) {
      violations.push({
        where: `${contractPath}:${String(h.line)}`,
        what:
          `section "${h.text}" (#${h.slug}) has no body. A pointer at it resolves to nothing, ` +
          `which is the same defect as a dangling anchor with a friendlier error message. ` +
          `Restore the narrative; do not delete the heading to clear this.`,
      });
    }
  }

  // ---- 3. Every pointer resolves ----------------------------------------
  // THE TWO SETS BELOW ARE SETS, NOT COUNTERS, AND THAT IS THE WHOLE POINT OF THE RECONCILIATION.
  // A pair of counters incremented one per loop iteration can only ever sum to the number of
  // iterations, so comparing that sum against the corpus size is a tautology dressed as a check.
  // Sets of PATHS cannot: they catch a path enumerated twice, a path visited twice, and a path
  // in the corpus that no branch ever reached. That is what makes the OK line's arithmetic
  // evidence rather than decoration.
  const openedPaths = new Set<string>();
  const skippedPaths = new Set<string>();
  let pointerCount = 0;
  const pointerFiles = new Set<string>();

  for (const path of tracked) {
    const buf = readTracked(root, path);
    if (buf.includes(0)) {
      // A NUL-bearing file is not markdown and cannot be edited to clear a red, so it is
      // skipped. THIS IS DISCLOSED MISS (v), NOT A PASS: a pointer inside such a file is never
      // read. The tell is the skipped count on the OK line, which is the same shape
      // `check-no-emdash.sh` uses for the same exclusion over the same one file.
      skippedPaths.add(path);
      continue;
    }
    openedPaths.add(path);
    const text = buf.toString("utf8");
    if (!text.includes(`${CONTRACT_BASENAME}#`)) continue;

    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      const re = pointerPattern();
      let m: RegExpExecArray | null;
      while ((m = re.exec(line)) !== null) {
        const anchor = m[1] ?? "";
        pointerCount += 1;
        pointerFiles.add(path);
        if (anchors.has(anchor)) continue;

        // Disclosed miss (i): the wrap join, attempted ONLY on an anchor that already failed
        // to resolve and only when it ran to the end of the line. It can rescue a false red;
        // it cannot manufacture a pass for a pointer the line pass already resolved.
        if (m.index + m[0].length === line.length) {
          const tail = (lines[i + 1] ?? "").replace(/^[ \t>*-]*/, "");
          const joined = new RegExp(`^(${ANCHOR_CHARS}+)`, "u").exec(tail);
          if (joined && anchors.has(anchor + (joined[1] ?? ""))) continue;
        }

        violations.push({
          where: `${path}:${String(i + 1)}`,
          what:
            `pointer #${anchor} does not resolve to a heading in ` +
            `${contractPath ?? `documentation/${CONTRACT_BASENAME}`}. Fix the anchor or ` +
            `restore the section. Deleting the pointer to clear this deletes the grounding ` +
            `for the rule that cited it.`,
        });
      }
    }
  }

  // ---- 4. Reconcile, then report ----------------------------------------
  // Reconciled as SETS against the enumerated corpus, so this can actually fail: a duplicate in
  // the corpus, a path visited twice, or a path no branch reached all break it. See the note at
  // the head of step 3 for why a pair of counters could not.
  const opened = openedPaths.size;
  const skippedBinary = skippedPaths.size;
  const unaccounted = tracked.filter((p) => !openedPaths.has(p) && !skippedPaths.has(p));
  if (opened + skippedBinary !== tracked.length || unaccounted.length > 0) {
    throw new RefusalError(
      `reconciliation failed: ${String(tracked.length)} tracked non-gitlink path(s) ` +
        `enumerated, ${String(opened)} opened and ${String(skippedBinary)} skipped as binary, ` +
        `${String(unaccounted.length)} reached by no branch` +
        `${unaccounted.length > 0 ? ` (first: ${String(unaccounted[0])})` : ""}. Every path ` +
        `must be opened or skipped for a named reason, and no path twice. A corpus that does ` +
        `not reconcile means the scan is reporting on something it did not read.`,
    );
  }

  if (pointerCount === 0) {
    throw new RefusalError(
      `found ZERO pointers at ${CONTRACT_BASENAME} across ${String(opened)} opened file(s). ` +
        `In this repo that is not a clean tree: ${CURSOR_PATH} opens by linking the narrative ` +
        `file and cites it by anchor throughout. Zero means the matcher stopped matching, so ` +
        `the pointer half of this gate observed nothing and proved nothing. EXISTENCE IS NOT ` +
        `OBSERVATION, and a denominator would not have caught this either.`,
    );
  }

  if (violations.length > 0) {
    process.stderr.write(
      `ERROR: check-agent-notes - the two-file contract is broken in this repo ` +
        `(${String(violations.length)} finding(s)).\n\n`,
    );
    for (const v of violations) {
      process.stderr.write(`  ${v.where}\n      ${v.what}\n\n`);
    }
    process.stderr.write(
      `  This gate asserts THIS repo's contract only. It says nothing about any sibling: ` +
        `measured 2026-08-06, config, hl7 and workflow carry no ${CONTRACT_BASENAME} at all.\n`,
    );
    return 1;
  }

  process.stdout.write(
    `check-agent-notes: OK (${contractPath ?? "?"}: ${String(sectionCount)} section(s), ` +
      `all with a body; ${String(pointerCount)} pointer(s) from ${String(pointerFiles.size)} ` +
      `file(s), all resolving; ${String(tracked.length)} tracked path(s) reconciled = ` +
      `${String(opened)} opened + ${String(skippedBinary)} skipped as binary, plus ` +
      `${String(gitlinks.length)} gitlink(s) with no bytes here)\n`,
  );
  return 0;
}

function run(): number {
  try {
    return main(process.argv.slice(2));
  } catch (err) {
    if (err instanceof RefusalError) {
      process.stderr.write(`[check-agent-notes] refusing: ${err.message}\n`);
      return 2;
    }
    if (err instanceof InvocationError) {
      process.stderr.write(`[check-agent-notes] bad invocation: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(
      `[check-agent-notes] refusing: the check failed before it could finish: ` +
        `${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 2;
  }
}

process.exit(run());
