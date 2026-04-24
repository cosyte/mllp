import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Connection } from '../../src/connection/connection.js';
import type { Transport } from '../../src/transport/index.js';

// Minimal Transport mock — stores callbacks and exposes trigger methods
function makeMockTransport() {
  let dataFn: ((c: Buffer) => void) | null = null;
  let connectFn: (() => void) | null = null;
  let closeFn: (() => void) | null = null;
  let errorFn: ((e: Error) => void) | null = null;

  const t: Transport = {
    write: vi.fn().mockReturnValue(true),
    close: vi.fn(),
    destroy: vi.fn(),
    onData: (fn) => { dataFn = fn; },
    onConnect: (fn) => { connectFn = fn; },
    onClose: (fn) => { closeFn = fn; },
    onError: (fn) => { errorFn = fn; },
  };

  return {
    transport: t,
    emit: {
      data: (chunk: Buffer) => dataFn?.(chunk),
      connect: () => connectFn?.(),
      close: () => closeFn?.(),
      error: (e: Error) => errorFn?.(e),
    },
  };
}

describe('Connection', () => {
  let mock: ReturnType<typeof makeMockTransport>;
  let conn: Connection;

  beforeEach(() => {
    mock = makeMockTransport();
    conn = new Connection({ transport: mock.transport });
  });

  describe('LIFE-01: state property', () => {
    it('starts in CONNECTING state', () => {
      expect(conn.state).toBe('CONNECTING');
    });

    it('transitions to CONNECTED after notifyConnect()', () => {
      conn.notifyConnect('127.0.0.1', 2575);
      expect(conn.state).toBe('CONNECTED');
    });
  });

  describe('LIFE-04: connectionId', () => {
    it('has a stable UUIDv4 connectionId', () => {
      expect(conn.connectionId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('each Connection has a unique connectionId', () => {
      const mock2 = makeMockTransport();
      const conn2 = new Connection({ transport: mock2.transport });
      expect(conn.connectionId).not.toBe(conn2.connectionId);
    });
  });

  describe('LIFE-01/02: stateChange event', () => {
    it('emits stateChange when transitioning CONNECTING → CONNECTED', () => {
      const changes: { from: string; to: string }[] = [];
      conn.on('stateChange', (e) => changes.push({ from: e.from, to: e.to }));
      conn.notifyConnect('127.0.0.1', 2575);
      expect(changes).toContainEqual({ from: 'CONNECTING', to: 'CONNECTED' });
    });

    it('stateChange event payload is frozen', () => {
      let payload: unknown;
      conn.on('stateChange', (e) => { payload = e; });
      conn.notifyConnect(null, null);
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('emits stateChange on CONNECTED → DISCONNECTED (peer drop)', () => {
      conn.notifyConnect('127.0.0.1', 2575);
      const changes: { from: string; to: string }[] = [];
      conn.on('stateChange', (e) => changes.push(e));
      mock.emit.close(); // transport closes unexpectedly
      expect(conn.state).toBe('DISCONNECTED');
      expect(changes.some((c) => c.from === 'CONNECTED' && c.to === 'DISCONNECTED')).toBe(true);
    });

    it('does not leak beyond CLOSED (illegal transition is no-op)', () => {
      conn.destroy();
      expect(conn.state).toBe('CLOSED');
      conn.destroy(); // second destroy — should be no-op
      expect(conn.state).toBe('CLOSED');
    });

    it('stateChange includes reason when provided', () => {
      let lastEvent: { from: string; to: string; reason?: string } | undefined;
      conn.on('stateChange', (e) => { lastEvent = e; });
      mock.emit.close(); // peer closed — reason 'peer closed'
      // CONNECTING -> DISCONNECTED is illegal (via _onTransportClose); let's check via destroy
      const m2 = makeMockTransport();
      const c2 = new Connection({ transport: m2.transport });
      c2.notifyConnect(null, null);
      let evt: { reason?: string } | undefined;
      c2.on('stateChange', (e) => { evt = e; });
      m2.emit.close();
      expect(evt?.reason).toBe('peer closed');
    });

    it('stateChange reason is omitted when not provided (CONNECTING → CONNECTED)', () => {
      let payload: { reason?: string } | undefined;
      conn.on('stateChange', (e) => { payload = e; });
      conn.notifyConnect(null, null);
      // reason should be absent, not present as undefined
      expect(payload).not.toHaveProperty('reason');
    });
  });

  describe('LIFE-03: lifecycle events', () => {
    it('emits connect event on notifyConnect()', () => {
      const fn = vi.fn();
      conn.on('connect', fn);
      conn.notifyConnect('127.0.0.1', 2575);
      expect(fn).toHaveBeenCalledOnce();
    });

    it('connect event payload is frozen', () => {
      let payload: unknown;
      conn.on('connect', (e) => { payload = e; });
      conn.notifyConnect(null, null);
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('emits disconnect event on peer drop', () => {
      conn.notifyConnect('127.0.0.1', 2575);
      const fn = vi.fn();
      conn.on('disconnect', fn);
      mock.emit.close();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('disconnect event payload is frozen', () => {
      conn.notifyConnect(null, null);
      let payload: unknown;
      conn.on('disconnect', (e) => { payload = e; });
      mock.emit.close();
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('emits close event on destroy()', () => {
      const fn = vi.fn();
      conn.on('close', fn);
      conn.destroy();
      expect(fn).toHaveBeenCalledOnce();
    });

    it('close event payload is frozen', () => {
      let payload: unknown;
      conn.on('close', (e) => { payload = e; });
      conn.destroy();
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('emits message when a framed MLLP message is received (D-05)', () => {
      conn.notifyConnect('127.0.0.1', 2575);
      const messages: Buffer[] = [];
      conn.on('message', (e: { payload: Buffer }) => messages.push(e.payload));
      // Push a complete MLLP frame: VT + 'A' + FS + CR
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toEqual(Buffer.from([0x41]));
    });

    it('message event payload is frozen (D-05)', () => {
      conn.notifyConnect(null, null);
      let payload: unknown;
      conn.on('message', (e) => { payload = e; });
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('message event contains connectionId matching connection.connectionId', () => {
      conn.notifyConnect(null, null);
      let received: { connectionId: string } | undefined;
      conn.on('message', (e: { connectionId: string }) => { received = e; });
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(received?.connectionId).toBe(conn.connectionId);
    });

    it('does NOT emit ack event — ack is MllpClient-layer (D-06)', () => {
      conn.notifyConnect(null, null);
      const fn = vi.fn();
      conn.on('ack', fn);
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(fn).not.toHaveBeenCalled();
    });

    it('calls onMessage option callback for each decoded frame', () => {
      const onMessage = vi.fn();
      const m2 = makeMockTransport();
      const c2 = new Connection({ transport: m2.transport, onMessage });
      c2.notifyConnect(null, null);
      m2.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(onMessage).toHaveBeenCalledOnce();
      expect(onMessage).toHaveBeenCalledWith(Buffer.from([0x41]));
    });

    it('does not emit message when in CONNECTING state (frame arrives before notifyConnect)', () => {
      const fn = vi.fn();
      conn.on('message', fn);
      // Push data before notifyConnect — state is CONNECTING
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('WARN-10: per-connection onWarning', () => {
    it('enriches warnings with connectionId (D-09)', () => {
      const mockT = makeMockTransport();
      const connWithTolerance = new Connection({
        transport: mockT.transport,
        framing: { allowFsOnly: true },
      });
      const tWarnings: Array<{ connectionId: string | undefined }> = [];
      connWithTolerance.onWarning((w) => tWarnings.push(w));
      connWithTolerance.notifyConnect(null, null);
      // VT + payload + FS + VT (FS without CR — triggers MLLP_FS_WITHOUT_CR warning)
      mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      // Consume the incomplete second frame
      mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      expect(tWarnings.length).toBeGreaterThan(0);
      expect(tWarnings[0]?.connectionId).toBe(connWithTolerance.connectionId);
    });

    it('enriched warning is frozen (D-09)', () => {
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true } });
      let received: unknown;
      c.onWarning((w) => { received = w; });
      c.notifyConnect(null, null);
      mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      if (received !== undefined) {
        expect(Object.isFrozen(received)).toBe(true);
      }
    });

    it('swallows throwing onWarning handler (WARN-06)', () => {
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true } });
      c.onWarning(() => { throw new Error('handler threw'); });
      c.notifyConnect(null, null);
      // Should not throw
      expect(() => {
        mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
        mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      }).not.toThrow();
    });

    it('onWarning subscription replaces previous handler (set-once semantics)', () => {
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true } });
      const first = vi.fn();
      const second = vi.fn();
      c.onWarning(first);
      c.onWarning(second); // replaces first
      c.notifyConnect(null, null);
      mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      expect(second).toHaveBeenCalled();
      expect(first).not.toHaveBeenCalled();
    });

    it('onWarning option in constructor sets initial handler', () => {
      const onWarning = vi.fn();
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true }, onWarning });
      c.notifyConnect(null, null);
      mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      expect(onWarning).toHaveBeenCalled();
    });

    it('warning is also emitted as EventEmitter event (aggregate stream)', () => {
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true } });
      const emittedWarnings: unknown[] = [];
      c.on('warning', (w) => emittedWarnings.push(w));
      c.notifyConnect(null, null);
      mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
      mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      expect(emittedWarnings.length).toBeGreaterThan(0);
    });
  });

  describe('OBS-03/04/05: getStats()', () => {
    it('returns JSON-serializable stats (OBS-04)', () => {
      conn.notifyConnect('127.0.0.1', 2575);
      const stats = conn.getStats();
      const json = JSON.stringify(stats);
      expect(() => JSON.parse(json)).not.toThrow();
    });

    it('state matches current FSM state (OBS-03)', () => {
      expect(conn.getStats().state).toBe('CONNECTING');
      conn.notifyConnect('127.0.0.1', 2575);
      expect(conn.getStats().state).toBe('CONNECTED');
    });

    it('connectionId in stats matches connection.connectionId (OBS-03)', () => {
      expect(conn.getStats().connectionId).toBe(conn.connectionId);
    });

    it('remoteAddress/Port captured on connect (OBS-03)', () => {
      conn.notifyConnect('192.168.1.1', 2575);
      const s = conn.getStats();
      expect(s.remoteAddress).toBe('192.168.1.1');
      expect(s.remotePort).toBe(2575);
    });

    it('remoteAddress/Port are null before connect', () => {
      const s = conn.getStats();
      expect(s.remoteAddress).toBeNull();
      expect(s.remotePort).toBeNull();
    });

    it('connectedAt is Date after notifyConnect() (OBS-04)', () => {
      conn.notifyConnect(null, null);
      expect(conn.getStats().connectedAt).toBeInstanceOf(Date);
    });

    it('connectedAt is null before notifyConnect()', () => {
      expect(conn.getStats().connectedAt).toBeNull();
    });

    it('bytesIn tracked from transport.onData (OBS-03)', () => {
      conn.notifyConnect(null, null);
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d])); // 4 bytes
      expect(conn.getStats().bytesIn).toBe(4);
    });

    it('bytesIn accumulates across multiple chunks', () => {
      conn.notifyConnect(null, null);
      mock.emit.data(Buffer.from([0x0b, 0x41])); // 2 bytes
      mock.emit.data(Buffer.from([0x1c, 0x0d])); // 2 bytes
      expect(conn.getStats().bytesIn).toBe(4);
    });

    it('bytesOut tracked via send() (OBS-03)', () => {
      conn.notifyConnect(null, null);
      conn.send(Buffer.from([0x0b, 0x41, 0x1c, 0x0d])); // 4 bytes
      expect(conn.getStats().bytesOut).toBe(4);
    });

    it('lastByteInAt is a Date (OBS-04: no epoch ms)', () => {
      conn.notifyConnect(null, null);
      // Use a complete MLLP frame so FrameReader does not throw
      mock.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
      const stats = conn.getStats();
      expect(stats.lastByteInAt).toBeInstanceOf(Date);
    });

    it('lastByteInAt is null before any data arrives', () => {
      expect(conn.getStats().lastByteInAt).toBeNull();
    });

    it('lastByteOutAt is a Date after send()', () => {
      conn.notifyConnect(null, null);
      conn.send(Buffer.from([0x41]));
      expect(conn.getStats().lastByteOutAt).toBeInstanceOf(Date);
    });

    it('lastByteOutAt is null before any send()', () => {
      expect(conn.getStats().lastByteOutAt).toBeNull();
    });

    it('warningsTruncated is false initially (OBS-05)', () => {
      expect(conn.getStats().warningsTruncated).toBe(false);
    });

    it('warningsByCode tracks counts even when buffer truncates (OBS-05)', () => {
      const mockT = makeMockTransport();
      const c = new Connection({ transport: mockT.transport, framing: { allowFsOnly: true } });
      c.notifyConnect(null, null);
      // Send 105 frames where each triggers MLLP_FS_WITHOUT_CR (exceeds 100-entry buffer cap)
      for (let i = 0; i < 105; i++) {
        // Each push: VT + payload + FS + VT (next frame) — triggers MLLP_FS_WITHOUT_CR
        mockT.emit.data(Buffer.from([0x0b, 0x41, 0x1c, 0x0b]));
        // Complete the second frame cleanly
        mockT.emit.data(Buffer.from([0x41, 0x1c, 0x0d]));
      }
      const stats = c.getStats();
      expect(stats.warningsTruncated).toBe(true);
      // Count must be accurate (at least 105 warnings)
      expect((stats.warningsByCode['MLLP_FS_WITHOUT_CR'] ?? 0)).toBeGreaterThanOrEqual(105);
    });

    it('warningsByCode is empty initially', () => {
      expect(conn.getStats().warningsByCode).toEqual({});
    });
  });

  describe('destroy()', () => {
    it('transitions any state to CLOSED immediately', () => {
      conn.destroy();
      expect(conn.state).toBe('CLOSED');
    });

    it('transitions CONNECTED to CLOSED', () => {
      conn.notifyConnect(null, null);
      conn.destroy();
      expect(conn.state).toBe('CLOSED');
    });

    it('calls transport.destroy()', () => {
      conn.destroy();
      expect(mock.transport.destroy).toHaveBeenCalled();
    });

    it('propagates reason to transport.destroy()', () => {
      const err = new Error('timeout');
      conn.destroy(err);
      expect(mock.transport.destroy).toHaveBeenCalledWith(err);
    });

    it('is idempotent — second destroy is a no-op', () => {
      conn.destroy();
      expect(() => conn.destroy()).not.toThrow();
      expect(conn.state).toBe('CLOSED');
    });

    it('destroy reason appears in stateChange event', () => {
      let evt: { reason?: string } | undefined;
      conn.on('stateChange', (e) => { evt = e; });
      conn.destroy(new Error('test reason'));
      expect(evt?.reason).toBe('test reason');
    });
  });

  describe('close()', () => {
    it('transitions CONNECTED → DRAINING → DISCONNECTED', async () => {
      conn.notifyConnect(null, null);
      await conn.close();
      expect(conn.state).toBe('DISCONNECTED');
    });

    it('is a no-op when already CLOSED', async () => {
      conn.destroy();
      await expect(conn.close()).resolves.toBeUndefined();
    });

    it('is a no-op when already DISCONNECTED', async () => {
      conn.notifyConnect(null, null);
      mock.emit.close(); // transport closed → DISCONNECTED
      await expect(conn.close()).resolves.toBeUndefined();
      expect(conn.state).toBe('DISCONNECTED');
    });

    it('calls transport.close() after beforeClose resolves', async () => {
      conn.notifyConnect(null, null);
      await conn.close();
      expect(mock.transport.close).toHaveBeenCalled();
    });

    it('respects drainTimeoutMs option passed to close()', async () => {
      let receivedTimeout: number | undefined;
      conn.beforeClose = async (ms) => { receivedTimeout = ms; };
      conn.notifyConnect(null, null);
      await conn.close({ drainTimeoutMs: 5_000 });
      expect(receivedTimeout).toBe(5_000);
    });

    it('uses default drainTimeoutMs (30000) when not specified', async () => {
      let receivedTimeout: number | undefined;
      conn.beforeClose = async (ms) => { receivedTimeout = ms; };
      conn.notifyConnect(null, null);
      await conn.close();
      expect(receivedTimeout).toBe(30_000);
    });
  });

  describe('send()', () => {
    it('returns false when CLOSED — no bytes written', () => {
      conn.destroy();
      const result = conn.send(Buffer.from([0x41]));
      expect(result).toBe(false);
      expect(mock.transport.write).not.toHaveBeenCalled();
    });

    it('returns false when DISCONNECTED — no bytes written', () => {
      conn.notifyConnect(null, null);
      mock.emit.close();
      expect(conn.state).toBe('DISCONNECTED');
      const result = conn.send(Buffer.from([0x41]));
      expect(result).toBe(false);
    });

    it('returns transport.write() result when writable', () => {
      conn.notifyConnect(null, null);
      const result = conn.send(Buffer.from([0x41]));
      expect(result).toBe(true); // mock returns true
      expect(mock.transport.write).toHaveBeenCalledWith(Buffer.from([0x41]));
    });
  });

  describe('error event', () => {
    it('emits error event with MllpConnectionError on transport error', () => {
      const errors: unknown[] = [];
      conn.on('error', (e) => errors.push(e));
      mock.emit.error(new Error('ECONNRESET'));
      expect(errors).toHaveLength(1);
    });

    it('error event payload is frozen', () => {
      let payload: unknown;
      conn.on('error', (e) => { payload = e; });
      mock.emit.error(new Error('ECONNRESET'));
      expect(Object.isFrozen(payload)).toBe(true);
    });

    it('transitions to CLOSED after transport error in CONNECTING (no DISCONNECTED path from CONNECTING)', () => {
      conn.on('error', () => {}); // prevent unhandled error
      mock.emit.error(new Error('ECONNREFUSED'));
      // CONNECTING → DISCONNECTED is not a legal LIFE-02 edge; CONNECTING → CLOSED is used instead
      expect(conn.state).toBe('CLOSED');
    });

    it('transitions to DISCONNECTED after transport error in CONNECTED', () => {
      conn.notifyConnect(null, null);
      conn.on('error', () => {}); // prevent unhandled error
      mock.emit.error(new Error('ECONNRESET'));
      expect(conn.state).toBe('DISCONNECTED');
    });
  });
});
