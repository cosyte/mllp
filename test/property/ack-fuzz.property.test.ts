/**
 * ACK fuzz: hostile HL7 v2 payloads through every reader and builder behind acknowledgement.
 *
 * Once a frame is decoded, the package reads its payload in four places, all on bytes a peer
 * chose: the server's auto-ACK (`rawAckUncorrelatable`, `buildRawAck`), the client's correlation
 * of an inbound acknowledgement (the `MSH` and `MSA` scans, MSA-1 classification, MSH-15/16
 * modes), and the `ack-from-hl7` adapter (`buildMllpAck`, `detectMode`, over `@cosyte/hl7`).
 * This suite mutates the message seeds in `_seed-corpus.ts` and drives each of them.
 *
 * The contract, per case:
 *
 *   - **No unsanctioned throw.** The scans and the raw ACK builder are documented never to
 *     throw. `buildMllpAck` with a known code never throws on any inbound; `detectMode` may throw
 *     only the peer's `Hl7ParseError`. A client fed any acknowledgement bytes never throws out of
 *     the socket's data path, reports as errors only framing fatals and acknowledgements it could
 *     not match (by code, with no payload byte), and settles its send once destroyed.
 *   - **The fail-safe holds.** A payload the raw builder cannot correlate never gets a positive
 *     `AA`/`CA`, and neither does an inbound `buildMllpAck` could not parse: a positive ACK the
 *     sender cannot match is a resend, and a duplicate clinical message.
 *   - **What we build, we can send.** A raw ACK for a payload the decoder could deliver (no `VT`
 *     or `FS` in it) frames without a throw, and a `buildMllpAck` frame decodes, strictly, to
 *     exactly its payload.
 *   - **No hang and no runaway allocation**, by the per-case budget in `_fuzz-config.ts`, over
 *     the mutations and over long runs of segment and field delimiters.
 *
 * @module
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  buildMllpAck,
  detectMode,
  MLLP_ACK_INBOUND_UNPARSEABLE,
} from "../../src/ack-from-hl7/index.js";
import { createClient } from "../../src/client/client.js";
import { Connection, MllpConnectionError } from "../../src/connection/index.js";
import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import {
  classifyMsa1,
  classifyOutboundAckMode,
  delimitersFrom,
  readAcceptCondition,
} from "../../src/internal/ack-mode.js";
import {
  containsBatchOrExtraMessage,
  extractMsaControlId,
  extractMshControlId,
  readMsaSegment,
  readMshSegment,
  stripLeadingSegmentTerminators,
} from "../../src/internal/control-id.js";
import { buildRawAck, rawAckUncorrelatable, type AckCode } from "../../src/server/ack.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

import { fuzzParameters, fuzzTimeout, preview, withinBudget } from "./_fuzz-config.js";
import { mutatedSeed } from "./_mutate.js";
import { MESSAGE_SEEDS, MLLP_TOKENS } from "./_seed-corpus.js";

const CODES: readonly AckCode[] = ["AA", "AE", "AR", "CA", "CE", "CR"];

const VT = 0x0b;
const FS = 0x1c;

/** Render a thrown value without assuming it is an Error. */
function describeThrown(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function unsanctioned(where: string, err: unknown, input: Buffer): Error {
  return new Error(`fuzz: ${where} threw ${describeThrown(err)} on ${preview(input)}`, {
    cause: err,
  });
}

/** Run `read`, turning any throw into an unsanctioned-throw failure naming `where`. */
function mustNotThrow<T>(where: string, input: Buffer, read: () => T): T {
  try {
    return read();
  } catch (err) {
    throw unsanctioned(where, err, input);
  }
}

/** `true` when the decoder could have delivered `payload`: it never hands out a VT or an FS. */
function deliverable(payload: Buffer): boolean {
  return !payload.includes(VT) && !payload.includes(FS);
}

/** One short unit repeated up to tens of thousands of times, between HL7-shaped ends. */
const delimiterRuns: fc.Arbitrary<Buffer> = fc
  .record({
    head: fc.constantFrom(
      "",
      "MSH|^~\\&|",
      "\r\n",
      "FHS|^~\\&|",
      "MSH|^~\\&|A|B|C|D|E||ACK|1|P|2.5\r",
    ),
    unit: fc
      .array(
        fc.constantFrom("|", "\r", "\n", "^", "~", "\\", "MSH|", "MSA|", "FHS|", "BHS|", " ", "A"),
        {
          minLength: 1,
          maxLength: 3,
        },
      )
      .map((parts) => parts.join("")),
    times: fc.integer({ min: 1, max: 40_000 }),
    tail: fc.constantFrom("", "MSA|AA|MSG00001", "\r", "|"),
  })
  .map(({ head, unit, times, tail }) => Buffer.from(head + unit.repeat(times) + tail, "latin1"));

const mutated = mutatedSeed(MESSAGE_SEEDS, MLLP_TOKENS);

/** Mutated messages and delimiter runs, as plain bytes. */
const payloads: fc.Arbitrary<Buffer> = fc.oneof(
  { weight: 4, arbitrary: mutated.map((input) => input.bytes) },
  { weight: 1, arbitrary: delimiterRuns },
);

/** Drain the microtask queue, so promise settlement is visible. */
async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe("fuzz: the payload readers and the raw ACK builder", () => {
  it(
    "the MSH and MSA scans, MSA-1 classification and MSH-15/16 reads never throw",
    () => {
      fc.assert(
        fc.property(payloads, (bytes) => {
          withinBudget(bytes, () => {
            mustNotThrow("the payload readers", bytes, () => {
              const msh = readMshSegment(bytes);
              extractMshControlId(bytes);
              extractMsaControlId(bytes);
              readMsaSegment(bytes);
              containsBatchOrExtraMessage(bytes);
              stripLeadingSegmentTerminators(bytes);
              classifyMsa1(bytes);
              classifyOutboundAckMode(msh);
              readAcceptCondition(msh);
              delimitersFrom(msh?.fields[1]);
            });
          });
        }),
        fuzzParameters(500, 0x3117_0101),
      );
    },
    fuzzTimeout(60_000),
  );

  it(
    "buildRawAck never throws, never answers positively for what it cannot correlate, and frames",
    () => {
      fc.assert(
        fc.property(payloads, fc.constantFrom(...CODES), (bytes, code) => {
          withinBudget(bytes, () => {
            const uncorrelatable = mustNotThrow("rawAckUncorrelatable", bytes, () =>
              rawAckUncorrelatable(bytes),
            );
            const ack = mustNotThrow("buildRawAck", bytes, () => buildRawAck(bytes, code));
            const msa = readMsaSegment(ack);
            expect(msa, "our own ACK is readable by our own MSA scan").not.toBeNull();
            const msa1 = msa?.fields[1];
            if (uncorrelatable) expect(msa1 === "AA" || msa1 === "CA").toBe(false);
            if (deliverable(bytes))
              mustNotThrow("encodeFrame of a raw ACK", bytes, () => encodeFrame(ack));
          });
        }),
        fuzzParameters(400, 0x3117_0102),
      );
    },
    fuzzTimeout(60_000),
  );
});

describe("fuzz: a client correlating hostile acknowledgements", () => {
  it(
    "never throws out of the data path, reports only sanctioned errors, and settles every send",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom(
            ...MESSAGE_SEEDS.slice(0, 2),
            ...MESSAGE_SEEDS.filter((s) => s.name.startsWith("enhanced")),
          ),
          fc.array(
            fc.oneof(
              mutated.map((input) => input.bytes),
              payloads,
            ),
            { minLength: 1, maxLength: 3 },
          ),
          fc.boolean(),
          fc.boolean(),
          async (sent, answers, framed, byControlId) => {
            const [local, peer] = InMemoryTransport.pair();
            const conn = new Connection({ transport: local });
            const client = createClient({
              host: "127.0.0.1",
              port: 0,
              ackTimeoutMs: 60_000,
              correlateByControlId: byControlId,
            });
            const errors: unknown[] = [];
            client.on("error", (e: unknown) => errors.push((e as { error?: unknown }).error ?? e));
            client.on("warning", () => undefined);
            client._attachExistingConnection(conn);
            conn.notifyConnect("127.0.0.1", 2575);

            let settled = false;
            client.send(sent.bytes).then(
              () => {
                settled = true;
              },
              () => {
                settled = true;
              },
            );
            try {
              for (const answer of answers) {
                const wire = framed && deliverable(answer) ? encodeFrame(answer) : answer;
                try {
                  peer.write(wire);
                } catch (err) {
                  throw unsanctioned("a write into a client's connection", err, answer);
                }
                await drain();
              }
            } finally {
              client.destroy(new Error("fuzz case complete"));
              await drain();
            }
            for (const error of errors) {
              // A framing fatal from the connection, or an acknowledgement the client could not
              // match, reported by code with no byte of the peer's payload in it.
              const framingFatal =
                error instanceof MllpConnectionError &&
                error.connectionCause === "framing-fatal" &&
                error.cause instanceof MllpFramingError;
              const unmatched =
                error instanceof MllpFramingError &&
                (error.code === "MLLP_ACK_UNMATCHED_CONTROL_ID" ||
                  error.code === "MLLP_ACK_AFTER_TIMEOUT") &&
                error.snippet.length === 0;
              if (!framingFatal && !unmatched) {
                throw unsanctioned("the client's receive path", error, Buffer.concat(answers));
              }
            }
            expect(settled, "the send settled once the client was destroyed").toBe(true);
          },
        ),
        fuzzParameters(60, 0x3117_0103),
      );
    },
    fuzzTimeout(60_000),
  );
});

