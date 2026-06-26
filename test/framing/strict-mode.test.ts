import { describe, it, expect } from "vitest";
import { FrameReader } from "../../src/framing/decoder.js";
import { MllpFramingError } from "../../src/framing/error.js";

function frame(payload: number[]): Buffer {
  return Buffer.from([0x0b, ...payload, 0x1c, 0x0d]);
}

describe("FrameReader — strict mode (WARN-08)", () => {
  describe("MLLP_FS_WITHOUT_CR escalated to error", () => {
    it("throws even with allowFsOnly: true when strict: true", () => {
      const r = new FrameReader({ onFrame: () => {}, allowFsOnly: true, strict: true });
      expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]))).toThrow(MllpFramingError);
      try {
        const r2 = new FrameReader({ onFrame: () => {}, allowFsOnly: true, strict: true });
        r2.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      } catch (err) {
        expect((err as MllpFramingError).code).toBe("MLLP_FS_WITHOUT_CR");
      }
    });

    it("throws for non-VT stray byte after FS with allowFsOnly: true and strict: true", () => {
      const r = new FrameReader({ onFrame: () => {}, allowFsOnly: true, strict: true });
      // [VT, A, FS, X] — X is not CR/LF/VT, triggers allowFsOnly path
      expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x41]))).toThrow(MllpFramingError);
      try {
        const r2 = new FrameReader({ onFrame: () => {}, allowFsOnly: true, strict: true });
        r2.push(Buffer.from([0x0b, 0x41, 0x1c, 0x41]));
      } catch (err) {
        expect((err as MllpFramingError).code).toBe("MLLP_FS_WITHOUT_CR");
      }
    });
  });

  describe("MLLP_LF_AFTER_FS escalated to error", () => {
    it("throws even with allowLfAfterFs: true when strict: true", () => {
      const r = new FrameReader({ onFrame: () => {}, allowLfAfterFs: true, strict: true });
      expect(() => r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0a]))).toThrow(MllpFramingError);
      try {
        const r2 = new FrameReader({ onFrame: () => {}, allowLfAfterFs: true, strict: true });
        r2.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0a]));
      } catch (err) {
        expect((err as MllpFramingError).code).toBe("MLLP_LF_AFTER_FS");
      }
    });
  });

  describe("MLLP_MISSING_LEADING_VT escalated to error", () => {
    it("throws even with allowMissingLeadingVt: true when strict: true", () => {
      const r = new FrameReader({ onFrame: () => {}, allowMissingLeadingVt: true, strict: true });
      expect(() => r.push(Buffer.from([0x41, 0x1c, 0x0d]))).toThrow(MllpFramingError);
      try {
        const r2 = new FrameReader({
          onFrame: () => {},
          allowMissingLeadingVt: true,
          strict: true,
        });
        r2.push(Buffer.from([0x41, 0x1c, 0x0d]));
      } catch (err) {
        expect((err as MllpFramingError).code).toBe("MLLP_MISSING_LEADING_VT");
      }
    });

    it("throws even with allowLeadingWhitespace: true when strict: true", () => {
      const r = new FrameReader({ onFrame: () => {}, allowLeadingWhitespace: true, strict: true });
      expect(() => r.push(Buffer.from([0x20, 0x0b, 0x41, 0x1c, 0x0d]))).toThrow(MllpFramingError);
      try {
        const r2 = new FrameReader({
          onFrame: () => {},
          allowLeadingWhitespace: true,
          strict: true,
        });
        r2.push(Buffer.from([0x20, 0x0b, 0x41, 0x1c, 0x0d]));
      } catch (err) {
        expect((err as MllpFramingError).code).toBe("MLLP_MISSING_LEADING_VT");
      }
    });
  });

  describe("MLLP_EMPTY_PAYLOAD stays a warning in strict mode", () => {
    it("does not throw for empty payload even with strict: true", () => {
      const warnings: string[] = [];
      const r = new FrameReader({
        onFrame: () => {},
        onWarning: (w) => warnings.push(w.code),
        strict: true,
      });
      expect(() => r.push(frame([]))).not.toThrow();
      expect(warnings).toContain("MLLP_EMPTY_PAYLOAD");
    });
  });

  describe("MLLP_TRAILING_BYTES stays a warning in strict mode", () => {
    it("does not throw for trailing bytes with strict: true", () => {
      const warnings: string[] = [];
      const r = new FrameReader({
        onFrame: () => {},
        onWarning: (w) => warnings.push(w.code),
        strict: true,
      });
      // Feed: [VT, A, VT, B, FS, CR] — second VT triggers MLLP_TRAILING_BYTES for 'A'
      expect(() => r.push(Buffer.from([0x0b, 0x41, 0x0b, 0x42, 0x1c, 0x0d]))).not.toThrow();
      expect(warnings).toContain("MLLP_TRAILING_BYTES");
    });
  });

  describe("strict: false is same as default", () => {
    it("allowFsOnly with strict: false still emits warning (no throw)", () => {
      const warnings: string[] = [];
      const frames: Buffer[] = [];
      const r = new FrameReader({
        onFrame: (p) => frames.push(p),
        onWarning: (w) => warnings.push(w.code),
        allowFsOnly: true,
        strict: false,
      });
      r.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0b, 0x42, 0x1c, 0x0d]));
      expect(frames).toHaveLength(2);
      expect(warnings).toContain("MLLP_FS_WITHOUT_CR");
    });
  });
});
