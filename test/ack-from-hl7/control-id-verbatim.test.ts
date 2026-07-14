/**
 * MLLP-ACK-UTF8 — the `ack-from-hl7` subpath must echo MSH-10 into MSA-2
 * **byte-verbatim** (HL7 v2.5.1 §2.9.2.2).
 *
 * The bug this locks out: `buildMllpAck` decoded the inbound through the peer
 * parser's charset machinery and re-encoded the ACK through a hardcoded `utf8`.
 * The two are not inverses. A control-ID byte `0x8B` (legal under an MSH-18 of
 * `8859/1`) came back out of MSA-2 as the TWO bytes `0xC2 0x8B` — a different
 * control ID. A `@cosyte/mllp` client, which keys its in-flight store on the raw
 * `latin1` bytes it sent, could not match that ACK: ACK timeout → resend →
 * **duplicate clinical message**.
 *
 * The end-to-end test in this file is the one that matters: a real `MllpClient`
 * in controlId mode talking to a server that ACKs with `buildAckAA`, over the
 * in-memory transport. That is the exact cosyte↔cosyte channel the bug broke.
 */

import { describe, expect, it } from "vitest";

import {
  buildAckAA,
  buildAckAE,
  buildMllpAck,
  MLLP_ACK_CONTROL_ID_NOT_VERBATIM,
  MLLP_ACK_INBOUND_UNPARSEABLE,
} from "../../src/ack-from-hl7/index.js";
import { createClient } from "../../src/client/client.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { Connection } from "../../src/connection/index.js";
import { FrameReader } from "../../src/framing/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

/** MSH-10 = `A<0x8B>C` — a high-bit control ID, legal under MSH-18 = `8859/1`. */
const HIGH_BIT_ID = Buffer.from([0x41, 0x8b, 0x43]);

/** An inbound ADT whose MSH-10 is the given raw bytes and whose MSH-18 declares 8859/1. */
function inboundWithControlId(id: Buffer, fieldSep = "|", encChars = "^~\\&"): Buffer {
  const s = fieldSep;
  return Buffer.concat([
    Buffer.from(
      `MSH${s}${encChars}${s}SEND${s}FAC${s}RECV${s}RFAC${s}20260714120000${s}${s}ADT^A01${s}`,
      "latin1",
    ),
    id,
    Buffer.from(`${s}P${s}2.5.1${s}${s}${s}${s}${s}${s}${s}8859/1\r`, "latin1"),
  ]);
}

const hex = (s: string | null | undefined): string =>
  s === null || s === undefined ? "<none>" : Buffer.from(s, "latin1").toString("hex");

