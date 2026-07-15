import { describe, it, expect } from "vitest";
import { FrameReader } from "../../src/framing/decoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import { must } from "../helpers/tracked-servers.js";

// Helper: wrap a payload in canonical MLLP framing
function frame(payload: number[]): Buffer {
  return Buffer.from([0x0b, ...payload, 0x1c, 0x0d]);
}

describe("FrameReader — basic framing", () => {
  it("delivers a single complete frame", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    r.push(frame([0x41, 0x42, 0x43]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41, 0x42, 0x43]));
  });

  it("delivers N frames from one chunk", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    r.push(Buffer.concat([frame([0x41]), frame([0x42]), frame([0x43])]));
    expect(frames).toHaveLength(3);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(frames[1]).toEqual(Buffer.from([0x42]));
    expect(frames[2]).toEqual(Buffer.from([0x43]));
  });

  it("delivers frame split across N 1-byte chunks", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    const buf = frame([0x41, 0x42]);
    for (let i = 0; i < buf.length; i++) {
      r.push(buf.subarray(i, i + 1));
    }
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41, 0x42]));
  });

  it("handles chunk ending at FS with CR in next chunk", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    r.push(Buffer.from([0x0b, 0x41, 0x1c]));
    expect(frames).toHaveLength(0);
    r.push(Buffer.from([0x0d]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
  });

  it("back-to-back frames with zero bytes between", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    r.push(Buffer.concat([frame([0x41]), frame([0x42])]));
    expect(frames).toHaveLength(2);
  });

  it("delivered payload is a copied Buffer — mutating accumulator does not corrupt prior frame", () => {
    const captured: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => captured.push(p) });
    r.push(frame([0x41, 0x42]));
    r.push(frame([0x43, 0x44]));
    // If payload were a view into the accumulator the second push would overwrite it
    expect(captured[0]).toEqual(Buffer.from([0x41, 0x42]));
    expect(captured[1]).toEqual(Buffer.from([0x43, 0x44]));
  });

  it("accumulator grows beyond initial size for large payloads", () => {
    // Push a payload larger than the default initial accumulator (4096 bytes)
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    const big = Buffer.alloc(8192, 0x41); // 8 KiB of 'A'
    const wrapped = Buffer.concat([Buffer.from([0x0b]), big, Buffer.from([0x1c, 0x0d])]);
    r.push(wrapped);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(big);
  });
});

describe("FrameReader — MLLP_EMPTY_PAYLOAD (always a warning)", () => {
  it("delivers empty Buffer and emits MLLP_EMPTY_PAYLOAD warning", () => {
    const frames: Buffer[] = [];
    const warnings: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnings.push(w.code),
    });
    r.push(frame([]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.alloc(0));
    expect(warnings).toContain("MLLP_EMPTY_PAYLOAD");
  });

  it("does not throw for empty payload even without tolerance opt-in", () => {
    const r = new FrameReader({ onFrame: () => {} });
    expect(() => r.push(frame([]))).not.toThrow();
  });
});

describe("FrameReader — FRAME-06: byte offset tracking", () => {
  it("onWarning receives correct absolute byteOffset", () => {
    const warnings: number[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnings.push(w.byteOffset),
      allowFsOnly: true,
    });
    // Byte layout:
    // [0]=VT [1]=A [2]=FS [3]=CR  — 1st frame complete at offset 3
    // [4]=VT [5]=B [6]=FS [7]=VT  — FS_WITHOUT_CR at offset 7 (VT after FS)
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0d, 0x0b, 0x42, 0x1c, 0x0b]));
    // MLLP_FS_WITHOUT_CR warning should carry byteOffset 7
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toBe(7);
  });

  it("byteOffset increases monotonically across multiple push() calls", () => {
    const offsets: number[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => offsets.push(w.byteOffset),
      allowFsOnly: true,
    });
    // First push: 4 bytes [VT, A, FS, CR] — complete frame, byteOffset goes 0..3
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
    // Second push: [VT, B, FS, VT] — FS_WITHOUT_CR at offset 7 (4+3)
    r.push(Buffer.from([0x0b, 0x42, 0x1c, 0x0b]));
    expect(offsets[0]).toBe(7);
  });
});

