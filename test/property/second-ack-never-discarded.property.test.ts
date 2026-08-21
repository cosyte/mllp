/**
 * The generative statement of the property this whole change exists to deliver: on an
 * enhanced-mode send correlated by control ID, **no acknowledgement is silently discarded**.
 *
 * Before it, the client settled a send on the first acknowledgement carrying its control ID
 * and deleted the pending entry, so a second one for the same message fell through to the
 * unmatched path and was dropped. A sender could therefore conclude success from a commit
 * while the receiving application had rejected the message.
 *
 * The property below feeds an arbitrary sequence of acknowledgements at one send and
 * requires that **every one of them produces exactly one observable outcome**: it settles
 * the send, fails it, reports a commit disposition, or is surfaced with a stable code.
 * Nothing lands nowhere. That is stronger than "the second one is not dropped", and it is
 * what makes the fail-safe checkable: an acknowledgement that cannot be classified is
 * surfaced rather than guessed.
 *
 * Fixtures are synthetic MSH/MSA headers only. No patient data appears anywhere here.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { createClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 200;

/**
 * MSA-1 values a peer might send, spanning every outcome of the read: both halves of Table
 * 0008, padded and coded spellings, an empty field, the explicit null, and values outside
 * the table altogether.
 */
const MSA1_VALUES = [
  "AA",
  "AE",
  "AR",
  "CA",
  "CE",
  "CR",
  "CA ",
  " AA",
  "CA^HL70008",
  "AA~AA",
  "",
  '""',
  "ca",
  "CAX",
  "OK",
  "C",
] as const;

const CONTROL_ID = "PROPMSG1";

function message(msh15: string, msh16: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|${CONTROL_ID}|P|2.5.1|||${msh15}|${msh16}\r`,
    "latin1",
  );
}

function ack(msa1: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|R|F2|S|F|20260101000000||ACK^A01|ACKID|P|2.5.1\r` + `MSA|${msa1}|${CONTROL_ID}\r`,
    "latin1",
  );
}

interface Run {
  /** One entry per acknowledgement fed, holding how many outcomes it produced. */
  readonly outcomesPerAck: readonly number[];
  /** Whether the send ever settled successfully. */
  readonly resolved: boolean;
  /** Whether the send ever failed. */
  readonly rejected: boolean;
}

/** Feed `values` at one enhanced-mode send and record what each acknowledgement produced. */
async function drive(msh15: string, msh16: string, values: readonly string[]): Promise<Run> {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: 60_000,
    correlateByControlId: true,
  });

  let outcomes = 0;
  let resolved = false;
  let rejected = false;
  client.on("warning", () => {
    outcomes += 1;
  });
  client.on("error", () => {
    outcomes += 1;
  });
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);

  const sent = client.send(message(msh15, msh16), {
    onCommitAck: () => {
      outcomes += 1;
    },
  });
  sent.then(
    () => {
      outcomes += 1;
      resolved = true;
    },
    () => {
      outcomes += 1;
      rejected = true;
    },
  );

  const outcomesPerAck: number[] = [];
  try {
    for (const value of values) {
      const before = outcomes;
      peer.write(encodeFrame(ack(value)));
      // Settlement travels through a promise, so drain the microtask queue before reading.
      for (let i = 0; i < 4; i++) await Promise.resolve();
      outcomesPerAck.push(outcomes - before);
    }
    return { outcomesPerAck, resolved, rejected };
  } finally {
    client.destroy(new Error("property run complete"));
    for (let i = 0; i < 4; i++) await Promise.resolve();
  }
}

describe("property: no acknowledgement for a two-phase send is silently discarded", () => {
  it("every acknowledgement in an arbitrary sequence produces exactly one outcome", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...MSA1_VALUES), { minLength: 1, maxLength: 6 }),
        async (values) => {
          const run = await drive("AL", "AL", values);
          expect(run.outcomesPerAck).toHaveLength(values.length);
          for (const count of run.outcomesPerAck) {
            expect(count).toBe(1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60_000);

  it("holds for a send that awaits no application acknowledgement", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom(...MSA1_VALUES), { minLength: 1, maxLength: 4 }),
        async (values) => {
          const run = await drive("AL", "NE", values);
          for (const count of run.outcomesPerAck) {
            expect(count).toBe(1);
          }
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60_000);

  it("a commit accept alone never settles a send that asked for an application acknowledgement", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("CA", "CA ", " CA", "CA^HL70008"), {
          minLength: 1,
          maxLength: 5,
        }),
        async (commits) => {
          const run = await drive("AL", "AL", commits);
          expect(run.resolved).toBe(false);
          expect(run.rejected).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60_000);

  it("an acknowledgement that cannot be classified never settles a send", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.constantFrom("", '""', "ca", "CAX", "OK", "C", "ZZZ"), {
          minLength: 1,
          maxLength: 5,
        }),
        async (unclassifiable) => {
          const run = await drive("AL", "AL", unclassifiable);
          expect(run.resolved).toBe(false);
          expect(run.rejected).toBe(false);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  }, 60_000);
});
