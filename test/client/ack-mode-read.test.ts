/**
 * The three acknowledgement-mode field reads, at the byte level: MSH-15 and MSH-16 on the
 * way out, MSA-1 on the way in.
 *
 * These are unit tests over the readers themselves. What the readings then DO to a send is
 * pinned in `two-phase-correlation.test.ts` and `two-phase-timeouts.test.ts`, and what they
 * do to a server's acknowledgement in `test/server/ack-mode-matrix.test.ts`.
 *
 * Fixtures are synthetic MSH/MSA headers only. No patient data appears anywhere here.
 */

import { describe, it, expect } from "vitest";

import {
  classifyMsa1,
  classifyOutboundAckMode,
  readAcceptCondition,
  acceptAckRequested,
  acceptModeCounterpart,
  delimitersFrom,
  ORIGINAL_MODE,
  type Table0008Code,
} from "../../src/internal/ack-mode.js";
import { extractMsaControlId, readMshSegment } from "../../src/internal/control-id.js";

/**
 * An outbound header whose MSH-15 / MSH-16 are exactly the supplied strings.
 *
 * Field layout, counted so the off-by-one is visible rather than asserted:
 * `MSH`(name) `^~\&`(MSH-2) `S`(3) `F`(4) `R`(5) `F2`(6) `20260101000000`(7) ``(8)
 * `ADT^A01`(9) `MSG001`(10) `P`(11) `2.5.1`(12) ``(13) ``(14) then MSH-15, MSH-16.
 */
function outbound(msh15: string, msh16: string, tail = ""): Buffer {
  return Buffer.from(
    `MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|MSG001|P|2.5.1|||${msh15}|${msh16}${tail}\r`,
    "latin1",
  );
}

/** An acknowledgement whose MSA-1 is exactly `msa1` and whose MSA-2 echoes `acked`. */
function ack(msa1: string, acked = "MSG001", terminator = "\r"): Buffer {
  return Buffer.from(
    `MSH|^~\\&|R|F2|S|F|20260101000000||ACK^A01|ACK001|P|2.5.1${terminator}` +
      `MSA|${msa1}|${acked}${terminator}`,
    "latin1",
  );
}

describe("reading a table value off a field", () => {
  // The worked examples the reading rule is defined by, on MSH-15.
  const CASES: ReadonlyArray<readonly [string, string, "AL" | "ER" | null | "unrecognised"]> = [
    ["AL", "plain code", "AL"],
    ["ER", "the other plain code", "ER"],
    [" AL ", "padded with spaces", "AL"],
    ["AL^HL70155", "a coded element", "AL"],
    ["AL~NE", "a repetition", "AL"],
    ["al", "lowercase", "unrecognised"],
    ["ALW", "a longer value", "unrecognised"],
    ["", "an empty field", null],
    ['""', "the two-byte HL7 explicit null", null],
  ];

  it.each(CASES)("MSH-15 %s (%s)", (value, _label, expected) => {
    const read = readAcceptCondition(readMshSegment(outbound(value, "")));
    if (expected === null) {
      expect(read.kind).toBe("null");
    } else if (expected === "unrecognised") {
      expect(read.kind).toBe("unrecognised");
    } else {
      expect(read).toMatchObject({ kind: "code", code: expected });
    }
  });

  it("an absent field (the segment stops short of MSH-15) reads as null", () => {
    const short = Buffer.from("MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|MSG001|P|2.5.1\r");
    expect(readAcceptCondition(readMshSegment(short)).kind).toBe("null");
  });

  it("an unrecognised value reports its byte length and nothing else", () => {
    const read = readAcceptCondition(readMshSegment(outbound("VENDOR-X", "")));
    expect(read.kind).toBe("unrecognised");
    expect(read.byteLength).toBe("VENDOR-X".length);
  });

  it("the delimiters come from MSH-2, and a message declaring none is read whole", () => {
    expect(delimitersFrom("^~\\&")).toEqual({ componentSep: "^", repetitionSep: "~" });
    // A one-byte MSH-2 declares a component separator and no repetition separator.
    expect(delimitersFrom("^")).toEqual({ componentSep: "^", repetitionSep: null });
    expect(delimitersFrom("")).toEqual({ componentSep: null, repetitionSep: null });
    expect(delimitersFrom(undefined)).toEqual({ componentSep: null, repetitionSep: null });
  });
});

