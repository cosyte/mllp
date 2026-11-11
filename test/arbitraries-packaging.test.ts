/**
 * How `@cosyte/mllp/arbitraries` ships: its own entry in `exports` for `import` and `require`, each
 * with its types; `fast-check` an optional peer dependency the build never bundles; nothing the
 * main entry reaches importing `fast-check` or the generators; and the generators importing only
 * types from the library, so the subpath carries no second copy of a class a consumer compares
 * against.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, unknown>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  devDependencies: Record<string, string>;
};

/** Every TypeScript file under `src/`, as a path relative to the root. */
function sources(dir = join(root, "src")): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    // With `/` between segments on every system, as the checks below spell the paths.
    return entry.name.endsWith(".ts") ? [relative(root, path).split(sep).join("/")] : [];
  });
}

/** The module specifiers a file imports or re-exports, with whether the statement is type-only. */
function imports(file: string): { specifier: string; typeOnly: boolean }[] {
  const text = readFileSync(join(root, file), "utf8");
  const found: { specifier: string; typeOnly: boolean }[] = [];
  for (const match of text.matchAll(
    /^(import|export)(\s+type)?\b[^;]*?\bfrom\s+"([^"]+)"|^import\s+"([^"]+)"/gmu,
  )) {
    found.push({ specifier: match[3] ?? match[4] ?? "", typeOnly: match[2] !== undefined });
  }
  return found;
}

describe("the @cosyte/mllp/arbitraries entry point", () => {
  it("is in exports for import and require, each with its own types", () => {
    expect(pkg.exports["./arbitraries"]).toEqual({
      import: {
        types: "./dist/arbitraries/index.d.ts",
        default: "./dist/arbitraries/index.mjs",
      },
      require: {
        types: "./dist/arbitraries/index.d.cts",
        default: "./dist/arbitraries/index.cjs",
      },
    });
  });

  it("needs fast-check 4 as an optional peer, which the tests install", () => {
    expect(pkg.peerDependencies["fast-check"]).toBe("^4.0.0");
    expect(pkg.peerDependenciesMeta["fast-check"]?.optional).toBe(true);
    expect(pkg.devDependencies["fast-check"]).toMatch(/^4\./u);
  });

  it("is built as its own entry, with fast-check left external", () => {
    const tsup = readFileSync(join(root, "tsup.config.ts"), "utf8");
    expect(tsup).toContain('"arbitraries/index": "src/arbitraries/index.ts"');
    expect(tsup).toMatch(/external: \[[^\]]*"fast-check"[^\]]*\]/u);
  });

  it("is the only part of src that imports fast-check, and nothing else imports it", () => {
    const files = sources();
    expect(files.some((f) => f.startsWith("src/arbitraries/"))).toBe(true);
    for (const file of files.filter((f) => !f.startsWith("src/arbitraries/"))) {
      for (const { specifier } of imports(file)) {
        expect(specifier, file).not.toBe("fast-check");
        expect(specifier, file).not.toMatch(/arbitraries/u);
      }
    }
  });

  it("imports only fast-check, its own modules, and types from the library", () => {
    for (const file of sources().filter((f) => f.startsWith("src/arbitraries/"))) {
      for (const { specifier, typeOnly } of imports(file)) {
        const own = specifier.startsWith("./");
        expect(specifier === "fast-check" || own || typeOnly, `${file}: ${specifier}`).toBe(true);
      }
    }
  });
});
