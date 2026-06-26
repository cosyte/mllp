/**
 * Property tests for the Postel's-Law DECODE side: the `FrameReader` is liberal in
 * what it accepts. With its tolerance opt-ins enabled, feeding malformed-but-
 * recoverable frames must NEVER throw — every deviation is recovered into a
 * warning — except for the one sanctioned fatal `MLLP_FRAME_TOO_LARGE` (FRAME-11
 * DoS guard), which throws even under full tolerance.
 *
 * This is the generative analogue of `test/framing/decoder.test.ts` and
 * `test/framing/strict-mode.test.ts`. Invariants on the warnings themselves:
 *   - every `warning.code` is a member of the 11-code public registry (no ad-hoc
 *     codes leak — `MLLP_WARNING_CODES`);
 *   - every warning carries byte-offset context (`byteOffset` is a finite number).
 *
 * Wiring to the `@cosyte/test-utils` `lenientNeverThrowsProperty` runner:
 *   - `parse`        — drive a tolerant `FrameReader` over the bytes; collect
 *                      emitted warnings; return `{ warnings }`.
 *   - `isFatal`      — `err instanceof MllpFramingError && err.code === 'MLLP_FRAME_TOO_LARGE'`
 *                      (the only code the decoder may throw under full tolerance).
 *   - `getWarnings`  — the collected `MllpWarning[]` (mapped to `{ code, position }`).
 *   - `isKnownCode`  — membership in the 11-code registry.
 *   - `hasPositionalContext` — `byteOffset` is a finite number.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { lenientNeverThrowsProperty, type LenientWarning } from "@cosyte/test-utils";

import { FrameReader, type FrameReaderOptions } from "../../src/framing/decoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning, WarningCode } from "../../src/framing/registry.js";

import { malformedFrame, hostileBytesOrChunks, type MalformedFrame } from "./_arbitraries.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 600;

/**
 * The 11 stable public MLLP warning codes (the registry the decoder may emit).
 *
 * `WarningCode` is a compile-time union with no runtime value, so this array is
 * the runtime mirror. The `satisfies` clause makes a desync a TYPE error: drop or
 * rename a code in the union and this array stops satisfying `readonly WarningCode[]`.
 */
export const MLLP_WARNING_CODES = [
  "MLLP_MISSING_LEADING_VT",
  "MLLP_FS_WITHOUT_CR",
  "MLLP_LF_AFTER_FS",
  "MLLP_LEADING_WHITESPACE",
  "MLLP_TRAILING_BYTES",
  "MLLP_PAYLOAD_CONTAINS_VT",
  "MLLP_PAYLOAD_CONTAINS_FS",
  "MLLP_EMPTY_PAYLOAD",
  "MLLP_FRAME_TOO_LARGE",
  "MLLP_ACK_UNMATCHED_CONTROL_ID",
  "MLLP_ACK_AFTER_TIMEOUT",
] as const satisfies readonly WarningCode[];

/** The set of known codes, for O(1) membership checks. */
const KNOWN_CODES: ReadonlySet<string> = new Set(MLLP_WARNING_CODES);

/** All decoder tolerance opt-ins on — the "maximally liberal receiver" posture. */
const ALL_TOLERANCES = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowMissingLeadingVt: true,
  allowLeadingWhitespace: true,
} as const;

/** The single fatal code the decoder may throw even under full tolerance. */
const SANCTIONED_FATAL: WarningCode = "MLLP_FRAME_TOO_LARGE";

/**
 * Drive a maximally-tolerant `FrameReader` over `bytes` and return every warning
 * it emitted. Frames themselves are discarded — the lenient invariant only cares
 * that nothing throws (bar the sanctioned fatal) and that warnings are well-formed.
 */
function parseTolerant(bytes: Buffer, maxFrameSizeBytes?: number): { warnings: MllpWarning[] } {
  const warnings: MllpWarning[] = [];
  const opts: FrameReaderOptions = {
    ...ALL_TOLERANCES,
    onFrame: (_payload, _offset, frameWarnings) => {
      // onFrame also surfaces per-frame warnings; fold them in so the registered-
      // code + position checks cover both delivery paths.
      warnings.push(...frameWarnings);
    },
    onWarning: (w) => {
      warnings.push(w);
    },
    ...(maxFrameSizeBytes !== undefined ? { maxFrameSizeBytes } : {}),
  };
  const reader = new FrameReader(opts);
  reader.push(bytes);
  return { warnings };
}

