/**
 * Client paths the main suites do not reach: a TLS connect refused at the TCP layer, a peer
 * that answers before the write returns, hooks that throw a non-Error, a retry strategy that
 * throws, a clean peer close, the real-socket reconnect path, a reconnect attempt that throws,
 * an abort while a send is parked, and the starter client's options and signal handlers. Each
 * asserts what the caller sees: the rejection, the event, or the retry context.
 *
 * In-process cases run over `InMemoryTransport.pair()` through the client's attach seams, the
 * same way the reconnect suite does; socket cases use loopback listeners.
 */

import * as net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createClient,
  createStarterClient,
  type ClientOptions,
  type MllpClient,
  type RetryContext,
} from "../../src/client/client.js";
import { MllpCommitRejectedError } from "../../src/client/error.js";
import { Connection, MllpConnectionError } from "../../src/connection/index.js";
import { encodeFrame } from "../../src/framing/index.js";
import { createServer, type MllpServer } from "../../src/server/server.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { buildServerCertFixture } from "../helpers/tls-fixtures.js";

/** An original-mode message: settled by its first acknowledgement. */
const ORIGINAL = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|MSG1|P|2.5\r", "latin1");
/** An enhanced-mode message (MSH-15 and MSH-16 AL): commit first, then the application ACK. */
const ENHANCED = Buffer.from("MSH|^~\\&|A|B|C|D|20260101||ADT^A01|MSG1|P|2.5|||AL|AL\r", "latin1");

function ackFrame(code: string, controlId = "MSG1"): Buffer {
  return encodeFrame(
    Buffer.from(`MSH|^~\\&|C|D|A|B|20260101||ACK|A1|P|2.5\rMSA|${code}|${controlId}\r`, "latin1"),
  );
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface Seamed {
  readonly client: MllpClient;
  /** The far end of the current in-memory link. */
  peer: () => InMemoryTransport;
  /** The client's end of the current in-memory link. */
  local: () => InMemoryTransport;
}

/** A connected client over an in-memory pair, reconnecting onto fresh pairs. */
function seamedClient(
  opts: Partial<ClientOptions> = {},
  factory?: () => { conn: Connection; arm: () => void },
): Seamed {
  let pair = InMemoryTransport.pair();
  const client = createClient({ host: "127.0.0.1", port: 0, ...opts });
  const seams = client as unknown as {
    _setReconnectFactory: (f: () => { conn: Connection; arm: () => void }) => void;
    _attachExistingConnection: (c: Connection) => void;
  };
  seams._setReconnectFactory(
    factory ??
      (() => {
        pair = InMemoryTransport.pair();
        const conn = new Connection({ transport: pair[0] });
        return { conn, arm: () => conn.notifyConnect("127.0.0.1", 2575) };
      }),
  );
  const conn = new Connection({ transport: pair[0] });
  seams._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, peer: () => pair[1], local: () => pair[0] };
}

const clients: MllpClient[] = [];
const servers: MllpServer[] = [];
const netServers: net.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const c of clients) c.destroy();
  clients.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
  for (const s of netServers) await new Promise((r) => s.close(r));
  netServers.length = 0;
});

describe("MllpClient: a TLS connect refused at the TCP layer", () => {
  it("rejects with an MllpConnectionError that names no TLS cause", async () => {
    const probe = net.createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const port = (probe.address() as net.AddressInfo).port;
    await new Promise((r) => probe.close(r));

    const { cert } = buildServerCertFixture();
    const client = createClient({ host: "127.0.0.1", port, tls: { ca: cert } });
    clients.push(client);

    const err = await client.connect().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MllpConnectionError);
    expect((err as MllpConnectionError).connectionCause).toBeUndefined();
    expect(((err as MllpConnectionError).cause as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
  });
});

describe("MllpClient: a peer that answers before the write returns", () => {
  it("fails an enhanced send on a synchronous CE with zero elapsed time", async () => {
    const h = seamedClient({ correlateByControlId: true, autoReconnect: false });
    clients.push(h.client);
    h.peer().onData(() => h.peer().write(ackFrame("CE")));

    const err = await h.client.send(ENHANCED).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MllpCommitRejectedError);
    expect((err as MllpCommitRejectedError).commitCode).toBe("CE");
    expect((err as MllpCommitRejectedError).elapsedMs).toBe(0);
  });
});

