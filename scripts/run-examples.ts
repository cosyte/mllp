/**
 * Runs every example in `examples/` against the BUILT package, and fails if any of them fails.
 *
 * Each top-level `examples/*.ts` (a name starting with `_` is skipped) imports this package by its
 * published name, which Node resolves through the package's own `exports` map to `dist/`: the files
 * a consumer installs, not the source tree. Every example checks its own key output and exits
 * non-zero on a mismatch, so the exit status is the verdict here. The output of every example is
 * printed, a failing one's stderr included.
 *
 * It refuses (exit 2) rather than reporting green when there is nothing real to run: no build to
 * import, or no example at all.
 *
 *     pnpm build && pnpm examples
 *
 * SECURITY: every path reaches spawnSync as an argv element, never through a shell.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const EXAMPLES_DIR = join(ROOT, "examples");
const BUILT_ENTRY = join(ROOT, "dist", "index.mjs");
const TIMEOUT_MS = 60_000;

/** tsx runs the TypeScript. It resolves `tsconfig.json` from the working directory (the repo root), which maps no paths, so the package name resolves through `exports`. */
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

function refuse(reason: string): never {
  console.error(`[examples] REFUSED: ${reason}`);
  process.exit(2);
}

function indent(text: string): string {
  return text
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

if (!existsSync(BUILT_ENTRY)) {
  refuse(
    `${BUILT_ENTRY} does not exist. The examples import the built package: run \`pnpm build\` first.`,
  );
}

const examples = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.startsWith("_"))
  .map((entry) => entry.name)
  .sort();

if (examples.length === 0) refuse(`no example found under ${EXAMPLES_DIR}`);

let failed = 0;
for (const file of examples) {
  const result = spawnSync(process.execPath, [TSX_CLI, join("examples", file)], {
    cwd: ROOT,
    encoding: "utf8",
    shell: false,
    timeout: TIMEOUT_MS,
  });

  if (result.status === 0) {
    console.log(`OK   ${file}`);
    if (result.stdout.trim().length > 0) console.log(indent(result.stdout));
    continue;
  }

  failed += 1;
  const how =
    result.error !== undefined
      ? result.error.message
      : `exit ${String(result.status)}${result.signal === null ? "" : `, signal ${result.signal}`}`;
  console.error(`FAIL ${file} (${how})`);
  if (result.stdout.trim().length > 0) console.error(indent(result.stdout));
  if (result.stderr.trim().length > 0) console.error(indent(result.stderr));
}

console.log(`[examples] ${String(examples.length - failed)} of ${String(examples.length)} passed`);
process.exit(failed === 0 ? 0 : 1);
