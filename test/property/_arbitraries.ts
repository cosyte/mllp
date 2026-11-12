/**
 * Shared fast-check arbitraries for the `@cosyte/mllp` property-test layer.
 *
 * MLLP is a **byte transport**, not a text format, so every generator here works
 * in `Buffer`s. Three families live here:
 *
 * 1. **Payloads** ({@link payloadBuffer}, {@link delimiterFreePayload}), arbitrary
 *    byte buffers, including ones that embed the framing bytes `VT`/`FS`/`CR`. The
 *    round-trip invariant uses the delimiter-free variant (the encoder is strict and
 *    rejects `VT`/`FS` in a payload, see `encodeFrame`'s FRAME-02 guard), so a
 *    round-trip failure means a real codec bug rather than a sanctioned encoder throw.
 *
 * 2. **Well-formed frames** ({@link wellFormedFrame}), `encodeFrame(payload)` output,
 *    the canonical `VT + payload + FS + CR` shape the decoder must accept losslessly.
 *
 * 3. **Malformed frames** ({@link malformedFrame}, {@link hostileBytesOrChunks})
 *    one generator per tolerance path the decoder recovers from (missing leading VT,
 *    FS-without-CR, LF-after-FS, leading whitespace, empty payload), plus pure random byte
 *    noise and the frames no tolerance recovers: an oversized frame (`MLLP_FRAME_TOO_LARGE`)
 *    and a frame with a `VT` or a bare `FS` inside it, which the decoder refuses whole
 *    (`MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`). These drive the lenient + fuzz
 *    invariants.
 *
 * Nothing here is mllp-package-internal: these are exactly the format-specific
 * arbitraries the shared `@cosyte/test-utils` runners are designed to consume.
 */

import fc from "fast-check";

import { encodeFrame } from "../../src/framing/encoder.js";
import { VT, FS, CR, LF } from "../../src/framing/constants.js";

/**
 * An arbitrary payload `Buffer` of 0 to 256 bytes drawn from the full `0x00` to `0xFF`
 * range, so it may contain the framing bytes `VT` (0x0B), `FS` (0x1C), and `CR`
 * (0x0D). Used by the lenient/fuzz invariants where payload bytes are hostile.
 */
export function payloadBuffer(): fc.Arbitrary<Buffer> {
  return fc.uint8Array({ minLength: 0, maxLength: 256 }).map((bytes) => Buffer.from(bytes));
}

/**
 * An arbitrary **non-empty** payload `Buffer` whose bytes exclude `VT` (0x0B) and
 * `FS` (0x1C), the two bytes the strict encoder rejects (FRAME-02). This is the
 * payload family the round-trip invariant uses, so `encode(payload)` never throws
 * and `decode(encode(payload))` must recover the exact bytes.
 *
 * `CR` (0x0D) is intentionally retained, it is a legal payload byte and a good
 * round-trip stressor (the decoder must not confuse a payload `CR` with the
 * frame-terminating `FS CR`).
 */
export function delimiterFreePayload(): fc.Arbitrary<Buffer> {
  return fc
    .array(
      fc.integer({ min: 0, max: 0xff }).filter((b) => b !== VT && b !== FS),
      { minLength: 1, maxLength: 256 },
    )
    .map((bytes) => Buffer.from(bytes));
}

/**
 * A canonical well-formed frame: `encodeFrame(payload)` over a delimiter-free
 * payload, i.e. `VT + payload + FS + CR`. The decoder must accept every one of
 * these with zero warnings and recover the exact payload.
 */
export function wellFormedFrame(): fc.Arbitrary<{ payload: Buffer; frame: Buffer }> {
  return delimiterFreePayload().map((payload) => ({ payload, frame: encodeFrame(payload) }));
}

/** Bytes that are safe to use as raw payload filler in malformed frames (no VT/FS/CR). */
const SAFE_PAYLOAD_BYTE = fc
  .integer({ min: 0x20, max: 0x7e })
  .filter((b) => b !== VT && b !== FS && b !== CR);