describe("MllpClient: an onCommitAck hook that throws a non-Error", () => {
  it("surfaces an Error on 'error' and still settles on the application ACK", async () => {
    const h = seamedClient({ correlateByControlId: true, autoReconnect: false });
    clients.push(h.client);
    const errors: Array<{ error: unknown }> = [];
    h.client.on("error", (e: { error: unknown }) => errors.push(e));

    const sending = h.client.send(ENHANCED, {
      onCommitAck: () => {
        throw "hook broke"; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    });
    h.peer().write(ackFrame("CA"));
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect((errors[0]?.error as Error).message).toBe("hook broke");

    h.peer().write(ackFrame("AA"));
    const ack = await sending;
    expect(ack.toString("latin1")).toContain("MSA|AA|MSG1");
  });
});

describe("MllpClient (FIFO): a link reset while the frame is being written", () => {
  it("rejects the send as fifo-unsafe, since it was never counted as on the wire", async () => {
    const h = seamedClient({ autoReconnect: true, retryStrategy: () => null });
    clients.push(h.client);
    h.peer().onData(() => {
      h.local().destroy(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
    });

    const err = await h.client.send(ORIGINAL).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MllpConnectionError);
    expect((err as MllpConnectionError).connectionCause).toBe("fifo-unsafe");
    expect((err as MllpConnectionError).phase).toBe("reconnect");
  });
});

describe("MllpClient: a subscriber that throws a non-Error", () => {
  it("is contained, and re-surfaced on 'error' as an Error", () => {
    const h = seamedClient({ autoReconnect: false });
    clients.push(h.client);
    const errors: Array<{ error: unknown }> = [];
    h.client.on("error", (e: { error: unknown }) => errors.push(e));
    h.client.on("stateChange", () => {
      throw "subscriber broke"; // eslint-disable-line @typescript-eslint/only-throw-error
    });

    expect(() => h.peer().close()).not.toThrow();

    expect(h.client.state).toBe("DISCONNECTED");
    expect(errors.map((e) => e.error)).toContainEqual(new Error("subscriber broke"));
  });

  it("is re-surfaced with the connectionId of the connection it was reported on", () => {
    const h = seamedClient({ autoReconnect: false });
    clients.push(h.client);
    const connectionId = h.client.getStats().connectionId;
    expect(connectionId).toEqual(expect.any(String));
    const errors: Array<{ connectionId?: unknown; error: unknown }> = [];
    h.client.on("error", (e: { connectionId?: unknown; error: unknown }) => errors.push(e));
    h.client.on("stateChange", () => {
      throw new Error("subscriber broke");
    });

    h.peer().close();

    const thrown = errors.filter((e) => (e.error as Error).message === "subscriber broke");
    expect(thrown.length).toBeGreaterThan(0);
    for (const e of thrown) {
      expect(Object.keys(e).sort()).toEqual(["connectionId", "error"]);
      expect(e.connectionId).toBe(connectionId);
    }
  });
});

describe("MllpClient: a retry strategy that throws", () => {
  it.each([
    ["an Error", new Error("strategy broke")],
    ["a string", "strategy broke"],
  ])("closes the client and reports %s on 'error' as an Error", (_label, thrown) => {
    const h = seamedClient({
      autoReconnect: true,
      retryStrategy: () => {
        throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error
      },
    });
    clients.push(h.client);
    const errors: Array<{ error: unknown }> = [];
    const reconnecting: unknown[] = [];
    h.client.on("error", (e: { error: unknown }) => errors.push(e));
    h.client.on("reconnecting", (e: unknown) => reconnecting.push(e));

    h.local().destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));

    const reported = errors
      .map((e) => e.error)
      .find((e) => (e as Error).message === "strategy broke");
    expect(reported).toBeInstanceOf(Error);
    expect(reconnecting).toEqual([]);
    expect(h.client.state).toBe("CLOSED");
  });
});

describe("MllpClient: the peer closes the link cleanly", () => {
  it("hands the retry strategy an Error naming the clean close", () => {
    const contexts: RetryContext[] = [];
    const h = seamedClient({
      autoReconnect: true,
      retryStrategy: (ctx) => {
        contexts.push(ctx);
        return null;
      },
    });
    clients.push(h.client);

    h.peer().close();

    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.lastError.message).toBe("peer closed");
    expect(contexts[0]?.classifiedAs).toBe("transient");
  });
});

describe("MllpClient: a reconnect attempt that throws", () => {
  it.each([
    ["an Error", new Error("factory broke")],
    ["a string", "factory broke"],
  ])("counts %s as a failed attempt and keeps the cycle going", async (_label, thrown) => {
    let calls = 0;
    const contexts: RetryContext[] = [];
    let latest: Connection | null = null;
    const h = seamedClient(
      {
        autoReconnect: true,
        retryStrategy: (ctx) => {
          contexts.push(ctx);
          return ctx.attempt < 3 ? 1 : null;
        },
      },
      () => {
        calls += 1;
        if (calls === 1) throw thrown; // eslint-disable-line @typescript-eslint/only-throw-error
        const [local] = InMemoryTransport.pair();
        const conn = new Connection({ transport: local });
        latest = conn;
        return { conn, arm: () => conn.notifyConnect("127.0.0.1", 2575) };
      },
    );
    clients.push(h.client);

    h.local().destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
    await waitFor(() => h.client.state === "CONNECTED" && latest !== null);

    expect(calls).toBe(2);
    expect(contexts[1]?.lastError).toBeInstanceOf(Error);
    expect(contexts[1]?.lastError.message).toBe("factory broke");
  });
});

