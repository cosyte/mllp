/**
 * Unit tests for `scripts/check-agent-notes.ts`, the two-file-contract gate.
 *
 * WHAT IS BEING PROVED, in the order it matters:
 *
 *   1. THE GATE SEES. Each of the three things it claims to check is seeded into a throwaway
 *      repo and shown RED, then repaired and shown GREEN in the same tree. A gate is only
 *      worth its exit code once it has been watched to fail.
 *   2. THE GATE REFUSES RATHER THAN REPORTING CLEAN OVER A CORPUS IT NEVER OPENED. This is the
 *      control, and it is the whole reason the exit codes are split 1/2. `check --root <empty
 *      tree>` must exit 2, never 0. So must a tree with no pointers in it at all.
 *   3. THE FOUR BYPASS CLASSES ARE REPRODUCED END TO END, not asserted in the abstract. Two of
 *      them are the ones `ncpdp#64` measured against a `/^#{1,6} /` heading guard (a single
 *      leading space, and a setext underline); both are FALSE-RED bypasses here, because a
 *      missed heading is a missing anchor and a missing anchor reds a pointer that works. The
 *      third is the opposite direction: an ATX line inside a code fence must NOT mint an
 *      anchor, or a dangling pointer passes. The fourth is the line-wrapped pointer.
 *   4. THE REAL TREE IS GREEN, run through the real script. That case is what puts this gate on
 *      the meta-repo's `scripts/verify.sh mllp` ladder without the ladder having to name it,
 *      and it is what reds if a future edit breaks an anchor on either side of the pair.
 *
 * WHAT IS DELIBERATELY NOT PROVED HERE: that any sibling repo satisfies the same contract.
 * Measured 2026-08-06, `config`, `hl7` and `workflow` carry no `documentation/agent-notes.md`
 * at all, so a universal assertion would be an overclaim. The script's banner says so; this
 * file does not restate the argument, it just declines to test the universal.
 *
 * RUNNER: the cases spawn `node` directly on the `.ts` gate and rely on node's native type
 * stripping, matching `test/scripts/phi-scan.test.ts` and for the same reason (a `tsx` start
 * costs several times a `node` start on a spawn-bound suite). `pnpm check:agent-notes` runs
 * `tsx`, so ONE case below spawns `tsx` and asserts the two runners agree byte for byte.
 * Delete it and a tsx-only breakage ships green, with the cheap runner testing something the
 * commit gate does not run.
 *
 * The throwaway repos are created under the OS temp dir, never under `test/`. `test/` is a
 * `phi-scan` walk root and its emptiness is load-bearing for a different suite; a temp repo
 * appearing and vanishing inside it would couple two gates that have nothing to do with each
 * other.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const REPO_ROOT = process.cwd();
const GATE_PATH = join(REPO_ROOT, "scripts", "check-agent-notes.ts");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
const NODE_BIN = process.execPath;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runGate(args: string[], bin: string = NODE_BIN): RunResult {
  const r = spawnSync(bin, [GATE_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

let scratch: string;

/**
 * Build a throwaway git repo and return its path. Only the INDEX is populated (`git add`), not
 * a commit: `git ls-files` reads the index, so no commit and therefore no committer identity is
 * needed, which keeps these cases independent of whatever git config the box carries.
 */
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(scratch, "tree-"));
  git(dir, ["init", "-q"]);
  write(dir, files);
  return dir;
}

function write(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    const slash = rel.lastIndexOf("/");
    if (slash > 0) mkdirSync(join(dir, rel.slice(0, slash)), { recursive: true });
    writeFileSync(abs, content);
  }
  git(dir, ["add", "-A"]);
}

function git(dir: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd: dir, encoding: "utf8", shell: false });
  if ((r.status ?? -1) !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
}

/**
 * A sample pointer, ASSEMBLED rather than written out, and that is load-bearing rather than a
 * style choice.
 *
 * The gate scans every tracked text file in the repo and carves out NO exemption for its own
 * source or for this file. So a pointer written literally here would be read as a pointer into
 * THIS repo's `documentation/agent-notes.md` and checked against its anchors, and every fixture
 * below names a section that exists only inside a throwaway repo. Measured: writing them out
 * literally turned this file into 16 findings against the real tree.
 *
 * The fix is deliberately the fixture and NOT an exemption. `DELIBERATE_VIOLATOR_SOURCES` in
 * `scripts/phi-scan.ts` shows what an exemption costs when it is drawn wider than one path: the
 * blanket `.ts` exclusion there removed 72 of 76 tracked files from both scan routes. A gate's
 * own tests are exactly where a genuinely broken pointer would hide, so they stay in scope.
 */