describe("fuzz: the ack-from-hl7 adapter over @cosyte/hl7", () => {
  it(
    "buildMllpAck never throws for a known code, stays fail-safe, and its frame decodes to its payload",
    () => {
      fc.assert(
        fc.property(payloads, fc.constantFrom(...CODES), fc.boolean(), (bytes, code, asText) => {
          withinBudget(bytes, () => {
            const inbound = asText ? bytes.toString("latin1") : bytes;
            const ack = mustNotThrow("buildMllpAck", bytes, () => buildMllpAck(inbound, { code }));
            if (ack.warnings.some((w) => w.code === MLLP_ACK_INBOUND_UNPARSEABLE)) {
              expect(ack.code === "AA" || ack.code === "CA").toBe(false);
            }
            const frames: Buffer[] = [];
            new FrameReader({ strict: true, onFrame: (payload) => frames.push(payload) }).push(
              ack.frame,
            );
            expect(frames).toHaveLength(1);
            expect(frames[0]?.equals(ack.payload)).toBe(true);
          });
        }),
        fuzzParameters(300, 0x3117_0104),
      );
    },
    fuzzTimeout(60_000),
  );

  it(
    "detectMode throws only the peer's Hl7ParseError",
    () => {
      fc.assert(
        fc.property(payloads, fc.boolean(), (bytes, asText) => {
          withinBudget(bytes, () => {
            try {
              detectMode(asText ? bytes.toString("latin1") : bytes);
            } catch (err) {
              if (!(err instanceof Error && err.name === "Hl7ParseError")) {
                throw unsanctioned("detectMode", err, bytes);
              }
            }
          });
        }),
        fuzzParameters(300, 0x3117_0105),
      );
    },
    fuzzTimeout(60_000),
  );
});
