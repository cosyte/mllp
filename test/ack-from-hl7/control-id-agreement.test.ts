/**
 * MLLP-ACK-UTF8, refuter round 1, the two properties the conformance gate refuted.
 *
 * **1. The scan stops at the segment terminator.** `extractMshControlId` counted field
 * separators without ever stopping at `CR`/`LF`. On a **truncated MSH**, one with fewer
 * than 10 fields, which is malformed but is exactly what a peer sends when it is broken,
 * the count ran *past* the segment terminator and kept counting inside the next segment.
 * The "MSH-10" it returned was `PID-3`: the patient's **MRN**. That value became the
 * client's correlation key, went into `MllpTimeoutError.messageControlId` and the
 * `MLLP_ACK_UNMATCHED_CONTROL_ID` / `MLLP_ACK_AFTER_TIMEOUT` warnings, and (once the
 * verbatim check was added) got hex-rendered into a warning message. A patient identifier,
 * mis-read, in a log line. A field that does not exist must read as **absent**.
 *
 * **2. The three call sites actually agree.** The client's correlator, `buildRawAck`, and
 * `buildMllpAck` must return the same answer for the same bytes, because a disagreement
 * between any two of them is an ACK the sender cannot match → timeout → resend →
 * duplicate clinical message. They each used to re-derive the read; two inputs below made
 * all three disagree. They now share `readMshSegment`, and these tests are what says so.
 *
 * Fixtures are synthetic-only (DOE/SYNTH/TEST names, invented MRNs), never PHI.
 */

import { describe, expect, it } from "vitest";

import { buildAckAA } from "../../src/ack-from-hl7/index.js";
import { encodeFrame, FrameReader } from "../../src/framing/index.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { readMshSegment } from "../../src/internal/control-id.js";
import { buildRawAck } from "../../src/server/ack.js";

/** A truncated MSH (6 fields, no MSH-10), followed by a PID carrying real identifiers. */
const TRUNCATED_MSH_THEN_PID = Buffer.from(
  "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB\rPID|1||MRN00042||DOE^SYNTH^Q||19850312|F\r",
  "latin1",
);

describe("the control-ID scan STOPS at the segment terminator (no PHI can leak into it)", () => {
  it("a truncated MSH yields NO control id, never a field of the next segment", () => {
    // The regression: this returned "MRN00042", PID-3, the patient's medical record number.
    expect(extractMshControlId(TRUNCATED_MSH_THEN_PID)).toBeNull();
  });

  it("no PID field can be reached by the MSH scan, whatever the truncation point", () => {
    // Sweep every truncation of the MSH: none may surface anything from the PID.
    const msh = "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB|20260714120000||ADT^A01|CID001|P|2.5.1";
    const pid = "PID|1||MRN00042||DOE^SYNTH^Q||19850312|F";
    for (let cut = 3; cut < msh.length; cut++) {
      const buf = Buffer.from(`${msh.slice(0, cut)}\r${pid}\r`, "latin1");
      const id = extractMshControlId(buf);
      if (id === null) continue;
      expect(id, `truncation at ${String(cut)}`).not.toContain("MRN00042");
      expect(id, `truncation at ${String(cut)}`).not.toContain("DOE");
      expect(id, `truncation at ${String(cut)}`).not.toContain("19850312");
      // Whatever it found, it must be a field of the MSH we actually gave it.
      expect(msh.slice(0, cut).split("|")).toContain(id);
    }
  });

  it("readMshSegment never returns a field past the MSH's own terminator", () => {
    const msh = readMshSegment(TRUNCATED_MSH_THEN_PID);
    expect(msh).not.toBeNull();
    expect(msh?.fields).toEqual(["MSH", "^~\\&", "EPIC", "HOSP", "MIRTH", "LAB"]);
    expect(msh?.fields.join("|")).not.toContain("MRN00042");
  });

  it("an LF-terminated MSH is bounded too", () => {
    const buf = Buffer.from("MSH|^~\\&|EPIC|HOSP|MIRTH|LAB\nPID|1||MRN00042\n", "latin1");
    expect(extractMshControlId(buf)).toBeNull();
    expect(readMshSegment(buf)?.fields).not.toContain("MRN00042");
  });

  it("a well-formed MSH still reads its MSH-10 (the fix is not a lobotomy)", () => {
    const buf = Buffer.from(
      "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB|20260714120000||ADT^A01|CID001|P|2.5.1\rPID|1||MRN00042\r",
      "latin1",
    );
    expect(extractMshControlId(buf)).toBe("CID001");
  });
});

