import { readFileSync } from "node:fs";
import { afterEach, describe, it, expect, vi } from "vitest";

// This file must not import the source statically. VERSION is set once, when src/index.ts is
// first evaluated, and the mutation run links a mutant only to the tests that run while its line
// is evaluated. A static import evaluates the module before any test starts, so no test is ever
// linked to the VERSION string and a changed literal survives. Here the module registry is reset
// and the root module is imported inside the test body, so the evaluation happens in the test.

const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Narrow the parsed manifest without an `as` cast. */
function manifestVersion(manifest: unknown): string {
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error("package.json did not parse to an object with a `version` field");
  }
  const { version } = manifest;
  if (typeof version !== "string") throw new Error("package.json `version` is not a string");
  return version;
}

afterEach(() => {
  vi.doUnmock("../src/framing/index.js");
  vi.resetModules();
});

describe("VERSION through a fresh import", () => {
  it("evaluates the root module inside the test and exports VERSION matching package.json", async () => {
    vi.resetModules();
    // A pass-through mock on a module the root imports counts how often the root is evaluated.
    // A cached root module never asks for its imports again, so the count stays 0 unless the
    // evaluation below really happens inside this test.
    let rootEvaluations = 0;
    vi.doMock("../src/framing/index.js", async (importOriginal) => {
      rootEvaluations += 1;
      return await importOriginal();
    });

    const root = await import("../src/index.js");

    expect(rootEvaluations).toBe(1);
    expect(root.VERSION).toBe(manifestVersion(pkg));
  });
});
