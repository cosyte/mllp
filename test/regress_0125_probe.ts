/**
 * Refuter probe for S0125-mllp-13, impl gate ordinal 2.
 *
 * Standalone rather than a `*.test.ts` file: the refuter write guard admits a
 * `regress_<name>.<ext>` filename, and this must not join the package's own suite.
 * Run it with `pnpm exec tsx test/regress_0125_probe.ts`; a non-zero exit is a failure.
 *
 * Five checks, none of which the committed suite makes:
 *
 *   P0. Discriminating power of the loop-1 fix. `_shutdownBegun()` is forced to `false` at
 *       runtime, which is the fix commit's own claim about what is load-bearing. If the four
 *       parked-send cases still pass with it forced off, the committed coverage proves
 *       nothing and F1 is not actually discharged by the code.
 *   P1. A1/A5 with a PARTIAL answer: two sends on the wire, one acknowledged during the
 *       drain. The drain must NOT end on the first settlement; it must run to its bound, the
 *       acknowledged send resolves and the unanswered one draws the unknown-fate report.
 *   P2. A11 on the wait-mode park (the committed A11 case only exercises the in-flight-slot
 *       park): a link failure mid-drain settles both populations and returns.
 *   P3. No send's promise is left pending by a shutdown, including a `send()` issued while
 *       the drain is in progress.
 *   P4. A3's flush timestamp is a real reading of when the bytes went out, not of when the
 *       report was written: with a drain bound of 300 ms, `elapsedMs` must be at least that.
 *
 * Fixtures are synthetic HL7 v2 headers with invented sending and receiving applications. No
 * patient data appears anywhere in this file.
 */

import { createClient, type MllpClient } from "../src/client/client.js";
import { Connection, MllpConnectionError } from "../src/connection/index.js";
import { InMemoryTransport } from "../src/testing/in-memory-transport.js";
import { encodeFrame } from "../src/framing/index.js";
import { MllpNeverDeliveredError, MllpUnknownFateError } from "../src/client/error.js";

/** Keeps the loop alive: every timer inside the product is unref'd. */
const keepAlive = setInterval(() => undefined, 1_000);

const failures: string[] = [];

function check(label: string, ok: boolean, detail: string): void {
  process.stdout.write(`${ok ? "ok  " : "FAIL"} ${label}: ${detail}\n`);
  if (!ok) failures.push(`${label}: ${detail}`);
}

interface Harness {
  readonly client: MllpClient;
  readonly conn: Connection;
  readonly local: InMemoryTransport;
  readonly peer: InMemoryTransport;
}

function harness(opts?: {
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
    ackTimeoutMs: opts?.ackTimeoutMs ?? 30_000,
    correlateByControlId: true,
    ...(opts?.pipeline !== undefined ? { pipeline: opts.pipeline } : {}),
    ...(opts?.highWaterMark !== undefined ? { highWaterMark: opts.highWaterMark } : {}),
    ...(opts?.onBackpressure !== undefined ? { onBackpressure: opts.onBackpressure } : {}),
  });
  client.on("error", () => undefined);
  client.on("warning", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, conn, local, peer };
}

