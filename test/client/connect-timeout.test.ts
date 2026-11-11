/**
 * `ClientOptions.connectTimeoutMs`: a bound on the TCP connect and the TLS handshake.
 *
 * Real sockets and real timers throughout, with small bounds. Two kinds of unresponsive peer:
 *
 * - **TCP**: a connect that never completes. A loopback listener always completes the TCP
 *   handshake in the kernel, so a black-holed address is simulated by stubbing
 *   `net.Socket.prototype.connect` to start nothing: the socket stays in its connecting state and
 *   never emits `'connect'`, exactly what a client facing a dropped SYN sees.
 * - **TLS**: a plain TCP listener that accepts the connection and never writes a byte, so the TCP
 *   connect completes and the TLS handshake waits for a ServerHello that never comes.
 *
 * The retry cases first connect for real, lose the link, and then meet an unresponsive peer on
 * the reconnect attempt, so the expiry has to travel through the reconnect classifier and the
 * caller's `retryStrategy`.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer as netCreateServer, Socket } from "node:net";
import type { Server as NetServer } from "node:net";
import { TLSSocket } from "node:tls";
import {
  createClient,
  createStarterClient,
  type MllpClient,
  type RetryContext,
} from "../../src/client/client.js";
import { isTransientConnectionError } from "../../src/client/error.js";
import { MllpConnectionError } from "../../src/connection/index.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

const TIMEOUT_MESSAGE =
  "connect timed out: the connection, including its TLS handshake when TLS is on, was not " +
  "established within connectTimeoutMs";

const RANGE_MESSAGE =
  "ClientOptions.connectTimeoutMs must be an integer from 1 to 2147483647, or left unset " +
  "for no bound";

/** Poll `cond` every 10 ms until true or `timeoutMs` elapses (real timers). */
async function waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Settle a promise into its rejection reason, failing if it resolves. */
async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (err: unknown) => err,
  );
}

/** Stub every socket's connect so it starts nothing and stays connecting: a black hole. */
function blackHoleConnects(): { restore: () => void } {
  const spy = vi.spyOn(Socket.prototype, "connect").mockImplementation(function (this: Socket) {
    return this;
  });
  return { restore: () => spy.mockRestore() };
}

const clients: MllpClient[] = [];
const servers: NetServer[] = [];
const peerSockets: Socket[] = [];
let restoreConnect: (() => void) | null = null;

afterEach(() => {
  restoreConnect?.();
  restoreConnect = null;
  for (const c of clients) c.destroy();
  clients.length = 0;
  for (const s of peerSockets) s.destroy();
  peerSockets.length = 0;
  for (const s of servers) {
    s.close();
    s.unref();
  }
  servers.length = 0;
});

function track(c: MllpClient): MllpClient {
  clients.push(c);
  // Every case here reads the outcome off the promise or the retry context; the dual 'error'
  // event a connect failure also raises is not under test, and an unlistened one would throw.
  c.on("error", () => undefined);
  return c;
}

function listen(server: NetServer): Promise<number> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) resolve(addr.port);
      else reject(new Error("no address"));
    });
  });
}

/** A TCP listener that accepts every connection and never writes to it. */
async function silentPeer(): Promise<{ port: number; accepted: () => number }> {
  let accepted = 0;
  const server = netCreateServer((sock) => {
    accepted += 1;
    peerSockets.push(sock);
  });
  const port = await listen(server);
  return { port, accepted: () => accepted };
}

