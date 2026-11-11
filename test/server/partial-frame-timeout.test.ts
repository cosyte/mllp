/**
 * `ServerOptions.partialFrameTimeoutMs` over real loopback sockets: a connection holding a
 * half-sent frame past the limit is closed, and a connection with no frame open is not, however
 * quiet it is. That second half is what keeps it separate from `deadPeerTimeoutMs`, the idle timer.
 *
 * The exact boundaries (to the millisecond, under fake timers) are pinned in
 * `test/connection/partial-frame-timeout.test.ts`; these check what a sender observes on the wire.
 *
 * Every byte is synthetic.
 */

import * as net from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createServer, type MllpServer } from "../../src/server/server.js";
import { must } from "../helpers/tracked-servers.js";

const MESSAGE =
  "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|STALL001|P|2.5\rPID|1||SYNTH^^^^MR||DOE^JANE\r";

const LIMIT = 300;

function frame(payload: string): Buffer {
  return Buffer.concat([
    Buffer.from([0x0b]),
    Buffer.from(payload, "latin1"),
    Buffer.from([0x1c, 0x0d]),
  ]);
}

const servers: MllpServer[] = [];
const sockets: net.Socket[] = [];

afterEach(async () => {
  for (const s of sockets) s.destroy();
  sockets.length = 0;
  for (const s of servers) await s.close({ drainTimeoutMs: 50 }).catch(() => undefined);
  servers.length = 0;
});

async function listening(opts: Parameters<typeof createServer>[0]): Promise<MllpServer> {
  const server = createServer(opts);
  servers.push(server);
  await server.listen(0, "127.0.0.1");
  return server;
}

/** A connected socket, with its close as a promise that resolves to the time it closed. */
async function open(server: MllpServer): Promise<{ sock: net.Socket; closedAt: Promise<number> }> {
  const port = must(server.getStats().port);
  const sock = net.createConnection({ host: "127.0.0.1", port });
  sockets.push(sock);
  sock.on("error", () => undefined); // a destroyed socket may see a reset; its close is what we read
  const closedAt = new Promise<number>((resolve) => sock.once("close", () => resolve(Date.now())));
  await new Promise<void>((resolve, reject) => {
    sock.once("connect", () => resolve());
    sock.once("error", reject);
  });
  return { sock, closedAt };
}

function sleep(ms: number): Promise<"slept"> {
  return new Promise((resolve) => setTimeout(() => resolve("slept"), ms));
}

describe("MllpServer partialFrameTimeoutMs: a half-sent frame", () => {
  it("closes the connection once the frame has been open for the limit", async () => {
    const received: Buffer[] = [];
    const server = await listening({
      partialFrameTimeoutMs: LIMIT,
      autoAck: "AA",
      onMessage: (payload) => {
        received.push(payload);
      },
    });
    const { sock, closedAt } = await open(server);
    const whole = frame(MESSAGE);
    const startedAt = Date.now();
    sock.write(whole.subarray(0, 40));

    const closed = await closedAt;
    // Not before the limit (a few ms of timer slack allowed), and not long after it.
    expect(closed - startedAt).toBeGreaterThanOrEqual(LIMIT - 20);
    expect(closed - startedAt).toBeLessThan(LIMIT + 2_000);
    expect(received).toHaveLength(0);
    expect(server.getStats().activeConnections).toBe(0);
  });

  it("closes a sender that keeps the frame open by trickling bytes", async () => {
    const server = await listening({ partialFrameTimeoutMs: LIMIT });
    const { sock, closedAt } = await open(server);
    const whole = frame(MESSAGE);
    sock.write(whole.subarray(0, 10));
    const startedAt = Date.now();
    let at = 10;
    const trickle = setInterval(() => {
      if (!sock.destroyed && at < whole.length - 2) sock.write(whole.subarray(at, ++at));
    }, 25);
    try {
      const closed = await closedAt;
      expect(closed - startedAt).toBeLessThan(LIMIT + 2_000);
    } finally {
      clearInterval(trickle);
    }
  });
});

describe("MllpServer partialFrameTimeoutMs: no frame open", () => {
  it("leaves an idle connection open well past the limit: it is not an idle timer", async () => {
    const server = await listening({ partialFrameTimeoutMs: LIMIT });
    const { closedAt } = await open(server);
    const first = await Promise.race([closedAt, sleep(LIMIT * 3)]);
    expect(first).toBe("slept");
    expect(server.getStats().activeConnections).toBe(1);
  });

  it("answers a frame sent in pieces that finishes inside the limit, and stays open after it", async () => {
    const server = await listening({
      partialFrameTimeoutMs: LIMIT,
      autoAck: "AA",
      onMessage: () => undefined,
    });
    const { sock, closedAt } = await open(server);
    const acks: Buffer[] = [];
    sock.on("data", (c: Buffer) => acks.push(c));
    const whole = frame(MESSAGE);
    sock.write(whole.subarray(0, 30));
    await sleep(LIMIT / 3);
    sock.write(whole.subarray(30));

    const first = await Promise.race([closedAt, sleep(LIMIT * 3)]);
    expect(first).toBe("slept");
    expect(Buffer.concat(acks).toString("latin1")).toContain("MSA|AA|STALL001");
  });

  it("runs alongside deadPeerTimeoutMs without either one standing in for the other", async () => {
    // The idle timer is far off; only the partial frame can close this connection in time.
    const server = await listening({ partialFrameTimeoutMs: LIMIT, deadPeerTimeoutMs: 60_000 });
    const quiet = await open(server);
    const stalled = await open(server);
    stalled.sock.write(frame(MESSAGE).subarray(0, 25));

    await stalled.closedAt;
    const first = await Promise.race([quiet.closedAt, sleep(LIMIT)]);
    expect(first).toBe("slept");
    expect(server.getStats().activeConnections).toBe(1);
  });
});

describe("MllpServer partialFrameTimeoutMs: checked at construction", () => {
  for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 2_147_483_648]) {
    it(`refuses ${String(bad)} with a RangeError naming the option`, () => {
      expect(() => createServer({ partialFrameTimeoutMs: bad })).toThrow(
        new RangeError(
          "ServerOptions.partialFrameTimeoutMs must be a positive number of milliseconds no greater than 2147483647, or left unset",
        ),
      );
    });
  }
});
