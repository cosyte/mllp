/**
 * Core `buildMllpAck` behavior, the ack-from-hl7 adapter over `@cosyte/hl7`'s
 * `buildAck`. Fixtures are synthetic-only (DOE/SYNTH/TEST names), never PHI.
 */

import { describe, expect, it } from "vitest";
import { parseHL7 } from "@cosyte/hl7";

import {
  buildMllpAck,
  buildAckAA,
  buildAckAE,
  buildAckAR,
  buildAckCA,
  buildAckCE,
  buildAckCR,
} from "../../src/ack-from-hl7/build.js";
import { extractMshControlId } from "../../src/client/correlator.js";
import { loadHl7Peer } from "../../src/ack-from-hl7/peer.js";

/** A minimal, well-formed inbound ADT^A01 with a correlatable MSH-10. */
const INBOUND =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5\r" +
  "PID|1||SYNTH^^^^MR||DOE^JANE\r";

/**
 * Replace the two volatile MSH fields (MSH-7 timestamp, MSH-10 control id)
 * with stable placeholders so a built ACK can be asserted against a golden
 * string. Mirrors hl7's own `test/builder-ack.test.ts` normalizeAck.
 */
function normalizeAck(wire: string): string {
  return wire
    .split("\r")
    .map((line) => {
      if (!line.startsWith("MSH")) return line;
      const parts = line.split("|");
      parts[6] = "<TS>"; // MSH-7
      parts[9] = "<CID>"; // MSH-10
      return parts.join("|");
    })
    .join("\r");
}

describe("buildMllpAck, AA happy path", () => {
  it("frame starts VT, ends FS CR", () => {
    const { frame } = buildAckAA(INBOUND);
    expect(frame[0]).toBe(0x0b);
    expect(frame[frame.length - 2]).toBe(0x1c);
    expect(frame[frame.length - 1]).toBe(0x0d);
  });

  it("payload between VT and FS re-parses via peer parseHL7", () => {
    const { frame, payload } = buildAckAA(INBOUND);
    const inner = frame.subarray(1, frame.length - 2);
    expect(inner.equals(payload)).toBe(true);
    const round = parseHL7(payload);
    expect(round.meta.messageCode).toBe("ACK");
  });

  it("MSA-1 is AA, MSA-2 echoes inbound MSH-10, correlationId matches", () => {
    const ack = buildAckAA(INBOUND);
    expect(ack.ack.get("MSA.1")).toBe("AA");
    expect(ack.ack.get("MSA.2")).toBe("MSG00001");
    expect(ack.correlationId).toBe("MSG00001");
  });

  it("swaps addressing: ACK MSH-3/4 = inbound MSH-5/6, ACK MSH-5/6 = inbound MSH-3/4", () => {
    const ack = buildAckAA(INBOUND);
    expect(ack.ack.meta.sendingApp).toBe("RECVAPP");
    expect(ack.ack.meta.sendingFacility).toBe("RECVFAC");
    expect(ack.ack.meta.receivingApp).toBe("SENDAPP");
    expect(ack.ack.meta.receivingFacility).toBe("SENDFAC");
  });

  it("result is frozen", () => {
    const ack = buildAckAA(INBOUND);
    expect(Object.isFrozen(ack)).toBe(true);
    expect(Object.isFrozen(ack.warnings)).toBe(true);
  });
});

describe("buildMllpAck, golden wire (normalized)", () => {
  it("bare AA normalizes to the expected wire", () => {
    const bare = "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5";
    const ack = buildAckAA(bare);
    expect(normalizeAck(ack.payload.toString("utf8"))).toBe(
      "MSH|^~\\&|RECVAPP|RECVFAC|SENDAPP|SENDFAC|<TS>||ACK^A01^ACK|<CID>|P|2.5\r" +
        "MSA|AA|MSG00001\r",
    );
  });

  it("AE with one ERR normalizes to the expected wire", () => {
    const bare = "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5";
    const ack = buildAckAE(bare, {
      error: { conditionCode: "101", severity: "E", location: "PID^1^5" },
    });
    expect(normalizeAck(ack.payload.toString("utf8"))).toBe(
      "MSH|^~\\&|RECVAPP|RECVFAC|SENDAPP|SENDFAC|<TS>||ACK^A01^ACK|<CID>|P|2.5\r" +
        "MSA|AE|MSG00001\r" +
        "ERR||PID^1^5|101^Required field missing^HL70357|E\r",
    );
  });
});

describe("buildMllpAck, ERR segments", () => {
  it("AE with error detail carries ERR-3 CWE + ERR-4 severity", () => {
    const ack = buildAckAE(INBOUND, {
      error: { conditionCode: "101", severity: "E", location: "PID^1^5" },
    });
    const round = parseHL7(ack.payload);
    const err = round.segments("ERR")[0];
    expect(err).toBeDefined();
    expect(err?.field(3).asCwe().identifier).toBe("101");
    expect(err?.field(4).value).toBe("E");
  });

  it("multiple error details produce multiple ERR segments", () => {
    const ack = buildAckAR(INBOUND, {
      error: [
        { conditionCode: "200", severity: "E" },
        { conditionCode: "203", severity: "W", location: "MSH^1^12" },
      ],
    });
    const round = parseHL7(ack.payload);
    const errs = round.segments("ERR");
    expect(errs).toHaveLength(2);
    expect(errs[0]?.field(3).asCwe().identifier).toBe("200");
    expect(errs[1]?.field(3).asCwe().identifier).toBe("203");
  });
});

