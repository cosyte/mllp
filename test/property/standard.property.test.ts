/**
 * The three properties every Cosyte parser proves, run on the generators this package exports at
 * `@cosyte/mllp/arbitraries`. MLLP's inputs are frames and byte streams, so:
 *
 * 1. **Round trip.** Serialize is `encodeFrame`, parse is a `FrameReader`. For any payload `p` the
 *    encoder accepts, reading `encodeFrame(p)` delivers exactly one frame, and it equals `p` byte
 *    for byte (`Buffer.equals`: same length, same bytes), at offset 0, with no warning; encoding
 *    the delivered payload again gives the same frame bytes. For a stream of frames split into any
 *    chunks, the reader delivers the same payloads in the same order, each at its `VT`'s offset,
 *    and re-encoding them gives the stream's bytes. Equality is on bytes only: a payload is not
 *    decoded as text anywhere here.
 * 2. **Idempotent normalize.** The library's normalizers are the lenient reader followed by the
 *    encoder (`normalize(stream)` is the canonical frames of the payloads a reader with every
 *    tolerance on delivers before it stops, at the end or at a frame it refuses), and the
 *    segment-terminator trim applied to a payload before its `MSH` is read. Normalizing twice
 *    gives what normalizing once gave, a canonical stream is its own normal form, and a messy
 *    stream normalizes to the canonical frames of its payloads.
 * 3. **Never throws in lenient mode, but for the refusals no tolerance turns off.** A
 *    `FrameReader` with every tolerance on, fed any bytes in any chunks, throws nothing but
 *    `MLLP_FRAME_TOO_LARGE` and the refusal of a frame whose end cannot be told, a `VT` or a bare
 *    `FS` inside it (`MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`); every warning carries
 *    a registered code and an offset inside the stream; no payload it delivers holds a `VT` or an
 *    `FS`; and how the bytes were split changes nothing it reports, the refusal included. The
 *    encoder with `allowDelimiterBytesInPayload` never throws either.
 *
 * Each runs 100 cases by default from a fresh seed; `COSYTE_PROPERTY_RUNS` sets the depth, and a
 * failure prints the seed and path that replay it (see `./_runner.ts`).
 */

import assert from "node:assert/strict";

import fc from "fast-check";
import { describe, it } from "vitest";

import { FrameReader, type FrameReaderOptions } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning, WarningCode } from "../../src/framing/registry.js";
import { stripLeadingSegmentTerminators } from "../../src/internal/control-id.js";
import { frame, hostileInput, messyStream, payload, stream } from "../../src/arbitraries/index.js";

import { assertProperty, propertyTimeout } from "./_runner.js";

/** Each test's budget, scaled to the depth `COSYTE_PROPERTY_RUNS` sets. */
const TIMEOUT = propertyTimeout();

const VT = 0x0b;
const FS = 0x1c;

/** Every registered warning code. A `Record` over the union fails to compile if one is missed. */
const REGISTERED: Readonly<Record<WarningCode, true>> = {
  MLLP_MISSING_LEADING_VT: true,
  MLLP_FS_WITHOUT_CR: true,
  MLLP_LF_AFTER_FS: true,
  MLLP_LEADING_WHITESPACE: true,
  MLLP_TRAILING_BYTES: true,
  MLLP_PAYLOAD_CONTAINS_VT: true,
  MLLP_PAYLOAD_CONTAINS_FS: true,
  MLLP_EMPTY_PAYLOAD: true,
  MLLP_FRAME_TOO_LARGE: true,
  MLLP_ACK_UNMATCHED_CONTROL_ID: true,
  MLLP_ACK_AFTER_TIMEOUT: true,
};
const KNOWN: ReadonlySet<string> = new Set(Object.keys(REGISTERED));

/** Every tolerance on: the lenient reader. */
const LENIENT = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowMissingLeadingVt: true,
  allowLeadingWhitespace: true,
} as const;

/** One delivered frame: its payload, the offset of its first byte, and its warnings' codes. */
interface Delivered {
  readonly payload: Buffer;
  readonly offset: number;
  readonly codes: readonly WarningCode[];
}

