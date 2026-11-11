/**
 * The server connection cap: `ServerOptions.maxConnections`.
 *
 * A connection over the cap is closed at accept: it never becomes a `Connection`, never reaches
 * `onMessage`, never fires `'connection'`, and is reported once on `'connectionRejected'` with the
 * stable code `MLLP_CONNECTION_LIMIT_REACHED`. Unset means no cap, the behaviour before the option
 * existed.
 *
 * Two tiers. Real loopback sockets (plaintext and TLS) cover a cap that is met, exceeded, and left
 * again, and a close that drains while the cap is full, on every runtime CI runs. The server takes
 * only operating-system sockets, so an `InMemoryTransport` cannot be handed to it; the socket-free
 * tier instead offers the accept gate a stand-in socket while the count is full and checks what
 * the caller observes.
 */

import * as net from "node:net";
import * as tls from "node:tls";
import type { EventEmitter } from "node:events";

import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME } from "../_helpers/runtime.js";

import {
  createServer,
  createStarterServer,
  MLLP_CONNECTION_LIMIT_REACHED,
  type ConnectionRejectedEvent,
  type MllpServer,
} from "../../src/server/server.js";
import { MLLP_CONNECTION_LIMIT_REACHED as ROOT_EXPORT } from "../../src/index.js";
import { must } from "../helpers/tracked-servers.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

const MESSAGE =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|CAPMSG01|P|2.5\rPID|1||SYNTH^^^^MR||DOE^JANE\r";

function frame(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x0b]),
    Buffer.from(payload, "latin1"),
    Buffer.from([0x1c, 0x0d]),
  ]);
}

const servers: MllpServer[] = [];
const sockets: net.Socket[] = [];

function track(server: MllpServer): MllpServer {
  servers.push(server);
  return server;
}

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
});

