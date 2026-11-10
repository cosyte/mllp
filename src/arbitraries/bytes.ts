/**
 * Payloads, canonical frames, canonical byte streams and chunk splits: the valid half of
 * `@cosyte/mllp/arbitraries`.
 *
 * The framing bytes are written here from the MLLP specification (HL7 v2 Appendix C), not imported
 * from the codec, so a generated frame is an independent statement of what the wire carries and a
 * test that compares it with `encodeFrame` checks something.
 *
 * @packageDocumentation
 */

import fc from "fast-check";

/** Start of a frame, `0x0B`. */
export const VT = 0x0b;
/** End of a frame's payload, `0x1C`. */
export const FS = 0x1c;
/** Carriage return, `0x0D`: the byte after `FS`, and the HL7 segment separator. */
export const CR = 0x0d;
/** Line feed, `0x0A`. */
export const LF = 0x0a;
/** The bytes a lenient reader skips before a frame: space, tab, line feed and carriage return. */
export const WHITESPACE: readonly number[] = [0x20, 0x09, LF, CR];

/**
 * Make a generated value safe from code that changes it. fast-check hands a property the value
 * itself the first time and a clone each time after, and reports the value itself when the
 * property fails. So a copy is taken here, before any code under test sees the value: every clone
 * is made from that copy, and the value prints as that copy, so a failure reports the case as it
 * was generated, whatever the code under test did to its bytes.
 *
 * @example
 * ```ts
 * const bytes = cloneable(Buffer.from("A"), (b) => Buffer.from(b));
 * ```
 */
export function cloneable<T extends object>(value: T, copy: (value: T) => T): T {
  const pristine = copy(value);
  Object.defineProperty(value, fc.cloneMethod, {
    value: () => cloneable(copy(pristine), copy),
  });
  Object.defineProperty(value, fc.toStringMethod, { value: () => fc.stringify(pristine) });
  return value;
}

/** A copy of a list of buffers, each buffer copied too. */
function copyBuffers(buffers: readonly Buffer[]): Buffer[] {
  return buffers.map((buffer) => Buffer.from(buffer));
}

/** A cloneable `Buffer` of the given bytes. */
function cloneableBuffer(bytes: Uint8Array | readonly number[]): Buffer {
  return cloneable(Buffer.from(bytes), (buffer) => Buffer.from(buffer));
}

/** What a generated payload holds. */
export type PayloadContent = "bytes" | "text" | "hl7";

/** Options for {@link payload}, and for the payloads inside frames and streams. */
export interface PayloadOptions {
  /**
   * What the payload holds.
   *
   * - `"bytes"` (the default): any byte except `VT` (`0x0B`) and `FS` (`0x1C`), the two bytes the
   *   encoder refuses. `CR` and the other control bytes are in.
   * - `"text"`: printable ASCII with carriage returns, the shape of HL7 v2 text.
   * - `"hl7"`: a synthetic HL7 v2 message: an `MSH` segment with a generated control id in MSH-10,
   *   then up to four more segments, each ended by a carriage return. `minLength` and `maxLength`
   *   do not apply.
   */
  readonly content?: PayloadContent;
  /** The fewest bytes in a `"bytes"` or `"text"` payload. Default `1`. */
  readonly minLength?: number;
  /** The most bytes in a `"bytes"` or `"text"` payload. Default `256`. */
  readonly maxLength?: number;
}

/** Any byte except the two the encoder refuses in a payload. */
const PAYLOAD_BYTE = fc.integer({ min: 0, max: 0xff }).filter((b) => b !== VT && b !== FS);

/** A printable ASCII byte, or a carriage return now and then. */
const TEXT_BYTE = fc.oneof(
  { weight: 15, arbitrary: fc.integer({ min: 0x20, max: 0x7e }) },
  { weight: 1, arbitrary: fc.constant(CR) },
);

/** A short run of letters and digits: the content of one synthetic HL7 field. */
function word(maxLength: number): fc.Arbitrary<string> {
  return fc.string({
    unit: fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"),
    maxLength,
  });
}

/** The message types a synthetic HL7 payload carries in MSH-9. */
const MESSAGE_TYPES = [
  "ADT^A01",
  "ADT^A04",
  "ADT^A08",
  "ORM^O01",
  "ORU^R01",
  "SIU^S12",
  "MDM^T02",
  "DFT^P03",
  "ACK",
];

/** The segments after MSH in a synthetic HL7 payload. None of them carries a patient. */
const SEGMENT_NAMES = ["EVN", "PV1", "ORC", "OBR", "OBX", "NTE", "ZXX"];

