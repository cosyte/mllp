/**
 * createStarterClient tests (PLAN-06, CLIENT-10, D-22, CLIENT-14).
 *
 * Validates D-22 default-set, override semantics, handleSignals,
 * Symbol.asyncDispose path, and JSDoc north-star example.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createServer as createNetServer } from "node:net";
import type { Server, Socket } from "node:net";
import {
  createStarterClient,
  type StarterClientOptions,
  type MllpClient,
} from "../../src/client/client.js";
import { encodeFrame, FrameReader } from "../../src/framing/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PeerHarness {
  server: Server;
  port: number;
  /** Sockets accepted by this peer; closed in afterEach. */
  sockets: Socket[];
  /** Promise resolves with the first frame the peer receives. */
  received: Promise<Buffer>;
  close: () => Promise<void>;
}

function startEchoAckPeer(): Promise<PeerHarness> {
  return new Promise((resolveOuter) => {
    const sockets: Socket[] = [];
    let resolveReceived!: (b: Buffer) => void;
    const received = new Promise<Buffer>((r) => {
      resolveReceived = r;
    });
    const server = createNetServer((socket) => {
      sockets.push(socket);
      const reader = new FrameReader({
        onFrame: (payload) => {
          resolveReceived(payload);
          // Echo back a synthetic ACK frame
          socket.write(encodeFrame(Buffer.from("AA")));
        },
        onWarning: () => undefined,
      });
      socket.on("data", (chunk) => reader.push(chunk));
      socket.on("error", () => undefined);
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolveOuter({
        server,
        port,
        sockets,
        received,
        close: async () =>
          new Promise<void>((r) => {
            for (const s of sockets) s.destroy();
            server.close(() => r());
          }),
      });
    });
  });
}

const peers: PeerHarness[] = [];
const clients: MllpClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    try {
      c.destroy();
    } catch {
      /* noop */
    }
  }
  for (const p of peers.splice(0)) {
    await p.close();
  }
});

describe("createStarterClient (PLAN-06, CLIENT-10, D-22)", () => {
  it("Test 1: returns a CONNECTED client (north-star three-line snippet)", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const client = await createStarterClient({ host: "127.0.0.1", port: peer.port });
    clients.push(client);
    expect(client.state).toBe("CONNECTED");
    const ack = await client.send(Buffer.from("PAY"));
    expect(ack.toString()).toBe("AA");
  });

  it("Test 2: applies D-22 defaults (autoReconnect, ackTimeoutMs, correlateByControlId, pipeline, highWaterMark, onBackpressure)", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const client = await createStarterClient({ host: "127.0.0.1", port: peer.port });
    clients.push(client);
    const internals = client as unknown as {
      _autoReconnect: boolean;
      _ackTimeoutMs: number;
      _correlateByControlId: boolean;
      _pipeline: boolean;
      _hwmCount: number;
      _onBackpressure: "reject" | "wait";
    };
    expect(internals._autoReconnect).toBe(true);
    expect(internals._ackTimeoutMs).toBe(30_000);
    expect(internals._correlateByControlId).toBe(false);
    expect(internals._pipeline).toBe(true);
    expect(internals._hwmCount).toBe(64);
    expect(internals._onBackpressure).toBe("reject");
  });

  it("Test 3: caller-supplied options override defaults", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const client = await createStarterClient({
      host: "127.0.0.1",
      port: peer.port,
      ackTimeoutMs: 5_000,
      pipeline: false,
      highWaterMark: 8,
    });
    clients.push(client);
    const internals = client as unknown as {
      _ackTimeoutMs: number;
      _pipeline: boolean;
      _hwmCount: number;
    };
    expect(internals._ackTimeoutMs).toBe(5_000);
    expect(internals._pipeline).toBe(false);
    expect(internals._hwmCount).toBe(8);
  });

  it("Test 4 (handleSignals:true): registers SIGTERM + SIGINT handlers", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const onceSpy = vi.spyOn(process, "once");
    try {
      const client = await createStarterClient({
        host: "127.0.0.1",
        port: peer.port,
        handleSignals: true,
      });
      clients.push(client);
      const events = onceSpy.mock.calls.map((c) => c[0]);
      expect(events).toContain("SIGTERM");
      expect(events).toContain("SIGINT");
      await client.close();
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("Test 4b (handleSignals:false default): does NOT register signal handlers", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const onceSpy = vi.spyOn(process, "once");
    try {
      const client = await createStarterClient({ host: "127.0.0.1", port: peer.port });
      clients.push(client);
      const events = onceSpy.mock.calls.map((c) => c[0]);
      expect(events).not.toContain("SIGTERM");
      expect(events).not.toContain("SIGINT");
    } finally {
      onceSpy.mockRestore();
    }
  });

  it("Test 5 (CLIENT-14): await using triggers Symbol.asyncDispose → close → CLOSED", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    let captured: MllpClient | undefined;
    {
      await using c = await createStarterClient({ host: "127.0.0.1", port: peer.port });
      captured = c;
      expect(c.state).toBe("CONNECTED");
    }
    // After the `await using` block exits, Symbol.asyncDispose was called.
    expect(captured).toBeDefined();
    expect(captured.state === "CLOSED" || captured.state === "DISCONNECTED").toBe(true);
  });

  it("Test 6 (W-06): JSDoc @example contains the literal `await using c = await createStarterClient(...)` snippet", () => {
    const src = readFileSync(resolve(__dirname, "../../src/client/client.ts"), "utf8");
    expect(src).toMatch(/await using c = await createStarterClient\(/);
    expect(src).toMatch(/const ack = await c\.send\(/);
  });

  it("Test 7: state is CONNECTED on return (not CONNECTING), connect() awaited", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const client = await createStarterClient({ host: "127.0.0.1", port: peer.port });
    clients.push(client);
    expect(client.state).toBe("CONNECTED");
    expect(client.state).not.toBe("CONNECTING");
  });

  it("Test 8: optional onMessage callback wires Connection message events", async () => {
    const peer = await startEchoAckPeer();
    peers.push(peer);
    const messages: Buffer[] = [];
    const opts: StarterClientOptions = {
      host: "127.0.0.1",
      port: peer.port,
      onMessage: (payload) => {
        messages.push(payload);
      },
    };
    const client = await createStarterClient(opts);
    clients.push(client);
    // Send a payload, peer echoes a synthetic AA frame, which fires the
    // 'message' event on the client (in addition to ACK matching).
    await client.send(Buffer.from("PAY"));
    expect(messages.length).toBeGreaterThanOrEqual(1);
    expect(messages[0]?.toString()).toBe("AA");
  });
});
