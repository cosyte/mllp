/**
 * `detectMode` / `MllpAck.mode`, the MSH-15/16 original-vs-enhanced
 * selection table. Fixtures are synthetic-only, never PHI.
 */

import { describe, expect, it } from "vitest";

import { buildAckAA, detectMode } from "../../src/ack-from-hl7/build.js";
import { loadHl7Peer } from "../../src/ack-from-hl7/peer.js";

/** Build an inbound message with the given MSH-15 (accept ack type) / MSH-16 (app ack type). */
function inboundWith(msh15: string, msh16: string): string {
  return `MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5|||${msh15}|${msh16}`;
}

const TABLE: ReadonlyArray<readonly [string, string, "original" | "enhanced"]> = [
  ["", "", "original"],
  ["AL", "", "enhanced"],
  ["", "ER", "enhanced"],
  ["NE", "NE", "enhanced"],
  ["SU", "AL", "enhanced"],
];

describe("detectMode, MSH-15/16 selection table", () => {
  it.each(TABLE)("MSH-15=%s MSH-16=%s -> %s", (msh15, msh16, expected) => {
    expect(detectMode(inboundWith(msh15, msh16))).toBe(expected);
  });
});

describe("buildMllpAck(...).mode, same selection table", () => {
  it.each(TABLE)("MSH-15=%s MSH-16=%s -> %s", (msh15, msh16, expected) => {
    const ack = buildAckAA(inboundWith(msh15, msh16));
    expect(ack.mode).toBe(expected);
  });
});

describe("detectMode, unparseable inbound", () => {
  it("rethrows the Hl7ParseError as-is", () => {
    // Checked via the SAME loaded copy of @cosyte/hl7 this adapter uses
    // internally (loadHl7Peer()), not a separate ESM `import` of the class,
    // see the dual-package-hazard note on `Hl7Peer.Hl7Message` in peer.ts.
    // Node can resolve `createRequire` (CJS) and `import` (ESM) to distinct
    // module instances, so a real caller mixing the two forms should compare
    // against `loadHl7Peer().Hl7ParseError` or narrow on `.code`/`.name`, as
    // this test does.
    const peer = loadHl7Peer();
    expect(() => detectMode("not hl7 at all")).toThrow(peer.Hl7ParseError);
  });

  it("the thrown error carries the expected fatal code and name regardless of realm", () => {
    try {
      detectMode("not hl7 at all");
      expect.fail("expected detectMode to throw");
    } catch (err) {
      expect(err).toHaveProperty("name", "Hl7ParseError");
      expect(err).toHaveProperty("code", "NO_MSH_SEGMENT");
    }
  });
});
