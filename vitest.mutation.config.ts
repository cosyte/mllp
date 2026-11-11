import type { ViteUserConfig } from "vitest/config";
import { configDefaults } from "vitest/config";

import shared from "./vitest.config.js";

const config = shared as ViteUserConfig;

/**
 * The Vitest run StrykerJS uses for mutation testing (`stryker.config.mjs`): the suite of
 * `vitest.config.ts`, without the files that check something other than what `src/` does.
 *
 * StrykerJS mutates `src/` inside a sandbox and switches each mutant on in the test process, so a
 * test only kills a mutant when it runs the source in that process. The files left out below do
 * not, and each would cost every mutant a build, a compile or a child process:
 *
 * - `test/docs-content.test.ts`: it runs `pnpm build` and checks every docs sample against the
 *   built package and its types. Inside the sandbox that build would bundle the instrumented
 *   source.
 * - `test/differential/packaging.test.ts`: it builds the package into a directory of its own and
 *   loads that build.
 * - `test/readme-usage.test.ts`: it runs the README program in a child process.
 * - `test/examples-typecheck.test.ts`: it compiles `examples/` with TypeScript.
 * - `test/docs/**`: the docs pages and their structure, not the library.
 * - `test/scripts/**`: this repository's own tooling (the changelog and the PHI scan), not the
 *   library.
 *
 * What they prove is proved by `pnpm test` on every pull request.
 */
const mutation: ViteUserConfig = {
  ...config,
  test: {
    ...config.test,
    exclude: [
      ...(config.test?.exclude ?? configDefaults.exclude),
      "test/docs-content.test.ts",
      "test/differential/packaging.test.ts",
      "test/readme-usage.test.ts",
      "test/examples-typecheck.test.ts",
      "test/docs/**",
      "test/scripts/**",
    ],
  },
};

export default mutation;
