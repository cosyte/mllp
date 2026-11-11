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
    exclude: [...configDefaults.exclude],
    testTimeout: 10_000,
  },
});
