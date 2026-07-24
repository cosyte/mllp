/**
 * PHI-safety property tests (MLLP-9 observability audit).
 *
 * mllp transports raw HL7 v2 payloads, every byte of every payload is assumed to be
 * PHI. The framing layer's diagnostic surfaces (`MllpFramingError.snippet` /
 * `.message`, and every `MllpWarning.message`) are the places a payload byte could
 * escape into a log. The invariant this suite pins:
 *
 *   **No framing diagnostic ever carries a run of payload content bytes.**
 *
 * A framing error may name the single boundary byte that violated the structure (its
 * hex is already in the message), but it must never echo a *slice* of the accumulated
 * payload. The one place that used to break this was `MLLP_FRAME_TOO_LARGE`, which
 * copied the last 32 accumulated payload bytes into `snippet`, a field-body slice of
 * clinical content on a public error field (the too-large frame is a full HL7
 * message). That snippet is now empty; this suite is the regression that keeps it so.
 *
 * Mutation check: restore the old `snippet = accumulator.subarray(writePos-32, writePos)`
 * in `decoder.ts` and the `snippet` assertions below flip to red (the marker bytes
 * reappear in the snippet).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { buildAckAA, buildMllpAck } from "../../src/ack-from-hl7/index.js";
import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning } from "../../src/framing/registry.js";
import { VT, FS, CR, LF } from "../../src/framing/constants.js";

/**
 * A recognizable "PHI marker" run. Chosen to be pure payload content: no framing
 * bytes (VT/FS/CR/LF), so if it ever surfaces in a diagnostic it can only have come
 * from the payload accumulator, never from a framing-boundary byte.
 */
const MARKER = Buffer.from("SECRETPHI0000", "ascii");

/** Does `haystack` contain the marker run (or any ≥4-byte slice of it)? */
function leaksMarker(haystack: Buffer | string): boolean {
  const hay = typeof haystack === "string" ? Buffer.from(haystack, "utf8") : haystack;
  // Any 4-byte window of the marker appearing in the haystack is a payload-content leak.
  for (let i = 0; i + 4 <= MARKER.length; i++) {
    if (hay.includes(MARKER.subarray(i, i + 4))) return true;
  }
  return false;
}

/** Build a payload of `n` bytes made only of repeated MARKER content (no framing bytes). */
function markerPayload(n: number): Buffer {
  const out = Buffer.allocUnsafe(n);
  for (let i = 0; i < n; i++) out[i] = MARKER[i % MARKER.length] as number;
  return out;
}

