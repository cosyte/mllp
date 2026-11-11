import { cosyteStryker } from "@cosyte/vitest-config/stryker";

// Mutation testing for @cosyte/mllp, on the shared StrykerJS config: per-test coverage, static
// mutants ignored, the JSON report at reports/mutation/mutation.json, and no score threshold of its
// own (quality-floor.json decides).
//
//   pnpm mutate:full                           every source file; its score is the floor's
//   pnpm mutate changed --base origin/main     only the source files a change touched
//   pnpm quality:mutation [--base origin/main] the score against quality-floor.json
//
// The files mutated are the shared default: every `.ts` file under `src/` but tests, declarations,
// fixtures, generated code and the barrels the shared config finds by reading `src/`.
export default cosyteStryker({
  // The suite without the build, the tooling tests and the files that read the built package (see
  // that file).
  vitestConfig: "vitest.mutation.config.ts",
  stryker: {
    // A mutant times out when a test takes longer than timeoutFactor times its first, unmutated
    // run plus timeoutMS. This suite runs real sockets, timers and TLS handshakes, so a mutant
    // that slows one down without breaking it sits near StrykerJS's defaults (1.5 and 5,000 ms),
    // and can be a timeout on one run and a survivor on the next, which moves a full score the
    // ratchet compares exactly. A wider margin lets a slow mutant that still finishes finish every
    // time, so only a mutant that never ends times out, and the weekly score does not move with
    // the runner's load.
    timeoutFactor: 3,
    timeoutMS: 10_000,
  },
});
