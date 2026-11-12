/**
 * Tests for the mutant shards of the pull request mutation job (`scripts/mutation-shards.mjs`,
 * `scripts/merge-mutation-parts.mjs`, `stryker.config.mjs` and the `mutation` jobs in
 * `.github/workflows/ci.yml`).
 *
 * WHY THIS FILE EXISTS. The job that mutates a pull request's changed files ran on one runner and
 * came within minutes of its 60 minute limit on a change to the client and the server together. It
 * now runs in parts, each testing a share of the mutants. A split like that can lose a mutant
 * quietly: a mutant no part tests never survives, so the score only looks better. These tests
 * hold that it cannot:
 *
 *  1. Over every file StrykerJS mutates, with StrykerJS's own instrumenter, the parts' reports
 *     merge into exactly the mutants a single run generates (same ids, same mutations), each
 *     tested by exactly one part, and the large files are shared out evenly enough to matter.
 *  2. The merge refuses every way the parts can fail to add up: a mutant tested by no part, by
 *     two, a part that mutated other files or read other source.
 *  3. With the variable unset, the StrykerJS config is the shared one, as the weekly full run uses
 *     it; set, only the ignorer is added, and never together with the file shards.
 *  4. The workflow wires it: the shared job is off, every part runs, the merge names the same
 *     count, and the check that reports the result fails when a part did not finish.
 */
import { describe, expect, it } from "vitest";

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { expandMutate, loadConfig } from "@cosyte/vitest-config/mutate";

import { RUNTIME } from "../_helpers/runtime.js";

import {
  FILE_SHARD_VARIABLE,
  IGNORER_NAME,
  SHARD_VARIABLE,
  ShardMergeError,
  createShardIgnorer,
  mergeShardReports,
  parseShard,
  shardReason,
  strykerPlugins,
  withMutantShards,
} from "../../scripts/mutation-shards.mjs";

const ROOT = resolve(import.meta.dirname, "../..");
const PARTS = 4;

interface ApiMutant {
  id: string;
  fileName: string;
  mutatorName: string;
  replacement: string;
  location: unknown;
  status?: string;
  statusReason?: string;
}

interface InstrumenterModule {
  Instrumenter: new (logger: unknown) => {
    instrument(
      files: { name: string; mutate: boolean; content: string }[],
      options: Record<string, unknown>,
    ): Promise<{ mutants: ApiMutant[] }>;
  };
}

const silent = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  trace: () => undefined,
  fatal: () => undefined,
  isDebugEnabled: () => false,
  isInfoEnabled: () => false,
  isTraceEnabled: () => false,
  isWarnEnabled: () => false,
  isErrorEnabled: () => false,
  isFatalEnabled: () => false,
};

/** StrykerJS's instrumenter, the one `@stryker-mutator/core` runs, resolved from core's install. */
async function loadInstrumenter(): Promise<InstrumenterModule> {
  const fromRoot = createRequire(join(ROOT, "package.json"));
  const core = fromRoot.resolve("@stryker-mutator/core/package.json");
  const path = createRequire(core).resolve("@stryker-mutator/instrumenter");
  return (await import(pathToFileURL(path).href)) as InstrumenterModule;
}

/** A report in the shape StrykerJS writes, from instrumented mutants. */
function asReport(mutants: ApiMutant[], sources: Map<string, string>): unknown {
  const files: Record<string, { language: string; source: string; mutants: unknown[] }> = {};
  for (const m of mutants) {
    const entry = (files[m.fileName] ??= {
      language: "typescript",
      source: sources.get(m.fileName) ?? "",
      mutants: [],
    });
    entry.mutants.push({
      id: m.id,
      mutatorName: m.mutatorName,
      replacement: m.replacement,
      location: m.location,
      // A tested mutant's status in a real run; the instrumenter leaves it unset.
      status: m.status ?? "Killed",
      ...(m.statusReason === undefined ? {} : { statusReason: m.statusReason }),
    });
  }
  return { schemaVersion: "2", thresholds: { high: 100, low: 90 }, files };
}

const mutationKey = (m: {
  id: string;
  mutatorName: string;
  replacement: string;
  location: unknown;
}) => `${m.id} ${m.mutatorName} ${m.replacement} ${JSON.stringify(m.location)}`;

