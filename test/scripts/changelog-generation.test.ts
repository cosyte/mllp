/**
 * Tests for the CHANGELOG generation contract: `.changeset/config.json` plus the
 * shape of `CHANGELOG.md` that makes generated output land where a reader expects
 * it.
 *
 * WHY THIS FILE EXISTS. `CHANGELOG.md` is listed in `package.json#files`, so it is
 * inside every published tarball of this package. For the whole of its published
 * history the release wrote no version heading into it, because
 * `.changeset/config.json` set `"changelog": false`. The file was hand-maintained
 * under one `[Unreleased]` heading that nothing ever rolled over, so a tarball
 * shipped a changelog describing its own already-published contents as unreleased,
 * with zero version headings in it. That is not a typo to correct by hand:
 * correcting the prose leaves the mechanism that wrote it, and it drifts again on
 * the next release. The flag is what these tests hold down.
 *
 * WHAT EACH TEST PINS, AND WHY IT IS HERE:
 *
 *  1. The flag itself. `changelog` must name a generator that really resolves and
 *     really exports the two functions Changesets calls. `false` is a legal value
 *     that silently produces no version heading at all, which is the state this
 *     work replaced.
 *  2. That the release actually reaches the generator. The `version` script is a
 *     chain, and `changeset version` is the only link in it that writes a
 *     changelog. A future edit that reorders or drops that link turns the flag
 *     into decoration with nothing else going red.
 *  3. THE DEFECT, ASSERTED DIRECTLY: no `[Unreleased]` heading and no
 *     `[Unreleased]` link definition survive in the file. With generation on, a
 *     surviving hand-maintained `[Unreleased]` heading is worse than before, not
 *     better: the generated version section is prepended ABOVE it, leaving already
 *     released content sitting under "Unreleased" forever, in the tarball.
 *  4. That the file is still shipped. If it ever leaves `files`, the assertions
 *     above are still nice to have but stop being about a consumer-visible defect,
 *     and the next reader deserves to be told which it is.
 *  5. END TO END, AGAINST THE REAL TOOL. The repo's real `CHANGELOG.md` and real
 *     `.changeset/config.json` are copied into a throwaway package, a synthetic
 *     changeset is added, and the real `changeset version` is run. A test that
 *     reimplements where Changesets inserts text proves only that the test agrees
 *     with itself, and would keep passing through the upgrade that moved it. The
 *     released document must satisfy the shape rule TOO, and the archived history
 *     must come through byte identical: a rule that only held before the first
 *     release would wedge this repo the first time this configuration worked.
 *     The throwaway package is a real git repo, which is not tidiness: the default
 *     generator prefixes each entry with the short sha of the commit that added the
 *     changeset, so without history every case here would assert against a line
 *     shape (`- <summary>`) that no release actually writes.
 *  6. THE PREFIX COLLISION, ON THIS PACKAGE'S OWN LADDER, AND THE TWO CONSECUTIVE
 *     RELEASES THAT EXPOSE IT. `## 0.0.1` is a prefix of `## 0.0.10`. This package
 *     stands in the `0.0.x` range where that pair is reachable, so any check
 *     written with `String.indexOf` or a substring `toContain` over a version
 *     heading reports a heading the document does not have. The case proves it
 *     rather than asserting it: on a document whose only version heading is
 *     `## 0.0.10`, a substring search for `## 0.0.1` returns TRUE while the exact
 *     heading list correctly does not contain it. Every version-heading comparison
 *     in this file is an exact match against that list for that reason. A second,
 *     chained release then shows the rules survive a document that already carries
 *     generated output.
 *  7. A CONTROL PROVING THE FLAG IS LOAD-BEARING. The same inputs with
 *     `"changelog": false` must produce NO version heading and leave the document
 *     byte identical. Without this, case 5 would pass on a config change that did
 *     nothing.
 *  8. `"prettier": false`, AND THE CONTROL THAT SHOWS IT IS NOT COSMETIC. Changesets
 *     runs the document it writes through Prettier unless that option turns the pass
 *     off. THIS REPO'S MARKDOWN IS DELIBERATELY NOT PRETTIER-MANAGED: `.prettierignore`
 *     lists `*.md`, so `format:check` never sees `CHANGELOG.md` and the archived
 *     history was never Prettier-canonical. Leaving the pass on therefore does not
 *     tidy the file, it REWRITES ALREADY-PUBLISHED TEXT on every release: measured on
 *     this archive, emphasis markers, list bullets and continuation indents all move,
 *     and one paragraph whose bold span contains an inline code literal ending in `**`
 *     comes back with the spaces around that literal EATEN. The control runs the same
 *     release with the pass on and requires the archived history to change, so the
 *     setting is proved load-bearing rather than assumed. Do not port a sibling's
 *     answer here: `hl7` Prettier-manages its markdown and needs the opposite setting.
 *  9. THE SHAPE RULE, and the negative control that explains it. Changesets
 *     prepends by replacing the FIRST newline in the file, so exactly one line can
 *     sit above generated output. The rule is that NOTHING BUT THE H1 sits above
 *     the first heading, which is what makes the splice land between two headings
 *     instead of cutting a paragraph in half. It is deliberately not "the archive
 *     heading comes second": a release puts its own version heading there. The
 *     control reproduces the damage on the shape this file used to have, so the
 *     rule is demonstrated rather than asserted.
 * 10. That the preamble makes no future-tense promise about a release.
 *
 * Every case runs in a temp directory built from scratch, and every mutation
 * happens there: nothing here writes into the repo, bumps its version, or consumes
 * a real changeset. Unlike `test/scripts/phi-scan.test.ts`, whose temp trees have
 * to sit under `test/` because the walk root is what that file proves, these trees
 * belong in the OS temp directory: they contain a `CHANGELOG.md` and a throwaway
 * `package.json` and have nothing to say to the PHI walk roots.
 *
 * The temp tree links this repo's Prettier and its Prettier config in even though
 * the release itself no longer runs a Prettier pass. That is for the control in
 * case 8: Changesets resolves Prettier from the tree it is writing into and falls
 * back to its own bundled copy when it finds none, so a control run with the pass
 * ON would otherwise exercise a formatter and a config that no release of this
 * package has ever used, and would prove nothing about what the setting prevents.
 *
 * MEASURED WHILE BUILDING THIS, AND WORTH KNOWING BEFORE DEBUGGING A RELEASE:
 * Changesets wraps the changelog write in a try/catch that only `console.warn`s.
 * A tree where `package.json` declares a Prettier config that cannot be resolved
 * bumps the version, consumes the changeset, and writes NO changelog at all, with
 * a warning as the only signal. Reproduced on this repo's own inputs by declaring
 * `"prettier": "@cosyte/prettier-config"` with no `node_modules`. `"prettier": false`
 * removes that route by removing the resolution, which is a side benefit and NOT the
 * reason the setting is there. Whatever the cause, A RELEASE THAT PUBLISHES WITH AN
 * UNCHANGED CHANGELOG IS A WRITE FAILURE, NOT A FLAG THAT QUIETLY REVERTED.
 *
 * SECURITY: every subprocess call uses spawnSync with array args. No exec, no
 * shell-form.
 */

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterAll } from "vitest";

