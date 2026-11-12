/**
 * A FIFO client settles the oldest pending send on whatever frame arrives next. When that frame
 * carries no readable MSA-1 (a lone Release 2 style `0x06` or `0x15` byte, an `MSH` with no `MSA`,
 * or an MSA-1 outside HL7 Table 0008), the peer has not acknowledged the message in HL7 terms.
 *
 * By default the send still resolves, as it always has, and the client says so with the warning
 * `MLLP_ACK_FIFO_MSA1_UNREADABLE`. With `fifoUnreadableAck: "reject"` the send rejects with
 * `MllpUnreadableAckError` instead. Correlation by control ID is untouched by either.
 *
 * Every payload here is synthetic.
 */

import { describe, it, expect } from "vitest";
import { createClient, type ClientOptions, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import { MllpUnreadableAckError } from "../../src/client/error.js";
import { ackModeDiagnosticMessage } from "../../src/internal/ack-mode-diagnostics.js";
import { MllpUnreadableAckError as RootExport } from "../../src/index.js";
import {
  Correlator,
  type AckModeWarningContext,
  type PendingAck,
} from "../../src/client/correlator.js";

interface Warning {
  code: string;
  message: string;
  msa1Bytes: number | null;
  ackCode: string | null;
  controlIdBytes: number | null;
  byteOffset: number;
  elapsedSinceSendMs: number;
}

interface Harness {
  client: MllpClient;
  fromPeer: (payload: Buffer) => void;
  warnings: Warning[];
  acks: unknown[];
}

function harness(extra: Partial<ClientOptions> = {}): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const client = createClient({ host: "127.0.0.1", port: 0, ackTimeoutMs: 1_000, ...extra });
  const warnings: Warning[] = [];
  const acks: unknown[] = [];
  client.on("warning", (w: Warning) => warnings.push(w));
  client.on("ack", (e: unknown) => acks.push(e));
  client.on("error", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, fromPeer: (payload) => b.write(encodeFrame(payload)), warnings, acks };
}

const MESSAGE = Buffer.from(
  "MSH|^~\\&|SYNTH_APP|SYNTH_FAC|RECV|RFAC|20260501101010||ADT^A01|SYNTH0001|P|2.5\r",
  "ascii",
);
const ACK_HEADER =
  "MSH|^~\\&|RECV|RFAC|SYNTH_APP|SYNTH_FAC|20260501101011||ACK^A01|SYNTHACK1|P|2.5\r";
const ack = (msa: string): Buffer => Buffer.from(`${ACK_HEADER}${msa}`, "ascii");

