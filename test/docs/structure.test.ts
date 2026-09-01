/**
 * The published documentation set, validated AS A SET.
 *
 * WHY THIS EXISTS. `test/docs-content.test.ts` proves each runnable example still agrees with the
 * code. Nothing proved that the nine pages around those examples were a coherent set, and the
 * defects that follow from an unvalidated set are the ordinary ones: three pages all declaring
 * `sidebar_position: 1` and none declaring the last two, a same-page fragment link whose heading
 * lives on a different page, one sibling link written extensionless while the rest carry `.md`, and
 * no page carrying a `description`, so every page on the docs site rendered with no meta
 * description. Each was true here and none of them is visible from inside a single page. The set is
 * shipped whole (`scripts/build-docs-artifacts.sh` tars `docs-content/` into the release artifact
 * `cosyte/docs` ingests), so it is checked whole.
 *
 * THE PAGE CONTRACT. Every tracked `.md` file under `docs-content/`:
 *
 *   1. carries frontmatter with non-empty `id`, `title`, `description` and `sidebar_position`;
 *   2. has an `id` equal to its own filename stem;
 *   3. is named exactly once in `docs-content/sidebars.json`, and every id `sidebars.json` names
 *      has a file;
 *   4. has a `sidebar_position` unique across the set, ascending in the order `sidebars.json` lists
 *      the ids, starting at 1;
 *   5. links to a sibling page as `./<id>.md`, never extensionless and never bare `<id>`;
 *   6. links only to fragments that exist as a heading in the page the link targets;
 *   7. contains no U+2013 and no U+2014.
 *
 * Two set-wide properties are checked beside the contract, because neither is visible from one page
 * either. THE COVERAGE ONE: the published `@cosyte/mllp/testing` subpath and the exported
 * `runDifferential` harness must have a page of their own, reachable from the sidebar and from the
 * entry page, rather than surviving as an aside inside a page about something else. THE
 * RELEASE-STATUS ONE: where this package sits on its release ladder is a claim a reader acts on, so
 * it is stated in exactly one place and linked from anywhere else that needs it, and no page except
 * the conformance statement carries a literal version. A second copy is a second thing to move at
 * release time, and the one that gets forgotten is the one a reader believes.
 *
 * WHAT "TRACKED" MEANS HERE, and why it is reconciled rather than assumed. The release artifact is
 * built from the working tree, but the two documentation gates (`check-no-emdash`,
 * `check-no-internal-refs`) scan `git ls-files`, so an untracked page is a page shipped past both of
 * them. The reconciliation below is therefore its own case: the on-disk set and the tracked set must
 * be equal, and a mismatch names the file rather than silently checking a different corpus than the
 * gates do.
 *
 * SLUGS ARE COMPUTED, NOT READ, and the bound is stated rather than left implicit. Docusaurus slugs
 * a heading from its RENDERED text, so this file strips inline markup, lowercases, drops punctuation
 * and joins on hyphens. Where the site and this approximation could differ is a run of whitespace
 * inside a heading, so both spellings are accepted: this check is permitted to be generous about
 * that one edge, and is never permitted to accept a fragment whose heading does not exist at all,
 * which is the defect it was written for.
 *
 * NO HL7 FIXTURE LIVES HERE. This file sits under a PHI-scan walk root with the structured scan
 * enabled; it reads markdown and needs no message bytes, so it carries none.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS_DIR = join(ROOT, "docs-content");
const SIDEBARS_FILE = "sidebars.json";
const ENTRY_PAGE_ID = "intro";

/** Frontmatter keys every page must carry, non-empty. */
const REQUIRED_FRONTMATTER = ["id", "title", "description", "sidebar_position"] as const;

/**
 * What a page documenting the published testing surface has to name, all three.
 *
 * The subpath and the constructor together, because a page naming only `InMemoryTransport` is a
 * page about something else that mentions it, and `runDifferential` because it is the other half of
 * the same question a reader arrives with: how do I test against this, and how do I check the engine
 * on the other end.
 */
const COVERAGE_MARKERS = [
  "@cosyte/mllp/testing",
  "InMemoryTransport.pair()",
  "runDifferential",
] as const;

