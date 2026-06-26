/**
 * Public-API stability snapshot for the MLLP warning-code surface.
 *
 * The 11 `MLLP_*` warning codes are part of the package's PUBLIC contract:
 * consumers narrow on `warning.code` (and `MllpFramingError.code`) in `onWarning`
 * handlers, log pipelines, and monitoring. Renaming or removing a code is a
 * BREAKING change.
 *
 * `WarningCode` is a compile-time union with no runtime value, so this file owns
 * the runtime mirror (`MLLP_WARNING_CODES`, re-exported from the lenient property
 * test). The `satisfies readonly WarningCode[]` clause there makes a rename a
 * TYPE error; this snapshot makes it a readable failing-test DIFF too. Updating the
 * snapshot (`vitest -u`) is the explicit acknowledgement that the public surface
 * changed and a changeset / breaking note is owed.
 *
 * Mirrors hl7's `test/warning-codes.snapshot.test.ts`.
 */

import { describe, it, expect } from "vitest";

import { sortedCodeSet } from "@cosyte/test-utils";

import { MLLP_WARNING_CODES } from "./lenient.property.test.js";

/**
 * Build the `{ CODE: "CODE" }` registry shape `sortedCodeSet` consumes from the
 * canonical code list (the runtime mirror of the `WarningCode` union).
 */
function warningCodeRegistry(): Record<string, string> {
  return Object.fromEntries(MLLP_WARNING_CODES.map((c) => [c, c]));
}

describe("public API: MLLP warning-code surface is stable", () => {
  it("the sorted set of warning codes matches the locked snapshot", () => {
    expect(sortedCodeSet(warningCodeRegistry())).toMatchInlineSnapshot(`
      [
        "MLLP_ACK_AFTER_TIMEOUT",
        "MLLP_ACK_UNMATCHED_CONTROL_ID",
        "MLLP_EMPTY_PAYLOAD",
        "MLLP_FRAME_TOO_LARGE",
        "MLLP_FS_WITHOUT_CR",
        "MLLP_LEADING_WHITESPACE",
        "MLLP_LF_AFTER_FS",
        "MLLP_MISSING_LEADING_VT",
        "MLLP_PAYLOAD_CONTAINS_FS",
        "MLLP_PAYLOAD_CONTAINS_VT",
        "MLLP_TRAILING_BYTES",
      ]
    `);
  });

  it("there are exactly 11 stable warning codes", () => {
    expect(MLLP_WARNING_CODES).toHaveLength(11);
  });

  it("the code list has no duplicates", () => {
    expect(new Set(MLLP_WARNING_CODES).size).toBe(MLLP_WARNING_CODES.length);
  });
});
