/**
 * The benchmark corpus is what its labels say, and every benchmark case runs.
 *
 * A benchmark that measures the wrong thing reads as a confident number all the same, so this holds
 * the corpus in `bench/corpus.mjs` to its shapes: each message is the size its label names, is one
 * well-formed HL7 v2 message with its MSH first, carries no MLLP framing byte (a payload holding VT
 * or FS is refused by the encoder), and the frames and reads built from it decode back to exactly
 * the messages sent. Then every case of `bench/mllp.bench.mjs` runs once against the source, so a
 * suite that throws, or a benchmark whose result weighs nothing, fails here rather than on a runner.
 * Every message is synthetic and built in code.
 */

import { describe, expect, it } from "vitest";

import {
  KIB,
  MIB,
  SEGMENT_BYTES,
  SHAPES,
  SOCKET_READ_BYTES,
  adtMessage,
  documentMessage,
  frame,
  oruMessage,
  reads,
  stream,
} from "../../bench/corpus.mjs";
import suite, { counting, roundTrip, splitReads } from "../../bench/mllp.bench.mjs";
import * as mllp from "../../src/index.js";

const VT = 0x0b;
const FS = 0x1c;

/** Every payload a FrameReader delivers for these reads, in order. */
function decode(chunks: readonly Buffer[]): Buffer[] {
  const out: Buffer[] = [];
  const reader = new mllp.FrameReader({ onFrame: (payload) => out.push(payload) });
  for (const chunk of chunks) reader.push(chunk);
  return out;
}

describe("the benchmark corpus", () => {
  it("builds each message at the size its label names", () => {
    expect(adtMessage(0).length).toBe(280);
    expect(adtMessage(999_999).length).toBe(280);
    const oru = oruMessage(0, 32 * KIB).length;
    expect(oru).toBeGreaterThanOrEqual(32 * KIB);
    expect(oru).toBeLessThan(32 * KIB + 128);
    for (const size of [MIB, 4 * MIB]) {
      const doc = documentMessage(0, size).length;
      expect(doc).toBeLessThanOrEqual(size);
      expect(doc).toBeGreaterThan(size - 8);
    }
  });

  it("builds one HL7 v2 message per payload, MSH first, with no VT or FS in it", () => {
    for (const shape of SHAPES) {
      for (let i = 0; i < Math.min(shape.messages, 4); i++) {
        const payload = shape.build(i);
        expect(payload.subarray(0, 4).toString("latin1")).toBe("MSH|");
        expect(payload.includes(VT)).toBe(false);
        expect(payload.includes(FS)).toBe(false);
        const segments = payload.toString("latin1").split("\r").filter(Boolean);
        expect(segments.filter((s) => s.startsWith("MSH|"))).toHaveLength(1);
        // The package reads the control id from MSH-10: each message of a pass has its own.
        expect(segments[0]?.split("|")[9]).toMatch(/^[ARD]\d{6}$/);
      }
    }
  });

  it("carries a document that is base64 of the size the label names", () => {
    const doc = documentMessage(3, MIB).toString("latin1");
    const obx = doc.split("\r").find((s) => s.startsWith("OBX|"));
    const data = obx?.split("|")[5]?.split("^")[4] ?? "";
    expect(data).toMatch(/^[A-Za-z0-9+/]+$/);
    expect(Buffer.from(data, "base64").length).toBeGreaterThan(MIB * 0.74);
    // The same index builds the same bytes; another index builds others.
    expect(documentMessage(3, MIB).equals(documentMessage(3, MIB))).toBe(true);
    expect(documentMessage(4, MIB).equals(documentMessage(3, MIB))).toBe(false);
  });

  it("frames and splits the messages so they decode back to exactly what was sent", () => {
    const adts = Array.from({ length: 64 }, (_v, i) => adtMessage(i));
    expect(frame(adts[0] as Buffer)).toEqual(mllp.encodeFrame(adts[0] as Buffer));
    const segments = reads(stream(adts), SEGMENT_BYTES);
    expect(segments.length).toBeGreaterThan(10);
    expect(segments.every((chunk) => chunk.length <= SEGMENT_BYTES)).toBe(true);
    expect(decode(segments)).toEqual(adts);
    expect(decode(splitReads(adts))).toEqual(adts);

    const doc = documentMessage(0, MIB);
    const docReads = splitReads([doc]);
    expect(docReads.length).toBe(Math.ceil((doc.length + 3) / SOCKET_READ_BYTES));
    expect(decode(docReads)).toEqual([doc]);
  });
});

describe("the benchmark suite", () => {
  it("names four benchmarks over the four shapes, the two large ones left to the readings", () => {
    expect(suite.benchmarks.map((b) => b.name)).toEqual([
      "FrameReader: decode",
      "FrameReader: decode, split across reads",
      "encodeFrame",
      "Connection: send, then ACK",
    ]);
    for (const benchmark of suite.benchmarks) {
      expect(benchmark.sizes.map((s) => [s.label, s.compare])).toEqual([
        ["ADT^A01, 280 B", true],
        ["ORU^R01, 32 KiB", true],
        ["MDM^T02, 1 MiB base64", false],
        ["MDM^T02, 4 MiB base64", false],
      ]);
    }
  });

  it("runs every case once against the source, and each result weighs something", () => {
    for (const benchmark of suite.benchmarks) {
      for (const size of benchmark.sizes) {
        const corpus = size.build();
        const run = benchmark.bind(mllp);
        let weight = 0;
        for (const input of corpus.inputs) weight += benchmark.weigh?.(run(input)) ?? 1;
        expect(weight, `${benchmark.name} at ${size.label}`).toBeGreaterThan(0);
        expect(corpus.bytes).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it("decodes one frame per message, and answers each with an AA naming its control id", () => {
    const { reader, seen } = counting(mllp);
    reader.push(stream([adtMessage(1), adtMessage(2)]));
    expect(seen.frames).toBe(2);
    expect(seen.bytes).toBe(560);

    const exchange = roundTrip(mllp);
    const ack = exchange(adtMessage(7))?.toString("latin1") ?? "";
    expect(ack.split("\r").find((s) => s.startsWith("MSA|"))).toBe("MSA|AA|A000007");
  });
});