describe("buildMllpAck, inbound input shapes", () => {
  it("accepts a Buffer inbound with the same result as string (MSH-10 differs, freshly generated)", () => {
    const fromString = buildAckAA(INBOUND);
    const fromBuffer = buildAckAA(Buffer.from(INBOUND, "utf8"));
    expect(fromBuffer.code).toBe(fromString.code);
    expect(fromBuffer.correlationId).toBe(fromString.correlationId);
    expect(normalizeAck(fromBuffer.payload.toString("utf8"))).toBe(
      normalizeAck(fromString.payload.toString("utf8")),
    );
  });

  it("accepts an already-parsed Hl7Message inbound", () => {
    const parsed = parseHL7(INBOUND);
    const ack = buildAckAA(parsed);
    expect(ack.correlationId).toBe("MSG00001");
    expect(ack.code).toBe("AA");
  });
});

describe("buildMllpAck, requestedCode vs code", () => {
  it("are equal on the happy path", () => {
    const ack = buildAckAA(INBOUND);
    expect(ack.requestedCode).toBe("AA");
    expect(ack.code).toBe("AA");
  });
});

describe("buildMllpAck, encoding option", () => {
  it("payload bytes match toString() serialized in the requested encoding", () => {
    const ack = buildMllpAck(INBOUND, { code: "AA", encoding: "latin1" });
    expect(ack.payload.equals(Buffer.from(ack.ack.toString(), "latin1"))).toBe(true);
  });

  it("defaults to utf8 when omitted", () => {
    const ack = buildAckAA(INBOUND);
    expect(ack.payload.equals(Buffer.from(ack.ack.toString(), "utf8"))).toBe(true);
  });
});

describe("buildMllpAck, runtime code validation", () => {
  it("throws TypeError on an unknown code (JS caller, cast)", () => {
    expect(() => buildMllpAck(INBOUND, { code: "ZZ" as unknown as "AA" })).toThrow(TypeError);
  });
});

describe("buildMllpAck, six convenience wrappers", () => {
  it.each([
    ["buildAckAA", buildAckAA, "AA"],
    ["buildAckAE", buildAckAE, "AE"],
    ["buildAckAR", buildAckAR, "AR"],
    ["buildAckCA", buildAckCA, "CA"],
    ["buildAckCE", buildAckCE, "CE"],
    ["buildAckCR", buildAckCR, "CR"],
  ] as const)("%s emits MSA-1 = %s", (_name, fn, expected) => {
    const ack = fn(INBOUND);
    expect(ack.requestedCode).toBe(expected);
  });
});

describe("buildMllpAck, verbatim MSA-2 echo (vendor-quirk control ids)", () => {
  /** Inbound whose MSH-10 carries an unescaped component delimiter, a real vendor quirk. */
  const INBOUND_QUIRKY =
    "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|ID^X|P|2.5\r";

  it("echoes a delimiter-bearing MSH-10 verbatim: correlationId and the wire MSA-2 are byte-for-byte", () => {
    const ack = buildAckAA(INBOUND_QUIRKY);
    expect(ack.code).toBe("AA"); // NOT downgraded, the id has content
    expect(ack.correlationId).toBe("ID^X");
    const msaLine = ack.payload
      .toString("utf8")
      .split("\r")
      .find((l) => l.startsWith("MSA"));
    expect(msaLine).toBe("MSA|AA|ID^X");
  });

  it("the ACK's MSA-2 matches what this package's own client correlator extracted from the inbound", () => {
    const inboundPayload = Buffer.from(INBOUND_QUIRKY.replace(/\r$/, ""), "utf8");
    const senderKey = extractMshControlId(inboundPayload);
    expect(senderKey).toBe("ID^X");
    const ack = buildAckAA(inboundPayload);
    expect(ack.correlationId).toBe(senderKey);
  });
});

describe("buildMllpAck, framing safety for escape-bearing control ids", () => {
  it("a hex-escaped CR in the inbound MSH-10 never corrupts the framed ACK", () => {
    const raw =
      "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|A\\X0D\\B|P|2.5\r";
    const ack = buildAckAA(raw);
    expect(ack.code).toBe("AA");
    // The payload contains no raw CR except the segment separators, exactly
    // MSH + MSA, and it re-parses cleanly through the peer.
    const lines = ack.payload
      .toString("utf8")
      .split("\r")
      .filter((l) => l !== "");
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe("MSA|AA|A\\X0D\\B");
    const round = loadHl7Peer().parseHL7(ack.payload);
    expect(round.segments("MSA")).toHaveLength(1);
  });
});
