import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  compileErrors,
  fences,
  fixturesByContent,
  section,
  wirePayloadLiteral,
} from "./_helpers/first-use.js";

/**
 * The first example under the README's `## Usage` is EXECUTED here, and the output block printed
 * beside it is the assertion. It is a complete program: it starts a server, sends one message over a
 * real loopback socket, logs the SHAPE of the acknowledgement and closes both ends, so a run that
 * leaves a listener open never exits and fails on the timeout.
 *
 * The block is READ OUT OF README.md at test time, never copied into this file. It runs in a
 * subprocess against `src/index.ts`, the single file the bundler compiles into the published entry
 * point, with only the `@cosyte/mllp` specifier rewritten (and that rewrite counted). Running against
 * the source rather than `dist/` keeps this suite out of the `dist/` rebuild
 * `test/docs-content.test.ts` performs in parallel.
 *
 * SECURITY: the subprocess is spawned with spawnSync and array args; no shell.
 */
const root = join(import.meta.dirname, "..");
const readme = readFileSync(join(root, "README.md"), "utf8");
const entryPoint = join(root, "src", "index.ts");
const tsx = join(root, "node_modules", ".bin", "tsx");
const PUBLISHED_SPECIFIER = '"@cosyte/mllp"';
const FIXTURE_DIR = join(root, "test", "fixtures", "first-use");
const CASE_TIMEOUT = 120_000;

const usage = fences(section(readme, "## Usage"));
const example = usage[0];
const shown = usage[1];

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mllp-readme-usage-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function run(source: string, fileName: string): { code: number; stdout: string; stderr: string } {
  expect(source.split(PUBLISHED_SPECIFIER).length - 1, "imports @cosyte/mllp exactly once").toBe(1);
  const path = join(dir, fileName);
  writeFileSync(
    path,
    `${source.replace(PUBLISHED_SPECIFIER, JSON.stringify(entryPoint))}\n`,
    "utf8",
  );
  const r = spawnSync(tsx, [path], { cwd: root, encoding: "utf8", shell: false, timeout: 60_000 });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
}

describe("the README ## Usage example", () => {
  it("AC-ML2: the first block under ## Usage is the TypeScript example, the next its output", () => {
    expect(example?.lang).toBe("ts");
    expect(shown?.lang).toBe("text");
  });

  it(
    "AC-ML2, AC-ML5: runs to exit twice in succession, printing exactly the output shown",
    () => {
      for (const attempt of ["usage-1.mts", "usage-2.mts"]) {
        const r = run(example?.body ?? "", attempt);
        expect(r.stderr, attempt).toBe("");
        expect(r.code, attempt).toBe(0);
        expect(r.stdout, attempt).toBe(`${shown?.body ?? ""}\n`);
      }
    },
    CASE_TIMEOUT,
  );

  it(
    "AC-ML2: compiles in a new TypeScript project against the package's types",
    () => {
      expect(compileErrors(root, "@cosyte/mllp", entryPoint, example?.body ?? "")).toEqual([]);
    },
    CASE_TIMEOUT,
  );

  it(
    "AC-ML2: a block that does not compile is reported, so it turns this suite red",
    () => {
      const body = example?.body ?? "";
      expect(body.split("msa?.[1]").length - 1).toBe(1);
      const mutated = body.replace("msa?.[1]", "msa[1]");
      expect(compileErrors(root, "@cosyte/mllp", entryPoint, mutated)).toEqual([
        expect.stringContaining("TS18048"),
      ]);
    },
    CASE_TIMEOUT,
  );

  it("AC-ML4: the message it sends is a byte-for-byte copy of a first-use fixture", () => {
    const payload = wirePayloadLiteral(example?.body ?? "");
    expect(payload).toBeDefined();
    expect(fixturesByContent(root, FIXTURE_DIR).get(payload ?? "")).toBeDefined();
  });

  it(
    "AC-ML3: a changed input value changes the output and leaves the fixture corpus",
    () => {
      const body = example?.body ?? "";
      expect(body.split("|CTRL0001|").length - 1, "the message carries one CTRL0001").toBe(1);
      const mutated = body.replace("|CTRL0001|", "|CTRL0002|");
      expect(
        fixturesByContent(root, FIXTURE_DIR).get(wirePayloadLiteral(mutated) ?? ""),
      ).toBeUndefined();
      const r = run(mutated, "usage-control.mts");
      expect(r.code).toBe(0);
      expect(r.stdout).not.toBe(`${shown?.body ?? ""}\n`);
      expect(r.stdout).toContain("MSA-2 echoes the control id sent: false");
    },
    CASE_TIMEOUT,
  );
});
