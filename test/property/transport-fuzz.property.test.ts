/**
 * Transport fuzz: hostile MLLP streams through the decoder and the connection's receive path.
 *
 * `fuzz.property.test.ts` feeds random noise to a fully tolerant reader. This suite starts from
 * the framed seeds in `_seed-corpus.ts` (canonical frames carrying HL7 v2 messages, and each
 * tolerance path) and mutates them, then runs them under **every** reader option set, strict
 * included, delivered whole and split at arbitrary chunk boundaries, so the bytes look like what
 * a misbehaving peer actually sends and reach every state of the decoder.
 *
 * The contract, per case:
 *
 *   - **No unsanctioned throw.** `FrameReader.push` may throw only an `MllpFramingError` with a
 *     registered code, a finite byte offset, and a snippet of at most one byte (no run of payload
 *     reaches an error). After a throw, `reset()` leaves the reader decoding a clean frame.
 *     Writing into a `Connection` never throws at all: a framing fatal becomes one `'error'`
 *     event with `connectionCause: 'framing-fatal'`, and anything else is our bug.
 *   - **Chunking changes nothing.** The frames (payload bytes and offsets), the warnings, and any
 *     fatal are the same whether the stream arrives whole or in pieces. A framing result that
 *     depends on how TCP segmented the stream is how a clinical message is dropped or split.
 *   - **No hang and no runaway allocation**, by the per-case budget in `_fuzz-config.ts`.
 *
 * The last target frames mutated HL7 payloads with `encodeFrame`: it may refuse a payload only
 * for a `VT` or `FS` byte, and a strict reader returns exactly the payload it framed.
 *
 * `pnpm test` runs each target at its base count against a pinned seed; `pnpm fuzz` with the
 * `MLLP_FUZZ_*` variables is the nightly run (see `_fuzz-config.ts`).
 *
 * @module
 */

import { Buffer } from "node:buffer";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { Connection, MllpConnectionError } from "../../src/connection/index.js";
import { FrameReader, type FrameReaderOptions } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { MllpWarning, WarningCode } from "../../src/framing/registry.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

import { fuzzParameters, fuzzTimeout, preview, withinBudget } from "./_fuzz-config.js";
import { mutatedSeed } from "./_mutate.js";
import { MESSAGE_SEEDS, MLLP_TOKENS, STREAM_SEEDS } from "./_seed-corpus.js";

/** Every registered warning and error code. */
const KNOWN: ReadonlySet<string> = new Set<WarningCode>([
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
]);

type ReaderOptions = Omit<FrameReaderOptions, "onFrame" | "onWarning">;

/** Every combination of the reader's options, the tiny frame caps included. */
const readerOptions: fc.Arbitrary<ReaderOptions> = fc.record(
  {
    strict: fc.boolean(),
    allowFsOnly: fc.boolean(),
    allowLfAfterFs: fc.boolean(),
    allowMissingLeadingVt: fc.boolean(),
    allowLeadingWhitespace: fc.boolean(),
    maxFrameSizeBytes: fc.integer({ min: 1, max: 4096 }),
  },
  { requiredKeys: [] },
);

/** Chunk sizes, used in turn until the stream runs out. Empty means one whole chunk. */
const chunkPlan = fc.array(fc.integer({ min: 1, max: 64 }), { maxLength: 24 });

/** Cut `bytes` into chunks by `plan`, cycling through it. */
function chunk(bytes: Buffer, plan: readonly number[]): Buffer[] {
  if (plan.length === 0) return [bytes];
  const chunks: Buffer[] = [];
  let at = 0;
  for (let i = 0; at < bytes.length; i++) {
    const size = plan[i % plan.length] ?? 1;
    chunks.push(bytes.subarray(at, at + size));
    at += size;
  }
  return chunks;
}

