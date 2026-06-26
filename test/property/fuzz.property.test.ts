/**
 * Transport-robustness FUZZ layer — the key invariant for an MLLP transport.
 *
 * A production MLLP listener faces hostile, corrupt, and adversarial byte streams.
 * The hard guarantee: feeding ARBITRARY random bytes into the decoder — whole or
 * split across arbitrary chunk boundaries — must never throw an *unexpected* error
 * and must never hang. The only sanctioned throw is the bounded-accumulator fatal
 * `MLLP_FRAME_TOO_LARGE` (FRAME-11), which random sub-cap noise cannot reach.
 *
 * This is driven over the **in-memory transport** wherever possible (per the mllp
 * guardrail "every test that can run over it must run over it"): random bytes are
 * written from the peer end, delivered synchronously to the `Connection`'s
 * `FrameReader` via `onData`. Because `InMemoryTransport.write()` invokes the data
 * handler synchronously, any throw from the decoder surfaces synchronously out of
 * `write()` — so the property can catch and classify it directly, and "no hang"
 * is structurally guaranteed (no timers, no async, all work completes in-call).
 */

import { describe, it, expect } from "vitest";
import fc from "fast-check";

import { Connection } from "../../src/connection/connection.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { MllpFramingError } from "../../src/framing/error.js";
import { FrameReader } from "../../src/framing/decoder.js";
import type { MllpWarning, WarningCode } from "../../src/framing/registry.js";

import { randomBytes, randomChunks, hostileBytesOrChunks } from "./_arbitraries.js";

/** Stable run budget so failures reproduce deterministically. */
const NUM_RUNS = 1000;

/** All decoder tolerances on — the liberal-receiver posture a hardened listener uses. */
const ALL_TOLERANCES = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowMissingLeadingVt: true,
  allowLeadingWhitespace: true,
} as const;

/** The single fatal a tolerant decoder may throw on sub-cap input: never, in practice. */
const SANCTIONED_FATAL: WarningCode = "MLLP_FRAME_TOO_LARGE";

/**
 * Assert a thrown value is the one sanctioned framing fatal; rethrow anything else
 * so fast-check reports it as a counterexample (an *unexpected* throw is the bug
 * the fuzzer hunts).
 */
function assertSanctioned(err: unknown): void {
  if (err instanceof MllpFramingError && err.code === SANCTIONED_FATAL) return;
  throw err;
}

/**
 * Build a tolerant `Connection` over an in-memory pair and return the peer end plus
 * accumulators. The connection is moved to CONNECTED so the full receive path
 * (frame delivery + `message` emit) is live, exercising more of the FSM under fuzz.
 */
function makeFuzzConnection(): {
  peer: InMemoryTransport;
  warnings: MllpWarning[];
  frames: Buffer[];
  errors: Error[];
} {
  const [clientT, serverT] = InMemoryTransport.pair();
  const warnings: MllpWarning[] = [];
  const frames: Buffer[] = [];
  const errors: Error[] = [];

  const conn = new Connection({
    transport: clientT,
    framing: ALL_TOLERANCES,
    onWarning: (w) => warnings.push(w),
    onMessage: (payload) => frames.push(payload),
  });
  // Connection swallows transport 'error' into an emitted error event — capture it
  // so an unexpected internal error can't pass silently.
  conn.on("error", (e: { error?: Error }) => {
    if (e.error !== undefined) errors.push(e.error);
  });
  conn.notifyConnect("127.0.0.1", 2575);

  return { peer: serverT, warnings, frames, errors };
}

describe("fuzz: arbitrary random bytes over the in-memory transport never crash the decoder", () => {
  it("whole-buffer random noise: only MLLP_FRAME_TOO_LARGE may throw; no hang", () => {
    fc.assert(
      fc.property(randomBytes(), (bytes) => {
        const { peer, errors } = makeFuzzConnection();
        try {
          // Synchronous delivery → any decoder throw surfaces here.
          peer.write(bytes);
        } catch (err) {
          assertSanctioned(err);
        }
        // No internal error should have leaked through the connection's error event
        // either (a framing fatal is thrown, not emitted, so this stays empty).
        expect(errors).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("chunk-split random noise: FSM survives arbitrary push() boundaries", () => {
    fc.assert(
      fc.property(randomChunks(), (chunks) => {
        const { peer, errors } = makeFuzzConnection();
        try {
          for (const chunk of chunks) peer.write(chunk);
        } catch (err) {
          assertSanctioned(err);
        }
        expect(errors).toEqual([]);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("byte-at-a-time delivery (split(1)) of random noise never crashes", () => {
    // The harshest chunk boundary: every single byte is its own push(). Uses the
    // transport's own split() to drive one-byte reads, the canonical reassembly stressor.
    fc.assert(
      fc.property(randomBytes(), (bytes) => {
        const { peer, errors } = makeFuzzConnection();
        peer.split(1);
        try {
          peer.write(bytes);
        } catch (err) {
          assertSanctioned(err);
        }
        expect(errors).toEqual([]);
      }),
      { numRuns: 400 },
    );
  });
});

describe("fuzz: standalone FrameReader robustness (raw push path)", () => {
  it("any byte stream (whole or chunked) yields only known warnings and no unexpected throw", () => {
    // Direct FrameReader path — no transport — so a regression in the FSM itself
    // is caught even if the Connection wiring masked it. Every emitted warning must
    // still carry a registered code; the only legal throw is the sanctioned fatal.
    const known: ReadonlySet<string> = new Set<WarningCode>([
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

    fc.assert(
      fc.property(hostileBytesOrChunks(), (chunks) => {
        const warnings: MllpWarning[] = [];
        const reader = new FrameReader({
          ...ALL_TOLERANCES,
          onFrame: (_p, _o, fw) => warnings.push(...fw),
          onWarning: (w) => warnings.push(w),
        });
        try {
          for (const chunk of chunks) reader.push(chunk);
        } catch (err) {
          assertSanctioned(err);
          return;
        }
        for (const w of warnings) {
          expect(known.has(w.code)).toBe(true);
          expect(Number.isFinite(w.byteOffset)).toBe(true);
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it("reset() after fuzz leaves the reader reusable (byte offset back to 0)", () => {
    // A fuzzed reader that is reset must cleanly decode a fresh canonical frame —
    // proving fuzz input cannot wedge the FSM into a permanently-broken state.
    fc.assert(
      fc.property(randomBytes(), (noise) => {
        const frames: Buffer[] = [];
        let firstOffset: number | undefined;
        const reader = new FrameReader({
          ...ALL_TOLERANCES,
          onFrame: (p, offset) => {
            frames.push(p);
            firstOffset ??= offset;
          },
        });
        try {
          reader.push(noise);
        } catch (err) {
          assertSanctioned(err);
        }
        reader.reset();
        frames.length = 0;
        firstOffset = undefined;

        // A clean canonical frame after reset must decode, starting at offset 0.
        reader.push(Buffer.from([0x0b, 0x41, 0x42, 0x1c, 0x0d]));
        expect(frames).toHaveLength(1);
        expect(frames[0]?.equals(Buffer.from([0x41, 0x42]))).toBe(true);
        expect(firstOffset).toBe(0);
      }),
      { numRuns: 400 },
    );
  });
});