/**
 * The tokens that make up the release-status claim: where the package sits on its ladder, and what
 * that means for its public surface. Keyed on the two spellings the claim is actually written in
 * rather than on a sentence, so a rewording that keeps the claim still counts as the claim.
 */
const RELEASE_STATUS_MARKERS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> =
  [
    { label: "the position on the release ladder", pattern: /0\.0\.x/ },
    { label: "the pre-alpha stability position", pattern: /pre-alpha/i },
  ];

/** The one page allowed to carry a literal version of this package. */
const VERSION_DECLARING_PAGE = "conformance.md";

/** The dashes banned across the set. `check-no-emdash.sh` covers U+2014 and does not cover U+2013. */
const BANNED_DASHES: ReadonlyArray<{ readonly name: string; readonly codePoint: number }> = [
  { name: "U+2013 (en dash)", codePoint: 0x2013 },
  { name: "U+2014 (em dash)", codePoint: 0x2014 },
];

// ---------------------------------------------------------------------------
// The corpus
// ---------------------------------------------------------------------------

/** Every `.md` file in the published set, by filename, sorted. */
function pageFilenames(): string[] {
  const found = readdirSync(DOCS_DIR)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  if (found.length === 0) {
    throw new Error(
      "docs-content/ holds no .md pages. Refusing to report a valid documentation set from a " +
        "check that found nothing to validate.",
    );
  }
  return found;
}

/** Every file git tracks under `docs-content/`, which is the corpus both documentation gates scan. */
function trackedDocsPaths(): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--", "docs-content"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  const paths = out.split("\0").filter((entry) => entry !== "");
  if (paths.length === 0) {
    throw new Error(
      "git tracks no file under docs-content/. The published set is what git carries, so a check " +
        "over an empty tracked corpus would report green having read nothing.",
    );
  }
  return paths.sort();
}

function readPage(filename: string): string {
  return readFileSync(join(DOCS_DIR, filename), "utf8");
}

// ---------------------------------------------------------------------------
// Reading a page
// ---------------------------------------------------------------------------

/**
 * The frontmatter block as a flat map.
 *
 * Handles the two shapes this set uses: `key: value` on one line, and a folded block scalar
 * (`key: >-`) whose indented continuation lines join with single spaces. Throws when the block is
 * missing or unterminated, because a page with no frontmatter is exactly the defect rule 1 is for
 * and an empty map would read as "every field absent" rather than "this file is not a page".
 */
function parseFrontmatter(raw: string, where: string): Map<string, string> {
  const lines = raw.split("\n");
  if (lines[0] !== "---") {
    throw new Error(`${where} does not open with a \`---\` frontmatter block.`);
  }
  const end = lines.indexOf("---", 1);
  if (end === -1) {
    throw new Error(`${where} opens a frontmatter block that is never closed with \`---\`.`);
  }

  const out = new Map<string, string>();
  let key: string | null = null;
  let value: string[] = [];
  const flush = (): void => {
    if (key !== null)
      out.set(
        key,
        value
          .join(" ")
          .trim()
          .replace(/^["']|["']$/g, ""),
      );
    key = null;
    value = [];
  };

  for (let i = 1; i < end; i += 1) {
    const line = lines[i] ?? "";
    const opener = /^([A-Za-z_][A-Za-z0-9_]*):(.*)$/.exec(line);
    if (opener !== null) {
      flush();
      key = opener[1] ?? "";
      const rest = (opener[2] ?? "").trim();
      // `>`/`>-`/`|`/`|-` are block-scalar indicators: the value is on the lines that follow.
      value = rest === "" || /^[>|][-+]?$/.test(rest) ? [] : [rest];
      continue;
    }
    if (key !== null) value.push(line.trim());
  }
  flush();
  return out;
}

/** The page body: everything after the frontmatter block. */
function bodyOf(raw: string): string {
  const lines = raw.split("\n");
  const end = lines.indexOf("---", 1);
  return end === -1 ? raw : lines.slice(end + 1).join("\n");
}

/**
 * The body with every fenced code block blanked out, line count preserved.
 *
 * Headings and links are read off this, never off the raw body: a `bash` block whose first line is a
 * `#` comment would otherwise register as a heading, and a fenced example is not a link a reader can
 * follow.
 */
function withoutFencedBlocks(body: string): string {
  const out: string[] = [];
  let openFence: string | null = null;
  for (const line of body.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line);
    if (openFence === null) {
      if (marker !== null) {
        openFence = (marker[1] ?? "").charAt(0);
        out.push("");
        continue;
      }
      out.push(line);
      continue;
    }
    const closer = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
    if (closer !== null && (closer[1] ?? "").charAt(0) === openFence) openFence = null;
    out.push("");
  }
  return out.join("\n");
}

/**
 * The slug spellings a heading can be linked by.
 *
 * Both the raw and the whitespace-collapsed spelling are returned; see the note on slugs at the top
 * of this file for why that generosity is bounded and deliberate.
 */
function slugVariants(headingText: string): string[] {
  const plain = headingText
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .trim();
  const raw = plain.replace(/ /g, "-");
  const collapsed = plain.replace(/ +/g, "-");
  return raw === collapsed ? [raw] : [raw, collapsed];
}

/** Every fragment a link may target on this page. */
function headingSlugs(body: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of withoutFencedBlocks(body).split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    if (heading === null) continue;
    for (const slug of slugVariants(heading[1] ?? "")) slugs.add(slug);
  }
  return slugs;
}

