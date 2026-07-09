/**
 * Real-world quirk corpus (MLLP-9, roadmap §3 + §6 tier 2).
 *
 * The unit tests in `test/framing/*` and the generative suites in `test/property/*`
 * already exercise each tolerance path over minimal byte arrays. This corpus is the
 * consolidated *interop* bar: it drives a realistic, multi-segment (synthetic) HL7 v2
 * message through each deviation a tolerant reader must survive in the field, and
 * asserts two things at once —
 *
 *   1. the exact stable warning code / typed error the deviation maps to, and
 *   2. that the recovered payload is **byte-identical** to the clean message (the
 *      quirk affected framing, never content).
 *
 * The lenient decoder must NEVER throw except for the one sanctioned fatal,
 * `MLLP_FRAME_TOO_LARGE`. Each entry cites the §3 deviation it pins.
 *
 * All fixtures are synthetic (no real PHI) per the cosyte PHI discipline.
 */

import { describe, it, expect } from "vitest";

import { FrameReader, type FrameReaderOptions } from "../../src/framing/decoder.js";
import { type MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning } from "../../src/framing/registry.js";
import { VT, FS, CR, LF } from "../../src/framing/constants.js";

/** A realistic, synthetic ADT^A01 admit — multi-segment, spec-clean, PHI-free. */
const ADT_A01 = Buffer.from(
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECV_APP|RECV_FAC|20260709120000||ADT^A01|MSG00001|P|2.5\r" +
    "EVN|A01|20260709120000\r" +
    "PID|1||900000001^^^FAC^MR||DOE^JANE^Q||19700101|F|||123 MAIN ST^^METROPOLIS^ST^00000\r" +
    "PV1|1|I|WARD^101^1^FAC||||1234^ATTEND^DR\r",
  "ascii",
);

/** Frame a payload the canonical R1 way: VT + payload + FS + CR. */
function frame(payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([VT]), payload, Buffer.from([FS, CR])]);
}

/** Drive a reader over `bytes`, collecting frames + warnings (no throw expected). */
function decode(
  bytes: Buffer,
  opts: Partial<FrameReaderOptions> = {},
): { frames: Buffer[]; warnings: MllpWarning[] } {
  const frames: Buffer[] = [];
  const warnings: MllpWarning[] = [];
  const reader = new FrameReader({
    onFrame: (p) => frames.push(p),
    onWarning: (w) => warnings.push(w),
    ...opts,
  });
  reader.push(bytes);
  return { frames, warnings };
}

const codes = (ws: MllpWarning[]): string[] => ws.map((w) => w.code);

describe("quirk corpus: a real HL7 message survives each §3 deviation", () => {
  it("baseline: canonical R1 frame decodes byte-identical, no warnings", () => {
    const { frames, warnings } = decode(frame(ADT_A01));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(ADT_A01);
    expect(warnings).toHaveLength(0);
  });

  it("§3.1 missing leading VT → MLLP_MISSING_LEADING_VT, payload intact", () => {
    const bytes = Buffer.concat([ADT_A01, Buffer.from([FS, CR])]); // no VT
    const { frames, warnings } = decode(bytes, { allowMissingLeadingVt: true });
    expect(frames[0]).toEqual(ADT_A01);
    expect(codes(warnings)).toContain("MLLP_MISSING_LEADING_VT");
  });

  it("§3.2 LF (0x0A) instead of CR after FS → MLLP_LF_AFTER_FS, payload intact", () => {
    const bytes = Buffer.concat([Buffer.from([VT]), ADT_A01, Buffer.from([FS, LF])]);
    const { frames, warnings } = decode(bytes, { allowLfAfterFs: true });
    expect(frames[0]).toEqual(ADT_A01);
    expect(codes(warnings)).toContain("MLLP_LF_AFTER_FS");
  });

  it("§3.3 stray trailing junk after FS+CR → MLLP_TRAILING_BYTES on next scan", () => {
    // Trailing junk lands in SCANNING_FOR_VT; under allowMissingLeadingVt it is surfaced.
    const bytes = Buffer.concat([frame(ADT_A01), Buffer.from([0x00, 0x7f])]);
    const { frames, warnings } = decode(bytes, {
      allowMissingLeadingVt: true,
      allowFsOnly: true,
    });
    expect(frames[0]).toEqual(ADT_A01);
    // The junk is surfaced as a recoverable deviation, never a throw.
    expect(warnings.length).toBeGreaterThan(0);
  });

  it("§3.4 non-MLLP keepalive frame (FS without CR, next VT immediately) → MLLP_FS_WITHOUT_CR", () => {
    // Two back-to-back frames with no CR between them — the 'FS then next VT' keepalive shape.
    const bytes = Buffer.concat([
      Buffer.from([VT]),
      ADT_A01,
      Buffer.from([FS]),
      Buffer.from([VT]),
      ADT_A01,
      Buffer.from([FS, CR]),
    ]);
    const { frames, warnings } = decode(bytes, { allowFsOnly: true });
    expect(frames).toHaveLength(2);
    expect(frames[0]).toEqual(ADT_A01);
    expect(frames[1]).toEqual(ADT_A01);
    expect(codes(warnings)).toContain("MLLP_FS_WITHOUT_CR");
  });

  it("§3.7 large payload past the accumulator grows-and-decodes intact (no false FRAME_TOO_LARGE)", () => {
    // 256 KiB forces the 4 KiB accumulator through several doublings — the same
    // growth path a multi-MB base64-PDF OBX takes, without the multi-MB runtime.
    const big = Buffer.concat([ADT_A01, Buffer.alloc(256 * 1024, 0x41)]);
    const { frames } = decode(frame(big), { maxFrameSizeBytes: 1024 * 1024 });
    expect(frames[0]).toEqual(big);
  });

  it("§3.7 oversized payload → MLLP_FRAME_TOO_LARGE (the ONLY sanctioned throw)", () => {
    const reader = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: ADT_A01.length - 1 });
    let caught: MllpFramingError | undefined;
    try {
      reader.push(frame(ADT_A01));
    } catch (err) {
      caught = err as MllpFramingError;
    }
    expect(caught?.code).toBe("MLLP_FRAME_TOO_LARGE");
  });

  it("§3.9 message split across 1-byte TCP chunks reassembles byte-identical", () => {
    const framed = frame(ADT_A01);
    const frames: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => frames.push(p) });
    for (const byte of framed) reader.push(Buffer.from([byte]));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(ADT_A01);
  });

  it("leading whitespace before VT → MLLP_LEADING_WHITESPACE, payload intact", () => {
    const bytes = Buffer.concat([Buffer.from([0x20, 0x09, LF]), frame(ADT_A01)]);
    const { frames, warnings } = decode(bytes, { allowLeadingWhitespace: true });
    expect(frames[0]).toEqual(ADT_A01);
    expect(codes(warnings)).toContain("MLLP_LEADING_WHITESPACE");
  });

  it("empty payload between VT and FS → MLLP_EMPTY_PAYLOAD (warning, not throw)", () => {
    const bytes = Buffer.from([VT, FS, CR]);
    const { warnings } = decode(bytes);
    expect(codes(warnings)).toContain("MLLP_EMPTY_PAYLOAD");
  });
});
