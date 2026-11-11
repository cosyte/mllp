import { configDefaults } from "vitest/config";

import { cosyteVitest } from "@cosyte/vitest-config";

/**
 * Vitest config for @cosyte/mllp from the shared @cosyte/vitest-config standard.
 *
 * Coverage is gated at 100% for lines, branches, functions and statements across every file in
 * `src/` (barrels excepted, per the shared standard), enforced by `pnpm test:coverage`. The shared
 * config's per-directory >= 90 gates on the core dirs stay underneath it. A floor only rises: a
 * line that truly cannot be reached carries an inline `v8 ignore` comment naming its reason, never
 * a lowered number here.
 *
 * TIMEOUTS. The rule is that a case needing more than this ceiling states its OWN budget at its
 * own site, with the reason, so the ceiling never has to be widened for one case and never
 * becomes the thing standing between a loaded machine and a false red. Which sites do that is
 * deliberately NOT listed here, because a list in this comment went stale inside one slice; read
 * them off the tests, and note two spellings, the `{ timeout: N }` options object and a bare
 * trailing number on `it`. `hookTimeout` was removed because it was set to exactly
 * Vitest's own default and changed nothing. `testTimeout` is kept at 10_000, not because the
 * suite needs it (measured, the slowest case with no budget of its own is well under Vitest's
 * own 5,000 ms default even under concurrent suites) but because nothing measured asks it to
 * move. Figures, method and what the trim bought are in CHANGELOG.md, not repeated here.
 */
/**
 * Test files that cannot run under one runtime, each named with its reason. CI runs the suite on
 * Node.js on Linux, macOS and Windows, and again under Bun and under Deno. A single case that
 * cannot run somewhere is skipped at its own site instead (`test/_helpers/runtime.ts`).
 *
 * - Deno, `test/docs-content.test.ts`: two of its samples rest on what Deno's `node:net` and
 *   `node:tls` do not do (a server over `maxConnections` emits no `'drop'`, so the cap's event never
 *   comes; a cipher list naming no real suite is accepted rather than refused), and the shared
 *   snippet runner gives no way to skip one sample. The samples run on Node on every system.
 */
const RUNTIME_EXCLUDES = "Deno" in globalThis ? ["test/docs-content.test.ts"] : [];

export default cosyteVitest({
  coverageDirs: [
    "framing",
    "client",
    "connection",
    "server",
    "transport",
    "ack-from-hl7",
    "arbitraries",
    "differential",
  ],
  coverageThresholds: { lines: 100, branches: 100, functions: 100, statements: 100 },
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...RUNTIME_EXCLUDES],
    testTimeout: 10_000,
  },
});
