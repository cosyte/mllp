/**
 * Fatal-framing-error containment (MLLP-10).
 *
 * The bug this pins: `Connection` fed `FrameReader.push(chunk)` straight from the transport's
 * data callback with no try/catch. On a real socket that callback IS the `'data'` listener, so a
 * `MllpFramingError` thrown by the decoder escaped as an **uncaught exception and killed the whole
 * process** — every other connection and every in-flight durable commit with it.
 *
 * It was reachable on a DEFAULT server, from one byte: `SERVER_DEFAULT_FRAMING` leaves
 * `allowMissingLeadingVt` off, so any non-whitespace byte where a VT was expected throws
 * `MLLP_MISSING_LEADING_VT`. A single stray keepalive character from a real interface engine was
 * enough to take the server down.
 *
 * The contract now: a fatal framing error drops **that connection only** — surfaced as a frozen
 * `'error'` event (`phase: 'receive'`, the `MllpFramingError` preserved as `cause`) — and the
 * server keeps serving everyone else.
 *
 * These run over real loopback sockets on purpose. The in-memory transport wraps its delivery in
 * try/**finally**, which re-routes the throw to the *writer* instead of leaving it uncaught — which
 * is exactly why the existing suites never caught this. Only a real socket reproduces it.
 */

import { describe, it, expect } from "vitest";
import type { Socket } from "node:net";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";

