/**
 * The differential harness, driven against IN-PROCESS peers.
 *
 * Every case here runs over `InMemoryTransport.pair()` rather than a socket, which is this
 * repository's standing rule and is what makes a deviating peer expressible at all: a real
 * engine cannot be asked to omit its leading `VT` on demand. One socket-level smoke case
 * sits at the bottom, over a loopback listener, so the default TCP connection is exercised
 * too and the report is proven end to end on real bytes.
 *
 * What each block pins:
 *   - a conformant peer reports byte parity and MSA-2 correlation per exchange;
 *   - a deviating peer is NAMED by its stable warning code, never an opaque error;
 *   - the report is a plain object a consumer reads programmatically;
 *   - a peer address that is present and unusable is REFUSED, and is not the same thing
 *     as no peer at all;
 *   - refused, dropped, silent and mis-correlating peers each land on their own named
 *     outcome and the run still returns a report;
 *   - a run that observed nothing is never presented as a pass.
 */

import { createServer, type Server, type Socket } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { CR, FS, VT } from "../../src/framing/constants.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { canonicalExchanges } from "../../src/differential/corpus.js";
import { MllpDifferentialConfigurationError } from "../../src/differential/error.js";
import { runDifferential, type DifferentialConnect } from "../../src/differential/run.js";
import type { DifferentialReport } from "../../src/differential/report.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

const CORPUS = canonicalExchanges();
const CORPUS_SIZE = CORPUS.length;

/** A short deadline: no case here waits on a real network. */
const FAST_DEADLINE_MS = 60;

/** The unframed payload of a frame the harness wrote, for a peer that wants to answer it. */
function payloadOf(framed: Buffer): Buffer {
  const start = framed[0] === VT ? 1 : 0;
  let end = framed.length;
  if (framed[end - 1] === CR) end -= 1;
  if (framed[end - 1] === FS) end -= 1;
  return framed.subarray(start, end);
}

/** `MSH-10` of a message, read the crude way a test peer would. */
function controlIdOf(payload: Buffer): string {
  return payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
}

/** A conformant positive acknowledgement payload echoing `controlId` in `MSA-2`. */
function ackPayload(controlId: string): Buffer {
  return Buffer.from(
    [
      "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
      `MSA|AA|${controlId}`,
    ].join("\r"),
    "latin1",
  );
}

/**
 * An in-process peer. `answer` is handed the framed bytes the harness wrote and returns
 * the RAW bytes to write back, or `null` to stay silent.
 */
function peerThat(answer: (framed: Buffer) => Buffer | null): DifferentialConnect {
  return () => {
    const [clientEnd, peerEnd] = InMemoryTransport.pair();
    peerEnd.onData((chunk) => {
      const reply = answer(chunk);
      if (reply !== null) peerEnd.write(reply);
    });
    setTimeout(() => {
      clientEnd.simulateConnect();
    }, 0);
    return clientEnd;
  };
}

/** A peer that answers every message with a conformant, correlating acknowledgement. */
const conformantPeer: DifferentialConnect = peerThat((framed) =>
  encodeFrame(ackPayload(controlIdOf(payloadOf(framed)))),
);

/** Run against an in-process peer, with the deadline kept short. */
async function run(
  connect: DifferentialConnect,
  extra: { deadlineMs?: number; maxFrameSizeBytes?: number } = {},
): Promise<DifferentialReport> {
  return runDifferential({
    peer: "127.0.0.1:2575",
    connect,
    deadlineMs: extra.deadlineMs ?? FAST_DEADLINE_MS,
    ...(extra.maxFrameSizeBytes === undefined
      ? {}
      : { maxFrameSizeBytes: extra.maxFrameSizeBytes }),
  });
}

// ---------------------------------------------------------------------------
// A conformant peer: parity and correlation, per exchange
// ---------------------------------------------------------------------------

