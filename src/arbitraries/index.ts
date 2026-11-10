/**
 * fast-check generators for MLLP, at `@cosyte/mllp/arbitraries`: payloads, canonical frames,
 * canonical byte streams split into chunks, messy streams a lenient reader accepts, and hostile
 * streams. We use them to test this library, and you can use them to test code you build on it.
 *
 * `fast-check` is an optional peer dependency: install it to use this entry point. The main entry
 * point, `@cosyte/mllp`, never loads it. This entry point imports nothing from the library at run
 * time, only its types.
 *
 * Every generated value is synthetic and random. Each one keeps a copy of itself, which fast-check
 * clones and prints, so code that changes the bytes it is given cannot change the case fast-check
 * reports.
 *
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { FrameReader, encodeFrame } from "@cosyte/mllp";
 * import { payload } from "@cosyte/mllp/arbitraries";
 *
 * fc.assert(
 *   fc.property(payload(), (p) => {
 *     let got: Buffer | undefined;
 *     new FrameReader({ onFrame: (b) => (got = b) }).push(encodeFrame(p));
 *     return got?.equals(p) === true;
 *   }),
 * );
 * ```
 *
 * @packageDocumentation
 */

export { chunked, frame, payload, stream } from "./bytes.js";
export type {
  ChunkOptions,
  GeneratedFrame,
  GeneratedStream,
  PayloadContent,
  PayloadOptions,
  StreamOptions,
} from "./bytes.js";
export { messyStream } from "./messy.js";
export type { MessyStream, MessyStreamOptions } from "./messy.js";
export { hostileInput } from "./hostile.js";
export type { HostileInputOptions } from "./hostile.js";
