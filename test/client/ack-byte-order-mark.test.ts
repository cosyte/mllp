/**
 * An acknowledgement whose payload starts with a UTF-8 byte order mark (`EF BB BF`).
 *
 * Some interface engines write one before the `MSH` when they encode a message as UTF-8. The
 * bytes before `MSH` used to make the header unreadable, so a healthy acknowledgement could not
 * be matched by control ID and, in FIFO mode, drew `MLLP_ACK_FIFO_MSA1_UNREADABLE` (or rejected
 * the send under `fifoUnreadableAck: "reject"`). The mark is now skipped for reading the header
 * and MSA-1 and MSA-2, and the bytes handed to the caller stay exactly as received.
 *
 * Every payload here is synthetic.
 */

import { describe, it, expect } from "vitest";
import { createClient, type ClientOptions, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import {
  containsBatchOrExtraMessage,
  extractMsaControlId,
  extractMshControlId,
  readMsaSegment,
  readMshSegment,
} from "../../src/internal/control-id.js";
import { classifyMsa1 } from "../../src/internal/ack-mode.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (text: string): Buffer => Buffer.concat([BOM, Buffer.from(text, "latin1")]);

interface Harness {
  client: MllpClient;
  fromPeer: (payload: Buffer) => void;
  warnings: Array<{ code: string }>;
}

function harness(extra: Partial<ClientOptions> = {}): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const client = createClient({ host: "127.0.0.1", port: 0, ackTimeoutMs: 1_000, ...extra });
  const warnings: Array<{ code: string }> = [];
  client.on("warning", (w: { code: string }) => warnings.push(w));
  client.on("error", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, fromPeer: (payload) => b.write(encodeFrame(payload)), warnings };
}

const MESSAGE = Buffer.from(
  "MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV|RFAC|20260501101010||ADT^A01|SYNTH0001|P|2.5\r",
  "latin1",
);
const ACK_TEXT =
  "MSH|^~\\&|RECV|RFAC|SYNTH_APP|SYNTH_FAC|20260501101011||ACK^A01|SYNTHACK1|P|2.5\r" +
  "MSA|AA|SYNTH0001\r";

/** CRLF segment ends and a non-default delimiter set: `#` fields, `$` components. */
const ODD_MESSAGE = Buffer.from(
  "MSH#$%*@#SYNTH_APP#SYNTH_FAC#RECV#RFAC#20260501101010##ADT$A01#SYNTH0002#P#2.5\r\n",
  "latin1",
);
const ODD_ACK_TEXT =
  "MSH#$%*@#RECV#RFAC#SYNTH_APP#SYNTH_FAC#20260501101011##ACK$A01#SYNTHACK2#P#2.5\r\n" +
  "MSA#AA#SYNTH0002\r\n";

