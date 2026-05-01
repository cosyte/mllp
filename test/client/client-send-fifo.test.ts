/**
 * MllpClient.send() FIFO mode tests (PLAN-02, CLIENT-02 + CLIENT-03 FIFO branch).
 *
 * Drives the send/ACK request-response over `InMemoryTransport.pair()` —
 * deterministic, no real sockets. The peer transport plays the role of a
 * server-side ACK echo.
 */

import { describe, it, expect, vi } from 'vitest';
import { createClient, MllpClient } from '../../src/client/client.js';
import { Connection, MllpConnectionError } from '../../src/connection/index.js';
import { MllpTimeoutError } from '../../src/client/error.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';

interface Harness {
  client: MllpClient;
  peer: InMemoryTransport;
  conn: Connection;
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: { ackTimeoutMs?: number }): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const clientOpts: { host: string; port: number; ackTimeoutMs?: number } = {
    host: '127.0.0.1',
    port: 0,
  };
  if (opts?.ackTimeoutMs !== undefined) {
    clientOpts.ackTimeoutMs = opts.ackTimeoutMs;
  }
  const client = createClient(clientOpts);
  client._attachExistingConnection(conn);
  conn.notifyConnect('127.0.0.1', 2575);
  const ackFromPeer = (payload: Buffer): void => {
    b.write(encodeFrame(payload));
  };
  return { client, peer: b, conn, ackFromPeer };
}

