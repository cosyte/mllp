/**
 * Correlator pure-data-structure tests (PLAN-02, D-03/A1).
 *
 * Drives the unified Map<correlationKey, PendingAck> + graveyard via an
 * injected fake clock — no real timers, no I/O, no FSM.
 */

import { describe, it, expect, vi } from 'vitest';
import { Correlator } from '../../src/client/correlator.js';
import type {
  CorrelatorOptions,
  PendingAck,
} from '../../src/client/correlator.js';
import type { WarningCode, MllpWarning } from '../../src/framing/index.js';

interface Harness {
  correlator: Correlator;
  setNow: (n: number) => void;
  getNow: () => number;
  onTimeout: ReturnType<typeof vi.fn>;
  onWarning: ReturnType<typeof vi.fn>;
  onUnmatchedAck: ReturnType<typeof vi.fn>;
}

function harness(overrides?: Partial<CorrelatorOptions>): Harness {
  let now = 1_000;
  const setNow = (n: number): void => {
    now = n;
  };
  const getNow = (): number => now;
  const onTimeout = vi.fn<(entry: PendingAck, elapsedMs: number) => void>();
  const onWarning =
    vi.fn<
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
    mode: 'fifo',
    ackTimeoutMs: 1_000,
    onTimeout,
    onWarning,
    onUnmatchedAck,
    now: () => now,
    ...overrides,
  });
  return { correlator, setNow, getNow, onTimeout, onWarning, onUnmatchedAck };
}

const noop = (): void => {
  /* noop */
};
const noopReject = (_err: Error): void => {
  /* noop */
};

