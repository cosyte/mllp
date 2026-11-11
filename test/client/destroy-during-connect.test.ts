/**
 * `destroy()` while `connect()` is still connecting settles the `connect()` promise.
 *
 * A destroy given no reason closes the socket and emits nothing but `'close'`, so a `connect()`
 * that only listened for the connect event and for `'error'` was left pending for good. The peer
 * here is a plain TCP listener that accepts the connection and never writes a byte, so the TCP
 * connect completes and a TLS handshake waits for a ServerHello that never comes: the client is
 * still connecting, for as long as the test likes, when `destroy()` runs.
 */

import { afterEach, describe, expect, it } from "vitest";
import { getEventListeners } from "node:events";
import { createServer as netCreateServer, type Server as NetServer, type Socket } from "node:net";

import { createClient } from "../../src/client/client.js";
import { MllpConnectionError } from "../../src/connection/index.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";
import { RUNTIME } from "../_helpers/runtime.js";

const servers: NetServer[] = [];
const peers: Socket[] = [];

afterEach(async () => {
  for (const p of peers) p.destroy();
  peers.length = 0;
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  servers.length = 0;
});

/** A listener that accepts every connection and never answers it. */
async function silentPeer(): Promise<{ port: number; accepted: () => number }> {
  let count = 0;
  const server = netCreateServer((socket) => {
    count += 1;
    peers.push(socket);
    socket.on("error", () => undefined);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a TCP address");
  return { port: address.port, accepted: () => count };
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** How a promise settled within `ms`, or `'pending'` if it had not. */
async function settledWithin(p: Promise<unknown>, ms: number): Promise<unknown> {
  return Promise.race([
    p.then(
      () => "resolved",
      (err: unknown) => err,
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), ms)),
  ]);
}

describe("destroy() during connect()", () => {
  it("with no reason, rejects connect() with a typed connect-phase error", async () => {
    const peer = await silentPeer();
    const { cert } = buildServerCertFixture();
    const client = createClient({
      host: "127.0.0.1",
      port: peer.port,
      tls: { ca: cert, servername: "localhost" },
    });
    const connecting = client.connect();
    await waitFor(() => peer.accepted() === 1);

    client.destroy();
    const outcome = await settledWithin(connecting, 2_000);

    expect(outcome).toBeInstanceOf(MllpConnectionError);
    const err = outcome as MllpConnectionError;
    expect(err.phase).toBe("connect");
    expect(err.message).toBe("connection closed before it was established");
    expect(err.cause).toBeInstanceOf(Error);
    expect(err.cause.message).toBe("closed before connect");
    expect(err.connectionCause).toBeUndefined();
    expect(client.state).toBe("CLOSED");
  });

  it("with a reason, rejects connect() with that reason as the cause", async () => {
    const peer = await silentPeer();
    const { cert } = buildServerCertFixture();
    const client = createClient({
      host: "127.0.0.1",
      port: peer.port,
      tls: { ca: cert, servername: "localhost" },
    });
    const connecting = client.connect();
    await waitFor(() => peer.accepted() === 1);

    const reason = new Error("shutting down");
    client.destroy(reason);
    const outcome = await settledWithin(connecting, 2_000);

    expect(outcome).toBeInstanceOf(MllpConnectionError);
    expect((outcome as MllpConnectionError).phase).toBe("connect");
    expect((outcome as MllpConnectionError).cause).toBe(reason);
  });
});

// Node only: `getEventListeners` on an `AbortSignal` is how Node exposes an EventTarget's
// listeners. What these pin, that a settled connect() leaves nothing of itself on the caller's
// signal, is the same on every runtime.
describe.skipIf(RUNTIME !== "node")(
  "connect() leaves nothing of itself on the caller's signal",
  () => {
    /** Listeners on `signal`: the client keeps exactly one for its lifetime, to stop reconnecting. */
    function abortListeners(signal: AbortSignal): number {
      return getEventListeners(signal, "abort").length;
    }

    it("once it resolves", async () => {
      const server = netCreateServer((socket) => {
        peers.push(socket);
      });
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
      const address = server.address();
      if (address === null || typeof address === "string")
        throw new Error("expected a TCP address");

      const client = createClient({ host: "127.0.0.1", port: address.port });
      const ac = new AbortController();
      const connecting = client.connect({ signal: ac.signal });
      expect(abortListeners(ac.signal)).toBe(2);
      await connecting;
      expect(abortListeners(ac.signal)).toBe(1);
      client.destroy();
    });

    it("once destroy() rejects it", async () => {
      const peer = await silentPeer();
      const { cert } = buildServerCertFixture();
      const client = createClient({
        host: "127.0.0.1",
        port: peer.port,
        tls: { ca: cert, servername: "localhost" },
      });
      const ac = new AbortController();
      const connecting = client.connect({ signal: ac.signal });
      await waitFor(() => peer.accepted() === 1);
      expect(abortListeners(ac.signal)).toBe(2);

      client.destroy();
      expect(await settledWithin(connecting, 2_000)).toBeInstanceOf(MllpConnectionError);
      expect(abortListeners(ac.signal)).toBe(1);
    });
  },
);
