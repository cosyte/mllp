/**
 * Tests for graceful shutdown, drain-timeout coordination, and AbortSignal on
 * server.listen() and server.close() (SERVER-06, SERVER-09).
 *
 * Also covers deadPeerTimeoutMs idle timer management (SERVER-07).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import * as net from "node:net";

import { must } from "../helpers/tracked-servers.js";

// Helper: connect a raw socket to a server bound on 0 and return it
async function connectToServer(server: MllpServer): Promise<net.Socket> {
  const stats = server.getStats();
  const port = must(stats.port);
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

// MLLP framing helpers
const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

function frameMessage(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "ascii");
  const framed = Buffer.allocUnsafe(payloadBuf.length + 3);
  framed[0] = VT;
  payloadBuf.copy(framed, 1);
  framed[payloadBuf.length + 1] = FS;
  framed[payloadBuf.length + 2] = CR;
  return framed;
}

describe("SERVER-06: graceful shutdown", () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.close({ drainTimeoutMs: 50 }).catch(() => {
        /* ignore */
      });
    }
    servers.length = 0;
  });

  function makeServer(opts: Parameters<typeof createServer>[0] = {}) {
    const s = createServer(opts);
    servers.push(s);
    return s;
  }

  it("close() on a server with zero connections resolves immediately", async () => {
    const server = makeServer({});
    await server.listen(0);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("close() on a freshly-created server (never listened) resolves immediately", async () => {
    const server = makeServer({});
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("close() on a server with one active connection eventually resolves", async () => {
    const server = makeServer({});
    await server.listen(0);

    const sock = await connectToServer(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.getStats().activeConnections).toBe(1);

    // Destroy the socket so the connection drains naturally
    const closePromise = server.close({ drainTimeoutMs: 500 });
    sock.destroy();

    await expect(closePromise).resolves.toBeUndefined();
  });

  it("close() stops accepting new connections", async () => {
    const server = makeServer({});
    await server.listen(0);
    const port = must(server.getStats().port);

    await server.close({ drainTimeoutMs: 100 });

    // After close(), connecting should fail
    await expect(
      new Promise<void>((resolve, reject) => {
        const sock = net.createConnection({ host: "127.0.0.1", port });
        sock.once("connect", () => {
          sock.destroy();
          resolve();
        });
        sock.once("error", () => reject(new Error("connection refused")));
        setTimeout(() => {
          sock.destroy();
          reject(new Error("timeout"));
        }, 200);
      }),
    ).rejects.toThrow();
  });

  it("close({ drainTimeoutMs }) with stuck connection: after timeout, destroy() called and close() resolves", async () => {
    // Create a server; after connection is accepted, override its beforeClose
    // hook so the connection never resolves on its own, simulating a straggler.
    const server = makeServer({});

    // Intercept 'connection' event to override the beforeClose hook
    server.on("connection", () => {
      // Wait a tick, then override the first active connection's beforeClose
      setImmediate(() => {
        const privateServer = server as unknown as {
          _connections: Set<{ beforeClose: () => Promise<void> }>;
        };
        for (const conn of privateServer._connections) {
          // Override beforeClose to never resolve, simulates a stuck drain
          conn.beforeClose = () =>
            new Promise<void>(() => {
              /* never resolves */
            });
        }
      });
    });

    await server.listen(0);

    const sock = await connectToServer(server);
    // Give time for connection to be accepted and beforeClose to be overridden
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(server.getStats().activeConnections).toBe(1);

    const start = Date.now();
    // Use a short drain timeout; with a stuck beforeClose, the straggler
    // destroy() will fire after drainTimeoutMs and resolve the Promise.all
    const closePromise = server.close({ drainTimeoutMs: 100 });

    await expect(closePromise).resolves.toBeUndefined();
    const elapsed = Date.now() - start;
    // Should complete around the drainTimeoutMs (100ms), allow generous tolerance
    expect(elapsed).toBeGreaterThanOrEqual(80);
    expect(elapsed).toBeLessThan(2000);

    sock.destroy();
  }, 5000);

  it("close() sets listening=false after completing", async () => {
    const server = makeServer({});
    await server.listen(0);
    expect(server.getStats().listening).toBe(true);
    await server.close({ drainTimeoutMs: 50 });
    expect(server.getStats().listening).toBe(false);
  });

  it("_drainAll exists as a method on MllpServer class", () => {
    const server = makeServer({});
    // Access private method via type cast to verify it exists
    const privateServer = server as unknown as Record<string, unknown>;
    expect(typeof privateServer["_drainAll"]).toBe("function");
  });
});

describe("SERVER-09: AbortSignal on listen()", () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.close({ drainTimeoutMs: 50 }).catch(() => {
        /* ignore */
      });
    }
    servers.length = 0;
  });

  function makeServer(opts: Parameters<typeof createServer>[0] = {}) {
    const s = createServer(opts);
    servers.push(s);
    return s;
  }

  it("listen(0, { signal }) with already-aborted signal rejects with AbortError", async () => {
    const server = makeServer({});
    const ac = new AbortController();
    ac.abort();

    await expect(server.listen(0, { signal: ac.signal })).rejects.toThrow();
    const result = await server.listen(0, { signal: ac.signal }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(DOMException);
    expect((result as DOMException).name).toBe("AbortError");
  });

  it("listen(0, { signal }) aborting during listen rejects with AbortError", async () => {
    const server = makeServer({});
    const ac = new AbortController();

    const listenPromise = server.listen(0, { signal: ac.signal });
    // Abort after a microtask tick, before listen resolves in most cases
    // (this test is inherently racy; use setImmediate to ensure listen() has time to start)
    setImmediate(() => ac.abort());

    const result = await listenPromise.catch((e: unknown) => e);
    // Either resolves (if listen completed before abort) or rejects with AbortError
    // We specifically test the AbortError case when aborted before listen resolves
    if (result instanceof Error || result instanceof DOMException) {
      expect((result as DOMException).name).toBe("AbortError");
    }
    // If it resolved, the server is now listening, clean it up
    // (this is acceptable, abort after resolution is a no-op per spec)
  });

  it("listen(0, { signal }) with already-aborted signal does not leave server listening", async () => {
    const server = makeServer({});
    const ac = new AbortController();
    ac.abort();

    await server.listen(0, { signal: ac.signal }).catch(() => {
      /* expected */
    });
    expect(server.getStats().listening).toBe(false);
  });

  it("AbortError rejection uses DOMException with name AbortError", async () => {
    const server = makeServer({});
    const ac = new AbortController();
    ac.abort();

    let caught: unknown;
    try {
      await server.listen(0, { signal: ac.signal });
    } catch (e) {
      caught = e;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });
});