describe("differential harness: a conformant peer", () => {
  it("reports frame byte parity and MSA-2 correlation for every canonical exchange", async () => {
    const report = await run(conformantPeer);

    expect(report.exchangesAttempted).toBe(CORPUS_SIZE);
    expect(report.exchangesAnswered).toBe(CORPUS_SIZE);
    expect(report.exchanges.map((e) => e.exchangeId)).toEqual(CORPUS.map((e) => e.id));
    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("answered");
      expect(exchange.byteParity).toBe("match");
      expect(exchange.correlation).toBe("match");
      expect(exchange.warningCodes).toEqual([]);
      expect(exchange.deviations).toEqual([]);
    }
    expect(report.result).toBe("parity-observed");
    expect(report.peer).toEqual({ host: "127.0.0.1", port: 2575 });
  });

  it("returns a report a consumer reads programmatically, with no human text to scrape", async () => {
    const report = await run(conformantPeer);
    const round = JSON.parse(JSON.stringify(report)) as DifferentialReport;

    // Everything survives a JSON round trip: no Buffer, no Date, no class instance.
    expect(round).toEqual(report);
    for (const exchange of round.exchanges) {
      expect(typeof exchange.exchangeId).toBe("string");
      expect(typeof exchange.outcome).toBe("string");
      expect(typeof exchange.byteParity).toBe("string");
      expect(typeof exchange.correlation).toBe("string");
      expect(Array.isArray(exchange.warningCodes)).toBe(true);
      expect(typeof exchange.requestByteCount).toBe("number");
      expect(typeof exchange.responseByteCount).toBe("number");
      expect(typeof exchange.deadlineMs).toBe("number");
      expect(typeof exchange.elapsedMs).toBe("number");
    }
    expect(Date.parse(round.startedAt)).not.toBeNaN();
    expect(Date.parse(round.finishedAt)).not.toBeNaN();
  });

  it("sends exactly the canonical corpus bytes, framed canonically", async () => {
    const seen: Buffer[] = [];
    await run(
      peerThat((framed) => {
        seen.push(Buffer.from(framed));
        return encodeFrame(ackPayload(controlIdOf(payloadOf(framed))));
      }),
    );
    expect(seen).toHaveLength(CORPUS_SIZE);
    for (const [i, exchange] of CORPUS.entries()) {
      expect(seen[i]).toEqual(encodeFrame(exchange.payload));
    }
  });
});

// ---------------------------------------------------------------------------
// A deviating peer: named by its stable code, never an opaque error
// ---------------------------------------------------------------------------

describe("differential harness: a peer that deviates from the canonical block", () => {
  const deviations: readonly {
    readonly name: string;
    readonly code: string;
    readonly wire: (ack: Buffer) => Buffer;
  }[] = [
    {
      name: "omits the leading VT",
      code: "MLLP_MISSING_LEADING_VT",
      wire: (ack) => Buffer.concat([ack, Buffer.from([FS, CR])]),
    },
    {
      name: "ends at FS with no CR, then a stray byte",
      code: "MLLP_FS_WITHOUT_CR",
      wire: (ack) => Buffer.concat([Buffer.from([VT]), ack, Buffer.from([FS, 0x20])]),
    },
    {
      name: "terminates with LF instead of CR",
      code: "MLLP_LF_AFTER_FS",
      wire: (ack) => Buffer.concat([Buffer.from([VT]), ack, Buffer.from([FS, 0x0a])]),
    },
    {
      name: "prefixes the block with whitespace",
      code: "MLLP_LEADING_WHITESPACE",
      wire: (ack) => Buffer.concat([Buffer.from([0x20, 0x09]), encodeFrame(ack)]),
    },
  ];

  for (const { name, code, wire } of deviations) {
    it(`names it ${code} when the peer ${name}`, async () => {
      const report = await run(
        peerThat((framed) => wire(ackPayload(controlIdOf(payloadOf(framed))))),
      );

      const first = report.exchanges[0];
      expect(first?.outcome).toBe("answered");
      expect(first?.byteParity).toBe("deviation");
      expect(first?.warningCodes).toContain(code);
      // The deviation is located, and located only: a code and an offset.
      const deviation = first?.deviations.find((d) => d.code === code);
      expect(deviation).toBeDefined();
      expect(typeof deviation?.byteOffset).toBe("number");
      // Correlation is still reported: a framing deviation is not a correlation failure.
      expect(first?.correlation).toBe("match");
      expect(report.result).toBe("deviations-observed");
    });
  }

  it("names an oversized response MLLP_FRAME_TOO_LARGE and returns a report", async () => {
    const report = await run(
      peerThat(() => Buffer.concat([Buffer.from([VT]), Buffer.alloc(512, 0x41)])),
      { maxFrameSizeBytes: 64 },
    );

    const first = report.exchanges[0];
    expect(first?.outcome).toBe("undecodable-response");
    expect(first?.byteParity).toBe("deviation");
    expect(first?.correlation).toBe("not-observed");
    expect(first?.warningCodes).toContain("MLLP_FRAME_TOO_LARGE");
    expect(report.result).toBe("no-observation");
  });
});