/** What a reader reported for a stream: its frames, its warnings, and the error it threw, if any. */
interface Decoded {
  readonly frames: Delivered[];
  readonly warnings: MllpWarning[];
  readonly error?: MllpFramingError;
}

/** Feed chunks to a new reader. A framing error ends the read and is returned; anything else escapes. */
function decode(
  chunks: readonly Buffer[],
  options: Omit<FrameReaderOptions, "onFrame" | "onWarning"> = {},
): Decoded {
  const frames: Delivered[] = [];
  const warnings: MllpWarning[] = [];
  const reader = new FrameReader({
    ...options,
    onFrame: (p, offset, frameWarnings) => {
      frames.push({ payload: p, offset, codes: frameWarnings.map((w) => w.code) });
    },
    onWarning: (w) => warnings.push(w),
  });
  try {
    for (const chunk of chunks) reader.push(chunk);
  } catch (err) {
    if (err instanceof MllpFramingError) return { frames, warnings, error: err };
    throw err;
  }
  return { frames, warnings };
}

/** The codes a lenient reader may throw: the oversized frame, and a frame refused whole. */
const REFUSALS: ReadonlySet<string> = new Set<WarningCode>([
  "MLLP_FRAME_TOO_LARGE",
  "MLLP_PAYLOAD_CONTAINS_VT",
  "MLLP_PAYLOAD_CONTAINS_FS",
]);

/**
 * The normalizer: the canonical frames of what a lenient reader delivers before it stops, at the
 * end of the bytes or at a frame it refuses whole.
 */
function normalize(chunks: readonly Buffer[]): Buffer {
  const { frames, error } = decode(chunks, LENIENT);
  if (error !== undefined) {
    assert.ok(REFUSALS.has(error.code), `the lenient reader threw ${error.code}`);
  }
  return Buffer.concat(frames.map((f) => encodeFrame(f.payload)));
}

/** A comparable summary of what a reader reported: payload bytes as hex, offsets, codes, error. */
function summary(decoded: Decoded): unknown {
  return {
    frames: decoded.frames.map((f) => [f.payload.toString("hex"), f.offset, f.codes]),
    warnings: decoded.warnings.map((w) => [w.code, w.byteOffset, w.message]),
    error:
      decoded.error === undefined
        ? undefined
        : [decoded.error.code, decoded.error.byteOffset, decoded.error.message],
  };
}

/** Split bytes at the given places, each taken modulo the length; the pieces concatenate back. */
function splitAt(bytes: Buffer, at: readonly number[]): Buffer[] {
  const cuts = at.map((n) => n % (bytes.length + 1)).sort((a, b) => a - b);
  return [0, ...cuts].map((start, i) => bytes.subarray(start, cuts[i] ?? bytes.length));
}

/** Payloads of every content kind. */
const anyPayload = fc.oneof(payload(), payload({ content: "text" }), payload({ content: "hl7" }));

