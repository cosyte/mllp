/**
 * Which runtime and system the suite is running on, for the few tests that cannot run on one of
 * them. CI runs the suite on Node.js on Linux, macOS and Windows, and again under Bun and under
 * Deno on Linux. A test skipped on one of them names the runtime or system it skips and says why at
 * the skip, so the list of what does not run where is read off the tests.
 */

/** The JavaScript runtime the suite is running under. */
export const RUNTIME: "bun" | "deno" | "node" =
  "Bun" in globalThis ? "bun" : "Deno" in globalThis ? "deno" : "node";

/** Whether the suite is running on Windows. */
export const ON_WINDOWS = process.platform === "win32";

/**
 * Whether this is the mutation run (`vitest.mutation.config.ts` sets `COSYTE_MUTATION_RUN`).
 * StrykerJS rewrites every mutated file under `src/` with its mutant switches, so a case that
 * reads a source file's text rather than running it reads the rewrite there and fails before any
 * mutant runs. Such a case is skipped in the mutation run, by name at its site, and runs in every
 * other run.
 */
export const MUTATION_RUN = process.env["COSYTE_MUTATION_RUN"] === "1";
