/**
 * Refuter artifact for S0125-mllp-13, impl gate ordinal 2.
 *
 * The repo's own Vitest config, plus one setup file that switches OFF the loop-1 fix at
 * runtime (`test/regress_0125_F1_neutralize.ts`). Nothing in `src/` is edited; the guard the
 * fix added is simply replaced on the prototype before any case runs.
 *
 * Usage:
 *   pnpm exec vitest run --config test/regress_0125_F1_config.ts test/client/close-drain.test.ts
 *
 * Expected: RED on exactly the cases that pin the fix. A green run would mean the committed
 * coverage does not actually hold F1 discharged.
 */

import base from "../vitest.config.js";

const config = base as unknown as { test?: Record<string, unknown> };

export default {
  ...config,
  test: {
    ...(config.test ?? {}),
    setupFiles: ["./test/regress_0125_F1_neutralize.ts"],
  },
};