describe("classifying an outbound send", () => {
  it("both fields empty is an original-mode send", () => {
    expect(classifyOutboundAckMode(readMshSegment(outbound("", "")))).toEqual(ORIGINAL_MODE);
    expect(ORIGINAL_MODE.enhanced).toBe(false);
  });

  it("a header that cannot be scanned at all is an original-mode send, not a failure", () => {
    for (const payload of [
      Buffer.from("not hl7 at all"),
      Buffer.from(""),
      Buffer.from("MSH"),
      Buffer.from("MSH|^~\\&|S|F"), // truncated, nowhere near MSH-15
      Buffer.from([0x4d, 0x53, 0x48, 0x0d]), // MSH followed by a segment terminator
    ]) {
      expect(classifyOutboundAckMode(readMshSegment(payload)).enhanced).toBe(false);
    }
  });

  it("either field non-null enters enhanced mode", () => {
    expect(classifyOutboundAckMode(readMshSegment(outbound("AL", ""))).enhanced).toBe(true);
    expect(classifyOutboundAckMode(readMshSegment(outbound("", "AL"))).enhanced).toBe(true);
    expect(classifyOutboundAckMode(readMshSegment(outbound("NE", "NE"))).enhanced).toBe(true);
  });

  it("a null MSH-15 defaults to NE and a null MSH-16 to AL", () => {
    const mode = classifyOutboundAckMode(readMshSegment(outbound("", "SU")));
    expect(mode).toMatchObject({
      enhanced: true,
      acceptCondition: "NE",
      applicationCondition: "SU",
    });
    const other = classifyOutboundAckMode(readMshSegment(outbound("AL", "")));
    expect(other).toMatchObject({ acceptCondition: "AL", applicationCondition: "AL" });
  });

  it("an unrecognised value defaults the same way and is reported", () => {
    const mode = classifyOutboundAckMode(readMshSegment(outbound("XX", "YY")));
    expect(mode).toMatchObject({
      enhanced: true,
      acceptCondition: "NE",
      applicationCondition: "AL",
      acceptFieldUnrecognised: true,
      applicationFieldUnrecognised: true,
    });
  });

  it("awaiting an application acknowledgement is decided by MSH-16 alone", () => {
    for (const [msh16, awaits] of [
      ["AL", true],
      ["ER", true],
      ["SU", true],
      ["NE", false],
    ] as const) {
      expect(
        classifyOutboundAckMode(readMshSegment(outbound("AL", msh16))).awaitsApplicationAck,
      ).toBe(awaits);
    }
  });

  it("MSH-15 is the fourteenth token after MSH, so a country code cannot be mistaken for it", () => {
    // MSH-15 and MSH-16 are both empty and MSH-17 carries a country code. Counting fields
    // the way an ordinary segment counts them would read MSH-17 as MSH-16, make this an
    // enhanced-mode send, and leave it waiting for an acknowledgement no original-mode peer
    // will ever send.
    const withCountry = Buffer.from(
      "MSH|^~\\&|A|B|C|D|20260820||ADT^A01|MSG1|P|2.5.1|||||USA|\r",
      "latin1",
    );
    const msh = readMshSegment(withCountry);
    expect(msh?.fields[16]).toBe("USA"); // MSH-17, one past the pair this contract reads
    expect(readAcceptCondition(msh).kind).toBe("null");
    expect(classifyOutboundAckMode(msh)).toEqual(ORIGINAL_MODE);
  });
});

