/**
 * Messy streams a lenient reader accepts: the framing quirks real senders produce, each with the
 * payload and the warnings a `FrameReader` must report for it.
 *
 * @packageDocumentation
 */

import fc from "fast-check";

import type { WarningCode } from "../framing/registry.js";

import {
  CR,
  FS,
  LF,
  VT,
  WHITESPACE,
  cloneable,
  copyStream,
  cutAt,
  cuts,
  payloadBytes,
  type GeneratedStream,
  type StreamOptions,
} from "./bytes.js";

/**
 * Options for {@link messyStream}: the payloads, the frames and the cuts as for a canonical stream,
 * and the tolerances of the reader the stream is meant for. A quirk whose tolerance is `false` is
 * never generated, so pass the same flags your `FrameReader` or server has. Each defaults to `true`.
 */
export interface MessyStreamOptions extends StreamOptions {
  /** Generate `FS` with no `CR` after it. */
  readonly allowFsOnly?: boolean;
  /** Generate `FS` then `LF` in place of `FS` then `CR`. */
  readonly allowLfAfterFs?: boolean;
  /** Generate a frame that opens with no `VT`. */
  readonly allowMissingLeadingVt?: boolean;
  /** Generate spaces, tabs, line feeds and carriage returns before a frame. */
  readonly allowLeadingWhitespace?: boolean;
}

/** A messy stream, with what a reader with the matching tolerances must deliver for it. */
export interface MessyStream extends GeneratedStream {
  /**
   * The warning codes each delivered frame must carry, in the order they are raised, one list per
   * payload. A frame with no quirk has an empty list.
   */
  readonly warnings: readonly (readonly WarningCode[])[];
}

/** How a frame opens. */
type Opening = "vt" | "whitespace" | "no-vt" | "whitespace-no-vt";
/** How a frame ends. */
type Ending = "cr" | "lf" | "fs-only";

/** One frame's choices, before the stream fixes them up so that they read as intended. */
interface FrameChoice {
  readonly opening: Opening;
  /** Whether the frame carries no payload. */
  readonly empty: boolean;
  readonly ending: Ending;
  readonly whitespace: readonly number[];
  readonly payload: readonly number[];
}

/** The parts of a messy stream built so far. */
interface Built {
  readonly bytes: number[];
  readonly payloads: Buffer[];
  readonly warnings: WarningCode[][];
}

/** The openings, bodies and endings the given tolerances accept. */
function quirks(options: MessyStreamOptions): {
  openings: Opening[];
  endings: Ending[];
} {
  const ws = options.allowLeadingWhitespace !== false;
  const noVt = options.allowMissingLeadingVt !== false;
  const openings: Opening[] = ["vt"];
  if (ws) openings.push("whitespace");
  if (noVt) openings.push("no-vt");
  if (ws && noVt) openings.push("whitespace-no-vt");
  const endings: Ending[] = ["cr"];
  if (options.allowLfAfterFs !== false) endings.push("lf");
  if (options.allowFsOnly !== false) endings.push("fs-only");
  return { openings, endings };
}

/** One frame's random choices, within the given tolerances. */
function frameChoice(options: MessyStreamOptions): fc.Arbitrary<FrameChoice> {
  const { openings, endings } = quirks(options);
  return fc.record({
    opening: fc.constantFrom(...openings),
    empty: fc.boolean(),
    ending: fc.constantFrom(...endings),
    whitespace: fc.array(fc.constantFrom(...WHITESPACE), { minLength: 1, maxLength: 4 }),
    payload: payloadBytes(options),
  });
}

/**
 * Append one frame to the stream, fixing its choices up where they would read otherwise:
 *
 * - a frame after an `fs-only` ending opens with its `VT`, which is what ends the frame before;
 * - a frame with no `VT` cannot open on whitespace a reader skips, so such a payload gets its `VT`;
 * - the last frame does not end `fs-only`, which only the next frame's `VT` completes.
 */