function expectConnectTimeout(err: unknown): void {
  expect(err).toBeInstanceOf(MllpConnectionError);
  const e = err as MllpConnectionError;
  expect(e.message).toBe(TIMEOUT_MESSAGE);
  expect(e.phase).toBe("connect");
  expect(e.connectionCause).toBe("connect-timeout");
  expect(e.cause).toBeInstanceOf(Error);
  expect(e.cause.message).toBe(TIMEOUT_MESSAGE);
  expect((e.cause as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");
  expect(isTransientConnectionError(e)).toBe(true);
  expect(isTransientConnectionError(e.cause)).toBe(true);
}

describe("ClientOptions.connectTimeoutMs validation", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648])(
    "refuses %s with a RangeError at construction",
    (value) => {
      expect(() => createClient({ host: "127.0.0.1", port: 1, connectTimeoutMs: value })).toThrow(
        new RangeError(RANGE_MESSAGE),
      );
    },
  );

  it.each([1, 2_147_483_647])("accepts %s", (value) => {
    expect(() =>
      createClient({ host: "127.0.0.1", port: 1, connectTimeoutMs: value }),
    ).not.toThrow();
  });

  it("accepts the option left unset", () => {
    expect(() => createClient({ host: "127.0.0.1", port: 1 })).not.toThrow();
  });

  it("refuses an invalid value through createStarterClient too, before connecting", async () => {
    await expect(
      createStarterClient({ host: "127.0.0.1", port: 1, connectTimeoutMs: 0 }),
    ).rejects.toThrow(new RangeError(RANGE_MESSAGE));
  });
});