/** A short run of safe payload bytes (1 to 32) for building hand-rolled frames. */
function safePayloadBytes(): fc.Arbitrary<number[]> {
  return fc.array(SAFE_PAYLOAD_BYTE, { minLength: 1, maxLength: 32 });
}

/**
 * One malformed frame, tagged with the tolerance path it exercises.
 *
 * Most variants are recoverable by a `FrameReader` with the matching tolerance
 * enabled (the lenient invariant runs with all tolerances on): the decoder must
 * emit a warning (or deliver the frame) rather than throw. Three are not, and throw
 * even under full tolerance, which the lenient runner's `isFatal` predicate
 * sanctions by code: `frame-too-large` (`MLLP_FRAME_TOO_LARGE`), and `vt-inside-frame`
 * and `fs-inside-frame`, two payloads joined by a `VT` or a bare `FS` inside one frame,
 * which the decoder refuses whole (`MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`).
 *
 * The `maxFrameSizeBytes` field, when present, tells the test harness to construct
 * the reader with that cap so the oversized payload trips the fatal deterministically.
 */
export interface MalformedFrame {
  readonly kind:
    | "missing-leading-vt"
    | "fs-without-cr"
    | "lf-after-fs"
    | "leading-whitespace"
    | "vt-inside-frame"
    | "fs-inside-frame"
    | "empty-payload"
    | "frame-too-large";
  readonly bytes: Buffer;
  /** When set, the reader must be built with this `maxFrameSizeBytes` cap. */
  readonly maxFrameSizeBytes?: number;
}

/** Missing leading VT: payload + FS + CR, with no opening VT (FRAME-09). */
function missingLeadingVt(): fc.Arbitrary<MalformedFrame> {
  return safePayloadBytes().map((p) => ({
    kind: "missing-leading-vt" as const,
    bytes: Buffer.from([...p, FS, CR]),
  }));
}

/** FS without CR: VT + payload + FS immediately followed by the next frame's VT (FRAME-07). */
function fsWithoutCr(): fc.Arbitrary<MalformedFrame> {
  return fc.tuple(safePayloadBytes(), safePayloadBytes()).map(([a, b]) => ({
    kind: "fs-without-cr" as const,
    // Frame A terminated by FS then (no CR) directly the next frame: VT + B + FS + CR
    bytes: Buffer.from([VT, ...a, FS, VT, ...b, FS, CR]),
  }));
}

/** LF after FS instead of CR: VT + payload + FS + LF (FRAME-08). */
function lfAfterFs(): fc.Arbitrary<MalformedFrame> {
  return safePayloadBytes().map((p) => ({
    kind: "lf-after-fs" as const,
    bytes: Buffer.from([VT, ...p, FS, LF]),
  }));
}

/** Leading whitespace before VT: (SP|TAB|LF|CR)+ then a canonical frame (FRAME-10). */
function leadingWhitespace(): fc.Arbitrary<MalformedFrame> {
  const ws = fc.array(fc.constantFrom(0x20, 0x09, LF, CR), { minLength: 1, maxLength: 8 });
  return fc.tuple(ws, safePayloadBytes()).map(([w, p]) => ({
    kind: "leading-whitespace" as const,
    bytes: Buffer.from([...w, VT, ...p, FS, CR]),
  }));
}

/**
 * A VT inside a frame: two payloads joined by a `VT`, `VT + a + VT + b + FS + CR`. Where the
 * frame ends cannot be told, so the decoder refuses it whole with `MLLP_PAYLOAD_CONTAINS_VT`,
 * whatever the tolerances, and delivers neither part.
 */
function vtInsideFrame(): fc.Arbitrary<MalformedFrame> {
  return fc.tuple(safePayloadBytes(), safePayloadBytes()).map(([a, b]) => ({
    kind: "vt-inside-frame" as const,
    bytes: Buffer.from([VT, ...a, VT, ...b, FS, CR]),
  }));
}

/**
 * A bare FS inside a frame: two payloads joined by an `FS` that no `CR`, `LF` or `VT` follows,
 * `VT + a + FS + b + FS + CR`. The decoder refuses it whole with `MLLP_PAYLOAD_CONTAINS_FS` on a
 * reader that allows FS without CR, and with `MLLP_FS_WITHOUT_CR` on one that does not.
 */
