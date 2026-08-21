/**
 * Mode-correct acknowledgement-code selection on the server's auto-ACK path.
 *
 * HL7 Table 0008 has two halves, and which half a responder answers in is not its own
 * choice: MSH-15 (accept acknowledgment type, HL7 Table 0155) states the conditions under
 * which the sender wants an accept acknowledgement. A responder that answers a peer asking
 * for a commit acknowledgement with an application-mode code has answered in the wrong half
 * of the table.
 *
 * The matrix below is the test. Rows are MSH-15 as read against Table 0155; columns are the
 * disposition the commit-gated path reaches; cells are the code that must go on the wire.
 * Two inbound shapes leave the matrix and keep the server's own answer: a batch or
 * concatenated frame, and a header the server cannot scan.
 *
 * These run over a real loopback socket, which is the observable server behaviour, mirroring
 * the commit-contract suite beside them.
 *
 * Fixtures are synthetic MSH headers only. No patient data appears anywhere here.
 */

import { describe, it, expect } from "vitest";
import type { Socket } from "node:net";

import { createServer, type MllpServer } from "../../src/server/server.js";
import { MllpAckError } from "../../src/server/ack.js";

import { must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** The disposition the commit-gated path reaches for a message, before mode selection. */
type Disposition = "AA" | "AE" | "AR";

/**
 * An inbound message whose MSH-15 is exactly `msh15`.
 *
 * `MSH`(name) `^~\&`(2) `SENDER`(3) `SFAC`(4) `RECV`(5) `RFAC`(6) time(7) ``(8)
 * `ADT^A01`(9) `MSG001`(10) `P`(11) `2.5.1`(12) ``(13) ``(14) msh15(15).
 */
function inbound(msh15: string, controlId = "MSG001"): string {
  return `MSH|^~\\&|SENDER|SFAC|RECV|RFAC|20260821120000||ADT^A01|${controlId}|P|2.5.1|||${msh15}\r`;
}

function framePayload(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "latin1");
  return Buffer.concat([Buffer.from([VT]), payloadBuf, Buffer.from([FS, CR])]);
}

/** Connect, send `payload`, resolve with the decoded ACK payload string. */
async function exchange(port: number, payload: string): Promise<string> {
  const net = await import("node:net");
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const ackPromise = new Promise<string>((resolve) => {
    let buf = Buffer.allocUnsafe(0);
    sock.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      const fsIdx = buf.indexOf(FS);
      if (fsIdx !== -1 && fsIdx + 1 < buf.length && buf[fsIdx + 1] === CR) {
        resolve(buf.subarray(1, fsIdx).toString("latin1"));
      }
    });
  });
  sock.write(framePayload(payload));
  try {
    return await Promise.race([
      ackPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ack timeout")), 4000)),
    ]);
  } finally {
    sock.destroy();
  }
}

/** Collect EVERY frame the server sends on one connection over a short window. */
async function exchangeAll(port: number, payload: string, windowMs = 300): Promise<string[]> {
  const net = await import("node:net");
  const sock = await new Promise<Socket>((resolve, reject) => {
    const s = net.createConnection({ host: "127.0.0.1", port });
    s.once("connect", () => resolve(s));
    s.once("error", reject);
  });
  const frames: string[] = [];
  let buf = Buffer.allocUnsafe(0);
  sock.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const fsIdx = buf.indexOf(FS);
      if (fsIdx === -1 || fsIdx + 1 >= buf.length || buf[fsIdx + 1] !== CR) break;
      frames.push(buf.subarray(1, fsIdx).toString("latin1"));
      buf = buf.subarray(fsIdx + 2);
    }
  });
  sock.write(framePayload(payload));
  try {
    await new Promise((resolve) => setTimeout(resolve, windowMs));
    return frames;
  } finally {
    sock.destroy();
  }
}

