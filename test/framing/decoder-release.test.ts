/**
 * A FrameReader holds no more than the frame it is part way through.
 *
 * A receiver that read one 4 MiB message used to keep a 4 MiB buffer for the life of the
 * connection, and up to the 16 MiB frame limit after a message that size: the accumulator grew to
 * fit the largest frame and never shrank. These read the accumulator's size after a large frame is
 * delivered, discarded or reset, and hold it to the 4 KiB the reader starts with. Every byte is
 * synthetic.
 */

import { describe, expect, it } from "vitest";

import { FrameReader } from "../../src/framing/index.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** The 4 KiB a reader starts with. */
const INITIAL = 4096;

/** The bytes a reader is holding for frames, read through its private fields. */
function held(reader: FrameReader): number {
  const inside = reader as unknown as { _accumulator: Buffer; _parts?: Buffer[] };
  const parts = inside._parts ?? [];
  return inside._accumulator.length + parts.reduce((n, part) => n + part.length, 0);
}

/** `bytes` in reads of `size`. */
function reads(bytes: Buffer, size: number): Buffer[] {
  const out: Buffer[] = [];
  for (let at = 0; at < bytes.length; at += size) out.push(bytes.subarray(at, at + size));
  return out;
}

/** A synthetic payload of `length` bytes holding no framing byte. */
function body(length: number): Buffer {
  const out = Buffer.alloc(length);
  for (let k = 0; k < length; k++) out[k] = 0x41 + (k % 26);
  return out;
}

const LARGE = body(1024 * 1024 + 17);

describe("FrameReader releases a large frame's buffer", () => {
  it("after delivering a frame that arrived across many reads", () => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => got.push(p) });
    const framed = Buffer.concat([Buffer.from([VT]), LARGE, Buffer.from([FS, CR])]);
    for (const chunk of reads(framed, 64 * 1024)) reader.push(chunk);
    expect(got).toHaveLength(1);
    expect((got[0] as Buffer).equals(LARGE)).toBe(true);
    expect(held(reader)).toBeLessThanOrEqual(INITIAL);
  });

  it("after a mid-payload VT discards a large partial frame", () => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => got.push(p) });
    reader.push(Buffer.concat([Buffer.from([VT]), LARGE.subarray(0, 512 * 1024)]));
    reader.push(LARGE.subarray(512 * 1024));
    reader.push(Buffer.from([VT]));
    expect(held(reader)).toBeLessThanOrEqual(INITIAL);
    reader.push(Buffer.from([0x4d, FS, CR]));
    expect(got.map((p) => p.toString("latin1"))).toEqual(["M"]);
  });

  it("holding no more than the partial frame and one block while a frame is part way", () => {
    const reader = new FrameReader({ onFrame: () => undefined });
    const partial = Buffer.concat([Buffer.from([VT]), LARGE.subarray(0, 600 * 1024)]);
    for (const chunk of reads(partial, 1460)) reader.push(chunk);
    expect(held(reader)).toBeLessThanOrEqual(600 * 1024 + INITIAL);
    for (const chunk of reads(LARGE.subarray(600 * 1024, 700 * 1024), 64 * 1024)) {
      reader.push(chunk);
    }
    expect(held(reader)).toBeLessThanOrEqual(700 * 1024 + INITIAL);
  });

  it("on reset() with a large partial frame pending", () => {
    const reader = new FrameReader({ onFrame: () => undefined });
    reader.push(Buffer.concat([Buffer.from([VT]), LARGE.subarray(0, 300 * 1024)]));
    reader.push(LARGE.subarray(300 * 1024));
    reader.reset();
    expect(held(reader)).toBeLessThanOrEqual(INITIAL);
  });

  it("and still delivers the next large frame whole, split at a read edge inside FS CR", () => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => got.push(p) });
    const framed = Buffer.concat([Buffer.from([VT]), LARGE, Buffer.from([FS])]);
    for (let round = 0; round < 3; round++) {
      for (const chunk of reads(framed, 50_000)) reader.push(chunk);
      reader.push(Buffer.from([CR]));
    }
    expect(got).toHaveLength(3);
    for (const p of got) expect(p.equals(LARGE)).toBe(true);
    expect(held(reader)).toBeLessThanOrEqual(INITIAL);
  });
});
