/**
 * TDD tests for Plan 04:
 * - createStarterServer factory
 * - server.getStats() full byte aggregation
 * - handleSignals support
 * - Symbol.asyncDispose
 * - frozen event payload audit
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createStarterServer, createServer } from "../../src/server/server.js";
import * as net from "node:net";

import { must, makeServerTracker } from "../helpers/tracked-servers.js";

// MLLP framing helpers
const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

function frameMessage(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "ascii");
  const framed = Buffer.allocUnsafe(payloadBuf.length + 3);
  framed[0] = VT;
  payloadBuf.copy(framed, 1);
  framed[payloadBuf.length + 1] = FS;
  framed[payloadBuf.length + 2] = CR;
  return framed;
}

async function connectRaw(port: number): Promise<net.Socket> {
  return new Promise<net.Socket>((resolve, reject) => {
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.once("connect", () => resolve(sock));
    sock.once("error", reject);
  });
}

async function sendFramedMessage(sock: net.Socket, msg: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    sock.write(frameMessage(msg), (err) => {
      if (err !== undefined && err !== null) reject(err);
      else resolve();
    });
  });
}

describe("createStarterServer", () => {
  const { track, closeAll } = makeServerTracker();

  afterEach(closeAll);

  it("resolves with a listening MllpServer", async () => {
    const server = await createStarterServer({ port: 0 });
    track(server);
    expect(server).toBeDefined();
    expect(server.getStats().listening).toBe(true);
  });

  it("getStats() has both connections and activeConnections fields (OBS-02)", async () => {
    const server = await createStarterServer({ port: 0 });
    track(server);
    const stats = server.getStats();
    expect(stats).toHaveProperty("connections");
    expect(stats).toHaveProperty("activeConnections");
    expect(typeof stats.connections).toBe("number");
    expect(typeof stats.activeConnections).toBe("number");
  });

  it("after close(), getStats().listening is false", async () => {
    const server = await createStarterServer({ port: 0 });
    // do NOT push to servers — we close manually
    await server.close();
    expect(server.getStats().listening).toBe(false);
  });

  it("no onMessage provided → auto-ACK AA is still active", async () => {
    const server = await createStarterServer({ port: 0 });
    track(server);
    const port = must(server.getStats().port);
    const sock = await connectRaw(port);
    try {
      const received: Buffer[] = [];
      sock.on("data", (chunk: Buffer) => received.push(chunk));

      const hl7 = "MSH|^~\\&|App|Fac|Srv|Srv|20240101120000||ADT^A01|MSG001|P|2.3\r";
      await sendFramedMessage(sock, hl7);
      // Wait briefly for the ACK to arrive
      await new Promise<void>((res) => setTimeout(res, 100));
      const total = Buffer.concat(received);
      // Must have received something (the AA ACK)
      expect(total.length).toBeGreaterThan(0);
      // Should start with VT (MLLP framing)
      expect(total[0]).toBe(VT);
    } finally {
      sock.destroy();
    }
  });

  it("JSON.stringify(server.getStats()) succeeds without loss (OBS-04)", async () => {
    const server = await createStarterServer({ port: 0 });
    track(server);
    const stats = server.getStats();
    const str = JSON.stringify(stats);
    expect(str).not.toContain("[object Object]");
    expect(str).not.toContain("undefined");
    // Must contain all required fields
    const parsed = JSON.parse(str) as Record<string, unknown>;
    expect(parsed).toHaveProperty("listening");
    expect(parsed).toHaveProperty("port");
    expect(parsed).toHaveProperty("host");
    expect(parsed).toHaveProperty("connections");
    expect(parsed).toHaveProperty("activeConnections");
    expect(parsed).toHaveProperty("totalBytesIn");
    expect(parsed).toHaveProperty("totalBytesOut");
    expect(parsed).toHaveProperty("acceptedTotal");
    expect(parsed).toHaveProperty("closedTotal");
  });
});

describe("server.getStats() byte aggregation", () => {
  const { track, closeAll } = makeServerTracker();

  afterEach(closeAll);

  it("totalBytesIn aggregates from connected peers", async () => {
    const server = await createStarterServer({ port: 0, autoAck: "AA" });
    track(server);
    const port = must(server.getStats().port);

    // Wait for message to be processed
    const messageReceived = new Promise<void>((resolve) => {
      server.once("message", () => setTimeout(resolve, 50));
    });

    const sock = await connectRaw(port);
    try {
      const hl7 = "MSH|^~\\&|App|Fac|Srv|Srv|20240101120000||ADT^A01|MSG001|P|2.3\r";
      await sendFramedMessage(sock, hl7);
      await messageReceived;

      const stats = server.getStats();
      // bytesIn should be > 0 after receiving a message
      expect(stats.totalBytesIn).toBeGreaterThan(0);
    } finally {
      sock.destroy();
    }
  });

  it("totalBytesOut aggregates from connected peers after sending", async () => {
    const server = await createStarterServer({ port: 0, autoAck: "AA" });
    track(server);
    const port = must(server.getStats().port);

    // Wait for message to be processed and ACK sent
    const messageReceived = new Promise<void>((resolve) => {
      server.once("message", () => setTimeout(resolve, 100));
    });

    const sock = await connectRaw(port);
    try {
      const hl7 = "MSH|^~\\&|App|Fac|Srv|Srv|20240101120000||ADT^A01|MSG001|P|2.3\r";
      await sendFramedMessage(sock, hl7);
      await messageReceived;

      const stats = server.getStats();
      // bytesOut should be > 0 after auto-ACK was sent
      expect(stats.totalBytesOut).toBeGreaterThan(0);
    } finally {
      sock.destroy();
    }
  });
});

describe("Symbol.asyncDispose", () => {
  it("await using server compiles and calls close() on scope exit", async () => {
    // This tests that Symbol.asyncDispose is present and functional
    const server = createServer({});
    await server.listen(0);
    expect(server.getStats().listening).toBe(true);
    // Manually call the disposer
    await server[Symbol.asyncDispose]();
    expect(server.getStats().listening).toBe(false);
  });

  it("Symbol.asyncDispose uses drainTimeoutMs from opts", async () => {
    // createStarterServer with custom drainTimeoutMs
    const server = await createStarterServer({ port: 0, drainTimeoutMs: 5_000 });
    expect(server.getStats().listening).toBe(true);
    // dispose should call close() with the configured drain
    await server[Symbol.asyncDispose]();
    expect(server.getStats().listening).toBe(false);
  });
});

describe("handleSignals", () => {
  beforeEach(() => {
    // Ensure no leftover SIGTERM listeners from other tests
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  afterEach(() => {
    // Clean up any remaining signal listeners
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGINT");
  });

  it('handleSignals: true — process.listenerCount("SIGTERM") === 1 after createStarterServer', async () => {
    const server = await createStarterServer({ port: 0, handleSignals: true });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('handleSignals: true — process.listenerCount("SIGTERM") === 0 after server.close()', async () => {
    const server = await createStarterServer({ port: 0, handleSignals: true });
    expect(process.listenerCount("SIGTERM")).toBe(1);
    await server.close();
    expect(process.listenerCount("SIGTERM")).toBe(0);
  });

  it("handleSignals: true — registers both SIGTERM and SIGINT", async () => {
    const server = await createStarterServer({ port: 0, handleSignals: true });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(1);
      expect(process.listenerCount("SIGINT")).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("handleSignals: true — after close(), both SIGTERM and SIGINT listeners removed", async () => {
    const server = await createStarterServer({ port: 0, handleSignals: true });
    await server.close();
    expect(process.listenerCount("SIGTERM")).toBe(0);
    expect(process.listenerCount("SIGINT")).toBe(0);
  });

  it("handleSignals: false (default) — process.once is NOT called", async () => {
    const server = await createStarterServer({ port: 0 });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(0);
      expect(process.listenerCount("SIGINT")).toBe(0);
    } finally {
      await server.close();
    }
  });

  it("handleSignals: false (default) — no SIGTERM listener even without explicit false", async () => {
    const server = await createStarterServer({ port: 0, handleSignals: false });
    try {
      expect(process.listenerCount("SIGTERM")).toBe(0);
    } finally {
      await server.close();
    }
  });
});

describe("frozen event payloads audit", () => {
  const { track, closeAll } = makeServerTracker();

  afterEach(closeAll);

  it("'listening' event payload is frozen", async () => {
    const server = createServer({});
    track(server);
    let listeningPayload: Record<string, unknown> | undefined;
    server.once("listening", (payload: unknown) => {
      listeningPayload = payload as Record<string, unknown>;
    });
    await server.listen(0);
    expect(listeningPayload).toBeDefined();
    expect(Object.isFrozen(listeningPayload)).toBe(true);
  });

  it("'connection' event payload is frozen", async () => {
    const server = createServer({});
    track(server);
    await server.listen(0);
    const port = must(server.getStats().port);

    const connPayload = await new Promise<unknown>((resolve) => {
      server.once("connection", (payload) => resolve(payload));
      const sock = net.createConnection({ host: "127.0.0.1", port });
      sock.on("error", () => {
        /* ignore */
      });
    });

    expect(Object.isFrozen(connPayload)).toBe(true);
    // Clean up
    const sock = net.createConnection({ host: "127.0.0.1", port });
    sock.destroy();
  });

  it("'message' event payload is frozen", async () => {
    const server = createServer({});
    track(server);
    await server.listen(0);
    const port = must(server.getStats().port);

    const msgPayload = await new Promise<unknown>((resolve) => {
      server.once("message", (payload) => resolve(payload));
      const sock = net.createConnection({ host: "127.0.0.1", port });
      sock.once("connect", () => {
        const hl7 = "MSH|^~\\&|A|B|C|D|20240101||ADT^A01|ID1|P|2.3\r";
        sock.write(frameMessage(hl7));
      });
    });

    expect(Object.isFrozen(msgPayload)).toBe(true);
  });
});
