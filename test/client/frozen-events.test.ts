/**
 * Frozen event payloads audit (PLAN-06 Task 3, CLIENT-13, D-25).
 *
 * Every public event payload emitted by `MllpClient` MUST be `Object.freeze`'d
 * before emission so subscribers cannot mutate shared state. This audit
 * exhaustively covers all 10 public events:
 *
 *   'connect', 'reconnecting', 'disconnect', 'close', 'error', 'drain',
 *   'stateChange', 'warning', 'message', 'ack'
 *
 * For each event we:
 *   1. Drive the client through a flow that emits it.
 *   2. Capture the payload via `client.on(eventName, (e) => captured.push(e))`.
 *   3. Assert `Object.isFrozen(payload) === true`.
 *   4. Assert mutation throws `TypeError` (strict mode is implicit in ESM).
 *
 * Test 11 spot-checks `connectionId` presence per LIFE-04 on events that carry
 * it (per the documented payload shape in src/client/client.ts).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createClient,
  MllpClient,
  type ClientOptions,
} from '../../src/client/client.js';
import { Connection } from '../../src/connection/index.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';

interface Harness {
  client: MllpClient;
  conn: Connection;
  peer: InMemoryTransport;
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: Partial<ClientOptions>): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({
    transport: a,
    ...(opts?.framing !== undefined ? { framing: opts.framing } : {}),
  });
  const baseOpts: ClientOptions = { host: '127.0.0.1', port: 0, ...opts };
  const client = createClient(baseOpts);
  (
    client as unknown as { _attachExistingConnection: (c: Connection) => void }
  )._attachExistingConnection(conn);
  return {
    client,
    conn,
    peer: b,
    ackFromPeer: (payload) => {
      b.write(encodeFrame(payload));
    },
  };
}

/**
 * Assert a payload is frozen AND that mutation throws TypeError.
 * ESM modules run in strict mode — assignment to frozen properties throws.
 */
function assertFrozenAndImmutable(
  payload: unknown,
  attemptKey: string,
): void {
  expect(Object.isFrozen(payload)).toBe(true);
  expect(() => {
    (payload as Record<string, unknown>)[attemptKey] = 'mutated';
  }).toThrow(TypeError);
}

