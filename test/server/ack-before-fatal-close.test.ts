/**
 * A frame delivered before a refused one is still acknowledged, over a real socket.
 *
 * A sender that writes its next frame before the previous ACK arrives can put a good frame and a
 * frame with a fatal framing error in one write. The good frame reaches the handler, and its ACK
 * goes out only once the handler settles, a microtask later even for a synchronous handler. The
 * connection used to close at once on the fatal error, so that ACK was never sent: the sender
 * resent a message the handler had already committed, and it was processed twice.
 *
 * Now the connection reads nothing more, waits for every delivered frame's handler and its ACK,
 * then closes; a handler that never settles holds it open for `drainTimeoutMs` at most.
 */

import type { Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { encodeFrame } from "../../src/framing/index.js";
import { buildRawAck } from "../../src/server/ack.js";
import { createServer } from "../../src/server/server.js";
import type { ServerOptions } from "../../src/server/server.js";

import { makeServerTracker, must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;

/** A synthetic result; every value is plainly fake. */
function result(id: string, pad = ""): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SYNLAB|SYNFAC|SYNEHR|SYNFAC|20260101120000||ORU^R01|${id}|P|2.5\r` +
      `PID|1||SYN000001^^^SYNFAC^MR||TEST^JANE\rOBX|1|TX|SYN^SYNTEST||synthetic${pad}\r`,
    "latin1",
  );
}

const A = result("SYNMSG0001");
const B = result("SYNMSG0002");
const C = result("SYNMSG0003");

const cat = (...parts: (Buffer | number[] | string)[]): Buffer =>
  Buffer.concat(
    parts.map((p) =>
      Buffer.isBuffer(p) ? p : typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p),
    ),
  );

const GOOD = cat([VT], A, [FS, CR]);

const tracker = makeServerTracker();
afterEach(async () => {
  await tracker.closeAll();
});

interface Seen {
  readonly port: number;
  readonly handled: string[];
  readonly codes: unknown[];
  readonly connections: () => number;
}

const idOf = (payload: Buffer): string =>
  /\|(SYNMSG\d+)\|/.exec(payload.toString("latin1"))?.[1] ?? "?";

/** A server recording the frames its handler saw and the framing codes it reported. */
async function start(opts: ServerOptions): Promise<Seen> {
  const server = tracker.track(createServer(opts));
  const codes: unknown[] = [];
  server.on("error", (e: unknown) => {
    const error = (e as { error?: { connectionCause?: string; cause?: { code?: unknown } } }).error;
    if (error?.connectionCause === "framing-fatal") codes.push(error.cause?.code);
  });
  await server.listen(0, "127.0.0.1");
  return {
    port: must(server.getStats().port),
    handled: [],
    codes,
    connections: () => server.getStats().connections,
  };
}

/** A recording commit handler, settling as `settle` says. */
function recording(
  seen: { handled: string[] },
  settle: (payload: Buffer) => unknown = () => undefined,
): NonNullable<ServerOptions["onMessage"]> {
  return (payload) => {
    seen.handled.push(idOf(payload));
    return settle(payload) as void;
  };
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

interface Outcome {
  readonly received: string;
  readonly closed: boolean;
  readonly closedAfterMs: number;
}

/**
 * Write the pieces with `gapMs` between, then collect every byte the server sends until it closes
 * the socket or `quietMs` passes with it open.
 */
async function send(
  port: number,
  pieces: readonly Buffer[],
  quietMs = 1_500,
  gapMs = 40,
): Promise<Outcome> {
  const sock = await connect(port);
  const chunks: Buffer[] = [];
  sock.on("data", (b: Buffer) => chunks.push(b));
  sock.on("error", () => undefined);
  const began = Date.now();
  let closedAt = -1;
  const closed = new Promise<boolean>((resolve) =>
    sock.once("close", () => {
      closedAt = Date.now();
      resolve(true);
    }),
  );
  for (const [i, piece] of pieces.entries()) {
    if (i > 0) await pause(gapMs);
    if (!sock.destroyed) sock.write(piece);
  }
  const outcome = await Promise.race([closed, pause(quietMs).then(() => false)]);
  sock.destroy();
  return {
    received: Buffer.concat(chunks).toString("latin1"),
    closed: outcome,
    closedAfterMs: closedAt - began,
  };
}

/** The MSA segments in what the server sent, in order. */
const msas = (received: string): string[] => received.match(/MSA\|[^\r]*/g) ?? [];

describe("a good frame and then a fatal one, in one write", () => {
  const cases: [string, Buffer, string, ServerOptions["framing"]][] = [
    ["a byte where a VT was expected", cat(GOOD, "X"), "MLLP_MISSING_LEADING_VT", undefined],
    [
      "a VT inside the next frame",
      cat(GOOD, [VT], B, [VT], C, [FS, CR]),
      "MLLP_PAYLOAD_CONTAINS_VT",
      undefined,
    ],
    [
      "a bare FS inside the next frame",
      cat(GOOD, [VT], B, [FS], C, [FS, CR]),
      "MLLP_PAYLOAD_CONTAINS_FS",
      undefined,
    ],
    [
      "an FS with no CR, allowFsOnly off",
      cat(GOOD, [VT], B, [FS], "X"),
      "MLLP_FS_WITHOUT_CR",
      { allowFsOnly: false },
    ],
    [
      "an LF after FS, allowLfAfterFs off",
      cat(GOOD, [VT], B, [FS, LF]),
      "MLLP_LF_AFTER_FS",
      { allowLfAfterFs: false },
    ],
    [
      "a next frame past the size cap",
      cat(GOOD, [VT], result("SYNMSG0002", "xxxx"), [FS, CR]),
      "MLLP_FRAME_TOO_LARGE",
      { maxFrameSizeBytes: A.length },
    ],
  ];
  for (const [name, wire, code, framing] of cases) {
    it(`${name}: the good frame is acknowledged, then the connection closes`, async () => {
      const seen = { handled: [] as string[] };
      const server = await start({
        autoAck: "AA",
        onMessage: recording(seen),
        ...(framing === undefined ? {} : { framing }),
      });
      const { received, closed } = await send(server.port, [wire]);

      expect(seen.handled).toEqual(["SYNMSG0001"]);
      expect(msas(received)).toEqual(["MSA|AA|SYNMSG0001"]);
      expect(closed).toBe(true);
      expect(server.codes).toEqual([code]);
    });
  }
});

describe("the wait for a delivered frame's answer", () => {
  it("waits for a slow handler, reads nothing more meanwhile, then closes", async () => {
    const seen = { handled: [] as string[] };
    const server = await start({
      autoAck: "AA",
      onMessage: recording(seen, () => pause(300)),
    });
    // The third frame arrives while the first is still being handled: it is never read.
    const { received, closed, closedAfterMs } = await send(server.port, [
      cat(GOOD, "X"),
      cat([VT], C, [FS, CR]),
    ]);

    expect(seen.handled).toEqual(["SYNMSG0001"]);
    expect(msas(received)).toEqual(["MSA|AA|SYNMSG0001"]);
    expect(closed).toBe(true);
    expect(closedAfterMs).toBeGreaterThanOrEqual(250);
    expect(server.codes).toEqual(["MLLP_MISSING_LEADING_VT"]);
    expect(server.connections()).toBe(0);
  });

  it("sends the negative ACK of a handler that rejects, then closes", async () => {
    const seen = { handled: [] as string[] };
    const server = await start({
      autoAck: "AA",
      onMessage: recording(seen, async () => {
        await pause(50);
        throw new Error("synthetic commit failure");
      }),
    });
    const { received, closed } = await send(server.port, [cat(GOOD, "X")]);

    expect(seen.handled).toEqual(["SYNMSG0001"]);
    expect(msas(received)).toEqual(["MSA|AE|SYNMSG0001|message could not be processed"]);
    expect(closed).toBe(true);
  });

  it("does not let a handler that never settles hold the connection open past drainTimeoutMs", async () => {
    const seen = { handled: [] as string[] };
    const server = await start({
      autoAck: "AA",
      drainTimeoutMs: 300,
      onMessage: recording(seen, () => new Promise<never>(() => undefined)),
    });
    const { received, closed, closedAfterMs } = await send(server.port, [cat(GOOD, "X")], 5_000);

    expect(seen.handled).toEqual(["SYNMSG0001"]);
    expect(received).toBe("");
    expect(closed).toBe(true);
    expect(closedAfterMs).toBeGreaterThanOrEqual(250);
    expect(closedAfterMs).toBeLessThan(3_000);
    expect(server.connections()).toBe(0);
  });

  it("waits for a manual-mode handler that writes its own ACK", async () => {
    const seen = { handled: [] as string[] };
    const server = await start({
      onMessage: async (payload, _meta, conn) => {
        seen.handled.push(idOf(payload));
        await pause(100);
        conn.send(encodeFrame(buildRawAck(payload, "AA")));
      },
    });
    const { received, closed } = await send(server.port, [cat(GOOD, "X")]);

    expect(seen.handled).toEqual(["SYNMSG0001"]);
    expect(msas(received)).toEqual(["MSA|AA|SYNMSG0001"]);
    expect(closed).toBe(true);
    expect(server.codes).toEqual(["MLLP_MISSING_LEADING_VT"]);
  });

  it("waits for a custom ACK builder", async () => {
    const server = await start({
      autoAck: async (payload) => {
        await pause(100);
        return buildRawAck(payload, "AA");
      },
    });
    const { received, closed } = await send(server.port, [cat(GOOD, "X")]);

    expect(msas(received)).toEqual(["MSA|AA|SYNMSG0001"]);
    expect(closed).toBe(true);
    expect(server.codes).toEqual(["MLLP_MISSING_LEADING_VT"]);
  });

  it("closes at once when nothing delivered is still being answered", async () => {
    const server = await start({ autoAck: "AA" });
    const { received, closed, closedAfterMs } = await send(server.port, [Buffer.from("X")]);

    expect(received).toBe("");
    expect(closed).toBe(true);
    expect(closedAfterMs).toBeLessThan(1_000);
    expect(server.codes).toEqual(["MLLP_MISSING_LEADING_VT"]);
  });
});