describe("the truncated MSH does not produce a bogus NOT_VERBATIM warning", () => {
  it("warns UNPARSEABLE or nothing, never 'failed to echo' an MSH-10 that never existed", () => {
    // The verbatim check promises it never warns on a comparison it could not perform.
    // With no MSH-10 in the inbound, there is nothing to compare.
    const ack = buildAckAA(TRUNCATED_MSH_THEN_PID);
    expect(ack.warnings.map((w) => w.code)).not.toContain("MLLP_ACK_CONTROL_ID_NOT_VERBATIM");
    // And nothing anywhere in the result may carry the patient's identifiers.
    for (const w of ack.warnings) {
      expect(w.message).not.toContain("MRN00042");
      expect(w.message).not.toContain("DOE");
    }
  });

  it("the ACK bytes carry no PID content either", () => {
    const raw = buildRawAck(TRUNCATED_MSH_THEN_PID, "AA").toString("latin1");
    expect(raw).not.toContain("MRN00042");
    expect(raw).not.toContain("DOE");
    expect(raw).not.toContain("19850312");
  });
});

describe("the three call sites agree on what a control ID is", () => {
  /** The client's key, `buildRawAck`'s echo, and `buildMllpAck`'s echo, for one input. */
  function threeReadings(payload: Buffer): {
    correlator: string | null;
    rawAck: string | null;
    fromHl7: string | null;
  } {
    let fromHl7: string | null;
    try {
      fromHl7 = extractMsaControlId(buildAckAA(payload).payload);
    } catch {
      fromHl7 = null; // an inbound it refuses to parse echoes nothing, that IS "no id"
    }
    return {
      correlator: extractMshControlId(payload),
      rawAck: extractMsaControlId(buildRawAck(payload, "AA")),
      fromHl7,
    };
  }

  const cases: ReadonlyArray<readonly [string, Buffer]> = [
    // Both inputs the refuter used to make the three disagree.
    ["truncated MSH followed by a PID", TRUNCATED_MSH_THEN_PID],
    [
      "a leading LF before the MSH",
      Buffer.from("\nMSH|^~\\&|A|B|C|D|ts||ADT^A01|CID001|P|2.5.1\r", "latin1"),
    ],
    // And the ordinary shapes, so agreement is not achieved by everything returning null.
    [
      "a well-formed message",
      Buffer.from("MSH|^~\\&|A|B|C|D|ts||ADT^A01|CID001|P|2.5.1\r", "latin1"),
    ],
    ["MSH with an empty MSH-10", Buffer.from("MSH|^~\\&|A|B|C|D|ts||ADT^A01||P|2.5.1\r", "latin1")],
    ["not HL7 at all", Buffer.from("garbage", "latin1")],
    ["a bare MSH", Buffer.from("MSH\r", "latin1")],
    [
      "MSH-1 is a framing byte (VT)",
      Buffer.from("MSH\v^~\\&\vA\vB\vC\vD\vts\v\vADT\vID1\r", "latin1"),
    ],
  ];

  it.each(cases)("agrees on: %s", (_name, payload) => {
    const { correlator, rawAck, fromHl7 } = threeReadings(payload);
    // The correlator is the reference, it is what the sender keys on. Whatever it says,
    // both builders must echo. `null` on the correlator means "no key", and then neither
    // builder may claim to have echoed one.
    expect(rawAck).toBe(correlator);
    expect(fromHl7).toBe(correlator);
  });

  it("agrees under a custom field separator, INCLUDING buildMllpAck", () => {
    // A delimiter-free control id survives `@cosyte/hl7`'s re-delimiting intact, so all
    // three agree here, `buildMllpAck` included. (It is only when the id itself contains
    // one of the inbound's own delimiters, e.g. `ID#X` under a `#` component separator,
    // that upstream's fixed `|^~\&` output cannot represent it. That case must WARN, and
    // control-id-verbatim.test.ts asserts it does.)
    const payload = Buffer.from("MSH!^~\\&!A!B!C!D!ts!!ADT^A01!CID001!P!2.5.1\r", "latin1");
    const { correlator, rawAck, fromHl7 } = threeReadings(payload);
    expect(correlator).toBe("CID001");
    expect(rawAck).toBe("CID001");
    expect(fromHl7).toBe("CID001");
  });
});

