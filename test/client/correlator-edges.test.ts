/**
 * Correlator edges the client does not reach today but the correlator promises on its own:
 * its defaults, the optional sinks left unset, two-phase sends with no control ID or not yet
 * flushed, and `dispose()` on keys it does not hold. Each asserts what the caller gets back
 * or which callback fires.
 */

import { describe, expect, it, vi } from "vitest";

import { Correlator, type TwoPhaseState } from "../../src/client/correlator.js";

const noop = (): void => undefined;

function ack(code: string, controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RECV|FAC|SEND|FAC|20260101120000||ACK|A1|P|2.5\rMSA|${code}|${controlId}\r`,
    "latin1",
  );
}

function twoPhase(overrides: Partial<TwoPhaseState> = {}): TwoPhaseState {
  return {
    awaitsApplicationAck: true,
    applicationAckTimeoutMs: 500,
    onCommitReport: null,
    commitCode: null,
    commitReceivedAt: null,
    ...overrides,
  };
}

describe("Correlator defaults", () => {
  it("times a flushed send out at 30 seconds when no timeout is given", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const c = new Correlator({ onWarning: noop, onTimeout, now: () => now });
    const key = c.enqueue(Buffer.from("x"), null, noop, noop);
    if (key === null) throw new Error("enqueue refused");
    c.markFlushed(key, 0);

    now = 29_999;
    c.expireDue();
    expect(onTimeout).not.toHaveBeenCalled();
    now = 30_000;
    c.expireDue();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[1]).toBe(30_000);
  });

  it("puts no cap on sends in flight when no cap is given", () => {
    const c = new Correlator({ onWarning: noop, onTimeout: noop });
    for (let i = 0; i < 1_000; i += 1) {
      expect(c.enqueue(Buffer.from("x"), null, noop, noop)).not.toBeNull();
    }
    expect(c.size).toBe(1_000);
  });
});

describe("Correlator in control-ID mode with no unmatched-ACK sink", () => {
  it("returns null for an ACK with no readable control ID, and throws nothing", () => {
    const c = new Correlator({ mode: "controlId", onWarning: noop, onTimeout: noop });
    expect(c.matchAck(ack("AA", ""), null)).toBeNull();
  });

  it("returns null for an ACK that matches no send, and throws nothing", () => {
    const c = new Correlator({ mode: "controlId", onWarning: noop, onTimeout: noop });
    c.enqueue(Buffer.from("x"), "MSG1", noop, noop);
    expect(c.matchAck(ack("AA", "OTHER"), "OTHER")).toBeNull();
    expect(c.size).toBe(1);
  });
});

describe("Correlator: a late ACK for a timed-out send that had no control ID", () => {
  it("warns MLLP_ACK_AFTER_TIMEOUT with a null control-ID length", () => {
    let now = 0;
    const onWarning = vi.fn();
    const c = new Correlator({
      mode: "controlId",
      ackTimeoutMs: 100,
      onWarning,
      onTimeout: noop,
      now: () => now,
    });
    const key = c.enqueue(Buffer.from("x"), null, noop, noop);
    if (key === null) throw new Error("enqueue refused");
    c.markFlushed(key, 0);
    now = 100;
    c.expireDue();
    expect(c.graveyardSize).toBe(1);

    now = 150;
    // The synthetic key stands in for the absent control ID.
    expect(c.matchAck(ack("AA", String(key)), String(key), 7)).toBeNull();

    expect(onWarning).toHaveBeenCalledWith("MLLP_ACK_AFTER_TIMEOUT", {
      controlIdBytes: null,
      elapsedSinceSendMs: 50,
      byteOffset: 7,
    });
  });
});

describe("Correlator: a two-phase send", () => {
  it("settles on AA before it was flushed, with no in-flight count to give back", () => {
    const onCommitReported = vi.fn();
    const c = new Correlator({
      mode: "controlId",
      onWarning: noop,
      onTimeout: noop,
      onCommitReported,
      now: () => 0,
    });
    c.enqueue(Buffer.from("x"), "MSG1", noop, noop, twoPhase());

    const matched = c.matchAck(ack("AA", "MSG1"), "MSG1");

    expect(matched?.controlId).toBe("MSG1");
    expect(c.size).toBe(0);
    expect(c.getStats().inFlight).toBe(0);
    expect(c.disposedSize).toBe(1);
  });

  it("reports a CA with zero latency when the send was never flushed", () => {
    const onCommitReported = vi.fn();
    const c = new Correlator({
      mode: "controlId",
      onWarning: noop,
      onTimeout: noop,
      onCommitReported,
      now: () => 40,
    });
    c.enqueue(Buffer.from("x"), "MSG1", noop, noop, twoPhase());

    expect(c.matchAck(ack("CA", "MSG1"), "MSG1")).toBeNull();

    expect(onCommitReported).toHaveBeenCalledTimes(1);
    expect(onCommitReported.mock.calls[0]?.[2]).toBe(0);
  });

  it("names no control-ID length in a warning when the send had none", () => {
    const onAckModeWarning = vi.fn();
    const c = new Correlator({
      mode: "controlId",
      onWarning: noop,
      onTimeout: noop,
      onAckModeWarning,
      now: () => 0,
    });
    const key = c.enqueue(Buffer.from("x"), null, noop, noop, twoPhase());
    if (key === null) throw new Error("enqueue refused");

    expect(c.matchAck(ack("ZZ", String(key)), String(key))).toBeNull();

    expect(onAckModeWarning).toHaveBeenCalledTimes(1);
    expect(onAckModeWarning.mock.calls[0]?.[0]).toBe("MLLP_ACK_MSA1_UNCLASSIFIABLE");
    expect(onAckModeWarning.mock.calls[0]?.[1]).toMatchObject({ controlIdBytes: null });
  });

  it("falls back to onTimeout when the application wait expires and no dedicated sink is set", () => {
    let now = 0;
    const onTimeout = vi.fn();
    const c = new Correlator({
      mode: "controlId",
      ackTimeoutMs: 1_000,
      onWarning: noop,
      onTimeout,
      now: () => now,
    });
    const key = c.enqueue(Buffer.from("x"), "MSG1", noop, noop, twoPhase());
    if (key === null) throw new Error("enqueue refused");
    c.markFlushed(key, 0);
    now = 10;
    expect(c.matchAck(ack("CA", "MSG1"), "MSG1")).toBeNull();

    now = 510;
    c.expireDue();

    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(onTimeout.mock.calls[0]?.[1]).toBe(500);
    expect(c.size).toBe(0);
    expect(c.disposedSize).toBe(1);
  });
});

describe("Correlator.dispose()", () => {
  it("returns null for a key it does not hold", () => {
    const c = new Correlator({ onWarning: noop, onTimeout: noop });
    expect(c.dispose(42)).toBeNull();
  });

  it("removes a one-phase send without remembering it as disposed", () => {
    const c = new Correlator({ mode: "controlId", onWarning: noop, onTimeout: noop });
    const key = c.enqueue(Buffer.from("x"), "MSG1", noop, noop);
    if (key === null) throw new Error("enqueue refused");

    expect(c.dispose(key)?.controlId).toBe("MSG1");
    expect(c.size).toBe(0);
    expect(c.disposedSize).toBe(0);
  });
});