const LONE_ACK_BYTE = Buffer.from([0x06]);
const LONE_NAK_BYTE = Buffer.from([0x15]);
const NO_MSA = Buffer.from(ACK_HEADER, "ascii");

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("FIFO, by default: a frame with no readable MSA-1 settles the send and warns", () => {
  const cases: Array<[string, Buffer, number]> = [
    ["a lone 0x06 byte", LONE_ACK_BYTE, 0],
    ["a lone 0x15 byte", LONE_NAK_BYTE, 0],
    ["an MSH with no MSA", NO_MSA, 0],
    ["an empty MSA-1", ack("MSA||SYNTH0001\r"), 0],
    ["an MSA-1 outside Table 0008", ack("MSA|ZZZ|SYNTH0001\r"), 3],
  ];
  for (const [label, frame, msa1Bytes] of cases) {
    it(`${label}: resolves with the frame and raises MLLP_ACK_FIFO_MSA1_UNREADABLE`, async () => {
      const { client, fromPeer, warnings, acks } = harness();
      const sent = client.send(MESSAGE);
      fromPeer(frame);
      expect(Buffer.compare(await sent, frame)).toBe(0);
      expect(acks).toHaveLength(1);
      expect(warnings).toHaveLength(1);
      const w = warnings[0];
      expect(w?.code).toBe("MLLP_ACK_FIFO_MSA1_UNREADABLE");
      expect(w?.message).toBe(ackModeDiagnosticMessage("MLLP_ACK_FIFO_MSA1_UNREADABLE"));
      expect(w?.msa1Bytes).toBe(msa1Bytes);
      expect(w?.ackCode).toBeNull();
      expect(w?.controlIdBytes).toBeNull();
      expect(w?.byteOffset).toBe(0);
      expect(w?.elapsedSinceSendMs).toBeGreaterThanOrEqual(0);
      expect(Object.isFrozen(w)).toBe(true);
      await client.close();
    });
  }

  it("the warning names the second frame's stream offset", async () => {
    const { client, fromPeer, warnings } = harness();
    const first = client.send(MESSAGE);
    const second = client.send(MESSAGE);
    const readable = ack("MSA|AA|SYNTH0001\r");
    fromPeer(readable);
    fromPeer(LONE_ACK_BYTE);
    await first;
    await second;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.byteOffset).toBe(encodeFrame(readable).length);
    await client.close();
  });

  it("the warning's text is fixed and carries no byte of the frame", () => {
    expect(ackModeDiagnosticMessage("MLLP_ACK_FIFO_MSA1_UNREADABLE")).toBe(
      "A client correlating acknowledgements in order settled its oldest pending send on a frame " +
        "with no readable MSA-1 acknowledgement code, so the peer has not acknowledged that " +
        "message in HL7 terms. The send resolved with the frame, or rejected when " +
        "fifoUnreadableAck is 'reject'. Set correlateByControlId to match acknowledgements by " +
        "MSA-2 instead. Field values are withheld; msa1Bytes gives the field's length.",
    );
  });

  for (const code of ["AA", "AE", "AR", "CA", "CE", "CR"]) {
    it(`a readable ${code} settles the send with no warning`, async () => {
      const { client, fromPeer, warnings } = harness();
      const sent = client.send(MESSAGE);
      fromPeer(ack(`MSA|${code}|SYNTH0001\r`));
      expect((await sent).toString("latin1")).toContain(`MSA|${code}|`);
      expect(warnings).toEqual([]);
      await client.close();
    });
  }

  it('"warn" is the same as leaving the option out', async () => {
    const { client, fromPeer, warnings } = harness({ fifoUnreadableAck: "warn" });
    const sent = client.send(MESSAGE);
    fromPeer(LONE_NAK_BYTE);
    expect([...(await sent)]).toEqual([0x15]);
    expect(warnings.map((w) => w.code)).toEqual(["MLLP_ACK_FIFO_MSA1_UNREADABLE"]);
    await client.close();
  });
});

