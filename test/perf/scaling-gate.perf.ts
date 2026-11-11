/**
 * The scaling gate for the receive path and for a round trip through a connection, from
 * `@cosyte/test-utils/perf`, run by `pnpm test:perf` and never under coverage (see
 * `vitest.perf.config.ts`).
 *
 * It asks one question: does the cost grow faster than the input? On the count axis, 4 times the
 * messages; on the size axis, messages 4 times longer, arriving in 4 times the reads. Each ratio
 * must stay inside the band the shared contract fixes. It does not see a constant-factor slowdown:
 * a decoder 10% slower everywhere passes, and always will. The base against head comparison on a
 * pull request (`bench/mllp.bench.mjs`) is the instrument for that.
 *
 * The self-checks prove these fixtures are large enough for the gate to fail. The regression they
 * inject is the one a stream reader most often has: on every read, everything received so far
 * searched again from its first byte for the end of the frame, which costs the square of the reads.
 * It must clear the ceiling at exactly these sizes. Every input is synthetic and built in
 * code by `bench/corpus.mjs`.
 *
 * A warmup that never settles is measured again in the same job, at most three times, and every
 * other failure fails at once: `unstable-warmup.ts` holds that rule and the reason for it.
 */

import {
  assertScalingGateFires,
  scalingGate,
  type ScalingGateOptions,
} from "@cosyte/test-utils/perf";
import { describe, expect, it } from "vitest";

import {
  KIB,
  SEGMENT_BYTES,
  adtMessage,
  documentMessage,
  frame,
  reads,
} from "../../bench/corpus.mjs";
import { roundTrip } from "../../bench/mllp.bench.mjs";
import * as mllp from "../../src/index.js";

import { expectMeasured, gateUntilWarm, selfCheckUntilWarm } from "./unstable-warmup.js";

const FS = 0x1c;

/**
 * One reader for every input, as one connection reads message after message. A fresh reader per
 * input also allocates its 4 KiB buffer outside the heap each time, and on the count axis that
 * churn, not the decoding, set the pace: the warmup never settled.
 */
let delivered: Buffer[] = [];
const reader = new mllp.FrameReader({ onFrame: (payload) => delivered.push(payload) });

/** Every payload the reader delivers for these reads, in order. */
function decode(chunks: readonly Buffer[]): Buffer[] {
  delivered = [];
  for (const chunk of chunks) reader.push(chunk);
  return delivered;
}

/**
 * Every read searched again from the first byte of the first read for the end of the frame, as a
 * reader that keeps no cursor does: quadratic in the reads. Returns the bytes, all of them. It
 * allocates nothing per read, so its cost is the search alone and does not move with the collector.
 */
function rescanEveryRead(chunks: readonly Buffer[]): Buffer {
  let searched = 0;
  for (let last = 0; last < chunks.length; last++) {
    search: for (let k = 0; k <= last; k++) {
      const chunk = chunks[k] as Buffer;
      for (let at = 0; at < chunk.length; at++, searched++) {
        if (chunk[at] === FS) break search;
      }
    }
  }
  // The search's work is read here, so the compiler cannot drop it.
  if (searched < 0) throw new Error("unreachable");
  return Buffer.concat(chunks);
}

/** Two lists of payloads hold the same bytes in the same order. */
function samePayloads(a: readonly Buffer[], b: readonly Buffer[]): boolean {
  return a.length === b.length && a.every((payload, k) => payload.equals(b[k] as Buffer));
}

/** One message as a socket hands it up: its frame in reads of one TCP segment. */
function arriving(payload: Buffer): Buffer[] {
  return reads(frame(payload), SEGMENT_BYTES);
}

/**
 * A document message of `size` KiB, one of 16 kept per size: the size axis takes thousands of
 * inputs, enough for its clean phase to clear the gate's 4 ms floor now that a frame is decoded in
 * bulk, and building each afresh would cost more than measuring it. Many short documents rather
 * than a few long ones, because the self-check's injected regression costs the square of the
 * reads in one document, and the fixture must stay quick to run with it.
 */
const documents = new Map<string, Buffer>();
function documentOf(i: number, size: number): Buffer {
  const key = `${String(i % 16)}:${String(size)}`;
  let doc = documents.get(key);
  if (doc === undefined) {
    doc = documentMessage(i % 16, size * KIB);
    documents.set(key, doc);
  }
  return doc;
}

/**
 * The receive path: a 280 byte ADT^A01 in one read on the count axis; on the size axis, a document
 * message of `size` KiB in 1,460 byte reads.
 */
const decodeOptions: ScalingGateOptions<Buffer[], Buffer[]> = {
  name: "@cosyte/mllp FrameReader",
  parse: (chunks) => decode(chunks),
  weigh: (payloads) => payloads.length,
  count: { n: 48_000, generate: (i) => arriving(adtMessage(i)) },
  size: { inputs: 2_000, size: 8, generate: (i, size) => arriving(documentOf(i, size)) },
};

/** The MSA segment of an ACK: the code and the control id it answers, which a resend keys on. */
function msa(ack: Buffer | null): string {
  return (
    ack
      ?.toString("latin1")
      .split("\r")
      .find((segment) => segment.startsWith("MSA|")) ?? ""
  );
}

const exchange = roundTrip(mllp);

/**
 * A message out through one connection and its ACK back through the other, over the synchronous
 * loopback transport the benchmarks use: the ADT^A01 on the count axis, the document on the size.
 */
const roundTripOptions: ScalingGateOptions<Buffer, string> = {
  name: "@cosyte/mllp Connection, send then ACK",
  parse: (payload) => msa(exchange(payload)),
  weigh: (answer) => answer.length,
  count: { n: 4_000, generate: (i) => adtMessage(i) },
  size: { inputs: 1_000, size: 16, generate: (i, size) => documentOf(i, size) },
};

describe("the scaling gate: the receive path", () => {
  it("has not acquired a complexity regression on either axis", () => {
    // A skip is not a pass: a gate that could not measure says so here, rather than reading green.
    expectMeasured(gateUntilWarm(() => scalingGate(decodeOptions)));
  });

  it("has fixtures large enough for that gate to fail", () => {
    const report = selfCheckUntilWarm(() =>
      assertScalingGateFires(decodeOptions, {
        regressedParse: (chunks) => decode([rescanEveryRead(chunks)]),
        equals: samePayloads,
      }),
    );
    expect(report.margin).toBeGreaterThan(1);
  });
});

describe("the scaling gate: a round trip through a connection", () => {
  it("has not acquired a complexity regression on either axis", () => {
    expectMeasured(gateUntilWarm(() => scalingGate(roundTripOptions)));
  });

  it("has fixtures large enough for that gate to fail", () => {
    const report = selfCheckUntilWarm(() =>
      assertScalingGateFires(roundTripOptions, {
        regressedParse: (payload) => msa(exchange(rescanEveryRead(reads(payload, SEGMENT_BYTES)))),
      }),
    );
    expect(report.margin).toBeGreaterThan(1);
  });
});