/** One synthetic segment after MSH: a name, then fields of letters and digits with components. */
const SEGMENT = fc
  .tuple(
    fc.constantFrom(...SEGMENT_NAMES),
    fc.array(fc.array(word(8), { minLength: 1, maxLength: 3 }), { maxLength: 6 }),
  )
  .map(([name, fields]) => [name, ...fields.map((components) => components.join("^"))].join("|"));

/** A synthetic HL7 v2 message, each segment ended by a carriage return. */
const HL7_TEXT = fc
  .record({
    sender: word(6),
    receiver: word(6),
    when: fc.date({
      min: new Date("2000-01-01T00:00:00Z"),
      max: new Date("2039-12-31T23:59:59Z"),
      noInvalidDate: true,
    }),
    type: fc.constantFrom(...MESSAGE_TYPES),
    controlId: word(20).filter((id) => id.length > 0),
    segments: fc.array(SEGMENT, { maxLength: 4 }),
  })
  .map(({ sender, receiver, when, type, controlId, segments }) => {
    const ts = when.toISOString().replace(/\D/gu, "").slice(0, 14);
    const msh = `MSH|^~\\&|${sender}|FAC|${receiver}|FAC|${ts}||${type}|${controlId}|P|2.5`;
    return [msh, ...segments].map((segment) => `${segment}\r`).join("");
  });

/**
 * The bytes of one payload, as a plain array, before it becomes a `Buffer`.
 *
 * @example
 * ```ts
 * const bytes = fc.sample(payloadBytes({ content: "text" }), 1)[0];
 * ```
 */
export function payloadBytes(options: PayloadOptions = {}): fc.Arbitrary<number[]> {
  const content = options.content ?? "bytes";
  if (content === "hl7") return HL7_TEXT.map((text) => [...Buffer.from(text, "latin1")]);
  return fc.array(content === "text" ? TEXT_BYTE : PAYLOAD_BYTE, {
    minLength: options.minLength ?? 1,
    maxLength: options.maxLength ?? 256,
  });
}

/**
 * A payload the encoder accepts: a `Buffer` with no `VT` (`0x0B`) and no `FS` (`0x1C`) in it.
 *
 * Framed with `encodeFrame` and read back with a `FrameReader`, every one comes back byte for
 * byte. With the default `minLength` of 1 it also comes back with no warning; an empty payload
 * comes back with `MLLP_EMPTY_PAYLOAD`.
 *
 * @param options - What the payload holds and how long it is.
 * @returns An arbitrary of payload buffers.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { encodeFrame } from "@cosyte/mllp";
 * import { payload } from "@cosyte/mllp/arbitraries";
 *
 * fc.assert(fc.property(payload(), (p) => encodeFrame(p).length === p.length + 3));
 * ```
 */
export function payload(options: PayloadOptions = {}): fc.Arbitrary<Buffer> {
  return payloadBytes(options).map(cloneableBuffer);
}

/** A canonical frame and the payload it carries. */
export interface GeneratedFrame {
  /** The payload: what a reader must deliver for these bytes. */
  readonly payload: Buffer;
  /** The frame as it goes on the wire: `VT`, the payload, `FS`, `CR`. */
  readonly bytes: Buffer;
}

/** The canonical frame of a payload, written byte by byte. */
function frameBytes(payloadBytes: readonly number[]): number[] {
  return [VT, ...payloadBytes, FS, CR];
}

/** Copy a frame, both buffers. */
function copyFrame(frame: GeneratedFrame): GeneratedFrame {
  return { payload: Buffer.from(frame.payload), bytes: Buffer.from(frame.bytes) };
}

/**
 * A canonical MLLP frame, `VT` + payload + `FS` + `CR`, with the payload it carries.
 *
 * The bytes are written from the MLLP specification, not by `encodeFrame`, so they are an
 * independent check on the encoder: `encodeFrame(f.payload)` equals `f.bytes`.
 *
 * @param options - The payload's options, as for {@link payload}.
 * @returns An arbitrary of frames.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { encodeFrame } from "@cosyte/mllp";
 * import { frame } from "@cosyte/mllp/arbitraries";
 *
 * fc.assert(fc.property(frame(), (f) => encodeFrame(f.payload).equals(f.bytes)));
 * ```
 */
export function frame(options: PayloadOptions = {}): fc.Arbitrary<GeneratedFrame> {
  return payloadBytes(options).map((bytes) =>
    cloneable<GeneratedFrame>(
      { payload: Buffer.from(bytes), bytes: Buffer.from(frameBytes(bytes)) },
      copyFrame,
    ),
  );
}

/** Options for {@link chunked}. */
export interface ChunkOptions {
  /** The most places the bytes are cut. Default `16`. Two cuts in one place leave an empty chunk. */
  readonly maxCuts?: number;
}

