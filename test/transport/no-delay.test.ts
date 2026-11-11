/**
 * TCP_NODELAY on every socket the client opens and the server accepts, plain and TLS: on by
 * default, so a frame is never held back by Nagle's algorithm waiting on a delayed TCP
 * acknowledgment, and off again with `noDelay: false`. Each test reads the flag the package
 * last gave each real socket it made, through a spy that still calls through to Node.
 */

import * as net from "node:net";
import * as tls from "node:tls";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClient,
  createStarterClient,
  type ClientOptions,
  type MllpClient,
} from "../../src/client/client.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";
import { must } from "../helpers/tracked-servers.js";

const clients: MllpClient[] = [];
const servers: MllpServer[] = [];
const netServers: net.Server[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients) c.destroy();
  clients.length = 0;
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
  for (const s of netServers) await new Promise((r) => s.close(r));
  netServers.length = 0;
});

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * Spies on `setNoDelay` of `proto`, calling through; the last argument given to each socket, as
 * given: Node reads a missing one as `true`, so an `undefined` here is not the same as `true`.
 */
function watchNoDelay(proto: net.Socket): () => Map<unknown, boolean | undefined> {
  const spy = vi.spyOn(proto, "setNoDelay");
  return () => {
    const last = new Map<unknown, boolean | undefined>();
    spy.mock.calls.forEach((args, i) => {
      last.set(spy.mock.contexts[i], args[0]);
    });
    return last;
  };
}

/** A plain TCP listener that only keeps what it accepts. */
async function plainListener(): Promise<{ port: number; accepted: net.Socket[] }> {
  const accepted: net.Socket[] = [];
  const server = net.createServer((s) => {
    accepted.push(s);
    sockets.push(s);
  });
  netServers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, accepted };
}

function socketOf(client: MllpClient): unknown {
  return (client as unknown as { _socket: unknown })._socket;
}

async function connectedClient(opts: ClientOptions): Promise<MllpClient> {
  const client = createClient(opts);
  clients.push(client);
  await client.connect();
  return client;
}

describe("MllpClient: TCP_NODELAY", () => {
  it("turns Nagle off on the socket it connects by default", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port } = await plainListener();
    const client = await connectedClient({ host: "127.0.0.1", port, autoReconnect: false });

    expect(flags().get(socketOf(client))).toBe(true);
  });

  it("leaves Nagle on when noDelay is false", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port } = await plainListener();
    const client = await connectedClient({
      host: "127.0.0.1",
      port,
      autoReconnect: false,
      noDelay: false,
    });

    expect(flags().get(socketOf(client))).toBe(false);
  });

  it("turns Nagle off again on the socket of every reconnect", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port, accepted } = await plainListener();
    const client = await connectedClient({
      host: "127.0.0.1",
      port,
      autoReconnect: true,
      retryStrategy: () => 5,
    });
    const first = socketOf(client);
    await waitFor(() => accepted.length === 1);

    must(accepted[0]).destroy();
    await waitFor(() => accepted.length === 2 && client.state === "CONNECTED");

    const second = socketOf(client);
    expect(second).not.toBe(first);
    expect(flags().get(first)).toBe(true);
    expect(flags().get(second)).toBe(true);
  });

  it("leaves Nagle on again on the socket of every reconnect when noDelay is false", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port, accepted } = await plainListener();
    const client = await connectedClient({
      host: "127.0.0.1",
      port,
      autoReconnect: true,
      retryStrategy: () => 5,
      noDelay: false,
    });
    const first = socketOf(client);
    await waitFor(() => accepted.length === 1);

    must(accepted[0]).destroy();
    await waitFor(() => accepted.length === 2 && client.state === "CONNECTED");

    const second = socketOf(client);
    expect(second).not.toBe(first);
    expect(flags().get(first)).toBe(false);
    expect(flags().get(second)).toBe(false);
  });

  it("turns Nagle off through createStarterClient by default", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port } = await plainListener();
    const client = await createStarterClient({ host: "127.0.0.1", port, autoReconnect: false });
    clients.push(client);

    expect(flags().get(socketOf(client))).toBe(true);
  });

  it("passes noDelay through createStarterClient", async () => {
    const flags = watchNoDelay(net.Socket.prototype);
    const { port } = await plainListener();
    const client = await createStarterClient({
      host: "127.0.0.1",
      port,
      autoReconnect: false,
      noDelay: false,
    });
    clients.push(client);

    expect(flags().get(socketOf(client))).toBe(false);
  });

  it("turns Nagle off on a TLS connection by default", async () => {
    const { cert, key } = buildServerCertFixture();
    const tlsServer = tls.createServer({ cert, key }, (s) => sockets.push(s));
    netServers.push(tlsServer);
    await new Promise<void>((r) => tlsServer.listen(0, "127.0.0.1", r));
    const port = (tlsServer.address() as net.AddressInfo).port;
    const flags = watchNoDelay(tls.TLSSocket.prototype);
    const client = await connectedClient({
      host: "localhost",
      port,
      autoReconnect: false,
      tls: { ca: cert },
    });

    expect(flags().get(socketOf(client))).toBe(true);
  });
});

describe("MllpServer: TCP_NODELAY", () => {
  async function acceptOne(
    server: MllpServer,
    proto: net.Socket,
    connect: (port: number) => net.Socket,
  ): Promise<Map<unknown, boolean | undefined>> {
    servers.push(server);
    const flags = watchNoDelay(proto);
    await server.listen(0, "127.0.0.1");
    sockets.push(connect(must(server.getStats().port)));
    await waitFor(() => server.getStats().activeConnections === 1);
    return flags();
  }

  const plain = (port: number): net.Socket => net.createConnection({ host: "127.0.0.1", port });

  it("turns Nagle off on each accepted socket by default", async () => {
    const flags = await acceptOne(createServer({}), net.Socket.prototype, plain);

    expect([...flags.values()]).toEqual([true]);
  });

  it("leaves Nagle on when noDelay is false", async () => {
    const flags = await acceptOne(createServer({ noDelay: false }), net.Socket.prototype, plain);

    expect([...flags.values()]).toEqual([false]);
  });

  it("turns Nagle off on each accepted TLS socket by default", async () => {
    const { cert, key } = buildServerCertFixture();
    const flags = await acceptOne(
      createServer({ tls: { cert, key } }),
      tls.TLSSocket.prototype,
      (port) => tls.connect({ host: "127.0.0.1", port, ca: cert, servername: "localhost" }),
    );

    expect([...flags.values()]).toEqual([true]);
  });
});
