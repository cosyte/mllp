/**
 * `destroy()` while `connect()` is still connecting settles the `connect()` promise.
 *
 * A destroy given no reason closes the socket and emits nothing but `'close'`, so a `connect()`
 * that only listened for the connect event and for `'error'` was left pending for good. The peer
 * here is a plain TCP listener that accepts the connection and never writes a byte, so the TCP
 * connect completes and a TLS handshake waits for a ServerHello that never comes: the client is
 * still connecting, for as long as the test likes, when `destroy()` runs. A second block destroys
 * in the same tick as `connect()`, before the TCP connect completes, over plain TCP and over TLS.
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

/** Build a `destroy()` reason, optionally with an error `code`. */
function reasonWith(message: string, code?: string): Error {
  const err = new Error(message) as NodeJS.ErrnoException;
  if (code !== undefined) err.code = code;
  return err;
}

/**
 * Reasons a caller might pass to `destroy()` that read like a TLS failure: a message with the
 * word `alert`, an `ERR_SSL_` code, `EPROTO`, and a certificate verification code. A reason is
 * the caller's own, so none of them is sorted into a TLS `connectionCause`.
 */
const TLS_SHAPED_REASONS = [
  { label: "a message with the word alert", make: () => reasonWith("alert: shutting down") },
  { label: "an ERR_SSL_ code", make: () => reasonWith("shutting down", "ERR_SSL_SYNTHETIC_TEST") },
  { label: "the EPROTO code", make: () => reasonWith("shutting down", "EPROTO") },
  { label: "a verification code", make: () => reasonWith("shutting down", "CERT_HAS_EXPIRED") },
];

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

  it.each(TLS_SHAPED_REASONS)(
    "with a reason carrying $label, mid-handshake, sets no connectionCause",
    async ({ make }) => {
      const peer = await silentPeer();
      const { cert } = buildServerCertFixture();
      const client = createClient({
        host: "127.0.0.1",
        port: peer.port,
        tls: { ca: cert, servername: "localhost" },
      });
      const connecting = client.connect();
      await waitFor(() => peer.accepted() === 1);

      const reason = make();
      client.destroy(reason);
      const outcome = await settledWithin(connecting, 2_000);

      expect(outcome).toBeInstanceOf(MllpConnectionError);
      const err = outcome as MllpConnectionError;
      expect(err.phase).toBe("connect");
      expect(err.cause).toBe(reason);
      expect(err.message).toBe(reason.message);
      expect(err.connectionCause).toBeUndefined();
    },
  );
});

// The same contract before the TCP connect itself has completed, over plain TCP and over TLS.
// `destroy()` runs in the same tick as `connect()`, so the socket has not connected yet on any
// runtime: the client is still CONNECTING, which the test checks before it destroys.
describe.each([
  { transport: "TCP", tls: false },
  { transport: "TLS", tls: true },
])("destroy() before the $transport connect completes", ({ tls }) => {
  async function connectingClient(): Promise<{
    client: ReturnType<typeof createClient>;
    connecting: Promise<void>;
  }> {
    const peer = await silentPeer();
    const client = createClient({
      host: "127.0.0.1",
      port: peer.port,
      ...(tls ? { tls: { ca: buildServerCertFixture().cert, servername: "localhost" } } : {}),
    });
    const connecting = client.connect();
    expect(client.state).toBe("CONNECTING");
    return { client, connecting };
  }

  it("with no reason, rejects connect() with a typed connect-phase error", async () => {
    const { client, connecting } = await connectingClient();

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
    const { client, connecting } = await connectingClient();

    const reason = new Error("shutting down");
    client.destroy(reason);
    const outcome = await settledWithin(connecting, 2_000);

    expect(outcome).toBeInstanceOf(MllpConnectionError);
    expect((outcome as MllpConnectionError).phase).toBe("connect");
    expect((outcome as MllpConnectionError).cause).toBe(reason);
    expect(client.state).toBe("CLOSED");
  });

  it.each(TLS_SHAPED_REASONS)(
    "with a reason carrying $label, sets no connectionCause",
    async ({ make }) => {
      const { client, connecting } = await connectingClient();

      const reason = make();
      client.destroy(reason);
      const outcome = await settledWithin(connecting, 2_000);

      expect(outcome).toBeInstanceOf(MllpConnectionError);
      const err = outcome as MllpConnectionError;
      expect(err.phase).toBe("connect");
      expect(err.cause).toBe(reason);
      expect(err.connectionCause).toBeUndefined();
      expect(client.state).toBe("CLOSED");
    },
  );
});