/**
 * Cut `bytes` at the given offsets, sorted; repeated offsets leave empty chunks.
 *
 * @example
 * ```ts
 * cutAt(Buffer.from("ABC"), [2, 1]); // A, B, C
 * ```
 */
export function cutAt(bytes: Buffer, cuts: readonly number[]): Buffer[] {
  const sorted = [...cuts].sort((a, b) => a - b);
  const chunks: Buffer[] = [];
  let start = 0;
  for (const cut of sorted) {
    chunks.push(Buffer.from(bytes.subarray(start, cut)));
    start = cut;
  }
  chunks.push(Buffer.from(bytes.subarray(start)));
  return chunks;
}

/**
 * A cloneable list of chunks.
 *
 * @example
 * ```ts
 * const chunks = cloneableChunks([Buffer.from("A")]);
 * ```
 */
export function cloneableChunks(chunks: Buffer[]): Buffer[] {
  return cloneable(chunks, copyBuffers);
}

/**
 * The cut offsets for a run of `length` bytes.
 *
 * @example
 * ```ts
 * const at = fc.sample(cuts(10), 1)[0];
 * ```
 */
export function cuts(length: number, options: ChunkOptions = {}): fc.Arbitrary<number[]> {
  return fc.array(fc.integer({ min: 0, max: length }), { maxLength: options.maxCuts ?? 16 });
}

/**
 * The given bytes split into chunks at random places, the way a socket may deliver them: a frame
 * across many reads, many frames in one read, and now and then an empty read. Concatenated, the
 * chunks are always the bytes given. A case shrinks toward one chunk.
 *
 * @param bytes - The bytes to split.
 * @param options - How many cuts at most.
 * @returns An arbitrary of chunk lists.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { chunked } from "@cosyte/mllp/arbitraries";
 *
 * const bytes = Buffer.from("ABCDEF");
 * fc.assert(fc.property(chunked(bytes), (chunks) => Buffer.concat(chunks).equals(bytes)));
 * ```
 */
export function chunked(bytes: Buffer, options: ChunkOptions = {}): fc.Arbitrary<Buffer[]> {
  const source = Buffer.from(bytes);
  return cuts(source.length, options).map((at) => cloneableChunks(cutAt(source, at)));
}

/** Options for {@link stream}. */
export interface StreamOptions extends PayloadOptions, ChunkOptions {
  /** The fewest frames in the stream. Default `1`. */
  readonly minFrames?: number;
  /** The most frames in the stream. Default `5`. */
  readonly maxFrames?: number;
}

/** A canonical byte stream: frames back to back, as chunks, with the payloads it carries. */
export interface GeneratedStream {
  /** The payloads in order: what a reader must deliver for this stream. */
  readonly payloads: readonly Buffer[];
  /** The whole stream: each payload's canonical frame, back to back. */
  readonly bytes: Buffer;
  /** The same bytes split at random places, the reads a socket may deliver. */
  readonly chunks: readonly Buffer[];
}

/**
 * Copy a stream, every buffer in it.
 *
 * @example
 * ```ts
 * const copy = copyStream(generated);
 * ```
 */
export function copyStream<T extends GeneratedStream>(stream: T): T {
  return {
    ...stream,
    payloads: copyBuffers(stream.payloads),
    bytes: Buffer.from(stream.bytes),
    chunks: copyBuffers(stream.chunks),
  };
}

/**
 * A canonical MLLP byte stream: one to five frames back to back, split into chunks at random
 * places, with the payloads a reader must deliver from it, in order and with no warning.
 *
 * @param options - The payloads' options, how many frames, and how many cuts at most.
 * @returns An arbitrary of streams.
 * @example
 * ```ts
 * import fc from "fast-check";
 * import { FrameReader } from "@cosyte/mllp";
 * import { stream } from "@cosyte/mllp/arbitraries";
 *
 * fc.assert(
 *   fc.property(stream(), (s) => {
 *     const got: Buffer[] = [];
 *     const reader = new FrameReader({ onFrame: (p) => got.push(p) });
 *     for (const chunk of s.chunks) reader.push(chunk);
 *     return got.length === s.payloads.length;
 *   }),
 * );
 * ```
 */
export function stream(options: StreamOptions = {}): fc.Arbitrary<GeneratedStream> {
  return fc
    .array(payloadBytes(options), {
      minLength: options.minFrames ?? 1,
      maxLength: options.maxFrames ?? 5,
    })
    .chain((payloads) => {
      const bytes = Buffer.from(payloads.flatMap(frameBytes));
      return cuts(bytes.length, options).map((at) =>
        cloneable<GeneratedStream>(
          {
            payloads: payloads.map((p) => Buffer.from(p)),
            bytes,
            chunks: cutAt(bytes, at),
          },
          copyStream,
        ),
      );
    });
}
