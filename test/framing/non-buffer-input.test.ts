/**
 * A JavaScript caller that hands the decoder or the encoder something other than a Buffer gets
 * what it always got.
 *
 * Both now search a byte array natively for the framing bytes. TypeScript says `Buffer`, but a
 * JavaScript caller can pass anything, and an array of numbers or a string is read one element
 * at a time, as every input was before the native search. Every byte here is synthetic.
 */

import { describe, expect, it } from "vitest";

import { FrameReader, MllpFramingError, encodeFrame } from "../../src/framing/index.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

describe("FrameReader.push with an array of numbers", () => {
  it("decodes it as the bytes it holds", () => {
    const got: string[] = [];
    const reader = new FrameReader({
      onFrame: (p, offset) => got.push(`${String(offset)}:${p.toString("latin1")}`),
    });
    reader.push([VT, 0x41, 0x42, FS, CR, VT, 0x43, FS, CR] as unknown as Buffer);
    expect(got).toEqual(["0:AB", "5:C"]);
  });

  it("decodes a frame longer than the decoder's 4 KiB block", () => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => got.push(p) });
    const body = Array.from({ length: 9000 }, (_, k) => 0x41 + (k % 26));
    reader.push([VT, ...body, FS, CR] as unknown as Buffer);
    expect(got).toHaveLength(1);
    expect((got[0] as Buffer).equals(Buffer.from(body))).toBe(true);
  });

  it("refuses a non-VT first byte at its offset", () => {
    const reader = new FrameReader({ onFrame: () => undefined });
    expect(() => reader.push([0x41] as unknown as Buffer)).toThrow(MllpFramingError);
  });
});

describe("encodeFrame with an array of numbers", () => {
  it("refuses a VT at its offset, as the byte scan did", () => {
    try {
      encodeFrame([0x41, VT] as unknown as Buffer);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(MllpFramingError);
      expect((err as MllpFramingError).code).toBe("MLLP_PAYLOAD_CONTAINS_VT");
      expect((err as MllpFramingError).byteOffset).toBe(1);
    }
  });

  it("warns for an FS under the tolerance, then fails to copy what is not a Buffer", () => {
    const codes: string[] = [];
    expect(() =>
      encodeFrame([FS, 0x41] as unknown as Buffer, {
        allowDelimiterBytesInPayload: true,
        onWarning: (w) => codes.push(w.code),
      }),
    ).toThrow(TypeError);
    expect(codes).toEqual(["MLLP_PAYLOAD_CONTAINS_FS"]);
  });

  it("passes a VT under the tolerance with no handler, then fails to copy", () => {
    expect(() =>
      encodeFrame([VT] as unknown as Buffer, { allowDelimiterBytesInPayload: true }),
    ).toThrow(TypeError);
  });

  it("reads a string as characters, which are never framing bytes", () => {
    expect(() => encodeFrame("\u000b" as unknown as Buffer)).toThrow(TypeError);
  });
});
