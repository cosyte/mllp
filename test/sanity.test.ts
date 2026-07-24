import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { VERSION } from "../src/index.js";

const pkg: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

/** Narrow the parsed manifest without an `as` cast, the sanity test must not lie about its input. */
function manifestVersion(manifest: unknown): string {
  if (typeof manifest !== "object" || manifest === null || !("version" in manifest)) {
    throw new Error("package.json did not parse to an object with a `version` field");
  }
  const { version } = manifest;
  if (typeof version !== "string") throw new Error("package.json `version` is not a string");
  return version;
}

describe("sanity", () => {
  it("package exports VERSION matching package.json", () => {
    // Compared against package.json, never a hardcoded literal. `changeset version` bumps
    // package.json alone, so a release that skipped `scripts/sync-version.mjs` (wired into the
    // `version` script) would otherwise publish a VERSION export that lies about the release,
    // and a literal-vs-literal assertion would have stayed green while it happened.
    expect(VERSION).toBe(manifestVersion(pkg));
  });

  it("Node.js version is 22+", () => {
    const major = parseInt(process.version.slice(1).split(".")[0] ?? "0", 10);
    expect(major).toBeGreaterThanOrEqual(22);
  });
});
