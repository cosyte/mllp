#!/usr/bin/env node
/**
 * Sync the two places that restate `package.json`'s `version`: the `VERSION` constant in
 * `src/index.ts`, and the release the published conformance statement declares.
 *
 * Why this exists: `VERSION` is a public export, but the version bump is owned by Changesets, which
 * only rewrites `package.json`. Without this step the package publishes a `VERSION` that *lies*,
 * `0.0.1` on the registry, `"0.0.0"` from the export. The `version` script (which the shared release
 * workflow invokes as `pnpm run version`) runs `changeset version` and then this, so the bump and the
 * constant always land in the same "Version Packages" commit.
 *
 * `docs-content/conformance.md` is here for the same reason and a sharper one. It is a declaration
 * an integrator may hand to a conformance reviewer, or enter in a self-declared registry statement,
 * so the release it names has to be the release it describes; a statement that describes 0.0.11
 * while claiming to be 0.0.12 is a claim about a version nobody inspected. It is a **one-line**
 * rewrite of the declared release and nothing else: no other sentence on that page is generated,
 * because the rest of it is a claim about behaviour that a human has to re-check.
 *
 * The guard against drift is the test suite: `test/sanity.test.ts` compares the export against
 * `package.json`, and `test/conformance/statement.test.ts` compares the statement's declared release
 * against it. Skipping this script makes both go red, deliberately.
 *
 * Idempotent; exits non-zero if either declaration is missing or ambiguous, a rename must not
 * silently no-op, and a decoy declaration in a comment must not be rewritten ahead of the real one.
 */
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const pkgUrl = new URL("package.json", root);

const { version } = JSON.parse(readFileSync(pkgUrl, "utf8"));
if (typeof version !== "string" || version.length === 0) {
  console.error("sync-version: package.json has no usable `version`");
  process.exit(1);
}

/**
 * Rewrite the single occurrence of `declaration` in `fileUrl` to `render(version)`.
 *
 * Exits non-zero on zero matches (a rename that would otherwise silently no-op) and on more than
 * one (ambiguous: a decoy would decide which one wins by document order).
 */
function syncOne({ fileUrl, label, what, declaration, render, onRename }) {
  const source = readFileSync(fileUrl, "utf8");
  const matches = source.match(declaration);

  if (matches === null) {
    console.error(`sync-version: could not find ${what} in ${label}.\n${onRename}`);
    process.exit(1);
  }
  if (matches.length !== 1) {
    console.error(
      `sync-version: found ${matches.length} occurrences of ${what} in ${label}; expected exactly one.\n` +
        "A decoy occurrence is ambiguous, remove it so the real declaration is unmistakable.",
    );
    process.exit(1);
  }

  // Pass a replacer *function*, not a replacement string: `String.prototype.replace` interprets
  // `$&`, `$1`, `` $` ``, etc. in a replacement string, so a version like `1.2.3-$&x` would inject
  // the matched text and corrupt the constant. A function's return value is inserted literally.
  const updated = source.replace(declaration, () => render(version));

  if (updated === source) {
    console.log(`sync-version: ${label} already ${version}`);
  } else {
    writeFileSync(fileUrl, updated);
    console.log(`sync-version: ${label} -> ${version}`);
  }
}

syncOne({
  fileUrl: new URL("src/index.ts", root),
  label: "src/index.ts VERSION",
  what: 'the `export const VERSION: string = "...";` declaration',
  declaration: /^export const VERSION: string = "[^"]*";$/gm,
  render: (v) => `export const VERSION: string = "${v}";`,
  onRename: "The declaration was renamed or reformatted, update this script alongside it.",
});

syncOne({
  fileUrl: new URL("docs-content/conformance.md", root),
  label: "docs-content/conformance.md declared release",
  what: "the `**Version declared:** `x.y.z`` line",
  declaration: /^\*\*Version declared:\*\* `[^`\n]*`$/gm,
  render: (v) => `**Version declared:** \`${v}\``,
  onRename:
    "The conformance statement must name the release whose behaviour it declares. Restore the " +
    "line, or update this script and test/conformance/statement.test.ts alongside the rewording.",
});
