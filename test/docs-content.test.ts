import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { beforeAll } from "vitest";

import { docSnippetSuite } from "@cosyte/vitest-config/snippets";

/**
 * Doc/code-agreement gate. Every ```` ```ts runnable ```` block in `docs-content/` is extracted,
 * compiled, and executed, and its inline `// =>` assertions are checked, so a documented example
 * can never silently drift from the shipped code (the documentation analog of the conformance
 * runners). Blocks tagged ` ```ts runnable throws ` must throw; plain ` ```ts ` blocks are
 * illustrative and are not executed.
 *
 * `@cosyte/mllp` is **transport, not parsing**, so the runnable blocks stay at the framing layer
 * (`encodeFrame` / `FrameReader`), the transport primitive, which runs deterministically
 * in-process. The client/server examples open real sockets and so are illustrative-only.
 *
 * Snippets import the package the way a consumer does, against the **built** ESM artifact, not the
 * source tree. The harness executes each block as a standalone ES module, so it can't resolve the
 * source's internal `.js`→`.ts` imports; the bundled `dist/index.mjs` is self-contained and is also
 * exactly what an installer loads. The shared CI gate runs `test` before `build`, so we provision
 * `dist/` on demand here rather than assuming build order.
 *
 * THE RESOLVER REFUSES A SUBPATH IT DOES NOT MAP, AND THAT REFUSAL IS THE LOAD-BEARING PART. This
 * package publishes three entry points, and a snippet that imports one the map does not cover would
 * otherwise be judged by whether the raw specifier happens to resolve at test time. For a plain
 * block the import simply rejects and the case reds, which is fine. For a block tagged
 * ` ```ts runnable throws ` it is not: the harness treats ANY rejection as the expected throw
 * (documented in `@cosyte/vitest-config/snippets`), so an unresolvable specifier there would report
 * GREEN over an example that never ran. `remapImports` is called before that try/catch, so throwing
 * from the map is the one place a refusal reaches both kinds of block. Adding a subpath to a snippet
 * therefore means adding it to SUBPATH_ENTRIES below, deliberately, in the same change.
 */
const root = join(import.meta.dirname, "..");

/** Published subpath -> the built ESM artifact a consumer of that subpath loads. */
const SUBPATH_ENTRIES: Readonly<Record<string, string>> = {
  "@cosyte/mllp": join(root, "dist", "index.mjs"),
  "@cosyte/mllp/testing": join(root, "dist", "testing", "index.mjs"),
};

function resolveSnippetImport(specifier: string): string | undefined {
  const mapped = SUBPATH_ENTRIES[specifier];
  if (mapped !== undefined) return mapped;
  if (specifier === "@cosyte/mllp" || specifier.startsWith("@cosyte/mllp/")) {
    throw new Error(
      `docs-content/ carries a runnable block importing "${specifier}", which this suite does not ` +
        `map to a built artifact. Add it to SUBPATH_ENTRIES in test/docs-content.test.ts, or make ` +
        `the block illustrative. Left unmapped, a block tagged \`throws\` would pass for the wrong ` +
        `reason: the harness counts an unresolvable import as the documented throw.`,
    );
  }
  return undefined;
}

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
}, 120_000);

docSnippetSuite({
  docsDir: join(root, "docs-content"),
  resolve: resolveSnippetImport,
});
