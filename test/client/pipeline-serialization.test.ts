/**
 * MllpClient pipeline:false serialization tests (PLAN-05, CLIENT-19, D-06, D-10).
 *
 * Verifies that `pipeline: false` collapses the in-flight set to ≤1 by setting
 * the unified Correlator's `maxInFlight=1` (D-06). Sends issued while a prior
 * ACK is pending wait for drain before they reach the wire.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient, MllpClient } from '../../src/client/client.js';
import { Connection } from '../../src/connection/index.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';
import type { ClientOptions } from '../../src/client/client.js';

interface Harness {
  client: MllpClient;
  peerSink: () => Buffer[];
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: Partial<ClientOptions>): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const baseOpts: ClientOptions = { host: '127.0.0.1', port: 0, ...opts };
  const client = createClient(baseOpts);
  (
    client as unknown as { _attachExistingConnection: (c: Connection) => void }
  )._attachExistingConnection(conn);
  conn.notifyConnect('127.0.0.1', 2575);
  const observed: Buffer[] = [];
  b.onData((chunk: Buffer) => {
    observed.push(Buffer.from(chunk));
  });
  return {
    client,
    peerSink: () => observed,
    ackFromPeer: (payload) => {
      b.write(encodeFrame(payload));
    },
  };
}

describe('MllpClient pipeline:false (PLAN-05, CLIENT-19, D-06)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Test 10: pipeline:false serializes sends — only one in-flight at a time', async () => {
    const { client, peerSink, ackFromPeer } = buildClientOverPair({
      pipeline: false,
      ackTimeoutMs: 60_000,
    });
    const p1 = client.send(Buffer.from('M1'));
    const p2 = client.send(Buffer.from('M2'));
    const p3 = client.send(Buffer.from('M3'));
    // Only the first send should have hit the wire.
    await vi.advanceTimersByTimeAsync(1);
    expect(peerSink().length).toBe(1);
    ackFromPeer(Buffer.from('A1'));
    await vi.advanceTimersByTimeAsync(1);
    expect(peerSink().length).toBe(2);
    ackFromPeer(Buffer.from('A2'));
    await vi.advanceTimersByTimeAsync(1);
    expect(peerSink().length).toBe(3);
    ackFromPeer(Buffer.from('A3'));
    await vi.advanceTimersByTimeAsync(1);
    const [a1, a2, a3] = await Promise.all([p1, p2, p3]);
    expect(a1.toString()).toBe('A1');
    expect(a2.toString()).toBe('A2');
    expect(a3.toString()).toBe('A3');
    await client.close();
  });

  it('Test 11: pipeline:false + ackTimeoutMs expiry frees the in-flight slot', async () => {
    const { client, peerSink, ackFromPeer } = buildClientOverPair({
      pipeline: false,
      ackTimeoutMs: 100,
    });
    const p1 = client.send(Buffer.from('M1'));
    const p1Settled = p1.catch((err: unknown) => err);
    const p2 = client.send(Buffer.from('M2'));
    // Only M1 on the wire initially.
    await vi.advanceTimersByTimeAsync(1);
    expect(peerSink().length).toBe(1);
    // Advance past M1's timeout — M1 expires; slot frees → M2 flushes.
    // Stop short of M2's own timeout (M2 is sent at ~100ms; its timeout
    // would fire at ~200ms, so 150ms is the safe assertion window).
    await vi.advanceTimersByTimeAsync(150);
    await expect(p1).rejects.toMatchObject({ name: 'MllpTimeoutError' });
    void p1Settled;
    expect(peerSink().length).toBe(2);
    // ACK M2 before its own timeout would fire.
    ackFromPeer(Buffer.from('A2'));
    await vi.advanceTimersByTimeAsync(1);
    const a2 = await p2;
    expect(a2.toString()).toBe('A2');
    await client.close();
  });

  it('Test 12: default pipeline:true preserves PLAN-02 parallel behavior', async () => {
    const { client, peerSink, ackFromPeer } = buildClientOverPair({
      ackTimeoutMs: 60_000,
    });
    const p1 = client.send(Buffer.from('M1'));
    const p2 = client.send(Buffer.from('M2'));
    const p3 = client.send(Buffer.from('M3'));
    await vi.advanceTimersByTimeAsync(1);
    // All three should be on the wire concurrently.
    expect(peerSink().length).toBe(3);
    ackFromPeer(Buffer.from('A1'));
    ackFromPeer(Buffer.from('A2'));
    ackFromPeer(Buffer.from('A3'));
    await vi.advanceTimersByTimeAsync(1);
    const [a1, a2, a3] = await Promise.all([p1, p2, p3]);
    expect(a1.toString()).toBe('A1');
    expect(a2.toString()).toBe('A2');
    expect(a3.toString()).toBe('A3');
    await client.close();
  });

  it('Test 13: pipeline:false sets Correlator maxInFlight=1', async () => {
    const { client, ackFromPeer } = buildClientOverPair({ pipeline: false });
    const p1 = client.send(Buffer.from('M1'));
    const p2 = client.send(Buffer.from('M2'));
    const corr = (
      client as unknown as { _correlator: { size: number } | null }
    )._correlator;
    // Only one entry should be in the live store at any time.
    expect(corr).not.toBeNull();
    expect(corr!.size).toBe(1);
    ackFromPeer(Buffer.from('A1'));
    await vi.advanceTimersByTimeAsync(1);
    expect(corr!.size).toBe(1);
    ackFromPeer(Buffer.from('A2'));
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all([p1, p2]);
    await client.close();
  });
});
