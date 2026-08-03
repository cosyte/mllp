#!/usr/bin/env node
/**
 * scripts/attw.mjs: the `attw` publish gate, made to report its own failure.
 *
 * ▶ WHY THIS WRAPPER EXISTS: `attw` PRINTS "This package does not contain types."
 *   AND EXITS 0. That is not a bug in `attw`. An untyped package is a legitimate
 *   npm package, so the CLI treats "no types at all" as a *description*, not a
 *   problem. From this repo's own `@arethetypeswrong/cli@0.18.4`,
 *   `node_modules/@arethetypeswrong/cli/dist/getExitCode.js`, first statement:
 *
 *       export function getExitCode(analysis, opts) {
 *           if (!analysis.types) {
 *               return 0;
 *           }
 *
 *   The problem list is consulted only *after* that early return, so no
 *   `--profile`, `--ignore-rules` or config setting can reach it. For a package
 *   that ships types, "does not contain types" does not mean "fine, untyped".
 *   It means THE TYPES WERE NOT IN THE TARBALL, which is a broken publish. The
 *   gate said nothing, and its caller read the 0. A false red costs an hour;
 *   A FALSE GREEN MERGES.
 *
 * ▶ MEASURED HERE, ON THIS PACKAGE, AT 0.0.6, WITH ZERO CONCURRENCY, under the old
 *   script `attw --pack . --profile node16`:
 *
 *       rm -rf dist && pnpm attw            -> "does not contain types", EXIT 0
 *
 *   ▶ AND THE BOUNDARY, WHICH IS SPECIFIC TO THIS PACKAGE AND WAS MEASURED RATHER
 *     THAN ASSUMED. The exit-0 path needs the tarball to carry NO declaration file
 *     AT ALL. `tsup` emits a shared type chunk (`dist/index-<hash>.d.ts`) beside the
 *     three entry declarations, so deleting only the six entry `.d.ts`/`.d.cts`
 *     files leaves that chunk in the tarball, `analysis.types` is truthy, the
 *     problem list IS consulted, and attw reds honestly:
 *
 *       rm -f dist/index.d.ts dist/index.d.cts \
 *             dist/testing/index.d.*ts dist/ack-from-hl7/index.d.*ts && pnpm attw
 *                                         -> "❌ No types" (UntypedResolution), EXIT 1
 *
 *       ...and the same removal PLUS dist/index-*.d.*ts
 *                                         -> "does not contain types", EXIT 0
 *
 *     Do not restate this as "missing declarations exit 0". Missing SOME of them
 *     does not. That distinction is why the die message below refuses to promise
 *     which way attw would have gone.
 *
 *   The build window is the realistic trigger, and it lands squarely in the exit-0
 *   state, because `tsup` writes JS in one pass and EVERY declaration in a later
 *   one: there is no moment where only some exist. Polling two real clean builds
 *   here for `dist/index.mjs` and then for the FIRST declaration file of any kind
 *   gave windows of 4.25s and 3.31s, with `dist/` holding `.mjs`/`.cjs` and ZERO
 *   declarations throughout. DO NOT WRITE A SINGLE FIGURE DOWN AS THE WINDOW: the
 *   absolute timings move run to run and with machine load. The stable, and
 *   sufficient, claim is that the gap is SECONDS rather than milliseconds, which is
 *   wide enough for a concurrent build or `pnpm clean` in the same working tree to
 *   land `attw` in it. Which is why this is not answered with a lock or a build
 *   queue: the gate is supposed to be able to tell you its own inputs were missing,
 *   whatever removed them.
 *
 * ▶ THIS PACKAGE HAS THREE SUBPATHS, SO THE PREFLIGHT HAS TWELVE FILES TO CHECK,
 *   not the four a single-entry sibling has. `.`, `./testing` and `./ack-from-hl7`
 *   each declare a `.d.ts`/`.mjs` pair for `import` and a `.d.cts`/`.cjs` pair for
 *   `require`, and `main`/`module`/`types` name three of those again. Deduped,
 *   that is the set below. `./package.json` is skipped (always in the tarball).
 *
 * ▶ TWO NETS, and they catch different things. Keep both:
 *
 *   1. PREFLIGHT (structural, no string matching). Every relative artifact path
 *      `package.json` promises (`main`, `module`, `types`, `typings`, and every
 *      string leaf of `exports`) must exist and be non-empty before `attw` runs.
 *      This is the one that catches the build window measured above, and it names
 *      the missing file instead of leaving the reader to infer it.
 *
 *   2. POST-CHECK. If `attw` still reports an untyped package, fail. The preflight
 *      cannot see this case: the declaration files can be present on disk and
 *      still be absent from the tarball, because `files` (or `.npmignore`) left
 *      them out. No instance of that is on record in this repo. It is the case
 *      `attw --pack` exists to catch, and the whole point here is that it catches
 *      it silently.
 *
 *   DISCLOSED GAP, because it is specific to how this package is built: `tsup`
 *   emits a SHARED TYPE CHUNK (`dist/index-<hash>.d.ts` / `.d.cts`) that the three
 *   entry declarations import and that `package.json` names nowhere. The preflight
 *   checks only what the manifest promises, so it cannot see that chunk go missing.
 *   That is a real hole in net 1 and not a hypothetical, since the filename carries
 *   a content hash and so changes on most builds. It is left to net 2 and to `attw`
 *   itself rather than papered over with a glob, because a glob would have to guess
 *   which unnamed files are load-bearing.
 *
 *   The post-check matches `attw`'s untyped sentence, which is a plain, un-chalked
 *   string in `dist/render/untyped.js` (read there, not assumed). That makes it
 *   blindable, so the arguments and config that would blind it are REFUSED rather
 *   than tolerated. See BLINDING below. `test/scripts/attw-gate.test.ts` pins both
 *   nets against the real binary, so if an `attw` upgrade reworks the wording or
 *   fixes the exit code, the suite reds and tells you to revisit this file rather
 *   than letting the net go quietly slack.
 *
 * ▶ BLINDING. Three routes were re-measured HERE, against this package's own
 *   untyped pack and under its own `--profile node16`, each restoring the exact
 *   false green by making the sentence absent from what this script can read:
 *   `--quiet` (exit 0, sentence gone), `--format json` (exit 0, sentence gone),
 *   and a `.attw.json` setting either, which `readConfig()` applies after argv
 *   (exit 0, sentence gone). All are refused below, along with `--config-path`,
 *   which would move the config file out of view. That one is refused by
 *   inference, not because it was measured. Bare `--profile node16` exits 0 in all three cases
 *   too, so refusing is not a regression against the old script. It is the
 *   difference between a gate and a gate-shaped thing.
 *
 *   The refusal is BY OPTION NAME, WHOLESALE, not by value. `--format table-flipped`
 *   still prints the sentence and blinds nothing, and is refused anyway. That is
 *   the deliberate trade: value-parsing these would be a third moving part in the
 *   guard, and being over-strict about an argument nobody passes to a repo's own
 *   publish gate costs less than a route back to a false green.
 *
 * Other arguments are forwarded, so `--profile node16` still works, unchanged.
 * package.json passes it and this repo wants it, because the per-condition `types`
 * layout that profile checks is exactly what the three subpaths above declare.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ATTW_BIN = fileURLToPath(new URL("../node_modules/.bin/attw", import.meta.url));
const UNTYPED = "This package does not contain types.";
const DECLARATION = /\.d\.[cm]?ts$/;
const args = process.argv.slice(2);

const die = (msg) => {
  process.stderr.write(`\n✗ attw gate: ${msg}\n`);
  process.exit(1);
};

// ---- Refuse what would blind the post-check --------------------------------
const BLINDING = new Set(["-q", "--quiet", "-f", "--format", "--config-path"]);
const blinding = args.filter((a) => BLINDING.has(a.split("=")[0]));
if (blinding.length > 0) {
  die(
    `${blinding.join(", ")} is refused wholesale, by option name and not by value.\n` +
      `  This gate reads attw's printed output, attw exits 0 on an untyped package,\n` +
      `  and some values of these options hide that output. Run it without them.`,
  );
}
try {
  const config = JSON.parse(readFileSync(".attw.json", "utf8"));
  const set = ["quiet", "format"].filter((k) => k in config);
  if (set.length > 0) {
    die(
      `.attw.json sets ${set.join(", ")}. These keys are refused wholesale, by name and\n` +
        `  not by value: readConfig() applies them after argv, this gate reads attw's\n` +
        `  printed output, and attw exits 0 on an untyped package.`,
    );
  }
} catch {
  // No .attw.json, or unreadable/invalid. attw itself reports the latter.
}

/** Every relative path `package.json` promises to ship, deduped. */
function declaredArtifacts(pkg) {
  const found = new Set();
  const add = (v) => {
    if (typeof v !== "string") return;
    // Skip wildcard subpath patterns (they name a set, not a file) and the
    // manifest itself, which is always in the tarball by definition.
    if (!v.startsWith(".") || v.includes("*") || v === "./package.json") return;
    found.add(v);
  };
  for (const key of ["main", "module", "types", "typings"]) add(pkg[key]);
  const walk = (node) => {
    if (typeof node === "string") add(node);
    else if (node && typeof node === "object") for (const v of Object.values(node)) walk(v);
  };
  walk(pkg.exports);
  return [...found];
}

