/**
 * Send HL7 v2 messages over a real loopback socket and read the acknowledgement for each.
 *
 * The server's auto-ACK awaits `onMessage`, your durable commit step, before it answers. A handler
 * that resolves earns `AA`. A handler that throws earns `AE`, so the sender is never told to forget
 * a message you did not keep.
 *
 * Run it after `pnpm build`:
 *
 *     pnpm tsx examples/send-and-acknowledge.ts
 */

import assert from "node:assert/strict";

import { createStarterClient, createStarterServer } from "@cosyte/mllp";

/** A synthetic ADT^A01 header with placeholder applications and facilities, and no patient segment. */
function adtHeader(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVING_APP|RECEIVING_FAC|20260101120000||ADT^A01|${controlId}|P|2.5.1\r`,
  );
}

/** MSA-1 (the acknowledgement code) and MSA-2 (the control id it answers), nothing else. */
function readMsa(ack: Buffer): { code: string | undefined; controlId: string | undefined } {
  const msa = ack
    .toString("latin1")
    .split("\r")
    .find((segment) => segment.startsWith("MSA|"))
    ?.split("|");
  return { code: msa?.[1], controlId: msa?.[2] };
}

const committed: Buffer[] = [];

// Port 0: the operating system picks a free port. The host defaults to loopback, 127.0.0.1.
const server = await createStarterServer({
  port: 0,
  onMessage: async (payload) => {
    // Stand-in for your durable commit. One control id simulates a write that failed.
    if (payload.includes("CTRL0002")) throw new Error("the commit failed");
    committed.push(payload);
    return Promise.resolve();
  },
});

const client = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });

try {
  const kept = readMsa(await client.send(adtHeader("CTRL0001")));
  console.log(`CTRL0001 answered ${String(kept.code)}, MSA-2 ${String(kept.controlId)}`);
  assert.equal(kept.code, "AA", "a committed message is acknowledged AA");
  assert.equal(kept.controlId, "CTRL0001", "MSA-2 echoes the control id sent");

  const lost = readMsa(await client.send(adtHeader("CTRL0002")));
  console.log(`CTRL0002 answered ${String(lost.code)}, MSA-2 ${String(lost.controlId)}`);
  assert.equal(lost.code, "AE", "a message whose commit threw is never acknowledged AA");
  assert.equal(lost.controlId, "CTRL0002", "MSA-2 echoes the control id sent");

  console.log(`messages committed: ${String(committed.length)}`);
  assert.equal(committed.length, 1);
} finally {
  await client.close();
  await server.close();
}