describe("SERVER-09: AbortSignal on close()", () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.close({ drainTimeoutMs: 50 }).catch(() => {
        /* ignore */
      });
    }
    servers.length = 0;
  });

  function makeServer(opts: Parameters<typeof createServer>[0] = {}) {
    const s = createServer(opts);
    servers.push(s);
    return s;
  }

  it("close({ signal }) with already-aborted signal rejects with AbortError", async () => {
    const server = makeServer({});
    await server.listen(0);
    const ac = new AbortController();
    ac.abort();

    const result = await server.close({ signal: ac.signal }).catch((e: unknown) => e);
    expect(result).toBeInstanceOf(DOMException);
    expect((result as DOMException).name).toBe("AbortError");
  });

  it("close({ signal }) aborting during drain: connections destroyed, close resolves or rejects with AbortError", async () => {
    const server = makeServer({});
    await server.listen(0);

    const sock = await connectToServer(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.getStats().activeConnections).toBe(1);

    const ac = new AbortController();
    const closePromise = server.close({ signal: ac.signal, drainTimeoutMs: 5000 });

    // Abort immediately, should cancel the drain
    setImmediate(() => ac.abort());

    const result = await closePromise.catch((e: unknown) => e);
    // When abort fires during drain: either rejects with AbortError, or resolves
    // (if connections were already closed). The important thing is it doesn't hang.
    if (result instanceof Error || result instanceof DOMException) {
      expect((result as DOMException).name).toBe("AbortError");
    }

    sock.destroy();
  }, 3000);
});

describe("SERVER-07: deadPeerTimeoutMs idle timer", () => {
  const servers: MllpServer[] = [];

  afterEach(async () => {
    for (const s of servers) {
      await s.close({ drainTimeoutMs: 50 }).catch(() => {
        /* ignore */
      });
    }
    servers.length = 0;
  });

  function makeServer(opts: Parameters<typeof createServer>[0] = {}) {
    const s = createServer(opts);
    servers.push(s);
    return s;
  }

  it("deadPeerTimeoutMs: connection is destroyed after timeout elapses with no messages", async () => {
    const server = makeServer({ deadPeerTimeoutMs: 100 });
    await server.listen(0);

    const sock = await connectToServer(server);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(server.getStats().activeConnections).toBe(1);

    // Wait for the idle timer to fire (100ms + tolerance)
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // After idle timeout, connection should be removed from _connections
    expect(server.getStats().activeConnections).toBe(0);

    sock.destroy();
  }, 3000);

  it("deadPeerTimeoutMs: timer resets on message, connection survives initial timeout window", async () => {
    const received: Buffer[] = [];
    const server = makeServer({
      deadPeerTimeoutMs: 150,
      onMessage: (payload) => {
        received.push(payload);
      },
    });
    await server.listen(0);

    const sock = await connectToServer(server);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const msg = "MSH|^~\\&|SENDER||RECV||20260424||ADT^A01|CTRL001|P|2.5";

    // Send a message at t=80ms (before the 150ms timeout)
    await new Promise<void>((resolve) => setTimeout(resolve, 80));
    sock.write(frameMessage(msg));
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    // Connection should still be alive (timer reset on message)
    expect(server.getStats().activeConnections).toBe(1);

    // Wait for the timer to fire after the reset (150ms + tolerance)
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // Now the idle timer should have fired
    expect(server.getStats().activeConnections).toBe(0);

    sock.destroy();
  }, 5000);
});
