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
 * points into it eighteen times, and its `CLAUDE.md` sits at its byte budget with the
 * narrative already relocated, so here the pointer relationship is real and paid for. Whether
 * the OTHER nineteen repos owe the same thing is a question for whoever owns the convention,
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
 * DID exist. The remedy `ncpdp` landed, and the one used here, is RECONCILIATION: enumerate
 * the corpus with `git ls-files`, account for every single path as opened or skipped-with-a-
 * named-reason, and REFUSE if the arithmetic does not balance. The OK line prints the sum so a
 * reader can check it without running anything.
 *
 * Three further refusals exist for the same reason, and each is a case where "no violations"
 * would be a lie rather than a result:
 *   * zero tracked paths (not a repo, or a `--root` pointed at an empty tree);
 *   * a tracked path that is missing, unreadable, or not a regular file; and
 *   * ZERO POINTERS FOUND ANYWHERE. In THIS repo that cannot be a clean tree: `CLAUDE.md`'s
 *     opening sentence is a link into `agent-notes.md` and eighteen rules cite an anchor. Zero
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
 * DISCLOSED MISSES. Stated here rather than discovered later. Each is pinned by a case in
 * `test/scripts/agent-notes.test.ts`, in the direction it actually fails, so a future widening
 * is a decision rather than an accident.
 *
 *  (i)   A POINTER SPLIT MID-ANCHOR ACROSS A LINE WRAP is matched only when the head fragment
 *        runs to the end of the line and the join with the next line resolves. The join is
 *        attempted ONLY after the line-pass anchor has already failed to resolve, so it can
 *        turn a false red into a pass but can never turn a real red into a pass -- except in
 *        the one case where the head fragment is ITSELF a valid anchor and the tail is
 *        garbage. That case is a miss. Closing it needs a markdown renderer, not a bigger
 *        regex, and `.prettierignore` lists `*.md` here so nothing reflows these lines behind
 *        a maintainer's back.
 *  (ii)  A PERCENT-ENCODED OR HTML-ENTITY ANCHOR IS NOT DECODED. `#a%20b` is read literally.
 *        No such pointer exists on this tree.
 *  (iii) A POINTER AT ANY OTHER FILE'S ANCHOR IS OUT OF SCOPE, including `CLAUDE.md#...`. This
 *        gate is about the narrative file. A general markdown link checker is a different tool
 *        with a different failure surface, and writing half of one here would be the overclaim
 *        this file's second section refuses.
 *  (iv)  A POINTER INSIDE A FENCED CODE BLOCK IS TREATED EXACTLY LIKE PROSE. Deliberate: a
 *        reader follows it either way. Headings are the opposite, see (v).
 *  (v)   AN ATX HEADING INSIDE A FENCED CODE BLOCK IS NOT AN ANCHOR, and the fence tracker is
 *        why. Without it a `# comment` line in a shell sample would mint a phantom anchor and
 *        mask exactly the dangling pointer this gate exists to catch. The tracker handles
 *        ``` and ~~~ fences of three or more characters; it does NOT handle indented code
 *        blocks, so a four-space-indented `# x` is still read as a heading. CommonMark would
 *        not be, but four-space indentation before a `#` does not occur on this tree and
 *        pretending to a full parser is how the ncpdp heading guard shipped two bypasses.
 *  (vi)  THE SLUGGER IS A TRANSCRIPTION OF github-slugger, NOT THE MODULE. It is pinned by a
 *        self-test table below and verified against every heading and every pointer on this
 *        tree. Emoji, combining marks and CJK headings are untested here because none exists
 *        here. A heading that needs one is the signal to test it, not to assume it works.
 *  (vii) A SECTION WITH A BODY IS NOT A SECTION WITH THE RIGHT BODY. This gate proves a
 *        pointer lands somewhere non-empty. It cannot prove the prose there grounds the rule
 *        that cited it. That half stays human, and saying so is the point of writing it down.
 *  (viii) IT DOES NOT CHECK ANY BYTE BUDGET. `CLAUDE.md`'s 27,000-byte ceiling is enforced by
 *        the umbrella's `.claude/hooks/doc-budget.mjs`, which holds the budget table; a script
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
 * github-slugger's transformation: lowercase, drop everything that is not a letter, a number,
 * a space separator, a hyphen or an underscore, trim, then replace each remaining space with a
 * hyphen. Per-space, not per-run: `a  b` becomes `a--b` on GitHub and must here too, or a
 * heading with a double space would be reported as a dangling pointer against a slug GitHub
 * never mints.
 */
function slugify(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{Zs}\-_]/gu, "")
    .trim()
    .replace(/ /g, "-");
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
 * Extract every heading GitHub would give an anchor, in document order, with the deduplicating
 * counter github-slugger applies: a repeated slug becomes `slug-1`, `slug-2`, and so on.
 */
