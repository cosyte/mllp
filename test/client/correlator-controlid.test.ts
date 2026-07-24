/**
 * Correlator controlId-mode tests (PLAN-03).
 *
 * Three test suites:
 *   1. MSH-10 / MSA-2 byte-level extractors (Task 1)
 *   2. Correlator.matchAck() controlId branch incl. graveyard hit + unmatched (Task 2)
 *   3. High-bit control IDs, the `latin1` (not `ascii`) decode (Task 3,
 *      MLLP-CORRELATOR-ASCII)
 *
 * Pure data-structure tests over an injected fake clock, no real timers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Correlator,
  extractMshControlId,
  extractMsaControlId,
} from "../../src/client/correlator.js";
import type { CorrelatorOptions, PendingAck } from "../../src/client/correlator.js";
import type { WarningCode } from "../../src/framing/index.js";
import { encodeFrame } from "../../src/framing/index.js";
import { buildRawAck } from "../../src/server/ack.js";

const noop = (): void => {
  /* noop */
};
const noopReject = (_err: Error): void => {
  /* noop */
};

// Build an MSH segment with field separator `|` and supplied fields after the
// encoding-chars field. fields.length should be >= 8 so MSH-10 (the 8th post-enc
// field) is present.
function buildMsh(fieldSep: string, encChars: string, fields: string[]): string {
  return ["MSH", encChars, ...fields].join(fieldSep === "MSH" ? "|" : fieldSep);
}

describe("Correlator (controlId mode), Task 1: MSH-10 / MSA-2 extractors", () => {
  it("Test 1: extractMshControlId on a canonical ADT^A01 payload returns MSH-10", () => {
    // MSH|^~\&|SENDER|FAC|RECV|FAC2|20260501101010||ADT^A01|MSG00001|P|2.5
    // Fields: enc=^~\&  MSH-3=SENDER MSH-4=FAC MSH-5=RECV MSH-6=FAC2
    //         MSH-7=20260501101010 MSH-8="" MSH-9=ADT^A01 MSH-10=MSG00001
    const buf = Buffer.from(
      "MSH|^~\\&|SENDER|FAC|RECV|FAC2|20260501101010||ADT^A01|MSG00001|P|2.5",
      "ascii",
    );
    expect(extractMshControlId(buf)).toBe("MSG00001");
  });

  it("Test 2: dynamic field separator detection from buf[3] (custom separator ^)", () => {
    const buf = Buffer.from(
      "MSH^~|\\&^SENDER^FAC^RECV^FAC2^20260501101010^^ADT~A01^MSG_X1^P^2.5",
      "ascii",
    );
    // fieldSep = '^' (buf[3] === 0x5E)
    expect(extractMshControlId(buf)).toBe("MSG_X1");
  });

  it("Test 3: returns null if buf does not start with MSH", () => {
    expect(extractMshControlId(Buffer.from("XYZ|...", "ascii"))).toBeNull();
    expect(extractMshControlId(Buffer.from("msh|...", "ascii"))).toBeNull(); // case-sensitive
  });

  it("Test 4: returns null if MSH-10 is empty", () => {
    // MSH|^~\&|S|F|R|F2|TS||TYPE^TRG||REST , MSH-10 is empty (between || at end)
    const buf = Buffer.from("MSH|^~\\&|S|F|R|F2|20260501101010||ADT^A01||P|2.5", "ascii");
    expect(extractMshControlId(buf)).toBeNull();
  });

  it("Test 5: returns null if MSH has fewer than 10 fields", () => {
    // Only 7 fields after MSH, truncated header
    const buf = Buffer.from("MSH|^~\\&|S|F|R|F2", "ascii");
    expect(extractMshControlId(buf)).toBeNull();
  });

  it("Test 6: extractMsaControlId on a canonical AA ACK returns MSA-2", () => {
    // MSH|^~\&|RECV|F|S|F2|TS||ACK^A01|ACK00001|P|2.5\rMSA|AA|MSG00001
    const buf = Buffer.from(
      "MSH|^~\\&|RECV|F|S|F2|20260501101010||ACK^A01|ACK00001|P|2.5\rMSA|AA|MSG00001",
      "ascii",
    );
    expect(extractMsaControlId(buf)).toBe("MSG00001");
  });

  it("Test 7: handles segment separators, MSA after MSH and other segments", () => {
    // MSH...\rEVN|...\rMSA|AA|MSG_BETA , MSA is the third segment
    const buf = Buffer.from(
      "MSH|^~\\&|R|F|S|F2|20260501101010||ACK|A1|P|2.5\rEVN|A01|20260501\rMSA|AA|MSG_BETA",
      "ascii",
    );
    expect(extractMsaControlId(buf)).toBe("MSG_BETA");
  });

  it("Test 8: returns null if no MSA segment present", () => {
    const buf = Buffer.from(
      "MSH|^~\\&|R|F|S|F2|20260501101010||ACK|A1|P|2.5\rEVN|A01|20260501",
      "ascii",
    );
    expect(extractMsaControlId(buf)).toBeNull();
  });

  it("Test 9: malformed input does not throw (Postel decoder side)", () => {
    // Truncated, garbage, empty, all return null cleanly.
    expect(() => extractMshControlId(Buffer.alloc(0))).not.toThrow();
    expect(extractMshControlId(Buffer.alloc(0))).toBeNull();
    expect(() => extractMshControlId(Buffer.from([0xff, 0xfe]))).not.toThrow();
    expect(extractMshControlId(Buffer.from([0xff, 0xfe]))).toBeNull();

    expect(() => extractMsaControlId(Buffer.alloc(0))).not.toThrow();
    expect(extractMsaControlId(Buffer.alloc(0))).toBeNull();
    expect(() => extractMsaControlId(Buffer.from("GIBBERISH"))).not.toThrow();
    expect(extractMsaControlId(Buffer.from("GIBBERISH"))).toBeNull();
    // MSA segment present but truncated mid-MSA-2
    const truncated = Buffer.from("MSH|^~\\&|R|F|S|F2|TS||T|X|P|2.5\rMSA|AA", "ascii");
    expect(() => extractMsaControlId(truncated)).not.toThrow();
    expect(extractMsaControlId(truncated)).toBeNull();
  });

  it("Test 10: extracts a printable-ASCII control ID byte-exactly", () => {
    const buf = Buffer.from(
      "MSH|^~\\&|S|F|R|F2|20260501101010||ADT^A01|abc-123_XYZ|P|2.5",
      "ascii",
    );
    expect(extractMshControlId(buf)).toBe("abc-123_XYZ");
    // Verify it would round-trip a known-ascii-safe MSA-2 too
    const ack = Buffer.from("MSH|^~\\&|R|F|S|F2|TS||ACK|A1|P|2.5\rMSA|AA|abc-123_XYZ", "ascii");
    expect(extractMsaControlId(ack)).toBe("abc-123_XYZ");
  });

  it("Test 11: helper buildMsh sanity (test-fixture self-check)", () => {
    // Sanity check on the helper used elsewhere in test fixtures so a future
    // refactor here doesn't silently change MSH layout assumptions.
    const fields = ["S", "F", "R", "F2", "20260501101010", "", "ADT^A01", "MSG_HELPER"];
    const msh = buildMsh("|", "^~\\&", fields);
    expect(extractMshControlId(Buffer.from(msh, "ascii"))).toBe("MSG_HELPER");
  });
});

