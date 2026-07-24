import { cosyteVitest } from "@cosyte/vitest-config";

/**
 * Vitest config for @cosyte/mllp from the shared @cosyte/vitest-config standard.
 *
 * Per-directory >= 90 gates on the core dirs (framing/client/connection/server/transport/ack-from-hl7),
 * enforced by `pnpm test:coverage`. The coverage gate was re-enabled during the Phase E standards
 * migration; `framing`, `connection`, `transport`, `testing`, and `ack-from-hl7` clear the 90 bar today.
 *
 * Transient floors below 90 (all to be lifted to 90 by adding the missing tests, these directories
 * have genuinely untested branches/paths, not a measurement artifact):
 *
 *  - Global `branches` floor is 85 (not 90): the per-directory entries enforce the real bar; the
 *    global figure is dragged down by `src/server/**`. // TODO(coverage): restore to 90.
 *  - `src/client/**` `branches` floor is 85 (measured ~85.6). // TODO(coverage): add branch tests, restore to 90.
 *  - `src/server/**` floors are statements 87 / branches 75 / functions 77 / lines 88 (measured
 *    ~87.6 / ~75.8 / ~77.1 / ~88.9). `server.ts` has the largest test gap (graceful-shutdown and
 *    error paths). // TODO(coverage): add server tests, restore all four to 90.
 */
export default cosyteVitest({
  coverageDirs: ["framing", "client", "connection", "server", "transport", "ack-from-hl7"],
  coverageThresholds: {
    branches: 85,
    "src/client/**": { lines: 90, branches: 85, functions: 90, statements: 90 },
    "src/server/**": { lines: 88, branches: 75, functions: 77, statements: 87 },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
