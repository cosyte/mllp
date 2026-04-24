import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from '../../src/server/server.js';
import type { MllpServer } from '../../src/server/server.js';
import * as net from 'node:net';

// Helper: connect a raw socket to a server bound on 0 and return both
async function connectToServer(server: MllpServer): Promise<net.Socket> {
  const stats = server.getStats();
  const port = stats.port!;
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port });
    sock.once('connect', () => resolve(sock));
    sock.once('error', reject);
  });
}

// MLLP framing helpers
const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

function frameMessage(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, 'ascii');
  const framed = Buffer.allocUnsafe(payloadBuf.length + 3);
  framed[0] = VT;
  payloadBuf.copy(framed, 1);
  framed[payloadBuf.length + 1] = FS;
  framed[payloadBuf.length + 2] = CR;
  return framed;
}

describe('createServer / MllpServer skeleton', () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    // Clean up all servers created during tests
    for (const s of servers) {
      await s.close().catch(() => {/* ignore errors during cleanup */});
    }
    servers.length = 0;
  });

  // Helper that creates a server and tracks it for cleanup
  function makeServer(opts: Parameters<typeof createServer>[0] = {}) {
    const s = createServer(opts);
    servers.push(s);
    return s;
  }

  describe('SERVER-01: factory and basic API', () => {
    it('createServer({}) returns an object with listen and close methods', () => {
      const server = makeServer({});
      expect(typeof server.listen).toBe('function');
      expect(typeof server.close).toBe('function');
    });

    it('createServer({}) returns an object with getStats method', () => {
      const server = makeServer({});
      expect(typeof server.getStats).toBe('function');
    });

    it('MllpServer does not extend net.Server', () => {
      const server = makeServer({});
      expect(server).not.toBeInstanceOf(net.Server);
    });
  });

  describe('SERVER-01: listen and stats', () => {
    it('listen(0) resolves (port 0 = OS assigns)', async () => {
      const server = makeServer({});
      await expect(server.listen(0)).resolves.toBeUndefined();
    });

    it('getStats().listening === true after listen(0)', async () => {
      const server = makeServer({});
      await server.listen(0);
      expect(server.getStats().listening).toBe(true);
    });

    it('getStats().port is a number after listen(0)', async () => {
      const server = makeServer({});
      await server.listen(0);
      const { port } = server.getStats();
      expect(typeof port).toBe('number');
      expect((port as number)).toBeGreaterThan(0);
    });
  });

  describe('SERVER-10: listening event is frozen and has port/host', () => {
    it('listen(0) emits listening event with frozen { port, host }', async () => {
      const server = makeServer({});
      const eventPromise = new Promise<{ port: number; host: string }>((resolve) => {
        server.once('listening', (payload) => resolve(payload as { port: number; host: string }));
      });
      await server.listen(0);
      const payload = await eventPromise;
      expect(typeof payload.port).toBe('number');
      expect(payload.port).toBeGreaterThan(0);
      expect(typeof payload.host).toBe('string');
      // Verify payload is frozen
      expect(Object.isFrozen(payload)).toBe(true);
    });
  });

  describe('SERVER-01/02: connection tracking', () => {
    it('accepting a connection increments activeConnections to 1', async () => {
      const server = makeServer({});
      await server.listen(0);

      expect(server.getStats().activeConnections).toBe(0);
      expect(server.getStats().connections).toBe(0);

      const sock = await connectToServer(server);
      // Give server time to process connection event
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(server.getStats().activeConnections).toBe(1);
      expect(server.getStats().connections).toBe(1);
      expect(server.getStats().acceptedTotal).toBe(1);

      sock.destroy();
    });

    it('connection close decrements activeConnections and increments closedTotal', async () => {
      const server = makeServer({});
      await server.listen(0);

      const sock = await connectToServer(server);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(server.getStats().activeConnections).toBe(1);

      // Destroy the socket to close connection
      sock.destroy();

      // Wait for server to process close event
      await new Promise<void>((resolve) => setTimeout(resolve, 50));

      expect(server.getStats().activeConnections).toBe(0);
      expect(server.getStats().closedTotal).toBe(1);
    });
  });

  describe('SERVER-01: close()', () => {
    it('close() resolves without throwing on a newly-created server', async () => {
      const server = makeServer({});
      await expect(server.close()).resolves.toBeUndefined();
    });

    it('close() resolves without throwing after listen(0)', async () => {
      const server = makeServer({});
      await server.listen(0);
      await expect(server.close()).resolves.toBeUndefined();
    });
  });

  describe('SERVER-10: connection event is frozen', () => {
    it('connection event payload is frozen with connectionId, remoteAddress, remotePort', async () => {
      const server = makeServer({});
      await server.listen(0);

      const connPayloadPromise = new Promise<unknown>((resolve) => {
        server.once('connection', (payload) => resolve(payload));
      });

      const sock = await connectToServer(server);
      const payload = await connPayloadPromise as { connectionId: string; remoteAddress: string | null; remotePort: number | null };

      expect(typeof payload.connectionId).toBe('string');
      expect(payload.connectionId.length).toBeGreaterThan(0);
      expect(Object.isFrozen(payload)).toBe(true);

      sock.destroy();
    });
  });

  describe('SERVER-03: message handling', () => {
    it('onMessage callback receives payload Buffer and meta when message arrives', async () => {
      const received: Array<{ payload: Buffer; meta: unknown }> = [];

      const server = makeServer({
        onMessage: (payload, meta) => {
          received.push({ payload, meta });
        },
      });
      await server.listen(0);

      const sock = await connectToServer(server);
      await new Promise<void>((resolve) => setImmediate(resolve));

      const msg = 'MSH|^~\\&|SENDER|FACILITY|RECEIVER|FACILITY|20260424||ADT^A01|CTRL001|P|2.5';
      sock.write(frameMessage(msg));

      // Wait for server to process message
      await new Promise<void>((resolve) => setTimeout(resolve, 100));

      expect(received.length).toBe(1);
      expect(received[0]!.payload).toBeInstanceOf(Buffer);
      expect((received[0]!.meta as { connectionId: string; byteOffset: number }).connectionId).toBeTruthy();
      expect(typeof (received[0]!.meta as { connectionId: string; byteOffset: number }).byteOffset).toBe('number');

      sock.destroy();
    });
  });

  describe('SERVER-02: Symbol.asyncDispose', () => {
    it('MllpServer has Symbol.asyncDispose', () => {
      const server = makeServer({});
      expect(typeof (server as unknown as Record<symbol, unknown>)[Symbol.asyncDispose]).toBe('function');
    });
  });

  describe('SERVER_DEFAULT_FRAMING', () => {
    it('server uses liberal framing by default (allowFsOnly=true, allowLfAfterFs=true)', async () => {
      const received: Buffer[] = [];
      const server = makeServer({
        onMessage: (payload) => { received.push(payload); },
      });
      await server.listen(0);

      const sock = await connectToServer(server);
      await new Promise<void>((resolve) => setImmediate(resolve));

      // Send FS+LF terminated frame (non-canonical but allowed by default)
      const payload = Buffer.from('test message', 'ascii');
      const fsLfFrame = Buffer.allocUnsafe(payload.length + 3);
      fsLfFrame[0] = VT;
      payload.copy(fsLfFrame, 1);
      fsLfFrame[payload.length + 1] = FS;
      fsLfFrame[payload.length + 2] = 0x0a; // LF instead of CR
      sock.write(fsLfFrame);

      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(received.length).toBe(1);

      sock.destroy();
    });
  });
});