describe("the MSH is LOCATED, not demanded at byte 0 (tolerance is not negotiable)", () => {
  /** Drive a payload through the real decoder, then the real auto-ACK builder. */
  function throughTheWire(payload: Buffer): { delivered: Buffer; ackMsa2: string | null } {
    let delivered: Buffer | null = null;
    const reader = new FrameReader({
      onFrame: (p) => {
        delivered = p;
      },
      onWarning: () => {},
    });
    reader.push(encodeFrame(payload));
    if (delivered === null) throw new Error("decoder delivered no frame");
    const d: Buffer = delivered;
    return { delivered: d, ackMsa2: extractMsaControlId(buildRawAck(d, "AA")) };
  }

  // Both shapes carry MSH-10 = MSG00042. Both are peer-reachable. Requiring `MSH` at byte 0
  // made buildRawAck emit a positive AA with an EMPTY MSA-2 and no warning, the sender,
  // keying on the MSH-10 it sent, cannot correlate it → timeout → resend → duplicate
  // clinical message. Silently dropping a field that is present is the one thing a lenient
  // reader must never do.
  const MSH = "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB|20260714120000||ADT^A01|MSG00042|P|2.5.1";

  it("a LEADING CR does not hide the control ID (the decoder passes it through)", () => {
    const { delivered, ackMsa2 } = throughTheWire(
      Buffer.from(`\r${MSH}\rPID|1||MRN00042\r`, "latin1"),
    );
    expect(extractMshControlId(delivered)).toBe("MSG00042");
    expect(ackMsa2).toBe("MSG00042");
  });

  it("a LEADING LF does not hide the control ID", () => {
    const { delivered, ackMsa2 } = throughTheWire(Buffer.from(`\n${MSH}\r`, "latin1"));
    expect(extractMshControlId(delivered)).toBe("MSG00042");
    expect(ackMsa2).toBe("MSG00042");
  });

  it("the byte scanners still locate an MSH behind an FHS/BHS header (as main did)", () => {
    // The byte-level scanners and `buildRawAck` find the MSH wherever the segment is,
    // `buildRawAck` always did (it hunted for a segment starting with `MSH`), so this is
    // main's behaviour preserved, not new tolerance. It is NOT a batch feature: see the
    // batch suite below for what the parser-backed builder does, and why.
    const batch = `FHS|^~\\&|SENDER\rBHS|^~\\&|SENDER\r${MSH}\rPID|1||MRN00042\r`;
    const { delivered, ackMsa2 } = throughTheWire(Buffer.from(batch, "latin1"));
    expect(extractMshControlId(delivered)).toBe("MSG00042");
    expect(ackMsa2).toBe("MSG00042");
  });

  it("a located MSH is still BOUNDED at its own terminator (both rules hold at once)", () => {
    // Truncated MSH behind a batch header: the MSH must be found, AND the scan must stop at
    // its CR rather than walking into the PID. Neither rule may be traded for the other.
    const truncated = "FHS|^~\\&\rMSH|^~\\&|EPIC|HOSP|MIRTH|LAB\rPID|1||MRN00042||DOE^SYNTH\r";
    const { delivered } = throughTheWire(Buffer.from(truncated, "latin1"));
    expect(extractMshControlId(delivered)).toBeNull();
    expect(buildRawAck(delivered, "AA").toString("latin1")).not.toContain("MRN00042");
  });

  it("a payload with NO MSH anywhere still reads as unreadable", () => {
    const { delivered, ackMsa2 } = throughTheWire(
      Buffer.from("FHS|^~\\&\rPID|1||MRN00042\r", "latin1"),
    );
    expect(extractMshControlId(delivered)).toBeNull();
    expect(ackMsa2).toBeNull();
  });
});

