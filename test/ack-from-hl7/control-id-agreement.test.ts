/**
 * MLLP-ACK-UTF8, refuter round 1 — the two properties the conformance gate refuted.
 *
 * **1. The scan stops at the segment terminator.** `extractMshControlId` counted field
 * separators without ever stopping at `CR`/`LF`. On a **truncated MSH** — one with fewer
 * than 10 fields, which is malformed but is exactly what a peer sends when it is broken —
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
 * Fixtures are synthetic-only (DOE/SYNTH/TEST names, invented MRNs) — never PHI.
 */

import { describe, expect, it } from "vitest";

import { buildAckAA } from "../../src/ack-from-hl7/index.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { readMshSegment } from "../../src/internal/control-id.js";
import { buildRawAck } from "../../src/server/ack.js";

/** A truncated MSH (6 fields — no MSH-10), followed by a PID carrying real identifiers. */
const TRUNCATED_MSH_THEN_PID = Buffer.from(
  "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB\rPID|1||MRN00042||DOE^SYNTH^Q||19850312|F\r",
  "latin1",
);

describe("the control-ID scan STOPS at the segment terminator (no PHI can leak into it)", () => {
  it("a truncated MSH yields NO control id — never a field of the next segment", () => {
    // The regression: this returned "MRN00042" — PID-3, the patient's medical record number.
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
  it("warns UNPARSEABLE or nothing — never 'failed to echo' an MSH-10 that never existed", () => {
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
  /** The client's key, `buildRawAck`'s echo, and `buildMllpAck`'s echo — for one input. */
  function threeReadings(payload: Buffer): {
    correlator: string | null;
    rawAck: string | null;
    fromHl7: string | null;
  } {
    let fromHl7: string | null;
    try {
      fromHl7 = extractMsaControlId(buildAckAA(payload).payload);
    } catch {
      fromHl7 = null; // an inbound it refuses to parse echoes nothing — that IS "no id"
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
    // The correlator is the reference — it is what the sender keys on. Whatever it says,
    // both builders must echo. `null` on the correlator means "no key", and then neither
    // builder may claim to have echoed one.
    expect(rawAck).toBe(correlator);
    expect(fromHl7).toBe(correlator);
  });

  it("agrees under a custom field separator", () => {
    const payload = Buffer.from("MSH!^~\\&!A!B!C!D!ts!!ADT^A01!CID001!P!2.5.1\r", "latin1");
    const { correlator, rawAck } = threeReadings(payload);
    expect(correlator).toBe("CID001");
    expect(rawAck).toBe("CID001");
    // `buildMllpAck` cannot hold this one — @cosyte/hl7 always emits `|^~\&` — but it is
    // required to WARN rather than emit a silently unmatchable ACK. Covered in
    // control-id-verbatim.test.ts and the property suite.
  });
});
