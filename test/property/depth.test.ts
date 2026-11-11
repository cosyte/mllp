/**
 * The depth of the property suites is one number a run sets: 100 cases a property on a pull
 * request, 10,000 nightly (`COSYTE_PROPERTY_RUNS`, set by `.github/workflows/nightly-properties.yml`).
 * These tests hold that: a property that ran through a bare `fc.assert`, or set its own `numRuns`,
 * would keep its own depth whatever the run asked for, and the nightly run would not be deep.
 *
 * The three fuzz targets are left out by name. They are the fuzz layer, not the property layer:
 * each runs a committed base count against a pinned seed on a pull request, so a pull request sees
 * the same inputs every time, and the nightly fuzz run (`.github/workflows/nightly-fuzz.yml`) runs
 * them for a time budget from a new seed instead of a case count (`./_fuzz-config.ts`).
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { checkAsyncProperty, checkProperty, propertyTimeout } from "./_runner.js";

const here = dirname(fileURLToPath(import.meta.url));

/** The fuzz targets, which keep their own knobs (see above). */
const FUZZ_TARGETS = new Set([
  "fuzz.property.test.ts",
  "transport-fuzz.property.test.ts",
  "ack-fuzz.property.test.ts",
]);

const propertyFiles = readdirSync(here)
  .filter((name) => name.endsWith(".property.test.ts") && !FUZZ_TARGETS.has(name))
  .sort();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("property depth", () => {
  it("finds the property suites, and every fuzz target it leaves out", () => {
    expect(propertyFiles.length).toBeGreaterThan(0);
    const all = new Set(readdirSync(here));
    for (const target of FUZZ_TARGETS) expect(all.has(target), target).toBe(true);
  });

  it.each(propertyFiles)("%s runs every property through the shared runner", (name) => {
    const source = readFileSync(join(here, name), "utf8");
    expect(source).toMatch(/\b(assertProperty|checkProperty|checkAsyncProperty)\(/u);
    expect(source).not.toMatch(/\bfc\.(assert|check)\(/u);
    expect(source).not.toMatch(/\bnumRuns\b/u);
  });

  it("runs 100 cases a property when the run sets no depth", () => {
    vi.stubEnv("COSYTE_PROPERTY_RUNS", "");
    let cases = 0;
    checkProperty(
      fc.property(fc.nat(), () => {
        cases += 1;
      }),
    );
    expect(cases).toBe(100);
  });

  it("runs the depth COSYTE_PROPERTY_RUNS sets, for a synchronous and an asynchronous property", async () => {
    vi.stubEnv("COSYTE_PROPERTY_RUNS", "1234");
    let cases = 0;
    checkProperty(
      fc.property(fc.nat(), () => {
        cases += 1;
      }),
    );
    expect(cases).toBe(1234);

    let asyncCases = 0;
    await checkAsyncProperty(
      fc.asyncProperty(fc.nat(), async () => {
        await Promise.resolve();
        asyncCases += 1;
      }),
    );
    expect(asyncCases).toBe(1234);
  });

  it("names the failing test and prints the seed and path that replay it", () => {
    vi.stubEnv("COSYTE_PROPERTY_RUNS", "");
    expect(() => {
      checkProperty(
        fc.property(fc.nat(), (n) => {
          expect(n).toBeLessThan(0);
        }),
      );
    }).toThrow(
      /^property depth > names the failing test and prints the seed and path that replay it: property failed after \d+ case\(s\)[^\n]*\nReplay exactly: COSYTE_PROPERTY_SEED=-?\d+ COSYTE_PROPERTY_PATH=\d+(:\d+)*\n/u,
    );
  });

  it("names a failing asynchronous property the same way, and replays it from the printed pair", async () => {
    vi.stubEnv("COSYTE_PROPERTY_RUNS", "");
    const below = fc.asyncProperty(fc.nat(), async (n) => {
      await Promise.resolve();
      return n < 50;
    });
    let message = "";
    try {
      await checkAsyncProperty(below);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(
      /^property depth > names a failing asynchronous property the same way, and replays it from the printed pair: property failed after \d+ case\(s\)/u,
    );
    expect(message).toContain("Counterexample: [50]");
    const replay = /COSYTE_PROPERTY_SEED=(-?\d+) COSYTE_PROPERTY_PATH=([\d:]+)/u.exec(message);
    expect(replay).not.toBeNull();

    vi.stubEnv("COSYTE_PROPERTY_SEED", replay?.[1] ?? "");
    vi.stubEnv("COSYTE_PROPERTY_PATH", replay?.[2] ?? "");
    await expect(checkAsyncProperty(below)).rejects.toThrow(/property failed after 1 case\(s\)/u);
  });

  it("gives a property test 10 s up to 1,000 cases, and 10 ms a case after", () => {
    expect(propertyTimeout({})).toBe(10_000);
    expect(propertyTimeout({ COSYTE_PROPERTY_RUNS: "1000" })).toBe(10_000);
    expect(propertyTimeout({ COSYTE_PROPERTY_RUNS: "10000" })).toBe(100_000);
  });
});