/** A commit-gated server whose handler reaches the disposition asked for. */
function serverFor(disposition: Disposition): MllpServer {
  return createServer({
    autoAck: "AA",
    onMessage: () => {
      if (disposition === "AE") throw new Error("downstream commit failed");
      if (disposition === "AR") {
        throw new MllpAckError("unsupported trigger event", { ackCode: "AR" });
      }
    },
  });
}

/**
 * Every cell of the matrix. `[MSH-15 bytes, label, code on AA, code on AE, code on AR]`.
 *
 * `AL` asks always; `NE`, an absent field and a value outside the table ask for nothing;
 * `ER` asks on an error or a reject only; `SU` on a success only.
 */
const MATRIX: ReadonlyArray<readonly [string, string, string, string, string]> = [
  ["", "NULL", "AA", "AE", "AR"],
  ["NE", "NE", "AA", "AE", "AR"],
  ["AL", "AL", "CA", "CE", "CR"],
  ["ER", "ER", "AA", "CE", "CR"],
  ["SU", "SU", "CA", "AE", "AR"],
  ["VENDOR", "UNRECOGNISED", "AA", "AE", "AR"],
];

describe("the server matrix: MSH-15 decides which half of Table 0008 the ACK carries", () => {
  for (const [msh15, label, onAA, onAE, onAR] of MATRIX) {
    for (const [disposition, expected] of [
      ["AA", onAA],
      ["AE", onAE],
      ["AR", onAR],
    ] as const) {
      it(`MSH-15 ${label} with a ${disposition} disposition answers ${expected}`, async () => {
        const server = serverFor(disposition);
        await server.listen(0);
        try {
          const port = must(server.getStats().port);
          const ack = await exchange(port, inbound(msh15));
          expect(ack).toContain(`MSA|${expected}|MSG001`);
        } finally {
          await server.close();
        }
      });
    }
  }
});

describe("an unrecognised MSH-15 is reported and the acknowledgement is unchanged", () => {
  it("emits a stable code naming the field, and still answers positively", async () => {
    const events: Array<{ code: string; message: string; connectionId: string }> = [];
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    server.on("ackModeWarning", (e: { code: string; message: string; connectionId: string }) =>
      events.push(e),
    );
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const ack = await exchange(port, inbound("VENDOR"));
      // Not downgraded, not negated: a message the handler committed is answered positively.
      expect(ack).toContain("MSA|AA|MSG001");
      expect(events.map((e) => e.code)).toEqual(["MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED"]);
      expect(typeof events[0]?.connectionId).toBe("string");
      // The event carries no payload content, only a code and a frozen message.
      expect(JSON.stringify(events[0])).not.toContain("VENDOR");
      expect(JSON.stringify(events[0])).not.toContain("MSG001");
    } finally {
      await server.close();
    }
  });

  it("a recognised or absent MSH-15 raises nothing", async () => {
    const events: string[] = [];
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    server.on("ackModeWarning", (e: { code: string }) => events.push(e.code));
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      await exchange(port, inbound("AL"));
      await exchange(port, inbound(""));
      expect(events).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("a throwing ackModeWarning subscriber cannot suppress the acknowledgement", async () => {
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    server.on("ackModeWarning", () => {
      throw new Error("consumer bug in the ackModeWarning handler");
    });
    server.on("error", () => undefined);
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      expect(await exchange(port, inbound("VENDOR"))).toContain("MSA|AA|MSG001");
    } finally {
      await server.close();
    }
  });
});

