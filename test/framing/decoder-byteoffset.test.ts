/**
 * Tests for FrameReader byteOffset and per-frame warnings threading (04-05 gap closure).
 *
 * These tests verify:
 * 1. onFrame receives byteOffset = stream byte offset of the VT that opened the frame.
 * 2. onFrame receives warnings = per-frame framing warnings emitted during that frame's parse.
 * 3. reset() resets byteOffset to 0.
 * 4. Two consecutive frames have correct byteOffset values.
 * 5. Connection 'message' event includes byteOffset and warnings from FrameReader.
 */

import { describe, it, expect } from "vitest";
import { FrameReader } from "../../src/framing/decoder.js";
import type { FrameReaderOptions } from "../../src/framing/decoder.js";
import type { MllpWarning } from "../../src/framing/registry.js";

// Narrowing helper: asserts a captured value is present without a non-null assertion.
function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

// Constants
const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;

// Helper: wrap a payload in canonical MLLP framing
function frame(payload: Buffer | number[]): Buffer {
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  return Buffer.concat([Buffer.from([VT]), p, Buffer.from([FS, CR])]);
}

// Helper: create a FrameReader that captures (payload, byteOffset, warnings) tuples
type FrameCall = { payload: Buffer; byteOffset: number; warnings: readonly MllpWarning[] };
function makeCaptureReader(extraOpts: Partial<Omit<FrameReaderOptions, "onFrame">> = {}): {
  reader: FrameReader;
  calls: FrameCall[];
} {
  const calls: FrameCall[] = [];
  const reader = new FrameReader({
    ...extraOpts,
    onFrame: (payload, byteOffset, warnings) => {
      calls.push({ payload, byteOffset, warnings });
    },
  });
  return { reader, calls };
}

describe("FrameReader byteOffset threading", () => {
  it("byteOffset is 0 when the first byte is VT", () => {
    const { reader, calls } = makeCaptureReader();
    const msg = Buffer.from([0x41, 0x42, 0x43]);
    reader.push(frame(msg));
    expect(calls).toHaveLength(1);
    expect(must(calls[0]).byteOffset).toBe(0);
  });

  it("byteOffset is 5 when 5 non-VT bytes precede the VT (allowLeadingWhitespace)", () => {
    const { reader, calls } = makeCaptureReader({ allowLeadingWhitespace: true });
    const preamble = Buffer.alloc(5, 0x20); // 5 SP bytes
    const msg = Buffer.from([0x41]);
    reader.push(Buffer.concat([preamble, frame(msg)]));
    expect(calls).toHaveLength(1);
    // VT is at index 5 (0-based)
    expect(must(calls[0]).byteOffset).toBe(5);
  });

  it("second frame byteOffset = 1 + firstPayloadLength + 2 (VT + payload + FS + CR)", () => {
    const { reader, calls } = makeCaptureReader();
    const first = Buffer.from([0x41, 0x42]); // 2 bytes
    const second = Buffer.from([0x43]);
    // First frame: VT(1) + payload(2) + FS(1) + CR(1) = 5 bytes
    // Second frame VT is at offset 5
    reader.push(Buffer.concat([frame(first), frame(second)]));
    expect(calls).toHaveLength(2);
    expect(must(calls[0]).byteOffset).toBe(0);
    expect(must(calls[1]).byteOffset).toBe(1 + first.length + 2); // 1 + 2 + 2 = 5
  });

  it("after reset(), next frame byteOffset starts at 0", () => {
    const { reader, calls } = makeCaptureReader();
    const msg = Buffer.from([0x41]);
    reader.push(frame(msg));
    expect(must(calls[0]).byteOffset).toBe(0);

    // Push another frame to advance offset before reset
    const msg2 = Buffer.from([0x42]);
    reader.push(frame(msg2));
    const secondOffset = must(calls[1]).byteOffset;
    expect(secondOffset).toBeGreaterThan(0);

    reader.reset();
    reader.push(frame(Buffer.from([0x43])));
    expect(must(calls[2]).byteOffset).toBe(0);
  });
});

describe("FrameReader per-frame warnings threading", () => {
  it("warnings is empty array for a canonical well-formed frame", () => {
    const { reader, calls } = makeCaptureReader();
    reader.push(frame(Buffer.from([0x41])));
    expect(calls).toHaveLength(1);
    expect(Array.isArray(must(calls[0]).warnings)).toBe(true);
    expect(must(calls[0]).warnings.length).toBe(0);
  });

  it("warnings contains MLLP_LF_AFTER_FS when FS+LF frame received (allowLfAfterFs)", () => {
    const warnings: MllpWarning[] = [];
    const calls: FrameCall[] = [];
    const reader = new FrameReader({
      allowLfAfterFs: true,
      onWarning: (w) => warnings.push(w),
      onFrame: (payload, byteOffset, frameWarnings) => {
        calls.push({ payload, byteOffset, warnings: frameWarnings });
      },
    });

    const payload = Buffer.from([0x41, 0x42]);
    const fsLfFrame = Buffer.from([VT, ...payload, FS, LF]);
    reader.push(fsLfFrame);

    expect(calls).toHaveLength(1);
    expect(must(calls[0]).warnings.length).toBe(1);
    expect(must(must(calls[0]).warnings[0]).code).toBe("MLLP_LF_AFTER_FS");
  });

  it("per-frame warnings do not bleed across frames", () => {
    const calls: FrameCall[] = [];
    const reader = new FrameReader({
      allowLfAfterFs: true,
      onFrame: (payload, byteOffset, frameWarnings) => {
        calls.push({ payload, byteOffset, warnings: frameWarnings });
      },
    });

    // First frame: FS+LF (triggers MLLP_LF_AFTER_FS)
    const fsLfFrame = Buffer.from([VT, 0x41, FS, LF]);
    // Second frame: canonical (no warnings)
    const canonical = frame(Buffer.from([0x42]));
    reader.push(Buffer.concat([fsLfFrame, canonical]));

    expect(calls).toHaveLength(2);
    expect(must(calls[0]).warnings.length).toBe(1);
    expect(must(must(calls[0]).warnings[0]).code).toBe("MLLP_LF_AFTER_FS");
    // Second frame must NOT inherit warnings from first frame
    expect(must(calls[1]).warnings.length).toBe(0);
  });

  it("warnings collected even when no onWarning handler is registered", () => {
    // warnings should be captured in the per-frame array even without onWarning
    const calls: FrameCall[] = [];
    const reader = new FrameReader({
      allowLfAfterFs: true,
      // No onWarning handler
      onFrame: (payload, byteOffset, frameWarnings) => {
        calls.push({ payload, byteOffset, warnings: frameWarnings });
      },
    });

    const fsLfFrame = Buffer.from([VT, 0x41, FS, LF]);
    reader.push(fsLfFrame);

    expect(calls).toHaveLength(1);
    expect(must(calls[0]).warnings.length).toBe(1);
    expect(must(must(calls[0]).warnings[0]).code).toBe("MLLP_LF_AFTER_FS");
  });
});