/**
 * Every markdown link target in a page body.
 *
 * The pattern spans newlines on purpose: this set wraps at 100 columns and several links have their
 * text on one line and their target on the next, which a line-by-line scan reads as no link at all.
 */
function linkTargets(body: string): string[] {
  const text = withoutFencedBlocks(body);
  const found: string[] = [];
  for (const match of text.matchAll(/\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*([^()\s]+)\s*\)/g)) {
    found.push(match[1] ?? "");
  }
  return found;
}

function isExternal(target: string): boolean {
  return /^(?:https?:|mailto:|tel:|\/\/)/i.test(target);
}

// ---------------------------------------------------------------------------
// Reading the sidebar
// ---------------------------------------------------------------------------

/**
 * The doc ids `sidebars.json` names, in the order it names them.
 *
 * Only arrays and `items` are descended into, so a category `label` is never mistaken for a doc id.
 */
function collectIds(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectIds(child, out);
    return;
  }
  if (typeof node === "object" && node !== null) {
    const record = node as Record<string, unknown>;
    if (record["type"] === "doc" && typeof record["id"] === "string") out.push(record["id"]);
    if ("items" in record) collectIds(record["items"], out);
  }
}

function sidebarIds(): string[] {
  const parsed: unknown = JSON.parse(readPage(SIDEBARS_FILE));
  if (typeof parsed !== "object" || parsed === null || !("docs" in parsed)) {
    throw new Error("docs-content/sidebars.json does not declare a `docs` sidebar.");
  }
  const ids: string[] = [];
  collectIds((parsed as Record<string, unknown>)["docs"], ids);
  if (ids.length === 0) {
    throw new Error(
      "docs-content/sidebars.json names no doc ids. Every check below is derived from that order, " +
        "so an empty list would check nothing.",
    );
  }
  return ids;
}

// ---------------------------------------------------------------------------
// The set, read once
// ---------------------------------------------------------------------------

interface Page {
  readonly filename: string;
  readonly stem: string;
  readonly raw: string;
  readonly body: string;
  readonly frontmatter: Map<string, string>;
  readonly slugs: Set<string>;
}

const PAGES: readonly Page[] = pageFilenames().map((filename) => {
  const raw = readPage(filename);
  const body = bodyOf(raw);
  return {
    filename,
    stem: filename.replace(/\.md$/, ""),
    raw,
    body,
    frontmatter: parseFrontmatter(raw, `docs-content/${filename}`),
    slugs: headingSlugs(body),
  };
});

