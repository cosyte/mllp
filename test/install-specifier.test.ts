import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { installSpecifiers } from "./_helpers/first-use.js";

/**
 * The install command a reader copies has to fetch THIS package. The subject is package identity:
 * each first-use document must print a command installing `package.json` `name`, and any other
 * package it tells a reader to install must be one this package declares (the optional
 * `@cosyte/hl7` peer the `ack-from-hl7` subpath needs). A specifier that is neither is named beside
 * the package name.
 */
const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  name: string;
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
};
const declared = new Set([
  ...Object.keys(pkg.peerDependencies ?? {}),
  ...Object.keys(pkg.dependencies ?? {}),
]);

describe("the documented install specifier", () => {
  for (const doc of ["docs-content/installation.md", "README.md"]) {
    it(`AC-ML7: ${doc} installs package.json name, and nothing this package does not declare`, () => {
      const specs = installSpecifiers(readFileSync(join(root, doc), "utf8"));
      expect(specs, `${doc} prints no command installing "${pkg.name}"`).toContain(pkg.name);
      for (const spec of specs.filter((s) => s !== pkg.name)) {
        expect(
          declared.has(spec),
          `${doc} installs "${spec}", which is neither package.json name "${pkg.name}" nor a declared dependency`,
        ).toBe(true);
      }
    });
  }

  it("AC-ML7: a specifier that is not the package name is read as the name it prints", () => {
    expect(installSpecifiers("npm install @cosyte/mllq\n`pnpm add -D @cosyte/mllp@0.0.1`")).toEqual(
      ["@cosyte/mllq", "@cosyte/mllp"],
    );
    expect(declared.has("@cosyte/mllq")).toBe(false);
  });

  it("AC-ML7: every install command form a reader may copy is read, inline code included", () => {
    const forms = [
      "pnpm i @cosyte/mllq",
      "pnpm install @cosyte/mllq",
      "npm add @cosyte/mllq",
      "deno add npm:@cosyte/mllq",
      "run `npm install @cosyte/mllq` first",
      "then run npm install @cosyte/mllq.",
    ];
    for (const form of forms) expect(installSpecifiers(form), form).toEqual(["@cosyte/mllq"]);
    expect(installSpecifiers("pnpm install\npnpm install --frozen-lockfile")).toEqual([]);
    expect(
      installSpecifiers("pnpm add file:../mllp\nnpm install git+https://x.test/mllp.git"),
    ).toEqual([]);
  });
});