// ---------------------------------------------------------------------------
// Task 2, Correlator.matchAck() controlId branch
// ---------------------------------------------------------------------------

interface ControlIdHarness {
  correlator: Correlator;
  setNow: (n: number) => void;
  getNow: () => number;
  onTimeout: ReturnType<typeof vi.fn<(entry: PendingAck, elapsedMs: number) => void>>;
  onWarning: ReturnType<
    typeof vi.fn<
      (
        code: WarningCode,
        ctx: { controlId: string | null; elapsedSinceSendMs: number; byteOffset: number },
      ) => void
    >
  >;
  onUnmatchedAck: ReturnType<typeof vi.fn<(controlId: string) => void>>;
}

function controlIdHarness(overrides?: Partial<CorrelatorOptions>): ControlIdHarness {
  let now = 1_000;
  const setNow = (n: number): void => {
    now = n;
  };
  const getNow = (): number => now;
  const onTimeout = vi.fn<(entry: PendingAck, elapsedMs: number) => void>();
  const onWarning = vi.fn<
    (
      code: WarningCode,
      ctx: {
        controlId: string | null;
        elapsedSinceSendMs: number;
        byteOffset: number;
      },
    ) => void
  >();
  const onUnmatchedAck = vi.fn<(controlId: string) => void>();
  const correlator = new Correlator({
    mode: "controlId",
    ackTimeoutMs: 100,
    onTimeout,
    onWarning,
    onUnmatchedAck,
    now: () => now,
    ...overrides,
  });
  return { correlator, setNow, getNow, onTimeout, onWarning, onUnmatchedAck };
}