function ptr(anchor: string): string {
  return `documentation/agent-notes.md${"#"}${anchor}`;
}

/** The narrative half, with one real section. */
const NOTES = "# notes\n\nPreamble.\n\n## The section\n\nBody.\n";

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "mllp-agent-notes-"));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("check-agent-notes: the contract it asserts", () => {
  it("is green on a tree that keeps the contract", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md": NOTES,
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("check-agent-notes: OK");
    // The OK line must show its arithmetic, not just its verdict.
    expect(r.stdout).toContain("2 tracked path(s) reconciled = 2 opened");
  });

  it("reds when a pointer dangles, and goes green when the anchor is repaired", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-wrong-anchor")}\n`,
      "documentation/agent-notes.md": NOTES,
    });

    const before = runGate(["--root", dir]);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain("#the-wrong-anchor does not resolve");
    expect(before.stderr).toContain("CLAUDE.md:3");

    write(dir, { "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n` });
    const after = runGate(["--root", dir]);
    expect(after.code).toBe(0);
  });

  it("reds on a section that is nothing but its heading, and goes green when the body returns", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md":
        "# notes\n\nPreamble.\n\n## The section\n\n## Next\n\nBody.\n",
    });

    const before = runGate(["--root", dir]);
    expect(before.code).toBe(1);
    expect(before.stderr).toContain('section "The section" (#the-section) has no body');

    write(dir, { "documentation/agent-notes.md": NOTES });
    expect(runGate(["--root", dir]).code).toBe(0);
  });

  it("reds when the narrative half is not tracked at all, and calls it a finding rather than a refusal", () => {
    const dir = repo({ "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n` });
    const r = runGate(["--root", dir]);
    // Exit 1, not 2: this is a broken contract a human acts on, not a scan that failed.
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the narrative half of the pair is not tracked");
  });

  it("reds when the cursor half is not tracked", () => {
    const dir = repo({
      "documentation/agent-notes.md": NOTES,
      "README.md": `See ${ptr("the-section")}.\n`,
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("the cursor half of the pair is not tracked");
  });

  it("finds a pointer wherever it is written, not only in CLAUDE.md", () => {
    // Measured on this tree: `scripts/phi-scan.ts` and `phi-scan-overrides.md` both name the
    // narrative file. A markdown-only sweep would not open either.
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md": NOTES,
      "scripts/thing.ts": `// see ${ptr("not-a-section")}\n`,
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("scripts/thing.ts:1");
  });
});

describe("check-agent-notes: the control, and every other refusal", () => {
  it("REFUSES when pointed at a tree with nothing tracked in it", () => {
    const dir = mkdtempSync(join(scratch, "empty-"));
    git(dir, ["init", "-q"]);
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(2);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("listed no readable tracked file");
    expect(r.stdout).not.toContain("OK");
  });

  it("REFUSES when pointed at something that is not a git repository", () => {
    const dir = mkdtempSync(join(scratch, "norepo-"));
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(2);
    expect(r.stdout).not.toContain("OK");
  });

  it("REFUSES a tree that holds the pair but zero pointers, instead of calling it clean", () => {
    // The `PHI-SCAN-OBSERVED-NOTHING-IS-GLOBAL` shape, in this gate's own terms: the corpus
    // exists, the files open, and the answer is still meaningless. EXISTENCE IS NOT
    // OBSERVATION, and a denominator would read healthy here.
    const dir = repo({
      "CLAUDE.md": "# cursor\n\nNo link here.\n",
      "documentation/agent-notes.md": NOTES,
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("ZERO pointers");
  });

  it("REFUSES when two tracked files carry the contract basename, rather than guessing", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md": NOTES,
      "docs-content/agent-notes.md": NOTES,
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("named agent-notes.md");
  });

  it("REFUSES an unknown flag rather than scanning with it ignored", () => {
    expect(runGate(["--everything"]).code).toBe(2);
  });
});

describe("check-agent-notes: the bypass classes, reproduced end to end", () => {
  it("sees a heading indented by one space (ncpdp#64 bypass 1: /^#{1,6} / misses it)", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md": "# notes\n\nPreamble.\n\n ## The section\n\nBody.\n",
    });
    // A guard that missed this would report a FALSE RED against a link GitHub resolves.
    expect(runGate(["--root", dir]).code).toBe(0);
  });

  it("sees a setext heading (ncpdp#64 bypass 2: an underline, not a hash)", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md": "# notes\n\nPreamble.\n\nThe section\n-----------\n\nBody.\n",
    });
    expect(runGate(["--root", dir]).code).toBe(0);
  });

  it("does NOT mint an anchor from an ATX line inside a code fence", () => {
    // The opposite direction from the two above, and the one that would let a dangling pointer
    // through. A shell sample containing `# The section` is a comment, not a section.
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-section")}\n`,
      "documentation/agent-notes.md":
        "# notes\n\nPreamble.\n\n## Real\n\n```sh\n# The section\n```\n",
    });
    const r = runGate(["--root", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("#the-section does not resolve");
  });

  it("resolves a pointer whose anchor is split across a line wrap", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-long-")}\nsection-name\n`,
      "documentation/agent-notes.md": "# notes\n\nPreamble.\n\n## The long section name\n\nBody.\n",
    });
    expect(runGate(["--root", dir]).code).toBe(0);
  });

  it("still reds a wrapped pointer whose join does not resolve either", () => {
    // The join can rescue a false red; it must not manufacture a pass.
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("the-long-")}\nwrong-name\n`,
      "documentation/agent-notes.md": "# notes\n\nPreamble.\n\n## The long section name\n\nBody.\n",
    });
    expect(runGate(["--root", dir]).code).toBe(1);
  });

  it("disambiguates two identical headings the way GitHub does", () => {
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("same-1")}\n`,
      "documentation/agent-notes.md": "# notes\n\nP.\n\n## Same\n\nA.\n\n## Same\n\nB.\n",
    });
    expect(runGate(["--root", dir]).code).toBe(0);
  });

  it("keeps an underscore in a slug, which is what makes a real anchor here resolve", () => {
    // `stable-warning-codes-not_verbatim-and-unverifiable` is a live pointer in CLAUDE.md. A
    // slugger that treated `_` as emphasis, or stripped it as punctuation, would red it.
    const dir = repo({
      "CLAUDE.md": `# cursor\n\nWhy: ${ptr("codes-not_verbatim-and-x")}\n`,
      "documentation/agent-notes.md": "# notes\n\nP.\n\n## Codes, NOT_VERBATIM and X\n\nBody.\n",
    });
    expect(runGate(["--root", dir]).code).toBe(0);
  });
});

