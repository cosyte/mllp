import { describe, it, expect } from "vitest";
import { encodeFrame } from "../../src/framing/encoder.js";
import { FrameReader } from "../../src/framing/decoder.js";
import { MllpFramingError } from "../../src/framing/error.js";

const VT = 0x0b;
const FS = 0x1c;

/**
 * Round-trip helper: encode a payload and decode it via FrameReader.
 * Returns the decoded payload buffer.
 */
function roundTrip(payload: Buffer): Buffer {
  let received: Buffer | undefined;
  const r = new FrameReader({
    onFrame: (p) => {
      received = p;
    },
  });
  const encoded = encodeFrame(payload);
  r.push(encoded);
  if (received === undefined) throw new Error("No frame delivered");
  return received;
}

/**
 * Round-trip in 1-byte chunks.
 */
function roundTripChunked(payload: Buffer): Buffer {
  let received: Buffer | undefined;
  const r = new FrameReader({
    onFrame: (p) => {
      received = p;
    },
  });
  const encoded = encodeFrame(payload);
  for (let i = 0; i < encoded.length; i++) {
    r.push(encoded.subarray(i, i + 1));
  }
  if (received === undefined) throw new Error("No frame delivered (chunked)");
  return received;
}

describe("FRAME-12: byte-fidelity round-trip", () => {
  it("every byte value 0x00-0xFF except 0x0B/0x1C round-trips unchanged", () => {
    for (let b = 0; b <= 0xff; b++) {
      if (b === VT || b === FS) continue; // handled in next tests
      const payload = Buffer.from([b]);
      const decoded = roundTrip(payload);
      expect(decoded[0]).toBe(b);
      expect(decoded.length).toBe(1);
    }
  });

  it("0x0B (VT) in payload causes MllpFramingError (FRAME-02 guard)", () => {
    expect(() => encodeFrame(Buffer.from([VT]))).toThrow(MllpFramingError);
    try {
      encodeFrame(Buffer.from([VT]));
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
    }
  });

  it("0x1C (FS) in payload causes MllpFramingError (FRAME-02 guard)", () => {
    expect(() => encodeFrame(Buffer.from([FS]))).toThrow(MllpFramingError);
    try {
      encodeFrame(Buffer.from([FS]));
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
    }
  });

  it("multi-byte payload with all safe bytes round-trips unchanged", () => {
    // Build a payload with all safe bytes (excluding VT/FS)
    const safeBytes: number[] = [];
    for (let b = 0; b <= 0xff; b++) {
      if (b !== VT && b !== FS) safeBytes.push(b);
    }
    const payload = Buffer.from(safeBytes);
    const decoded = roundTrip(payload);
    expect(decoded).toEqual(payload);
  });

  it(
    "1 MiB random corpus (excluding VT/FS bytes) round-trips unchanged",
    { timeout: 30_000 },
    () => {
      // Generate 1 MiB of deterministic pseudo-random bytes, filtering out VT and FS
      const SIZE = 1024 * 1024;
      const raw = Buffer.allocUnsafe(SIZE);
      // Use a simple LCG for determinism (no crypto dependency)
      let seed = 0xdeadbeef;
      for (let i = 0; i < SIZE; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        raw[i] = seed & 0xff;
      }
      // Strip VT and FS bytes (replace with 0x41 'A')
      for (let i = 0; i < raw.length; i++) {
        const b = raw[i];
        if (b === VT || b === FS) raw[i] = 0x41;
      }
      const decoded = roundTrip(raw);
      expect(decoded).toEqual(raw);
      expect(decoded.length).toBe(SIZE);
    },
  );

  it("corpus round-trips correctly in 1-byte chunks", () => {
    // 8 KiB corpus for 1-byte chunk test (full 1 MiB would be slow)
    const SIZE = 8192;
    const payload = Buffer.allocUnsafe(SIZE);
    let seed = 0xcafebabe;
    for (let i = 0; i < SIZE; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      const b = seed & 0xff;
      payload[i] = b === VT || b === FS ? 0x41 : b;
    }
    const decoded = roundTripChunked(payload);
    expect(decoded).toEqual(payload);
  });
});