describe("TCP connect expiry against an unresponsive peer", () => {
  it("destroys the socket and rejects connect() with connectionCause 'connect-timeout'", async () => {
    restoreConnect = blackHoleConnects().restore;
    const client = track(createClient({ host: "127.0.0.1", port: 2575, connectTimeoutMs: 60 }));
    const started = Date.now();
    const err = await rejectionOf(client.connect());
    const elapsed = Date.now() - started;
    expectConnectTimeout(err);
    expect(elapsed).toBeGreaterThanOrEqual(55);
    // A connect failure leaves the attempt's Connection closed, and nothing reconnects.
    expect(client.state).toBe("CLOSED");
    expect(client.getStats().reconnectAttempts).toBe(0);
  });

  it("leaves a connect unbounded when the option is unset", async () => {
    restoreConnect = blackHoleConnects().restore;
    const client = track(createClient({ host: "127.0.0.1", port: 2575 }));
    const ac = new AbortController();
    let settled = false;
    const pending = client.connect({ signal: ac.signal }).then(
      () => (settled = true),
      () => (settled = true),
    );
    await sleep(150);
    expect(settled).toBe(false);
    expect(client.state).toBe("CONNECTING");
    // Ended by the caller's own signal, the bound a caller without this option has.
    ac.abort();
    await pending;
  });

  it("does not fire after a connect that completed in time", async () => {
    const { port } = await silentPeer();
    const client = track(createClient({ host: "127.0.0.1", port, connectTimeoutMs: 50 }));
    await client.connect();
    await sleep(150);
    expect(client.state).toBe("CONNECTED");
  });

  it("does not fire after a connect that was refused first", async () => {
    // A port nothing listens on: the OS refuses at once, and the timer must not fire later.
    const { port } = await silentPeer();
    const probe = servers.pop();
    await new Promise<void>((r) => probe?.close(() => r()));
    const client = track(createClient({ host: "127.0.0.1", port, connectTimeoutMs: 80 }));
    const errors: unknown[] = [];
    client.on("error", (e: unknown) => errors.push(e));
    const err = await rejectionOf(client.connect());
    expect(err).toBeInstanceOf(MllpConnectionError);
    expect((err as MllpConnectionError).connectionCause).toBeUndefined();
    expect(((err as MllpConnectionError).cause as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
    const errorsAtReject = errors.length;
    await sleep(160);
    expect(errors.length).toBe(errorsAtReject);
  });

  it("does not fire after the connect was aborted", async () => {
    restoreConnect = blackHoleConnects().restore;
    const client = track(createClient({ host: "127.0.0.1", port: 2575, connectTimeoutMs: 60 }));
    const errors: unknown[] = [];
    client.on("error", (e: unknown) => errors.push(e));
    const ac = new AbortController();
    const pending = rejectionOf(client.connect({ signal: ac.signal }));
    ac.abort();
    const err = await pending;
    expect((err as Error).name).toBe("AbortError");
    const errorsAtAbort = errors.length;
    await sleep(150);
    expect(errors.length).toBe(errorsAtAbort);
  });

  it("is passed through by createStarterClient", async () => {
    restoreConnect = blackHoleConnects().restore;
    const err = await rejectionOf(
      createStarterClient({ host: "127.0.0.1", port: 2575, connectTimeoutMs: 60 }),
    );
    expectConnectTimeout(err);
  });
});

describe("TLS handshake expiry against an unresponsive peer", () => {
  it("bounds the handshake after a completed TCP connect", async () => {
    const peer = await silentPeer();
    const client = track(
      createClient({ host: "127.0.0.1", port: peer.port, tls: true, connectTimeoutMs: 80 }),
    );
    const err = await rejectionOf(client.connect());
    // The TCP connect completed; it is the handshake that never finished.
    expect(peer.accepted()).toBe(1);
    expectConnectTimeout(err);
    expect(client.state).toBe("CLOSED");
  });

  it("does not fire after a handshake that completed in time", async () => {
    const { cert, key } = buildServerCertFixture();
    const server = netCreateServer((sock) => {
      peerSockets.push(new TLSSocket(sock, { isServer: true, cert, key }));
    });
    const port = await listen(server);
    const client = track(
      createClient({ host: "127.0.0.1", port, tls: { ca: cert }, connectTimeoutMs: 2_000 }),
    );
    await client.connect();
    await sleep(50);
    expect(client.state).toBe("CONNECTED");
  });
});

describe("expiry on a reconnect attempt feeds the reconnect policy", () => {
  it("TCP: the retry strategy sees a transient ETIMEDOUT, and the client recovers", async () => {
    const live: Socket[] = [];
    const server = netCreateServer((sock) => {
      live.push(sock);
      peerSockets.push(sock);
    });
    const port = await listen(server);
    const contexts: RetryContext[] = [];
    const client = track(
      createClient({
        host: "127.0.0.1",
        port,
        autoReconnect: true,
        connectTimeoutMs: 60,
        retryStrategy: (ctx) => {
          contexts.push(ctx);
          return 5;
        },
      }),
    );
    await client.connect();
    await waitFor(() => live.length === 1);

    // The peer goes dark: every reconnect attempt now meets a connect that never completes.
    restoreConnect = blackHoleConnects().restore;
    live[0]?.destroy();
    await waitFor(() => contexts.length >= 2);

    const afterTimeout = contexts[1];
    expect(afterTimeout?.attempt).toBe(1);
    expect(afterTimeout?.classifiedAs).toBe("transient");
    expect(afterTimeout?.lastError.message).toBe(TIMEOUT_MESSAGE);
    expect((afterTimeout?.lastError as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");

    // The peer comes back: the next attempt connects and the client is whole again.
    restoreConnect();
    restoreConnect = null;
    await waitFor(() => client.state === "CONNECTED" && live.length >= 2);
    expect(client.getStats().reconnectAttempts).toBeGreaterThanOrEqual(2);
  });

  it("TLS: an unanswered handshake on reconnect is retried, and the client recovers", async () => {
    const { cert, key } = buildServerCertFixture();
    let accepted = 0;
    const tlsSessions: TLSSocket[] = [];
    const server = netCreateServer((sock) => {
      accepted += 1;
      peerSockets.push(sock);
      // The first and the third connection get a TLS server; the second is accepted and left
      // silent, so its handshake never completes.
      if (accepted !== 2) {
        const t = new TLSSocket(sock, { isServer: true, cert, key });
        tlsSessions.push(t);
        peerSockets.push(t);
      }
    });
    const port = await listen(server);
    const contexts: RetryContext[] = [];
    const client = track(
      createClient({
        host: "127.0.0.1",
        port,
        tls: { ca: cert },
        autoReconnect: true,
        connectTimeoutMs: 1_000,
        retryStrategy: (ctx) => {
          contexts.push(ctx);
          return 5;
        },
      }),
    );
    await client.connect();
    tlsSessions[0]?.destroy();

    await waitFor(() => contexts.length >= 2, 5000);
    const afterTimeout = contexts[1];
    expect(afterTimeout?.classifiedAs).toBe("transient");
    expect(afterTimeout?.lastError.message).toBe(TIMEOUT_MESSAGE);
    expect((afterTimeout?.lastError as NodeJS.ErrnoException).code).toBe("ETIMEDOUT");

    await waitFor(() => client.state === "CONNECTED" && accepted >= 3, 5000);
    expect(contexts).toHaveLength(2);
  });
});