describe("FrameReader — FRAME-07: allowFsOnly (MLLP_FS_WITHOUT_CR)", () => {
  it("throws MllpFramingError without opt-in when FS not followed by CR", () => {
    const r = new FrameReader({ onFrame: () => {} });
    // [VT, A, FS, VT] — FS followed by VT (no CR)
    expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]))).toThrow(MllpFramingError);
  });

  it("thrown error has code MLLP_FS_WITHOUT_CR", () => {
    const r = new FrameReader({ onFrame: () => {} });
    try {
      r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_FS_WITHOUT_CR");
    }
  });

  it("emits MLLP_FS_WITHOUT_CR warning and delivers frame with allowFsOnly: true", () => {
    const frames: Buffer[] = [];
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnCodes.push(w.code),
      allowFsOnly: true,
    });
    // [VT, A, FS, VT, B, FS, CR] — first frame without CR (FS directly followed by VT of next frame)
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b, 0x42, 0x1c, 0x0d]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(frames[1]).toEqual(Buffer.from([0x42]));
    expect(warnCodes).toContain("MLLP_FS_WITHOUT_CR");
  });

  it("throws MllpFramingError without opt-in for non-CR byte after FS", () => {
    const r = new FrameReader({ onFrame: () => {} });
    // [VT, A, FS, 0x42] — FS followed by random byte
    expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x42]))).toThrow(MllpFramingError);
    const r2 = new FrameReader({ onFrame: () => {} });
    try {
      r2.push(Buffer.from([0x0b, 0x41, 0x1c, 0x42]));
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_FS_WITHOUT_CR");
    }
  });
});

describe("FrameReader — FRAME-08: allowLfAfterFs (MLLP_LF_AFTER_FS)", () => {
  it("throws MllpFramingError without opt-in when FS followed by LF", () => {
    const r = new FrameReader({ onFrame: () => {} });
    expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0a]))).toThrow(MllpFramingError);
  });

  it("thrown error has code MLLP_LF_AFTER_FS", () => {
    const r = new FrameReader({ onFrame: () => {} });
    try {
      r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0a]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_LF_AFTER_FS");
    }
  });

  it("emits MLLP_LF_AFTER_FS warning and delivers frame with allowLfAfterFs: true", () => {
    const frames: Buffer[] = [];
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnCodes.push(w.code),
      allowLfAfterFs: true,
    });
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0a]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(warnCodes).toContain("MLLP_LF_AFTER_FS");
  });
});

describe("FrameReader — FRAME-09: allowMissingLeadingVt (MLLP_MISSING_LEADING_VT)", () => {
  it("throws MllpFramingError without opt-in on non-VT first byte", () => {
    const r = new FrameReader({ onFrame: () => {} });
    expect(() => r.push(Buffer.from([0x41, 0x1c, 0x0d]))).toThrow(MllpFramingError);
  });

  it("thrown error has code MLLP_MISSING_LEADING_VT", () => {
    const r = new FrameReader({ onFrame: () => {} });
    try {
      r.push(Buffer.from([0x41, 0x1c, 0x0d]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_MISSING_LEADING_VT");
    }
  });

  it("emits MLLP_MISSING_LEADING_VT and delivers frame with allowMissingLeadingVt: true", () => {
    const frames: Buffer[] = [];
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnCodes.push(w.code),
      allowMissingLeadingVt: true,
    });
    // Stream: [A, B, FS, CR] — no leading VT
    r.push(Buffer.from([0x41, 0x42, 0x1c, 0x0d]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41, 0x42]));
    expect(warnCodes).toContain("MLLP_MISSING_LEADING_VT");
  });
});

describe("FrameReader — FRAME-10: allowLeadingWhitespace (MLLP_LEADING_WHITESPACE)", () => {
  it("throws MllpFramingError without opt-in on whitespace before VT", () => {
    const r = new FrameReader({ onFrame: () => {} });
    // SP before VT
    expect(() => r.push(Buffer.from([0x20, 0x0b, 0x41, 0x1c, 0x0d]))).toThrow(MllpFramingError);
  });

  it("emits MLLP_LEADING_WHITESPACE and delivers frame with allowLeadingWhitespace: true", () => {
    const frames: Buffer[] = [];
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnCodes.push(w.code),
      allowLeadingWhitespace: true,
    });
    // SP + TAB before VT
    r.push(Buffer.from([0x20, 0x09, 0x0b, 0x41, 0x1c, 0x0d]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(warnCodes).toContain("MLLP_LEADING_WHITESPACE");
  });

  it("MLLP_LEADING_WHITESPACE warning byteOffset is the offset of the first whitespace byte", () => {
    const warnOffsets: number[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnOffsets.push(w.byteOffset),
      allowLeadingWhitespace: true,
    });
    // SP at offset 0, TAB at offset 1, VT at offset 2
    r.push(Buffer.from([0x20, 0x09, 0x0b, 0x41, 0x1c, 0x0d]));
    expect(warnOffsets[0]).toBe(0);
  });

  it("handles LF and CR as leading whitespace", () => {
    const frames: Buffer[] = [];
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: (w) => warnCodes.push(w.code),
      allowLeadingWhitespace: true,
    });
    r.push(Buffer.from([0x0a, 0x0d, 0x0b, 0x41, 0x1c, 0x0d]));
    expect(frames).toHaveLength(1);
    expect(warnCodes).toContain("MLLP_LEADING_WHITESPACE");
  });
});