// ---------------------------------------------------------------------------
// Correlation, told apart from parity
// ---------------------------------------------------------------------------

describe("differential harness: acknowledgement correlation", () => {
  it("reports a mis-correlated ACK as a correlation failure, named by the ACK-correlation code", async () => {
    const report = await run(peerThat(() => encodeFrame(ackPayload("NOT-THE-SENT-ID"))));

    const first = report.exchanges[0];
    expect(first?.outcome).toBe("answered");
    expect(first?.correlation).toBe("mismatch");
    expect(first?.warningCodes).toContain("MLLP_ACK_UNMATCHED_CONTROL_ID");
    // NOT a framing-parity failure: the block itself was canonical.
    expect(first?.byteParity).toBe("match");
    expect(first?.deviations.map((d) => d.code)).toEqual(["MLLP_ACK_UNMATCHED_CONTROL_ID"]);
  });

  it("reports an acknowledgement with no readable MSA-2 as absent, not as a mismatch", async () => {
    const noMsa = Buffer.from(
      "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
      "latin1",
    );
    const report = await run(peerThat(() => encodeFrame(noMsa)));

    const first = report.exchanges[0];
    expect(first?.correlation).toBe("absent");
    expect(first?.warningCodes).toContain("MLLP_ACK_UNMATCHED_CONTROL_ID");
    expect(first?.byteParity).toBe("match");
  });
});

// ---------------------------------------------------------------------------
// Configuration: absent, and present-but-unusable, are different things
// ---------------------------------------------------------------------------