describe("PHI-safety: MLLP_FRAME_TOO_LARGE never carries a payload slice (MLLP-9)", () => {
  it("the too-large snippet is empty and neither snippet nor message echoes payload content", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 64 }),
        fc.integer({ min: 1, max: 200 }),
        (cap, over) => {
          const payload = markerPayload(cap + over);
          const framed = Buffer.concat([Buffer.from([VT]), payload, Buffer.from([FS, CR])]);
          const reader = new FrameReader({ onFrame: () => {}, maxFrameSizeBytes: cap });

          let caught: MllpFramingError | undefined;
          try {
            reader.push(framed);
          } catch (err) {
            expect(err).toBeInstanceOf(MllpFramingError);
            caught = err as MllpFramingError;
          }

          expect(caught).toBeDefined();
          const fe = caught as MllpFramingError;
          expect(fe.code).toBe("MLLP_FRAME_TOO_LARGE");
          // The anomaly is the size, not a byte: snippet MUST be empty.
          expect(fe.snippet.length).toBe(0);
          // Belt-and-braces: no payload marker in either public string/byte surface.
          expect(leaksMarker(fe.snippet)).toBe(false);
          expect(leaksMarker(fe.message)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("PHI-safety: no framing throw echoes a payload content slice (MLLP-9)", () => {
  it("across strict/tolerant modes, snippet ≤ 1 byte and never a marker run", () => {
    fc.assert(
      fc.property(
        fc.constantFrom<"strict" | "default" | "tolerant">("strict", "default", "tolerant"),
        fc.integer({ min: 4, max: 80 }),
        (mode, len) => {
          const payload = markerPayload(len);
          // A frame missing its leading VT so a strict/default reader throws MISSING_LEADING_VT
          // on the first payload byte, and an FS-without-CR variant.
          const noVt = Buffer.concat([payload, Buffer.from([FS, CR])]);

          const opts =
            mode === "strict"
              ? { onFrame: () => {}, strict: true, allowMissingLeadingVt: true }
              : mode === "tolerant"
                ? { onFrame: () => {}, allowMissingLeadingVt: false }
                : { onFrame: () => {} };
          const reader = new FrameReader(opts);
          let caught: MllpFramingError | undefined;
          try {
            reader.push(noVt);
          } catch (err) {
            caught = err as MllpFramingError;
          }
          // A missing-VT payload MUST throw in every mode exercised here. Without this guard
          // the PHI assertions below would VACUOUSLY pass if a regression stopped throwing.
          expect(caught).toBeDefined();
          const fe = caught as MllpFramingError;
          // The load-bearing PHI invariant: the snippet is at most ONE byte (whose hex the
          // message already discloses), so it can never be a *run* of payload content. That
          // single byte may itself be a payload byte (the first byte seen where a VT was
          // expected), so the invariant is a length cap, not a "snippet is a delimiter" check,
          // and not `leaksMarker(snippet)`, which needs a ≥4-byte window and so can never fire
          // on a ≤1-byte snippet.
          expect(fe.snippet.length).toBeLessThanOrEqual(1);
          // The message is the one diagnostic surface long enough to leak a run, pin that it
          // never echoes marker content.
          expect(leaksMarker(fe.message)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("PHI-safety: the ENCODER's delimiter-byte throw never carries a payload slice (MLLP-9)", () => {
  it("encodeFrame's MLLP_PAYLOAD_CONTAINS_VT/FS snippet is ≤ 1 byte and never a marker run", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(VT, FS),
        fc.integer({ min: 8, max: 120 }),
        fc.integer({ min: 1, max: 6 }),
        (delimiter, len, whereFrac) => {
          // Embed a stray framing delimiter in the MIDDLE of a marker payload, so the
          // OLD `subarray(i-32, i+32)` snippet would have echoed surrounding content.
          const payload = markerPayload(len);
          const at = Math.min(len - 1, Math.floor((len * whereFrac) / 7));
          payload[at] = delimiter;

          let caught: MllpFramingError | undefined;
          try {
            // strict (default), a delimiter byte in the payload throws
            encodeFrame(payload);
          } catch (err) {
            expect(err).toBeInstanceOf(MllpFramingError);
            caught = err as MllpFramingError;
          }
          expect(caught).toBeDefined();
          const fe = caught as MllpFramingError;
          expect(["MLLP_PAYLOAD_CONTAINS_VT", "MLLP_PAYLOAD_CONTAINS_FS"]).toContain(fe.code);
          // At most the single offending delimiter byte, never a run of payload content.
          expect(fe.snippet.length).toBeLessThanOrEqual(1);
          expect(leaksMarker(fe.snippet)).toBe(false);
          expect(leaksMarker(fe.message)).toBe(false);
        },
      ),
      { numRuns: 300 },
    );
  });
});

describe("PHI-safety: warnings carry structural facts only, never a payload slice (MLLP-9)", () => {
  it("every tolerance-path warning message is free of payload content", () => {
    fc.assert(
      fc.property(fc.integer({ min: 4, max: 120 }), (len) => {
        const payload = markerPayload(len);
        const warnings: MllpWarning[] = [];
        // Maximally tolerant reader over a quirk-laden stream: leading whitespace,
        // missing VT, FS-without-CR, LF-after-FS, trailing junk, every warning path.
        const reader = new FrameReader({
          onFrame: () => {},
          onWarning: (w) => warnings.push(w),
          allowFsOnly: true,
          allowLfAfterFs: true,
          allowMissingLeadingVt: true,
          allowLeadingWhitespace: true,
        });
        const stream = Buffer.concat([
          Buffer.from([0x20, 0x20]), // leading whitespace
          payload, // missing-VT payload
          Buffer.from([FS, LF]), // LF after FS
          Buffer.from([VT]),
          payload,
          Buffer.from([FS]),
          Buffer.from([0x7e]), // stray trailing byte → TRAILING_BYTES
        ]);
        reader.push(stream);
        for (const w of warnings) {
          expect(leaksMarker(w.message)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("PHI-safety: the ACK builders' warnings carry no message content (MLLP-ACK-UTF8)", () => {
  /**
   * The leak this pins shut. `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` used to hex-encode the
   * inbound MSH-10 into its message, on the reasoning that a control ID is routing
   * metadata rather than clinical content. But the scanner that produced that "MSH-10"
   * ran past the segment terminator, so on a TRUNCATED MSH it actually returned PID-3,
   * the patient's MRN, and the warning rendered it into a log line. Both are fixed
   * (`readMshSegment` is bounded; the warning reports byte lengths only), and this is
   * the property that keeps them fixed: whatever the inbound, an ACK warning may not
   * echo any field of it.
   *
   * Every field below is a distinct marker, so a leak names the field it came from.
   */
  const MSH10 = "CTLZZZ1";
  const MRN = "MRNZZZ2";
  const NAME = "NAMZZZ3";
  const DOB = "19850312";

  /** An inbound whose MSH is truncated at `mshFields`, followed by a PID full of markers. */
  function inboundTruncatedAt(mshFields: number): Buffer {
    const all = [
      "MSH",
      "^~\\&",
      "EPIC",
      "HOSP",
      "MIRTH",
      "LAB",
      "20260714120000",
      "",
      "ADT^A01",
      MSH10,
      "P",
      "2.5.1",
    ];
    const msh = all.slice(0, mshFields).join("|");
    return Buffer.from(`${msh}\rPID|1||${MRN}||${NAME}^SYNTH||${DOB}|F\r`, "latin1");
  }

  const leaks = (text: string): boolean =>
    [MRN, NAME, DOB, MSH10].some((m) => text.includes(m)) ||
    [MRN, NAME, DOB, MSH10].some((m) => text.includes(Buffer.from(m, "latin1").toString("hex")));

  it("no ACK warning echoes any inbound field, at ANY MSH truncation point", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 12 }),
        fc.constantFrom<BufferEncoding>("latin1", "utf8", "ascii"),
        (mshFields, encoding) => {
          const inbound = inboundTruncatedAt(mshFields);
          // Sweep the encodings too: a lossy override is the other way to make the
          // verbatim check fire, and it must be just as quiet about the bytes.
          const ack = buildMllpAck(inbound, { code: "AA", encoding });
          for (const w of ack.warnings) {
            expect(leaks(w.message), `warning ${w.code} leaked a field`).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("no ACK PAYLOAD carries a field of any segment after the MSH", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 12 }), (mshFields) => {
        const inbound = inboundTruncatedAt(mshFields);
        const text = buildAckAA(inbound).payload.toString("latin1");
        // MSH-10 legitimately appears in MSA-2, that is the ACK's whole job. Nothing
        // from the PID may appear anywhere.
        for (const marker of [MRN, NAME, DOB]) {
          expect(text.includes(marker), `ACK payload leaked ${marker}`).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });
});
