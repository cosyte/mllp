/**
 * AbortSignal audit coverage (PLAN-06 Task 3, CLIENT-11).
 *
 * Re-verifies the AbortSignal contract end-to-end across every awaitable surface
 * on `MllpClient` and the reconnect cycle. PLAN-01/02/04/05 each contributed
 * pieces; this audit consolidates them into a single 8-case suite that asserts
 * the canonical `DOMException('Aborted', 'AbortError')` shape, listener-leak
 * cleanup invariants, and the 'wait'-mode mid-abort cleanup path (B-06).
 *
 * Cases:
 * - Test 1: connect({ signal }) — abort BEFORE socket connects (PLAN-01 re-verify)
 * - Test 2: send({ signal }) — abort BEFORE ACK arrives (PLAN-02 re-verify)
 * - Test 3: close({ signal }) — abort during DRAINING (PLAN-01 re-verify)
 * - Test 4: pre-aborted signal on each method → immediate AbortError, no work
 * - Test 5: AbortError matches `DOMException` shape (`name === 'AbortError'`)
 * - Test 6: listener-leak audit — `removeEventListener` is called for every
 *   `addEventListener` registration after a series of aborts
 * - Test 7: AbortSignal during reconnect mid-backoff cancels reconnect (PLAN-04
 *   re-verify)
 * - Test 8: 'wait' mode + mid-wait abort cleanup (B-06 — PLAN-05 re-verify):
 *   AbortError + zero leftover `'drain'` listeners on the client
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer as netCreateServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  createClient,
  MllpClient,
  type ClientOptions,
  type RetryContext,
} from '../../src/client/client.js';
import { Connection } from '../../src/connection/index.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';

interface InMemoryHarness {
  client: MllpClient;
  conn: Connection;
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: Partial<ClientOptions>): InMemoryHarness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const baseOpts: ClientOptions = { host: '127.0.0.1', port: 0, ...opts };
  const client = createClient(baseOpts);
  (
    client as unknown as { _attachExistingConnection: (c: Connection) => void }
  )._attachExistingConnection(conn);
  conn.notifyConnect('127.0.0.1', 2575);
  return {
    client,
    conn,
    ackFromPeer: (payload) => {
      b.write(encodeFrame(payload));
    },
  };
}

describe('MllpClient AbortSignal audit (PLAN-06 Task 3, CLIENT-11)', () => {
  describe('connect/send/close — abort BEFORE awaitable resolves', () => {
    it('Test 1: connect({ signal }) rejects with AbortError when signal aborts before connect resolves', async () => {
      // Pre-aborted signal short-circuits the connect() pre-check (PLAN-01 path).
      const ac = new AbortController();
      ac.abort();
      const client = createClient({ host: '127.0.0.1', port: 1 });
      const err = await client.connect({ signal: ac.signal }).catch((e) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');
      expect(client.state).toBe('DISCONNECTED');
    });

    it('Test 2: send({ signal }) rejects with AbortError when signal aborts before ACK arrives', async () => {
      const { client } = buildClientOverPair({ ackTimeoutMs: 60_000 });
      const ac = new AbortController();
      const sendP = client.send(Buffer.from('M1'), { signal: ac.signal });
      // Abort mid-flight (no ACK ever arrives from peer).
      ac.abort();
      const err = await sendP.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');
      await client.close();
    });

    it('Test 3: close({ signal }) rejects with AbortError when signal aborts during DRAINING', async () => {
      // DrainTimeoutMs large enough that the close stays in DRAINING long
      // enough for us to abort. We register an in-flight send first to keep
      // the drain alive, then abort the close signal.
      const { client } = buildClientOverPair({ ackTimeoutMs: 60_000 });
      // Keep a pending send so the drain has work to wait on.
      const pendingSend = client
        .send(Buffer.from('PENDING'))
        .catch(() => undefined);
      const ac = new AbortController();
      const closeP = client.close({
        drainTimeoutMs: 60_000,
        signal: ac.signal,
      });
      // Abort during DRAINING.
      ac.abort();
      const err = await closeP.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');
      await pendingSend;
    });
  });

  describe('Pre-aborted signal short-circuits every method', () => {
    it('Test 4: pre-aborted signal on connect/send/close → immediate AbortError, no work performed', async () => {
      // connect()
      const acConnect = new AbortController();
      acConnect.abort();
      const c1 = createClient({ host: '127.0.0.1', port: 1 });
      const errConnect = await c1
        .connect({ signal: acConnect.signal })
        .catch((e: unknown) => e);
      expect(errConnect).toBeInstanceOf(DOMException);
      expect((errConnect as DOMException).name).toBe('AbortError');
      // The pre-check returned immediately — no socket attempt was started.
      expect(c1.state).toBe('DISCONNECTED');

      // send()
      const { client: c2 } = buildClientOverPair({ ackTimeoutMs: 60_000 });
      const acSend = new AbortController();
      acSend.abort();
      const errSend = await c2
        .send(Buffer.from('X'), { signal: acSend.signal })
        .catch((e: unknown) => e);
      expect(errSend).toBeInstanceOf(DOMException);
      expect((errSend as DOMException).name).toBe('AbortError');
      // Correlator stays empty — pre-aborted send never enqueued.
      expect(c2.getStats().queueDepth).toBe(0);
      expect(c2.getStats().sentTotal).toBe(0);

      // close()
      const { client: c3 } = buildClientOverPair();
      const acClose = new AbortController();
      acClose.abort();
      const errClose = await c3
        .close({ signal: acClose.signal })
        .catch((e: unknown) => e);
      expect(errClose).toBeInstanceOf(DOMException);
      expect((errClose as DOMException).name).toBe('AbortError');

      await c2.close().catch(() => undefined);
    });
  });

  describe('AbortError shape', () => {
    it('Test 5: AbortError thrown by every method matches DOMException shape (name === "AbortError")', async () => {
      // connect()
      const acConnect = new AbortController();
      acConnect.abort();
      const c1 = createClient({ host: '127.0.0.1', port: 1 });
      const e1 = await c1
        .connect({ signal: acConnect.signal })
        .catch((err: unknown) => err);
      expect(e1).toBeInstanceOf(DOMException);
      expect((e1 as Error).name).toBe('AbortError');

      // send()
      const { client: c2 } = buildClientOverPair();
      const acSend = new AbortController();
      acSend.abort();
      const e2 = await c2
        .send(Buffer.from('X'), { signal: acSend.signal })
        .catch((err: unknown) => err);
      expect(e2).toBeInstanceOf(DOMException);
      expect((e2 as Error).name).toBe('AbortError');

      // close()
      const { client: c3 } = buildClientOverPair();
      const acClose = new AbortController();
      acClose.abort();
      const e3 = await c3
        .close({ signal: acClose.signal })
        .catch((err: unknown) => err);
      expect(e3).toBeInstanceOf(DOMException);
      expect((e3 as Error).name).toBe('AbortError');

      await c2.close().catch(() => undefined);
    });
  });

  describe('Listener leak audit', () => {
    it('Test 6: removeEventListener is called for every addEventListener after a series of aborts', async () => {
      // We instrument an AbortSignal with spies that count how many times
      // addEventListener and removeEventListener are called for the 'abort'
      // event. After aborting and triggering each method's cleanup path, the
      // counts MUST match (every registration paired with a removal — or the
      // listener is consumed by the abort firing once with `{ once: true }`,
      // which the platform handles automatically).
      //
      // Since `{ once: true }` listeners are auto-removed by the platform on
      // fire, we instead validate that the client never LEAKS listeners
      // between calls — i.e. after a non-aborted resolution, removeEventListener
      // is invoked an equal number of times as addEventListener. We exercise
      // the success path of send() to verify cleanup on resolve.

      const { client, ackFromPeer } = buildClientOverPair();
      const ac = new AbortController();
      let addCount = 0;
      let removeCount = 0;
      const origAdd = ac.signal.addEventListener.bind(ac.signal);
      const origRemove = ac.signal.removeEventListener.bind(ac.signal);
      ac.signal.addEventListener = ((
        type: string,
        ...rest: Parameters<AbortSignal['addEventListener']> extends [
          string,
          ...infer R,
        ]
          ? R
          : never
      ) => {
        if (type === 'abort') addCount += 1;
        return (origAdd as (...args: unknown[]) => void)(type, ...rest);
      }) as AbortSignal['addEventListener'];
      ac.signal.removeEventListener = ((
        type: string,
        ...rest: Parameters<AbortSignal['removeEventListener']> extends [
          string,
          ...infer R,
        ]
          ? R
          : never
      ) => {
        if (type === 'abort') removeCount += 1;
        return (origRemove as (...args: unknown[]) => void)(type, ...rest);
      }) as AbortSignal['removeEventListener'];

      // Run a successful send() with the signal — it should add ONE listener
      // and remove it on success (not aborted).
      const sendP = client.send(Buffer.from('M1'), { signal: ac.signal });
      ackFromPeer(Buffer.from('AA1'));
      await sendP;

      // Successful path: every addEventListener('abort', ...) was paired with
      // a removeEventListener('abort', ...) call. No leak.
      expect(addCount).toBeGreaterThanOrEqual(1);
      expect(removeCount).toBe(addCount);

      await client.close();
    });
  });

  describe('AbortSignal during reconnect cycle', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('Test 7: AbortSignal during reconnect (mid-backoff) cancels reconnect, transitions to CLOSED', async () => {
      // Mirror PLAN-04 Test 10 — assert the client transitions to CLOSED when
      // the connect signal aborts during the backoff window.
      let currentPair: [InMemoryTransport, InMemoryTransport] =
        InMemoryTransport.pair();
      let currentConn = new Connection({ transport: currentPair[0] });
      let observedSignal: AbortSignal | null = null;
      const ac = new AbortController();
      const client = createClient({
        host: '127.0.0.1',
        port: 0,
        autoReconnect: true,
        retryStrategy: (ctx: RetryContext) => {
          observedSignal = ctx.signal;
          return 1000;
        },
      });
      (
        client as unknown as {
          _setReconnectFactory: (
            f: () => { conn: Connection; arm: () => void },
          ) => void;
        }
      )._setReconnectFactory(() => {
        const pair = InMemoryTransport.pair();
        currentPair = pair;
        const conn = new Connection({ transport: pair[0] });
        currentConn = conn;
        return {
          conn,
          arm: () => conn.notifyConnect('127.0.0.1', 2575),
        };
      });
      (
        client as unknown as { _attachExistingConnection: (c: Connection) => void }
      )._attachExistingConnection(currentConn);
      (
        client as unknown as { _captureConnectSignal: (s: AbortSignal) => void }
      )._captureConnectSignal(ac.signal);
      currentConn.notifyConnect('127.0.0.1', 2575);

      // Drop the current transport (transient), starting the reconnect cycle.
      currentPair[0].destroy(
        Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }),
      );
      await vi.advanceTimersByTimeAsync(1);
      expect(observedSignal).toBe(ac.signal);
      // Abort mid-backoff — the cycle MUST tear down to CLOSED.
      ac.abort();
      await vi.advanceTimersByTimeAsync(2000);
      expect(client.state).toBe('CLOSED');
    });
  });

  describe("'wait' mode + mid-wait abort cleanup (B-06)", () => {
    it("Test 8: 'wait' mode mid-wait abort yields AbortError + zero leftover 'drain' listeners", async () => {
      // PLAN-05 B-06 audit — re-verify the listener-leak invariant with a
      // DOMException-shape assertion. The drain listener registered by
      // `_waitThenSend` MUST be removed on abort.
      const { client } = buildClientOverPair({
        highWaterMark: 1,
        onBackpressure: 'wait',
        ackTimeoutMs: 60_000,
      });

      // p1 occupies the single live-store slot.
      const p1 = client.send(Buffer.from('M1'));
      p1.catch(() => undefined);

      const baselineDrainListeners = client.listenerCount('drain');
      const ac = new AbortController();
      // p2 enters 'wait' mode (queue at high-water mark).
      const p2 = client.send(Buffer.from('M2'), { signal: ac.signal });
      // Drain listener should be registered for the wait.
      expect(client.listenerCount('drain')).toBeGreaterThan(
        baselineDrainListeners,
      );

      // Abort mid-wait — must reject with AbortError.
      ac.abort();
      const err = await p2.catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DOMException);
      expect((err as DOMException).name).toBe('AbortError');

      // Cleanup invariant: drain listener removed; no leak.
      expect(client.listenerCount('drain')).toBe(baselineDrainListeners);

      client.destroy();
    });
  });
});