describe("FrameReader — FRAME-11: maxFrameSizeBytes (MLLP_FRAME_TOO_LARGE)", () => {
  it("throws MllpFramingError(MLLP_FRAME_TOO_LARGE) when payload exceeds limit", () => {
    const r = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: 5 });
    // VT + 6 payload bytes → should throw at the 6th byte
    const buf = Buffer.from([0x0b, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x1c, 0x0d]);
    expect(() => r.push(buf)).toThrow(MllpFramingError);
  });

  it("thrown error has code MLLP_FRAME_TOO_LARGE", () => {
    try {
      const r = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: 5 });
      r.push(Buffer.from([0x0b, 0x41, 0x42, 0x43, 0x44, 0x45, 0x46, 0x1c, 0x0d]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_FRAME_TOO_LARGE");
    }
  });

  it("does not throw for payload exactly at limit", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p), maxFrameSizeBytes: 3 });
    r.push(Buffer.from([0x0b, 0x41, 0x42, 0x43, 0x1c, 0x0d]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x41, 0x42, 0x43]));
  });

  it("error.byteOffset is non-zero (at cap point, not 0)", () => {
    try {
      const r = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: 3 });
      r.push(Buffer.from([0x0b, 0x41, 0x42, 0x43, 0x44, 0x1c, 0x0d]));
      expect.fail("should have thrown");
    } catch (err) {
      expect((err as MllpFramingError).byteOffset).toBeGreaterThan(0);
    }
  });

  it("MLLP_FRAME_TOO_LARGE always throws even with onWarning provided (WARN-09)", () => {
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnCodes.push(w.code),
      maxFrameSizeBytes: 2,
    });
    expect(() => r.push(Buffer.from([0x0b, 0x41, 0x42, 0x43, 0x1c, 0x0d]))).toThrow(
      MllpFramingError,
    );
    expect(warnCodes).not.toContain("MLLP_FRAME_TOO_LARGE");
  });
});

describe("FrameReader — WARN-06: onWarning try/catch safety", () => {
  it("throwing onWarning handler does not corrupt FSM — subsequent frames still delivered", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: () => {
        throw new Error("handler error");
      },
      allowFsOnly: true,
    });
    // First frame: [VT, A, FS, VT] — FS_WITHOUT_CR triggers onWarning (which throws), then
    // second frame [B, FS, CR] must still be delivered
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b, 0x42, 0x1c, 0x0d]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(frames[1]).toEqual(Buffer.from([0x42]));
  });

  it("throwing onWarning during MLLP_EMPTY_PAYLOAD does not break subsequent frame delivery", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({
      onFrame: (p) => frames.push(p),
      onWarning: () => {
        throw new Error("boom");
      },
    });
    r.push(frame([]));
    r.push(frame([0x41]));
    expect(frames).toHaveLength(2);
  });
});

describe("FrameReader — reset()", () => {
  it("discards partial accumulator state", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    // Push incomplete frame (no FS+CR)
    r.push(Buffer.from([0x0b, 0x41, 0x42]));
    r.reset();
    // After reset, a new complete frame should be delivered normally
    r.push(frame([0x43]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x43]));
  });

  it("resets byteOffset to 0 for connection reuse", () => {
    const warnOffsets: number[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnOffsets.push(w.byteOffset),
      allowFsOnly: true,
    });
    // Push a complete frame (5 bytes: VT A FS CR), then reset
    r.push(frame([0x41, 0x42, 0x43])); // 5 bytes: VT + 3 payload + FS + CR = 6 bytes
    r.reset();
    // After reset byteOffset is 0
    // [VT, A, FS, VT] — MLLP_FS_WITHOUT_CR at byteOffset 3 (zero-based after reset)
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
    expect(warnOffsets[0]).toBe(3);
  });

  it("reset after completing a frame allows fresh frame to be delivered", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    r.push(frame([0x41]));
    r.reset();
    r.push(frame([0x42]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(Buffer.from([0x41]));
    expect(frames[1]).toEqual(Buffer.from([0x42]));
  });
});

