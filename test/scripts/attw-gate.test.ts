/**
 * Tests for scripts/attw.mjs, the wrapper that makes the `attw` publish gate report
 * its own failure.
 *
 * WHAT THESE PIN, AND WHY EACH ONE IS HERE:
 *
 *  1. THE UPSTREAM BEHAVIOUR THE WRAPPER EXISTS FOR, EXERCISED THROUGH THIS REPO'S
 *     OWN INVOCATION. The old script was `attw --pack . --profile node16`, so every
 *     bare run below carries `--profile node16` too. `attw` prints "This package
 *     does not contain types." and exits **0**. If a future `attw` upgrade fixes
 *     that exit code or rewords the sentence, this test reds, which is the point.
 *     A guard that silently stops matching is worse than no guard, and this is the
 *     one net in `attw.mjs` that depends on a string.
 *  2. That the wrapper turns that exit 0 into a failure. Cases 1 and 2 are the same
 *     tarball through the old invocation and the new one, so the pair is the proof
 *     that the false green existed and that this change closes it. A test that only
 *     showed green on a good pack would prove neither half.
 *  3. That the preflight catches a declared-but-missing artifact, which is the shape
 *     the false green actually takes here (a `dist/` removed, or not yet written,
 *     underneath the gate).
 *  4. That the preflight reaches SUBPATH leaves, not just the root. This package
 *     declares three subpaths (`.`, `/testing`, `/ack-from-hl7`) and twelve distinct
 *     artifact paths between them, so a preflight that only checked `main`/`module`/
 *     `types` would miss two thirds of what the manifest promises.
 *  5. THAT `--profile node16` SURVIVES THE PORT. The flag is deliberate in this repo,
 *     and a wrapper that dropped it would silently widen the gate to the node10
 *     resolution this package does not support. The fixture is red without the flag
 *     and green with it, through the wrapper, so a dropped flag reds this test.
 *  6. A NEGATIVE CONTROL. On a package whose tarball really does carry types, the
 *     wrapper is transparent: same exit status as `attw` itself, and green. A gate
 *     that only ever fails is not a gate, and a false red here would cost every
 *     later run an hour.
 *  7. THE GATE'S MOST BASIC OBLIGATION, that a real `attw` failure still fails.
 *     Without this, every other test here would pass on a wrapper that swallowed
 *     attw's own exit status, because net 2 reds the untyped fixture regardless.
 *  8. The refusals that keep net 2 readable. Each of these argument and config
 *     routes was measured against this package's own untyped pack, under its own
 *     `--profile node16`, to make the untyped sentence unreadable and hand back
 *     exit 0: the exact false green this file exists to close.
 *
 * The fixtures are minimal throwaway packages in a temp dir. Nothing about this
 * repo's own build, so the test does not need one and cannot race one. Nothing here
 * touches framing, ACK correlation, or any wire path. `attw` is invoked with
 * `--no-definitely-typed` so the runs stay offline; the wrapper forwards arguments,
 * which is what makes that possible.
 *
 * PHI: every fixture is a two-line arithmetic module. No message, no identifier, no
 * clinical content of any kind reaches a tarball or a log line here.
 *
 * SECURITY: every subprocess call uses spawnSync with array args. No exec, no
 * shell-form.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = process.cwd();
const WRAPPER = join(REPO_ROOT, "scripts", "attw.mjs");
const ATTW_BIN = join(REPO_ROOT, "node_modules", ".bin", "attw");
const UNTYPED = "This package does not contain types.";
const OFFLINE = ["--no-definitely-typed"];
/** This repo's deliberate profile. Every bare run mirrors the pre-port script. */
const PROFILE = ["--profile", "node16"];
const BASE = [...OFFLINE, ...PROFILE];
// Each case shells out to `attw --pack`, which runs a real `npm pack`; two of those
// in one test comfortably exceeds this suite's 10s default.
const SPAWN_TIMEOUT = 120_000;

interface RunResult {
  code: number;
  out: string;
}

