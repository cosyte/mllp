/**
 * Phase 6, fail-safe ACK semantics & the commit contract (HL7 v2.5.1 §2.9.2).
 *
 * The central safety property: a positive acknowledgement (`AA`) can **never** precede a
 * successful durable commit. With `autoAck: 'AA'` and an `onMessage` handler, the handler
 * IS the commit step, the server awaits it, then ACKs:
 *   - resolve            ⇒ MSA-1 = AA
 *   - throw / reject     ⇒ MSA-1 = AE (default)
 *   - throw MllpAckError ⇒ MSA-1 = AR (when asked)
 *
 * These run over a real loopback socket (the observable server behavior), mirroring
 * `test/server/auto-ack.test.ts`.
 */

import { describe, it, expect } from "vitest";
import type { Socket } from "node:net";
import { createServer } from "../../src/server/server.js";
import { MllpAckError } from "../../src/server/ack.js";

import { must } from "../helpers/tracked-servers.js";

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

const ADT_A01_PAYLOAD =
  "MSH|^~\\&|SENDER|SFAC|RECV|RFAC|20260424120000||ADT^A01|MSG001|P|2.5\rPID|||12345^^^FAC||DOE^JOHN\r";

function framePayload(payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, "ascii");
  const framed = Buffer.allocUnsafe(payloadBuf.length + 3);
  framed[0] = VT;
  payloadBuf.copy(framed, 1);
  framed[payloadBuf.length + 1] = FS;
  framed[payloadBuf.length + 2] = CR;
  return framed;
}

/** Connect to a listening server, send `payload`, resolve with the decoded ACK payload string. */
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
        resolve(buf.subarray(1, fsIdx).toString("ascii"));
      }
    });
  });

  sock.write(framePayload(payload));
  try {
    return await Promise.race([
      ackPromise,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ack timeout")), 2000)),
    ]);
  } finally {
    sock.destroy();
  }
}

describe("commit contract, positive ACK never precedes a successful commit", () => {
  it("handler resolves ⇒ MSA|AA, echoing the inbound MSH-10", async () => {
    const committed: Buffer[] = [];
    const server = createServer({
      autoAck: "AA",
      onMessage: (payload) => {
        committed.push(payload); // "durable commit"
      },
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ack = await exchange(port, ADT_A01_PAYLOAD);
    expect(ack).toContain("MSA|AA|MSG001");
    expect(committed).toHaveLength(1);

    await server.close();
  });

  it("THE SAFETY TEST: handler throws ⇒ MSA|AE, never AA (forced commit failure)", async () => {
    const server = createServer({
      autoAck: "AA",
      onMessage: () => {
        // Simulate a downstream commit failure (DB write rejected, queue full, …)
        throw new Error("downstream commit failed");
      },
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ack = await exchange(port, ADT_A01_PAYLOAD);
    expect(ack).toContain("MSA|AE|MSG001");
    expect(ack).not.toContain("MSA|AA");

    await server.close();
  });

  it("async handler rejects ⇒ MSA|AE, never AA", async () => {
    const server = createServer({
      autoAck: "AA",
      onMessage: async () => {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return Promise.reject(new Error("async commit failed"));
      },
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ack = await exchange(port, ADT_A01_PAYLOAD);
    expect(ack).toContain("MSA|AE");
    expect(ack).not.toContain("MSA|AA");

    await server.close();
  });

  it("handler throws MllpAckError({ ackCode: 'AR' }) ⇒ MSA|AR (application reject)", async () => {
    const server = createServer({
      autoAck: "AA",
      onMessage: () => {
        throw new MllpAckError("unsupported message type", { ackCode: "AR" });
      },
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ack = await exchange(port, ADT_A01_PAYLOAD);
    expect(ack).toContain("MSA|AR|MSG001");
    expect(ack).not.toContain("MSA|AA");

    await server.close();
  });

  it("ordering: the AA ACK is sent only AFTER the commit handler resolves", async () => {
    let committed = false;
    let ackSentBeforeCommit = false;
    const server = createServer({
      autoAck: "AA",
      onMessage: async () => {
        // Hold the commit open across a macrotask; if the ACK were sent before this
        // resolved, the client would observe it during the delay window.
        await new Promise<void>((resolve) => setTimeout(resolve, 80));
        committed = true;
      },
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ackPromise = exchange(port, ADT_A01_PAYLOAD).then((ack) => {
      if (!committed) ackSentBeforeCommit = true;
      return ack;
    });
    const ack = await ackPromise;

    expect(ack).toContain("MSA|AA");
    expect(committed).toBe(true);
    expect(ackSentBeforeCommit).toBe(false);

    await server.close();
  });

  it("emits a PHI-safe 'nack' event { connectionId, ackCode } on handler failure", async () => {
    const nacks: Array<{ connectionId: string; ackCode: string }> = [];
    const server = createServer({
      autoAck: "AA",
      onMessage: () => {
        throw new MllpAckError("reject", { ackCode: "AR" });
      },
    });
    server.on("nack", (evt: { connectionId: string; ackCode: string }) => {
      nacks.push(evt);
    });
    await server.listen(0);
    const port = must(server.getStats().port);

    await exchange(port, ADT_A01_PAYLOAD);
    // give the event loop a tick for the async commit path to settle
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(nacks).toHaveLength(1);
    const evt = must(nacks[0]);
    expect(evt.ackCode).toBe("AR");
    expect(evt.connectionId).toBeTruthy();
    // PHI-safety: the event must not carry payload content
    expect(JSON.stringify(evt)).not.toContain("MSG001");
    expect(JSON.stringify(evt)).not.toContain("DOE");

    await server.close();
  });

  it("transport-accept: autoAck 'AA' with NO handler still ACKs AA (received+framed)", async () => {
    const server = createServer({ autoAck: "AA" });
    await server.listen(0);
    const port = must(server.getStats().port);

    const ack = await exchange(port, ADT_A01_PAYLOAD);
    expect(ack).toContain("MSA|AA|MSG001");

    await server.close();
  });
});
