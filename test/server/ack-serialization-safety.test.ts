/**
 * ACK-serialization safety (MLLP-10).
 *
 * Two defects on the ACK build/dispatch path, both reachable WITHOUT any consumer bug — one of them
 * from peer-controlled input alone:
 *
 * 1. **`buildRawAck` decoded the inbound with `ascii`,** which masks the high bit (`byte & 0x7f`).
 *    That is wrong twice: it violates HL7 v2.5.1 §2.9.2.2 (MSA-2 must echo MSH-10 *verbatim*), and
 *    it MANUFACTURES framing delimiters — `0x8B → 0x0B` (VT), `0x9C → 0x1C` (FS). A peer sending one
 *    high-bit byte in an echoed MSH field made the ACK payload contain a real VT/FS.
 * 2. **`encodeFrame` (strict) then threw on that injected delimiter,** and the throw escaped the
 *    `void`-ed `_sendCommitAck` async task → unhandled rejection → **the whole server crashed**, and
 *    the fail-safe ACK was never sent.
 *
 * Fix: `buildRawAck` uses `latin1` (byte-exact, no synthesis), and `_dispatchAck` is total — a frame
 * failure (e.g. a caller's `autoAck: fn` returning bytes with a literal VT/FS) becomes a connection
 * `'error'`, never a process kill.
 *
 * Real loopback sockets, because the crash is an unhandled rejection from a void-ed task.
 */

import { describe, it, expect } from "vitest";
import type { Socket } from "node:net";
import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";
import { buildRawAck } from "../../src/server/ack.js";
import { must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

async function connect(port: number): Promise<Socket> {
  const net = await import("node:net");
  return await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

async function listen(server: MllpServer): Promise<number> {
  await server.listen(0, "127.0.0.1");
  return must(server.getStats().port);
}

/** Send raw framed bytes, resolve with the ACK payload bytes (framing stripped). */
async function exchangeRaw(port: number, framed: Buffer): Promise<Buffer> {
  const sock = await connect(port);
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no ACK within 3s")), 3000);
      sock.once("data", (buf: Buffer) => {
        clearTimeout(t);
        resolve(buf.subarray(1, buf.length - 2));
      });
      sock.once("error", reject);
      sock.write(framed);
    });
  } finally {
    sock.destroy();
  }
}

describe("ACK serialization is safe against peer-controlled and caller-controlled bytes", () => {
  it("a high-bit byte in the inbound MSH-10 does not crash the server, and MSA-2 echoes it verbatim", async () => {
    const server = createServer({
      autoAck: "AA",
      onMessage: () => Promise.resolve(), // commit succeeds
    });
    server.on("error", () => undefined);
    const port = await listen(server);
    try {
      const msh = Buffer.concat([
        Buffer.from("MSH|^~\\&|S|F|R|F|20260714||ADT^A01|MSG", "ascii"),
        Buffer.from([0x8b]), // would become VT (0x0b) under ascii — a synthesized framing byte
        Buffer.from("001|P|2.5\r", "ascii"),
      ]);
      const framed = Buffer.concat([Buffer.from([VT]), msh, Buffer.from([FS, CR])]);

      const ack = await exchangeRaw(port, framed);
      const msa2 = ack.toString("latin1").split("\r")[1]?.split("|")[2];
      // §2.9.2.2 — MSA-2 echoes the inbound MSH-10 verbatim, high bit intact.
      expect(msa2).toBe(`MSG${String.fromCharCode(0x8b)}001`);

      // Server still serving after the input that used to crash it.
      const ack2 = await exchangeRaw(
        port,
        Buffer.concat([
          Buffer.from([VT]),
          Buffer.from("MSH|^~\\&|S|F|R|F|20260714||ADT^A01|MSG002|P|2.5\r", "ascii"),
          Buffer.from([FS, CR]),
        ]),
      );
      expect(ack2.toString("ascii")).toContain("MSA|AA");
    } finally {
      await server.close().catch(() => undefined);
    }
  });

  it("buildRawAck output never contains a framing delimiter for a delimiter-adjacent inbound id", () => {
    // Direct unit check on the primitive: every high-bit byte round-trips, none becomes VT/FS.
    for (const b of [0x8b, 0x9c, 0x80, 0xff]) {
      const inbound = Buffer.concat([
        Buffer.from("MSH|^~\\&|S|F|R|F|20260714||ADT^A01|ID", "ascii"),
        Buffer.from([b]),
        Buffer.from("|P|2.5\r", "ascii"),
      ]);
      const ack = buildRawAck(inbound, "AA");
      expect(ack.includes(VT)).toBe(false);
      expect(ack.includes(FS)).toBe(false);
      expect(ack.toString("latin1")).toContain(`ID${String.fromCharCode(b)}`);
    }
  });

  it("a custom autoAck fn returning bytes with a literal VT does not crash — surfaced as a connection error", async () => {
    // The one path where encodeFrame genuinely can still throw: the caller owns the ACK bytes.
    // It must be a contained connection 'error', never a process kill.
    const server = createServer({
      autoAck: () => Buffer.from([0x4d, VT, 0x53]), // "M<VT>S" — a literal framing byte
    });
    const errors: { error?: { message?: string } }[] = [];
    server.on("error", (e: { error?: { message?: string } }) => errors.push(e));
    const port = await listen(server);
    try {
      const sock = await connect(port);
      const framed = Buffer.concat([
        Buffer.from([VT]),
        Buffer.from("MSH|^~\\&|S|F|R|F|20260714||ADT^A01|MSG001|P|2.5\r", "ascii"),
        Buffer.from([FS, CR]),
      ]);
      sock.write(framed);
      // Give the server a moment to process and (not) crash.
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
      sock.destroy();

      // Still serving, and the frame failure was reported rather than thrown.
      expect(errors.some((e) => e.error?.message === "ACK could not be framed")).toBe(true);
    } finally {
      await server.close().catch(() => undefined);
    }
  });
});
