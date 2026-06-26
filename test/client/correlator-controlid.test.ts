/**
 * Correlator controlId-mode tests (PLAN-03).
 *
 * Two test suites:
 *   1. MSH-10 / MSA-2 byte-level extractors (Task 1)
 *   2. Correlator.matchAck() controlId branch incl. graveyard hit + unmatched (Task 2)
 *
 * Pure data-structure tests over an injected fake clock — no real timers.
 */

import { describe, it, expect, vi } from "vitest";
import {
  Correlator,
  extractMshControlId,
  extractMsaControlId,
} from "../../src/client/correlator.js";
import type { CorrelatorOptions, PendingAck } from "../../src/client/correlator.js";
import type { WarningCode } from "../../src/framing/index.js";

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

describe("Correlator (controlId mode) — Task 1: MSH-10 / MSA-2 extractors", () => {
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
    // MSH|^~\&|S|F|R|F2|TS||TYPE^TRG||REST  — MSH-10 is empty (between || at end)
    const buf = Buffer.from("MSH|^~\\&|S|F|R|F2|20260501101010||ADT^A01||P|2.5", "ascii");
    expect(extractMshControlId(buf)).toBeNull();
  });

  it("Test 5: returns null if MSH has fewer than 10 fields", () => {
    // Only 7 fields after MSH — truncated header
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

  it("Test 7: handles segment separators — MSA after MSH and other segments", () => {
    // MSH...\rEVN|...\rMSA|AA|MSG_BETA  — MSA is the third segment
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

  it("Test 10: extracts ASCII (control IDs are documented ASCII-only)", () => {
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
// Task 2 — Correlator.matchAck() controlId branch
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

describe("Correlator (controlId mode) — Task 2: matchAck branch + graveyard", () => {
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

  it("Test 14: matchAck out-of-order — returns the entry by controlId regardless of insertion", () => {
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

  it("Test 15: matchAck unmatched controlId — fires onUnmatchedAck, returns null, no live entry touched", () => {
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

  it("Test 16: matchAck graveyard hit — fires MLLP_ACK_AFTER_TIMEOUT with byteOffset forwarded", () => {
    const { correlator, setNow, onWarning, onTimeout } = controlIdHarness();
    const r = vi.fn();
    correlator.enqueue(Buffer.from("A"), "A", r, noopReject);
    setNow(1_000);
    correlator.markFlushed("A");
    // Trigger timeout — entry moves to graveyard
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

  it("Test 18: graveyard TTL — after 2 * ackTimeoutMs late ACK gets unmatched (not late)", () => {
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

  it("Test 19: matchAck with controlIdFromAck=null in controlId mode — defensive unmatched path", () => {
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