function run(bin: string, args: string[], cwd: string): RunResult {
  const r = spawnSync(bin, args, { cwd, encoding: "utf8", timeout: 180_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

const runAttw = (cwd: string, args: string[] = BASE): RunResult =>
  run(ATTW_BIN, ["--pack", ".", ...args], cwd);
const runWrapper = (cwd: string, args: string[] = BASE): RunResult =>
  run(process.execPath, [WRAPPER, ...args], cwd);

let root: string;

/** A package whose declaration file exists on disk but is left out of `files`. */
let typesNotPacked: string;
/** A package whose `package.json` points at a `dist/` that was never built. */
let noBuild: string;
/** Three subpaths, this package's shape, with one subpath's `.d.cts` missing. */
let subpathGap: string;
/** A well-formed dual ESM/CJS package: the negative control. */
let wellFormed: string;
/** A package with a real attw problem: `require` resolves to ESM. */
let attwFails: string;
/** Declarations present, JS entry point missing. attw itself is green on this. */
let jsMissing: string;
/** Green under `--profile node16`, red under the default profile. */
let node16Only: string;
/** Entry declarations gone, a shared type chunk still in the tarball. */
let chunkSurvives: string;

function writePkg(dir: string, pkg: Record<string, unknown>, files: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const full = join(dir, name);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, body);
  }
}

const ESM = "export const a = 1;\n";
const CJS = "module.exports.a = 1;\n";
const DTS = "export declare const a: number;\n";

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "attw-gate-"));

  typesNotPacked = join(root, "types-not-packed");
  writePkg(
    typesNotPacked,
    {
      name: "attw-gate-fixture-unpacked",
      version: "1.0.0",
      main: "./index.js",
      types: "./index.d.ts",
      files: ["index.js"],
    },
    { "index.js": CJS, "index.d.ts": DTS },
  );

  noBuild = join(root, "no-build");
  writePkg(
    noBuild,
    {
      name: "attw-gate-fixture-nobuild",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" } },
      files: ["dist"],
    },
    {},
  );

  // This repo's own manifest shape: three subpaths, per-condition types, everything
  // under dist/. Only ./dist/ack-from-hl7/index.d.cts is withheld, so the preflight
  // has to have walked into the third subpath's `require` branch to notice.
  subpathGap = join(root, "subpath-gap");
  writePkg(
    subpathGap,
    {
      name: "attw-gate-fixture-subpath",
      version: "1.0.0",
      type: "module",
      main: "./dist/index.cjs",
      module: "./dist/index.mjs",
      types: "./dist/index.d.ts",
      exports: {
        ".": {
          import: { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
          require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
        },
        "./testing": {
          import: { types: "./dist/testing/index.d.ts", default: "./dist/testing/index.mjs" },
          require: { types: "./dist/testing/index.d.cts", default: "./dist/testing/index.cjs" },
        },
        "./ack-from-hl7": {
          import: {
            types: "./dist/ack-from-hl7/index.d.ts",
            default: "./dist/ack-from-hl7/index.mjs",
          },
          require: {
            types: "./dist/ack-from-hl7/index.d.cts",
            default: "./dist/ack-from-hl7/index.cjs",
          },
        },
        "./package.json": "./package.json",
      },
      files: ["dist"],
    },
    {
      "dist/index.mjs": ESM,
      "dist/index.d.ts": DTS,
      "dist/index.cjs": CJS,
      "dist/index.d.cts": DTS,
      "dist/testing/index.mjs": ESM,
      "dist/testing/index.d.ts": DTS,
      "dist/testing/index.cjs": CJS,
      "dist/testing/index.d.cts": DTS,
      "dist/ack-from-hl7/index.mjs": ESM,
      "dist/ack-from-hl7/index.d.ts": DTS,
      "dist/ack-from-hl7/index.cjs": CJS,
      // ./dist/ack-from-hl7/index.d.cts deliberately absent.
    },
  );

  wellFormed = join(root, "well-formed");
  writePkg(
    wellFormed,
    {
      name: "attw-gate-fixture-wellformed",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          import: { types: "./index.d.ts", default: "./index.js" },
          require: { types: "./index.d.cts", default: "./index.cjs" },
        },
      },
      files: ["index.js", "index.d.ts", "index.cjs", "index.d.cts"],
    },
    { "index.js": ESM, "index.d.ts": DTS, "index.cjs": CJS, "index.d.cts": DTS },
  );

  // ESM-only, with no `require` condition: the node16 profile reports
  // CJSResolvesToESM and attw exits non-zero of its own accord.
  attwFails = join(root, "attw-fails");
  writePkg(
    attwFails,
    {
      name: "attw-gate-fixture-problem",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
      files: ["index.js", "index.d.ts"],
    },
    { "index.js": ESM, "index.d.ts": DTS },
  );

  jsMissing = join(root, "js-missing");
  writePkg(
    jsMissing,
    {
      name: "attw-gate-fixture-jsmissing",
      version: "1.0.0",
      main: "./dist/index.js",
      types: "./index.d.ts",
      files: ["index.d.ts"],
    },
    { "index.d.ts": DTS },
  );

  // Exports-only, everything under dist/, so node10 cannot resolve it at all.
  // Measured: exit 1 under the default profile ("node10 Resolution failed"),
  // exit 0 under --profile node16, which ignores the node10 resolution.
  // The boundary case, and it is specific to how tsup builds this package. The
  // entry declarations are absent but a shared type chunk is still in the tarball,
  // so `analysis.types` is truthy, the problem list IS consulted, and attw reds of
  // its own accord. The exit-0 path needs ZERO declarations in the tarball.
  chunkSurvives = join(root, "chunk-survives");
  writePkg(
    chunkSurvives,
    {
      name: "attw-gate-fixture-chunk",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          import: { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
          require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
        },
      },
      files: ["dist"],
    },
    {
      "dist/index.mjs": ESM,
      "dist/index.cjs": CJS,
      // The entry declarations are absent; only the shared chunk ships.
      "dist/shared-chunk.d.ts": DTS,
    },
  );

  node16Only = join(root, "node16-only");
  writePkg(
    node16Only,
    {
      name: "attw-gate-fixture-node16only",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": {
          import: { types: "./dist/index.d.ts", default: "./dist/index.mjs" },
          require: { types: "./dist/index.d.cts", default: "./dist/index.cjs" },
        },
      },
      files: ["dist"],
    },
    {
      "dist/index.mjs": ESM,
      "dist/index.d.ts": DTS,
      "dist/index.cjs": CJS,
      "dist/index.d.cts": DTS,
    },
  );
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("attw's own exit code under this repo's invocation (why the wrapper exists)", () => {
  it(
    "reports an untyped pack and still exits 0",
    () => {
      // This is verbatim the pre-port script: attw --pack . --profile node16.
      const r = runAttw(typesNotPacked);
      expect(r.out).toContain(UNTYPED);
      // If this ever fails because the status is now non-zero, attw has fixed the
      // early return in getExitCode() and net 2 of scripts/attw.mjs is redundant.
      // Read that file's header before deleting anything.
      expect(r.code).toBe(0);
    },
    SPAWN_TIMEOUT,
  );
});