const REPO_ROOT = process.cwd();
const CHANGELOG_PATH = join(REPO_ROOT, "CHANGELOG.md");
const CONFIG_PATH = join(REPO_ROOT, ".changeset", "config.json");
const PACKAGE_PATH = join(REPO_ROOT, "package.json");
const CHANGESET_BIN = join(REPO_ROOT, "node_modules", "@changesets", "cli", "bin.js");

/** The heading the hand-written history was moved under. Generated sections sit above it. */
const ARCHIVE_HEADING = "## Released before this file was generated";
const PROBE_SUMMARY = "A synthetic entry written by the changelog generation test.";
/**
 * The probe's summary deliberately QUOTES THE ARCHIVE HEADING on a line of its own. A real
 * changeset may do this (the one shipping this change does), and a quoted copy lands in
 * generated output ABOVE the real heading, where a substring search would find it first and
 * every helper anchored on it would measure the wrong block. Changesets indents every line of a
 * summary after the first, so a quoted copy cannot start at column 0; this is what proves it.
 * Stated exactly: the claim is NOT that nothing in a release section reaches column 0 (the version
 * heading, `### Patch Changes` and the entry's own `- ` bullet all do), only that nothing a SUMMARY
 * contributes below its first line does, and the generator's own column-0 lines are headings and
 * bullets that never spell the archive heading.
 */
const PROBE_BODY = `${PROBE_SUMMARY}\n\n${ARCHIVE_HEADING}\n`;