const PAGE_BY_ID = new Map(PAGES.map((page) => [page.stem, page]));
const SIDEBAR_IDS = sidebarIds();

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe("docs-content is a valid set", () => {
  it("checks exactly the corpus the documentation gates scan", () => {
    const tracked = trackedDocsPaths()
      .filter((path) => path.endsWith(".md"))
      .map((path) => path.replace(/^docs-content\//, ""));
    const onDisk = PAGES.map((page) => page.filename);
    expect(
      tracked,
      "the tracked and on-disk `.md` sets under docs-content/ differ. An untracked page ships in " +
        "the release artifact but is invisible to `check-no-emdash` and `check-no-internal-refs`, " +
        "and a tracked page with no file is a broken artifact; `git add` or `git rm` it here.",
    ).toStrictEqual(onDisk);
  });

  describe("frontmatter", () => {
    it("carries a non-empty id, title, description and sidebar_position on every page", () => {
      for (const page of PAGES) {
        for (const field of REQUIRED_FRONTMATTER) {
          expect(
            page.frontmatter.get(field) ?? "",
            `docs-content/${page.filename} carries no non-empty \`${field}\` in its frontmatter. ` +
              `Every page needs all four: a missing \`description\` renders the page on the docs ` +
              `site with no meta description, and a missing \`sidebar_position\` leaves its place ` +
              `in the navigation to chance.`,
          ).not.toBe("");
        }
      }
    });

    it("gives every page an id equal to its own filename stem", () => {
      for (const page of PAGES) {
        expect(
          page.frontmatter.get("id"),
          `docs-content/${page.filename} declares id "${page.frontmatter.get("id") ?? ""}". The ` +
            `sidebar names pages by id and the set links them by filename, so the two must agree.`,
        ).toBe(page.stem);
      }
    });
  });

  describe("the sidebar and the files are a bijection", () => {
    it("names every page exactly once, and names no page that does not exist", () => {
      const orphans = PAGES.filter((page) => !SIDEBAR_IDS.includes(page.stem)).map(
        (page) => page.filename,
      );
      expect(
        orphans,
        `docs-content/sidebars.json names no entry for ${orphans.join(", ")}. A page nothing ` +
          `names ships inside the release artifact and is reachable from nowhere.`,
      ).toStrictEqual([]);

      const unresolvable = SIDEBAR_IDS.filter((id) => !PAGE_BY_ID.has(id));
      expect(
        unresolvable,
        `docs-content/sidebars.json names the id(s) ${unresolvable.join(", ")}, which no file ` +
          `under docs-content/ provides. The docs build fails on an unresolvable id.`,
      ).toStrictEqual([]);

      const duplicates = SIDEBAR_IDS.filter((id, index) => SIDEBAR_IDS.indexOf(id) !== index);
      expect(
        duplicates,
        `docs-content/sidebars.json names ${duplicates.join(", ")} more than once.`,
      ).toStrictEqual([]);
    });
  });

  describe("sidebar_position", () => {
    it("ascends in sidebar order, starting at 1, with no value used twice", () => {
      const declared = SIDEBAR_IDS.map((id) => {
        const page = PAGE_BY_ID.get(id);
        if (page === undefined)
          throw new Error(`docs-content/sidebars.json names unknown id ${id}`);
        return { id, position: Number(page.frontmatter.get("sidebar_position")) };
      });

      const expected = SIDEBAR_IDS.map((_, index) => index + 1);
      expect(
        declared.map((entry) => entry.position),
        `the sidebar lists ${SIDEBAR_IDS.join(", ")}, so their sidebar_position values must read ` +
          `${expected.join(", ")}. They read ` +
          `${declared.map((entry) => `${entry.id}=${String(entry.position)}`).join(", ")}. A ` +
          `repeated or absent position leaves the rendered order to the theme's tie-break.`,
      ).toStrictEqual(expected);
    });
  });

  describe("links", () => {
    it("resolves every relative target and every fragment", () => {
      for (const page of PAGES) {
        for (const target of linkTargets(page.body)) {
          if (isExternal(target)) continue;

          const [pathPart = "", fragment] = splitTarget(target);
          const destination =
            pathPart === ""
              ? page
              : PAGE_BY_ID.get(pathPart.replace(/^\.\//, "").replace(/\.md$/, ""));

          if (pathPart !== "") {
            expect(
              existsSync(join(DOCS_DIR, pathPart.replace(/^\.\//, ""))),
              `docs-content/${page.filename} links "${target}", and no such file exists under ` +
                `docs-content/.`,
            ).toBe(true);
          }

          if (fragment === undefined) continue;
          expect(
            destination?.slugs.has(fragment) ?? false,
            `docs-content/${page.filename} links "${target}", but ` +
              `${destination === undefined ? "that page" : `docs-content/${destination.filename}`} ` +
              `defines no heading with the fragment "${fragment}". A same-page fragment whose ` +
              `heading lives on another page renders as a link that goes nowhere.`,
          ).toBe(true);
        }
      }
    });

    it("writes every in-set link as ./<id>.md", () => {
      for (const page of PAGES) {
        for (const target of linkTargets(page.body)) {
          if (isExternal(target)) continue;
          const [pathPart = ""] = splitTarget(target);
          if (pathPart === "") continue;
          expect(
            /^\.\/[a-z0-9-]+\.md$/.test(pathPart),
            `docs-content/${page.filename} links "${target}". An in-set link is written ` +
              `\`./<id>.md\`, never extensionless and never bare: the extensionless form resolves ` +
              `on the docs site and breaks everywhere the markdown is read directly.`,
          ).toBe(true);
        }
      }
    });
  });

  describe("dashes", () => {
    it("carries neither U+2013 nor U+2014 anywhere in the tracked set", () => {
      for (const path of trackedDocsPaths()) {
        const text = readFileSync(join(ROOT, path), "utf8");
        for (const { name, codePoint } of BANNED_DASHES) {
          const at = text.indexOf(String.fromCodePoint(codePoint));
          expect(
            at,
            `${path} carries ${name} at offset ${String(at)}. This set uses ASCII hyphens for ` +
              `ranges and rewrites a dash-joined clause with a period, colon, comma or ` +
              `parentheses. (\`check-no-emdash.sh\` covers U+2014 across every tracked file; ` +
              `U+2013 is covered here and nowhere else.)`,
          ).toBe(-1);
        }
      }
    });
  });

  describe("coverage of the published testing surface", () => {
    // The entry page is excluded from candidacy on purpose: it summarises every page in the set, so
    // it names these surfaces whatever the set does with them, and counting it would let the aside
    // this criterion exists to replace pass as the page it asks for.
    const candidates = PAGES.filter(
      (page) =>
        page.stem !== ENTRY_PAGE_ID &&
        COVERAGE_MARKERS.every((marker) => page.body.includes(marker)),
    );

    it("gives the in-memory transport and the differential harness a page of their own", () => {
      expect(
        candidates.map((page) => page.filename),
        "no page in docs-content/ documents the published `@cosyte/mllp/testing` subpath " +
          "(`InMemoryTransport.pair()`) together with the exported `runDifferential` harness. " +
          "Both are shipped surface: the subpath is one of three in package.json `exports`, and " +
          "`runDifferential` is a root export. A shipped capability documented only as an aside " +
          "inside a page about something else is a capability consumers do not find.",
      ).not.toStrictEqual([]);
    });

    it("puts that page in the sidebar and links it from the entry page", () => {
      const entry = PAGE_BY_ID.get(ENTRY_PAGE_ID);
      expect(entry, `docs-content/${ENTRY_PAGE_ID}.md is missing`).toBeDefined();
      const marker = "## Next";
      const at = entry === undefined ? -1 : entry.body.indexOf(marker);
      expect(
        at,
        `docs-content/${ENTRY_PAGE_ID}.md carries no "${marker}" section, which is the closing ` +
          `list of pages this check reads.`,
      ).not.toBe(-1);
      const closingList = entry === undefined || at === -1 ? "" : entry.body.slice(at);
      const listed = linkTargets(closingList);

      const reachable = candidates.filter(
        (page) => SIDEBAR_IDS.includes(page.stem) && listed.includes(`./${page.stem}.md`),
      );
      expect(
        reachable.map((page) => page.filename),
        `${candidates.map((page) => `docs-content/${page.filename}`).join(", ")} documents the ` +
          `testing surface, but none of those pages is both named in docs-content/sidebars.json ` +
          `and linked from docs-content/${ENTRY_PAGE_ID}.md's closing list. A page the sidebar ` +
          `does not name ships unlinked, and the entry page's list is how a reader finds the set.`,
      ).not.toStrictEqual([]);
    });
  });

  describe("the release-status claim", () => {
    it("states the claim on exactly one page", () => {
      const pagesPerMarker = RELEASE_STATUS_MARKERS.map(({ label, pattern }) => ({
        label,
        pages: PAGES.filter((page) => pattern.test(page.body)).map((page) => page.filename),
      }));

      for (const { label, pages } of pagesPerMarker) {
        expect(
          pages,
          `${label} appears on ${pages.length === 0 ? "no page" : pages.join(", ")}. It belongs ` +
            `on exactly one, with every other page that needs it linking there: a second copy is ` +
            `a second thing to move at release time, and the copy that gets forgotten is the one ` +
            `a reader believes.`,
        ).toHaveLength(1);
      }

      const homes = new Set(pagesPerMarker.flatMap((entry) => entry.pages));
      expect(
        [...homes],
        "the parts of the release-status claim are split across pages. They are one claim and " +
          "belong in one place.",
      ).toHaveLength(1);
    });

    it("is linked, by fragment, from at least one other page", () => {
      const home = PAGES.find((page) => RELEASE_STATUS_MARKERS[0]?.pattern.test(page.body));
      expect(home, "no page carries the release-status claim").toBeDefined();
      if (home === undefined) return;

      const slugs = claimHeadingSlugs(home);
      const linkers = PAGES.filter(
        (page) =>
          page.filename !== home.filename &&
          linkTargets(page.body).some((target) => {
            const [pathPart = "", fragment] = splitTarget(target);
            return (
              pathPart === `./${home.stem}.md` && fragment !== undefined && slugs.has(fragment)
            );
          }),
      ).map((page) => page.filename);

      expect(
        linkers,
        `no other page links docs-content/${home.filename} at the section carrying the ` +
          `release-status claim. Consolidating the claim onto one page is only half of it: the ` +
          `pages that used to restate it have to point at it, or a reader who starts on one of ` +
          `them never meets the claim at all.`,
      ).not.toStrictEqual([]);
    });

    it("carries a literal version of this package on the conformance statement alone", () => {
      const version = packageVersion();
      const carriers = PAGES.filter((page) => page.raw.includes(version)).map(
        (page) => page.filename,
      );
      expect(
        carriers,
        `the literal version ${version} appears on ${carriers.join(", ")}. Only ` +
          `${VERSION_DECLARING_PAGE} may carry it: \`scripts/sync-version.mjs\` rewrites that one ` +
          `line on release, and a version anywhere else goes stale silently on the next one.`,
      ).toStrictEqual([VERSION_DECLARING_PAGE]);
    });
  });
});

// ---------------------------------------------------------------------------
// Helpers used by more than one case
// ---------------------------------------------------------------------------

/** A link target split into its path part and its fragment, either of which may be absent. */
function splitTarget(target: string): [string, string | undefined] {
  const hash = target.indexOf("#");
  if (hash === -1) return [target, undefined];
  return [target.slice(0, hash), target.slice(hash + 1)];
}

/** The slugs of the heading the release-status claim sits under, on the page that carries it. */
function claimHeadingSlugs(home: Page): Set<string> {
  const lines = withoutFencedBlocks(home.body).split("\n");
  const marker = RELEASE_STATUS_MARKERS[0]?.pattern;
  const at = marker === undefined ? -1 : lines.findIndex((line) => marker.test(line));
  const slugs = new Set<string>();
  for (let i = at; i >= 0; i -= 1) {
    const heading = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i] ?? "");
    if (heading === null) continue;
    for (const slug of slugVariants(heading[1] ?? "")) slugs.add(slug);
    break;
  }
  return slugs;
}

function packageVersion(): string {
  const parsed: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) {
    throw new Error("package.json did not parse to an object with a `version` field");
  }
  const { version } = parsed;
  if (typeof version !== "string") throw new Error("package.json `version` is not a string");
  return version;
}
