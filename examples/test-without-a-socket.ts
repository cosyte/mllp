/**
 * Drive a whole `Connection` over the in-memory transport: no port, no certificate, no timers.
 *
 * `InMemoryTransport.pair()` returns two connected ends. A write to one end is delivered to the
 * other synchronously, so a test runs in-process and deterministically. Here the far end is a test
 * double that answers every message with a positive acknowledgement built from it, and it reads
 * one byte at a time, the worst a real socket can do.
 *
 * Run it after `pnpm build`:
 *
 *     pnpm tsx examples/test-without-a-socket.ts
 */

import assert from "node:assert/strict";

import { buildRawAck, Connection, encodeFrame, FrameReader } from "@cosyte/mllp";
import { InMemoryTransport } from "@cosyte/mllp/testing";

// A synthetic ADT^A01 header with placeholder applications and facilities, and no patient segment.
const message = Buffer.from(
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECEIVING_APP|RECEIVING_FAC|20260101120000||ADT^A01|CTRL0001|P|2.5.1\r",
);

const [ourSide, peerSide] = InMemoryTransport.pair();

// The test double: reassemble frames, answer each one with AA.
peerSide.split(1);
const peerReader = new FrameReader({
  onFrame: (payload) => {
    peerSide.write(encodeFrame(buildRawAck(payload, "AA")));
  },
});
peerSide.onData((chunk) => {
  peerReader.push(chunk);
});

const acks: Buffer[] = [];
const connection = new Connection({
  transport: ourSide,
  onMessage: (payload) => acks.push(Buffer.from(payload)),
});
connection.notifyConnect(null, null);
console.log(`state: ${connection.state}`);
assert.equal(connection.state, "CONNECTED");

connection.send(encodeFrame(message));

// Already answered, with nothing awaited.
const msa = acks[0]
  ?.toString("latin1")
  .split("\r")
  .find((segment) => segment.startsWith("MSA|"))
  ?.split("|");
console.log(`acknowledgements received: ${String(acks.length)}`);
console.log(`MSA-1 ${String(msa?.[1])}, MSA-2 ${String(msa?.[2])}`);
assert.equal(acks.length, 1);
assert.equal(msa?.[1], "AA");
assert.equal(msa?.[2], "CTRL0001", "MSA-2 echoes the control id sent");

const stats = connection.getStats();
console.log(`bytes out ${String(stats.bytesOut)}, bytes in ${String(stats.bytesIn)}`);
assert.equal(stats.bytesOut, message.length + 3);

connection.destroy();
console.log(`state: ${connection.state}`);
assert.equal(connection.state, "CLOSED");