describe("FrameReader — MLLP_TRAILING_BYTES (always a warning)", () => {
  it("VT mid-payload emits MLLP_TRAILING_BYTES warning (never throws)", () => {
    const warnCodes: string[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnCodes.push(w.code),
    });
    // [VT, A, VT, B, FS, CR] — VT mid-payload discards partial frame A, starts fresh with B
    r.push(Buffer.from([0x0b, 0x41, 0x0b, 0x42, 0x1c, 0x0d]));
    expect(warnCodes).toContain("MLLP_TRAILING_BYTES");
  });

  it("VT mid-payload does not throw even without any tolerance opt-in", () => {
    const r = new FrameReader({ onFrame: () => {} });
    expect(() => r.push(Buffer.from([0x0b, 0x41, 0x0b, 0x42, 0x1c, 0x0d]))).not.toThrow();
  });

  it("VT mid-payload: payload after the embedded VT is delivered as complete frame", () => {
    const frames: Buffer[] = [];
    const r = new FrameReader({ onFrame: (p) => frames.push(p) });
    // Discard partial, deliver [B]
    r.push(Buffer.from([0x0b, 0x41, 0x0b, 0x42, 0x1c, 0x0d]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(Buffer.from([0x42]));
  });

  it("MLLP_TRAILING_BYTES is delivered on the discarded frame itself, not bled to the next", () => {
    // [VT A VT B FS CR VT C FS CR]: frame1 (B) had a mid-payload discard; frame2 (C) is clean.
    const perFrame: Array<{ payload: string; codes: string[] }> = [];
    const r = new FrameReader({
      onFrame: (p, _off, warnings) => {
        perFrame.push({ payload: p.toString("latin1"), codes: warnings.map((w) => w.code) });
      },
    });
    r.push(Buffer.from([0x0b, 0x41, 0x0b, 0x42, 0x1c, 0x0d, 0x0b, 0x43, 0x1c, 0x0d]));
    expect(perFrame).toHaveLength(2);
    expect(must(perFrame[0]).payload).toBe("B");
    expect(must(perFrame[0]).codes).toContain("MLLP_TRAILING_BYTES");
    expect(must(perFrame[1]).payload).toBe("C");
    // The discard belongs to frame 1 ONLY — it must not bleed onto the clean frame 2.
    expect(must(perFrame[1]).codes).not.toContain("MLLP_TRAILING_BYTES");
  });

  it("an FS-without-CR stray byte does NOT emit MLLP_TRAILING_BYTES (reserved for mid-payload VT)", () => {
    // [VT A FS X VT B FS CR]: frame1 (A) is FS-without-CR + stray 'X'; frame2 (B) is clean.
    // MLLP_TRAILING_BYTES is reserved for a mid-payload VT discard, so neither frame may carry it —
    // the stray byte is reported by MLLP_FS_WITHOUT_CR instead, and must not bleed onto frame 2.
    const perFrame: Array<{ payload: string; codes: string[] }> = [];
    const all: string[] = [];
    const r = new FrameReader({
      allowFsOnly: true,
      onWarning: (w) => all.push(w.code),
      onFrame: (p, _off, warnings) => {
        perFrame.push({ payload: p.toString("latin1"), codes: warnings.map((w) => w.code) });
      },
    });
    r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x58, 0x0b, 0x42, 0x1c, 0x0d]));
    expect(perFrame).toHaveLength(2);
    expect(must(perFrame[0]).payload).toBe("A");
    expect(must(perFrame[0]).codes).toContain("MLLP_FS_WITHOUT_CR");
    expect(must(perFrame[1]).payload).toBe("B");
    expect(all).not.toContain("MLLP_TRAILING_BYTES");
    expect(must(perFrame[1]).codes).not.toContain("MLLP_TRAILING_BYTES");
  });
});

describe("FrameReader — MllpWarning shape", () => {
  it("warning object is frozen", () => {
    const warnings: object[] = [];
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => warnings.push(w),
    });
    r.push(frame([]));
    expect(warnings).toHaveLength(1);
    expect(Object.isFrozen(warnings[0])).toBe(true);
  });

  it("warning has all required fields: code, message, byteOffset, connectionId, timestamp", () => {
    let captured: unknown;
    const r = new FrameReader({
      onFrame: () => {},
      onWarning: (w) => {
        captured = w;
      },
    });
    r.push(frame([]));
    const w = captured as {
      code: string;
      message: string;
      byteOffset: number;
      connectionId: unknown;
      timestamp: unknown;
    };
    expect(typeof w.code).toBe("string");
    expect(typeof w.message).toBe("string");
    expect(typeof w.byteOffset).toBe("number");
    expect(w.connectionId).toBeUndefined();
    expect(w.timestamp).toBeInstanceOf(Date);
  });
});
