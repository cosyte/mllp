/**
 * Every entry point a consumer can import has its cold import read on a runner.
 *
 * The main reading (`bench/mllp.bench.mjs`) measures the import of the root entry point only. Each
 * subpath in `package.json` `exports` is read by `bench/import.bench.mjs` in its own `import` job of
 * `bench.yml`, so this holds that job's list to the exports: a subpath added without a reading
 * fails here. Then the import suite's one case runs once against each entry point's source.
 */

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import suite from "../../bench/import.bench.mjs";

const root = new URL("../../", import.meta.url);

/** The subpaths of `exports` that are code: neither the root nor `./package.json`. */
function subpaths(): string[] {
  const pkg = JSON.parse(readFileSync(new URL("package.json", root), "utf8")) as {
    exports: Record<string, unknown>;
  };
  return Object.keys(pkg.exports)
    .filter((key) => key !== "." && key !== "./package.json")
    .map((key) => key.slice(2));
}

/** The entries of the `import` job's matrix in bench.yml, in order. */
function importJobEntries(): string[] {
  const text = readFileSync(new URL(".github/workflows/bench.yml", root), "utf8");
  const job = /\n {2}import:\n([\s\S]*?)(?=\n {2}[a-z-]+:\n|$)/.exec(text)?.[1] ?? "";
  const list = /\n {8}entry:\n((?: {10}- .*\n)+)/.exec(job)?.[1] ?? "";
  return [...list.matchAll(/- "?([^"\n]+)"?/g)].map((m) => m[1] as string);
}

describe("the cold import of each entry point", () => {
  it("is read on a runner for every subpath package.json exports", () => {
    expect(subpaths().length).toBeGreaterThan(0);
    expect(importJobEntries()).toEqual(subpaths());
  });

  it("runs the import suite's case once against each entry point's source", async () => {
    const sources = {
      root: await import("../../src/index.js"),
      testing: await import("../../src/testing/index.js"),
      "ack-from-hl7": await import("../../src/ack-from-hl7/index.js"),
      arbitraries: await import("../../src/arbitraries/index.js"),
    };
    expect(Object.keys(sources).slice(1)).toEqual(subpaths());
    const [benchmark] = suite.benchmarks;
    for (const [name, entry] of Object.entries(sources)) {
      for (const size of benchmark?.sizes ?? []) {
        const run = benchmark?.bind(entry);
        let weight = 0;
        for (const input of size.build().inputs) weight += benchmark?.weigh?.(run?.(input)) ?? 0;
        expect(weight, name).toBeGreaterThan(0);
      }
    }
  });
});
