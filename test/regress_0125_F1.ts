/**
 * Refuter regression artifact for S0125-mllp-13, finding F1.
 *
 * Standalone rather than a `*.test.ts` file: the refuter guard admits only a
 * `regress_<name>.<ext>` filename, and Vitest's include glob here is `test/**` + `*.test.ts`.
 * Run it with `pnpm exec tsx test/regress_0125_F1.ts`; a non-zero exit is a failure.
 *
 * Under test, acceptance criterion A2: "IF a pending send was never flushed to the transport
 * THEN THE SYSTEM SHALL reject it with a typed error stating that delivery did not occur."
 * Case C additionally exercises A8, which requires the same two-population rule on an aborted
 * close ("delivery-did-not-occur for one never flushed").
 *
 * A send parked inside the client (waiting for the single in-flight slot under
 * `pipeline: false`, or for queue room under `onBackpressure: 'wait'`) re-enters `send()` when
 * the `'drain'` event fires. When that drain event is produced by the settlement which ENDS
 * the shutdown drain, the re-entry happens while the Connection is still `DRAINING`, so
 * `send()`'s not-connected guard rejects it with the generic
 * `MllpConnectionError({ phase: 'send' })` instead of `MllpNeverDeliveredError`. Those bytes
 * were never written, so the caller is told nothing it can safely replay on.
 *
 * Fixtures are synthetic HL7 v2 headers with invented sending and receiving applications. No
 * patient data appears anywhere in this file.
 */

import { createClient, type MllpClient } from "../src/client/client.js";
import { Connection } from "../src/connection/index.js";
import { InMemoryTransport } from "../src/testing/in-memory-transport.js";
import { encodeFrame } from "../src/framing/index.js";
import { MllpNeverDeliveredError } from "../src/client/error.js";

/** Keeps the loop alive: every timer inside the product is unref'd. */
const keepAlive = setInterval(() => undefined, 1_000);

interface Harness {
  readonly client: MllpClient;
  readonly peer: InMemoryTransport;
}

function harness(opts: {
  pipeline?: boolean;
  highWaterMark?: { count?: number; bytes?: number };
  onBackpressure?: "reject" | "wait";
  ackTimeoutMs?: number;
}): Harness {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: opts.ackTimeoutMs ?? 30_000,
    correlateByControlId: true,
    ...(opts.pipeline !== undefined ? { pipeline: opts.pipeline } : {}),
    ...(opts.highWaterMark !== undefined ? { highWaterMark: opts.highWaterMark } : {}),
    ...(opts.onBackpressure !== undefined ? { onBackpressure: opts.onBackpressure } : {}),
  });
  client.on("error", () => undefined);
  client.on("warning", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, peer };
}

/** A minimal original-mode message whose MSH-10 is `controlId`. */
function message(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260801000000||ADT^A01|${controlId}|P|2.5.1\r`,
    "latin1",
  );
}

/** An acknowledgement whose MSA-1 is `msa1` and whose MSA-2 echoes `acked`. */
function ack(msa1: string, acked: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RECV|RFAC|SEND|SFAC|20260801000000||ACK^A01|ACK_${acked}|P|2.5.1\r` +
      `MSA|${msa1}|${acked}\r`,
    "latin1",
  );
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    (v) => v,
    (e: unknown) => e,
  );
}

function nameOf(v: unknown): string {
  return v instanceof Error ? v.name : `resolved(${typeof v})`;
}

const failures: string[] = [];

/** Assert the parked send drew the never-delivered report, and record it if it did not. */
function expectNeverDelivered(label: string, parked: unknown): void {
  process.stdout.write(`${label}: parked send settled as ${nameOf(parked)}\n`);
  if (parked instanceof MllpNeverDeliveredError) return;
  failures.push(`${label}: expected MllpNeverDeliveredError, got ${nameOf(parked)}`);
}

/** A: the in-flight send is ACKNOWLEDGED during the drain, which releases the park. */
async function caseA(): Promise<void> {
  const h = harness({ pipeline: false });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  const closing = h.client.close({ drainTimeoutMs: 5_000 });
  setImmediate(() => {
    h.peer.write(encodeFrame(ack("AA", "M1")));
  });
  await closing;
  await onWire;
  expectNeverDelivered("A (pipeline:false, ACK ends the drain)", await parked);
}

/** B: the same shape on the high-water-mark park rather than the in-flight-slot park. */
async function caseB(): Promise<void> {
  const h = harness({ highWaterMark: { count: 1 }, onBackpressure: "wait" });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  const closing = h.client.close({ drainTimeoutMs: 5_000 });
  setImmediate(() => {
    h.peer.write(encodeFrame(ack("AA", "M1")));
  });
  await closing;
  await onWire;
  expectNeverDelivered("B (onBackpressure:'wait', ACK ends the drain)", await parked);
}

/** C: an aborted close racing the ACK. A8 asks for the same two-population rule here. */
async function caseC(): Promise<void> {
  const h = harness({ pipeline: false });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  const controller = new AbortController();
  const closing = caught(h.client.close({ drainTimeoutMs: 5_000, signal: controller.signal }));
  setImmediate(() => {
    h.peer.write(encodeFrame(ack("AA", "M1")));
    controller.abort();
  });
  await closing;
  await onWire;
  expectNeverDelivered("C (aborted close racing the ACK)", await parked);
}

/** D: the in-flight send TIMES OUT during the drain, which also releases the park. */
async function caseD(): Promise<void> {
  const h = harness({ pipeline: false, ackTimeoutMs: 40 });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  await h.client.close({ drainTimeoutMs: 5_000 });
  await onWire;
  expectNeverDelivered("D (pipeline:false, ACK timeout ends the drain)", await parked);
}

async function main(): Promise<void> {
  await caseA();
  await caseB();
  await caseC();
  await caseD();
  clearInterval(keepAlive);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`FAIL: ${f}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("PASS: every parked send drew the never-delivered report\n");
}

await main();
