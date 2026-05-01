/**
 * MllpClient lifecycle tests — PLAN-01.
 *
 * Drives the client through CONNECTING -> CONNECTED -> DRAINING -> DISCONNECTED
 * over an `InMemoryTransport.pair()`, bypassing `net.createConnection` via the
 * internal `_attachExistingConnection` test seam. Production-path connect() is
 * exercised against a localhost listening server in test 11 to assert the
 * net.Socket flow + AbortSignal pre-check.
 */

import { describe, it, expect } from 'vitest';
import { createServer as netCreateServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createClient, MllpClient } from '../../src/client/client.js';
import { Connection, MllpConnectionError } from '../../src/connection/index.js';
import { InMemoryTransport } from '../../src/testing/in-memory-transport.js';
import { encodeFrame } from '../../src/framing/index.js';

/**
 * Build a client wired to a fresh InMemoryTransport pair. Returns the client
 * (with an attached pre-built Connection) plus the peer transport so the test
 * can write framed messages back through it.
 */
function buildClientOverInMemoryPair(): {
  client: MllpClient;
  transport: InMemoryTransport;
  peer: InMemoryTransport;
  conn: Connection;
} {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const client = createClient({ host: '127.0.0.1', port: 0 });
  client._attachExistingConnection(conn);
  return { client, transport: a, peer: b, conn };
}