const changelog = readFileSync(CHANGELOG_PATH, "utf8");
const config = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
  changelog?: unknown;
  prettier?: unknown;
};
const pkg = JSON.parse(readFileSync(PACKAGE_PATH, "utf8")) as {
  files?: string[];
  scripts?: Record<string, string>;
};

/** The two functions Changesets calls on whatever `changelog` names. */
interface ChangelogFunctions {
  getReleaseLine?: unknown;
  getDependencyReleaseLine?: unknown;
}
type ChangelogModule = ChangelogFunctions & { default?: ChangelogFunctions };

const roots: string[] = [];

afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
});

/**
 * Build a throwaway single-package repo and run the real `changeset version` in it.
 * Returns the resulting `CHANGELOG.md` and the version `package.json` was bumped to.
 */
function runVersion(opts: {
  changelogBody: string;
  /**
   * Applied ON TOP of the repo's real `.changeset/config.json`. The base is read rather than
   * retyped so a setting added to the real config is exercised here by default instead of
   * silently diverging: `prettier` was added to the real one and a hand-built copy would have
   * gone on proving something about a configuration this package does not run.
   */
  configOverrides?: Record<string, unknown>;
  /** Version the throwaway package starts at. A `patch` changeset bumps it by one. */
  from?: string;
}): {
  changelog: string;
  version: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "mllp-changelog-"));
  roots.push(dir);
  mkdirSync(join(dir, ".changeset"));
  writeFileSync(join(dir, "CHANGELOG.md"), opts.changelogBody);
  writeFileSync(
    join(dir, ".changeset", "config.json"),
    JSON.stringify({ ...config, ...(opts.configOverrides ?? {}) }),
  );
  writeFileSync(
    join(dir, ".changeset", "probe.md"),
    `---\n"@cosyte/mllp": patch\n---\n\n${PROBE_BODY}`,
  );
  // `private` keeps the throwaway package unpublishable even if it escaped the temp dir.
  // `prettier` is declared because Changesets reformats the whole document it writes, and
  // it must be reformatted the way THIS repo formats it or the run proves nothing about
  // what lands on the Version PR.
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({
      name: "@cosyte/mllp",
      version: opts.from ?? "0.0.0",
      private: true,
      prettier: "@cosyte/prettier-config",
    }),
  );
  // Changesets resolves Prettier from the tree it is writing into (`require.resolve` with
  // `paths: [cwd]`) and falls back to its own BUNDLED Prettier when it finds none. That
  // fallback ignores this repo's config, so a temp tree without these two links would
  // exercise a formatter no release ever uses. Links rather than copies: pnpm's own
  // `node_modules` entries are links already.
  mkdirSync(join(dir, "node_modules", "@cosyte"), { recursive: true });
  symlinkSync(join(REPO_ROOT, "node_modules", "prettier"), join(dir, "node_modules", "prettier"));
  symlinkSync(
    join(REPO_ROOT, "node_modules", "@cosyte", "prettier-config"),
    join(dir, "node_modules", "@cosyte", "prettier-config"),
  );

  // THE TEMP TREE IS A REAL GIT REPO, AND THAT IS LOAD-BEARING RATHER THAN TIDY. The default
  // generator calls `getCommitThatAddsFile` on each changeset and prefixes the entry with that
  // commit's short sha, so the line a release really writes is `- <sha>: <summary>` and not the
  // summary alone. In a tree with no git history the lookup returns nothing and the prefix never
  // appears, which would leave every case below asserting against a shape no release produces.
  // The identity and the hooks path are passed per-invocation. Stated exactly: this does not
  // WRITE to any git config, and it pins the two settings that would otherwise decide what the
  // commit does. It is not independent of global git config in general, and `core.hooksPath` is
  // the one that matters, because a global value points the temp repo's `commit` at hooks this
  // suite never meant to run. Emptying it is not cosmetic: containers here really do set one.
  const git = (...args: string[]): void => {
    const g = spawnSync(
      "git",
      // `example.com` rather than a `.invalid` domain: `pnpm phi-scan` hits any email whose
      // domain is not declared in `scripts/phi-allow-list.txt`, and the reserved domains are
      // already declared there. Reusing one keeps the allow-list from growing for a git
      // identity that never leaves a temp directory.
      [
        "-c",
        "user.name=changelog test",
        "-c",
        "user.email=changelog@example.com",
        "-c",
        "core.hooksPath=",
        ...args,
      ],
      { cwd: dir, encoding: "utf8", timeout: 60_000 },
    );
    expect(g.status, `git ${args.join(" ")}: ${g.stdout ?? ""}${g.stderr ?? ""}`).toBe(0);
  };
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "--no-gpg-sign", "-m", "seed");

  const r = spawnSync(process.execPath, [CHANGESET_BIN, "version"], {
    cwd: dir,
    encoding: "utf8",
    timeout: 60_000,
  });
  expect(r.status, `${r.stdout ?? ""}${r.stderr ?? ""}`).toBe(0);

  const bumped = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version: string };
  return { changelog: readFileSync(join(dir, "CHANGELOG.md"), "utf8"), version: bumped.version };
}

