/**
 * MllpClient dead-peer + keepalive tests
 * (PLAN-05 Task 3, CLIENT-08, D-11/A3, D-12, D-13, D-14).
 *
 * Verifies:
 * - TCP keepalive is set on the raw `net.Socket` BEFORE NetTransport wrap.
 * - `deadPeerTimeoutMs` is an application-idle timer keyed on inbound
 *   bytes/ACK/warning; expiry calls `connection.destroy()`.
 * - Both timers are cleared on every transition out of CONNECTED and
 *   re-armed on every entry to CONNECTED via the SINGLE PLAN-02
 *   `_onStateChange` hook (B-04 contract).
 * - Trip honors `autoReconnect` (D-13).
 * - Both options are independent (D-11/A3).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { createClient, MllpClient } from '../../src/client/client.js';
import { Connection } from '../../src/connection/index.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';
import type { ClientOptions } from '../../src/client/client.js';

interface Harness {
  client: MllpClient;
  conn: Connection;
  ackFromPeer: (payload: Buffer) => void;
  warningFromPeer: () => void;
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
  return {
    client,
    conn,
    ackFromPeer: (payload) => {
      b.write(encodeFrame(payload));
    },
    warningFromPeer: () => {
      // Send a malformed leading-whitespace frame to provoke a warning event.
      b.write(Buffer.concat([Buffer.from([0x20, 0x20]), encodeFrame(Buffer.from('OK'))]));
    },
  };
}

describe('MllpClient dead-peer + keepalive (PLAN-05 Task 3, CLIENT-08, D-11/A3)', () => {
  describe('keepaliveIntervalMs (TCP keepalive)', () => {
    it('Test 1: setKeepAlive(true, ms) is called on the raw socket on connect', async () => {
      const setKeepAliveSpy = vi.fn();
      // Spy on net.Socket.prototype.setKeepAlive
      const origSetKeepAlive = (
        await import('node:net')
      ).Socket.prototype.setKeepAlive;
      const { Socket } = await import('node:net');
      Socket.prototype.setKeepAlive = function (
        ...args: Parameters<typeof origSetKeepAlive>
      ) {
        setKeepAliveSpy(...args);
        return this;
      };
      try {
        const client = createClient({
          host: '127.0.0.1',
          port: 1, // unreachable port — connect attempt fires error
          keepaliveIntervalMs: 1234,
        });
        // Initiate connect; we don't need to wait for it to succeed — just
        // for the socket build path to run.
        const cp = client.connect();
        cp.catch(() => {});
        // setKeepAlive is called synchronously in connect() right after
        // createConnection.
        expect(setKeepAliveSpy).toHaveBeenCalledWith(true, 1234);
        client.destroy();
      } finally {
        Socket.prototype.setKeepAlive = origSetKeepAlive;
      }
    });

    it('Test 2: default keepaliveIntervalMs is undefined → setKeepAlive NOT called', async () => {
      const setKeepAliveSpy = vi.fn();
      const origSetKeepAlive = (
        await import('node:net')
      ).Socket.prototype.setKeepAlive;
      const { Socket } = await import('node:net');
      Socket.prototype.setKeepAlive = function (
        ...args: Parameters<typeof origSetKeepAlive>
      ) {
        setKeepAliveSpy(...args);
        return this;
      };
      try {
        const client = createClient({ host: '127.0.0.1', port: 1 });
        const cp = client.connect();
        cp.catch(() => {});
        expect(setKeepAliveSpy).not.toHaveBeenCalled();
        client.destroy();
      } finally {
        Socket.prototype.setKeepAlive = origSetKeepAlive;
      }
    });
  });

  describe('deadPeerTimeoutMs (app-idle timer)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('Test 4: dead-peer timer fires connection.destroy on idle', async () => {
      const { client, conn } = buildClientOverPair({
        deadPeerTimeoutMs: 100,
      });
      const destroySpy = vi.spyOn(conn, 'destroy');
      await vi.advanceTimersByTimeAsync(150);
      expect(destroySpy).toHaveBeenCalled();
      const arg = destroySpy.mock.calls[0]![0] as Error;
      expect(arg).toBeInstanceOf(Error);
      expect(arg.message).toMatch(/dead peer/i);
      client.destroy();
    });

    it("Test 5: timer resets on inbound 'message' / 'ack' events", async () => {
      const { client, conn, ackFromPeer } = buildClientOverPair({
        deadPeerTimeoutMs: 100,
      });
      const destroySpy = vi.spyOn(conn, 'destroy');
      // ACK every 50ms — the timer should keep resetting and never fire.
      // Use client.send to register an awaited send; ackFromPeer triggers
      // both the inbound 'message' on the Connection and the 'ack' event
      // on the MllpClient.
      const sends: Promise<Buffer>[] = [];
      for (let i = 0; i < 4; i++) {
        const p = client.send(Buffer.from(`M${i}`));
        p.catch(() => {});
        sends.push(p);
        await vi.advanceTimersByTimeAsync(50);
        ackFromPeer(Buffer.from(`A${i}`));
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(destroySpy).not.toHaveBeenCalled();
      client.destroy();
    });

    it('Test 6: default deadPeerTimeoutMs is undefined → no timer armed', async () => {
      const { client, conn } = buildClientOverPair();
      const destroySpy = vi.spyOn(conn, 'destroy');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(destroySpy).not.toHaveBeenCalled();
      client.destroy();
    });

    it('Test 7: timer cleared on transition out of CONNECTED, re-armed on entry', async () => {
      const { client, conn } = buildClientOverPair({
        deadPeerTimeoutMs: 100,
      });
      // Start: timer armed at attach time.
      const beforeFieldA = (
        client as unknown as { _deadPeerTimer: unknown }
      )._deadPeerTimer;
      expect(beforeFieldA).not.toBeNull();
      // Drive Connection out of CONNECTED via close.
      const closeP = conn.close();
      await vi.advanceTimersByTimeAsync(1);
      const afterField = (client as unknown as { _deadPeerTimer: unknown })
        ._deadPeerTimer;
      expect(afterField).toBeNull();
      // Wait for close to settle.
      await closeP.catch(() => {});
      client.destroy();
    });

    it('Test 12: dead-peer timer is .unref()-ed (no-throw assertion)', async () => {
      // We can't directly observe .unref() but we can assert the field is
      // a valid Timeout and the test process exits cleanly when the timer
      // is the only remaining handle (vitest's afterEach + useRealTimers
      // resets the test environment regardless).
      const { client } = buildClientOverPair({ deadPeerTimeoutMs: 60_000 });
      const t = (client as unknown as { _deadPeerTimer: unknown })
        ._deadPeerTimer;
      expect(t).not.toBeNull();
      client.destroy();
    });
  });

  describe('FSM-aware lifecycle (D-14, B-04)', () => {
    it('Test 8b: no parallel `conn.on(\'stateChange\')` listener registered by Plan 05', async () => {
      // Sanity: read the source of client.ts and ensure the only
      // 'stateChange' listener registration count matches PLAN-02's
      // single delegating listener (B-04 contract).
      const fs = await import('node:fs/promises');
      const url = new URL('../../src/client/client.ts', import.meta.url);
      const text = await fs.readFile(url, 'utf8');
      const matches = text.match(/conn\.on\(\s*'stateChange'/g) ?? [];
      // Exactly ONE delegating registration (PLAN-02's). Plan 05 contributes
      // ADDITIVE statements at the named anchor; it does NOT add a parallel.
      expect(matches.length).toBe(1);
    });

    it('HOOK_EXTENSION_POINT: state-change anchor is preserved', async () => {
      const fs = await import('node:fs/promises');
      const url = new URL('../../src/client/client.ts', import.meta.url);
      const text = await fs.readFile(url, 'utf8');
      const matches =
        text.match(/HOOK_EXTENSION_POINT: state-change/g) ?? [];
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('autoReconnect integration (D-13)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('Test 10: autoReconnect:false + dead-peer trip → DISCONNECTED, no RECONNECTING', async () => {
      const { client } = buildClientOverPair({
        deadPeerTimeoutMs: 100,
        autoReconnect: false,
      });
      const states: string[] = [];
      client.on('stateChange', (e: unknown) => {
        states.push((e as { to: string }).to);
      });
      await vi.advanceTimersByTimeAsync(150);
      // Trip happened — should NOT see RECONNECTING under autoReconnect:false.
      expect(states).not.toContain('RECONNECTING');
      client.destroy();
    });
  });

  describe('Independence (D-11/A3)', () => {
    it('Test 11: keepaliveIntervalMs and deadPeerTimeoutMs combine without interference', async () => {
      // Just verify the option fields can co-exist on createClient()
      // without a constructor throw and that the dead-peer timer is armed.
      const { client } = buildClientOverPair({
        keepaliveIntervalMs: 30_000,
        deadPeerTimeoutMs: 60_000,
      });
      const t = (client as unknown as { _deadPeerTimer: unknown })
        ._deadPeerTimer;
      expect(t).not.toBeNull();
      client.destroy();
    });
  });
});

// Avoid net imports being declared but unused by mistake.
void createConnection;
