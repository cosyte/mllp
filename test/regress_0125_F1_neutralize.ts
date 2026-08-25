/**
 * Refuter artifact for S0125-mllp-13, impl gate ordinal 2: a Vitest setup file that switches
 * OFF the loop-1 fix at runtime, without editing a line of `src/`.
 *
 * Purpose: "F1 discharged with committed coverage" is a claim about the COMMITTED SUITE, not
 * about a standalone script. This file lets that claim be executed. The loop-1 fix is a guard,
 * `MllpClient._shutdownBegun()`, consulted on the `'drain'` listener of every parked send;
 * forcing it to `false` restores exactly the pre-fix behaviour and nothing else.
 *
 * Usage:
 *   pnpm exec vitest run test/client/close-drain.test.ts \
 *     --setupFiles test/regress_0125_F1_neutralize.ts
 *
 * Expected: the cases that assert a parked send keeps its never-delivered report when a
 * SETTLEMENT (rather than the drain timeout) ends the shutdown wait go RED, and the rest of
 * the suite stays green. A fully green run would mean the committed coverage does not
 * actually pin the fix.
 */

import { MllpClient } from "../src/client/client.js";

(MllpClient.prototype as unknown as { _shutdownBegun: () => boolean })._shutdownBegun =
  function neutralized(): boolean {
    return false;
  };
