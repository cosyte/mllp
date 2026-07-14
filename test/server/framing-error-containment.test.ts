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
