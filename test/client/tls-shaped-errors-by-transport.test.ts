/**
 * A socket error that looks like a TLS protocol failure (`EPROTO`, or a message naming an SSL
 * alert) is read as one only on a client configured for TLS.
 *
 * On a plaintext client such an error carries no TLS `connectionCause` when it fails `connect()`,
 * and a transient one after the connection is up still leads to a reconnect. On a TLS client the
 * same kind of error after the connection is up is permanent: the reconnect would meet the same
 * TLS failure. The errors are synthetic and injected into the client's own socket.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as netCreateServer, type Server as NetServer } from "node:net";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

import { RUNTIME } from "../_helpers/runtime.js";
import { MllpClient, createClient } from "../../src/client/client.js";
import { MllpConnectionError } from "../../src/connection/index.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

/** Poll `cond` every 10ms until true or `timeoutMs` elapses (real timers). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A synthetic socket error with `code`, as Node.js would raise it. */
function socketError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

type SocketFactory = { _createSocketAndTransport: () => { socket: Socket | TLSSocket } };

/** Record every socket the client opens, so a test can fail one with an error of its choosing. */
function captureSockets(): Array<Socket | TLSSocket> {
  const sockets: Array<Socket | TLSSocket> = [];
  const prototype = MllpClient.prototype as unknown as SocketFactory;
  const original = prototype._createSocketAndTransport;
  vi.spyOn(prototype, "_createSocketAndTransport").mockImplementation(function (this: MllpClient) {
    const made = original.call(this);
    sockets.push(made.socket);
    return made;
  });
  return sockets;
}

const clients: MllpClient[] = [];
const servers: NetServer[] = [];
const mllpServers: MllpServer[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients) c.destroy();
  clients.length = 0;
  for (const s of servers) {
    s.close();
    s.unref();
  }
  servers.length = 0;
  for (const s of mllpServers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  mllpServers.length = 0;
});

/** A plain TCP listener that keeps every socket open. */
async function plainListener(): Promise<number> {
  const server = netCreateServer(() => undefined);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (typeof addr !== "object" || addr === null) throw new Error("no address");
  return addr.port;
}

describe("TLS-shaped socket errors on a plaintext client", () => {
  it("an EPROTO that fails connect() carries no TLS connectionCause", async () => {
    const sockets = captureSockets();
    const port = await plainListener();
    const client = createClient({ host: "127.0.0.1", port });
    clients.push(client);

    const pending = client.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error("no socket was opened");
    socket.destroy(socketError("synthetic protocol error", "EPROTO"));

    const err: unknown = await pending.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MllpConnectionError);
    expect((err as MllpConnectionError).connectionCause).toBeUndefined();
  });

  it("a transient error naming an SSL alert after connect still reconnects", async () => {
    const sockets = captureSockets();
    const port = await plainListener();
    const client = createClient({
      host: "127.0.0.1",
      port,
      autoReconnect: true,
      initialDelayMs: 5,
      maxDelayMs: 20,
    });
    clients.push(client);
    client.on("error", () => undefined);
    await client.connect();

    sockets[0]?.destroy(socketError("synthetic ssl alert", "ECONNRESET"));

    await waitFor(() => sockets.length >= 2 && client.state === "CONNECTED");
    expect(client.getStats().reconnectAttempts).toBeGreaterThanOrEqual(1);
  });
});

describe.skipIf(RUNTIME !== "node")("TLS-shaped socket errors on a TLS client", () => {
  it("a transient-coded error naming an SSL alert after connect is permanent", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key } });
    mllpServers.push(server);
    await server.listen(0, "127.0.0.1");
    const port = server.getStats().port;
    if (port === null) throw new Error("no port");

    const sockets = captureSockets();
    const client = createClient({
      host: "127.0.0.1",
      port,
      tls: { ca: cert, servername: "localhost" },
      autoReconnect: true,
      initialDelayMs: 5,
      maxDelayMs: 20,
    });
    clients.push(client);
    client.on("error", () => undefined);
    await client.connect();

    sockets[0]?.destroy(socketError("synthetic ssl alert", "ECONNRESET"));

    await waitFor(() => client.state === "CLOSED");
    await new Promise((r) => setTimeout(r, 100));
    expect(sockets).toHaveLength(1);
    expect(client.getStats().reconnectAttempts).toBe(0);
  });
});