describe("Correlator (controlId mode), Task 2: matchAck branch + graveyard", () => {
  it("Test 12: enqueue keys by MSH-10 string in controlId mode", () => {
    const { correlator } = controlIdHarness();
    const key = correlator.enqueue(Buffer.from("frame-A"), "MSG001", noop, noopReject);
    expect(key).toBe("MSG001");
    expect(correlator.size).toBe(1);
  });

  it("Test 13: enqueue with null controlId falls back to synthetic __seq-N (no crash)", () => {
    const { correlator } = controlIdHarness();
    const key = correlator.enqueue(Buffer.from("frame"), null, noop, noopReject);
    expect(key).toBe("__seq-1");
    expect(correlator.size).toBe(1);
  });

  it("Test 14: matchAck out-of-order, returns the entry by controlId regardless of insertion", () => {
    const { correlator } = controlIdHarness();
    const rA = vi.fn();
    const rB = vi.fn();
    const rC = vi.fn();
    correlator.enqueue(Buffer.from("A"), "A", rA, noopReject);
    correlator.enqueue(Buffer.from("B"), "B", rB, noopReject);
    correlator.enqueue(Buffer.from("C"), "C", rC, noopReject);

    const ack = Buffer.from("ACK-bytes");
    // Match B first
    const mB = correlator.matchAck(ack, "B");
    expect(mB).not.toBeNull();
    expect(mB?.controlId).toBe("B");
    expect(correlator.size).toBe(2);

    const mA = correlator.matchAck(ack, "A");
    expect(mA?.controlId).toBe("A");
    const mC = correlator.matchAck(ack, "C");
    expect(mC?.controlId).toBe("C");
    expect(correlator.size).toBe(0);
  });

  it("Test 15: matchAck unmatched controlId, fires onUnmatchedAck, returns null, no live entry touched", () => {
    const { correlator, onUnmatchedAck, onWarning } = controlIdHarness();
    const r = vi.fn();
    correlator.enqueue(Buffer.from("A"), "A", r, noopReject);

    const result = correlator.matchAck(Buffer.from("ACK"), "NOPE");
    expect(result).toBeNull();
    expect(onUnmatchedAck).toHaveBeenCalledTimes(1);
    expect(onUnmatchedAck).toHaveBeenCalledWith("NOPE");
    expect(onWarning).not.toHaveBeenCalled();
    // Live entry untouched
    expect(correlator.size).toBe(1);
    expect(r).not.toHaveBeenCalled();
  });

  it("Test 16: matchAck graveyard hit, fires MLLP_ACK_AFTER_TIMEOUT with byteOffset forwarded", () => {
    const { correlator, setNow, onWarning, onTimeout } = controlIdHarness();
    const r = vi.fn();
    correlator.enqueue(Buffer.from("A"), "A", r, noopReject);
    setNow(1_000);
    correlator.markFlushed("A");
    // Trigger timeout, entry moves to graveyard
    setNow(1_100);
    correlator.expireDue();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(correlator.size).toBe(0);
    expect(correlator.graveyardSize).toBe(1);

    // Now late ACK arrives at t=1_150 with a non-zero byteOffset (W-05 contract)
    setNow(1_150);
    const result = correlator.matchAck(Buffer.from("LATE_ACK"), "A", 4_242);
    expect(result).toBeNull();
    expect(onWarning).toHaveBeenCalledTimes(1);
    const [code, ctx] = onWarning.mock.calls[0] ?? [];
    expect(code).toBe("MLLP_ACK_AFTER_TIMEOUT");
    expect(ctx).toMatchObject({
      controlId: "A",
      elapsedSinceSendMs: 50, // 1_150 - 1_100 (timedOutAt)
      byteOffset: 4_242,
    });
    // Graveyard entry evicted after the late hit (one-shot per CLIENT-16)
    expect(correlator.graveyardSize).toBe(0);
  });

  it("Test 17: liveEntries() insertion order preserved across mixed enqueue calls", () => {
    const { correlator } = controlIdHarness();
    correlator.enqueue(Buffer.from("1"), "first", noop, noopReject);
    correlator.enqueue(Buffer.from("2"), null, noop, noopReject); // synthetic __seq-1
    correlator.enqueue(Buffer.from("3"), "third", noop, noopReject);
    const labels: string[] = [];
    for (const e of correlator.liveEntries()) labels.push(e.frame.toString());
    expect(labels).toEqual(["1", "2", "3"]);
  });

  it("Test 18: graveyard TTL, after 2 * ackTimeoutMs late ACK gets unmatched (not late)", () => {
    const { correlator, setNow, onWarning, onUnmatchedAck } = controlIdHarness();
    correlator.enqueue(Buffer.from("A"), "A", noop, noopReject);
    setNow(1_000);
    correlator.markFlushed("A");
    setNow(1_100);
    correlator.expireDue();
    expect(correlator.graveyardSize).toBe(1);

    // Wait past TTL (timedOutAt + 2 * ackTimeoutMs = 1_100 + 200 = 1_300);
    // any matchAck at >= 1_300 evicts the graveyard before checking it.
    setNow(1_300);
    const result = correlator.matchAck(Buffer.from("LATE"), "A");
    expect(result).toBeNull();
    // After eviction, the controlId is unmatched (CLIENT-15) not late (CLIENT-16).
    expect(onWarning).not.toHaveBeenCalled();
    expect(onUnmatchedAck).toHaveBeenCalledTimes(1);
    expect(onUnmatchedAck).toHaveBeenCalledWith("A");
    expect(correlator.graveyardSize).toBe(0);
  });

  it("Test 19: matchAck with controlIdFromAck=null in controlId mode, defensive unmatched path", () => {
    const { correlator, onUnmatchedAck } = controlIdHarness();
    correlator.enqueue(Buffer.from("A"), "A", noop, noopReject);
    // Caller failed to extract MSA-2; correlator should treat as unmatched.
    const result = correlator.matchAck(Buffer.from("ACK"), null);
    expect(result).toBeNull();
    // The defensive branch fires onUnmatchedAck('') so observers see the anomaly.
    expect(onUnmatchedAck).toHaveBeenCalledTimes(1);
    expect(onUnmatchedAck).toHaveBeenCalledWith("");
  });
});