describe("scripts/attw.mjs", () => {
  it(
    "fails on the same tarball where the old invocation exited 0",
    () => {
      const r = runWrapper(typesNotPacked);
      expect(r.out).toContain(UNTYPED);
      expect(r.code).not.toBe(0);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "fails, naming the file, when a declared artifact was never built",
    () => {
      const r = runWrapper(noBuild);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("./dist/index.d.ts");
      expect(r.out).toContain("missing");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "reaches a subpath's require branch, not just the root entry",
    () => {
      const r = runWrapper(subpathGap);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("./dist/ack-from-hl7/index.d.cts");
      // The eleven present artifacts must NOT be reported, or the failure stops
      // naming the one file that matters.
      expect(r.out).not.toContain("./dist/testing/index.d.cts");
      expect(r.out).not.toContain("./dist/index.d.cts (");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "does not promise attw would have exited 0, because with a chunk left it does not",
    () => {
      // THE BOUNDARY. "Declarations missing" is NOT the same condition as "attw
      // exits 0": the exit-0 path needs the tarball to carry no declaration at all.
      // With a shared type chunk still shipping, attw consults the problem list and
      // reds honestly, so the preflight must not claim the exit-0 counterfactual.
      const bare = runAttw(chunkSurvives);
      expect(bare.out).not.toContain(UNTYPED);
      expect(bare.code).not.toBe(0);

      const r = runWrapper(chunkSurvives);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("./dist/index.d.ts");
      // The old wording asserted attw "would have reported ... and EXITED 0 on this
      // tree", which is false here. Restoring it reds this assertion.
      expect(r.out).not.toContain(`reported "${UNTYPED}" and EXITED 0`);
      expect(r.out).not.toContain("would have");
    },
    SPAWN_TIMEOUT,
  );

  it(
    "does not claim attw would have said 'untyped' when only JS is missing",
    () => {
      // Measured: with the declarations intact, bare attw reports no problems and
      // exits 0 on this fixture. The preflight still reds it, but must not tell the
      // reader something about attw's behaviour that is false for this case.
      const bare = runAttw(jsMissing);
      expect(bare.out).toContain("No problems found");
      expect(bare.code).toBe(0);
      const r = runWrapper(jsMissing);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("./dist/index.js");
      expect(r.out).not.toContain(UNTYPED);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "still fails when attw itself fails, with attw's own status",
    () => {
      const bare = runAttw(attwFails);
      expect(bare.code).not.toBe(0);
      expect(bare.out).not.toContain(UNTYPED);
      const wrapped = runWrapper(attwFails);
      expect(wrapped.code).toBe(bare.code);
    },
    SPAWN_TIMEOUT,
  );

  it(
    "is transparent on a package that really does ship types",
    () => {
      const bare = runAttw(wellFormed);
      const wrapped = runWrapper(wellFormed);
      expect(bare.out).not.toContain(UNTYPED);
      expect(wrapped.code).toBe(bare.code);
      expect(wrapped.code).toBe(0);
    },
    SPAWN_TIMEOUT,
  );
});

describe("--profile node16 survives the port", () => {
  it(
    "forwards the profile, so the node10 resolution stays ignored",
    () => {
      // Without the profile this fixture is a real attw failure, and the wrapper
      // reports it. With the profile it is green, through the wrapper, at the same
      // status bare attw gives. A wrapper that dropped the flag would red the
      // second assertion; one that ignored arguments entirely would red the first.
      const bareDefault = runAttw(node16Only, OFFLINE);
      expect(bareDefault.code).not.toBe(0);
      expect(runWrapper(node16Only, OFFLINE).code).not.toBe(0);

      const bareNode16 = runAttw(node16Only, BASE);
      expect(bareNode16.code).toBe(0);
      const wrapped = runWrapper(node16Only, BASE);
      expect(wrapped.code).toBe(0);
      expect(wrapped.out).toContain("node16");
    },
    SPAWN_TIMEOUT,
  );
});

describe("the refusals that keep the post-check readable", () => {
  // Each of these was measured, on this package's own untyped pack and under
  // --profile node16, to make bare attw exit 0 with the untyped sentence
  // unreadable.
  it.each([
    ["--quiet", ["--quiet"]],
    ["-q", ["-q"]],
    ["--format json", ["--format", "json"]],
    ["-f json", ["-f", "json"]],
    ["--format=json", ["--format=json"]],
    ["--config-path", ["--config-path", "other.json"]],
  ])(
    "refuses %s",
    (_name, extra) => {
      const r = runWrapper(typesNotPacked, [...BASE, ...extra]);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain("attw gate");
      expect(r.out).not.toContain("🌟");
    },
    // These currently return before attw is spawned, so they finish in
    // milliseconds and the suite default would do. Carry the same timeout as
    // every other case anyway: if the BLINDING check ever moves below the spawn,
    // these six start running a real `npm pack` and would go flaky rather than
    // simply failing.
    SPAWN_TIMEOUT,
  );

  it(
    "refuses a .attw.json that sets quiet or format",
    () => {
      const dir = join(root, "config-blinded");
      writePkg(
        dir,
        {
          name: "attw-gate-fixture-configblind",
          version: "1.0.0",
          main: "./index.js",
          types: "./index.d.ts",
          files: ["index.js"],
        },
        {
          "index.js": CJS,
          "index.d.ts": DTS,
          ".attw.json": JSON.stringify({ quiet: true }),
        },
      );
      // Bare attw takes the config and goes silent: exit 0 over an untyped pack.
      const bare = runAttw(dir);
      expect(bare.code).toBe(0);
      expect(bare.out).not.toContain(UNTYPED);

      const r = runWrapper(dir);
      expect(r.code).not.toBe(0);
      expect(r.out).toContain(".attw.json");
    },
    SPAWN_TIMEOUT,
  );
});