describe("shapes that leave the matrix", () => {
  it("a batch frame keeps its warned non-positive answer, whatever MSH-15 says", async () => {
    const batch =
      `FHS|^~\\&|S|F|R|F2|20260821120000\r` +
      `MSH|^~\\&|S|F|R|F2|20260821120000||ADT^A01|B1|P|2.5.1|||AL\r`;
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    const nacks: Array<{ ackCode: string; reason: string }> = [];
    server.on("nack", (e: { ackCode: string; reason: string }) => nacks.push(e));
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const ack = await exchange(port, batch);
      expect(ack).toContain("MSA|AE");
      expect(ack).not.toContain("MSA|CA");
      expect(ack).not.toContain("MSA|CE");
      expect(nacks[0]?.ackCode).toBe("AE");
      expect(nacks[0]?.reason).toBe("uncorrelatable-inbound");
    } finally {
      await server.close();
    }
  });

  it("a second MSH in one frame is refused the same way", async () => {
    const concatenated =
      `MSH|^~\\&|S|F|R|F2|20260821120000||ADT^A01|C1|P|2.5.1|||AL\r` +
      `MSH|^~\\&|S|F|R|F2|20260821120000||ADT^A01|C2|P|2.5.1|||AL\r`;
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const ack = await exchange(port, concatenated);
      expect(ack).toContain("MSA|AE");
      expect(ack).not.toContain("MSA|CA");
    } finally {
      await server.close();
    }
  });

  it("a header that cannot be scanned behaves exactly as it did, adding no new failure", async () => {
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    const events: string[] = [];
    server.on("ackModeWarning", (e: { code: string }) => events.push(e.code));
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const ack = await exchange(port, "no hl7 here at all");
      expect(ack).toContain("MSA|AE");
      expect(events).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("an empty MSH-10 stays a downgrade, in whichever half was asked for", async () => {
    // Readable header, not a batch, so the matrix applies: the downgraded disposition is
    // emitted in the accept-mode half the inbound asked for.
    const noControlId = `MSH|^~\\&|S|F|R|F2|20260821120000||ADT^A01||P|2.5.1|||AL\r`;
    const server = createServer({ autoAck: "AA", onMessage: () => undefined });
    const nacks: Array<{ ackCode: string }> = [];
    server.on("nack", (e: { ackCode: string }) => nacks.push(e));
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const ack = await exchange(port, noControlId);
      expect(ack).toContain("MSA|CE");
      expect(ack).not.toContain("MSA|CA");
      // The reported code is the one that actually went on the wire.
      expect(nacks[0]?.ackCode).toBe("CE");
    } finally {
      await server.close();
    }
  });
});

describe("exactly one acknowledgement per inbound message, in every mode", () => {
  for (const msh15 of ["", "AL", "ER", "SU", "NE", "VENDOR"]) {
    it(`MSH-15 ${msh15 === "" ? "NULL" : msh15} draws exactly one`, async () => {
      const server = createServer({ autoAck: "AA", onMessage: () => undefined });
      await server.listen(0);
      try {
        const port = must(server.getStats().port);
        const frames = await exchangeAll(port, inbound(msh15));
        expect(frames).toHaveLength(1);
      } finally {
        await server.close();
      }
    });
  }

  it("a rejected enhanced-mode message draws exactly one, and it is the commit rejection", async () => {
    const server = serverFor("AR");
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      const frames = await exchangeAll(port, inbound("AL"));
      expect(frames).toHaveLength(1);
      expect(frames[0]).toContain("MSA|CR|MSG001");
    } finally {
      await server.close();
    }
  });

  it("the transport-accept path (no handler) selects the same way", async () => {
    const server = createServer({ autoAck: "AA" });
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      expect(await exchange(port, inbound("AL"))).toContain("MSA|CA|MSG001");
      expect(await exchange(port, inbound(""))).toContain("MSA|AA|MSG001");
    } finally {
      await server.close();
    }
  });

  it("a custom acknowledgement builder still owns MSA-1 entirely", async () => {
    const server = createServer({
      autoAck: () =>
        Buffer.from("MSH|^~\\&|R|F|S|F2|20260821120000||ACK|A1|P|2.5.1\rMSA|CR|MSG001\r"),
    });
    await server.listen(0);
    try {
      const port = must(server.getStats().port);
      expect(await exchange(port, inbound("AL"))).toContain("MSA|CR|MSG001");
    } finally {
      await server.close();
    }
  });
});