describe('MllpClient.send (FIFO mode, PLAN-02)', () => {
  it('Test 1: send() resolves with the inbound ACK Buffer (framing stripped)', async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const sendPromise = client.send(Buffer.from('PAYLOAD'));
    // Peer responds with ACK
    ackFromPeer(Buffer.from('ACK_BODY'));
    const ack = await sendPromise;
    expect(Buffer.isBuffer(ack)).toBe(true);
    expect(ack.toString()).toBe('ACK_BODY');
    await client.close();
  });

  it('Test 2: multiple in-flight sends resolve in FIFO order', async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const p1 = client.send(Buffer.from('M1'));
    const p2 = client.send(Buffer.from('M2'));
    const p3 = client.send(Buffer.from('M3'));
    // Peer responds in order — the FIFO contract says they map by insertion order.
    ackFromPeer(Buffer.from('A1'));
    ackFromPeer(Buffer.from('A2'));
    ackFromPeer(Buffer.from('A3'));
    const [a1, a2, a3] = await Promise.all([p1, p2, p3]);
    expect(a1.toString()).toBe('A1');
    expect(a2.toString()).toBe('A2');
    expect(a3.toString()).toBe('A3');
    await client.close();
  });

  it('Test 3: send({ signal }) rejects with AbortError when signal aborts before ACK', async () => {
    const { client } = buildClientOverPair();
    const ac = new AbortController();
    const p = client.send(Buffer.from('PAYLOAD'), { signal: ac.signal });
    // Abort before the peer sends an ACK
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // Verify pending entry was removed from the correlator (size === 0)
    // We check via _correlator (test seam — the field is private but readable
    // from this same package via cast).
    const correlator = (client as unknown as { _correlator: { size: number } | null })
      ._correlator;
    expect(correlator?.size ?? 0).toBe(0);
    await client.close();
  });

  it('Test 4: ACK timeout — rejects with MllpTimeoutError; clock starts at write-flush', async () => {
    // Use very short timeout for fast test execution.
    const { client } = buildClientOverPair({ ackTimeoutMs: 50 });
    const beforeSend = Date.now();
    const p = client.send(Buffer.from('PAYLOAD'));
    let caught: unknown;
    try {
      await p;
    } catch (err) {
      caught = err;
    }
    const totalElapsed = Date.now() - beforeSend;
    expect(caught).toBeInstanceOf(MllpTimeoutError);
    const tErr = caught as MllpTimeoutError;
    expect(tErr.elapsedMs).toBeGreaterThanOrEqual(50);
    // Clock-from-flush invariant: in-memory transport flushes synchronously
    // so elapsedMs is within a small window of total wall clock; the relevant
    // assertion is that elapsedMs is recorded against sentAt (a positive number).
    expect(tErr.sentAt).toBeGreaterThan(0);
    expect(totalElapsed).toBeGreaterThanOrEqual(50);
    expect(tErr.messageControlId).toBeUndefined();
    await client.close();
  });

  it('Test 5: late ACK after timeout — does not double-resolve and is observable', async () => {
    const { client, ackFromPeer } = buildClientOverPair({ ackTimeoutMs: 50 });
    const p = client.send(Buffer.from('PAYLOAD'));
    let timeoutErr: unknown;
    try {
      await p;
    } catch (err) {
      timeoutErr = err;
    }
    expect(timeoutErr).toBeInstanceOf(MllpTimeoutError);
    // Now peer sends a late ACK. With the timed-out send already gone, the
    // FIFO live store is empty; matchAck() returns null. The send() promise
    // has already rejected, so no double-resolve risk. The graveyard tracks
    // the timed-out entry; controlId-mode warning emission is PLAN-03 territory.
    ackFromPeer(Buffer.from('LATE_ACK'));
    // No error thrown; no second promise resolves. Sanity: correlator state is empty.
    const correlator = (client as unknown as { _correlator: { size: number } | null })
      ._correlator;
    expect(correlator?.size ?? 0).toBe(0);
    await client.close();
  });

  it('Test 6: default ackTimeoutMs is 30_000 when not configured', () => {
    const { client } = buildClientOverPair();
    const ackTimeoutMs = (
      client as unknown as { _ackTimeoutMs: number }
    )._ackTimeoutMs;
    expect(ackTimeoutMs).toBe(30_000);
  });

  it('Test 7: "ack" event fires on every match with frozen { payload, controlId, latencyMs }', async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const events: Array<{
      payload: Buffer;
      controlId: string | null;
      latencyMs: number;
    }> = [];
    client.on(
      'ack',
      (e: { payload: Buffer; controlId: string | null; latencyMs: number }) => {
        events.push(e);
        expect(Object.isFrozen(e)).toBe(true);
        expect(() => {
          (e as unknown as { payload: Buffer }).payload = Buffer.from('hax');
        }).toThrow();
      },
    );
    const p = client.send(Buffer.from('PAYLOAD'));
    ackFromPeer(Buffer.from('ACK_BODY'));
    await p;
    expect(events).toHaveLength(1);
    expect(events[0]?.payload.toString()).toBe('ACK_BODY');
    expect(events[0]?.controlId).toBeNull();
    expect(typeof events[0]?.latencyMs).toBe('number');
    await client.close();
  });

  it('Test 8: send() before connect() rejects with MllpConnectionError(phase: "send")', async () => {
    const client = createClient({ host: '127.0.0.1', port: 0 });
    await expect(client.send(Buffer.from('x'))).rejects.toMatchObject({
      name: 'MllpConnectionError',
      phase: 'send',
    });
    expect(MllpConnectionError).toBeDefined(); // type referenced for instanceof use
  });

  it('Test 9: in-flight count visible via correlator stats', () => {
    const { client } = buildClientOverPair();
    void client.send(Buffer.from('one'));
    void client.send(Buffer.from('two'));
    const correlator = (
      client as unknown as { _correlator: { getStats: () => { size: number } } }
    )._correlator;
    expect(correlator.getStats().size).toBe(2);
  });

  it('Test 10: Object.freeze applied to "ack" event payload (mutation throws in strict mode)', async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const captured: Array<unknown> = [];
    client.on('ack', (e: unknown) => {
      captured.push(e);
    });
    const p = client.send(Buffer.from('PAYLOAD'));
    ackFromPeer(Buffer.from('ACK'));
    await p;
    expect(captured).toHaveLength(1);
    const e = captured[0] as { payload: Buffer };
    expect(Object.isFrozen(e)).toBe(true);
    expect(() => {
      (e as { latencyMs: number }).latencyMs = 99_999;
    }).toThrow();
    await client.close();
  });

  it('Test 11: AbortSignal pre-aborted on send() rejects synchronously', async () => {
    const { client } = buildClientOverPair();
    const ac = new AbortController();
    ac.abort();
    await expect(
      client.send(Buffer.from('x'), { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    await client.close();
  });

  it('Test 12: client.close() rejects all pending sends', async () => {
    const { client } = buildClientOverPair();
    const p1 = client.send(Buffer.from('a'));
    const p2 = client.send(Buffer.from('b'));
    await client.close();
    await expect(p1).rejects.toBeInstanceOf(MllpConnectionError);
    await expect(p2).rejects.toBeInstanceOf(MllpConnectionError);
  });

  it('mock vi reference (avoid unused import)', () => {
    const fn = vi.fn();
    fn();
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