// ---------------------------------------------------------------------------
// Task 3, high-bit control IDs (MLLP-CORRELATOR-ASCII)
//
// The extractors decode MSH-10 / MSA-2 as `latin1`, not `ascii`. Node's `ascii`
// codec masks the high bit (`byte & 0x7f`), which silently rewrites a control ID.
// Every test below is written to FAIL under the old `ascii` decode: the masked
// value is named and asserted against, never asserted away.
//
// Reachable when MSH-18 declares a non-ASCII charset (`8859/1` in these
// fixtures), where high-bit bytes are legal inside an ST-typed control ID.
//
// Two distinct hazards, one fixture each:
//   * 0xC9 (LATIN CAPITAL LETTER E WITH ACUTE) masks to 0x49 ('I'), an ordinary
//     printable letter. So `MSG\u00c91` and `MSGI1` are two legal, DIFFERENT wire
//     control IDs that `ascii` collapses onto ONE correlation key. That is the
//     collision the backlog item names.
//   * 0x8B masks to 0x0B, a VT, the MLLP start-block byte. `ascii` manufactures
//     a framing delimiter out of an ordinary payload byte.
// ---------------------------------------------------------------------------

/** MSH-10 `MSG\u00c91`, high-bit byte, legal under an 8859/1 charset. */
const HIGH_BIT_ID = "MSG\u00c91";
/** What `ascii` decoded HIGH_BIT_ID to (0xC9 & 0x7F === 0x49, 'I'), itself a real control ID. */
const MASKED_TWIN = "MSGI1";
/** MSH-10 whose high-bit byte 0x8B masks to 0x0B (VT) under `ascii`. */
const VT_MASKING_ID = "MSG\u008b1";

/** An HL7 v2 payload (latin1 bytes, MSH-18 = 8859/1) whose MSH-10 is `controlId`. */
function payloadWithControlId(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SENDER|FAC|RECV|FAC2|20260501101010||ADT^A01|${controlId}|P|2.5||||||8859/1\r`,
    "latin1",
  );
}

/** An HL7 v2 ACK (latin1 bytes) whose MSA-2 echoes `controlId`. */
function ackWithControlId(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RECV|FAC2|SENDER|FAC|20260501101010||ACK|ACK00001|P|2.5||||||8859/1\rMSA|AA|${controlId}\r`,
    "latin1",
  );
}