describe("classifying an inbound acknowledgement's MSA-1", () => {
  // Every row is the MSA-1 bytes of one acknowledgement, and the outcome the read yields.
  const ROWS: ReadonlyArray<readonly [string, "code" | "null" | "unclassifiable", string | null]> =
    [
      ["CA", "code", "CA"],
      ["CA ", "code", "CA"],
      [" CA", "code", "CA"],
      ["CA^HL70008", "code", "CA"],
      ["AA", "code", "AA"],
      ["AA~AA", "code", "AA"],
      ["AE", "code", "AE"],
      ["AR ", "code", "AR"],
      ["CE", "code", "CE"],
      ["CR^HL70008", "code", "CR"],
      ["", "null", null],
      ['""', "null", null],
      ["ca", "unclassifiable", null],
      ["CAX", "unclassifiable", null],
      ["C", "unclassifiable", null],
      ["A", "unclassifiable", null],
      ["OK", "unclassifiable", null],
    ];

  it.each(ROWS)("MSA-1 %s reads as %s", (msa1, kind, code) => {
    const classification = classifyMsa1(ack(msa1));
    expect(classification.kind).toBe(kind);
    if (code !== null) {
      expect(classification).toMatchObject({ kind: "code", code });
    }
  });

  it("an acknowledgement with no MSA segment reads as null", () => {
    const noMsa = Buffer.from("MSH|^~\\&|R|F2|S|F|20260101000000||ACK^A01|ACK001|P|2.5.1\r");
    expect(classifyMsa1(noMsa)).toMatchObject({ kind: "null" });
  });

  it("a payload with no readable MSH is unclassifiable", () => {
    for (const payload of [
      Buffer.from("MSA|AA|MSG001\r"), // an MSA with no header to declare its delimiters
      Buffer.from("no hl7 here at all"),
      Buffer.from(""),
      Buffer.from("MSH"),
    ]) {
      expect(classifyMsa1(payload)).toMatchObject({ kind: "unclassifiable" });
    }
  });

  it("the outcomes are total and mutually exclusive over arbitrary bytes", () => {
    // A blunt sweep: every single-byte payload, and every byte spliced into a well-formed
    // acknowledgement's MSA-1, must land on exactly one of the three outcomes.
    const kinds = new Set<string>();
    for (let b = 0; b < 256; b++) {
      const single = classifyMsa1(Buffer.from([b]));
      const spliced = classifyMsa1(ack(String.fromCharCode(b)));
      const framed = classifyMsa1(Buffer.concat([Buffer.from([b]), ack("AA")]));
      for (const c of [single, spliced, framed]) {
        expect(["null", "code", "unclassifiable"]).toContain(c.kind);
        kinds.add(c.kind);
      }
    }
    // All three outcomes are actually reachable from that sweep, so it is not vacuous.
    expect(kinds.size).toBe(3);
  });

  it("an unclassifiable MSA-1 reports its byte length and nothing else", () => {
    expect(classifyMsa1(ack("VENDORCODE")).byteLength).toBe("VENDORCODE".length);
  });
});

