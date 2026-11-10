/**
 * Hostile byte streams: what a reader may meet from a broken sender, a port scanner or an attacker.
 *
 * @packageDocumentation
 */

import fc from "fast-check";

import { CR, FS, LF, VT, WHITESPACE, cloneableChunks, cutAt, cuts } from "./bytes.js";
import { messyStream } from "./messy.js";

/** Options for {@link hostileInput}. */
export interface HostileInputOptions {
  /** The most bytes in the stream. Default `512`. */
  readonly maxLength?: number;
  /** The most places the stream is cut into chunks. Default `16`. */
  readonly maxCuts?: number;
}

/** A byte that is a framing byte or whitespace one time in two, and any byte otherwise. */
const FRAMING_HEAVY_BYTE = fc.oneof(
  fc.constantFrom(VT, FS, CR, LF, ...WHITESPACE),
  fc.integer({ min: 0, max: 0xff }),
);

/** One edit to a stream. `at` is taken modulo the stream's length at the time. */
interface Edit {
  readonly op: "insert" | "delete" | "replace" | "truncate" | "repeat";
  readonly at: number;
  readonly byte: number;
}

const EDIT: fc.Arbitrary<Edit> = fc.record({
  op: fc.constantFrom<Edit["op"]>("insert", "delete", "replace", "truncate", "repeat"),
  at: fc.nat(),
  byte: FRAMING_HEAVY_BYTE,
});

/** Apply edits to a stream's bytes, in order. */
function applyEdits(bytes: readonly number[], edits: readonly Edit[]): number[] {
  const out = [...bytes];
  for (const { op, at, byte } of edits) {
    const i = at % (out.length + 1);
    if (op === "insert") out.splice(i, 0, byte);
    else if (op === "truncate") out.length = i;
    else if (op === "repeat") out.splice(i, 0, ...out.slice(i, i + 8));
    else if (i < out.length) {
      if (op === "delete") out.splice(i, 1);
      else out[i] = byte;
    }
  }
  return out;
}

/**
 * A hostile MLLP byte stream as the chunks a socket delivers: random bytes, bytes thick with
 * `VT`, `FS`, `CR`, `LF` and whitespace, and messy streams with bytes inserted, deleted, replaced,
 * repeated and cut off. A reader may refuse one, but it must not hang, crash or throw anything it
 * does not document.
 *
 * @param options - The most bytes, and the most cuts.
 * @returns An arbitrary of chunk lists.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { FrameReader, MllpFramingError } from "@cosyte/mllp";
 * import { hostileInput } from "@cosyte/mllp/arbitraries";
 *
 * fc.assert(
 *   fc.property(hostileInput(), (chunks) => {
 *     const reader = new FrameReader({ onFrame: () => {} });
 *     try {
 *       for (const chunk of chunks) reader.push(chunk);
 *     } catch (err) {
 *       if (!(err instanceof MllpFramingError)) throw err;
 *     }
 *   }),
 * );
 * ```
 */
export function hostileInput(options: HostileInputOptions = {}): fc.Arbitrary<Buffer[]> {
  const maxLength = options.maxLength ?? 512;
  const bytes = fc.oneof(
    fc.array(fc.integer({ min: 0, max: 0xff }), { maxLength }),
    fc.array(FRAMING_HEAVY_BYTE, { maxLength }),
    fc
      .tuple(
        messyStream({ content: "text", maxLength: 32 }),
        fc.array(EDIT, { minLength: 1, maxLength: 4 }),
      )
      .map(([messy, edits]) => applyEdits([...messy.bytes], edits).slice(0, maxLength)),
  );
  return bytes.chain((list) => {
    const buffer = Buffer.from(list);
    return cuts(buffer.length, options).map((at) => cloneableChunks(cutAt(buffer, at)));
  });
}