/** Every ATX heading in a markdown document, in document order. */
const headings = (text: string): string[] =>
  text.split("\n").filter((line) => /^#{1,6} /.test(line));

/**
 * The one structural rule this file has to keep, stated so that it survives a release.
 *
 * Changesets prepends a release by replacing the FIRST newline in the document, so exactly
 * one line can sit above generated output and everything else is pushed below the newest
 * release section. The rule is therefore NOT "the archive heading comes second": a release
 * legitimately puts its own `## <version>` heading there, and asserting the pre-release
 * neighbour would red the first Version PR that this configuration ever opens. The rule is
 * that nothing but the H1 sits above the first heading, so whatever the release splices in
 * lands between two headings and can never cut a paragraph in half.
 *
 * Returns a description of the violation, or `undefined` if the document is well shaped.
 */
function shapeViolation(text: string): string | undefined {
  const lines = text.split("\n");
  if (lines[0] !== "# Changelog") return `line 1 is ${JSON.stringify(lines[0])}, not the H1`;
  const next = lines.slice(1).find((line) => line.trim() !== "");
  if (next === undefined) return "the document has no content below the H1";
  if (!/^## /.test(next)) return `prose above the first heading: ${JSON.stringify(next)}`;
  const anchors = lines.filter((line) => line === ARCHIVE_HEADING).length;
  if (anchors !== 1) return `expected exactly one archived-history heading, found ${anchors}`;
  return undefined;
}

/**
 * The header block of the archived half: from its heading down to its first entry section.
 *
 * The heading is located as a WHOLE LINE, not with `indexOf`. A changeset summary may quote
 * it (this slice's own does), and a quoted copy inside a release section sits above the real
 * heading, so a substring search would slice a few characters out of generated output and the
 * future-tense guard below would silently stop reading the preamble it exists to protect.
 * A whole-line match cannot collide: `getReleaseLine` prefixes the first line of every summary
 * with `- ` and indents every later line by two spaces, so no line a summary contributes below
 * its first can begin at column 0, and the generator's own column-0 lines are the version
 * heading, `### Patch Changes` and that bullet, none of which spell the archive heading.
 * `shapeViolation` asserts the count is one, so if that ever stops holding this fails loudly
 * instead of measuring the wrong block.
 */
function archivePreamble(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(ARCHIVE_HEADING);
  if (start === -1) return "";
  const end = lines.findIndex((line, i) => i > start && line.startsWith("### "));
  return (end === -1 ? lines.slice(start) : lines.slice(start, end)).join("\n");
}

/** Everything from the archived-history heading down, located the same whole-line way. */
function archivedHistory(text: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(ARCHIVE_HEADING);
  return start === -1 ? "" : lines.slice(start).join("\n");
}

describe("changelog generation is on", () => {
  it("names a changelog generator that resolves and exports what Changesets calls", () => {
    // `false` is the value this package shipped its whole published history under,
    // and it is the reason no release ever wrote a version heading.
    expect(config.changelog).not.toBe(false);
    expect(typeof config.changelog).toBe("string");

    const require = createRequire(CONFIG_PATH);
    const mod = require(config.changelog as string) as ChangelogModule;
    const fns = mod.default ?? mod;
    expect(typeof fns.getReleaseLine).toBe("function");
    expect(typeof fns.getDependencyReleaseLine).toBe("function");
  });

  it("runs `changeset version` from the release `version` script, so the flag is reached", () => {
    // The flag only does anything if the release actually invokes the tool that reads it.
    // This repo's `version` script is a chain (`changeset version`, then a version sync,
    // then a format pass), and only the first link writes a changelog.
    const version = pkg.scripts?.["version"] ?? "";
    expect(version).toMatch(/(^|&&\s*)changeset\s+version(\s|$|&)/);
  });

  it("keeps CHANGELOG.md in the published tarball, which is why any of this matters", () => {
    expect(pkg.files ?? []).toContain("CHANGELOG.md");
  });

  it("turns the release's Prettier pass off, because this repo's markdown is not Prettier-managed", () => {
    // `.prettierignore` lists `*.md`, so `format:check` never reads CHANGELOG.md and the
    // archived history has never been through Prettier. With the pass left on, every release
    // would reformat already-published text rather than tidy it. The behavioural proof that
    // this matters is the control below; this case pins the two halves of the reasoning
    // together so neither can be changed without the other being reconsidered.
    expect(config.prettier).toBe(false);
    expect(readFileSync(join(REPO_ROOT, ".prettierignore"), "utf8").split("\n")).toContain("*.md");
  });
});

describe("CHANGELOG.md carries no hand-maintained Unreleased section", () => {
  it("has no [Unreleased] heading", () => {
    // With generation on this is not merely stale: the release prepends its version
    // section ABOVE this heading, so released content would sit under "Unreleased"
    // permanently, in the tarball.
    expect(headings(changelog).filter((h) => h.includes("[Unreleased]"))).toEqual([]);
  });

  it("has no [Unreleased] link definition left behind", () => {
    expect(changelog).not.toMatch(/^\[Unreleased\]:/m);
  });

  it("makes no future-tense promise about a release in its preamble", () => {
    // The published preamble read: the first pre-alpha release "will ship" the API
    // surface below. It had shipped, several versions earlier, in this same file.
    //
    // The block is located by the ARCHIVE HEADING, not by the first `### ` in the
    // document. Anchoring on the first `### ` measures the whole header today and a
    // couple of dozen bytes of generated output after the first release, at which
    // point this assertion would silently stop reading the preamble it guards.
    const preamble = archivePreamble(changelog);
    expect(preamble.length).toBeGreaterThan(200);
    expect(preamble).not.toMatch(/will ship/i);
  });
});

describe("the shape that makes generated output land correctly", () => {
  it("puts nothing but the H1 above the first heading", () => {
    expect(shapeViolation(changelog)).toBeUndefined();
  });

  it(
    "writes the new version section between the H1 and the archived history",
    { timeout: 90_000 },
    () => {
      const result = runVersion({ changelogBody: changelog });

      expect(result.version).not.toBe("0.0.0");
      expect(headings(result.changelog).slice(0, 3)).toEqual([
        "# Changelog",
        `## ${result.version}`,
        "### Patch Changes",
      ]);
      // The archived history survives, below the release that was just written.
      // Compared as HEADINGS, not as string offsets, for the reason case 6 proves.
      const order = headings(result.changelog);
      expect(order).toContain(ARCHIVE_HEADING);
      expect(order.indexOf(`## ${result.version}`)).toBeLessThan(order.indexOf(ARCHIVE_HEADING));
      // The changeset's own summary is what landed as the entry, in the exact line shape a
      // release writes: the default generator prefixes it with the short sha of the commit
      // that added the changeset. "The changeset summary is the changelog entry" is true of
      // the TEXT, and this pins the LINE, so a generator swap that dropped or changed the
      // prefix is visible here rather than first seen in a published tarball.
      expect(result.changelog).toContain(PROBE_SUMMARY);
      expect(result.changelog).toMatch(
        new RegExp(
          `^- [0-9a-f]{7,40}: ${PROBE_SUMMARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`,
          "m",
        ),
      );
      // AND THE INVARIANT IS CLOSED UNDER A RELEASE: the file a release produces is
      // itself a file the next release can be prepended to. Without this the suite
      // would only ever prove the shape of a file no release had touched yet, which
      // is exactly the file that stops existing the moment this configuration works.
      expect(shapeViolation(result.changelog)).toBeUndefined();
      // The archived history comes through BYTE IDENTICAL. This is the assertion that
      // makes the formatter part of the test: the release reformats the whole document
      // through Prettier, so an entry the archive already carried must survive that
      // pass unchanged or the Version PR reds `format:check` on a file nobody edited.
      expect(archivedHistory(result.changelog)).toBe(archivedHistory(changelog));
    },
  );

  it(
    "survives the version-heading prefix collision, across two consecutive releases",
    // Above the two 60s `spawnSync` ceilings this case can spend, so a hung subprocess
    // reports as itself rather than as a case timeout.
    { timeout: 150_000 },
    () => {
      // `## 0.0.1` is a PREFIX of `## 0.0.10`, and this package sits on the `0.0.x`
      // ladder where that pair is reachable. So a document whose only version heading
      // is `## 0.0.10` answers TRUE to a substring search for a heading it does not
      // have. An assertion written that way goes wrong inside a Version PR, with the
      // changeset already consumed, and `prepublishOnly` runs this same suite under
      // `changeset publish`.
      const first = runVersion({ changelogBody: changelog, from: "0.0.9" });
      expect(first.version).toBe("0.0.10");

      // The collision, demonstrated on real generator output rather than asserted.
      expect(first.changelog).toContain("## 0.0.1"); // a substring check is satisfied ...
      expect(headings(first.changelog)).not.toContain("## 0.0.1"); // ... by a heading that is not there.
      expect(headings(first.changelog)).toContain("## 0.0.10");

      // A second release onto a document that already carries generated output.
      const second = runVersion({ changelogBody: first.changelog, from: first.version });
      expect(second.version).toBe("0.0.11");

      expect(headings(second.changelog).slice(0, 5)).toEqual([
        "# Changelog",
        "## 0.0.11",
        "### Patch Changes",
        "## 0.0.10",
        "### Patch Changes",
      ]);
      // Newest first, the archive last, and the history untouched by either release.
      const order = headings(second.changelog);
      expect(order.indexOf("## 0.0.10")).toBeLessThan(order.indexOf(ARCHIVE_HEADING));
      expect(shapeViolation(second.changelog)).toBeUndefined();
      expect(archivePreamble(second.changelog)).toBe(archivePreamble(changelog));
      expect(archivedHistory(second.changelog)).toBe(archivedHistory(changelog));
    },
  );

  it(
    "writes no version heading at all when the generator is off (the control)",
    { timeout: 90_000 },
    () => {
      const result = runVersion({
        changelogBody: changelog,
        configOverrides: { changelog: false },
      });

      expect(result.version).not.toBe("0.0.0");
      // The version bump still happens. The changelog is simply never touched,
      // which is the whole defect: nothing tells a reader the release went out.
      expect(result.changelog).toBe(changelog);
      // As a HEADING, not a substring, for the reason the case above proves.
      expect(headings(result.changelog)).not.toContain(`## ${result.version}`);
      expect(result.changelog).not.toContain(PROBE_SUMMARY);
    },
  );

  it(
    "rewrites the archived history when the Prettier pass is left on (the control)",
    { timeout: 90_000 },
    () => {
      // The setting proved load-bearing rather than assumed. Same inputs, same tool, same
      // temp tree, `prettier` back on: the release still lands correctly, but the archived
      // history no longer comes through unchanged. If this case ever goes green, either
      // Prettier stopped normalising this document (in which case the setting is free to
      // revisit) or the archive stopped being compared properly, and both deserve a look.
      const result = runVersion({ changelogBody: changelog, configOverrides: { prettier: true } });

      expect(headings(result.changelog).slice(0, 2)).toEqual([
        "# Changelog",
        `## ${result.version}`,
      ]);
      expect(archivedHistory(result.changelog)).not.toBe(archivedHistory(changelog));
      // Named concretely rather than left as "something moved": a bold span containing an
      // inline code literal that ends in `**` comes back with the spaces around it eaten,
      // which is text corruption inside a published tarball, not a formatting preference.
      expect(archivedHistory(changelog)).toContain("`test/tls/**` is not a test budget at all.");
      expect(archivedHistory(result.changelog)).not.toContain(
        "`test/tls/**` is not a test budget at all.",
      );
    },
  );

  it(
    "splits the header when prose follows the H1 (the negative control)",
    { timeout: 90_000 },
    () => {
      const oldShape = [
        "# Changelog",
        "",
        "All notable changes to this project will be documented in this file.",
        "",
        "## [Unreleased]",
        "",
        "### Added",
        "",
        "- something that has already shipped",
        "",
      ].join("\n");

      const result = runVersion({ changelogBody: oldShape });

      // The release section is inserted between the H1 and the preamble, so the
      // preamble now reads as part of the release, and `[Unreleased]` still holds
      // shipped content below it.
      expect(headings(result.changelog)).toEqual([
        "# Changelog",
        `## ${result.version}`,
        "### Patch Changes",
        "## [Unreleased]",
        "### Added",
      ]);
      expect(result.changelog.indexOf("All notable changes")).toBeGreaterThan(
        result.changelog.indexOf(PROBE_SUMMARY),
      );
    },
  );
});
