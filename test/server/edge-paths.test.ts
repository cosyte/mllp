/**
 * Server paths the main suites do not reach: hooks and subscribers that throw a non-Error, an
 * ACK that has nowhere to go, the keepalive option, a socket with no address, a dead-peer timer
 * that outlives a graceful disconnect, the two ways a slow drain is cut short, and the signal
 * handlers a starter server installs. Each asserts what an operator sees: the event, the error,
 * the counters, or the exit code.
 */

import * as net from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createServer, createStarterServer, type MllpServer } from "../../src/server/server.js";
import type { MllpConnectionError } from "../../src/connection/index.js";
import { must } from "../helpers/tracked-servers.js";

const MESSAGE =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG00001|P|2.5\rPID|1||SYNTH^^^^MR||DOE^JANE\r";

function frame(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x0b]),
    Buffer.from(payload, "latin1"),
    Buffer.from([0x1c, 0x0d]),
  ]);
}

function connectTo(server: MllpServer): Promise<net.Socket> {
  const port = must(server.getStats().port);
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setTimeout(r, 5));
  }
}

interface ConnErrorEvent {
  readonly connectionId: string;
  readonly error: MllpConnectionError;
}

/** Make every live connection's drain hang, the way a slow application hook would. */
function stallDrains(server: MllpServer): void {
  const internals = server as unknown as {
    _connections: Set<{ beforeClose: () => Promise<void> }>;
  };
  for (const conn of internals._connections) {
    conn.beforeClose = () => new Promise<void>(() => undefined);
  }
}

const servers: MllpServer[] = [];
const sockets: net.Socket[] = [];

function track(server: MllpServer): MllpServer {
  servers.push(server);
  return server;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
});

describe("MllpServer: a 'listening' subscriber that throws a non-Error", () => {
  it("still binds, and surfaces the throw on 'error' as an Error", async () => {
    const server = track(createServer({}));
    const errors: unknown[] = [];
    server.on("error", (e: unknown) => errors.push(e));
    server.on("listening", () => {
      throw "listener broke"; // eslint-disable-line @typescript-eslint/only-throw-error
    });

    await server.listen(0);

    expect(server.getStats().listening).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("listener broke");
  });
});

describe("MllpServer: keepaliveIntervalMs", () => {
  it("turns TCP keepalive on for each accepted socket with the configured delay", async () => {
    const setKeepAlive = vi.spyOn(net.Socket.prototype, "setKeepAlive");
    const server = track(createServer({ keepaliveIntervalMs: 4_321 }));
    await server.listen(0);
    sockets.push(await connectTo(server));
    await waitFor(() => server.getStats().activeConnections === 1);

    expect(setKeepAlive).toHaveBeenCalledWith(true, 4_321);
  });
});

describe("MllpServer: a socket that has no remote address when it is accepted", () => {
  it("reports null for the address and port on the 'connection' event", () => {
    const server = track(createServer({}));
    const events: Array<{ remoteAddress: string | null; remotePort: number | null }> = [];
    server.on("connection", (e: { remoteAddress: string | null; remotePort: number | null }) =>
      events.push(e),
    );
    // A socket that was never connected, standing in for one reset before it was accepted.
    const internals = server as unknown as { _netServer: net.Server };
    const orphan = new net.Socket();
    internals._netServer.emit("connection", orphan);
    orphan.destroy();

    expect(events).toHaveLength(1);
    expect(events[0]?.remoteAddress).toBeNull();
    expect(events[0]?.remotePort).toBeNull();
  });
});

describe("MllpServer: a dead-peer timer that fires after a graceful disconnect", () => {
  it("counts the connection as closed once, not twice", async () => {
    const server = track(createServer({ deadPeerTimeoutMs: 500 }));
    await server.listen(0);
    const sock = await connectTo(server);
    await waitFor(() => server.getStats().activeConnections === 1);

    sock.end();
    await waitFor(() => server.getStats().activeConnections === 0);
    expect(server.getStats().closedTotal).toBe(1);

    // Let the idle timer fire on the already-disconnected connection.
    await new Promise((r) => setTimeout(r, 650));
    expect(server.getStats().closedTotal).toBe(1);
  });
});

