/**
 * The two waits an enhanced-mode send can enter, and the typed errors that end them.
 *
 * The first wait is this package's own acknowledgement timeout, unchanged: same duration,
 * same default, same error. The second starts when the accept acknowledgement arrives, is
 * measured from that moment, and ends either with the application acknowledgement or with
 * an error that names the commit disposition already received. Both are finite; a send that
 * could wait forever is a defect.
 *
 * Timers are faked so nothing here waits on a clock, and every input-derived number in an
 * error is deterministic.
 *
 * Fixtures are synthetic MSH/MSA headers only. No patient data appears anywhere here.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import { MllpConnectionError } from "../../src/connection/index.js";
import { MllpApplicationAckError, MllpTimeoutError } from "../../src/client/error.js";

const ACK_TIMEOUT_MS = 10_000;

interface Harness {
  client: MllpClient;
  conn: Connection;
  local: InMemoryTransport;
  peerAck: (payload: Buffer) => void;
}

function harness(opts?: {
  ackTimeoutMs?: number;
  applicationAckTimeoutMs?: number;
  autoReconnect?: boolean;
}): Harness {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: opts?.ackTimeoutMs ?? ACK_TIMEOUT_MS,
    correlateByControlId: true,
    ...(opts?.applicationAckTimeoutMs !== undefined
      ? { applicationAckTimeoutMs: opts.applicationAckTimeoutMs }
      : {}),
    ...(opts?.autoReconnect === true
      ? { autoReconnect: true, retryStrategy: (): null => null }
      : {}),
  });
  client.on("warning", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, conn, local, peerAck: (payload) => peer.write(encodeFrame(payload)) };
}

function message(controlId: string, msh15: string, msh16: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|${controlId}|P|2.5.1|||${msh15}|${msh16}\r`,
    "latin1",
  );
}

function ack(msa1: string, acked: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|R|F2|S|F|20260101000000||ACK^A01|ACK_${acked}|P|2.5.1\r` + `MSA|${msa1}|${acked}\r`,
    "latin1",
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the first wait is this package's own acknowledgement timeout, unchanged", () => {
  it("an enhanced-mode send with no acknowledgement at all fails with the same error as before", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS + 1_000);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpTimeoutError);
    expect((err as MllpTimeoutError).name).toBe("MllpTimeoutError");
    h.client.destroy();
  });

  it("an accept acknowledgement stops it, so it cannot expire against an answered send", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);

    // Commit at t = 9s, one second inside the first window.
    await vi.advanceTimersByTimeAsync(9_000);
    h.peerAck(ack("CA", "M1"));

    // t = 10s: the first window would have expired here. It has been stopped.
    await vi.advanceTimersByTimeAsync(1_500);
    let settled = false;
    void sent.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // The application acknowledgement at t = 12s settles the send, successfully.
    await vi.advanceTimersByTimeAsync(1_500);
    h.peerAck(ack("AA", "M1"));
    const resolved = await caught;
    expect(Buffer.isBuffer(resolved)).toBe(true);
    expect((resolved as Buffer).toString("latin1")).toContain("MSA|AA|M1");
    h.client.destroy();
  });
});

describe("the second wait is measured from the accept acknowledgement", () => {
  it("the same send with no application acknowledgement fails at 19s, not at 10s", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(9_000);
    h.peerAck(ack("CA", "M1"));

    // Well past where the FIRST window would have fired, and still pending.
    await vi.advanceTimersByTimeAsync(8_000); // t = 17s
    let settled = false;
    void sent.then(
      () => (settled = true),
      () => (settled = true),
    );
    await Promise.resolve();
    expect(settled).toBe(false);

    // t = 19s: nine seconds of commit plus ten of the second window.
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpApplicationAckError);
    const failure = err as MllpApplicationAckError;
    expect(failure.reason).toBe("timeout");
    expect(failure.commitCode).toBe("CA");
    expect(failure.elapsedMs).toBeGreaterThanOrEqual(ACK_TIMEOUT_MS);
    h.client.destroy();
  });

  it("its error is distinguishable from the first wait's by a stable identifier", async () => {
    const h = harness();
    const first = h.client.send(message("A", "AL", "AL"));
    const firstCaught = first.catch((err: unknown) => err);
    const second = h.client.send(message("B", "AL", "AL"));
    const secondCaught = second.catch((err: unknown) => err);
    h.peerAck(ack("CA", "B"));

    await vi.advanceTimersByTimeAsync(ACK_TIMEOUT_MS * 3);
    const a = await firstCaught;
    const b = await secondCaught;
    expect((a as Error).name).toBe("MllpTimeoutError");
    expect((b as Error).name).toBe("MllpApplicationAckError");
    expect(a).not.toBeInstanceOf(MllpApplicationAckError);
    expect(b).not.toBeInstanceOf(MllpTimeoutError);
    h.client.destroy();
  });

  it("it defaults to the acknowledgement timeout in force and can be overridden globally", async () => {
    const h = harness({ ackTimeoutMs: 10_000, applicationAckTimeoutMs: 2_000 });
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await vi.advanceTimersByTimeAsync(2_500);
    expect(await caught).toBeInstanceOf(MllpApplicationAckError);
    h.client.destroy();
  });

  it("it can be overridden per send", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const sent = h.client.send(message("M1", "AL", "AL"), { applicationAckTimeoutMs: 1_000 });
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(await caught).toBeInstanceOf(MllpApplicationAckError);
    h.client.destroy();
  });

  it("a repeat commit does not restart it", async () => {
    const h = harness({ ackTimeoutMs: 10_000, applicationAckTimeoutMs: 4_000 });
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await vi.advanceTimersByTimeAsync(3_000);
    h.peerAck(ack("CA", "M1")); // a repeat, three seconds into a four-second window
    await vi.advanceTimersByTimeAsync(1_500);
    // If the repeat had restarted the window the send would still be pending here.
    expect(await caught).toBeInstanceOf(MllpApplicationAckError);
    h.client.destroy();
  });

  it("a conditional application condition that is never met ends here", async () => {
    // MSH-16 `SU` on a peer whose application did not succeed: no second acknowledgement
    // is coming, and the sender cannot know that in advance.
    const h = harness({ applicationAckTimeoutMs: 3_000 });
    const sent = h.client.send(message("M1", "AL", "SU"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await vi.advanceTimersByTimeAsync(3_500);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpApplicationAckError);
    expect((err as MllpApplicationAckError).commitCode).toBe("CA");
    h.client.destroy();
  });

  it("no send waits forever: the second window is finite even at its default", async () => {
    const h = harness({ ackTimeoutMs: 1_000 });
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await caught).toBeInstanceOf(MllpApplicationAckError);
    h.client.destroy();
  });
});

describe("a link lost while the send is waiting on its application acknowledgement", () => {
  it("fails the send with an error carrying the commit disposition, on close()", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    await h.client.close();
    const err = await caught;
    expect(err).toBeInstanceOf(MllpApplicationAckError);
    const failure = err as MllpApplicationAckError;
    expect(failure.reason).toBe("connection-lost");
    expect(failure.commitCode).toBe("CA");
  });

  it("fails it on a transport drop rather than holding it for a resend", async () => {
    const h = harness({ autoReconnect: true });
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", "M1"));
    // The peer already holds this message. Re-sending it would commit it twice.
    h.local.destroy(Object.assign(new Error("peer reset"), { code: "ECONNRESET" }));
    await vi.advanceTimersByTimeAsync(10);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpApplicationAckError);
    expect((err as MllpApplicationAckError).reason).toBe("connection-lost");
    h.client.destroy();
  });

  it("a send with no commit yet still gets the ordinary connection error", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    await h.client.close();
    const err = await caught;
    expect(err).toBeInstanceOf(MllpConnectionError);
    expect(err).not.toBeInstanceOf(MllpApplicationAckError);
  });

  it("it is never reported as successful", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    let resolvedWith: unknown = null;
    const caught = sent.then(
      (v) => {
        resolvedWith = v;
        return "resolved";
      },
      () => "rejected",
    );
    h.peerAck(ack("CA", "M1"));
    await h.client.close();
    expect(await caught).toBe("rejected");
    expect(resolvedWith).toBeNull();
  });
});

describe("the errors carry no payload content", () => {
  it("neither the timeout nor the connection-lost error names the control ID", async () => {
    const marker = "SECRETCONTROL";
    const h = harness({ applicationAckTimeoutMs: 1_000 });
    const sent = h.client.send(message(marker, "AL", "AL"));
    const caught = sent.catch((err: unknown) => err);
    h.peerAck(ack("CA", marker));
    await vi.advanceTimersByTimeAsync(2_000);
    const err = (await caught) as MllpApplicationAckError;
    expect(err.messageControlIdBytes).toBe(marker.length);
    expect(err.message).not.toContain(marker);
    expect(err.stack ?? "").not.toContain(marker);
    expect(JSON.stringify({ ...err })).not.toContain(marker);
    h.client.destroy();
  });
});