// A second `destroy()` in the same tick, from a cleanup or a finally block, never reaches the
// socket: the Connection is already CLOSED. The reason that did reach it is the one `connect()`
// reports, so a later call with no reason or with another reason must not displace it.
// Over TCP the calls run in the same tick as `connect()`, since a silent peer lets the TCP connect
// complete; over TLS they run both then and once the peer has accepted, mid-handshake.
describe.each([
  { when: "before the TCP connect completes", tls: false, midHandshake: false },
  { when: "before the TLS connect completes", tls: true, midHandshake: false },
  { when: "during the TLS handshake", tls: true, midHandshake: true },
])("destroy() twice in one tick $when", ({ tls, midHandshake }) => {
  async function connectingClient(): Promise<{
    client: ReturnType<typeof createClient>;
    connecting: Promise<void>;
  }> {
    const peer = await silentPeer();
    const client = createClient({
      host: "127.0.0.1",
      port: peer.port,
      ...(tls ? { tls: { ca: buildServerCertFixture().cert, servername: "localhost" } } : {}),
    });
    const connecting = client.connect();
    if (midHandshake) await waitFor(() => peer.accepted() === 1);
    expect(client.state).toBe("CONNECTING");
    return { client, connecting };
  }

  const SECOND_CALLS = [
    { then: "no reason", second: (): Error | undefined => undefined },
    { then: "another reason", second: (): Error | undefined => reasonWith("other", "EPROTO") },
  ];

  it.each(TLS_SHAPED_REASONS.flatMap((first) => SECOND_CALLS.map((s) => ({ ...first, ...s }))))(
    "first with a reason carrying $label, then with $then: the first reason is the cause",
    async ({ make, second }) => {
      const { client, connecting } = await connectingClient();

      const reason = make();
      client.destroy(reason);
      client.destroy(second());
      const outcome = await settledWithin(connecting, 2_000);

      expect(outcome).toBeInstanceOf(MllpConnectionError);
      const err = outcome as MllpConnectionError;
      expect(err.phase).toBe("connect");
      expect(err.cause).toBe(reason);
      expect(err.message).toBe(reason.message);
      expect(err.connectionCause).toBeUndefined();
      expect(client.state).toBe("CLOSED");
    },
  );

  it.each(TLS_SHAPED_REASONS)(
    "first with no reason, then with a reason carrying $label: closed before connect",
    async ({ make }) => {
      const { client, connecting } = await connectingClient();

      client.destroy();
      client.destroy(make());
      const outcome = await settledWithin(connecting, 2_000);

      expect(outcome).toBeInstanceOf(MllpConnectionError);
      const err = outcome as MllpConnectionError;
      expect(err.phase).toBe("connect");
      expect(err.message).toBe("connection closed before it was established");
      expect(err.cause).toBeInstanceOf(Error);
      expect(err.cause.message).toBe("closed before connect");
      expect(err.connectionCause).toBeUndefined();
      expect(client.state).toBe("CLOSED");
    },
  );
});

// The client holds a destroy() reason only while the socket has yet to hand it back: it does not
// keep the caller's object alive after that, nor record one for a connection already connected.
describe("the destroy() reason is not kept", () => {
  /** The reason the client is holding for the connect in progress. */
  function heldReason(client: ReturnType<typeof createClient>): unknown {
    return (client as unknown as { _destroyReason: unknown })._destroyReason;
  }

  it("once connect() has rejected with it", async () => {
    const peer = await silentPeer();
    const { cert } = buildServerCertFixture();
    const client = createClient({
      host: "127.0.0.1",
      port: peer.port,
      tls: { ca: cert, servername: "localhost" },
    });
    const connecting = client.connect();
    await waitFor(() => peer.accepted() === 1);

    const reason = reasonWith("alert: shutting down");
    client.destroy(reason);
    expect(heldReason(client)).toBe(reason);
    expect(((await settledWithin(connecting, 2_000)) as MllpConnectionError).cause).toBe(reason);
    expect(heldReason(client)).toBeNull();
  });

  it("when the client was already connected", async () => {
    const peer = await silentPeer();
    const client = createClient({ host: "127.0.0.1", port: peer.port });
    await client.connect();

    client.destroy(reasonWith("shutting down"));
    expect(heldReason(client)).toBeNull();
    expect(client.state).toBe("CLOSED");
  });

  it("once a new connect() starts", async () => {
    const peer = await silentPeer();
    const client = createClient({ host: "127.0.0.1", port: peer.port });
    // A reason left over from an attempt the connect() promise never saw, as a destroy() during
    // a reconnect attempt leaves it.
    (client as unknown as { _destroyReason: unknown })._destroyReason = reasonWith("earlier");

    const connecting = client.connect();
    expect(heldReason(client)).toBeNull();
    await connecting;
    client.destroy();
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