function message(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260801000000||ADT^A01|${controlId}|P|2.5.1\r`,
    "latin1",
  );
}

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

/** Settle-or-not observation that never leaves an unhandled rejection behind. */
function watch(p: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  void p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: (): boolean => done };
}

/**
 * P0: force `_shutdownBegun()` off on one client and re-run the four shapes the loop-1
 * artifact covers. Each must now come back as the generic connection error, which is what
 * makes the committed coverage a real guard rather than a tautology.
 */
async function probeDiscriminatingPower(): Promise<void> {
  const cases: readonly {
    readonly label: string;
    readonly opts: Parameters<typeof harness>[0];
    readonly endDrain: (h: Harness) => void;
  }[] = [
    {
      label: "in-flight-slot park, ACK ends the drain",
      opts: { pipeline: false },
      endDrain: (h) => {
        setImmediate(() => {
          h.peer.write(encodeFrame(ack("AA", "M1")));
        });
      },
    },
    {
      label: "high-water-mark park, ACK ends the drain",
      opts: { highWaterMark: { count: 1 }, onBackpressure: "wait" },
      endDrain: (h) => {
        setImmediate(() => {
          h.peer.write(encodeFrame(ack("AA", "M1")));
        });
      },
    },
    {
      label: "in-flight-slot park, ACK timeout ends the drain",
      opts: { pipeline: false, ackTimeoutMs: 40 },
      endDrain: () => undefined,
    },
  ];

  for (const c of cases) {
    const h = harness(c.opts);
    // Runtime-only override of a TS-private method. Nothing in src/ is edited: this asks
    // "does the committed code still report correctly with the loop-1 guard switched off?"
    (h.client as unknown as { _shutdownBegun: () => boolean })._shutdownBegun = (): boolean =>
      false;
    const onWire = caught(h.client.send(message("M1")));
    const parked = caught(h.client.send(message("M2")));
    const closing = h.client.close({ drainTimeoutMs: 5_000 });
    c.endDrain(h);
    await closing;
    await onWire;
    const got = await parked;
    check(
      `P0 (${c.label})`,
      got instanceof MllpConnectionError,
      `guard forced off -> ${nameOf(got)} (a generic connection error here is what proves the ` +
        `committed guard is load-bearing)`,
    );
    h.client.destroy(new Error("probe complete"));
  }
}

/** P1: one of two flushed sends is answered during the drain. */
async function probePartialAnswer(): Promise<void> {
  const h = harness();
  const first = caught(h.client.send(message("M1")));
  const second = caught(h.client.send(message("M2")));
  const secondWatch = watch(second);
  const started = Date.now();
  const closing = h.client.close({ drainTimeoutMs: 300 });
  setImmediate(() => {
    h.peer.write(encodeFrame(ack("AA", "M1")));
  });
  await closing;
  const took = Date.now() - started;
  const a = await first;
  const b = await second;
  check("P1a (answered send resolves)", Buffer.isBuffer(a), `first send -> ${nameOf(a)}`);
  check(
    "P1b (unanswered send has an unknown fate)",
    b instanceof MllpUnknownFateError,
    `second send -> ${nameOf(b)}`,
  );
  check(
    "P1c (the drain is not ended by one settlement out of two)",
    took >= 250,
    `close() took ${took} ms of a 300 ms bound (settled early = ${String(secondWatch.settled())})`,
  );
  h.client.destroy(new Error("probe complete"));
}

/** P2: A11 with the park being a wait-mode one rather than an in-flight-slot one. */
async function probeLinkFailureWithWaitPark(): Promise<void> {
  const h = harness({ highWaterMark: { count: 1 }, onBackpressure: "wait" });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  const started = Date.now();
  const closing = h.client.close({ drainTimeoutMs: 5_000 });
  setImmediate(() => {
    h.local.destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
  });
  await closing;
  const took = Date.now() - started;
  const wire = await onWire;
  const held = await parked;
  check("P2a (close returns rather than hanging)", took < 500, `close() took ${took} ms`);
  check(
    "P2b (flushed send: unknown fate)",
    wire instanceof MllpUnknownFateError,
    `on-the-wire send -> ${nameOf(wire)}`,
  );
  check(
    "P2c (wait-mode park: never delivered)",
    held instanceof MllpNeverDeliveredError,
    `parked send -> ${nameOf(held)}`,
  );
  h.client.destroy(new Error("probe complete"));
}

/** P3: nothing is left pending, including a send issued into an in-progress drain. */
async function probeNothingLeftPending(): Promise<void> {
  const h = harness({ pipeline: false });
  const onWire = caught(h.client.send(message("M1")));
  const parked = caught(h.client.send(message("M2")));
  const closing = h.client.close({ drainTimeoutMs: 200 });
  let duringDrain: Promise<unknown> | null = null;
  setImmediate(() => {
    duringDrain = caught(h.client.send(message("M3")));
  });
  await closing;
  await onWire;
  await parked;
  const settledInTime = await Promise.race([
    (duringDrain ?? Promise.resolve("no send was issued")).then(() => true),
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        resolve(false);
      }, 500);
      t.unref();
    }),
  ]);
  check(
    "P3 (a send issued during the drain settles)",
    settledInTime,
    `mid-drain send -> ${nameOf(await (duringDrain ?? Promise.resolve(null)))}`,
  );
  h.client.destroy(new Error("probe complete"));
}

/** P4: the flush timestamp is when the bytes went out, not when the report was written. */
async function probeFlushTimestamp(): Promise<void> {
  const h = harness();
  const before = Date.now();
  const sent = caught(h.client.send(message("M1")));
  await h.client.close({ drainTimeoutMs: 300 });
  const err = await sent;
  if (!(err instanceof MllpUnknownFateError)) {
    check("P4 (flush timestamp)", false, `expected MllpUnknownFateError, got ${nameOf(err)}`);
    return;
  }
  check(
    "P4a (flushedAt is the write, not the report)",
    err.flushedAt >= before && err.flushedAt <= before + 100,
    `flushedAt=${err.flushedAt} (send began at ${before})`,
  );
  check(
    "P4b (elapsedMs spans the drain)",
    err.elapsedMs >= 250,
    `elapsedMs=${err.elapsedMs} over a 300 ms drain`,
  );
  check(
    "P4c (byte counts only, no payload)",
    err.byteCount === encodeFrame(message("M1")).length && err.messageControlIdBytes === 2,
    `byteCount=${err.byteCount} messageControlIdBytes=${String(err.messageControlIdBytes)}`,
  );
  h.client.destroy(new Error("probe complete"));
}

async function main(): Promise<void> {
  await probeDiscriminatingPower();
  await probePartialAnswer();
  await probeLinkFailureWithWaitPark();
  await probeNothingLeftPending();
  await probeFlushTimestamp();
  clearInterval(keepAlive);
  if (failures.length > 0) {
    for (const f of failures) process.stdout.write(`FAILED: ${f}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("PASS: every probe held\n");
}

await main();