// StrykerJS and the merge run on Node.js only, in CI's mutation jobs, so the cases that load the
// instrumenter or start the merge script are skipped under Bun and Deno.
describe.skipIf(RUNTIME !== "node")(
  "the parts of a mutation run, with StrykerJS's own instrumenter",
  () => {
    it("merge into exactly the mutants one run generates, each tested by one part", async () => {
      const config = await loadConfig(join(ROOT, "stryker.config.mjs"));
      const names = expandMutate({ cwd: ROOT, patterns: config["mutate"] });
      expect(names).toContain("src/client/client.ts");
      expect(names).toContain("src/server/server.ts");
      const sources = new Map(names.map((name) => [name, readFileSync(join(ROOT, name), "utf8")]));
      const files = names.map((name) => ({ name, mutate: true, content: sources.get(name) ?? "" }));
      const { Instrumenter } = await loadInstrumenter();
      const run = async (ignorers: unknown[]) =>
        (
          await new Instrumenter(silent).instrument(files, {
            ignorers,
            excludedMutations: [],
            plugins: null,
          })
        ).mutants;

      const whole = await run([]);
      const parts: ApiMutant[][] = [];
      for (let k = 1; k <= PARTS; k += 1)
        parts.push(await run([createShardIgnorer({ k, n: PARTS })]));

      const { report, summary } = mergeShardReports(parts.map((p) => asReport(p, sources)));
      const merged = Object.entries(report.files).flatMap(([file, entry]) =>
        (entry.mutants as ApiMutant[]).map((m) => ({ ...m, fileName: file })),
      );
      // The same mutants a single run makes, by id and by mutation, none left out and none added.
      expect(merged.map(mutationKey).sort()).toEqual(whole.map(mutationKey).sort());
      expect(new Set(merged.map((m) => m.fileName))).toEqual(new Set(whole.map((m) => m.fileName)));
      expect(summary.mutants).toBe(whole.length);
      expect(summary.tested.reduce((a, b) => a + b, 0) + summary.ignored).toBe(whole.length);
      expect(summary.ignored).toBe(whole.filter((m) => m.status === "Ignored").length);
      // A comment or a static rule that ignores a mutant in one run ignores it in the merge too.
      const reasonOf = new Map(whole.map((m) => [mutationKey(m), m.statusReason]));
      for (const m of merged) expect(m.statusReason).toBe(reasonOf.get(mutationKey(m)));

      // The two files the job was too slow on are each shared out: no part tests more than a third
      // of either, or fewer than a sixth.
      for (const file of ["src/client/client.ts", "src/server/server.ts"]) {
        const total = whole.filter((m) => m.fileName === file).length;
        for (const part of parts) {
          const own = part.filter((m) => m.fileName === file && m.status !== "Ignored").length;
          expect(own, `${file}: ${own} of ${total}`).toBeLessThanOrEqual(total / 3);
          expect(own, `${file}: ${own} of ${total}`).toBeGreaterThanOrEqual(total / 6);
        }
      }
    }, 120_000); // Five instrumenter runs over every source file: about ten seconds on a laptop.
  },
);

/** A one-file report whose mutants are given as [id, status, reason?, mutator?]. */
function partReport(rows: [string, string, string?, string?][], source = "a()"): unknown {
  return {
    schemaVersion: "2",
    files: {
      "src/a.ts": {
        language: "typescript",
        source,
        mutants: rows.map(([id, status, reason, mutator]) => ({
          id,
          mutatorName: mutator ?? "BooleanLiteral",
          replacement: "false",
          location: {
            start: { line: Number(id), column: 1 },
            end: { line: Number(id), column: 5 },
          },
          status,
          ...(reason === undefined ? {} : { statusReason: reason }),
        })),
      },
    },
  };
}

const left = (part: number, n = 2) => shardReason(part, n);