function extractHeadings(lines: readonly string[]): Heading[] {
  const headings: Heading[] = [];
  const seen = new Map<string, number>();
  let inFence = false;
  let fenceMarker = "";

  const push = (line: number, rawText: string, bodyFrom: number): void => {
    const text = rawText.trim();
    const base = slugify(text);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    headings.push({ line, text, slug: n === 0 ? base : `${base}-${n}`, bodyFrom });
  };

  for (let i = 0; i < lines.length; i += 1) {
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
      push(i + 1, stripTrailingHashes(atx[2] ?? ""), i + 2);
      continue;
    }

    // Setext. The underline is only a heading when it sits directly under a non-blank line
    // that is not itself a heading and not a list marker. A `---` after a blank line is a
    // thematic break, and a `---` on line 1 is YAML front matter; neither mints an anchor.
    const setext = SETEXT_RE.exec(line);
    if (setext && i > 0) {
      const prev = lines[i - 1] ?? "";
      const prevIsText = prev.trim() !== "" && !ATX_RE.test(prev) && !/^ {0,3}[-*+>] /.test(prev);
      if (prevIsText) {
        // The anchor belongs to the text line; the body starts after the underline.
        push(i, prev.trim(), i + 2);
      }
    }
  }

  return headings;
}

/**
 * A section is EMPTY when nothing but blank lines separates its heading from the next heading
 * or from the end of the file. That is the check the item asks for and it is deliberately the
 * weak form: see disclosed miss (vii). A heading whose only body is a fence or a single word
 * counts as non-empty, because judging sufficiency is not something a script can do honestly.
 */
function emptySections(lines: readonly string[], headings: readonly Heading[]): Heading[] {
  const empty: Heading[] = [];
  for (let h = 0; h < headings.length; h += 1) {
    const here = headings[h];
    if (!here) continue;
    const next = headings[h + 1];
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
 * shape a future one is likely to take. If someone "simplifies" `slugify`, this table reds
 * here rather than turning eighteen working pointers into eighteen false reds.
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

  // The heading detector must still see all four shapes, and must NOT see the two non-headings.
  // `#hashtag` and a fenced `# x` are the false-anchor direction: a phantom anchor would let a
  // dangling pointer pass, which is the one outcome this gate exists to prevent.
  const sample = [
    "# Top",
    "body",
    "  ## Indented by two",
    "body",
    "Setext one",
    "==========",
    "body",
    "Setext two",
    "----------",
    "body",
    "#hashtag",
    "```sh",
    "# not a heading",
    "```",
    "body",
  ];
  const got = extractHeadings(sample).map((h) => h.slug);
  const want = ["top", "indented-by-two", "setext-one", "setext-two"];
  if (got.length !== want.length || got.some((s, i) => s !== want[i])) {
    throw new RefusalError(
      `SELF-TEST FAILED: the heading detector produced [${got.join(", ")}], expected ` +
        `[${want.join(", ")}]. A missed heading is a false red on a working pointer; a ` +
        `phantom one lets a dangling pointer through. Refusing to report on the tree.`,
    );
  }

  const dedup = extractHeadings(["## Same", "a", "## Same", "b"]).map((h) => h.slug);
  if (dedup[0] !== "same" || dedup[1] !== "same-1") {
    throw new RefusalError(
      `SELF-TEST FAILED: duplicate headings slugged as [${dedup.join(", ")}], expected ` +
        `[same, same-1]. GitHub disambiguates with a numeric suffix and a pointer at the ` +
        `second of two identical headings depends on it.`,
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
  let opened = 0;
  let skippedBinary = 0;
  let pointerCount = 0;
  const pointerFiles = new Set<string>();

  for (const path of tracked) {
    const buf = readTracked(root, path);
    if (buf.includes(0)) {
      // A binary blob cannot carry a markdown pointer a human follows. Counted, and named on
      // the OK line, because a silent skip is how a scan shrinks without anyone noticing.
      skippedBinary += 1;
      continue;
    }
    opened += 1;
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
  const accounted = opened + skippedBinary;
  if (accounted !== tracked.length) {
    throw new RefusalError(
      `reconciliation failed: ${String(tracked.length)} tracked non-gitlink path(s) ` +
        `enumerated but ${String(accounted)} accounted for (${String(opened)} opened + ` +
        `${String(skippedBinary)} skipped as binary). Every path must be opened or skipped ` +
        `for a named reason. A count that does not balance means the scan is reporting on a ` +
        `corpus it did not read.`,
    );
  }

  if (pointerCount === 0) {
    throw new RefusalError(
      `found ZERO pointers at ${CONTRACT_BASENAME} across ${String(opened)} opened file(s). ` +
        `In this repo that is not a clean tree: ${CURSOR_PATH} opens by linking the narrative ` +
        `file and its rules cite it by anchor throughout. Zero means the matcher stopped ` +
        `matching, so the pointer half of this gate observed nothing and proved nothing. ` +
        `EXISTENCE IS NOT OBSERVATION, and a denominator would not have caught this either.`,
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
