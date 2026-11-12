/**
 * `server.close()` waits for every handler still running and its ACK, over a real socket.
 *
 * A graceful shutdown during a slow commit used to close each connection at once: the handler
 * finished its commit, but the connection was gone, so its ACK was never sent. The sender resent a
 * message already committed, and it was processed twice. Now `close()` reads nothing more on each
 * connection, waits for the handlers still running and the ACKs they write, then ends the socket.
 * The wait is bounded by `drainTimeoutMs`; a handler still running then is abandoned and reported
 * on `'error'`.
 */

import type { Socket } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { Connection } from "../../src/connection/connection.js";
import { MllpConnectionError } from "../../src/connection/error.js";
import { encodeFrame } from "../../src/framing/index.js";
import { buildRawAck } from "../../src/server/ack.js";
import { createServer } from "../../src/server/server.js";
import type { MllpServer, ServerOptions } from "../../src/server/server.js";

import { makeServerTracker, must } from "../helpers/tracked-servers.js";

/** A synthetic result; every value is plainly fake. */
function result(id: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SYNLAB|SYNFAC|SYNEHR|SYNFAC|20260101120000||ORU^R01|${id}|P|2.5\r` +
      `PID|1||SYN000001^^^SYNFAC^MR||TEST^JANE\rOBX|1|TX|SYN^SYNTEST||synthetic\r`,
    "latin1",
  );
}

const frame = (id: string): Buffer => encodeFrame(result(id));

const idOf = (payload: Buffer): string =>
  /\|(SYNMSG\d+)\|/.exec(payload.toString("latin1"))?.[1] ?? "?";

/** The MSA segments in what the server sent, in order. */
const msas = (received: string): string[] => received.match(/MSA\|[^\r]*/g) ?? [];

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const tracker = makeServerTracker();
afterEach(async () => {
  vi.restoreAllMocks();
  await tracker.closeAll();
});

interface Started {
  readonly server: MllpServer;
  readonly port: number;
  readonly handled: string[];
  /** The messages of every error the server reported. */
  readonly errors: { message: string; phase?: string }[];
  /** The messages of the causes of those errors. */
  readonly causes: string[];
}

async function start(opts: ServerOptions, handled: string[] = []): Promise<Started> {
  const server = tracker.track(createServer(opts));
  const errors: { message: string; phase?: string }[] = [];
  const causes: string[] = [];
  server.on("error", (e: unknown) => {
    const error = (e as { error?: unknown }).error;
    if (error instanceof Error && error.cause instanceof Error) causes.push(error.cause.message);
    if (error instanceof MllpConnectionError) {
      errors.push({ message: error.message, phase: error.phase });
    } else if (error instanceof Error) {
      errors.push({ message: error.message });
    }
  });
  await server.listen(0, "127.0.0.1");
  return { server, port: must(server.getStats().port), handled, errors, causes };
}

interface Peer {
  readonly sock: Socket;
  /** Every byte the server sent, as latin1. */
  readonly received: () => string;
  /** Resolves with the time the server closed the socket. */
  readonly closed: Promise<number>;
}

async function connect(port: number): Promise<Peer> {
  const net = await import("node:net");
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const chunks: Buffer[] = [];
  sock.on("data", (b: Buffer) => chunks.push(b));
  sock.on("error", () => undefined);
  const closed = new Promise<number>((resolve) => sock.once("close", () => resolve(Date.now())));
  return { sock, received: () => Buffer.concat(chunks).toString("latin1"), closed };
}

/** A latch the handler opens when it starts, so the test closes while it is still running. */
function latch(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { opened, open };
}

/** Wait until `n` handlers have started. */
async function untilHandled(seen: { handled: string[] }, n: number): Promise<void> {
  for (let i = 0; i < 400 && seen.handled.length < n; i++) await pause(5);
  expect(seen.handled.length).toBe(n);
}

describe("server.close() with a handler still running", () => {
  it("waits for a slow commit and sends its AA before the socket closes", async () => {
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: async (payload) => {
          handled.push(idOf(payload));
          started.open();
          await pause(300);
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    const began = Date.now();
    await seen.server.close();
    const closeTook = Date.now() - began;
    await peer.closed;

    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
    expect(closeTook).toBeGreaterThanOrEqual(200);
    expect(seen.errors).toEqual([]);
    expect(seen.server.getStats().connections).toBe(0);
  });

  it("reads nothing new while it waits", async () => {
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: async (payload) => {
          handled.push(idOf(payload));
          started.open();
          await pause(300);
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    const closing = seen.server.close();
    await pause(50);
    // Written while the first is still being handled: never read, never handled, never answered.
    peer.sock.write(frame("SYNMSG0002"));
    await closing;
    await peer.closed;

    expect(seen.handled).toEqual(["SYNMSG0001"]);
    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
  });

  it("sends the negative ACK of a handler that rejects", async () => {
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: async (payload) => {
          handled.push(idOf(payload));
          started.open();
          await pause(150);
          throw new Error("synthetic commit failure");
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close();
    await peer.closed;

    expect(msas(peer.received())).toEqual(["MSA|AE|SYNMSG0001|message could not be processed"]);
  });

  it("does not let a handler that never settles hold close() past drainTimeoutMs, and says so", async () => {
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: (payload) => {
          handled.push(idOf(payload));
          started.open();
          return new Promise<never>(() => undefined);
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    const began = Date.now();
    await seen.server.close({ drainTimeoutMs: 200 });
    const closeTook = Date.now() - began;
    await peer.closed;

    expect(closeTook).toBeGreaterThanOrEqual(150);
    expect(closeTook).toBeLessThan(3_000);
    expect(peer.received()).toBe("");
    expect(seen.errors).toHaveLength(1);
    const [report] = seen.errors;
    expect(report?.phase).toBe("close");
    expect(report?.message).toMatch(/^close\(\) ended after \d+ ms \(drain timeout\): /);
    expect(report?.message).toMatch(
      /: 1 message was delivered and its acknowledgement was not sent$/,
    );
    expect(seen.server.getStats().connections).toBe(0);
  });

  it("reports a handler that settles after the bound as closed, not as backpressure", async () => {
    const started = latch();
    let settled!: () => void;
    const lateDone = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const seen = await start({
      autoAck: "AA",
      onMessage: async () => {
        started.open();
        await pause(300);
        setImmediate(settled);
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close({ drainTimeoutMs: 100 });
    await lateDone;
    await pause(20);

    const messages = seen.errors.map((e) => e.message);
    expect(messages.some((m) => /backpressure/.test(m))).toBe(false);
    expect(messages).toContain("ACK not sent: the connection closed before the handler settled");
    expect(seen.causes).toContain("connection closed");
    expect(peer.received()).toBe("");
  });

  it("waits for a manual-mode handler until its promise settles", async () => {
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        onMessage: async (payload, _meta, conn) => {
          handled.push(idOf(payload));
          started.open();
          await pause(200);
          conn.send(encodeFrame(buildRawAck(payload, "AA")));
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close();
    await peer.closed;

    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
  });

  it("waits for a custom ACK builder", async () => {
    const started = latch();
    const seen = await start({
      autoAck: async (payload) => {
        started.open();
        await pause(200);
        return buildRawAck(payload, "AA");
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close();
    await peer.closed;

    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
  });

  it("waits on every connection, each for its own handlers", async () => {
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: async (payload) => {
          handled.push(idOf(payload));
          await pause(150 + 20 * (Number(idOf(payload).slice(-2)) % 5));
        },
      },
      handled,
    );
    const peers = await Promise.all(Array.from({ length: 8 }, () => connect(seen.port)));
    for (const [i, peer] of peers.entries()) {
      const n = String(i + 1).padStart(2, "0");
      peer.sock.write(Buffer.concat([frame(`SYNMSG00${n}`), frame(`SYNMSG01${n}`)]));
    }
    await untilHandled(seen, 16);

    await seen.server.close();
    await Promise.all(peers.map((p) => p.closed));

    for (const [i, peer] of peers.entries()) {
      const n = String(i + 1).padStart(2, "0");
      expect(msas(peer.received())).toEqual([`MSA|AA|SYNMSG00${n}`, `MSA|AA|SYNMSG01${n}`]);
    }
    expect(seen.errors).toEqual([]);
    expect(seen.server.getStats().connections).toBe(0);
  });

  it("closes an idle connection at once", async () => {
    const seen = await start({ autoAck: "AA", onMessage: () => undefined });
    const peer = await connect(seen.port);
    for (let i = 0; i < 400 && seen.server.getStats().connections === 0; i++) await pause(5);

    const began = Date.now();
    await seen.server.close();
    await peer.closed;

    expect(Date.now() - began).toBeLessThan(1_000);
    expect(seen.errors).toEqual([]);
  });
});

describe("an ACK the open connection could not flush", () => {
  it("is still reported as backpressure", async () => {
    const seen = await start({ autoAck: "AA" });
    vi.spyOn(Connection.prototype, "send").mockReturnValue(false);
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    for (let i = 0; i < 400 && seen.errors.length === 0; i++) await pause(5);

    expect(seen.errors).toEqual([{ message: "ACK dropped: socket backpressure", phase: "send" }]);
  });
});

describe("the bound server.close() gives each connection", () => {
  it("is the one passed to close(), not the server's option", async () => {
    const got: number[] = [];
    const started = latch();
    const seen = await start({
      autoAck: "AA",
      drainTimeoutMs: 5_000,
      onMessage: (_payload, _meta, conn) => {
        conn.beforeClose = (ms) => {
          got.push(ms);
          return Promise.resolve();
        };
        started.open();
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;
    await pause(20);

    await seen.server.close({ drainTimeoutMs: 1_234 });
    await peer.closed;

    expect(got).toEqual([1_234]);
  });

  it("ends a connection already waiting after a fatal framing error, and names the timeout", async () => {
    const states: { to: string; reason?: string }[] = [];
    const started = latch();
    const seen = await start({
      autoAck: "AA",
      drainTimeoutMs: 5_000,
      onMessage: (_payload, _meta, conn) => {
        conn.on("stateChange", (e: { to: string; reason?: string }) => states.push(e));
        started.open();
        return new Promise<never>(() => undefined);
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(Buffer.concat([frame("SYNMSG0001"), Buffer.from("X", "latin1")]));
    await started.opened;
    for (let i = 0; i < 400 && states.length === 0; i++) await pause(5);
    expect(states.map((e) => e.to)).toEqual(["DRAINING"]);

    const began = Date.now();
    await seen.server.close({ drainTimeoutMs: 200 });
    expect(Date.now() - began).toBeLessThan(3_000);
    await peer.closed;

    expect(states.at(-1)).toEqual({ from: "DRAINING", to: "CLOSED", reason: "drain timeout" });
  });
});

describe("what close() reports it abandoned", () => {
  it("does not wait for a custom-ACK observer that never settles once the ACK is out", async () => {
    const seen = await start({
      autoAck: (payload) => buildRawAck(payload, "AA"),
      onMessage: () => new Promise<never>(() => undefined),
      drainTimeoutMs: 2_000,
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    for (let i = 0; i < 400 && msas(peer.received()).length === 0; i++) await pause(5);
    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);

    const began = Date.now();
    await seen.server.close();
    const closeTook = Date.now() - began;
    await peer.closed;

    expect(closeTook).toBeLessThan(1_000);
    expect(seen.errors).toEqual([]);
  });

  it("counts one message, not two, when its builder and its observer are both still running", async () => {
    const started = latch();
    const seen = await start({
      autoAck: () => {
        started.open();
        return new Promise<never>(() => undefined);
      },
      onMessage: () => new Promise<never>(() => undefined),
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close({ drainTimeoutMs: 200 });
    await peer.closed;

    expect(peer.received()).toBe("");
    expect(seen.errors).toHaveLength(1);
    const [report] = seen.errors;
    expect(report?.phase).toBe("close");
    expect(report?.message).toMatch(/^close\(\) ended after \d+ ms \(drain timeout\): /);
    expect(report?.message).toMatch(/1 message was delivered and its acknowledgement was not sent/);
    expect(report?.message).toMatch(/1 observer that owes no acknowledgement was still running/);
    expect(report?.message).not.toMatch(/\b2\b/);
  });

  it("says a manual-mode handler's acknowledgement may not have been sent", async () => {
    const started = latch();
    const seen = await start({
      onMessage: (payload, _meta, conn) => {
        conn.send(encodeFrame(buildRawAck(payload, "AA")));
        started.open();
        return new Promise<never>(() => undefined);
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    await seen.server.close({ drainTimeoutMs: 200 });
    await peer.closed;

    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]?.message).toMatch(
      /1 manual-mode handler was still running, so its acknowledgement may not have been sent/,
    );
    expect(seen.errors[0]?.message).not.toMatch(/was not sent/);
  });

  it("counts every message on the connection", async () => {
    const handled: string[] = [];
    const seen = await start(
      {
        autoAck: "AA",
        onMessage: (payload) => {
          handled.push(idOf(payload));
          return new Promise<never>(() => undefined);
        },
      },
      handled,
    );
    const peer = await connect(seen.port);
    peer.sock.write(Buffer.concat([frame("SYNMSG0001"), frame("SYNMSG0002"), frame("SYNMSG0003")]));
    await untilHandled(seen, 3);

    await seen.server.close({ drainTimeoutMs: 200 });
    await peer.closed;

    expect(seen.errors).toHaveLength(1);
    expect(seen.errors[0]?.message).toMatch(
      /3 messages were delivered and their acknowledgements were not sent/,
    );
  });
});

describe("a connection accepted after close() began", () => {
  it("is closed, though every connection listed when close() began finished early", async () => {
    const { buildServerCertFixture } = await import("../helpers/tls-fixtures.js");
    const net = await import("node:net");
    const tls = await import("node:tls");
    const { cert, key } = buildServerCertFixture();
    const started = latch();
    const handled: string[] = [];
    const seen = await start(
      {
        tls: { cert, key },
        autoAck: "AA",
        drainTimeoutMs: 30_000,
        onMessage: async (payload) => {
          handled.push(idOf(payload));
          started.open();
          await pause(300);
        },
      },
      handled,
    );
    const first = tls.connect({
      host: "127.0.0.1",
      port: seen.port,
      ca: cert,
      servername: "localhost",
    });
    first.on("error", () => undefined);
    await new Promise<void>((resolve) => first.once("secureConnect", () => resolve()));
    first.resume();
    first.write(frame("SYNMSG0001"));
    await started.opened;

    // Connected before close() began, its handshake not yet started: the server accepts it only
    // once close() is already waiting.
    const raw = await new Promise<Socket>((resolve, reject) => {
      const s = net.createConnection({ host: "127.0.0.1", port: seen.port });
      s.once("connect", () => resolve(s));
      s.once("error", reject);
    });
    const closing = seen.server.close();
    const late = tls.connect({ socket: raw, ca: cert, servername: "localhost" });
    late.on("error", () => undefined);
    const lateClosed = new Promise<void>((resolve) => late.once("close", () => resolve()));

    await closing;
    const outcome = await Promise.race([
      lateClosed.then(() => "closed"),
      pause(1_500).then(() => "still open"),
    ]);
    late.destroy();
    first.destroy();

    expect(outcome).toBe("closed");
    expect(seen.server.getStats().connections).toBe(0);
  });
});

describe("a server listening again after close()", () => {
  it("serves the connections it accepts", async () => {
    const seen = await start({ autoAck: "AA" });
    await seen.server.close();
    await seen.server.listen(0, "127.0.0.1");
    const peer = await connect(must(seen.server.getStats().port));
    peer.sock.write(frame("SYNMSG0001"));
    for (let i = 0; i < 400 && msas(peer.received()).length === 0; i++) await pause(5);
    expect(msas(peer.received())).toEqual(["MSA|AA|SYNMSG0001"]);
    peer.sock.destroy();
  });
});

describe("a sender that half-closes while close() waits", () => {
  it("is reported as unable to receive the ACK, not as backpressure", async () => {
    const started = latch();
    let settled!: () => void;
    const handlerDone = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const seen = await start({
      autoAck: "AA",
      onMessage: async () => {
        started.open();
        await pause(300);
        setImmediate(settled);
      },
    });
    const peer = await connect(seen.port);
    peer.sock.write(frame("SYNMSG0001"));
    await started.opened;

    const closing = seen.server.close();
    await pause(50);
    peer.sock.end();
    await closing;
    await handlerDone;
    await pause(50);

    const messages = seen.errors.map((e) => e.message);
    expect(messages.some((m) => /backpressure/.test(m))).toBe(false);
    expect(messages.some((m) => /write after end/i.test(m))).toBe(false);
    expect(messages).toContain(
      "close() ended when the sender closed the connection: 1 message was delivered and its acknowledgement was not sent",
    );
  });
});