describe("the header scans skip a leading UTF-8 byte order mark", () => {
  it("reads MSH-10, MSA-1 and MSA-2 behind the mark", () => {
    const ackBuf = withBom(ACK_TEXT);
    expect(readMshSegment(ackBuf)?.fields[0]).toBe("MSH");
    expect(extractMshControlId(ackBuf)).toBe("SYNTHACK1");
    expect(readMsaSegment(ackBuf)?.fields[1]).toBe("AA");
    expect(extractMsaControlId(ackBuf)).toBe("SYNTH0001");
    expect(classifyMsa1(ackBuf)).toEqual({ kind: "code", code: "AA", byteLength: 2 });
  });

  it("reads CRLF segment ends and a non-default delimiter set behind the mark", () => {
    const ackBuf = withBom(ODD_ACK_TEXT);
    expect(readMshSegment(ackBuf)?.fieldSep).toBe("#");
    expect(extractMshControlId(ackBuf)).toBe("SYNTHACK2");
    expect(extractMsaControlId(ackBuf)).toBe("SYNTH0002");
    expect(classifyMsa1(ackBuf)).toEqual({ kind: "code", code: "AA", byteLength: 2 });
  });

  it("skips only a mark at byte 0, and only a whole one", () => {
    // A mark after a leading CR, a doubled mark, or a partial mark still hides the MSH.
    expect(readMshSegment(Buffer.concat([Buffer.from([0x0d]), withBom(ACK_TEXT)]))).toBeNull();
    expect(readMshSegment(Buffer.concat([BOM, withBom(ACK_TEXT)]))).toBeNull();
    expect(
      readMshSegment(Buffer.concat([Buffer.from([0xef, 0xbb]), Buffer.from(ACK_TEXT)])),
    ).toBeNull();
    expect(readMshSegment(BOM)).toBeNull();
    expect(readMshSegment(withBom("MSH"))).toBeNull();
    // Each of the three bytes must match: one changed byte is not a mark.
    for (let i = 0; i < 3; i++) {
      const notAMark = Buffer.from(BOM);
      notAMark[i] = 0x41;
      const read = readMshSegment(Buffer.concat([notAMark, Buffer.from(ACK_TEXT)]));
      expect(read, `byte ${String(i)}`).toBeNull();
    }
  });

  it("the MSA scan starts behind the mark too, as the MSH scan does", () => {
    // Out of order, but it shows both scans begin at the same byte.
    const msaFirst = withBom(
      "MSA|AA|SYNTH0001\rMSH|^~\\&|RECV|RFAC|SYNTH_APP|SYNTH_FAC|20260501101011||ACK|X1|P|2.5\r",
    );
    expect(extractMsaControlId(msaFirst)).toBe("SYNTH0001");
  });

  it("still sees a batch envelope behind the mark", () => {
    // FHS heads the payload behind the mark and one MSH follows: still a batch, never one message.
    const batch = withBom(
      "FHS|^~\\&|A|B\rMSH|^~\\&|A|B|C|D|20260424120000||ADT^A01|MSG001|P|2.5\rFTS|1\r",
    );
    expect(containsBatchOrExtraMessage(batch)).toBe(true);
    expect(containsBatchOrExtraMessage(withBom(ACK_TEXT))).toBe(false);
  });
});

describe("FIFO: an acknowledgement behind a byte order mark settles the send with no warning", () => {
  for (const [label, ackBuf] of [
    ["CR segment ends", withBom(ACK_TEXT)],
    ["CRLF segment ends and a non-default delimiter set", withBom(ODD_ACK_TEXT)],
  ] as const) {
    it(`${label}: resolves with the exact bytes and raises no warning`, async () => {
      const { client, fromPeer, warnings } = harness();
      const sent = client.send(MESSAGE);
      fromPeer(ackBuf);
      expect(Buffer.compare(await sent, ackBuf)).toBe(0);
      expect(warnings).toEqual([]);
      await client.close();
    });
  }

  it('with fifoUnreadableAck: "reject" the send still resolves', async () => {
    const { client, fromPeer, warnings } = harness({ fifoUnreadableAck: "reject" });
    const sent = client.send(MESSAGE);
    const ackBuf = withBom(ACK_TEXT);
    fromPeer(ackBuf);
    expect(Buffer.compare(await sent, ackBuf)).toBe(0);
    expect(warnings).toEqual([]);
    await client.close();
  });
});

describe("correlated: an acknowledgement behind a byte order mark matches its send by MSA-2", () => {
  for (const [label, message, ackBuf] of [
    ["CR segment ends", MESSAGE, withBom(ACK_TEXT)],
    ["CRLF segment ends and a non-default delimiter set", ODD_MESSAGE, withBom(ODD_ACK_TEXT)],
  ] as const) {
    it(`${label}: resolves with the exact bytes and raises no warning`, async () => {
      const { client, fromPeer, warnings } = harness({ correlateByControlId: true });
      const sent = client.send(message);
      fromPeer(ackBuf);
      expect(Buffer.compare(await sent, ackBuf)).toBe(0);
      expect(warnings).toEqual([]);
      await client.close();
    });
  }

  it("an outbound message behind a byte order mark is keyed by its MSH-10", async () => {
    const { client, fromPeer, warnings } = harness({ correlateByControlId: true });
    const sent = client.send(Buffer.concat([BOM, MESSAGE]));
    const ackBuf = Buffer.from(ACK_TEXT, "latin1");
    fromPeer(ackBuf);
    expect(Buffer.compare(await sent, ackBuf)).toBe(0);
    expect(warnings).toEqual([]);
    await client.close();
  });
});
