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
 */
const root = join(import.meta.dirname, "..");
const distEntry = join(root, "dist", "index.mjs");

beforeAll(() => {
  execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
}, 120_000);

docSnippetSuite({
  docsDir: join(root, "docs-content"),
  resolve: (specifier) => (specifier === "@cosyte/mllp" ? distEntry : undefined),
});
