/**
 * The server connection cap: `ServerOptions.maxConnections`.
 *
 * A connection over the cap is closed at accept: it never becomes a `Connection`, never reaches
 * `onMessage`, never fires `'connection'`, and is reported once on `'connectionRejected'` with the
 * stable code `MLLP_CONNECTION_LIMIT_REACHED`. Unset means no cap, the behaviour before the option
 * existed.
 *
 * Two tiers. Real loopback sockets (plaintext and TLS) cover a cap that is met, exceeded, and left
 * again, and a close that drains while the cap is full. The server takes only operating-system
 * sockets, so an `InMemoryTransport` cannot be handed to it; the socket-free tier instead drives
 * the accept seam directly with a synthetic over-cap notice and checks what the caller observes.
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

// Not under Deno, here and in the two blocks below: its `node:net` server closes a socket over
// `maxConnections` without emitting `'drop'`, which is where the server learns of it, so the cap's
// `connectionRejected` never arrives and each case waits out its budget. The value checks above and
// the socketless cases below still run there.
describe.skipIf(RUNTIME === "deno")("ServerOptions.maxConnections over loopback sockets", () => {
  it("unset: no cap, every connection is accepted and none is rejected", async () => {
    const server = track(createServer({}));
    const seen = observe(server);
    await server.listen(0);
    for (let i = 0; i < 6; i++) await open(server);
    await waitFor(() => server.getStats().activeConnections === 6);

    expect(seen.rejected).toHaveLength(0);
    expect(server.getStats().acceptedTotal).toBe(6);
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

describe.skipIf(RUNTIME === "deno")("ServerOptions.maxConnections while close() drains", () => {
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

describe.skipIf(RUNTIME === "deno")("ServerOptions.maxConnections over TLS", () => {
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

describe("ServerOptions.maxConnections without a socket", () => {
  /** Deliver an over-cap notice to the accept seam, as the listener does at the cap. */
  function notifyOverCap(server: MllpServer, data?: object): void {
    (server as unknown as { _netServer: EventEmitter })._netServer.emit("drop", data);
  }

  it("reports the peer address and port it is given, in a frozen event", () => {
    const delivered: Buffer[] = [];
    const server = track(
      createServer({ maxConnections: 3, onMessage: (payload) => void delivered.push(payload) }),
    );
    const seen = observe(server);
    notifyOverCap(server, { remoteAddress: "192.0.2.10", remotePort: 49_152 });

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

  it("reports null for an address and port the listener could not read", () => {
    const server = track(createServer({ maxConnections: 1 }));
    const seen = observe(server);
    notifyOverCap(server);
    notifyOverCap(server, {});

    expect(seen.rejected).toHaveLength(2);
    for (const event of seen.rejected) {
      expect(event.remoteAddress).toBeNull();
      expect(event.remotePort).toBeNull();
    }
  });

  it("listens for no over-cap notice when no cap is set", () => {
    const server = track(createServer({}));
    const inner = (server as unknown as { _netServer: EventEmitter })._netServer;
    expect(inner.listenerCount("drop")).toBe(0);
    expect((inner as net.Server).maxConnections).toBeUndefined();
  });

  it("hands the cap to the listener when one is set", () => {
    const server = track(createServer({ maxConnections: 7 }));
    const inner = (server as unknown as { _netServer: net.Server })._netServer;
    expect(inner.maxConnections).toBe(7);
    expect(inner.listenerCount("drop")).toBe(1);
  });
});