describe("differential harness: peer configuration", () => {
  for (const absent of [undefined, "", "   "]) {
    it(`skips cleanly when the peer address is ${JSON.stringify(absent)}`, async () => {
      const report = await runDifferential({ peer: absent, connect: conformantPeer });
      expect(report.result).toBe("skipped");
      expect(report.skipReason).toBe("no-peer-configured");
      expect(report.exchanges).toEqual([]);
      expect(report.exchangesAttempted).toBe(0);
      expect(report.peer).toBeUndefined();
    });
  }

  const unusable = [
    "nonsense",
    "127.0.0.1:",
    ":2575",
    "127.0.0.1:abc",
    "127.0.0.1:0",
    "127.0.0.1:70000",
    "127.0.0.1:0x2575",
    "127.0.0.1: 2575",
    "127.0.0.1:-1",
  ];
  for (const value of unusable) {
    it(`refuses the run by name for ${JSON.stringify(value)}, and does not skip`, async () => {
      let thrown: unknown;
      try {
        await runDifferential({ peer: value, connect: conformantPeer });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(MllpDifferentialConfigurationError);
      const err = thrown as MllpDifferentialConfigurationError;
      expect(err.code).toBe("MLLP_DIFF_PEER_UNPARSEABLE");
      // The offending value is identified, so the operator can see which setting is wrong.
      expect(err.value).toBe(value);
      expect(err.message).toContain(JSON.stringify(value));
    });
  }

  it("resolves an IPv6 literal, bracketed or bare", async () => {
    const bracketed = await runDifferential({
      peer: "[::1]:2575",
      connect: conformantPeer,
      deadlineMs: FAST_DEADLINE_MS,
    });
    expect(bracketed.peer).toEqual({ host: "::1", port: 2575 });
    const bare = await runDifferential({
      peer: "::1:2575",
      connect: conformantPeer,
      deadlineMs: FAST_DEADLINE_MS,
    });
    expect(bare.peer).toEqual({ host: "::1", port: 2575 });
  });
});

// ---------------------------------------------------------------------------
// Connection failures, silence, and a run that observed nothing
// ---------------------------------------------------------------------------

describe("differential harness: failure paths", () => {
  it("records a refused connection under its own outcome and still returns a report", async () => {
    const report = await run(() => {
      const [clientEnd] = InMemoryTransport.pair();
      setTimeout(() => {
        const err = new Error("connect ECONNREFUSED 127.0.0.1:2575");
        Object.defineProperty(err, "code", { value: "ECONNREFUSED", enumerable: true });
        clientEnd.destroy(err);
      }, 0);
      return clientEnd;
    });

    expect(report.exchanges).toHaveLength(CORPUS_SIZE);
    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("connection-refused");
      expect(exchange.byteParity).toBe("not-observed");
      expect(exchange.correlation).toBe("not-observed");
    }
    expect(report.result).toBe("no-observation");
  });

  it("records a connection dropped part way through the exchange", async () => {
    const report = await run(() => {
      const [clientEnd, peerEnd] = InMemoryTransport.pair();
      peerEnd.onData(() => {
        clientEnd.destroy(new Error("read ECONNRESET"));
      });
      setTimeout(() => {
        clientEnd.simulateConnect();
      }, 0);
      return clientEnd;
    });

    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("connection-dropped");
    }
    expect(report.result).toBe("no-observation");
  });

  it("records a connection that closes before it is established as a failure, not a drop", async () => {
    const report = await run(() => {
      const [clientEnd] = InMemoryTransport.pair();
      setTimeout(() => {
        clientEnd.close();
      }, 0);
      return clientEnd;
    });
    for (const exchange of report.exchanges) expect(exchange.outcome).toBe("connection-failed");
  });

  it("records a connection factory that throws as a failure rather than propagating", async () => {
    const report = await run(() => {
      throw new Error("no route to host");
    });
    for (const exchange of report.exchanges) expect(exchange.outcome).toBe("connection-failed");
    expect(report.result).toBe("no-observation");
  });

  it("records a silent peer as unanswered, states the deadline, and reports no parity", async () => {
    const report = await run(
      peerThat(() => null),
      { deadlineMs: 40 },
    );

    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("unanswered");
      expect(exchange.deadlineMs).toBe(40);
      expect(exchange.byteParity).toBe("not-observed");
      expect(exchange.correlation).toBe("not-observed");
      expect(exchange.warningCodes).toEqual([]);
    }
    expect(report.deadlineMs).toBe(40);
    expect(report.result).toBe("no-observation");
  });

  it("never presents a run with nothing answered as a pass", async () => {
    const report = await run(
      peerThat(() => null),
      { deadlineMs: 40 },
    );
    expect(report.exchangesAnswered).toBe(0);
    expect(report.result).toBe("no-observation");
    expect(report.result).not.toBe("parity-observed");
    // A report still comes back, whole, rather than an error being thrown.
    expect(report.exchanges).toHaveLength(CORPUS_SIZE);
  });

  it("reports a partly answered run as deviations observed, not as parity", async () => {
    let first = true;
    const report = await run(
      peerThat((framed) => {
        if (first) {
          first = false;
          return encodeFrame(ackPayload(controlIdOf(payloadOf(framed))));
        }
        return null;
      }),
      { deadlineMs: 40 },
    );

    expect(report.exchangesAnswered).toBe(1);
    expect(report.result).toBe("deviations-observed");
  });

  it("rejects with the signal's own reason when the run is aborted before it starts", async () => {
    const controller = new AbortController();
    const reason = new Error("caller changed its mind");
    controller.abort(reason);
    await expect(
      runDifferential({
        peer: "127.0.0.1:2575",
        connect: conformantPeer,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("rejects with the signal's own reason when the run is aborted mid-exchange", async () => {
    const controller = new AbortController();
    const reason = new Error("caller ran out of patience");
    const pending = runDifferential({
      peer: "127.0.0.1:2575",
      connect: peerThat(() => null),
      deadlineMs: 5_000,
      signal: controller.signal,
    });
    setTimeout(() => {
      controller.abort(reason);
    }, 20);
    // The exchange is waiting on its deadline, so the abort is what ends it, well before
    // the five seconds the deadline would otherwise cost.
    await expect(pending).rejects.toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// A delivered payload that carries a framing byte
// ---------------------------------------------------------------------------

describe("differential harness: a payload carrying a framing byte", () => {
  it("names it MLLP_PAYLOAD_CONTAINS_FS rather than throwing out of the encoder", async () => {
    // Reachable exactly as this package's own control-ID reader documents: with no leading
    // `VT`, an `FS` byte is neither `VT` nor whitespace, so it becomes payload byte 0 and
    // the DELIVERED payload carries a framing byte. Re-encoding that payload canonically is
    // how parity is judged, and the strict encoder throws on it, so the harness encodes
    // tolerantly and names the byte instead.
    const report = await run(
      peerThat((framed) =>
        Buffer.concat([
          Buffer.from([FS]),
          ackPayload(controlIdOf(payloadOf(framed))),
          Buffer.from([FS, CR]),
        ]),
      ),
    );

    const first = report.exchanges[0];
    expect(first?.outcome).toBe("answered");
    expect(first?.byteParity).toBe("deviation");
    expect(first?.warningCodes).toContain("MLLP_MISSING_LEADING_VT");
    expect(first?.warningCodes).toContain("MLLP_PAYLOAD_CONTAINS_FS");
    // Still located by offset, every one of them.
    for (const deviation of first?.deviations ?? []) {
      expect(typeof deviation.byteOffset).toBe("number");
    }
    // And correlation is reported honestly as ABSENT rather than as a mismatch: the framing
    // byte sits where the segment id would be, so the delivered payload has no readable MSH
    // at all and there is no acknowledged control ID to compare. Reporting a mismatch here
    // would claim the peer echoed the wrong id when it echoed nothing this reader could find.
    expect(first?.correlation).toBe("absent");
    expect(first?.warningCodes).toContain("MLLP_ACK_UNMATCHED_CONTROL_ID");
  });
});

// ---------------------------------------------------------------------------
// One socket-level smoke case, so the default TCP connection is exercised too
// ---------------------------------------------------------------------------

describe("differential harness: over a real loopback socket", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const s = server;
    server = undefined;
    if (s === undefined) return;
    await new Promise<void>((resolve) => {
      s.close(() => {
        resolve();
      });
    });
  });

  it("runs the canonical exchanges against a listener and reports parity and correlation", async () => {
    server = createServer((socket: Socket) => {
      socket.on("data", (chunk: Buffer) => {
        socket.write(encodeFrame(ackPayload(controlIdOf(payloadOf(chunk)))));
      });
      socket.on("error", () => {
        /* the harness destroys its end after each exchange */
      });
    });
    const port = await new Promise<number>((resolve) => {
      server?.listen(0, "127.0.0.1", () => {
        const address = server?.address();
        resolve(typeof address === "object" && address !== null ? address.port : 0);
      });
    });

    const report = await runDifferential({ peer: `127.0.0.1:${String(port)}`, deadlineMs: 5_000 });

    expect(report.exchangesAnswered).toBe(CORPUS_SIZE);
    for (const exchange of report.exchanges) {
      expect(exchange.outcome).toBe("answered");
      expect(exchange.byteParity).toBe("match");
      expect(exchange.correlation).toBe("match");
    }
    expect(report.result).toBe("parity-observed");
  });
});