describe('FIFO with fifoUnreadableAck: "reject"', () => {
  it("rejects the send with MllpUnreadableAckError and raises the same warning", async () => {
    const { client, fromPeer, warnings, acks } = harness({ fifoUnreadableAck: "reject" });
    const sent = client.send(MESSAGE);
    // Let the clock move between the flush and the frame, so elapsedMs has something to measure.
    await new Promise((resolve) => setTimeout(resolve, 25));
    fromPeer(LONE_ACK_BYTE);
    const err: unknown = await sent.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MllpUnreadableAckError);
    expect(err).toBeInstanceOf(RootExport);
    const e = err as MllpUnreadableAckError;
    expect(e.name).toBe("MllpUnreadableAckError");
    // The constructor frame is captured away, as for every other error of ours.
    expect(e.stack).toBeDefined();
    expect(e.stack).not.toMatch(/at new MllpUnreadableAckError/);
    expect(e.msa1Bytes).toBe(0);
    expect(e.byteOffset).toBe(0);
    expect(e.elapsedMs).toBeGreaterThanOrEqual(20);
    expect(e.elapsedMs).toBeLessThan(60_000);
    expect(e.message).toBe(
      "the frame that settled this send in order carried no readable MSA-1, so the peer has " +
        "not acknowledged it in HL7 terms",
    );
    expect(acks).toEqual([]);
    expect(warnings.map((w) => w.code)).toEqual(["MLLP_ACK_FIFO_MSA1_UNREADABLE"]);
    expect(client.getStats().ackedTotal).toBe(0);
    expect(client.getStats().queueDepth).toBe(0);
    await client.close();
  });

  it("an MSA-1 outside Table 0008 reports its byte length", async () => {
    const { client, fromPeer } = harness({ fifoUnreadableAck: "reject" });
    const sent = client.send(MESSAGE);
    fromPeer(ack("MSA|ZZZZ|SYNTH0001\r"));
    await expect(sent).rejects.toMatchObject({ msa1Bytes: 4 });
    await client.close();
  });

  it("consumes the frame in order: the next send settles on the next frame", async () => {
    const { client, fromPeer } = harness({ fifoUnreadableAck: "reject" });
    const first = client.send(MESSAGE);
    const second = client.send(MESSAGE);
    const firstOutcome = first.then(
      () => "resolved",
      (e: unknown) => (e instanceof MllpUnreadableAckError ? "unreadable" : "other"),
    );
    fromPeer(LONE_NAK_BYTE);
    fromPeer(ack("MSA|AA|SYNTH0001\r"));
    expect(await firstOutcome).toBe("unreadable");
    expect((await second).toString("latin1")).toContain("MSA|AA|");
    await client.close();
  });

  it("emits drain once the rejected send frees its slot", async () => {
    const { client, fromPeer } = harness({ fifoUnreadableAck: "reject", highWaterMark: 1 });
    const drains: unknown[] = [];
    client.on("drain", (e: unknown) => drains.push(e));
    const sent = client.send(MESSAGE).catch(() => undefined);
    fromPeer(LONE_ACK_BYTE);
    await sent;
    expect(drains).toHaveLength(1);
    await client.close();
  });

  it("a readable acknowledgment still resolves", async () => {
    const { client, fromPeer, warnings } = harness({ fifoUnreadableAck: "reject" });
    const sent = client.send(MESSAGE);
    fromPeer(ack("MSA|AE|SYNTH0001\r"));
    expect((await sent).toString("latin1")).toContain("MSA|AE|");
    expect(warnings).toEqual([]);
    await client.close();
  });
});

describe("correlation by control ID is unchanged", () => {
  for (const setting of [undefined, "warn", "reject"] as const) {
    it(`fifoUnreadableAck ${String(setting)}: a lone byte is unmatched and the send waits`, async () => {
      const { client, fromPeer, warnings } = harness({
        correlateByControlId: true,
        ...(setting === undefined ? {} : { fifoUnreadableAck: setting }),
      });
      let settled = false;
      const sent = client.send(MESSAGE).then((a) => {
        settled = true;
        return a;
      });
      fromPeer(LONE_ACK_BYTE);
      await tick();
      expect(settled).toBe(false);
      expect(warnings).toEqual([]);
      fromPeer(ack("MSA|AA|SYNTH0001\r"));
      expect((await sent).toString("latin1")).toContain("MSA|AA|SYNTH0001");
      await client.close();
    });
  }

  it("a correlated acknowledgment with an unreadable MSA-1 still resolves, unwarned", async () => {
    const { client, fromPeer, warnings } = harness({
      correlateByControlId: true,
      fifoUnreadableAck: "reject",
    });
    const sent = client.send(MESSAGE);
    fromPeer(ack("MSA|ZZZ|SYNTH0001\r"));
    expect((await sent).toString("latin1")).toContain("MSA|ZZZ|");
    expect(warnings).toEqual([]);
    await client.close();
  });
});

