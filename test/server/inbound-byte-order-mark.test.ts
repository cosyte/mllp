/**
 * An inbound message whose payload starts with a UTF-8 byte order mark (`EF BB BF`).
 *
 * The server reads the message's header to build its acknowledgement. The mark used to hide the
 * `MSH`, so a positive auto-ACK was downgraded to `AE` with an empty MSA-2, and the sender, which
 * keyed on the MSH-10 it sent, timed out and resent. The mark is now skipped for reading the
 * header, the acknowledgement echoes MSH-10, and the handler still gets the bytes exactly as
 * received.
 *
 * Every payload here is synthetic.
 */

import { afterEach, describe, it, expect } from "vitest";
import type { Socket } from "node:net";
import { encodeFrame } from "../../src/framing/index.js";
import { createServer } from "../../src/server/server.js";
import { buildRawAck, rawAckUncorrelatable } from "../../src/server/ack.js";
import { makeServerTracker, must } from "../helpers/tracked-servers.js";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const withBom = (text: string): Buffer => Buffer.concat([BOM, Buffer.from(text, "latin1")]);

const MESSAGE_TEXT =
  "MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV|RFAC|20260501101010||ADT^A01|SYNTH0001|P|2.5\r" +
  "EVN|A01|20260501101010\r";

/** CRLF segment ends and a non-default delimiter set: `#` fields, `$` components. */
const ODD_MESSAGE_TEXT =
  "MSH#$%*@#SYNTH_APP#SYNTH_FAC#RECV#RFAC#20260501101010##ADT$A01#SYNTH0002#P#2.5\r\n" +
  "EVN#A01#20260501101010\r\n";

const tracker = makeServerTracker();
afterEach(() => tracker.closeAll());

/** Open a socket to `port`, write `frame`, resolve the first acknowledgement payload (unframed). */
async function sendAndAwaitAck(port: number, frame: Buffer): Promise<Buffer> {
  const net = await import("node:net");
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      let buf = Buffer.allocUnsafe(0);
      sock.on("data", (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        const fsIdx = buf.indexOf(0x1c);
        if (fsIdx !== -1 && fsIdx + 1 < buf.length && buf[fsIdx + 1] === 0x0d) {
          resolve(buf.subarray(1, fsIdx));
        }
      });
      setTimeout(() => reject(new Error("timeout")), 2000);
      sock.write(frame);
    });
  } finally {
    sock.destroy();
  }
}

describe("buildRawAck reads the header behind a byte order mark", () => {
  it("a positive AA stays AA and echoes MSH-10", () => {
    const inbound = withBom(MESSAGE_TEXT);
    expect(rawAckUncorrelatable(inbound)).toBe(false);
    const ack = buildRawAck(inbound, "AA").toString("latin1");
    expect(ack.startsWith("MSH|^~\\&|RECV|RFAC|SYNTH_APP|SYNTH_FAC|")).toBe(true);
    expect(ack).toContain("MSA|AA|SYNTH0001");
  });

  it("CRLF segment ends and a non-default delimiter set keep their delimiters", () => {
    const inbound = withBom(ODD_MESSAGE_TEXT);
    expect(rawAckUncorrelatable(inbound)).toBe(false);
    const ack = buildRawAck(inbound, "AA").toString("latin1");
    expect(ack.startsWith("MSH#$%*@#RECV#RFAC#SYNTH_APP#SYNTH_FAC#")).toBe(true);
    expect(ack).toContain("MSA#AA#SYNTH0002");
  });

  it("a batch envelope behind the mark is still downgraded", () => {
    const batch = withBom(
      "FHS|^~\\&|A|B\rMSH|^~\\&|A|B|C|D|20260424120000||ADT^A01|MSG001|P|2.5\rFTS|1\r",
    );
    expect(rawAckUncorrelatable(batch)).toBe(true);
    expect(buildRawAck(batch, "AA").toString("latin1")).toContain("MSA|AE");
  });
});

describe("the server's auto-ACK reads the header behind a byte order mark", () => {
  for (const [label, text, msa] of [
    ["CR segment ends", MESSAGE_TEXT, "MSA|AA|SYNTH0001"],
    ["CRLF segment ends and a non-default delimiter set", ODD_MESSAGE_TEXT, "MSA#AA#SYNTH0002"],
  ] as const) {
    it(`${label}: answers AA with MSA-2, no nack, and hands over the exact bytes`, async () => {
      const received: Buffer[] = [];
      const nacks: unknown[] = [];
      const server = tracker.track(
        createServer({
          autoAck: "AA",
          onMessage: (payload) => {
            received.push(Buffer.from(payload));
          },
        }),
      );
      server.on("nack", (evt) => nacks.push(evt));
      await server.listen(0);
      const port = must(server.getStats().port);

      const inbound = withBom(text);
      const ack = (await sendAndAwaitAck(port, encodeFrame(inbound))).toString("latin1");
      expect(ack).toContain(msa);
      expect(nacks).toEqual([]);
      expect(received).toHaveLength(1);
      expect(Buffer.compare(must(received[0]), inbound)).toBe(0);
    });
  }
});