describe("Correlator (controlId mode), Task 3: high-bit control IDs", () => {
  it("Test 20: extractMshControlId preserves a high-bit MSH-10 byte verbatim", () => {
    const extracted = extractMshControlId(payloadWithControlId(HIGH_BIT_ID));
    expect(extracted).toBe(HIGH_BIT_ID);
    // `ascii` would have masked 0xC9 -> 0x49. Pin that we do NOT get that string.
    expect(extracted).not.toBe(MASKED_TWIN);
    // The extracted key re-encodes to the exact bytes that were on the wire.
    expect(Buffer.from(extracted as string, "latin1")).toEqual(
      Buffer.from([0x4d, 0x53, 0x47, 0xc9, 0x31]),
    );
  });

  it("Test 21: extractMsaControlId preserves a high-bit MSA-2 byte verbatim", () => {
    const extracted = extractMsaControlId(ackWithControlId(HIGH_BIT_ID));
    expect(extracted).toBe(HIGH_BIT_ID);
    expect(extracted).not.toBe(MASKED_TWIN);
    expect(Buffer.from(extracted as string, "latin1")).toEqual(
      Buffer.from([0x4d, 0x53, 0x47, 0xc9, 0x31]),
    );
  });

  it("Test 22: two control IDs differing solely in the high bit extract to DIFFERENT keys", () => {
    const high = extractMshControlId(payloadWithControlId(HIGH_BIT_ID));
    const masked = extractMshControlId(payloadWithControlId(MASKED_TWIN));
    expect(high).toBe(HIGH_BIT_ID);
    expect(masked).toBe(MASKED_TWIN);
    // The bug: under `ascii` both of these decoded to "MSGI1".
    expect(high).not.toBe(masked);
  });

  it("Test 23: no framing byte is synthesized, 0x8B does not decode into a VT (0x0B)", () => {
    const extracted = extractMshControlId(payloadWithControlId(VT_MASKING_ID));
    expect(extracted).toBe(VT_MASKING_ID);
    // Under `ascii` the correlation key itself would have contained the MLLP
    // start-block byte (and the same masking on an echoed ACK payload would make
    // `encodeFrame` (strict) reject the ACK outright).
    expect(extracted).not.toContain("\u000b");
    expect(Buffer.from(extracted as string, "latin1").includes(0x0b)).toBe(false);
    expect(extractMsaControlId(ackWithControlId(VT_MASKING_ID))).toBe(VT_MASKING_ID);
  });

  it("Test 24: high-bit twins do not collide in the live store, each ACK settles its own send", () => {
    const { correlator } = controlIdHarness();
    // Keys come from the real extractor over real payload bytes, so the test
    // exercises the decode rather than hand-written string keys.
    const highKey = extractMshControlId(payloadWithControlId(HIGH_BIT_ID));
    const maskedKey = extractMshControlId(payloadWithControlId(MASKED_TWIN));
    const resolveHigh = vi.fn();
    const resolveMasked = vi.fn();

    const k1 = correlator.enqueue(Buffer.from("frame-high"), highKey, resolveHigh, noopReject);
    const k2 = correlator.enqueue(
      Buffer.from("frame-masked"),
      maskedKey,
      resolveMasked,
      noopReject,
    );
    expect(k1).not.toBe(k2);
    // Under `ascii` the second enqueue OVERWROTE the first in the Map (same key)
    // and size would be 1, the first send could then never be settled by its ACK.
    expect(correlator.size).toBe(2);

    // The peer ACKs the plain-ASCII twin first; it must settle that entry only.
    const maskedAck = ackWithControlId(MASKED_TWIN);
    const m1 = correlator.matchAck(maskedAck, extractMsaControlId(maskedAck));
    expect(m1?.frame.toString()).toBe("frame-masked");
    expect(correlator.size).toBe(1);

    const highAck = ackWithControlId(HIGH_BIT_ID);
    const m2 = correlator.matchAck(highAck, extractMsaControlId(highAck));
    expect(m2?.frame.toString()).toBe("frame-high");
    expect(correlator.size).toBe(0);
  });

  it("Test 25: agrees with buildRawAck, a server-echoed MSH-10 round-trips into the same key", () => {
    // The consistency claim of this fix, across both control-ID code paths:
    // buildRawAck (server: MSH-10 -> MSA-2, latin1) and the client extractors.
    for (const id of [HIGH_BIT_ID, VT_MASKING_ID, MASKED_TWIN]) {
      const payload = payloadWithControlId(id);
      const sendKey = extractMshControlId(payload);
      const ack = buildRawAck(payload, "AA");
      const ackKey = extractMsaControlId(ack);
      expect(sendKey).toBe(id);
      expect(ackKey).toBe(sendKey);
    }
    // The ACK carries the ORIGINAL high-bit byte...
    const ack8b = buildRawAck(payloadWithControlId(VT_MASKING_ID), "AA");
    expect(ack8b.includes(0x8b)).toBe(true);
    // ...and no VT/FS was manufactured out of it, so encodeFrame accepts the ACK.
    expect(ack8b.includes(0x0b)).toBe(false);
    expect(ack8b.includes(0x1c)).toBe(false);
    expect(() => encodeFrame(ack8b)).not.toThrow();
  });
});