describe("the option is checked at construction", () => {
  for (const bad of ["Reject", "", true, 1, null]) {
    it(`refuses ${JSON.stringify(bad)}`, () => {
      expect(() =>
        createClient({
          host: "127.0.0.1",
          port: 0,
          fifoUnreadableAck: bad as unknown as "warn",
        }),
      ).toThrow(
        new TypeError(
          "ClientOptions.fifoUnreadableAck must be 'warn' or 'reject', or left unset for 'warn'",
        ),
      );
    });
  }
});

describe("the correlator, FIFO mode", () => {
  function correlator(
    onUnreadableAck?: (entry: PendingAck, msa1: number, at: number, elapsed: number) => void,
  ): {
    c: Correlator;
    warnings: Array<{ code: string; ctx: AckModeWarningContext }>;
  } {
    const warnings: Array<{ code: string; ctx: AckModeWarningContext }> = [];
    let clock = 1_000;
    const c = new Correlator({
      mode: "fifo",
      onWarning: () => undefined,
      onTimeout: () => undefined,
      onAckModeWarning: (code, ctx) => warnings.push({ code, ctx }),
      ...(onUnreadableAck === undefined ? {} : { onUnreadableAck }),
      now: () => (clock += 5),
    });
    return { c, warnings };
  }

  it("reports an elapsed time of 0 for a send never flushed", () => {
    const { c, warnings } = correlator();
    c.enqueue(
      MESSAGE,
      null,
      () => undefined,
      () => undefined,
    );
    const matched = c.matchAck(LONE_ACK_BYTE, null, 42);
    expect(matched).not.toBeNull();
    expect(warnings).toEqual([
      {
        code: "MLLP_ACK_FIFO_MSA1_UNREADABLE",
        ctx: {
          msa1Bytes: 0,
          ackCode: null,
          controlIdBytes: null,
          byteOffset: 42,
          elapsedSinceSendMs: 0,
        },
      },
    ]);
  });

  it("measures the elapsed time from the flush", () => {
    const { c, warnings } = correlator();
    const key = c.enqueue(
      MESSAGE,
      null,
      () => undefined,
      () => undefined,
    );
    expect(key).not.toBeNull();
    c.markFlushed(key as number, 1_000);
    c.matchAck(NO_MSA, null, 0);
    // The injected clock reads 1_005 for the eviction sweep, then 1_010 for the warning.
    expect(warnings[0]?.ctx.elapsedSinceSendMs).toBe(10);
  });

  it("hands the entry to onUnreadableAck, returns null, and keeps the counters straight", () => {
    const handed: Array<[PendingAck, number, number, number]> = [];
    const { c, warnings } = correlator((entry, msa1, at, elapsed) =>
      handed.push([entry, msa1, at, elapsed]),
    );
    const key = c.enqueue(
      MESSAGE,
      null,
      () => undefined,
      () => undefined,
    );
    c.markFlushed(key as number, 1_000);
    expect(c.getStats().inFlight).toBe(1);
    expect(c.matchAck(ack("MSA|ZZ|SYNTH0001\r"), null, 9)).toBeNull();
    expect(handed).toHaveLength(1);
    expect(handed[0]?.[0].key).toBe(key);
    expect(handed[0]?.[1]).toBe(2);
    expect(handed[0]?.[2]).toBe(9);
    // The same elapsed time the warning carries: the clock reads 1_010 when it is taken.
    expect(handed[0]?.[3]).toBe(10);
    expect(warnings[0]?.ctx.elapsedSinceSendMs).toBe(10);
    expect(c.getStats()).toMatchObject({ size: 0, inFlight: 0, queueBytes: 0 });
  });

  it("returns a readable acknowledgment's entry without calling onUnreadableAck", () => {
    const handed: unknown[] = [];
    const { c, warnings } = correlator(() => handed.push(1));
    c.enqueue(
      MESSAGE,
      null,
      () => undefined,
      () => undefined,
    );
    expect(c.matchAck(ack("MSA|AA|SYNTH0001\r"))).not.toBeNull();
    expect(handed).toEqual([]);
    expect(warnings).toEqual([]);
  });
});