let pkg;
try {
  pkg = JSON.parse(readFileSync("package.json", "utf8"));
} catch (err) {
  die(`cannot read ./package.json from ${process.cwd()}: ${err.message}`);
}

// ---- Net 1: preflight -------------------------------------------------------
const broken = [];
for (const rel of declaredArtifacts(pkg)) {
  let size;
  try {
    size = statSync(rel).size;
  } catch {
    broken.push({ rel, why: "missing" });
    continue;
  }
  if (size === 0) broken.push({ rel, why: "empty" });
}
if (broken.length > 0) {
  // Say what attw's exit code is worth here, and DO NOT promise which way it would
  // have gone. Measured on this package: with every declaration gone from the
  // tarball it prints the untyped sentence and exits 0, but with tsup's shared type
  // chunk still present it reds honestly at UntypedResolution. The preflight cannot
  // see that chunk (package.json names it nowhere), so it cannot tell the two apart
  // and must not pretend to. With the declarations intact and only JS missing, attw
  // reports no problems at all and still exits 0: a different silence, not this one.
  const declarationsHit = broken.some(({ rel }) => DECLARATION.test(rel));
  die(
    `package.json promises files the build has not produced:\n` +
      broken.map(({ rel, why }) => `    ${rel} (${why})\n`).join("") +
      `\n  Run the build first. If you DID build, something removed or truncated the\n` +
      `  output underneath this run. A concurrent build or \`clean\` in the same\n` +
      `  working tree will do it, and \`tsup\` writes JS before declarations, so there\n` +
      `  is a window where the .d.ts files do not exist yet.\n` +
      (declarationsHit
        ? `  Declarations are among them, so attw's own exit code cannot decide this:\n` +
          `  if NO declaration reaches the tarball it reports "${UNTYPED}"\n` +
          `  and EXITS 0, and if some still do (tsup's shared type chunk is not named in\n` +
          `  package.json, so this check cannot see it) it reds instead. Reported here.\n`
        : `  attw does not gate these: it analyses types, and exits 0 here.\n`),
  );
}

// ---- Run attw ---------------------------------------------------------------
const res = spawnSync(ATTW_BIN, ["--pack", ".", ...args], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "pipe"],
});
if (res.error) die(`could not run ${ATTW_BIN}: ${res.error.message}`);
const output = `${res.stdout ?? ""}${res.stderr ?? ""}`;
process.stdout.write(res.stdout ?? "");
process.stderr.write(res.stderr ?? "");
if (res.status !== 0) process.exit(res.status ?? 1);

// ---- Net 2: post-check ------------------------------------------------------
// An empty transcript means the post-check read nothing, by some route not listed
// under BLINDING above. Treat that as a failure rather than as a pass: this gate
// is only as good as the output it got to see.
if (output.trim() === "") {
  die(`attw exited 0 but printed nothing, so nothing was checked.`);
}
if (output.includes(UNTYPED)) {
  die(
    `attw reported "${UNTYPED}" and exited 0.\n` +
      `  This package ships types, so that means the tarball did not carry them,\n` +
      `  check the "files" field and .npmignore. Reported as a failure here because\n` +
      `  attw's own exit code cannot: getExitCode() returns 0 whenever the analysis\n` +
      `  found no types at all, before it ever looks at the problem list.`,
  );
}