describe('MllpClient frozen event payloads (PLAN-06 Task 3, CLIENT-13, D-25)', () => {
  describe("Test 9: every public event emits Object.isFrozen payload", () => {
    it("'connect' payload is frozen", () => {
      const { client, conn } = buildClientOverPair();
      const captured: unknown[] = [];
      client.on('connect', (e) => captured.push(e));
      conn.notifyConnect('127.0.0.1', 2575);
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
    });

    it("'reconnecting' payload is frozen", async () => {
      vi.useFakeTimers();
      try {
        let currentPair: [InMemoryTransport, InMemoryTransport] =
          InMemoryTransport.pair();
        let currentConn = new Connection({ transport: currentPair[0] });
        const client = createClient({
          host: '127.0.0.1',
          port: 0,
          autoReconnect: true,
          initialDelayMs: 10,
          jitter: 0,
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
          client as unknown as {
            _attachExistingConnection: (c: Connection) => void;
          }
        )._attachExistingConnection(currentConn);
        currentConn.notifyConnect('127.0.0.1', 2575);
        const captured: unknown[] = [];
        client.on('reconnecting', (e) => captured.push(e));
        currentPair[0].destroy(
          Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }),
        );
        await vi.advanceTimersByTimeAsync(1);
        expect(captured.length).toBeGreaterThan(0);
        expect(Object.isFrozen(captured[0])).toBe(true);
        await client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("'disconnect' payload is frozen (autoReconnect:false drops to DISCONNECTED)", async () => {
      const [a] = InMemoryTransport.pair();
      const conn = new Connection({ transport: a });
      const client = createClient({
        host: '127.0.0.1',
        port: 0,
        autoReconnect: false,
      });
      (
        client as unknown as { _attachExistingConnection: (c: Connection) => void }
      )._attachExistingConnection(conn);
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('disconnect', (e) => captured.push(e));
      await client.close();
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
    });

    it("'close' payload is frozen", async () => {
      const { client, conn } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('close', (e) => captured.push(e));
      await client.close();
      // Drive the Connection FSM all the way to CLOSED — close() emits at
      // DISCONNECTED, but Connection emits 'close' on the CLOSED transition.
      conn.destroy(new Error('done'));
      // 'close' may be re-emitted via the Connection transition.
      // If it didn't fire from the natural close path, force it here.
      expect(captured.length).toBeGreaterThan(0);
      for (const c of captured) {
        expect(Object.isFrozen(c)).toBe(true);
      }
    });

    it("'error' payload is frozen (unmatched controlId ACK in controlId mode)", () => {
      const { client, ackFromPeer, conn } = buildClientOverPair({
        correlateByControlId: true,
      });
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('error', (e) => captured.push(e));
      // Send a synthetic ACK whose MSA-2 control ID does not match any
      // outstanding send. The Correlator's onUnmatchedAck callback emits a
      // frozen 'error' payload with the unmatched MllpFramingError.
      ackFromPeer(
        Buffer.from(
          'MSH|^~\\&|TEST|TEST|TEST|TEST|20260101120000||ACK|UNKNOWN_ID|P|2.5\rMSA|AA|UNKNOWN_ID',
        ),
      );
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
      client.destroy();
    });

    it("'drain' payload is frozen (queue crosses below high-water mark)", async () => {
      const { client, ackFromPeer, conn } = buildClientOverPair({
        highWaterMark: 2,
      });
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('drain', (e) => captured.push(e));
      const p1 = client.send(Buffer.from('M1'));
      p1.catch(() => undefined);
      const p2 = client.send(Buffer.from('M2'));
      p2.catch(() => undefined);
      ackFromPeer(Buffer.from('AA1'));
      await Promise.resolve();
      await p1;
      // Issuing the ACK drops queueDepth from 2 → 1, crossing below cap.
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
      ackFromPeer(Buffer.from('AA2'));
      await p2;
      await client.close();
    });

    it("'stateChange' payload is frozen (any FSM transition)", () => {
      const { client, conn } = buildClientOverPair();
      const captured: unknown[] = [];
      client.on('stateChange', (e) => captured.push(e));
      conn.notifyConnect('127.0.0.1', 2575);
      expect(captured.length).toBeGreaterThan(0);
      for (const c of captured) {
        expect(Object.isFrozen(c)).toBe(true);
      }
    });

    it("'warning' payload is frozen (peer sends frame with leading whitespace)", () => {
      const { client, conn, peer } = buildClientOverPair({
        framing: { allowLeadingWhitespace: true },
      });
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('warning', (e) => captured.push(e));
      // Send leading-whitespace frame to provoke MLLP_LEADING_WHITESPACE
      // warning from the FrameReader (Connection re-emits it as a frozen
      // enriched payload).
      peer.write(
        Buffer.concat([Buffer.from([0x20, 0x20]), encodeFrame(Buffer.from('OK'))]),
      );
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
    });

    it("'message' payload is frozen (peer sends a frame)", () => {
      const { client, peer, conn } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('message', (e) => captured.push(e));
      peer.write(encodeFrame(Buffer.from('PEER-MSG')));
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
    });

    it("'ack' payload is frozen (peer ACKs a send)", async () => {
      const { client, conn, ackFromPeer } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      const captured: unknown[] = [];
      client.on('ack', (e) => captured.push(e));
      const sendP = client.send(Buffer.from('M1'));
      ackFromPeer(Buffer.from('AA1'));
      await sendP;
      expect(captured.length).toBeGreaterThan(0);
      expect(Object.isFrozen(captured[0])).toBe(true);
      await client.close();
    });
  });

  describe('Test 10: mutation attempt on each frozen event payload throws TypeError', () => {
    it("'connect' mutation throws TypeError", () => {
      const { client, conn } = buildClientOverPair();
      let captured: unknown = null;
      client.on('connect', (e) => {
        captured = e;
      });
      conn.notifyConnect('127.0.0.1', 2575);
      assertFrozenAndImmutable(captured, 'connectionId');
    });

    it("'reconnecting' mutation throws TypeError", async () => {
      vi.useFakeTimers();
      try {
        let currentPair: [InMemoryTransport, InMemoryTransport] =
          InMemoryTransport.pair();
        let currentConn = new Connection({ transport: currentPair[0] });
        const client = createClient({
          host: '127.0.0.1',
          port: 0,
          autoReconnect: true,
          initialDelayMs: 10,
          jitter: 0,
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
          client as unknown as {
            _attachExistingConnection: (c: Connection) => void;
          }
        )._attachExistingConnection(currentConn);
        currentConn.notifyConnect('127.0.0.1', 2575);
        let captured: unknown = null;
        client.on('reconnecting', (e) => {
          if (captured === null) captured = e;
        });
        currentPair[0].destroy(
          Object.assign(new Error('peer reset'), { code: 'ECONNRESET' }),
        );
        await vi.advanceTimersByTimeAsync(1);
        assertFrozenAndImmutable(captured, 'attempt');
        await client.close();
      } finally {
        vi.useRealTimers();
      }
    });

    it("'disconnect' mutation throws TypeError", async () => {
      const [a] = InMemoryTransport.pair();
      const conn = new Connection({ transport: a });
      const client = createClient({
        host: '127.0.0.1',
        port: 0,
        autoReconnect: false,
      });
      (
        client as unknown as { _attachExistingConnection: (c: Connection) => void }
      )._attachExistingConnection(conn);
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('disconnect', (e) => {
        captured = e;
      });
      await client.close();
      assertFrozenAndImmutable(captured, 'connectionId');
    });

    it("'close' mutation throws TypeError", async () => {
      const { client, conn } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('close', (e) => {
        if (captured === null) captured = e;
      });
      await client.close();
      conn.destroy(new Error('done'));
      assertFrozenAndImmutable(captured, 'connectionId');
    });

    it("'error' mutation throws TypeError", () => {
      const { client, ackFromPeer, conn } = buildClientOverPair({
        correlateByControlId: true,
      });
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('error', (e) => {
        captured = e;
      });
      ackFromPeer(
        Buffer.from(
          'MSH|^~\\&|TEST|TEST|TEST|TEST|20260101120000||ACK|UNKNOWN_ID|P|2.5\rMSA|AA|UNKNOWN_ID',
        ),
      );
      assertFrozenAndImmutable(captured, 'connectionId');
      client.destroy();
    });

    it("'drain' mutation throws TypeError", async () => {
      const { client, ackFromPeer, conn } = buildClientOverPair({
        highWaterMark: 2,
      });
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('drain', (e) => {
        if (captured === null) captured = e;
      });
      const p1 = client.send(Buffer.from('M1'));
      p1.catch(() => undefined);
      const p2 = client.send(Buffer.from('M2'));
      p2.catch(() => undefined);
      ackFromPeer(Buffer.from('AA1'));
      await p1;
      assertFrozenAndImmutable(captured, 'queueDepth');
      ackFromPeer(Buffer.from('AA2'));
      await p2;
      await client.close();
    });

    it("'stateChange' mutation throws TypeError", () => {
      const { client, conn } = buildClientOverPair();
      let captured: unknown = null;
      client.on('stateChange', (e) => {
        if (captured === null) captured = e;
      });
      conn.notifyConnect('127.0.0.1', 2575);
      assertFrozenAndImmutable(captured, 'from');
    });

    it("'warning' mutation throws TypeError", () => {
      const { client, conn, peer } = buildClientOverPair({
        framing: { allowLeadingWhitespace: true },
      });
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('warning', (e) => {
        if (captured === null) captured = e;
      });
      peer.write(
        Buffer.concat([Buffer.from([0x20, 0x20]), encodeFrame(Buffer.from('OK'))]),
      );
      assertFrozenAndImmutable(captured, 'code');
    });

    it("'message' mutation throws TypeError", () => {
      const { client, peer, conn } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('message', (e) => {
        captured = e;
      });
      peer.write(encodeFrame(Buffer.from('PEER-MSG')));
      assertFrozenAndImmutable(captured, 'connectionId');
    });

    it("'ack' mutation throws TypeError", async () => {
      const { client, conn, ackFromPeer } = buildClientOverPair();
      conn.notifyConnect('127.0.0.1', 2575);
      let captured: unknown = null;
      client.on('ack', (e) => {
        captured = e;
      });
      const sendP = client.send(Buffer.from('M1'));
      ackFromPeer(Buffer.from('AA1'));
      await sendP;
      assertFrozenAndImmutable(captured, 'controlId');
      await client.close();
    });
  });

  describe('Test 11: connectionId presence per LIFE-04', () => {
    it("'connect' carries connectionId", () => {
      const { client, conn } = buildClientOverPair();
      let captured: { connectionId?: string } | null = null;
      client.on('connect', (e: unknown) => {
        captured = e as { connectionId?: string };
      });
      conn.notifyConnect('127.0.0.1', 2575);
      expect(captured).not.toBeNull();
      expect(typeof (captured as unknown as { connectionId?: string }).connectionId).toBe('string');
      expect((captured as unknown as { connectionId?: string }).connectionId).toBe(
        conn.connectionId,
      );
    });

    it("'message' / 'warning' / 'error' carry connectionId where applicable", () => {
      const { client, conn, peer, ackFromPeer } = buildClientOverPair({
        framing: { allowLeadingWhitespace: true },
        correlateByControlId: true,
      });
      conn.notifyConnect('127.0.0.1', 2575);
      const messages: Array<{ connectionId?: string }> = [];
      const warnings: Array<{ connectionId?: string }> = [];
      const errors: Array<{ connectionId?: string }> = [];
      client.on('message', (e: unknown) =>
        messages.push(e as { connectionId?: string }),
      );
      client.on('warning', (e: unknown) =>
        warnings.push(e as { connectionId?: string }),
      );
      client.on('error', (e: unknown) =>
        errors.push(e as { connectionId?: string }),
      );

      // Trigger 'message' + 'warning' via a leading-whitespace frame.
      peer.write(
        Buffer.concat([Buffer.from([0x20, 0x20]), encodeFrame(Buffer.from('OK'))]),
      );
      // Trigger 'error' via unmatched-controlId ACK.
      ackFromPeer(
        Buffer.from(
          'MSH|^~\\&|TEST|TEST|TEST|TEST|20260101120000||ACK|UNKNOWN|P|2.5\rMSA|AA|UNKNOWN',
        ),
      );

      expect(messages.length).toBeGreaterThan(0);
      expect(typeof messages[0]?.connectionId).toBe('string');
      expect(warnings.length).toBeGreaterThan(0);
      expect(typeof warnings[0]?.connectionId).toBe('string');
      expect(errors.length).toBeGreaterThan(0);
      expect(typeof errors[0]?.connectionId).toBe('string');
      client.destroy();
    });
  });
});
