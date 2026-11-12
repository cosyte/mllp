/**
 * Release 1 only: MLLP Release 2 commit blocks and HL7 batch acknowledgment are decided non-goals.
 *
 * `docs-content/limitations.md` records the decision for each: not built, why, what would change it,
 * and that a Release 1 link never silently downgrades. This file holds the page to that shape and
 * holds the code to what the page says a Release 1 endpoint does when a peer sends it a frame shaped
 * like a Release 2 commit block (one `ACK` 0x06 or `NAK` 0x15 byte inside an ordinary frame):
 *
 *   - the server treats it as an ordinary Release 1 frame with no readable `MSH`, and a requested
 *     positive `AA` becomes the non-positive `AE`;
 *   - a client correlating by control ID finds no MSA-2 in it, reports it as unmatched and settles
 *     nothing, so the send waits for its real acknowledgment;
 *   - a FIFO client (the default) settles the next send on it, as it settles on any next frame,
 *     hands the caller the one byte, and warns `MLLP_ACK_FIFO_MSA1_UNREADABLE` because there is no
 *     MSA-1 to read; with `fifoUnreadableAck: "reject"` the send rejects with
 *     `MllpUnreadableAckError` instead.
 *
 * Every payload here is synthetic.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import type { MllpFramingError } from "../../src/framing/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import { buildRawAck, rawAckUncorrelatable } from "../../src/server/ack.js";
import { MllpUnreadableAckError } from "../../src/client/error.js";

const ROOT = join(import.meta.dirname, "..", "..");
const LIMITATIONS = readFileSync(join(ROOT, "docs-content", "limitations.md"), "utf8");

/** The body of one `## ` section of the limitations page, up to the next `## ` heading. */
function section(heading: string): string {
  const start = LIMITATIONS.indexOf(`\n## ${heading}\n`);
  expect(start, `limitations.md has no "## ${heading}" section`).toBeGreaterThan(-1);
  const rest = LIMITATIONS.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** The four parts every decision record on the page carries, in this order. */
const DECISION_PARTS = [
  "**Decision.**",
  "**Why.**",
  "**What would change it.**",
  "**Release 1 never silently downgrades.**",
] as const;

const COMMIT_ACK_BLOCK = Buffer.from([0x06]);
const COMMIT_NAK_BLOCK = Buffer.from([0x15]);

const MESSAGE = Buffer.from(
  "MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV|RFAC|20260501101010||ADT^A01|SYNTH0001|P|2.5\r",
  "ascii",
);
const REAL_ACK = Buffer.from(
  "MSH|^~\\&|RECV|RFAC|SYNTH_APP|SYNTH_FAC|20260501101011||ACK^A01|SYNTHACK1|P|2.5\rMSA|AA|SYNTH0001\r",
  "ascii",
);

function clientOverPair(
  correlateByControlId: boolean,
  fifoUnreadableAck?: "warn" | "reject",
): {
  client: MllpClient;
  fromPeer: (payload: Buffer) => void;
} {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: 1_000,
    correlateByControlId,
    ...(fifoUnreadableAck === undefined ? {} : { fifoUnreadableAck }),
  });
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, fromPeer: (payload) => b.write(encodeFrame(payload)) };
}

describe("the decision record on the limitations page", () => {
  for (const heading of [
    "It does not speak MLLP Release 2",
    "It does not acknowledge an HL7 batch",
  ]) {
    it(`"${heading}" states the decision, why, what would change it, and the no-downgrade rule`, () => {
      const body = section(heading);
      let from = 0;
      for (const part of DECISION_PARTS) {
        const at = body.indexOf(part, from);
        expect(at, `"${heading}" is missing ${part}, or has it out of order`).toBeGreaterThan(-1);
        from = at + part.length;
      }
      expect(body).toContain("not built");
    });
  }
});

describe("a Release 2 commit block reaching a Release 1 server", () => {
  it("is an ordinary frame with no readable MSH, so a requested AA is answered AE", () => {
    for (const block of [COMMIT_ACK_BLOCK, COMMIT_NAK_BLOCK]) {
      expect(rawAckUncorrelatable(block)).toBe(true);
      const ack = buildRawAck(block, "AA").toString("latin1");
      expect(ack).toContain("MSA|AE|");
      expect(ack).not.toContain("MSA|AA");
      // The answer is an HL7 acknowledgment, never a Release 2 block echoed back.
      expect(ack.startsWith("MSH")).toBe(true);
    }
  });
});

describe("a Release 2 commit block reaching a Release 1 client", () => {
  it("correlating by control ID: reported as unmatched, settles nothing", async () => {
    const { client, fromPeer } = clientOverPair(true);
    const errors: Array<{ error: MllpFramingError; controlIdBytes: number | null }> = [];
    client.on("error", (e: { error: MllpFramingError; controlIdBytes: number | null }) => {
      errors.push(e);
    });
    let settled = false;
    const sent = client.send(MESSAGE).then((ack) => {
      settled = true;
      return ack;
    });

    fromPeer(COMMIT_ACK_BLOCK);
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error.code).toBe("MLLP_ACK_UNMATCHED_CONTROL_ID");
    expect(errors[0]?.controlIdBytes).toBeNull();

    fromPeer(REAL_ACK);
    expect((await sent).toString("latin1")).toContain("MSA|AA|SYNTH0001");
    await client.close();
  });

  it("FIFO, the default: settles the next send on the block and warns that it has no MSA-1", async () => {
    const { client, fromPeer } = clientOverPair(false);
    const warnings: Array<{ code: string; msa1Bytes: number | null }> = [];
    client.on("warning", (w: { code: string; msa1Bytes: number | null }) => warnings.push(w));
    const sent = client.send(MESSAGE);
    fromPeer(COMMIT_NAK_BLOCK);
    const answer = await sent;
    expect([...answer]).toEqual([0x15]);
    expect(answer.includes("MSA|")).toBe(false);
    expect(warnings).toEqual([
      expect.objectContaining({ code: "MLLP_ACK_FIFO_MSA1_UNREADABLE", msa1Bytes: 0 }),
    ]);
    await client.close();
  });

  it('FIFO with fifoUnreadableAck: "reject": the send rejects on the block', async () => {
    const { client, fromPeer } = clientOverPair(false, "reject");
    client.on("warning", () => undefined);
    for (const block of [COMMIT_ACK_BLOCK, COMMIT_NAK_BLOCK]) {
      const sent = client.send(MESSAGE);
      fromPeer(block);
      await expect(sent).rejects.toBeInstanceOf(MllpUnreadableAckError);
    }
    await client.close();
  });
});

describe("the limitations page says what a FIFO client does with the block", () => {
  it("names the warning, the opt-in rejection, and recommends correlating by control ID", () => {
    const body = section("It does not speak MLLP Release 2");
    expect(body).toContain("`MLLP_ACK_FIFO_MSA1_UNREADABLE`");
    expect(body).toContain('`fifoUnreadableAck: "reject"`');
    expect(body).toContain("`MllpUnreadableAckError`");
    expect(body).toContain("correlate by control ID");
  });
});