function append(built: Built, choice: FrameChoice, mustOpenWithVt: boolean, last: boolean): void {
  const payload = choice.empty ? [] : [...choice.payload];
  let opening = mustOpenWithVt ? "vt" : choice.opening;
  const noVt = opening === "no-vt" || opening === "whitespace-no-vt";
  // An empty payload has no first byte, and `includes(undefined)` is false.
  if (noVt && WHITESPACE.includes(payload[0] as number)) {
    opening = opening === "no-vt" ? "vt" : "whitespace";
  }
  const ending = last && choice.ending === "fs-only" ? "cr" : choice.ending;

  const warnings: WarningCode[] = [];
  if (opening === "whitespace" || opening === "whitespace-no-vt") {
    built.bytes.push(...choice.whitespace);
    warnings.push("MLLP_LEADING_WHITESPACE");
  }
  if (opening === "no-vt" || opening === "whitespace-no-vt") {
    warnings.push("MLLP_MISSING_LEADING_VT");
  } else if (!mustOpenWithVt) {
    built.bytes.push(VT);
  }
  built.bytes.push(...payload, FS);
  if (payload.length === 0) warnings.push("MLLP_EMPTY_PAYLOAD");
  if (ending === "cr") built.bytes.push(CR);
  else if (ending === "lf") {
    built.bytes.push(LF);
    warnings.push("MLLP_LF_AFTER_FS");
  } else {
    // `fs-only` is ended by the next frame's VT, which that frame writes as its opening.
    built.bytes.push(VT);
    warnings.push("MLLP_FS_WITHOUT_CR");
  }
  built.payloads.push(Buffer.from(payload));
  built.warnings.push(warnings);
}

/** Build a messy stream's bytes, payloads and warnings from its frames' choices. */
function buildMessy(choices: readonly FrameChoice[]): Built {
  const built: Built = { bytes: [], payloads: [], warnings: [] };
  let mustOpenWithVt = false;
  choices.forEach((choice, index) => {
    const last = index === choices.length - 1;
    append(built, choice, mustOpenWithVt, last);
    mustOpenWithVt = !last && choice.ending === "fs-only";
  });
  return built;
}

/**
 * A messy MLLP byte stream a lenient reader accepts, split into chunks at random places, with the
 * payloads it must deliver and the warnings each must carry.
 *
 * Each frame may open with spaces, tabs, line feeds or carriage returns before its `VT`, or with no
 * `VT` at all; carry an empty payload; and end with `FS` and `LF`, or with `FS` and the next frame's
 * `VT`. Give it the tolerances your reader has, and it generates only what that reader accepts. It
 * never puts a `VT` inside a frame, nor an `FS` with anything but `CR`, `LF` or the next `VT` after
 * it: a reader refuses such a frame whole (`MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`),
 * so no reader accepts it.
 *
 * @param options - The payloads, frames, cuts and tolerances.
 * @returns An arbitrary of messy streams.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { FrameReader } from "@cosyte/mllp";
 * import { messyStream } from "@cosyte/mllp/arbitraries";
 *
 * const tolerances = { allowFsOnly: true, allowLfAfterFs: true, allowLeadingWhitespace: true };
 * fc.assert(
 *   fc.property(messyStream({ ...tolerances, allowMissingLeadingVt: false }), (s) => {
 *     const got: Buffer[] = [];
 *     const reader = new FrameReader({ ...tolerances, onFrame: (p) => got.push(p) });
 *     for (const chunk of s.chunks) reader.push(chunk);
 *     return got.length === s.payloads.length;
 *   }),
 * );
 * ```
 */
export function messyStream(options: MessyStreamOptions = {}): fc.Arbitrary<MessyStream> {
  return fc
    .array(frameChoice(options), {
      minLength: options.minFrames ?? 1,
      maxLength: options.maxFrames ?? 5,
    })
    .chain((choices) => {
      const built = buildMessy(choices);
      const bytes = Buffer.from(built.bytes);
      return cuts(bytes.length, options).map((at) =>
        cloneable<MessyStream>(
          {
            payloads: built.payloads.map((p) => Buffer.from(p)),
            warnings: built.warnings.map((codes) => [...codes]),
            bytes,
            chunks: cutAt(bytes, at),
          },
          copyStream,
        ),
      );
    });
}
