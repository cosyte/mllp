/**
 * Differential run edges: a peer address with empty brackets, a signal aborted by the caller's
 * own connect function, and bytes that arrive after an exchange has already settled. Each runs
 * over `InMemoryTransport.pair()`, so no socket is opened.
 */

import { describe, expect, it } from "vitest";

import { CR, FS, VT } from "../../src/framing/constants.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { canonicalExchanges } from "../../src/differential/corpus.js";
import {
  MLLP_DIFF_PEER_UNPARSEABLE,
  MllpDifferentialConfigurationError,
} from "../../src/differential/error.js";
import { resolveDifferentialPeer } from "../../src/differential/peer.js";
import { runDifferential, type DifferentialConnect } from "../../src/differential/run.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

function payloadOf(framed: Buffer): Buffer {
  const start = framed[0] === VT ? 1 : 0;
  let end = framed.length;
  if (framed[end - 1] === CR) end -= 1;
  if (framed[end - 1] === FS) end -= 1;
  return framed.subarray(start, end);
}

function ackFor(framed: Buffer): Buffer {
  const controlId = payloadOf(framed).toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
  return encodeFrame(
    Buffer.from(
      `MSH|^~\\&|RECV_APP|RECV_FAC|SEND_APP|SEND_FAC|20260709120001||ACK^A01|ACK00001|P|2.5\rMSA|AA|${controlId}`,
      "latin1",
    ),
  );
}

describe("resolveDifferentialPeer: an address with empty brackets", () => {
  it("refuses it as unparseable rather than resolving an empty host", () => {
    let caught: unknown;
    try {
      resolveDifferentialPeer("[]:2575");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MllpDifferentialConfigurationError);
    expect((caught as MllpDifferentialConfigurationError).code).toBe(MLLP_DIFF_PEER_UNPARSEABLE);
    expect((caught as MllpDifferentialConfigurationError).value).toBe("[]:2575");
  });
});

describe("runDifferential: the caller's connect function aborts the run", () => {
  it("rejects with the signal's own reason before writing anything", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted while connecting");
    let written = 0;
    const connect: DifferentialConnect = () => {
      const [clientEnd, peerEnd] = InMemoryTransport.pair();
      peerEnd.onData((chunk) => {
        written += chunk.length;
      });
      controller.abort(reason);
      return clientEnd;
    };

    await expect(
      runDifferential({ peer: "127.0.0.1:2575", connect, signal: controller.signal }),
    ).rejects.toBe(reason);
    expect(written).toBe(0);
  });
});

describe("runDifferential: bytes after the exchange settled", () => {
  it("counts only the bytes up to the answering frame", async () => {
    const exchange = canonicalExchanges()[0];
    if (exchange === undefined) throw new Error("corpus is empty");
    let answerLength = 0;
    const connect: DifferentialConnect = () => {
      const [clientEnd, peerEnd] = InMemoryTransport.pair();
      peerEnd.onData((chunk) => {
        const answer = ackFor(chunk);
        answerLength = answer.length;
        peerEnd.write(answer);
        // A second, stray write lands after the frame already settled the exchange.
        peerEnd.write(Buffer.from("trailing noise", "latin1"));
      });
      setTimeout(() => {
        clientEnd.simulateConnect();
      }, 0);
      return clientEnd;
    };

    const report = await runDifferential({
      peer: "127.0.0.1:2575",
      connect,
      exchanges: [exchange],
      deadlineMs: 1_000,
    });

    expect(report.exchanges).toHaveLength(1);
    expect(report.exchanges[0]?.outcome).toBe("answered");
    expect(report.exchanges[0]?.correlation).toBe("match");
    expect(report.exchanges[0]?.responseByteCount).toBe(answerLength);
  });
});