/** Render a thrown value without assuming it is an Error. */
function describeThrown(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

function unsanctioned(where: string, err: unknown, input: Buffer): Error {
  return new Error(`fuzz: ${where} threw ${describeThrown(err)} on ${preview(input)}`, {
    cause: err,
  });
}

/** A warning carries a registered code and a finite byte offset. */
function checkWarning(w: MllpWarning, input: Buffer): void {
  if (!KNOWN.has(w.code) || !Number.isFinite(w.byteOffset)) {
    throw new Error(
      `fuzz: an unregistered or unplaced warning ${JSON.stringify(w.code)}: ${preview(input)}`,
    );
  }
}

/** Everything a decode produced, in a comparable form. */
interface Decoded {
  readonly frames: readonly string[];
  readonly warnings: readonly string[];
  readonly fatal: string | undefined;
}

/** Decode `input` as `chunks` with a reader built from `options`, holding the contract. */
function decode(chunks: readonly Buffer[], options: ReaderOptions, input: Buffer): Decoded {
  const frames: string[] = [];
  const delivered: { readonly payload: Buffer; readonly hex: string }[] = [];
  const warnings: string[] = [];
  const reader = new FrameReader({
    ...options,
    onFrame: (payload, offset, frameWarnings) => {
      delivered.push({ payload, hex: payload.toString("hex") });
      frames.push(
        `${String(offset)}:${payload.toString("hex")}:${frameWarnings.map((w) => w.code).join(",")}`,
      );
    },
    onWarning: (w) => {
      checkWarning(w, input);
      warnings.push(`${w.code}@${String(w.byteOffset)}`);
    },
  });
  let fatal: string | undefined;
  try {
    for (const piece of chunks) reader.push(piece);
  } catch (err) {
    if (
      !(err instanceof MllpFramingError) ||
      !KNOWN.has(err.code) ||
      !Number.isFinite(err.byteOffset) ||
      err.snippet.length > 1
    ) {
      throw unsanctioned("FrameReader.push", err, input);
    }
    fatal = `${err.code}@${String(err.byteOffset)}`;
  }
  // A payload handed to onFrame is the consumer's: later bytes must never rewrite it.
  for (const d of delivered) {
    if (d.payload.toString("hex") !== d.hex) {
      throw new Error(`fuzz: a delivered payload changed after delivery: ${preview(input)}`);
    }
  }
  return { frames, warnings, fatal };
}

/** One connection fed `chunks` from its peer, holding the receive-path contract. */
function receive(chunks: readonly Buffer[], framing: ReaderOptions, input: Buffer): void {
  const [local, peer] = InMemoryTransport.pair();
  const errors: unknown[] = [];
  const conn = new Connection({
    transport: local,
    framing,
    onWarning: (w) => {
      checkWarning(w, input);
    },
    onMessage: (payload) => {
      if (!Buffer.isBuffer(payload)) throw new Error("fuzz: a message payload is not a Buffer");
    },
  });
  conn.on("error", (e: unknown) => errors.push((e as { error?: unknown }).error));
  conn.notifyConnect("127.0.0.1", 2575);
  try {
    for (const piece of chunks) {
      try {
        peer.write(piece);
      } catch (err) {
        throw unsanctioned("a write into a Connection", err, input);
      }
    }
    for (const error of errors) {
      const sanctioned =
        error instanceof MllpConnectionError &&
        error.connectionCause === "framing-fatal" &&
        error.cause instanceof MllpFramingError;
      if (!sanctioned) throw unsanctioned("the Connection's receive path", error, input);
    }
  } finally {
    conn.destroy();
  }
}

const streams = mutatedSeed(STREAM_SEEDS, MLLP_TOKENS);
const messages = mutatedSeed(MESSAGE_SEEDS, MLLP_TOKENS);

describe("fuzz: mutated MLLP streams through the decoder and the connection", () => {
  it(
    "FrameReader under every option set: sanctioned throws only, and chunking changes nothing",
    () => {
      fc.assert(
        fc.property(streams, readerOptions, chunkPlan, (input, options, plan) => {
          withinBudget(input.bytes, () => {
            const whole = decode([input.bytes], options, input.bytes);
            const pieces = decode(chunk(input.bytes, plan), options, input.bytes);
            expect(pieces).toEqual(whole);
          });
        }),
        fuzzParameters(400, 0x3117_0001),
      );
    },
    fuzzTimeout(60_000),
  );

  it(
    "reset() after any stream leaves the reader decoding a clean frame from offset 0",
    () => {
      fc.assert(
        fc.property(streams, readerOptions, (input, options) => {
          withinBudget(input.bytes, () => {
            const frames: Buffer[] = [];
            let first: number | undefined;
            const reader = new FrameReader({
              ...options,
              onFrame: (payload, offset) => {
                frames.push(payload);
                first ??= offset;
              },
            });
            try {
              reader.push(input.bytes);
            } catch (err) {
              if (!(err instanceof MllpFramingError))
                throw unsanctioned("FrameReader.push", err, input.bytes);
            }
            reader.reset();
            frames.length = 0;
            first = undefined;
            // One payload byte, so it fits the smallest frame cap the options can set.
            reader.push(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
            expect(frames).toHaveLength(1);
            expect(frames[0]?.equals(Buffer.from([0x41]))).toBe(true);
            expect(first).toBe(0);
          });
        }),
        fuzzParameters(300, 0x3117_0002),
      );
    },
    fuzzTimeout(60_000),
  );

  it(
    "a Connection fed any stream in any chunks never throws, and reports only framing fatals",
    () => {
      fc.assert(
        fc.property(streams, readerOptions, chunkPlan, (input, framing, plan) => {
          withinBudget(input.bytes, () => {
            receive(chunk(input.bytes, plan), framing, input.bytes);
          });
        }),
        fuzzParameters(300, 0x3117_0003),
      );
    },
    fuzzTimeout(60_000),
  );

  it(
    "encodeFrame refuses only VT and FS, and a strict reader returns exactly what it framed",
    () => {
      fc.assert(
        fc.property(messages, (input) => {
          withinBudget(input.bytes, () => {
            let framed: Buffer;
            try {
              framed = encodeFrame(input.bytes);
            } catch (err) {
              const refused =
                err instanceof MllpFramingError &&
                (err.code === "MLLP_PAYLOAD_CONTAINS_VT" ||
                  err.code === "MLLP_PAYLOAD_CONTAINS_FS") &&
                err.snippet.length <= 1;
              if (!refused) throw unsanctioned("encodeFrame", err, input.bytes);
              return;
            }
            const got: Buffer[] = [];
            new FrameReader({ strict: true, onFrame: (payload) => got.push(payload) }).push(framed);
            expect(got).toHaveLength(1);
            expect(got[0]?.equals(input.bytes)).toBe(true);
          });
        }),
        fuzzParameters(300, 0x3117_0004),
      );
    },
    fuzzTimeout(60_000),
  );
});