/** Map an `MllpWarning` into the runner's minimal `{ code, position }` shape. */
function toLenientWarnings(parsed: unknown): readonly LenientWarning[] {
  const { warnings } = parsed as { warnings: MllpWarning[] };
  return warnings.map((w) => ({ code: w.code, position: { byteOffset: w.byteOffset } }));
}

/** `byteOffset` is the decoder's positional context — assert it is a finite number. */
function hasByteOffset(w: LenientWarning): boolean {
  const pos = w.position as { byteOffset?: unknown } | undefined;
  return pos !== undefined && typeof pos.byteOffset === "number" && Number.isFinite(pos.byteOffset);
}

describe("property: lenient decoder never throws except the sanctioned fatal", () => {
  it("every malformed-but-recoverable frame recovers into warnings (or throws only MLLP_FRAME_TOO_LARGE)", () => {
    lenientNeverThrowsProperty<MalformedFrame>({
      arbitrary: malformedFrame(),
      parse: (mf) => parseTolerant(mf.bytes, mf.maxFrameSizeBytes),
      isFatal: (err) => err instanceof MllpFramingError && err.code === SANCTIONED_FATAL,
      getWarnings: toLenientWarnings,
      isKnownCode: (code) => KNOWN_CODES.has(code),
      hasPositionalContext: hasByteOffset,
      numRuns: NUM_RUNS,
    });
  });

  it("the oversized fatal carries the sanctioned code + byte-offset + isolated snippet", () => {
    // Pin the exact fatal shape the lenient invariant tolerates, so `isFatal`
    // can never silently start sanctioning the wrong throw.
    let thrown: unknown;
    try {
      const payload = Buffer.alloc(40, 0x41);
      parseTolerant(Buffer.from([0x0b, ...payload, 0x1c, 0x0d]), 8);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(MllpFramingError);
    const fe = thrown as MllpFramingError;
    expect(fe.code).toBe(SANCTIONED_FATAL);
    expect(typeof fe.byteOffset).toBe("number");
    expect(Buffer.isBuffer(fe.snippet)).toBe(true);
    expect(fe.snippet.length).toBeLessThanOrEqual(64);
  });

  it("each tolerance kind emits at least its expected warning code", () => {
    // Spot-check that the recovery paths are actually firing (a generator that
    // produced only no-op inputs would pass the lenient invariant vacuously).
    const expectedByKind: Record<MalformedFrame["kind"], WarningCode | null> = {
      "missing-leading-vt": "MLLP_MISSING_LEADING_VT",
      "fs-without-cr": "MLLP_FS_WITHOUT_CR",
      "lf-after-fs": "MLLP_LF_AFTER_FS",
      "leading-whitespace": "MLLP_LEADING_WHITESPACE",
      "trailing-bytes": "MLLP_TRAILING_BYTES",
      "empty-payload": "MLLP_EMPTY_PAYLOAD",
      "frame-too-large": null, // throws instead of warning
    };
    fc.assert(
      fc.property(malformedFrame(), (mf) => {
        const expected = expectedByKind[mf.kind];
        if (expected === null) return; // fatal path covered above
        const { warnings } = parseTolerant(mf.bytes, mf.maxFrameSizeBytes);
        expect(warnings.some((w) => w.code === expected)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe("property: lenient decoder vs hostile byte noise", () => {
  it("arbitrary random bytes (and chunk-splits) never throw a non-sanctioned error", () => {
    // The decoder under full tolerance must treat ANY byte stream as recoverable:
    // every deviation is a warning, the only legal throw is MLLP_FRAME_TOO_LARGE
    // (which random <=512-byte noise under the default 16 MB cap cannot reach).
    lenientNeverThrowsProperty<Buffer[]>({
      arbitrary: hostileBytesOrChunks(),
      parse: (chunks) => {
        const warnings: MllpWarning[] = [];
        const reader = new FrameReader({
          ...ALL_TOLERANCES,
          onFrame: (_p, _o, fw) => warnings.push(...fw),
          onWarning: (w) => warnings.push(w),
        });
        for (const chunk of chunks) reader.push(chunk);
        return { warnings };
      },
      isFatal: (err) => err instanceof MllpFramingError && err.code === SANCTIONED_FATAL,
      getWarnings: toLenientWarnings,
      isKnownCode: (code) => KNOWN_CODES.has(code),
      hasPositionalContext: hasByteOffset,
      numRuns: NUM_RUNS,
    });
  });
});