describe("check-agent-notes: against this repo", () => {
  it("is green on this tree, with every pointer resolving", () => {
    const r = runGate([]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("documentation/agent-notes.md");
    expect(r.stdout).toContain("all resolving");
  });

  it("accounts for every tracked path on the OK line", () => {
    // The reconciliation is the anti-`observed nothing` property, so it is asserted as a
    // property of the OUTPUT, not just of the exit code: `tracked == opened + skipped`.
    const r = runGate([]);
    const m = /(\d+) tracked path\(s\) reconciled = (\d+) opened \+ (\d+) skipped as binary/.exec(
      r.stdout,
    );
    expect(m).not.toBeNull();
    const tracked = Number(m?.[1]);
    const opened = Number(m?.[2]);
    const skipped = Number(m?.[3]);
    expect(opened).toBeGreaterThan(0);
    expect(tracked).toBe(opened + skipped);
  });

  it("agrees byte for byte between the node runner used here and the tsx runner pnpm uses", () => {
    // `pnpm check:agent-notes` runs tsx. Every other case above runs node. Without this, a
    // tsx-only breakage ships green and the cheap runner is testing something CI never runs.
    const viaNode = runGate([]);
    const viaTsx = runGate([], TSX_BIN);
    expect(viaTsx.code).toBe(viaNode.code);
    expect(viaTsx.stdout).toBe(viaNode.stdout);
  }, 30_000);
});
