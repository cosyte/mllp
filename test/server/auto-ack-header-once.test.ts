/**
 * The server's auto-ACK path reads an inbound's MSH header once.
 *
 * Choosing the acknowledgement mode, deciding whether a positive ACK can be correlated, and
 * building the ACK each read the header again, about four times per message, and scanned the whole
 * payload for a batch or a second MSH twice: a quarter of a round trip's time and about half its
 * allocated bytes. These count the calls into the shared scanner for one message on each route
 * through the path. Every message is synthetic.
 */

import { EventEmitter } from "node:events";
import type { Socket } from "node:net";

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as ControlId from "../../src/internal/control-id.js";

const calls = vi.hoisted(() => ({ msh: 0, batch: 0 }));

vi.mock("../../src/internal/control-id.js", async (importOriginal) => {
  const actual = await importOriginal<typeof ControlId>();
  return {
    ...actual,
    readMshSegment: (buf: Buffer) => {
      calls.msh++;
      return actual.readMshSegment(buf);
    },
    containsBatchOrExtraMessage: (buf: Buffer) => {
      calls.batch++;
      return actual.containsBatchOrExtraMessage(buf);
    },
  };
});

import { MllpAckError } from "../../src/server/ack.js";
import { MllpServer, type ServerOptions } from "../../src/server/server.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** Only what the server reads and writes of a socket: no network. */
class FakeSocket extends EventEmitter {
  readonly remoteAddress = "127.0.0.1";
  readonly remotePort = 50000;
  readonly written: Buffer[] = [];
  write(buf: Buffer): boolean {
    this.written.push(Buffer.from(buf));
    return true;
  }
  end(): this {
    return this;
  }
  destroy(): this {
    return this;
  }
  setKeepAlive(): this {
    return this;
  }
  setNoDelay(): this {
    return this;
  }
}

function framed(text: string): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(text, "latin1"), Buffer.from([FS, CR])]);
}

const header = (msh15 = ""): string =>
  `MSH|^~\\&|SEND|SFAC|RECV|RFAC|20260101120000||ADT^A01|CID1|P|2.5|||${msh15}\rPID|1\r`;

/** Send one message through a fresh server and return its ACK text. */
async function ackOne(text: string, onMessage?: ServerOptions["onMessage"]): Promise<string> {
  const server = new MllpServer({ autoAck: "AA", ...(onMessage ? { onMessage } : {}) });
  server.on("error", () => undefined);
  const socket = new FakeSocket();
  (server as unknown as { _onSocketAccepted(s: Socket): void })._onSocketAccepted(
    socket as unknown as Socket,
  );
  calls.msh = 0;
  calls.batch = 0;
  socket.emit("data", framed(text));
  for (let k = 0; k < 5; k++) await new Promise<void>((done) => setImmediate(done));
  expect(socket.written).toHaveLength(1);
  return (socket.written[0] as Buffer).subarray(1, -2).toString("latin1");
}

describe("auto-ACK reads the MSH header once per message", () => {
  beforeEach(() => {
    calls.msh = 0;
    calls.batch = 0;
  });

  const routes: [string, string, ServerOptions["onMessage"] | undefined, string][] = [
    ["no handler", header(), undefined, "MSA|AA|CID1"],
    ["a handler that resolves", header(), () => undefined, "MSA|AA|CID1"],
    [
      "a handler that rejects",
      header(),
      () => {
        throw new Error("commit failed");
      },
      "MSA|AE|CID1",
    ],
    [
      "a handler that rejects with AR",
      header("AL"),
      () => Promise.reject(new MllpAckError("no", { ackCode: "AR" })),
      "MSA|CR|CID1",
    ],
    ["an accept acknowledgement asked for", header("AL"), () => undefined, "MSA|CA|CID1"],
    ["a batch", `BHS|^~\\&\r${header("AL")}`, undefined, "MSA|AE|CID1"],
    ["no MSH at all", "PID|1\r", undefined, "MSA|AE|"],
  ];

  for (const [route, text, onMessage, msa] of routes) {
    it(`on ${route}`, async () => {
      const ack = await ackOne(text, onMessage);
      expect(ack).toContain(msa);
      expect(calls.msh).toBe(1);
      expect(calls.batch).toBeLessThanOrEqual(1);
    });
  }
});
