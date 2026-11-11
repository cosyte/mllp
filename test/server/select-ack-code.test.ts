/**
 * `selectAckCode`: the acknowledgement-condition table as a public function, from MSH-15, MSH-16
 * and an outcome to the code to send.
 *
 * The server's auto-ACK path reads the same table (`test/server/ack-mode-matrix.test.ts` holds the
 * wire side and checks this function against every cell of it), so a caller that builds its own
 * acknowledgement answers exactly as the server would.
 *
 * Fixtures are field values only. No patient data appears anywhere here.
 */

import { describe, expect, it } from "vitest";

import {
  selectAckCode,
  type AckCodeSelection,
  type AckCodeSelectionInput,
} from "../../src/server/ack-code.js";
import * as root from "../../src/index.js";

type Outcome = AckCodeSelectionInput["outcome"];
const OUTCOMES: readonly Outcome[] = ["AA", "AE", "AR"];

/**
 * The accept-condition half. `[MSH-15, code on AA, code on AE, code on AR]`, the same rows as the
 * server matrix and as the table in docs-content/acks.md.
 */
const ACCEPT_ROWS: ReadonlyArray<readonly [string | undefined, Outcome | "CA", string, string]> = [
  [undefined, "AA", "AE", "AR"],
  ["", "AA", "AE", "AR"],
  ['""', "AA", "AE", "AR"],
  ["NE", "AA", "AE", "AR"],
  ["AL", "CA", "CE", "CR"],
  ["ER", "AA", "CE", "CR"],
  ["SU", "CA", "AE", "AR"],
  ["VENDOR", "AA", "AE", "AR"],
];

describe("selectAckCode: MSH-15 picks the half of Table 0008", () => {
  for (const [msh15, onAA, onAE, onAR] of ACCEPT_ROWS) {
    const expected: Record<Outcome, string> = { AA: onAA, AE: onAE, AR: onAR };
    for (const outcome of OUTCOMES) {
      it(`MSH-15 ${JSON.stringify(msh15)} with ${outcome} sends ${expected[outcome]}`, () => {
        expect(selectAckCode({ msh15, outcome }).code).toBe(expected[outcome]);
      });
    }
  }

  it("reads a coded element, a repetition and padding the way the server does", () => {
    expect(selectAckCode({ msh15: "AL^HL70155", outcome: "AA" }).code).toBe("CA");
    expect(selectAckCode({ msh15: "AL~NE", outcome: "AA" }).code).toBe("CA");
    expect(selectAckCode({ msh15: " AL ", outcome: "AA" }).code).toBe("CA");
    // Case-sensitive, as on the wire.
    expect(selectAckCode({ msh15: "al", outcome: "AA" }).code).toBe("AA");
  });

  it("splits on the message's own MSH-2 separators when it declares others", () => {
    // `#` is the component separator and `*` the repetition separator here.
    expect(selectAckCode({ msh15: "AL#X", encodingCharacters: "#*\\&", outcome: "AA" }).code).toBe(
      "CA",
    );
    expect(selectAckCode({ msh15: "AL*NE", encodingCharacters: "#*\\&", outcome: "AA" }).code).toBe(
      "CA",
    );
    // Under those separators `^` is an ordinary byte, so `AL^X` is not a code.
    expect(selectAckCode({ msh15: "AL^X", encodingCharacters: "#*\\&", outcome: "AA" }).code).toBe(
      "AA",
    );
    // Unset, the standard `^~\&` applies.
    expect(selectAckCode({ msh15: "AL^X", outcome: "AA" }).code).toBe("CA");
  });
});

describe("selectAckCode: the mode and what MSH-16 asks for", () => {
  it("with neither field set the message is original mode and the code is the application acknowledgement", () => {
    for (const outcome of OUTCOMES) {
      const selection = selectAckCode({ outcome });
      expect(selection).toEqual({
        code: outcome,
        mode: "original",
        applicationAckRequested: true,
        acceptTypeUnrecognised: false,
        applicationTypeUnrecognised: false,
      } satisfies AckCodeSelection);
      expect(Object.isFrozen(selection)).toBe(true);
    }
  });

  it("an explicit null in both fields is still original mode", () => {
    expect(selectAckCode({ msh15: '""', msh16: "", outcome: "AA" }).mode).toBe("original");
  });

  it("either field set makes it enhanced mode", () => {
    expect(selectAckCode({ msh15: "NE", outcome: "AA" }).mode).toBe("enhanced");
    expect(selectAckCode({ msh16: "AL", outcome: "AA" }).mode).toBe("enhanced");
    expect(selectAckCode({ msh15: "VENDOR", outcome: "AA" }).mode).toBe("enhanced");
  });

  // `[MSH-16, asked on AA, asked on AE, asked on AR]`.
  const APPLICATION_ROWS: ReadonlyArray<readonly [string | undefined, boolean, boolean, boolean]> =
    [
      [undefined, true, true, true],
      ["AL", true, true, true],
      ["NE", false, false, false],
      ["ER", false, true, true],
      ["SU", true, false, false],
      ["VENDOR", true, true, true],
    ];
  for (const [msh16, onAA, onAE, onAR] of APPLICATION_ROWS) {
    const expected: Record<Outcome, boolean> = { AA: onAA, AE: onAE, AR: onAR };
    for (const outcome of OUTCOMES) {
      it(`MSH-16 ${JSON.stringify(msh16)} with ${outcome} asks for an application acknowledgement: ${String(expected[outcome])}`, () => {
        expect(selectAckCode({ msh15: "AL", msh16, outcome }).applicationAckRequested).toBe(
          expected[outcome],
        );
      });
    }
  }

  it("MSH-16 never changes the code", () => {
    for (const msh16 of ["AL", "NE", "ER", "SU", "VENDOR", undefined]) {
      expect(selectAckCode({ msh15: "AL", msh16, outcome: "AE" }).code).toBe("CE");
      expect(selectAckCode({ msh15: "NE", msh16, outcome: "AE" }).code).toBe("AE");
    }
  });

  it("names an unrecognised field without echoing it", () => {
    const both = selectAckCode({ msh15: "VENDOR", msh16: "OTHER", outcome: "AA" });
    expect(both.acceptTypeUnrecognised).toBe(true);
    expect(both.applicationTypeUnrecognised).toBe(true);
    expect(JSON.stringify(both)).not.toContain("VENDOR");
    expect(JSON.stringify(both)).not.toContain("OTHER");

    const accept = selectAckCode({ msh15: "VENDOR", msh16: "AL", outcome: "AA" });
    expect(accept.acceptTypeUnrecognised).toBe(true);
    expect(accept.applicationTypeUnrecognised).toBe(false);

    const application = selectAckCode({ msh15: "AL", msh16: "OTHER", outcome: "AA" });
    expect(application.acceptTypeUnrecognised).toBe(false);
    expect(application.applicationTypeUnrecognised).toBe(true);
  });
});

describe("selectAckCode: an outcome outside the application half is refused", () => {
  for (const outcome of ["CA", "CE", "CR", "XX", "", undefined]) {
    it(`refuses ${JSON.stringify(outcome)} with a RangeError that does not echo it`, () => {
      const call = (): AckCodeSelection =>
        selectAckCode({ msh15: "AL", outcome: outcome as unknown as Outcome });
      expect(call).toThrow(RangeError);
      expect(call).toThrow("selectAckCode: outcome must be one of AA, AE or AR");
    });
  }
});

describe("selectAckCode: the root entry point", () => {
  it("is exported from @cosyte/mllp", () => {
    expect(root.selectAckCode).toBe(selectAckCode);
  });
});
