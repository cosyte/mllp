/**
 * Property tests for the Postel's-Law ENCODE side of the MLLP framing codec: any
 * payload the strict encoder accepts must survive `decode(encode(payload))` with
 * exact byte fidelity, and encoding must be idempotent.
 *
 * These are the generative analogue of `test/framing/byte-fidelity.test.ts`
 * (which sweeps every single byte value 0x00–0xFF and a 1 MiB corpus). Where that
 * file pins fixed corpora, this file generates thousands of arbitrary
 * delimiter-free payloads and proves the codec is a lossless inverse pair.
 *
 * Wiring to the `@cosyte/test-utils` `roundTripProperty` runner: the runner's
 * contract is `serialize: (T) => string` / `parse: (string) => T`. MLLP is a byte
 * transport, so we marshal the frame `Buffer` across that string boundary with
 * `latin1` (a lossless 1:1 byte↔code-unit mapping for 0x00–0xFF). The in-memory
 * value `T` is the payload `Buffer`; `serialize` encodes a frame and stringifies
 * it, `parse` decodes the frame back to the payload. Buffer equality is the
 * structural check.
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { roundTripProperty } from "@cosyte/test-utils";

import { encodeFrame } from "../../src/framing/encoder.js";
import { FrameReader } from "../../src/framing/decoder.js";

import { delimiterFreePayload } from "./_arbitraries.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 500;

/**
 * Decode exactly one frame's worth of bytes via `FrameReader` and return the
 * recovered payload. Throws if the bytes did not yield exactly one frame — a
 * round-trip of a single `encodeFrame` output must deliver one and only one frame.
 */
function decodeOneFrame(frame: Buffer): Buffer {
  const delivered: Buffer[] = [];
  const reader = new FrameReader({
    onFrame: (payload) => {
      delivered.push(payload);
    },
  });
  reader.push(frame);
  if (delivered.length !== 1 || delivered[0] === undefined) {
    throw new Error(`expected exactly 1 frame, got ${delivered.length}`);
  }
  return delivered[0];
}

describe("property: MLLP codec round-trip (encode → decode) byte fidelity", () => {
  it("decode(encode(payload)) recovers the exact payload bytes, and encode is idempotent", () => {
    roundTripProperty<Buffer>({
      arbitrary: delimiterFreePayload(),
      // latin1 is a lossless byte<->string mapping over 0x00-0xFF, so the frame
      // Buffer survives the runner's string boundary unchanged.
      serialize: (payload) => encodeFrame(payload).toString("latin1"),
      parse: (frameStr) => decodeOneFrame(Buffer.from(frameStr, "latin1")),
      // The runner re-serializes the parsed value and asserts byte-identity, which
      // gives us encode-idempotency for free: encode(decode(encode(p))) === encode(p).
      equals: (a, b) => a.equals(b),
      numRuns: NUM_RUNS,
    });
  });

  it("a directly-decoded frame equals the original payload (no string marshalling)", () => {
    // Belt-and-braces: prove fidelity against the raw Buffer path too, so the
    // latin1 marshalling above can never mask a codec bug.
    fc.assert(
      fc.property(delimiterFreePayload(), (payload) => {
        const recovered = decodeOneFrame(encodeFrame(payload));
        expect(recovered.equals(payload)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("a well-formed frame decodes with zero warnings (the encoder emits canonical bytes)", () => {
    // Guards the GENERATOR + encoder: a canonical encodeFrame output must never
    // trip a tolerance warning, otherwise the fidelity claim could be masking a
    // lossy recovery path rather than a clean round-trip.
    fc.assert(
      fc.property(delimiterFreePayload(), (payload) => {
        let warningCount = 0;
        const reader = new FrameReader({
          onFrame: () => {
            /* delivered */
          },
          onWarning: () => {
            warningCount++;
          },
        });
        reader.push(encodeFrame(payload));
        expect(warningCount).toBe(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("encode wraps payload in exactly VT + payload + FS + CR (length + sentinels)", () => {
    fc.assert(
      fc.property(delimiterFreePayload(), (payload) => {
        const frame = encodeFrame(payload);
        expect(frame.length).toBe(payload.length + 3);
        expect(frame[0]).toBe(0x0b); // VT
        expect(frame[frame.length - 2]).toBe(0x1c); // FS
        expect(frame[frame.length - 1]).toBe(0x0d); // CR
        // The middle bytes are an exact, independent copy of the payload.
        expect(frame.subarray(1, frame.length - 2).equals(payload)).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