/** A connected plaintext socket, tracked for teardown, with a promise that settles on its close. */
async function open(server: MllpServer): Promise<{ sock: net.Socket; closed: Promise<void> }> {
  const port = must(server.getStats().port);
  const sock = net.createConnection({ host: "127.0.0.1", port });
  sockets.push(sock);
  sock.on("error", () => undefined); // a dropped socket may see a reset; its close is what we read
  const closed = new Promise<void>((resolve) => sock.once("close", () => resolve()));
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  return { sock, closed };
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** The listener's own socket count: the number the cap is compared against. */
function socketCount(server: MllpServer): Promise<number> {
  const inner = (server as unknown as { _netServer: net.Server })._netServer;
  return new Promise((resolve, reject) => {
    inner.getConnections((err, n) => (err ? reject(err) : resolve(n)));
  });
}

async function waitForSockets(server: MllpServer, n: number): Promise<void> {
  const start = Date.now();
  while ((await socketCount(server)) !== n) {
    if (Date.now() - start > 3_000) throw new Error(`socket count never reached ${String(n)}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function observe(server: MllpServer): {
  rejected: ConnectionRejectedEvent[];
  accepted: number[];
  errors: unknown[];
} {
  const seen = { rejected: [] as ConnectionRejectedEvent[], accepted: [] as number[], errors: [] };
  server.on("connectionRejected", (e: ConnectionRejectedEvent) => seen.rejected.push(e));
  server.on("connection", () => seen.accepted.push(seen.accepted.length + 1));
  server.on("error", (e: unknown) => (seen.errors as unknown[]).push(e));
  return seen;
}

describe("ServerOptions.maxConnections: the value", () => {
  it.each([
    ["zero", 0],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number past the safe integers", 2 ** 53],
    ["a numeric string", "2"],
  ])("refuses %s at construction with a RangeError", (_label, value) => {
    expect(() => createServer({ maxConnections: value as number })).toThrow(RangeError);
    expect(() => createServer({ maxConnections: value as number })).toThrow(
      "ServerOptions.maxConnections must be a positive integer, or left unset for no cap",
    );
  });

  it("accepts 1, the smallest cap", () => {
    expect(() => track(createServer({ maxConnections: 1 }))).not.toThrow();
  });

  it("is exported from the package root with its stable value", () => {
    expect(MLLP_CONNECTION_LIMIT_REACHED).toBe("MLLP_CONNECTION_LIMIT_REACHED");
    expect(ROOT_EXPORT).toBe(MLLP_CONNECTION_LIMIT_REACHED);
  });
});

// On every runtime, Deno included: the server counts connections itself rather than relying on the
// listener's own cap and its `'drop'` event, which Deno's `node:net` never emits.
describe("ServerOptions.maxConnections over loopback sockets", () => {
  it("unset: no cap, every connection is accepted and none is rejected", async () => {
    const server = track(createServer({}));
    const seen = observe(server);
    await server.listen(0);
    for (let i = 0; i < 6; i++) await open(server);
    await waitFor(() => server.getStats().activeConnections === 6);

    expect(seen.rejected).toHaveLength(0);
    expect(server.getStats().acceptedTotal).toBe(6);
    // With no cap, nothing is counted either.
    expect((server as unknown as { _openSockets: number })._openSockets).toBe(0);
  });

  it("at the cap: every connection up to it is accepted and nothing is rejected", async () => {
    const server = track(createServer({ maxConnections: 2 }));
    const seen = observe(server);
    await server.listen(0);
    await open(server);
    await open(server);
    await waitFor(() => server.getStats().activeConnections === 2);
    await waitForSockets(server, 2);

    expect(seen.rejected).toHaveLength(0);
    expect(seen.accepted).toHaveLength(2);
  });

  it("over the cap: closed at accept, reported once, and never handed to the handler", async () => {
    const delivered: string[] = [];
    const server = track(
      createServer({
        maxConnections: 2,
        autoAck: "AA",
        onMessage: (payload) => {
          delivered.push(payload.toString("latin1"));
        },
      }),
    );
    const seen = observe(server);
    await server.listen(0);
    await open(server);
    await open(server);
    await waitFor(() => server.getStats().activeConnections === 2);

    const extra = await open(server);
    const extraPort = extra.sock.localPort;
    extra.sock.write(frame(MESSAGE), () => undefined);
    await extra.closed; // the server closed it, the test did not

    await waitFor(() => seen.rejected.length === 1);
    const event = must(seen.rejected[0]);
    expect(Object.isFrozen(event)).toBe(true);
    expect(event.code).toBe("MLLP_CONNECTION_LIMIT_REACHED");
    expect(event.message).toBe(
      "connection closed at accept: the server already holds maxConnections connections",
    );
    expect(event.maxConnections).toBe(2);
    expect(event.remoteAddress).toBe("127.0.0.1");
    expect(event.remotePort).toBe(extraPort);
    expect(event.timestamp).toBeInstanceOf(Date);

    // Give a stray delivery every chance to show up before asserting its absence.
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered).toHaveLength(0);
    expect(seen.accepted).toHaveLength(2);
    expect(server.getStats().acceptedTotal).toBe(2);
    expect(server.getStats().activeConnections).toBe(2);
    expect(seen.errors).toHaveLength(0);
  });

  it("back under the cap: a closed connection frees its place for the next one", async () => {
    const server = track(createServer({ maxConnections: 1 }));
    const seen = observe(server);
    await server.listen(0);
    const first = await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);

    const over = await open(server);
    await over.closed;
    await waitFor(() => seen.rejected.length === 1);

    first.sock.end();
    await first.closed;
    await waitForSockets(server, 0);

    const next = await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);
    expect(seen.accepted).toHaveLength(2);
    expect(seen.rejected).toHaveLength(1);
    expect(next.sock.destroyed).toBe(false);

    // And the cap still holds after the turnover.
    const overAgain = await open(server);
    await overAgain.closed;
    await waitFor(() => seen.rejected.length === 2);
    expect(seen.accepted).toHaveLength(2);
  });

  it("a throwing 'connectionRejected' subscriber surfaces on 'error' and the server keeps serving", async () => {
    const server = track(createServer({ maxConnections: 1, autoAck: "AA" }));
    const errors: unknown[] = [];
    server.on("error", (e: unknown) => errors.push(e));
    server.on("connectionRejected", () => {
      throw new Error("metrics tap broke");
    });
    await server.listen(0);
    const first = await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);

    const over = await open(server);
    await over.closed;
    await waitFor(() => errors.length === 1);
    expect((errors[0] as Error).message).toBe("metrics tap broke");

    const acks: Buffer[] = [];
    first.sock.on("data", (chunk: Buffer) => acks.push(chunk));
    first.sock.write(frame(MESSAGE));
    await waitFor(() => Buffer.concat(acks).includes("MSA|AA|CAPMSG01"));
  });

  it("with no subscriber at all, a rejection is silent and the server keeps serving", async () => {
    const server = track(createServer({ maxConnections: 1 }));
    await server.listen(0);
    await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);
    const over = await open(server);
    await over.closed;
    expect(server.getStats().listening).toBe(true);
    expect(server.getStats().activeConnections).toBe(1);
  });

  it("createStarterServer passes the cap through", async () => {
    const server = track(await createStarterServer({ port: 0, maxConnections: 1 }));
    const seen = observe(server);
    await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);
    const over = await open(server);
    await over.closed;
    await waitFor(() => seen.rejected.length === 1);
    expect(must(seen.rejected[0]).maxConnections).toBe(1);
  });
});

describe("ServerOptions.maxConnections while close() drains", () => {
  it("a full server that is draining refuses new connections and reports no rejection", async () => {
    const server = track(createServer({ maxConnections: 1 }));
    const seen = observe(server);
    await server.listen(0);
    const port = must(server.getStats().port);
    await open(server);
    await waitFor(() => server.getStats().activeConnections === 1);

    // Hold the drain open, the way a slow application hook would.
    const internals = server as unknown as {
      _connections: Set<{ beforeClose: () => Promise<void> }>;
    };
    for (const conn of internals._connections) {
      conn.beforeClose = () => new Promise<void>(() => undefined);
    }
    const closing = server.close({ drainTimeoutMs: 300 });

    const refused = await new Promise<string>((resolve) => {
      const sock = net.createConnection({ host: "127.0.0.1", port });
      sockets.push(sock);
      sock.once("connect", () => resolve("connected"));
      sock.once("error", (err: NodeJS.ErrnoException) => resolve(err.code ?? "error"));
    });
    expect(refused).toBe("ECONNREFUSED");

    await closing;
    expect(seen.rejected).toHaveLength(0);
    expect(seen.accepted).toHaveLength(1);
  });

  // Not under Bun: a server listened a second time after close() never counts the first
  // connection to it as active there (measured: the wait for one active connection runs out).
  it.skipIf(RUNTIME === "bun")(
    "after the drain, a re-listened server starts empty and keeps the same cap",
    async () => {
      const server = track(createServer({ maxConnections: 1 }));
      const seen = observe(server);
      await server.listen(0);
      await open(server);
      await waitFor(() => server.getStats().activeConnections === 1);
      await server.close({ drainTimeoutMs: 50 });
      // A socket counts until it has fully closed, which can land just after close() settles.
      await waitForSockets(server, 0);

      await server.listen(0);
      await open(server);
      await waitFor(() => server.getStats().activeConnections === 1);
      const over = await open(server);
      await over.closed;
      await waitFor(() => seen.rejected.length === 1);
      expect(seen.accepted).toHaveLength(2);
    },
  );
});

describe("ServerOptions.maxConnections over TLS", () => {
  it("closes an over-cap socket before its handshake, so it is no TLS client error", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = track(createServer({ maxConnections: 1, tls: { cert, key } }));
    const seen = observe(server);
    const tlsErrors: unknown[] = [];
    server.on("tlsClientError", (e: unknown) => tlsErrors.push(e));
    await server.listen(0);
    const port = must(server.getStats().port);

    const first = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" });
    sockets.push(first);
    await new Promise<void>((resolve, reject) => {
      first.once("secureConnect", () => resolve());
      first.once("error", reject);
    });
    await waitFor(() => server.getStats().activeConnections === 1);

    const over = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" });
    sockets.push(over);
    const outcome = await new Promise<string>((resolve) => {
      over.once("secureConnect", () => resolve("handshake completed"));
      over.once("error", () => resolve("closed before the handshake"));
    });
    expect(outcome).toBe("closed before the handshake");

    await waitFor(() => seen.rejected.length === 1);
    expect(seen.accepted).toHaveLength(1);
    expect(tlsErrors).toHaveLength(0);
    expect(server.getStats().tlsClientErrorsTotal).toBe(0);
  });
});

// The plaintext turnover above, for each way a TLS connection can end. A TLS socket is the
// runtime's wrapper around the raw socket the gate counted, so the place is given back only if
// that raw socket's close still reaches the count however the connection ended. On every runtime
// CI runs, Bun and Deno included.
describe("ServerOptions.maxConnections over TLS: an ended connection frees its place", () => {
  /** The number the cap is compared against. */
  function held(server: MllpServer): number {
    return (server as unknown as { _openSockets: number })._openSockets;
  }

  /** A TLS server with room for one connection, and what it reports. */
  async function tlsServer(): Promise<{
    server: MllpServer;
    seen: ReturnType<typeof observe>;
    port: number;
    cert: string;
  }> {
    const { cert, key } = buildServerCertFixture();
    const server = track(createServer({ maxConnections: 1, tls: { cert, key } }));
    const seen = observe(server);
    server.on("tlsClientError", () => undefined); // a failed handshake is one case under test
    await server.listen(0);
    return { server, seen, port: must(server.getStats().port), cert };
  }

  /** A TLS client that has finished its handshake, tracked for teardown. */
  async function handshaken(port: number, cert: string): Promise<tls.TLSSocket> {
    const sock = tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" });
    sockets.push(sock);
    await new Promise<void>((resolve, reject) => {
      sock.once("secureConnect", () => resolve());
      sock.once("error", reject);
    });
    return sock;
  }

  /** After the first connection ended: the place is free, and the next connection is served. */
  async function expectPlaceFreed(
    server: MllpServer,
    seen: ReturnType<typeof observe>,
    port: number,
    cert: string,
  ): Promise<void> {
    await waitFor(() => held(server) === 0);
    const acceptedBefore = seen.accepted.length;
    const next = await handshaken(port, cert);
    await waitFor(() => seen.accepted.length === acceptedBefore + 1);
    expect(next.destroyed).toBe(false);
    expect(held(server)).toBe(1);
    expect(seen.rejected).toHaveLength(0);
  }

  it("a clean close", async () => {
    const { server, seen, port, cert } = await tlsServer();
    const first = await handshaken(port, cert);
    await waitFor(() => seen.accepted.length === 1);
    expect(held(server)).toBe(1);

    first.end();
    await expectPlaceFreed(server, seen, port, cert);
  });

  it("a client that destroys its socket", async () => {
    const { server, seen, port, cert } = await tlsServer();
    const first = await handshaken(port, cert);
    await waitFor(() => seen.accepted.length === 1);
    expect(held(server)).toBe(1);

    first.destroy();
    await expectPlaceFreed(server, seen, port, cert);
  });

  it("a failed handshake", async () => {
    const { server, seen, port, cert } = await tlsServer();
    // A client that does not trust the server's certificate gives up during the handshake.
    const first = tls.connect({ host: "127.0.0.1", port, servername: "localhost" });
    sockets.push(first);
    const outcome = await new Promise<string>((resolve) => {
      first.once("secureConnect", () => resolve("handshake completed"));
      first.once("error", () => resolve("handshake failed"));
    });
    expect(outcome).toBe("handshake failed");
    await expectPlaceFreed(server, seen, port, cert);
  });

  it("a peer that connects and closes without a byte", async () => {
    const { server, seen, port, cert } = await tlsServer();
    const first = net.createConnection({ host: "127.0.0.1", port });
    sockets.push(first);
    first.on("error", () => undefined);
    await new Promise<void>((resolve, reject) => {
      first.once("connect", () => resolve());
      first.once("error", reject);
    });
    await waitFor(() => held(server) === 1);

    first.end();
    await expectPlaceFreed(server, seen, port, cert);
    expect(seen.accepted).toHaveLength(1);
  });
});

describe("ServerOptions.maxConnections without a socket", () => {
  /** A stand-in for an accepted socket: the fields the accept gate reads, and its destroy. */
  function fakeSocket(peer: { remoteAddress?: string; remotePort?: number } = {}): {
    destroyed: boolean;
    remoteAddress?: string;
    remotePort?: number;
    destroy: () => void;
    once: () => void;
  } {
    return {
      destroyed: false,
      ...peer,
      destroy() {
        this.destroyed = true;
      },
      once: () => undefined,
    };
  }

  /** Fill the count to the cap without a socket, then offer the server one more. */
  function offerOverCap(server: MllpServer, cap: number, socket: object): void {
    (server as unknown as { _openSockets: number })._openSockets = cap;
    (server as unknown as { _netServer: EventEmitter })._netServer.emit("connection", socket);
  }

  it("reports the peer address and port it is given, in a frozen event, and closes the socket", () => {
    const delivered: Buffer[] = [];
    const server = track(
      createServer({ maxConnections: 3, onMessage: (payload) => void delivered.push(payload) }),
    );
    const seen = observe(server);
    const socket = fakeSocket({ remoteAddress: "192.0.2.10", remotePort: 49_152 });
    offerOverCap(server, 3, socket);

    expect(socket.destroyed).toBe(true);
    expect(seen.rejected).toHaveLength(1);
    const event = must(seen.rejected[0]);
    expect(Object.isFrozen(event)).toBe(true);
    expect(event).toMatchObject({
      code: MLLP_CONNECTION_LIMIT_REACHED,
      maxConnections: 3,
      remoteAddress: "192.0.2.10",
      remotePort: 49_152,
    });
    expect(delivered).toHaveLength(0);
    expect(seen.accepted).toHaveLength(0);
    expect(server.getStats().acceptedTotal).toBe(0);
  });

  it("reports null for an address and port the socket could not give", () => {
    const server = track(createServer({ maxConnections: 1 }));
    const seen = observe(server);
    offerOverCap(server, 1, fakeSocket());

    expect(seen.rejected).toHaveLength(1);
    for (const event of seen.rejected) {
      expect(event.remoteAddress).toBeNull();
      expect(event.remotePort).toBeNull();
    }
  });

  it("a TLS server does not count a socket it closed at accept as a failed handshake", () => {
    const server = track(createServer({ maxConnections: 1, tls: buildServerCertFixture() }));
    const tlsErrors: unknown[] = [];
    server.on("tlsClientError", (e: unknown) => tlsErrors.push(e));
    const closed = fakeSocket({ remoteAddress: "192.0.2.11", remotePort: 49_153 });
    offerOverCap(server, 1, closed);
    const inner = (server as unknown as { _netServer: EventEmitter })._netServer;

    // The report a runtime may make of the socket the cap closed (Bun does) is left out...
    inner.emit("tlsClientError", new Error("socket hang up"), closed);
    expect(tlsErrors).toHaveLength(0);
    expect(server.getStats().tlsClientErrorsTotal).toBe(0);

    // ...and a real failed handshake on any other socket is still reported.
    inner.emit("tlsClientError", new Error("wrong version number"), fakeSocket());
    expect(tlsErrors).toHaveLength(1);
    expect(server.getStats().tlsClientErrorsTotal).toBe(1);
  });

  it("gives the place back when the TLS socket it serves is the socket it counted, as under Bun", async () => {
    // Node.js counts the raw socket and serves the TLS socket wrapping it, two objects. Bun hands
    // 'connection' and 'secureConnection' the same object, so the transport that takes it over
    // replaces the cap's 'close' listener. Modelled here by reporting the counted socket as the
    // secure one.
    const server = track(createServer({ maxConnections: 1, tls: buildServerCertFixture() }));
    const inner = (server as unknown as { _netServer: EventEmitter })._netServer;
    const socket = new net.Socket();
    socket.on("error", () => undefined);
    inner.emit("connection", socket);
    expect((server as unknown as { _openSockets: number })._openSockets).toBe(1);

    inner.emit("secureConnection", socket);
    socket.destroy();
    await waitFor(() => (server as unknown as { _openSockets: number })._openSockets === 0);
    // Given back once, though the socket carries the cap's listener twice.
    await new Promise((r) => setTimeout(r, 20));
    expect((server as unknown as { _openSockets: number })._openSockets).toBe(0);
  });

  it("gates nothing when no cap is set", () => {
    const server = track(createServer({}));
    const inner = (server as unknown as { _netServer: net.Server })._netServer;
    expect(inner.listenerCount("connection")).toBe(1);
    expect(inner.listenerCount("drop")).toBe(0);
    expect(inner.maxConnections).toBeUndefined();
  });

  it("counts connections itself, in front of the listener's one accept handler", () => {
    for (const tlsOn of [false, true]) {
      const server = track(
        createServer(
          tlsOn ? { maxConnections: 7, tls: buildServerCertFixture() } : { maxConnections: 7 },
        ),
      );
      const inner = (server as unknown as { _netServer: net.Server })._netServer;
      // One gate, and the listener's own cap and its 'drop' report left unused: the count is ours.
      expect(inner.listenerCount("connection")).toBe(1);
      expect(inner.listenerCount("drop")).toBe(0);
      expect(inner.maxConnections).toBeUndefined();
    }
  });
});