describe('MllpClient lifecycle (PLAN-01)', () => {
  it('Test 1: connect()-style transition emits frozen connect event with connectionId', () => {
    const { client, conn } = buildClientOverInMemoryPair();

    const events: Array<{ connectionId: string }> = [];
    client.on('connect', (e: { connectionId: string }) => {
      events.push(e);
    });

    // Drive the FSM externally — analog of socket-connect path
    conn.notifyConnect('127.0.0.1', 2575);

    expect(client.state).toBe('CONNECTED');
    expect(events).toHaveLength(1);
    expect(events[0]?.connectionId).toBe(conn.connectionId);
    expect(Object.isFrozen(events[0])).toBe(true);
  });

  it('Test 2: connect() rejects when already connected', async () => {
    // Use the public connect() path — server bound on ephemeral port
    const server = netCreateServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    const client = createClient({ host: '127.0.0.1', port });
    try {
      await client.connect();
      expect(client.state).toBe('CONNECTED');

      await expect(client.connect()).rejects.toMatchObject({
        name: 'MllpConnectionError',
        phase: 'connect',
      });
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('Test 3: connect({ signal }) rejects with AbortError when signal aborts before connect', async () => {
    // Bind a server but never accept — use a port that DOES exist, then abort the signal
    // before the connect resolves. Aborting between createConnection() and the 'connect'
    // event is timing-sensitive; use a fresh AbortController and abort immediately.
    const ac = new AbortController();
    ac.abort();
    const client = createClient({ host: '127.0.0.1', port: 1 });
    await expect(client.connect({ signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    // Pre-aborted signal short-circuits — no connection attempted, no socket leak.
    expect(client.state).toBe('DISCONNECTED');
  });

  it('Test 4: close() from CONNECTED transitions DRAINING -> DISCONNECTED with frozen events', async () => {
    const { client, conn } = buildClientOverInMemoryPair();

    const stateChanges: Array<{ from: string; to: string }> = [];
    client.on(
      'stateChange',
      (e: { from: string; to: string }) => {
        stateChanges.push(e);
        expect(Object.isFrozen(e)).toBe(true);
      },
    );
    const disconnects: Array<{ connectionId: string }> = [];
    client.on('disconnect', (e: { connectionId: string }) => {
      disconnects.push(e);
      expect(Object.isFrozen(e)).toBe(true);
    });

    conn.notifyConnect('127.0.0.1', 2575);
    expect(client.state).toBe('CONNECTED');

    await client.close({ drainTimeoutMs: 50 });

    // Sequence: CONNECTED -> DRAINING -> DISCONNECTED (via Connection.close())
    const transitions = stateChanges.map((s) => `${s.from}->${s.to}`);
    expect(transitions).toContain('CONNECTING->CONNECTED');
    expect(transitions).toContain('CONNECTED->DRAINING');
    expect(transitions).toContain('DRAINING->DISCONNECTED');
    expect(disconnects).toHaveLength(1);
    expect(client.state).toBe('DISCONNECTED');
  });

  it('Test 5: destroy() from CONNECTED transitions directly to CLOSED, emits frozen close', () => {
    const { client, conn } = buildClientOverInMemoryPair();

    const closeEvents: Array<{ connectionId: string }> = [];
    client.on('close', (e: { connectionId: string }) => {
      closeEvents.push(e);
      expect(Object.isFrozen(e)).toBe(true);
    });

    conn.notifyConnect('127.0.0.1', 2575);
    client.destroy();

    expect(client.state).toBe('CLOSED');
    expect(closeEvents).toHaveLength(1);
  });

  it('Test 6: state is observable; transitions emit frozen stateChange', () => {
    const { client, conn } = buildClientOverInMemoryPair();

    const validStates = new Set([
      'CONNECTING',
      'CONNECTED',
      'DRAINING',
      'RECONNECTING',
      'DISCONNECTED',
      'CLOSED',
    ]);
    expect(validStates.has(client.state)).toBe(true);

    const seen: string[] = [];
    client.on('stateChange', (e: { from: string; to: string }) => {
      seen.push(e.to);
      expect(Object.isFrozen(e)).toBe(true);
    });

    conn.notifyConnect('127.0.0.1', 2575);
    client.destroy();

    expect(seen).toContain('CONNECTED');
    expect(seen).toContain('CLOSED');
  });

  it('Test 7: inbound frame re-emits as frozen message event with payload+connectionId', () => {
    const { client, conn, peer } = buildClientOverInMemoryPair();

    // Drive the FSM into CONNECTED so messages are delivered (Connection only
    // delivers in CONNECTED or DRAINING).
    conn.notifyConnect('127.0.0.1', 2575);

    const messages: Array<{
      payload: Buffer;
      connectionId: string;
      byteOffset: number;
      warnings: readonly unknown[];
    }> = [];
    client.on(
      'message',
      (e: {
        payload: Buffer;
        connectionId: string;
        byteOffset: number;
        warnings: readonly unknown[];
      }) => {
        messages.push(e);
        expect(Object.isFrozen(e)).toBe(true);
      },
    );

    // Server-side peer writes a framed message to the client
    peer.write(encodeFrame(Buffer.from('MSH|^~\\&|test\rEVN|', 'ascii')));

    expect(messages).toHaveLength(1);
    expect(messages[0]?.connectionId).toBe(conn.connectionId);
    expect(messages[0]?.payload.toString('ascii')).toBe('MSH|^~\\&|test\rEVN|');
  });

  it('Test 8: warnings re-emit on the client', () => {
    const { client, conn, peer } = buildClientOverInMemoryPair();
    conn.notifyConnect('127.0.0.1', 2575);

    const warnings: Array<{ code: string }> = [];
    client.on('warning', (w: { code: string }) => {
      warnings.push(w);
    });

    // Send bytes that should trigger a tolerance warning. Default FrameReader
    // does NOT enable tolerances, so an empty payload between VT and FS is the
    // simplest deterministic warning we can fire.
    peer.write(Buffer.from([0x0b, 0x1c, 0x0d])); // VT FS CR — empty payload

    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0]?.code).toBe('MLLP_EMPTY_PAYLOAD');
  });

  it('Test 9: error re-emits guarded by listenerCount (no crash if no listener)', () => {
    const { client, conn } = buildClientOverInMemoryPair();
    conn.notifyConnect('127.0.0.1', 2575);

    // No 'error' listener attached — connection error should NOT crash the process.
    // Trigger it via transport destroy with a reason.
    expect(() => {
      conn.destroy(new Error('boom'));
    }).not.toThrow();
    expect(client.state).toBe('CLOSED');

    // Now attach an error listener and re-trigger via a fresh client.
    const { client: client2, conn: conn2 } = buildClientOverInMemoryPair();
    conn2.notifyConnect('127.0.0.1', 2575);
    const errors: unknown[] = [];
    client2.on('error', (e: unknown) => errors.push(e));

    // Connection emits its own 'error' on transport error during CONNECTED.
    // We trigger it via the transport directly by destroying with a reason.
    // Use the underlying transport's onError simulation: easier path is to
    // simulate a transport error by calling _onTransportError indirectly —
    // easiest is to write to a destroyed transport peer. Simulate explicitly:
    const fakeError = new Error('simulated transport error');
    conn2.emit(
      'error',
      Object.freeze({ connectionId: conn2.connectionId, error: fakeError }),
    );
    expect(errors).toHaveLength(1);
  });

  it('Test 10: await using delegates to close() — Symbol.asyncDispose', async () => {
    let observedAfter: string | null = null;
    let connRef: Connection | null = null;
    {
      const [a] = InMemoryTransport.pair();
      const conn = new Connection({ transport: a });
      connRef = conn;
      await using client = createClient({ host: '127.0.0.1', port: 0 });
      client._attachExistingConnection(conn);
      conn.notifyConnect('127.0.0.1', 2575);
      expect(client.state).toBe('CONNECTED');
      // scope exit triggers Symbol.asyncDispose -> close()
    }
    // After scope exit, the Connection should have transitioned out of CONNECTED.
    // close() drains and reaches DISCONNECTED (or CLOSED on timeout).
    observedAfter = connRef?.state ?? null;
    expect(observedAfter === 'DISCONNECTED' || observedAfter === 'CLOSED').toBe(
      true,
    );
  });
});

describe('MllpConnectionError export sanity (PLAN-01)', () => {
  it('exports MllpConnectionError so callers can instanceof-check', () => {
    expect(typeof MllpConnectionError).toBe('function');
    const err = new MllpConnectionError('test', {
      cause: new Error('x'),
      phase: 'connect',
    });
    expect(err).toBeInstanceOf(MllpConnectionError);
  });
});

describe('MllpClient additional coverage (PLAN-01)', () => {
  it('connect() succeeds against a localhost listener', async () => {
    const server = netCreateServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;

    const client = createClient({
      host: '127.0.0.1',
      port,
      framing: { maxFrameSizeBytes: 1024 * 1024 },
      drainTimeoutMs: 100,
    });
    try {
      await client.connect();
      expect(client.state).toBe('CONNECTED');
    } finally {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('connect() rejects with MllpConnectionError on socket error (ECONNREFUSED)', async () => {
    // Connect to a port nobody listens on. ECONNREFUSED bubbles via the
    // socket 'error' handler into the connect() promise rejection.
    const client = createClient({ host: '127.0.0.1', port: 1 });
    await expect(client.connect()).rejects.toMatchObject({
      name: 'MllpConnectionError',
      phase: 'connect',
    });
  });

  it('connect() with mid-attempt abort rejects with AbortError', async () => {
    // Connect to an unreachable address with delayed abort. Because we cannot
    // reliably guarantee timing for "between createConnection and connect",
    // we use a bind to a routable but never-accepting address (192.0.2.1 is
    // TEST-NET-1 — always unreachable per RFC 5737).
    const ac = new AbortController();
    const client = createClient({ host: '192.0.2.1', port: 12345 });
    const p = client.connect({ signal: ac.signal });
    // Allow createConnection to start before aborting
    setImmediate(() => ac.abort());
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('close() resolves immediately when no Connection is attached', async () => {
    const client = createClient({ host: '127.0.0.1', port: 1 });
    await expect(client.close()).resolves.toBeUndefined();
  });

  it('close() pre-aborted signal rejects with AbortError', async () => {
    const ac = new AbortController();
    ac.abort();
    const client = createClient({ host: '127.0.0.1', port: 1 });
    await expect(client.close({ signal: ac.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('close() with mid-drain abort force-destroys connection and rejects', async () => {
    const [a] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: '127.0.0.1', port: 0 });
    client._attachExistingConnection(conn);
    conn.notifyConnect('127.0.0.1', 2575);

    // Replace beforeClose with a never-resolving drain so we can abort it
    conn.beforeClose = () => new Promise<void>(() => { /* never */ });

    const ac = new AbortController();
    const closePromise = client.close({ drainTimeoutMs: 60_000, signal: ac.signal });
    setImmediate(() => ac.abort());
    await expect(closePromise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.state).toBe('CLOSED');
  });

  it('destroy() is a no-op when no Connection is attached', () => {
    const client = createClient({ host: '127.0.0.1', port: 1 });
    expect(() => client.destroy()).not.toThrow();
    // No connection attached -> falls through baseline state
    expect(client.state).toBe('DISCONNECTED');
  });

  it('_attachExistingConnection throws if called twice', () => {
    const [a] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: '127.0.0.1', port: 0 });
    client._attachExistingConnection(conn);

    const [a2] = InMemoryTransport.pair();
    const conn2 = new Connection({ transport: a2 });
    expect(() => client._attachExistingConnection(conn2)).toThrow(
      MllpConnectionError,
    );
  });

  it('reconnecting event re-emits with frozen payload', () => {
    // Force a stateChange CONNECTED -> RECONNECTING via the Connection FSM.
    // The Connection itself does not auto-emit reconnecting in PLAN-01 scope,
    // but it does emit when _transition routes through RECONNECTING. We can
    // trigger this by sending a synthetic 'reconnecting' through the Connection.
    const [a] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: '127.0.0.1', port: 0 });
    client._attachExistingConnection(conn);

    const events: Array<{ connectionId: string }> = [];
    client.on('reconnecting', (e: { connectionId: string }) => {
      events.push(e);
      expect(Object.isFrozen(e)).toBe(true);
    });

    conn.notifyConnect('127.0.0.1', 2575);
    // Manually drive the Connection's emit (bypassing the FSM) — emulate Phase 5
    // PLAN-04 behaviour without yet implementing it.
    conn.emit(
      'reconnecting',
      Object.freeze({ connectionId: conn.connectionId, attempt: 1, delayMs: 100 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.connectionId).toBe(conn.connectionId);
  });

  it('connect() rejects when called twice without close (already-connected guard)', () => {
    const [a] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: '127.0.0.1', port: 0 });
    client._attachExistingConnection(conn);
    conn.notifyConnect('127.0.0.1', 2575);

    return expect(client.connect()).rejects.toMatchObject({
      name: 'MllpConnectionError',
      phase: 'connect',
    });
  });
});