describe("MllpClient (pipeline: false): an abort while a send is parked", () => {
  it("rejects the parked send with AbortError and never writes it", async () => {
    const h = seamedClient({ pipeline: false, autoReconnect: false });
    clients.push(h.client);
    let framesSeen = 0;
    h.peer().onData(() => {
      framesSeen += 1;
    });

    const first = h.client.send(ORIGINAL);
    const ac = new AbortController();
    const second = h.client.send(ORIGINAL, { signal: ac.signal });
    ac.abort();

    const err = await second.catch((e: unknown) => e);
    expect((err as DOMException).name).toBe("AbortError");

    h.peer().write(ackFrame("AA"));
    await expect(first).resolves.toBeInstanceOf(Buffer);
    expect(framesSeen).toBe(1);
  });
});

describe("MllpClient: reconnecting over a real socket", () => {
  it("re-applies keepalive on the new socket and reports the refused attempt's OS error", async () => {
    const setKeepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const accepted: net.Socket[] = [];
    const server = net.createServer((s) => {
      accepted.push(s);
    });
    netServers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as net.AddressInfo).port;

    const contexts: RetryContext[] = [];
    const client = createClient({
      host: "127.0.0.1",
      port,
      autoReconnect: true,
      keepaliveIntervalMs: 2_468,
      drainTimeoutMs: 100,
      framing: {},
      retryStrategy: (ctx) => {
        contexts.push(ctx);
        return ctx.attempt < 3 ? 5 : null;
      },
    });
    clients.push(client);
    await client.connect();
    await waitFor(() => accepted.length === 1);

    // First drop: the server is still listening, so the client reconnects on a new socket.
    accepted[0]?.destroy();
    await waitFor(() => accepted.length === 2 && client.state === "CONNECTED");
    const keepaliveCalls = setKeepAlive.mock.calls.filter((c) => c[0] === true && c[1] === 2_468);
    expect(keepaliveCalls.length).toBeGreaterThanOrEqual(2);

    // Second drop with nothing listening: each attempt is refused at the TCP layer.
    const closed = new Promise((r) => server.close(r));
    netServers.length = 0;
    accepted[1]?.destroy();
    await closed;
    await waitFor(() =>
      contexts.some((c) => (c.lastError as NodeJS.ErrnoException).code === "ECONNREFUSED"),
    );
    await waitFor(() => client.state === "CLOSED");

    const refused = contexts.filter(
      (c) => (c.lastError as NodeJS.ErrnoException).code === "ECONNREFUSED",
    );
    expect(refused.length).toBeGreaterThanOrEqual(1);
    expect(refused.every((c) => c.classifiedAs === "transient")).toBe(true);
  });
});

describe("createStarterClient", () => {
  it("passes every optional setting through to the client", async () => {
    const setKeepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const { cert, key } = buildServerCertFixture();
    const server = createServer({ tls: { cert, key }, autoAck: "AA" });
    servers.push(server);
    await server.listen(0, "127.0.0.1");
    const port = server.getStats().port ?? 0;

    const contexts: RetryContext[] = [];
    const client = await createStarterClient({
      host: "127.0.0.1",
      port,
      tls: { ca: cert },
      drainTimeoutMs: 100,
      framing: {},
      keepaliveIntervalMs: 1_357,
      deadPeerTimeoutMs: 300,
      retryStrategy: (ctx) => {
        contexts.push(ctx);
        return null;
      },
    });
    clients.push(client);

    expect(client.getStats().tls).toBe(true);
    expect(setKeepAlive).toHaveBeenCalledWith(true, 1_357);
    const ack = await client.send(ORIGINAL);
    expect(ack.toString("latin1")).toContain("MSA|AA|MSG1");

    // Idle past the dead-peer timeout: the client drops the link and asks its strategy.
    await waitFor(() => contexts.length === 1);
    expect(contexts[0]?.lastError.message).toBe("dead peer timeout");
  });

  describe("with handleSignals: true", () => {
    let installed: (() => void) | undefined;

    afterEach(() => {
      // Remove only the handler this suite installed; the test runner may hold its own.
      if (installed !== undefined) {
        process.removeListener("SIGTERM", installed);
        process.removeListener("SIGINT", installed);
        installed = undefined;
      }
    });

    async function starter(): Promise<{ client: MllpClient; handler: () => void }> {
      const server = createServer({ autoAck: "AA" });
      servers.push(server);
      await server.listen(0, "127.0.0.1");
      const client = await createStarterClient({
        host: "127.0.0.1",
        port: server.getStats().port ?? 0,
        handleSignals: true,
      });
      clients.push(client);
      const handler = process.listeners("SIGTERM").at(-1) as (() => void) | undefined;
      if (handler === undefined) throw new Error("no SIGTERM handler installed");
      installed = handler;
      return { client, handler };
    }

    it("closes the client and exits 0 on a signal", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const { client, handler } = await starter();

      handler();

      await waitFor(() => exit.mock.calls.length === 1);
      expect(exit).toHaveBeenCalledWith(0);
      expect(client.state).not.toBe("CONNECTED");
    });

    it("exits 1 when the close fails", async () => {
      const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
      const { client, handler } = await starter();
      vi.spyOn(client, "close").mockRejectedValueOnce(new Error("close failed"));

      handler();

      await waitFor(() => exit.mock.calls.length === 1);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });
});