describe("merging the parts", () => {
  it("keeps each mutant from the part that tested it", () => {
    const { report, summary } = mergeShardReports([
      partReport([
        ["0", "Killed"],
        ["1", "Ignored", left(2)],
      ]),
      partReport([
        ["0", "Ignored", left(1)],
        ["1", "Survived"],
      ]),
    ]);
    const mutants = report.files["src/a.ts"]?.mutants as { id: string; status: string }[];
    expect(mutants.map((m) => [m.id, m.status])).toEqual([
      ["0", "Killed"],
      ["1", "Survived"],
    ]);
    expect(summary).toEqual({
      files: ["src/a.ts"],
      mutants: 2,
      tested: [1, 1],
      ignored: 0,
      removed: 0,
    });
  });

  it("refuses a mutant no part tested", () => {
    expect(() =>
      mergeShardReports([
        partReport([["0", "Ignored", left(2)]]),
        partReport([["0", "Ignored", left(2)]]),
      ]),
    ).toThrow(ShardMergeError);
    expect(() =>
      mergeShardReports([
        partReport([["0", "Ignored", left(2)]]),
        partReport([["0", "Ignored", left(2)]]),
      ]),
    ).toThrow(/tested by no part/);
    // Even when its own part has no entry for it, unless StrykerJS's own rule removed it there.
    expect(() =>
      mergeShardReports([partReport([["0", "Ignored", left(2)]]), partReport([])]),
    ).toThrow(/tested by no part/);
  });

  it("leaves out only an emptied call its own part never generated, as a single run does", () => {
    const { report, summary } = mergeShardReports([
      partReport([["0", "Ignored", left(2), "CallExpression"]]),
      partReport([]),
    ]);
    expect(report.files["src/a.ts"]?.mutants).toEqual([]);
    expect(summary.removed).toBe(1);
  });

  it("refuses a mutant two parts tested, or one left to two parts", () => {
    expect(() =>
      mergeShardReports([partReport([["0", "Killed"]]), partReport([["0", "Killed"]])]),
    ).toThrow(/tested by parts 1 and 2/);
    expect(() =>
      mergeShardReports([
        partReport([["0", "Ignored", left(2, 3)]]),
        partReport([["0", "Ignored", left(3, 3)]]),
        partReport([["0", "Ignored", left(2, 3)]]),
      ]),
    ).toThrow(/left to parts/);
  });

  it("refuses a mutant missing from a part that should list it", () => {
    expect(() => mergeShardReports([partReport([["0", "Killed"]]), partReport([])])).toThrow(
      /part 2 has no mutant 0/,
    );
  });

  it("refuses parts that mutated different files or read different source", () => {
    expect(() => mergeShardReports([partReport([["0", "Killed"]]), { files: {} }])).toThrow(
      /every part must mutate the same files/,
    );
    expect(() =>
      mergeShardReports([
        partReport([["0", "Ignored", left(2)]]),
        partReport([["0", "Killed"]], "b()"),
      ]),
    ).toThrow(/different source/);
  });

  it("refuses a reason that names another split", () => {
    expect(() =>
      mergeShardReports([
        partReport([["0", "Ignored", left(2, 3)]]),
        partReport([["0", "Killed"]]),
      ]),
    ).toThrow(/in a run of 2 parts/);
  });

  it("keeps a mutant a comment ignored in every part, once, as ignored", () => {
    const { report, summary } = mergeShardReports([
      partReport([["0", "Ignored", "equivalent"]]),
      partReport([["0", "Ignored", "equivalent"]]),
    ]);
    expect(report.files["src/a.ts"]?.mutants).toMatchObject([
      { status: "Ignored", statusReason: "equivalent" },
    ]);
    expect(summary).toMatchObject({ mutants: 1, tested: [0, 0], ignored: 1 });
  });

  it("keeps a mutant StrykerJS found static, from the part that owns it", () => {
    const { report, summary } = mergeShardReports([
      partReport([["0", "Ignored", left(2)]]),
      partReport([["0", "Ignored", "Static mutant"]]),
    ]);
    expect(report.files["src/a.ts"]?.mutants).toMatchObject([
      { status: "Ignored", statusReason: "Static mutant" },
    ]);
    expect(summary).toMatchObject({ mutants: 1, tested: [0, 1], ignored: 0 });
  });

  it("names each part's tests apart", () => {
    const withTests = (part: number) => {
      const r = partReport(part === 1 ? [["0", "Killed"]] : [["0", "Ignored", left(1)]]) as {
        files: Record<string, { mutants: Record<string, unknown>[] }>;
      };
      const m = r.files["src/a.ts"]?.mutants[0];
      if (m !== undefined) Object.assign(m, { killedBy: ["7"], coveredBy: ["7"] });
      return { ...r, testFiles: { "test/a.test.ts": { tests: [{ id: "7", name: "a" }] } } };
    };
    const { report } = mergeShardReports([withTests(1), withTests(2)]);
    expect(report.files["src/a.ts"]?.mutants).toMatchObject([
      { killedBy: ["part-1/7"], coveredBy: ["part-1/7"] },
    ]);
    expect(report["testFiles"]).toEqual({
      "test/a.test.ts": {
        tests: [
          { id: "part-1/7", name: "a" },
          { id: "part-2/7", name: "a" },
        ],
      },
    });
  });
});

