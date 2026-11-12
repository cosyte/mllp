/**
 * A stray `FS` or `VT` inside a frame, end to end on a default server over a real socket.
 *
 * What a sender sees is what matters here. Two synthetic results joined by a bare `FS` used to
 * reach the handler as the first result, after which the connection closed before its
 * acknowledgement went out and the second was never read: a delivered message with no ACK, which
 * the sender resends, and so commits twice. Joined by a `VT`, the first was dropped and the second
 * handed to the handler and committed under an `AE`.
 *
 * Now the frame is refused whole: the handler sees nothing from it, the server reports one
 * `'error'` whose cause carries `MLLP_PAYLOAD_CONTAINS_FS` or `MLLP_PAYLOAD_CONTAINS_VT`, that
 * connection closes with no acknowledgement, and the server keeps serving. Every case is also sent
 * in two writes split at the stray byte, with a pause between, so the server reads it in two
 * pieces. An `FS` followed by the next frame's `VT` stays two frames, acknowledged in order.
 */

import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { createServer } from "../../src/server/server.js";
import type { MllpServer } from "../../src/server/server.js";

import { makeServerTracker, must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** A synthetic result; every value is plainly fake. */
function result(id: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SYNLAB|SYNFAC|SYNEHR|SYNFAC|20260101120000||ORU^R01|${id}|P|2.5\r` +
      `PID|1||SYN000001^^^SYNFAC^MR||TEST^JANE\rOBX|1|TX|SYN^SYNTEST||synthetic\r`,
    "latin1",
  );
}

const A = result("SYNMSG0001");
const B = result("SYNMSG0002");
const CLEAN = result("SYNMSG0003");

const cat = (...parts: (Buffer | number[])[]): Buffer =>
  Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(p))));

const tracker = makeServerTracker();
afterEach(async () => {
  await tracker.closeAll();
});

interface Seen {
  readonly server: MllpServer;
  readonly port: number;
  readonly handled: string[];
  readonly errors: { code: unknown; message: string }[];
}

/** A default server with a commit handler, recording what it handled and what it reported. */
async function start(): Promise<Seen> {
  const handled: string[] = [];
  const errors: { code: unknown; message: string }[] = [];
  const server = tracker.track(
    createServer({
      autoAck: "AA",
      onMessage: (payload) => {
        handled.push(/\|(SYNMSG\d+)\|/.exec(payload.toString("latin1"))?.[1] ?? "?");
      },
    }),
  );
  server.on("error", (e: unknown) => {
    const error = (e as { error?: { message?: string; cause?: { code?: unknown } } }).error;
    errors.push({ code: error?.cause?.code, message: error?.message ?? "" });
  });
  await server.listen(0, "127.0.0.1");
  return { server, port: must(server.getStats().port), handled, errors };
}

async function connect(port: number): Promise<Socket> {
  const net = await import("node:net");
  return await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Write the pieces with a pause between, then collect every byte the server sends until it
 * closes the socket or `quietMs` passes with the socket open.
 */
async function send(
  port: number,
  pieces: readonly Buffer[],
  quietMs = 300,
): Promise<{ received: string; closed: boolean }> {
  const sock = await connect(port);
  const chunks: Buffer[] = [];
  sock.on("data", (b: Buffer) => chunks.push(b));
  sock.on("error", () => undefined);
  const closed = new Promise<boolean>((resolve) => sock.once("close", () => resolve(true)));
  for (const [i, piece] of pieces.entries()) {
    if (i > 0) await pause(40);
    if (!sock.destroyed) sock.write(piece);
  }
  const outcome = await Promise.race([closed, pause(quietMs).then(() => false)]);
  sock.destroy();
  return { received: Buffer.concat(chunks).toString("latin1"), closed: outcome };
}

/** The MSA segments in what the server sent, in order. */
const msas = (received: string): string[] => received.match(/MSA\|[^\r]*/g) ?? [];

/** The bytes whole, then split in two at `at`. */
const ways = (bytes: Buffer, at: number): [string, Buffer[]][] => [
  ["whole", [bytes]],
  ["split at the stray byte", [bytes.subarray(0, at), bytes.subarray(at)]],
  ["split after the stray byte", [bytes.subarray(0, at + 1), bytes.subarray(at + 1)]],
];

describe("a default server refuses a frame with a stray FS or VT inside it", () => {
  const cases: [string, Buffer, string][] = [
    ["a bare FS", cat([VT], A, [FS], B, [FS, CR]), "MLLP_PAYLOAD_CONTAINS_FS"],
    ["a VT", cat([VT], A, [VT], B, [FS, CR]), "MLLP_PAYLOAD_CONTAINS_VT"],
  ];
  for (const [name, wire, code] of cases) {
    for (const [how, pieces] of ways(wire, 1 + A.length)) {
      it(`two results joined by ${name}, sent ${how}: nothing handled, one coded error, closed`, async () => {
        const seen = await start();
        const { received, closed } = await send(seen.port, pieces);

        expect(seen.handled).toEqual([]);
        expect(received).toBe("");
        expect(closed).toBe(true);
        expect(seen.errors.map((e) => e.code)).toEqual([code]);
        for (const e of seen.errors) {
          expect(e.message).not.toMatch(/SYNMSG|TEST\^JANE|SYN0000|synthetic/);
        }

        // The server keeps serving the next connection.
        const next = await send(seen.port, [cat([VT], CLEAN, [FS, CR])]);
        expect(msas(next.received)).toEqual(["MSA|AA|SYNMSG0003"]);
        expect(seen.handled).toEqual(["SYNMSG0003"]);
      });
    }
  }

  for (const [how, pieces] of ways(cat([VT], A, [FS, VT], B, [FS, CR]), 1 + A.length)) {
    it(`two results joined by FS then VT, sent ${how}: both handled and acknowledged in order`, async () => {
      const seen = await start();
      const { received, closed } = await send(seen.port, pieces);

      expect(closed).toBe(false);
      expect(seen.handled).toEqual(["SYNMSG0001", "SYNMSG0002"]);
      expect(msas(received)).toEqual(["MSA|AA|SYNMSG0001", "MSA|AA|SYNMSG0002"]);
      expect(seen.errors).toEqual([]);
    });
  }
});