describe("round trip: decode(encode(x)) is x, byte for byte", () => {
  it(
    "a payload comes back alone, exactly, with no warning, and encodes to the same frame again",
    () => {
      assertProperty(
        "payload round trip",
        fc.property(anyPayload, (p) => {
          const wire = encodeFrame(p);
          const { frames, warnings, error } = decode([wire]);
          assert.equal(error, undefined);
          assert.equal(frames.length, 1);
          const [only] = frames;
          assert.ok(only !== undefined);
          assert.ok(only.payload.equals(p), "the payload changed");
          assert.equal(only.offset, 0);
          assert.deepEqual(warnings, []);
          assert.ok(encodeFrame(only.payload).equals(wire), "encoding again changed the frame");
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "a generated frame is the encoder's frame of its payload, and reads back to that payload",
    () => {
      assertProperty(
        "frame round trip",
        fc.property(frame(), (f) => {
          assert.ok(encodeFrame(f.payload).equals(f.bytes), "the encoder disagrees with the spec");
          const { frames, warnings } = decode([f.bytes]);
          assert.equal(frames.length, 1);
          assert.ok(frames[0]?.payload.equals(f.payload));
          assert.deepEqual(warnings, []);
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "a stream in any chunks gives its payloads in order, each at its VT, and re-encodes to its bytes",
    () => {
      assertProperty(
        "stream round trip",
        fc.property(fc.oneof(stream(), stream({ content: "hl7" })), (s) => {
          const { frames, warnings, error } = decode(s.chunks);
          assert.equal(error, undefined);
          assert.deepEqual(warnings, []);
          assert.deepEqual(
            frames.map((f) => f.payload.toString("hex")),
            s.payloads.map((p) => p.toString("hex")),
          );
          let offset = 0;
          for (const [i, f] of frames.entries()) {
            assert.equal(f.offset, offset, `frame ${i} is not at its VT`);
            offset += f.payload.length + 3;
          }
          assert.ok(Buffer.concat(frames.map((f) => encodeFrame(f.payload))).equals(s.bytes));
        }),
      );
    },
    TIMEOUT,
  );
});

describe("idempotent normalize: normalizing twice gives what normalizing once gave", () => {
  it(
    "a canonical stream is its own normal form",
    () => {
      assertProperty(
        "canonical stream is normal",
        fc.property(stream(), (s) => {
          assert.ok(normalize(s.chunks).equals(s.bytes));
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "a messy stream normalizes to the canonical frames of its payloads, and stays there",
    () => {
      assertProperty(
        "messy stream normalize",
        fc.property(messyStream(), (s) => {
          const once = normalize(s.chunks);
          assert.ok(once.equals(Buffer.concat(s.payloads.map((p) => encodeFrame(p)))));
          assert.ok(normalize([once]).equals(once));
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "hostile input normalizes once and for all, however the normal form is split",
    () => {
      assertProperty(
        "hostile normalize",
        fc.property(hostileInput(), fc.array(fc.nat(), { maxLength: 8 }), (chunks, at) => {
          const once = normalize(chunks);
          assert.ok(normalize(splitAt(once, at)).equals(once));
        }),
      );
    },
    TIMEOUT,
  );

  it(
    "trimming a payload's leading segment terminators twice trims what once did",
    () => {
      assertProperty(
        "segment terminator trim",
        fc.property(
          fc.oneof(
            anyPayload,
            hostileInput().map((chunks) => Buffer.concat(chunks)),
          ),
          (p) => {
            const once = stripLeadingSegmentTerminators(p);
            assert.ok(stripLeadingSegmentTerminators(once).equals(once));
          },
        ),
      );
    },
    TIMEOUT,
  );
});

describe("never throws in lenient mode", () => {
  it(
    "the lenient reader throws only its refusals, warns only registered codes inside the stream, and never delivers a VT or FS",
    () => {
      assertProperty(
        "lenient reader never throws",
        fc.property(
          hostileInput(),
          fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
          (chunks, cap) => {
            const total = chunks.reduce((n, c) => n + c.length, 0);
            const decoded = decode(chunks, {
              ...LENIENT,
              ...(cap === undefined ? {} : { maxFrameSizeBytes: cap }),
            });
            if (decoded.error !== undefined) {
              assert.ok(REFUSALS.has(decoded.error.code), `threw ${decoded.error.code}`);
              assert.ok(decoded.error.snippet.length <= 1, "a run of bytes in the snippet");
              if (decoded.error.code === "MLLP_FRAME_TOO_LARGE") {
                assert.notEqual(cap, undefined, "no cap was set, yet a frame was too large");
              }
            }
            for (const w of decoded.warnings) {
              assert.ok(KNOWN.has(w.code), `unregistered code ${w.code}`);
              assert.ok(Number.isInteger(w.byteOffset));
              assert.ok(w.byteOffset >= 0 && w.byteOffset < total, `offset ${w.byteOffset}`);
            }
            for (const f of decoded.frames) {
              assert.ok(!f.payload.includes(VT) && !f.payload.includes(FS), "a framing byte");
              if (cap !== undefined) assert.ok(f.payload.length <= cap);
            }
          },
        ),
      );
    },
    TIMEOUT,
  );

  it(
    "how the bytes are split changes nothing the reader reports, its error included",
    () => {
      assertProperty(
        "chunk split invariance",
        fc.property(
          hostileInput(),
          fc.option(fc.integer({ min: 0, max: 64 }), { nil: undefined }),
          (chunks, cap) => {
            const options = {
              ...LENIENT,
              ...(cap === undefined ? {} : { maxFrameSizeBytes: cap }),
            };
            const whole = decode([Buffer.concat(chunks)], options);
            assert.deepEqual(summary(decode(chunks, options)), summary(whole));
          },
        ),
      );
    },
    TIMEOUT,
  );

  it(
    "a frame with a VT or a bare FS inside it is refused whole, however the stream is split",
    () => {
      const CR = 0x0d;
      const LF = 0x0a;
      // Server defaults, and every tolerance on: a stray framing byte is refused on both.
      const readers = fc.constantFrom<Omit<FrameReaderOptions, "onFrame" | "onWarning">>(
        { allowFsOnly: true, allowLfAfterFs: true, allowLeadingWhitespace: true },
        LENIENT,
      );
      // `b` opens on neither CR nor LF, which after an FS would end the frame properly.
      const second = anyPayload.filter((b) => b[0] !== CR && b[0] !== LF);
      assertProperty(
        "stray framing byte refused whole",
        fc.property(
          stream({ minFrames: 0, maxFrames: 3 }),
          fc.constantFrom(VT, FS),
          anyPayload,
          second,
          readers,
          fc.array(fc.nat(), { maxLength: 8 }),
          (before, delimiter, a, b, options, at) => {
            const joined = Buffer.concat([
              Buffer.from([VT]),
              a,
              Buffer.from([delimiter]),
              b,
              Buffer.from([FS, CR]),
            ]);
            const bytes = Buffer.concat([before.bytes, joined]);
            const decoded = decode(splitAt(bytes, at), options);
            // Every frame before the joined one is delivered, exactly, and nothing of it.
            assert.deepEqual(
              decoded.frames.map((f) => f.payload.toString("hex")),
              before.payloads.map((p) => p.toString("hex")),
            );
            assert.ok(decoded.error !== undefined, "nothing was refused");
            assert.equal(
              decoded.error.code,
              delimiter === VT ? "MLLP_PAYLOAD_CONTAINS_VT" : "MLLP_PAYLOAD_CONTAINS_FS",
            );
            assert.equal(decoded.error.byteOffset, before.bytes.length + 1 + a.length);
            assert.ok(decoded.error.snippet.equals(Buffer.from([delimiter])));
            // The same report whole as in pieces, the refusal included.
            assert.deepEqual(summary(decoded), summary(decode([bytes], options)));
          },
        ),
      );
    },
    TIMEOUT,
  );

  it(
    "a messy stream reads back to exactly its payloads and warnings, on a reader with its tolerances",
    () => {
      const tolerances = fc.record({
        allowFsOnly: fc.boolean(),
        allowLfAfterFs: fc.boolean(),
        allowMissingLeadingVt: fc.boolean(),
        allowLeadingWhitespace: fc.boolean(),
      });
      assertProperty(
        "messy stream reads back",
        fc.property(
          tolerances.chain((t) => messyStream(t).map((s) => ({ t, s }))),
          ({ t, s }) => {
            const { frames, error } = decode(s.chunks, t);
            assert.equal(error, undefined);
            assert.deepEqual(
              frames.map((f) => [f.payload.toString("hex"), f.codes]),
              s.payloads.map((p, i) => [p.toString("hex"), s.warnings[i]]),
            );
          },
        ),
      );
    },
    TIMEOUT,
  );

  it(
    "the encoder with allowDelimiterBytesInPayload wraps any bytes verbatim and warns once per VT or FS",
    () => {
      assertProperty(
        "lenient encoder never throws",
        fc.property(
          hostileInput().map((chunks) => Buffer.concat(chunks)),
          (bytes) => {
            const codes: string[] = [];
            const wire = encodeFrame(bytes, {
              allowDelimiterBytesInPayload: true,
              onWarning: (w) => codes.push(w.code),
            });
            assert.ok(wire.subarray(1, -2).equals(bytes));
            const delimiters = [...bytes].filter((b) => b === VT || b === FS).length;
            assert.equal(codes.length, delimiters);
          },
        ),
      );
    },
    TIMEOUT,
  );
});