describe('Correlator (PLAN-02 FIFO mode)', () => {
  it('Test 1: enqueue() returns the assigned correlationKey, increments size + queueBytes', () => {
    const { correlator } = harness();
    const frame = Buffer.from([0x0b, 0x41, 0x42, 0x1c, 0x0d]);
    const key = correlator.enqueue(frame, null, noop, noopReject);
    expect(key).not.toBeNull();
    expect(typeof key).toBe('number');
    expect(correlator.size).toBe(1);
    expect(correlator.queueBytes).toBe(frame.length);
  });

  it('Test 2: markFlushed() records sentAt for the entry', () => {
    const { correlator, setNow } = harness();
    const frame = Buffer.from([0x0b, 0x41, 0x1c, 0x0d]);
    const key = correlator.enqueue(frame, null, noop, noopReject);
    expect(key).not.toBeNull();
    setNow(2_500);
    correlator.markFlushed(key as number);
    // No public sentAt accessor; verify indirectly via expireDue() at the
    // exact threshold so the entry expires only after sentAt + ackTimeoutMs.
    setNow(3_499);
    correlator.expireDue();
    expect(correlator.size).toBe(1);
    setNow(3_500);
    correlator.expireDue();
    expect(correlator.size).toBe(0);
  });

  it('Test 3: matchAck() returns first pending entry in FIFO insertion order', () => {
    const { correlator } = harness();
    const f1 = Buffer.from('one');
    const f2 = Buffer.from('two');
    const f3 = Buffer.from('three');
    const r1 = vi.fn();
    const r2 = vi.fn();
    const r3 = vi.fn();
    correlator.enqueue(f1, null, r1, noopReject);
    correlator.enqueue(f2, null, r2, noopReject);
    correlator.enqueue(f3, null, r3, noopReject);

    const ack = Buffer.from('ACK');
    const m1 = correlator.matchAck(ack);
    expect(m1).not.toBeNull();
    expect(m1?.frame.toString()).toBe('one');
    expect(correlator.size).toBe(2);

    const m2 = correlator.matchAck(ack);
    expect(m2?.frame.toString()).toBe('two');
    expect(correlator.size).toBe(1);

    const m3 = correlator.matchAck(ack);
    expect(m3?.frame.toString()).toBe('three');
    expect(correlator.size).toBe(0);

    expect(correlator.matchAck(ack)).toBeNull();
  });

  it('Test 4: expireDue() fires onTimeout and moves entries to graveyard', () => {
    const { correlator, setNow, onTimeout } = harness();
    const frame = Buffer.from('x');
    const key = correlator.enqueue(frame, null, noop, noopReject);
    expect(key).not.toBeNull();
    setNow(1_000);
    correlator.markFlushed(key as number);

    // Just before expiry — nothing fires
    setNow(1_999);
    correlator.expireDue();
    expect(onTimeout).not.toHaveBeenCalled();
    expect(correlator.size).toBe(1);
    expect(correlator.graveyardSize).toBe(0);

    // At threshold (sentAt + ackTimeoutMs <= now) — expires
    setNow(2_000);
    correlator.expireDue();
    expect(onTimeout).toHaveBeenCalledTimes(1);
    const [entry, elapsed] = onTimeout.mock.calls[0] ?? [];
    expect((entry as PendingAck).frame).toBe(frame);
    expect(elapsed).toBe(1_000);
    expect(correlator.size).toBe(0);
    expect(correlator.graveyardSize).toBe(1);
  });

  it('Test 5: matchAck() after expiry — late ACK in FIFO returns null cleanly', () => {
    // FIFO graveyard semantics: matchAck pulls from the head of the live store.
    // After all sends have expired, no live entries exist, so matchAck returns null.
    // (The MLLP_ACK_AFTER_TIMEOUT code is emitted by the controlId-mode graveyard
    // hit path in PLAN-03; in FIFO mode the warning is fired by MllpClient via the
    // onWarning callback when we observe a late ACK after a timeout.)
    const { correlator, setNow } = harness();
    const frame = Buffer.from('x');
    const key = correlator.enqueue(frame, null, noop, noopReject);
    setNow(1_000);
    correlator.markFlushed(key as number);
    setNow(2_000);
    correlator.expireDue();
    expect(correlator.size).toBe(0);
    expect(correlator.graveyardSize).toBe(1);

    const result = correlator.matchAck(Buffer.from('ACK'));
    expect(result).toBeNull();
  });

  it('Test 6: graveyard entries evict lazily after 2 * ackTimeoutMs', () => {
    const { correlator, setNow } = harness();
    const frame = Buffer.from('x');
    const key = correlator.enqueue(frame, null, noop, noopReject);
    setNow(1_000);
    correlator.markFlushed(key as number);
    setNow(2_000);
    correlator.expireDue();
    expect(correlator.graveyardSize).toBe(1);

    // matchAck triggers lazy eviction. Just before threshold (timedOutAt + 2 * ackTimeoutMs).
    setNow(3_999);
    correlator.matchAck(Buffer.from('ACK'));
    expect(correlator.graveyardSize).toBe(1);

    // At threshold — graveyard entry evicted.
    setNow(4_000);
    correlator.matchAck(Buffer.from('ACK'));
    expect(correlator.graveyardSize).toBe(0);
  });

  it('Test 7: getStats() returns plain JSON-serializable object', () => {
    const { correlator } = harness();
    const f1 = Buffer.alloc(10);
    const f2 = Buffer.alloc(20);
    correlator.enqueue(f1, null, noop, noopReject);
    correlator.enqueue(f2, null, noop, noopReject);

    const stats = correlator.getStats();
    expect(stats).toEqual({
      size: 2,
      queueBytes: 30,
      graveyardSize: 0,
      sendSeq: 2,
    });
    // Round-trip through JSON to verify serializable
    expect(JSON.parse(JSON.stringify(stats))).toEqual(stats);
  });

  it('Test 8: clear(reason) walks live entries in insertion order and rejects them', () => {
    const { correlator } = harness();
    const reasons: Error[] = [];
    const order: string[] = [];
    const mkReject = (label: string) => (err: Error): void => {
      order.push(label);
      reasons.push(err);
    };
    correlator.enqueue(Buffer.from('a'), null, noop, mkReject('a'));
    correlator.enqueue(Buffer.from('b'), null, noop, mkReject('b'));
    correlator.enqueue(Buffer.from('c'), null, noop, mkReject('c'));

    const reason = new Error('clear test');
    correlator.clear(reason);
    expect(order).toEqual(['a', 'b', 'c']);
    for (const r of reasons) expect(r).toBe(reason);
    expect(correlator.size).toBe(0);
    expect(correlator.queueBytes).toBe(0);
  });

  it('Test 9: maxInFlight=1 makes enqueue() return null when at capacity', () => {
    const { correlator } = harness({ maxInFlight: 1 });
    const k1 = correlator.enqueue(Buffer.from('a'), null, noop, noopReject);
    expect(k1).not.toBeNull();
    const k2 = correlator.enqueue(Buffer.from('b'), null, noop, noopReject);
    expect(k2).toBeNull();
    // After matching the in-flight entry, enqueue() succeeds again.
    correlator.matchAck(Buffer.from('ACK'));
    const k3 = correlator.enqueue(Buffer.from('c'), null, noop, noopReject);
    expect(k3).not.toBeNull();
  });

  it('Test 10: no real timers are armed by Correlator (timer-free per D-03)', () => {
    // Spy on global timer constructors before constructing the Correlator.
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const { correlator, setNow } = harness();
      correlator.enqueue(Buffer.from('a'), null, noop, noopReject);
      setNow(2_000);
      correlator.expireDue();
      correlator.matchAck(Buffer.from('ACK'));
      correlator.clear(new Error('done'));
      expect(setTimeoutSpy).not.toHaveBeenCalled();
      expect(setIntervalSpy).not.toHaveBeenCalled();
    } finally {
      setTimeoutSpy.mockRestore();
      setIntervalSpy.mockRestore();
    }
  });

  it('Test 11: liveEntries() yields entries in insertion order', () => {
    const { correlator } = harness();
    correlator.enqueue(Buffer.from('first'), null, noop, noopReject);
    correlator.enqueue(Buffer.from('second'), null, noop, noopReject);
    correlator.enqueue(Buffer.from('third'), null, noop, noopReject);
    const labels: string[] = [];
    for (const entry of correlator.liveEntries()) {
      labels.push(entry.frame.toString());
    }
    expect(labels).toEqual(['first', 'second', 'third']);
  });

  it('Test 12: remove(key) removes a live entry without resolving/rejecting; returns it', () => {
    const { correlator } = harness();
    const resolved = vi.fn();
    const rejected = vi.fn();
    const key = correlator.enqueue(Buffer.from('x'), null, resolved, rejected);
    expect(key).not.toBeNull();

    const removed = correlator.remove(key as number);
    expect(removed).not.toBeNull();
    expect(removed?.frame.toString()).toBe('x');
    expect(correlator.size).toBe(0);
    expect(correlator.queueBytes).toBe(0);
    expect(resolved).not.toHaveBeenCalled();
    expect(rejected).not.toHaveBeenCalled();

    // Removing a non-existent key returns null
    expect(correlator.remove(9_999)).toBeNull();
  });

  it('warnings: unused onWarning is wired but not fired in pure FIFO mode (sanity)', () => {
    const { correlator, onWarning } = harness();
    correlator.enqueue(Buffer.from('a'), null, noop, noopReject);
    correlator.matchAck(Buffer.from('ACK'));
    expect(onWarning).not.toHaveBeenCalled();
    // Reference the type so an unused MllpWarning import would be flagged — used here as a no-op type assertion.
    const _w: MllpWarning | undefined = undefined;
    expect(_w).toBeUndefined();
  });
});