import { must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

const PAYLOAD =
  "MSH|^~\\&|SENDER|SFAC|RECV|RFAC|20260714120000||ADT^A01|MSG001|P|2.5\rPID|||12345^^^FAC||DOE^JOHN\r";

function framePayload(payload: string): Buffer {
  const body = Buffer.from(payload, "ascii");
  const framed = Buffer.allocUnsafe(body.length + 3);
  framed[0] = VT;
  body.copy(framed, 1);
  framed[body.length + 1] = FS;
  framed[body.length + 2] = CR;
  return framed;
}

async function connect(port: number): Promise<Socket> {
  const net = await import("node:net");
  return await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

/** Send one framed message, resolve with the ACK payload text. */
async function exchange(port: number, payload: string): Promise<string> {
  const sock = await connect(port);
  try {
    return await new Promise<string>((resolve, reject) => {
      sock.once("data", (buf: Buffer) => {
        resolve(buf.subarray(1, buf.length - 2).toString("ascii"));
      });
      sock.once("error", reject);
      sock.write(framePayload(payload));
    });
  } finally {
    sock.destroy();
  }
}

async function listen(server: MllpServer): Promise<number> {
  await server.listen(0, "127.0.0.1");
  return must(server.getStats().port);
}

describe("fatal framing errors are contained to one connection", () => {
  it("a junk byte on a DEFAULT server does not crash the process, and the server keeps serving", async () => {
    const server = createServer({ autoAck: "AA" });
    const errors: unknown[] = [];
    server.on("error", (e: unknown) => errors.push(e));

    const port = await listen(server);
    try {
      // Sanity: the server works.
      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");

      // The killer: one non-whitespace byte where a VT was expected. Before the fix this threw
      // out of the socket 'data' handler as an uncaught exception. Vitest fails the run on an
      // uncaught exception, so simply getting to the end of this test is the regression assertion.
      const bad = await connect(port);
      const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));
      bad.write(Buffer.from([0x58])); // 'X'

      // That connection is dropped — the stream is desynchronized and cannot be trusted.
      await closed;

      // THE contract: the server survived and still serves other peers.
      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("surfaces the framing error as a typed connection error rather than throwing", async () => {
    const server = createServer({ autoAck: "AA" });
    const seen: { code?: unknown; phase?: unknown }[] = [];
    server.on("error", (e: unknown) => {
      // Server re-emits the connection's frozen { connectionId, error } payload.
      const error = (e as { error?: { phase?: unknown; cause?: { code?: unknown } } }).error;
      seen.push({ phase: error?.phase, code: error?.cause?.code });
    });

    const port = await listen(server);
    try {
      const bad = await connect(port);
      const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));
      bad.write(Buffer.from([0x58]));
      await closed;

      // The original MllpFramingError is preserved as `cause`, so the stable warning code and
      // byte offset survive for log pipelines.
      expect(seen).toContainEqual({ phase: "receive", code: "MLLP_MISSING_LEADING_VT" });
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("contains MLLP_FRAME_TOO_LARGE — the oversized-frame fatal — the same way", async () => {
    const server = createServer({ autoAck: "AA", framing: { maxFrameSizeBytes: 1024 } });
    const port = await listen(server);
    try {
      const bad = await connect(port);
      const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));

      // Open a frame and never close it, past the cap.
      bad.write(Buffer.concat([Buffer.from([VT]), Buffer.alloc(4096, 0x41)]));
      await closed;

      // Server still serving.
      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("a BARE Connection with no 'error' listener still does not crash the process", async () => {
    // The first cut of this fix only relocated the crash: `emit('error')` on an EventEmitter with
    // no listener throws ERR_UNHANDLED_ERROR, and that throw happened inside the new catch block —
    // escaping the socket 'data' callback exactly as the MllpFramingError used to. MllpServer and
    // MllpClient both attach an 'error' listener, which masked it; `Connection` is a public export
    // and need not. Deliberately attach NO 'error' listener here.
    const net = await import("node:net");
    const { Connection } = await import("../../src/connection/connection.js");
    const { NetTransport } = await import("../../src/transport/net-transport.js");

    // A raw peer that greets with one non-MLLP byte.
    const rogue = net.createServer((s) => s.write(Buffer.from([0x58])));
    await new Promise<void>((resolve) => rogue.listen(0, "127.0.0.1", () => resolve()));
    const { port } = rogue.address() as { port: number };

    try {
      const sock = await connect(port);
      const conn = new Connection({ transport: new NetTransport(sock) });
      const states: string[] = [];
      conn.on("stateChange", (e: { to: string }) => states.push(e.to));
      // NO conn.on('error', …) — that is the whole point of this test.

      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      // Survived (an uncaught exception would have failed the run), and torn itself down.
      expect(conn.state).toBe("CLOSED");
      expect(states).toContain("CLOSED");
    } finally {
      await new Promise<void>((resolve) => rogue.close(() => resolve()));
    }
  });

  it("does NOT auto-reconnect-loop against a peer that is not speaking MLLP", async () => {
    // A fatal framing error is a COMPATIBILITY failure, not a network blip. Classifying it
    // transient made `createStarterClient` (autoReconnect defaults true) retry forever — an
    // unbounded reconnect storm against a misconfigured peer. It must be permanent.
    const net = await import("node:net");
    const { createClient } = await import("../../src/client/client.js");

    let accepts = 0;
    const httpish = net.createServer((s) => {
      accepts += 1;
      s.write(Buffer.from("HTTP/1.1 200 OK\r\n", "ascii")); // wrong protocol on the MLLP port
    });
    await new Promise<void>((resolve) => httpish.listen(0, "127.0.0.1", () => resolve()));
    const { port } = httpish.address() as { port: number };

    try {
      const client = createClient({
        host: "127.0.0.1",
        port,
        autoReconnect: true,
        initialDelayMs: 10, // if it looped, it would loop FAST
        maxDelayMs: 20,
      });
      client.on("error", () => undefined); // don't care about the payload, just the retry count
      await client.connect().catch(() => undefined);

      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      await client.close().catch(() => undefined);

      // With a 10 ms backoff, a loop would rack up dozens of accepts in 500 ms.
      expect(accepts).toBeLessThanOrEqual(2);
    } finally {
      await new Promise<void>((resolve) => httpish.close(() => resolve()));
    }
  });

  it("a throwing 'message' subscriber does not kill the connection or suppress the ACK", async () => {
    // `onFrame` dispatches synchronously inside `FrameReader.push()`, so a throwing subscriber
    // unwinds through push() and out of the socket 'data' handler. Contained per-subscriber: the
    // ACK still goes out, and the throw is never mislabeled as a peer framing fault.
    const server = createServer({ autoAck: "AA" });
    server.on("message", () => {
      throw new Error("consumer bug in message handler");
    });
    server.on("error", () => undefined);

    const port = await listen(server);
    try {
      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("a peer whose quirk is expected can be tolerated instead — the opt-ins turn the throw into a warning", async () => {
    // The supported answer for a peer that really does omit the leading VT.
    const warnings: string[] = [];
    const server = createServer({
      autoAck: "AA",
      framing: { allowMissingLeadingVt: true },
      onWarning: (w) => warnings.push(w.code),
    });

    const port = await listen(server);
    try {
      const sock = await connect(port);
      try {
        const ack = await new Promise<string>((resolve, reject) => {
          sock.once("data", (buf: Buffer) => resolve(buf.subarray(1, buf.length - 2).toString()));
          sock.once("error", reject);
          // No leading VT — tolerated, warned, and the payload still recovered.
          const body = Buffer.from(PAYLOAD, "ascii");
          sock.write(Buffer.concat([body, Buffer.from([FS, CR])]));
        });
        expect(ack).toContain("MSA|AA");
        expect(warnings).toContain("MLLP_MISSING_LEADING_VT");
      } finally {
        sock.destroy();
      }
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});

/**
 * STRUCTURAL — the rule the previous rounds kept getting wrong.
 *
 * The hazard belongs to the **call stack**, not to a class. `Connection`, `MllpServer` and
 * `MllpClient` all emit from callbacks we do not own (a socket's `'data'`/`'secureConnect'`
 * listener, `net.Server`'s `'connection'` listener, `tls.Server`'s `'tlsClientError'` listener,
 * the `catch` of a `void`-ed async ACK task). Scoping containment to `Connection` alone left four
 * live process-kills in the other two classes — including a throwing `'nack'` subscriber that ALSO
 * suppressed the fail-safe negative ACK.
 *
 * So: attach a throwing subscriber to EVERY event of the server and the client at once, and drive
 * a real exchange through it. A new event emitted uncontained from a callback fails this.
 */
describe("STRUCTURAL: no emit from any class may escape a transport/accept callback", () => {
  const SERVER_EVENTS = [
    "listening",
    "connection",
    "message",
    "nack",
    "error",
    "close",
    "securityWarning",
    "tlsClientError",
  ] as const;

  it("a throwing subscriber on EVERY MllpServer event still serves, and still sends the fail-safe ACK", async () => {
    const server = createServer({
      autoAck: "AA",
      onMessage: async (payload) => {
        // Commit fails for the second message → must still produce a negative ACK, even though
        // the 'nack' subscriber throws.
        if (payload.includes("FAIL")) throw new Error("commit failed");
        await Promise.resolve();
      },
    });
    for (const e of SERVER_EVENTS) {
      server.on(e, () => {
        throw new Error(`consumer bug in the ${e} handler`);
      });
    }

    const port = await listen(server);
    try {
      // Happy path: commit succeeds → AA, despite throwing 'connection'/'message' subscribers.
      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");

      // Failure path: commit throws → the negative ACK MUST still reach the sender, even though
      // the 'nack' subscriber throws inside the catch of a void-ed async task. Suppressing this
      // ACK would leave the sender waiting on a message the server had already failed to commit.
      expect(await exchange(port, `${PAYLOAD}FAIL\r`)).toContain("MSA|AE");

      // And a junk byte on top of all that still does not take the server down.
      const bad = await connect(port);
      const closed = new Promise<void>((resolve) => bad.once("close", () => resolve()));
      bad.write(Buffer.from([0x58]));
      await closed;

      expect(await exchange(port, PAYLOAD)).toContain("MSA|AA");
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("a throwing subscriber on EVERY MllpClient event still connects, sends, and closes", async () => {
    const { createClient } = await import("../../src/client/client.js");
    const server = createServer({ autoAck: "AA" });
    const port = await listen(server);

    const CLIENT_EVENTS = [
      "connect",
      "disconnect",
      "reconnecting",
      "close",
      "message",
      "warning",
      "error",
      "stateChange",
      "securityWarning",
    ] as const;

    try {
      const client = createClient({ host: "127.0.0.1", port });
      for (const e of CLIENT_EVENTS) {
        client.on(e, () => {
          throw new Error(`consumer bug in the ${e} handler`);
        });
      }

      await client.connect();
      const ack = await client.send(Buffer.from(PAYLOAD, "ascii"));
      expect(ack.toString("ascii")).toContain("MSA|AA");
      await client.close();
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});