describe("MllpServer: handlers that throw a non-Error", () => {
  it("a 'message' subscriber that throws a string is reported on 'error' and the ACK still goes out", async () => {
    const server = track(createServer({ autoAck: "AA" }));
    const errors: ConnErrorEvent[] = [];
    server.on("error", (e: ConnErrorEvent) => errors.push(e));
    server.on("message", () => {
      throw "observer broke"; // eslint-disable-line @typescript-eslint/only-throw-error
    });
    await server.listen(0);
    const sock = await connectTo(server);
    sockets.push(sock);
    const chunks: Buffer[] = [];
    sock.on("data", (c: Buffer) => chunks.push(c));
    sock.write(frame(MESSAGE));

    await waitFor(() => Buffer.concat(chunks).includes(0x1c));
    expect(Buffer.concat(chunks).toString("latin1")).toContain("MSA|AA|MSG00001");
    expect(errors).toHaveLength(1);
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(errors[0]?.error.message).toBe("observer broke");
  });

  it("manual mode: an onMessage that throws a string is reported on 'error' as an Error", async () => {
    const server = track(
      createServer({
        onMessage: () => {
          throw "handler broke"; // eslint-disable-line @typescript-eslint/only-throw-error
        },
      }),
    );
    const errors: ConnErrorEvent[] = [];
    server.on("error", (e: ConnErrorEvent) => errors.push(e));
    await server.listen(0);
    const sock = await connectTo(server);
    sockets.push(sock);
    sock.write(frame(MESSAGE));

    await waitFor(() => errors.length === 1);
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(errors[0]?.error.message).toBe("handler broke");
  });

  it("custom ACK: a builder that throws a string is reported on 'error' and no ACK is sent", async () => {
    const server = track(
      createServer({
        autoAck: () => {
          throw "builder broke"; // eslint-disable-line @typescript-eslint/only-throw-error
        },
      }),
    );
    const errors: ConnErrorEvent[] = [];
    server.on("error", (e: ConnErrorEvent) => errors.push(e));
    await server.listen(0);
    const sock = await connectTo(server);
    sockets.push(sock);
    let received = 0;
    sock.on("data", (c: Buffer) => {
      received += c.length;
    });
    sock.write(frame(MESSAGE));

    await waitFor(() => errors.length === 1);
    expect(errors[0]?.error).toBeInstanceOf(Error);
    expect(errors[0]?.error.message).toBe("builder broke");
    expect(received).toBe(0);
  });
});

describe("MllpServer: an ACK built after the sender hung up", () => {
  it("reports the dropped ACK on 'error' with phase 'send'", async () => {
    let releaseAck: () => void = () => undefined;
    const ackReady = new Promise<void>((r) => {
      releaseAck = r;
    });
    const server = track(
      createServer({
        autoAck: async () => {
          await ackReady;
          return Buffer.from("MSH|^~\\&|R|F|S|F|20260101120000||ACK|A1|P|2.5\rMSA|AA|MSG00001\r");
        },
      }),
    );
    const errors: ConnErrorEvent[] = [];
    server.on("error", (e: ConnErrorEvent) => errors.push(e));
    await server.listen(0);
    const sock = await connectTo(server);
    sock.write(frame(MESSAGE));
    await waitFor(() => server.getStats().totalBytesIn > 0);

    sock.destroy();
    await waitFor(() => server.getStats().activeConnections === 0);
    releaseAck();

    await waitFor(() => errors.length === 1);
    expect(errors[0]?.error.phase).toBe("send");
    expect(errors[0]?.error.message).toBe("ACK dropped: socket backpressure");
  });
});

describe("MllpServer.close(): cutting a slow drain short", () => {
  it("an abort destroys every connection and rejects with AbortError", async () => {
    const server = track(createServer({}));
    await server.listen(0);
    sockets.push(await connectTo(server));
    await waitFor(() => server.getStats().activeConnections === 1);
    stallDrains(server);

    const ac = new AbortController();
    const closing = server.close({ signal: ac.signal, drainTimeoutMs: 10_000 });
    setTimeout(() => ac.abort(), 20);

    const result = await closing.catch((e: unknown) => e);
    expect((result as DOMException).name).toBe("AbortError");
    expect(server.getStats().activeConnections).toBe(0);
  });

  it("a second close() with a shorter timeout destroys the straggler at its own deadline", async () => {
    const server = track(createServer({}));
    await server.listen(0);
    const sock = await connectTo(server);
    sockets.push(sock);
    await waitFor(() => server.getStats().activeConnections === 1);
    stallDrains(server);
    let peerClosed = false;
    sock.on("close", () => {
      peerClosed = true;
    });

    const slow = server.close({ drainTimeoutMs: 1_500 });
    const fast = server.close({ drainTimeoutMs: 50 });

    // Well before the first close's 1,500 ms timeout, the straggler is gone.
    await waitFor(() => peerClosed, 1_000);
    expect(server.getStats().activeConnections).toBe(0);
    await Promise.all([slow, fast]);
  });
});

describe("createStarterServer({ handleSignals: true })", () => {
  function installedHandler(): () => void {
    const handler = process.listeners("SIGTERM").at(-1);
    if (handler === undefined) throw new Error("no SIGTERM handler installed");
    return handler as () => void;
  }

  it("closes the server and exits 0 on a signal", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const server = track(await createStarterServer({ port: 0, handleSignals: true }));

    installedHandler()();

    await waitFor(() => exit.mock.calls.length === 1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(server.getStats().listening).toBe(false);
  });

  it("exits 1 when the close fails", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const server = track(await createStarterServer({ port: 0, handleSignals: true }));
    const handler = installedHandler();
    vi.spyOn(server, "close").mockRejectedValueOnce(new Error("close failed"));

    handler();

    await waitFor(() => exit.mock.calls.length === 1);
    expect(exit).toHaveBeenCalledWith(1);
    process.removeListener("SIGTERM", handler);
    process.removeListener("SIGINT", handler);
  });
});
