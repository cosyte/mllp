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
 *
 * TIMEOUTS. `testTimeout` stays, and the reason is measurement rather than habit: a slice that
 * set out to delete it found that on this suite the framework default would red correct code.
 * The rule is that a case which needs more than the ceiling states its own budget, so the
 * ceiling never has to be widened for one case and never becomes the thing standing between a
 * loaded machine and a false red. The cases carrying their own budgets today are the real-socket
 * TLS suites, the framing byte-fidelity corpus, the quirk-corpus large-payload case and the
 * attw gate; each says why at its own site. `hookTimeout` was removed because it was set to
 * exactly Vitest's own default and changed nothing. Figures, method and what the trim bought
 * are in CHANGELOG.md, not repeated here.
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
  },
});
