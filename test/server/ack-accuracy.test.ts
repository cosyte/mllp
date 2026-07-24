/**
 * Accuracy gate for the Phase 6 ACK builder (HL7 v2.5.1 §2.9.2, Table 0008).
 *
 * `buildRawAck` is a one-way construction (raw bytes → ACK), but the two clinically
 * load-bearing facts it carries, the MSA-1 acknowledgement code and the MSA-2 echo of
 * the inbound MSH-10 control ID, must survive verbatim. We prove that with the
 * `@cosyte/test-utils` `roundTripProperty` runner: the in-memory model is
 * `{ code, controlId }`; `serialize` builds an inbound message with that control ID,
 * runs `buildRawAck`, and returns the **MSA segment** (which is fully determined by the
 * model, unlike the ACK's MSH, whose timestamp and fresh control ID are non-deterministic);
 * `parse` reads MSA-1/MSA-2 back out. Equality of the recovered model is the accuracy
 * check (catches a code copy/paste or a control-ID mis-echo that unit examples might miss);
 * the runner's idempotency assertion holds because the MSA segment is deterministic.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { roundTripProperty } from "@cosyte/test-utils";

import { buildRawAck, type AckCode } from "../../src/server/ack.js";

const ACK_CODES: readonly AckCode[] = ["AA", "AE", "AR", "CA", "CE", "CR"];

interface AckModel {
  readonly code: AckCode;
  readonly controlId: string;
}

/** Control IDs as a real sender would mint them: alphanumeric, 1..20 chars (no HL7 delimiters). */
const controlIdArb = fc
  .stringMatching(/^[A-Za-z0-9]{1,20}$/)
  .filter((s) => s.length >= 1 && s.length <= 20);

const ackModelArb: fc.Arbitrary<AckModel> = fc.record({
  code: fc.constantFrom(...ACK_CODES),
  controlId: controlIdArb,
});

function inboundWith(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SENDER|SFAC|RECV|RFAC|20260424120000||ADT^A01|${controlId}|P|2.5\r`,
    "ascii",
  );
}

/** Extract the deterministic MSA segment from a built ACK. */
function msaOf(model: AckModel): string {
  const ack = buildRawAck(inboundWith(model.controlId), model.code).toString("ascii");
  const msa = ack.split("\r").find((seg) => seg.startsWith("MSA"));
  if (msa === undefined) throw new Error("no MSA segment in ACK");
  return msa;
}

/** Read MSA-1 (code) and MSA-2 (control ID) back out of an MSA segment string. */
function parseMsa(msa: string): AckModel {
  const fields = msa.split("|");
  return { code: fields[1] as AckCode, controlId: fields[2] ?? "" };
}

describe("accuracy: buildRawAck carries MSA-1 code + MSA-2 control ID verbatim", () => {
  it("every Table 0008 code round-trips, and MSA-2 echoes the inbound MSH-10", () => {
    roundTripProperty<AckModel>({
      arbitrary: ackModelArb,
      serialize: msaOf,
      parse: parseMsa,
      equals: (a, b) => a.code === b.code && a.controlId === b.controlId,
      numRuns: 300,
    });
  });

  it("negative codes never carry inbound payload content (PHI-safe construction)", () => {
    fc.assert(
      fc.property(fc.constantFrom<AckCode>("AE", "AR"), controlIdArb, (code, controlId) => {
        const inbound = Buffer.from(
          `MSH|^~\\&|SENDER|SFAC|RECV|RFAC|20260424120000||ADT^A01|${controlId}|P|2.5\r` +
            `PID|||999888777^^^FAC||SECRETLAST^SECRETFIRST\r`,
          "ascii",
        );
        const ack = buildRawAck(inbound, code).toString("ascii");
        expect(ack).not.toContain("SECRETLAST");
        expect(ack).not.toContain("SECRETFIRST");
        expect(ack).not.toContain("999888777");
        // ...but the control ID (routing metadata, not PHI) is still echoed.
        expect(ack).toContain(`|${controlId}|`);
      }),
      { numRuns: 200 },
    );
  });
});