describe("ack-from-hl7 — MSA-2 echoes MSH-10 verbatim (HL7 v2.5.1 §2.9.2.2)", () => {
  it("a high-bit control ID survives into MSA-2 byte-for-byte", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);

    // The bytes on the wire are the bytes that arrived.
    expect(hex(extractMsaControlId(ack.payload))).toBe(HIGH_BIT_ID.toString("hex"));
    expect(extractMsaControlId(ack.payload)).toBe(extractMshControlId(inbound));
  });

  it("the ACK payload does NOT contain the utf8 double-encoding of the control ID", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);

    // The exact regression: `latin1` in, `utf8` out turned 0x8B into 0xC2 0x8B.
    expect(ack.payload.includes(Buffer.from([0xc2, 0x8b]))).toBe(false);
    expect(ack.payload.includes(Buffer.from([0x8b]))).toBe(true);
    // And never the `U+FFFD` replacement char, which a utf8 DECODE of 0x8B produces.
    expect(ack.payload.includes(Buffer.from("�", "utf8"))).toBe(false);
  });

  it("MllpAck.correlationId is the same string the client correlator keys on", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe(extractMshControlId(inbound));
  });

  it("a verbatim echo emits NO warning", () => {
    const ack = buildAckAA(inboundWithControlId(HIGH_BIT_ID));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("negative ACKs echo the control ID verbatim too", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAE(inbound, { error: { conditionCode: "101" } });
    expect(ack.code).toBe("AE");
    expect(extractMsaControlId(ack.payload)).toBe(extractMshControlId(inbound));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("every byte value 0x21..0xFF works as a control-ID byte", () => {
    for (let b = 0x21; b <= 0xff; b++) {
      // Skip the delimiters the message itself uses — those are structure, not content.
      if ("|^~\\&\r\n".includes(String.fromCharCode(b))) continue;
      const id = Buffer.from([0x49, b, 0x44]); // "I<b>D"
      const inbound = inboundWithControlId(id);
      const ack = buildAckAA(inbound);
      expect(hex(extractMsaControlId(ack.payload)), `byte 0x${b.toString(16)}`).toBe(
        id.toString("hex"),
      );
      expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    }
  });

  it("a plain-ASCII control ID is unaffected (no regression)", () => {
    const inbound = inboundWithControlId(Buffer.from("MSG00001", "latin1"));
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe("MSG00001");
    expect(extractMsaControlId(ack.payload)).toBe("MSG00001");
  });

  it("a UTF-8 inbound still round-trips its control-ID bytes exactly", () => {
    // MSH-10 = "ID-é" as real UTF-8 (0xC3 0xA9), MSH-18 = UNICODE UTF-8.
    const id = Buffer.from("ID-é", "utf8");
    const inbound = Buffer.concat([
      Buffer.from("MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|", "latin1"),
      id,
      Buffer.from("|P|2.5.1|||||||UNICODE UTF-8\r", "latin1"),
    ]);
    const ack = buildAckAA(inbound);
    // Byte-faithful: the same two UTF-8 bytes come back, not a re-encoding of them.
    expect(hex(extractMsaControlId(ack.payload))).toBe(id.toString("hex"));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — a non-verbatim echo is LOUD, never silent", () => {
  it("an `encoding` override that cannot round-trip the bytes warns", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    // `ascii` masks the high bit: 0x8B -> 0x0B. The caller asked for it; we must say so.
    const ack = buildMllpAck(inbound, { code: "AA", encoding: "ascii" });

    const warning = ack.warnings.find((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("§2.9.2.2");
    // The message names the bytes, in hex — routing metadata, never clinical content.
    expect(warning?.message).toContain("418b43");
  });

  it("`utf8` on a high-bit inbound warns — this is the exact pre-fix default", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildMllpAck(inbound, { code: "AA", encoding: "utf8" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an inbound with NON-DEFAULT encoding characters warns (documented limitation)", () => {
    // MSH-1 = `!`, component separator `#`. `@cosyte/hl7`'s buildMessage always emits the
    // HL7 default `|^~\&`, so MSA-2 gets re-delimited: `ID#X` -> `ID^X`. Different bytes,
    // so the sender cannot match it. We cannot fix that from here (it is upstream's
    // DEFAULT_ENCODING_CHARACTERS), so we refuse to let it pass quietly.
    const inbound = inboundWithControlId(Buffer.from("ID#X", "latin1"), "!", "#~\\&");
    const ack = buildMllpAck(inbound, { code: "AA" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an unparseable inbound warns UNPARSEABLE, not NOT_VERBATIM", () => {
    // MSA-2 is deliberately empty here — we refuse to fabricate a correlation id.
    // Reporting that deliberate choice as a §2.9.2.2 violation would be noise.
    const ack = buildAckAA(Buffer.from("this is not hl7 at all", "latin1"));
    const codes = ack.warnings.map((w) => w.code);
    expect(codes).toContain(MLLP_ACK_INBOUND_UNPARSEABLE);
    expect(codes).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an inbound with no MSH-10 does not warn NOT_VERBATIM (nothing to echo)", () => {
    const inbound = Buffer.from("MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01||P|2.5.1\r", "latin1");
    const ack = buildAckAA(inbound);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — text inbound keeps its utf8 default (back-compat)", () => {
  it("a string inbound is encoded utf8, as before", () => {
    const inbound = "MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|ID-é|P|2.5.1\r";
    const ack = buildAckAA(inbound);
    // The caller handed us text, so their code units are re-encoded utf8.
    expect(hex(extractMsaControlId(ack.payload))).toBe(Buffer.from("ID-é", "utf8").toString("hex"));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — end-to-end cosyte client ↔ cosyte ack-from-hl7 server", () => {
  it("a client in controlId mode correlates an ACK for a HIGH-BIT control ID", async () => {
    // This is the failure the item describes, reproduced as a real channel: the client
    // keys on the MSH-10 bytes it wrote; the server ACKs with `buildAckAA`. Before the
    // fix the ACK's MSA-2 was `0xC2 0x8B`, the lookup missed, `send()` never settled,
    // and the sender would time out and resend a duplicate clinical message.
    const [a, b] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: "127.0.0.1", port: 0, correlateByControlId: true });
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);

    // The "server": decode the inbound frame, ACK it with the ack-from-hl7 subpath.
    const reader = new FrameReader({
      onFrame: (payload) => {
        b.write(buildAckAA(payload).frame);
      },
      onWarning: () => {},
    });
    b.onData((chunk) => {
      reader.push(chunk);
    });

    const inbound = inboundWithControlId(HIGH_BIT_ID);
    // Resolves iff the ACK correlated. A regression hangs here rather than failing fast,
    // so bound it — an un-settled send is precisely the bug.
    const ack = await Promise.race([
      client.send(inbound),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error("send() never settled — the ACK did not correlate"));
        }, 2_000),
      ),
    ]);

    expect(extractMsaControlId(ack)).toBe(extractMshControlId(inbound));
    await client.close();
  });
});