function fsInsideFrame(): fc.Arbitrary<MalformedFrame> {
  return fc.tuple(safePayloadBytes(), safePayloadBytes()).map(([a, b]) => ({
    kind: "fs-inside-frame" as const,
    bytes: Buffer.from([VT, ...a, FS, ...b, FS, CR]),
  }));
}

/** Empty payload: VT + FS + CR, no bytes between VT and FS (WARN-05). */
function emptyPayload(): fc.Arbitrary<MalformedFrame> {
  return fc.constant<MalformedFrame>({
    kind: "empty-payload",
    bytes: Buffer.from([VT, FS, CR]),
  });
}

/**
 * Oversized frame: a payload longer than a deliberately tiny `maxFrameSizeBytes`,
 * so the decoder throws the one sanctioned fatal `MLLP_FRAME_TOO_LARGE` (FRAME-11).
 */
function frameTooLarge(): fc.Arbitrary<MalformedFrame> {
  return fc.integer({ min: 1, max: 16 }).map((cap) => {
    const payload = Buffer.alloc(cap + 8, 0x41); // strictly larger than the cap
    return {
      kind: "frame-too-large" as const,
      bytes: Buffer.from([VT, ...payload, FS, CR]),
      maxFrameSizeBytes: cap,
    };
  });
}

/**
 * The union of every malformed-frame shape, one generator per decoder tolerance
 * path plus the three frames refused whole. The lenient invariant runs against this.
 */
export function malformedFrame(): fc.Arbitrary<MalformedFrame> {
  return fc.oneof(
    missingLeadingVt(),
    fsWithoutCr(),
    lfAfterFs(),
    leadingWhitespace(),
    vtInsideFrame(),
    fsInsideFrame(),
    emptyPayload(),
    frameTooLarge(),
  );
}

/**
 * The malformed frames a reader with every tolerance on recovers from: every shape but the
 * three it refuses (`frame-too-large`, `vt-inside-frame`, `fs-inside-frame`). Each one emits at
 * least one warning.
 */
export function recoverableFrame(): fc.Arbitrary<MalformedFrame> {
  return fc.oneof(
    missingLeadingVt(),
    fsWithoutCr(),
    lfAfterFs(),
    leadingWhitespace(),
    emptyPayload(),
  );
}

/**
 * Pure random byte noise as a `Buffer` (0 to 512 bytes), the most hostile fuzz input
 * for the decoder. Includes every byte value, so VT/FS/CR land at random offsets.
 */
export function randomBytes(): fc.Arbitrary<Buffer> {
  return fc.uint8Array({ minLength: 0, maxLength: 512 }).map((bytes) => Buffer.from(bytes));
}

/**
 * A list of random byte chunks (1 to 16 chunks, each 0 to 64 bytes). Concatenated they
 * are arbitrary noise; fed chunk-by-chunk they stress the decoder's chunk-boundary
 * reassembly (a frame may straddle any number of `push()` calls).
 */
export function randomChunks(): fc.Arbitrary<Buffer[]> {
  return fc.array(
    fc.uint8Array({ minLength: 0, maxLength: 64 }).map((b) => Buffer.from(b)),
    {
      minLength: 1,
      maxLength: 16,
    },
  );
}

/**
 * The key transport-robustness fuzz generator: arbitrary random byte buffers fed
 * to the decoder either as a single `push()` (one-element list) or split across
 * many random `push()` chunks. Unifying both shapes into `Buffer[]` lets one
 * fuzz property cover whole-buffer AND chunk-boundary delivery, the decoder's
 * FSM must survive both identically.
 */
export function hostileBytesOrChunks(): fc.Arbitrary<Buffer[]> {
  return fc.oneof(
    // Whole-buffer delivery: a single arbitrary noise buffer pushed at once.
    { weight: 1, arbitrary: randomBytes().map((b) => [b]) },
    // Chunked delivery: arbitrary noise split across many random pushes.
    { weight: 1, arbitrary: randomChunks() },
  );
}