describe("a BATCH is refused loudly, never a positive AA for messages nobody read", () => {
  /**
   * An HL7 batch (§2.10.3) is `[FHS] { [BHS] { MSH … } [BTS] } [FTS]`, a **sequence** of
   * messages, with BTS-1 carrying the count. `@cosyte/mllp` does not implement batch ACK.
   * The only safe answer is therefore the one `parseHL7` already gives: `NO_MSH_SEGMENT`
   * out into the warned, non-positive `AE` fallback, a loud refusal to acknowledge what
   * we did not read.
   *
   * The trap this locks shut: an interim version of MLLP-ACK-UTF8 re-based the payload on
   * the *located* MSH before parsing, which skipped the batch envelope. `buildMllpAck` then
   * parsed message 1, silently discarded every later MSH and the BTS/FTS, and returned a
   * confident **`AA` correlated to message 1 with ZERO warnings**. The sender reads that as
   * "batch accepted", so messages 2..N are lost outright, or time out and resend as
   * duplicate clinical messages. A positive ACK for a message nobody looked at is the exact
   * failure the commit contract exists to make structurally impossible.
   *
   * Do not "fix" this into a positive AA. Batch ACK is its own feature, to be built
   * deliberately (parse every MSH, verify the BTS count, emit a batch ACK), never arrived
   * at by accident via a byte-offset helper.
   */
  const msg = (id: string): string =>
    `MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|${id}|P|2.5.1\rPID|1||MRN00042\r`;

  const batch = (...ids: readonly string[]): Buffer =>
    Buffer.from(
      `FHS|^~\\&|S|F\rBHS|^~\\&|S|F\r${ids.map(msg).join("")}BTS|${String(ids.length)}\rFTS|1\r`,
      "latin1",
    );

  it("a TWO-message batch never yields a positive AA", () => {
    const ack = buildAckAA(batch("MSG00001", "MSG00002"));

    expect(ack.code).toBe("AE"); // downgraded, never AA
    expect(ack.correlationId).toBeUndefined(); // no fabricated correlation
    expect(ack.warnings.map((w) => w.code)).toContain("MLLP_ACK_INBOUND_UNPARSEABLE");
    // Above all: it must NOT claim to have accepted message 1 while ignoring message 2.
    expect(ack.payload.toString("latin1")).not.toContain("MSG00001");
    expect(ack.payload.toString("latin1")).not.toContain("MSG00002");
  });

  it("a ONE-message batch is refused too, the envelope is what we cannot read", () => {
    const ack = buildAckAA(batch("MSG00001"));
    expect(ack.code).toBe("AE");
    expect(ack.correlationId).toBeUndefined();
    expect(ack.warnings.map((w) => w.code)).toContain("MLLP_ACK_INBOUND_UNPARSEABLE");
  });

  it("but a LEADING CR/LF is still stripped, terminator noise carries no data", () => {
    // The line between the two: a leading CR is pure segment-terminator noise, so dropping
    // it hides nothing. An FHS/BHS envelope is DATA, and dropping it hides messages.
    for (const prefix of ["\r", "\n", "\r\n", "\r\r\n"]) {
      const ack = buildAckAA(Buffer.from(`${prefix}${msg("MSG00042")}`, "latin1"));
      expect(ack.code, `prefix ${JSON.stringify(prefix)}`).toBe("AA");
      expect(ack.correlationId, `prefix ${JSON.stringify(prefix)}`).toBe("MSG00042");
      expect(ack.warnings, `prefix ${JSON.stringify(prefix)}`).toHaveLength(0);
    }
  });

  it("a string inbound answers exactly as the equivalent Buffer does", () => {
    // The tolerant strip is applied to bytes and text alike, so the two branches cannot
    // disagree about the same message.
    const text = `\r${msg("MSG00042")}`;
    const fromText = buildAckAA(text);
    const fromBytes = buildAckAA(Buffer.from(text, "latin1"));
    expect(fromText.code).toBe(fromBytes.code);
    expect(fromText.correlationId).toBe(fromBytes.correlationId);

    const batchText = batch("MSG00001", "MSG00002").toString("latin1");
    expect(buildAckAA(batchText).code).toBe("AE");
    expect(buildAckAA(batchText).correlationId).toBeUndefined();
  });
});
