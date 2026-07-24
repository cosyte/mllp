/**
 * Property test: for arbitrary MSH-10 control ids, `buildAckAA` correlates
 * correctly and always emits a fresh (non-echoed) outbound control id.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseHL7 } from "@cosyte/hl7";

import { buildAckAA } from "../../src/ack-from-hl7/build.js";
import { loadHl7Peer } from "../../src/ack-from-hl7/peer.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 300;

/** Alphanumeric characters only, matching a realistic MSH-10 control id alphabet. */
const ALPHANUMERIC_CHAR = fc.constantFrom(
  ..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789".split(""),
);

/** An arbitrary alphanumeric control id, length 1..20. */
function controlIdArbitrary(): fc.Arbitrary<string> {
  return fc
    .array(ALPHANUMERIC_CHAR, { minLength: 1, maxLength: 20 })
    .map((chars) => chars.join(""));
}

function inboundWithControlId(controlId: string): string {
  return `MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|${controlId}|P|2.5`;
}

describe("property: buildAckAA correlation over arbitrary control ids", () => {
  it("correlationId === id, parsed MSA-2 === id, parsed ACK MSH-10 !== id (fresh id)", () => {
    fc.assert(
      fc.property(controlIdArbitrary(), (id) => {
        const ack = buildAckAA(inboundWithControlId(id));
        expect(ack.correlationId).toBe(id);

        const round = parseHL7(ack.payload);
        expect(round.get("MSA.2")).toBe(id);
        expect(round.meta.controlId).not.toBe(id);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("a correlated ACK always re-parses with zero parse warnings (spec-clean emit invariant)", () => {
    fc.assert(
      fc.property(controlIdArbitrary(), (id) => {
        const ack = buildAckAA(inboundWithControlId(id));
        const round = parseHL7(ack.payload);
        expect(round.warnings).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("property: verbatim echo for delimiter-bearing control ids", () => {
  // Vendor-quirk alphabet: alphanumerics plus unescaped ^ & ~ delimiters.
  // Trailing delimiters excluded, HL7 treats trailing empty components/
  // repetitions as insignificant and the spec-clean serializer canonicalizes
  // them (upstream D-02); requires at least one alphanumeric so the id is
  // never all-empty structure.
  const quirkyControlId = fc
    .stringOf(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789^&~".split("")), {
      minLength: 1,
      maxLength: 20,
    })
    .filter((s) => !/[\^&~]$/.test(s) && /[A-Z0-9]/.test(s));

  it("correlationId and wire MSA-2 always equal the inbound MSH-10 field text", () => {
    fc.assert(
      fc.property(quirkyControlId, (controlId) => {
        const raw = `MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|${controlId}|P|2.5\r`;
        const inboundText = loadHl7Peer().parseHL7(raw).segments("MSH")[0]?.field(10).text ?? "";
        expect(inboundText.length).toBeGreaterThan(0);
        const ack = buildAckAA(raw);
        expect(ack.code).toBe("AA");
        expect(ack.correlationId).toBe(inboundText);
        const msaLine = ack.payload
          .toString("utf8")
          .split("\r")
          .find((l) => l.startsWith("MSA"));
        expect(msaLine).toBe(`MSA|AA|${inboundText}`);
      }),
      { numRuns: 200 },
    );
  });
});