describe("classification and correlation read the same acknowledgement the same way", () => {
  it("a CRLF-terminated acknowledgement yields BOTH its MSA-2 and its MSA-1", () => {
    // A peer whose interface engine terminates segments with CRLF. If the MSA-1 read split
    // segments on CR alone, the second element would begin with LF, no MSA segment would be
    // found, and a correctly answered send would sit pending to its timeout while its MSA-2
    // had been located perfectly well.
    const crlf = ack("AA", "MSG001", "\r\n");
    expect(extractMsaControlId(crlf)).toBe("MSG001");
    expect(classifyMsa1(crlf)).toMatchObject({ kind: "code", code: "AA" });
  });

  it("a leading CR before the MSH is read by both, not discarded by either", () => {
    const leading = Buffer.concat([Buffer.from("\r"), ack("CA")]);
    expect(extractMsaControlId(leading)).toBe("MSG001");
    expect(classifyMsa1(leading)).toMatchObject({ kind: "code", code: "CA" });
  });

  it("a one-byte MSH-2 declares a component separator and no repetition separator", () => {
    // The field after MSH-1 is a single byte, so there is no second byte to take a
    // repetition separator from. The read applies the component separator it did declare
    // and leaves the repetition split undone, rather than inventing a delimiter.
    const oneByteEnc = Buffer.from("MSH|^|R|F2|S|F|20260101000000||ACK|A1|P|2.5.1\rMSA|CA^X|M1\r");
    expect(classifyMsa1(oneByteEnc)).toMatchObject({ kind: "code", code: "CA" });
    const withRepetition = Buffer.from(
      "MSH|^|R|F2|S|F|20260101000000||ACK|A1|P|2.5.1\rMSA|CA~AA|M1\r",
    );
    expect(classifyMsa1(withRepetition)).toMatchObject({ kind: "unclassifiable" });
  });

  it("an empty MSH-2 leaves both splits undone", () => {
    const noEnc = Buffer.from("MSH||R|F2|S|F|20260101000000||ACK|A1|P|2.5.1\rMSA|CA|M1\r");
    expect(classifyMsa1(noEnc)).toMatchObject({ kind: "code", code: "CA" });
  });

  it("a non-default field separator is honoured on both reads", () => {
    const bang = Buffer.from("MSH!^~\\&!R!F2!S!F!20260101000000!!ACK!A1!P!2.5.1\rMSA!CA!M1\r");
    expect(extractMsaControlId(bang)).toBe("M1");
    expect(classifyMsa1(bang)).toMatchObject({ kind: "code", code: "CA" });
  });

  it("a segment that merely starts with the letters MSA is not one", () => {
    const notMsa = Buffer.from(
      "MSH|^~\\&|R|F2|S|F|20260101000000||ACK|A1|P|2.5.1\rMSAX|CA|M1\r",
      "latin1",
    );
    expect(extractMsaControlId(notMsa)).toBeNull();
    expect(classifyMsa1(notMsa)).toMatchObject({ kind: "null" });
  });
});

describe("selecting the half of Table 0008 an inbound message asked for", () => {
  const DISPOSITIONS: readonly Table0008Code[] = ["AA", "AE", "AR"];

  it("AL asks always, NE never", () => {
    for (const disposition of DISPOSITIONS) {
      expect(
        acceptAckRequested(readAcceptCondition(readMshSegment(outbound("AL", ""))), disposition),
      ).toBe(true);
      expect(
        acceptAckRequested(readAcceptCondition(readMshSegment(outbound("NE", ""))), disposition),
      ).toBe(false);
    }
  });

  it("ER asks on an error or a reject only, SU on a positive only", () => {
    const er = readAcceptCondition(readMshSegment(outbound("ER", "")));
    expect(acceptAckRequested(er, "AA")).toBe(false);
    expect(acceptAckRequested(er, "AE")).toBe(true);
    expect(acceptAckRequested(er, "AR")).toBe(true);
    const su = readAcceptCondition(readMshSegment(outbound("SU", "")));
    expect(acceptAckRequested(su, "AA")).toBe(true);
    expect(acceptAckRequested(su, "AE")).toBe(false);
    expect(acceptAckRequested(su, "AR")).toBe(false);
  });

  it("a null or unrecognised MSH-15 asks for nothing", () => {
    for (const value of ["", "XX", '""']) {
      const read = readAcceptCondition(readMshSegment(outbound(value, "")));
      for (const disposition of DISPOSITIONS) {
        expect(acceptAckRequested(read, disposition)).toBe(false);
      }
    }
  });

  it("the accept-mode counterpart maps each half onto the other", () => {
    expect(acceptModeCounterpart("AA")).toBe("CA");
    expect(acceptModeCounterpart("AE")).toBe("CE");
    expect(acceptModeCounterpart("AR")).toBe("CR");
    expect(acceptModeCounterpart("CA")).toBe("CA");
    expect(acceptModeCounterpart("CE")).toBe("CE");
    expect(acceptModeCounterpart("CR")).toBe("CR");
  });
});