describe.skipIf(RUNTIME !== "node")("merge-mutation-parts.mjs", () => {
  /** Run the merge over the given part reports, against HEAD, in a fresh directory. */
  function merge(parts: unknown[]) {
    const dir = mkdtempSync(join(tmpdir(), "mllp-mutation-parts-"));
    try {
      parts.forEach((report, i) => {
        if (report === null) return;
        const into = join(dir, `mutation-part-${i + 1}-of-${parts.length}`);
        mkdirSync(into);
        writeFileSync(join(into, "changed.json"), JSON.stringify(report));
      });
      const out = join(dir, "changed.json");
      const run = spawnSync(
        process.execPath,
        [
          join(ROOT, "scripts/merge-mutation-parts.mjs"),
          ...["--parts", String(parts.length), "--dir", dir, "--base", "HEAD", "--out", out],
        ],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: "" } },
      );
      let written: unknown = null;
      if (run.status === 0) written = JSON.parse(readFileSync(out, "utf8"));
      return { status: run.status, stdout: run.stdout, stderr: run.stderr, written };
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const empty = { schemaVersion: "2", files: {} };

  it("writes the merged report when the parts add up", () => {
    const result = merge([empty, empty]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.written).toMatchObject({ files: {}, projectRoot: ROOT });
    expect(result.stdout).toContain("each owned by exactly one part (part 1: 0, part 2: 0)");
  });

  it("refuses a part that left no report", () => {
    const result = merge([empty, null]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("part 2 of 2 left no report");
  });

  it("refuses a file the change did not touch", () => {
    const stray = partReport([["0", "Killed"]]);
    const result = merge([stray, partReport([["0", "Ignored", left(1)]])]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('["src/a.ts"], which the change against HEAD did not touch');
  });
});

describe("the StrykerJS config", () => {
  const base = { mutate: ["src/**/*.ts"], plugins: ["/runner.js"], thresholds: { break: null } };

  it("is the shared config, untouched, when no part is named", () => {
    expect(withMutantShards(base, {}, "/shards.mjs")).toBe(base);
    expect(withMutantShards(base, { [SHARD_VARIABLE]: "" }, "/shards.mjs")).toBe(base);
  });

  it("adds only the ignorer when a part is named", () => {
    expect(withMutantShards(base, { [SHARD_VARIABLE]: "2/4" }, "/shards.mjs")).toEqual({
      ...base,
      plugins: ["/runner.js", "/shards.mjs"],
      ignorers: [IGNORER_NAME],
    });
  });

  it("refuses a part split together with the weekly file shards", () => {
    expect(() =>
      withMutantShards(base, { [SHARD_VARIABLE]: "1/4", [FILE_SHARD_VARIABLE]: "1/8" }, "/s.mjs"),
    ).toThrow(/both set/);
  });

  it("reads only a well-formed part", () => {
    expect(parseShard(undefined)).toBeNull();
    expect(parseShard("3/4")).toEqual({ k: 3, n: 4 });
    for (const bad of ["0/4", "5/4", "1/17", "x", "1/", "-1/2"]) {
      expect(() => parseShard(bad), bad).toThrow(SHARD_VARIABLE);
    }
  });

  it("declares the ignorer it names, which refuses to run with no part", () => {
    expect(strykerPlugins).toMatchObject([{ kind: "Ignore", name: IGNORER_NAME }]);
    const previous = process.env[SHARD_VARIABLE];
    delete process.env[SHARD_VARIABLE];
    try {
      expect(() => strykerPlugins[0]?.value.shouldIgnore({})).toThrow(SHARD_VARIABLE);
    } finally {
      if (previous !== undefined) process.env[SHARD_VARIABLE] = previous;
    }
  });

  it.skipIf(RUNTIME !== "node")("is what stryker.config.mjs exports", async () => {
    const config = await loadConfig(join(ROOT, "stryker.config.mjs"));
    if (process.env[SHARD_VARIABLE] === undefined) expect(config["ignorers"]).toBeUndefined();
    expect(readFileSync(join(ROOT, "stryker.config.mjs"), "utf8")).toContain("withMutantShards(");
  });
});

describe("the mutation jobs in ci.yml", () => {
  const ci = readFileSync(join(ROOT, ".github/workflows/ci.yml"), "utf8");

  it("turns off the shared single-runner job", () => {
    expect(ci).toMatch(/^ {6}run-mutation: false$/m);
  });

  it("runs every part, and merges the same number", () => {
    const matrix = /^ {8}part: \[([\d, ]+)\]$/m.exec(ci);
    expect(matrix).not.toBeNull();
    const parts = (matrix?.[1] ?? "").split(",").map((s) => Number(s.trim()));
    expect(parts).toEqual(Array.from({ length: parts.length }, (_, i) => i + 1));
    expect(ci).toContain(`MUTATION_PARTS: ${parts.length}`);
    expect(ci).toContain(`${SHARD_VARIABLE}: \${{ matrix.part }}/\${{ env.MUTATION_PARTS }}`);
    expect(ci).toContain("node scripts/merge-mutation-parts.mjs");
  });

  it("reports under a name of its own, and fails when a part did not finish", () => {
    // Never `ci / mutation`: the shared caller still reports that context, skipped, and a skipped
    // check of the same name could stand in for this one.
    expect(ci).toMatch(/^ {4}name: mutation$/m);
    expect(ci).not.toMatch(/name: ci \/ mutation/);
    expect(ci).toContain("needs.mutation-part.result");
    expect(ci).toMatch(/if: \$\{\{ !cancelled\(\) && github\.event_name == 'pull_request' \}\}/);
  });
});
