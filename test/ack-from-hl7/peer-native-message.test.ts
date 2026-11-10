/**
 * An `Hl7Message` built by the same `@cosyte/hl7` instance this adapter loads is acknowledged
 * as it stands, with no round trip through text. (A message from another loaded copy of the
 * library is round-tripped; `control-id-verbatim.test.ts` covers that side.)
 */

import { describe, expect, it } from "vitest";

import { buildAckAA, buildAckAE } from "../../src/ack-from-hl7/build.js";
import { loadHl7Peer } from "../../src/ack-from-hl7/peer.js";

const INBOUND =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00077|P|2.5\r" +
  "PID|1||SYNTH^^^^MR||DOE^JANE\r";

describe("buildMllpAck with a message from the adapter's own peer instance", () => {
  it("echoes its MSH-10 and answers AA", () => {
    const peer = loadHl7Peer();
    const msg = peer.parseHL7(INBOUND);
    expect(msg).toBeInstanceOf(peer.Hl7Message);

    const ack = buildAckAA(msg);

    expect(ack.code).toBe("AA");
    expect(ack.correlationId).toBe("MSG00077");
    expect(ack.warnings).toEqual([]);
    expect(peer.parseHL7(ack.payload.toString("latin1")).get("MSA.2")).toBe("MSG00077");
  });

  it("carries a negative code through unchanged", () => {
    const peer = loadHl7Peer();
    const ack = buildAckAE(peer.parseHL7(INBOUND));
    expect(ack.code).toBe("AE");
    expect(ack.correlationId).toBe("MSG00077");
  });
});
