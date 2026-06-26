import { describe, it, expect, vi } from "vitest";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning } from "../../src/framing/registry.js";

describe("encodeFrame — strict path (default)", () => {
  it("wraps payload: VT at [0], FS at [len-2], CR at [len-1]", () => {
    const payload = Buffer.from("MSH|^~\\&|SEND|FAC|||");
    const frame = encodeFrame(payload);
    expect(frame[0]).toBe(0x0b);
    expect(frame[frame.length - 2]).toBe(0x1c);
    expect(frame[frame.length - 1]).toBe(0x0d);
  });

  it("frame length is payload.length + 3", () => {
    const payload = Buffer.alloc(100);
    expect(encodeFrame(payload).length).toBe(103);
  });

  it("payload bytes are preserved verbatim between VT and FS", () => {
    const payload = Buffer.from([0x41, 0x42, 0x43]);
    const frame = encodeFrame(payload);
    expect(frame.subarray(1, 4)).toEqual(payload);
  });

  it("empty payload produces 3-byte frame [VT, FS, CR]", () => {
    const frame = encodeFrame(Buffer.alloc(0));
    expect(frame).toEqual(Buffer.from([0x0b, 0x1c, 0x0d]));
  });

  it("return value is a Buffer", () => {
    expect(Buffer.isBuffer(encodeFrame(Buffer.alloc(1)))).toBe(true);
  });

  it("throws MllpFramingError for payload containing VT (0x0B)", () => {
    const payload = Buffer.from([0x41, 0x0b, 0x42]);
    expect(() => encodeFrame(payload)).toThrow(MllpFramingError);
    try {
      encodeFrame(payload);
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
      expect((err as MllpFramingError).byteOffset).toBe(1);
    }
  });

  it("throws MllpFramingError for payload containing FS (0x1C)", () => {
    const payload = Buffer.from([0x41, 0x1c, 0x42]);
    expect(() => encodeFrame(payload)).toThrow(MllpFramingError);
    try {
      encodeFrame(payload);
    } catch (err) {
      expect((err as MllpFramingError).code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
      expect((err as MllpFramingError).byteOffset).toBe(1);
    }
  });

  it("thrown error snippet is a Buffer", () => {
    try {
      encodeFrame(Buffer.from([0x0b]));
    } catch (err) {
      expect(Buffer.isBuffer((err as MllpFramingError).snippet)).toBe(true);
    }
  });

  it("thrown error byteOffset matches index of first offending byte", () => {
    const payload = Buffer.from([0x41, 0x42, 0x0b, 0x43]);
    try {
      encodeFrame(payload);
    } catch (err) {
      expect((err as MllpFramingError).byteOffset).toBe(2);
    }
  });

  it("output buffer is independent — mutating payload after encode does not affect output", () => {
    const payload = Buffer.from([0x41, 0x42, 0x43]);
    const frame = encodeFrame(payload);
    const before = frame.subarray(1, 4).toString("hex");
    payload[0] = 0xff;
    const after = frame.subarray(1, 4).toString("hex");
    expect(after).toBe(before);
  });

  it("encodes a 1 MB payload without error", () => {
    const payload = Buffer.alloc(1024 * 1024, 0x41);
    const frame = encodeFrame(payload);
    expect(frame.length).toBe(1024 * 1024 + 3);
  });

  it("single-byte payload produces 4-byte frame", () => {
    const payload = Buffer.from([0x41]);
    const frame = encodeFrame(payload);
    expect(frame.length).toBe(4);
    expect(frame[0]).toBe(0x0b);
    expect(frame[1]).toBe(0x41);
    expect(frame[2]).toBe(0x1c);
    expect(frame[3]).toBe(0x0d);
  });
});

describe("encodeFrame — tolerant path (allowDelimiterBytesInPayload)", () => {
  it("does not throw on VT byte when allowDelimiterBytesInPayload: true", () => {
    const payload = Buffer.from([0x41, 0x0b, 0x42]);
    expect(() => encodeFrame(payload, { allowDelimiterBytesInPayload: true })).not.toThrow();
  });

  it("calls onWarning with MLLP_PAYLOAD_CONTAINS_VT for VT byte", () => {
    const payload = Buffer.from([0x41, 0x0b, 0x42]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning.mock.calls[0]?.[0].code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
    expect(onWarning.mock.calls[0]?.[0].byteOffset).toBe(1);
  });

  it("calls onWarning with MLLP_PAYLOAD_CONTAINS_FS for FS byte", () => {
    const payload = Buffer.from([0x41, 0x1c, 0x42]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning.mock.calls[0]?.[0].code).toBe("MLLP_PAYLOAD_CONTAINS_FS");
    expect(onWarning.mock.calls[0]?.[0].byteOffset).toBe(1);
  });

  it("calls onWarning twice when both VT and FS present", () => {
    const payload = Buffer.from([0x0b, 0x41, 0x1c]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(onWarning).toHaveBeenCalledTimes(2);
  });

  it("emitted warnings are frozen objects", () => {
    const payload = Buffer.from([0x0b]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(Object.isFrozen(onWarning.mock.calls[0]?.[0])).toBe(true);
  });

  it("delimiter bytes preserved verbatim in output frame", () => {
    const payload = Buffer.from([0x41, 0x0b, 0x42]);
    const frame = encodeFrame(payload, { allowDelimiterBytesInPayload: true });
    // VT byte at payload position 1 should appear at frame position 2 (after leading VT)
    expect(frame[2]).toBe(0x0b);
  });

  it("no throw when allowDelimiterBytesInPayload: true without onWarning", () => {
    expect(() =>
      encodeFrame(Buffer.from([0x0b, 0x1c]), { allowDelimiterBytesInPayload: true }),
    ).not.toThrow();
  });

  it("throwing onWarning handler does not interrupt encoding (WARN-06)", () => {
    const payload = Buffer.from([0x0b, 0x41]);
    const onWarning = (): void => {
      throw new Error("handler error");
    };
    expect(() =>
      encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning }),
    ).not.toThrow();
  });

  it("returned frame has correct length when delimiter bytes are tolerated", () => {
    const payload = Buffer.from([0x0b, 0x41, 0x1c]);
    const frame = encodeFrame(payload, { allowDelimiterBytesInPayload: true });
    expect(frame.length).toBe(payload.length + 3);
  });

  it("warning has a message string", () => {
    const payload = Buffer.from([0x0b]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(typeof onWarning.mock.calls[0]?.[0].message).toBe("string");
  });

  it("warning has a timestamp Date", () => {
    const payload = Buffer.from([0x1c]);
    const onWarning = vi.fn<(w: MllpWarning) => void>();
    encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning });
    expect(onWarning.mock.calls[0]?.[0].timestamp).toBeInstanceOf(Date);
  });
});
