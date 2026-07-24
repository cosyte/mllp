import { describe, it, expect } from "vitest";
import { MllpFramingError } from "../../src/framing/error.js";

describe("MllpFramingError", () => {
  it("is an instance of Error", () => {
    const err = new MllpFramingError("MLLP_FRAME_TOO_LARGE", 100, Buffer.alloc(0));
    expect(err).toBeInstanceOf(Error);
  });

  it("has name MllpFramingError", () => {
    const err = new MllpFramingError("MLLP_FRAME_TOO_LARGE", 100, Buffer.alloc(0));
    expect(err.name).toBe("MllpFramingError");
  });

  it("carries code and byteOffset", () => {
    const err = new MllpFramingError("MLLP_PAYLOAD_CONTAINS_VT", 55, Buffer.alloc(0));
    expect(err.code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
    expect(err.byteOffset).toBe(55);
  });

  it("message contains code by default", () => {
    const err = new MllpFramingError("MLLP_EMPTY_PAYLOAD", 0, Buffer.alloc(0));
    expect(err.message).toContain("MLLP_EMPTY_PAYLOAD");
  });

  it("accepts custom message override", () => {
    const err = new MllpFramingError("MLLP_EMPTY_PAYLOAD", 0, Buffer.alloc(0), "custom msg");
    expect(err.message).toBe("custom msg");
  });

  it("snippet is a Buffer", () => {
    const err = new MllpFramingError("MLLP_FRAME_TOO_LARGE", 0, Buffer.from([1, 2, 3]));
    expect(Buffer.isBuffer(err.snippet)).toBe(true);
  });

  it("snippet is a COPY, mutating source does not change snippet", () => {
    const source = Buffer.from([0x0b, 0x41, 0x1c, 0x0d]);
    const err = new MllpFramingError("MLLP_PAYLOAD_CONTAINS_VT", 1, source);
    source[0] = 0xff;
    expect(err.snippet[0]).toBe(0x0b);
  });

  it("snippet is capped at 64 bytes when source is larger", () => {
    const bigSource = Buffer.alloc(100, 0xaa);
    const err = new MllpFramingError("MLLP_FRAME_TOO_LARGE", 0, bigSource);
    expect(err.snippet.length).toBe(64);
  });

  it("snippet preserves bytes up to 64", () => {
    const source = Buffer.from([10, 20, 30]);
    const err = new MllpFramingError("MLLP_TRAILING_BYTES", 0, source);
    expect(err.snippet).toEqual(Buffer.from([10, 20, 30]));
  });
});
