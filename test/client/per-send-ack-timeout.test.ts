/**
 * The per-send `ackTimeoutMs` bounds that send's own acknowledgement wait.
 *
 * `send(payload, { ackTimeoutMs })` used to bound only the wait for queue room under
 * `onBackpressure: "wait"`: the acknowledgement wait itself always ran on the client-wide
 * value, so a caller who asked one send to give up after a second waited the client's 30.
 * These cases pin the option to what its name says, in both directions (shorter and longer
 * than the client-wide value) and in both correlation modes, and pin that a send without it
 * behaves exactly as before.
 *
 * Timers are faked so nothing here waits on a clock. Fixtures are synthetic headers only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import { MllpTimeoutError } from "../../src/client/error.js";

interface Harness {
  client: MllpClient;
  peer: InMemoryTransport;
  peerAck: (payload: Buffer) => void;
}

function harness(opts: { ackTimeoutMs: number; correlateByControlId?: boolean }): Harness {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: opts.ackTimeoutMs,
    correlateByControlId: opts.correlateByControlId === true,
  });
  client.on("warning", () => undefined);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return { client, peer, peerAck: (payload) => peer.write(encodeFrame(payload)) };
}

function message(controlId: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|SYNTH|FAC|RCV|FAC2|20260101000000||ADT^A01|${controlId}|P|2.5.1\r`,
    "latin1",
  );
}

function ack(acked: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|RCV|FAC2|SYNTH|FAC|20260101000000||ACK^A01|ACK_${acked}|P|2.5.1\r` +
      `MSA|AA|${acked}\r`,
    "latin1",
  );
}

/** Whether `p` has settled, read after the microtask queue drains. */
async function isSettled(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void p.then(
    () => (settled = true),
    () => (settled = true),
  );
  await Promise.resolve();
  await Promise.resolve();
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-21T00:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("send({ ackTimeoutMs }) bounds that send's acknowledgement wait", () => {
  it("a shorter per-send value ends the wait at that value, not the client's", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 1_000 });
    const caught = sent.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(999);
    expect(await isSettled(sent)).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpTimeoutError);
    expect((err as MllpTimeoutError).elapsedMs).toBe(1_000);
    h.client.destroy();
  });

  it("a longer per-send value keeps the send waiting past the client's value", async () => {
    const h = harness({ ackTimeoutMs: 1_000 });
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 5_000 });
    const caught = sent.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(4_000);
    expect(await isSettled(sent)).toBe(false);

    await vi.advanceTimersByTimeAsync(1_250);
    const err = await caught;
    expect(err).toBeInstanceOf(MllpTimeoutError);
    expect((err as MllpTimeoutError).elapsedMs).toBeGreaterThanOrEqual(5_000);
    expect((err as MllpTimeoutError).elapsedMs).toBeLessThan(5_250);
    h.client.destroy();
  });

  it("an acknowledgement inside a longer per-send window resolves the send", async () => {
    const h = harness({ ackTimeoutMs: 1_000 });
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 5_000 });

    await vi.advanceTimersByTimeAsync(3_000);
    h.peerAck(ack("M1"));
    const resolved = await sent;
    expect(resolved.toString("latin1")).toContain("MSA|AA|M1");
    h.client.destroy();
  });

  it("applies in control ID mode too", async () => {
    const h = harness({ ackTimeoutMs: 10_000, correlateByControlId: true });
    const short = h.client.send(message("M1"), { ackTimeoutMs: 500 });
    const plain = h.client.send(message("M2"));
    const shortCaught = short.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(500);
    const err = await shortCaught;
    expect(err).toBeInstanceOf(MllpTimeoutError);
    expect((err as MllpTimeoutError).elapsedMs).toBe(500);
    // The send that set nothing still runs on the client's value.
    expect(await isSettled(plain)).toBe(false);

    h.peerAck(ack("M2"));
    expect((await plain).toString("latin1")).toContain("MSA|AA|M2");
    h.client.destroy();
  });

  it("each send keeps its own window when several are in flight", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const first = h.client.send(message("M1"), { ackTimeoutMs: 3_000 });
    const second = h.client.send(message("M2"), { ackTimeoutMs: 1_000 });
    const firstCaught = first.catch((err: unknown) => err);
    const secondCaught = second.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(await secondCaught).toBeInstanceOf(MllpTimeoutError);
    expect(await isSettled(first)).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(await firstCaught).toBeInstanceOf(MllpTimeoutError);
    h.client.destroy();
  });

  it("a send without it still runs on the client's value", async () => {
    const h = harness({ ackTimeoutMs: 2_000 });
    const sent = h.client.send(message("M1"));
    const caught = sent.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(1_900);
    expect(await isSettled(sent)).toBe(false);

    await vi.advanceTimersByTimeAsync(600);
    expect(await caught).toBeInstanceOf(MllpTimeoutError);
    h.client.destroy();
  });

  it("an answered send leaves no timer of its own behind", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const before = vi.getTimerCount();
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 1_000 });
    h.peerAck(ack("M1"));
    await sent;
    expect(vi.getTimerCount()).toBe(before);
    h.client.destroy();
  });

  it("an aborted send leaves no timer of its own behind", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const before = vi.getTimerCount();
    const ac = new AbortController();
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 1_000, signal: ac.signal });
    const caught = sent.catch((err: unknown) => err);
    ac.abort();
    expect(await caught).toMatchObject({ name: "AbortError" });
    expect(vi.getTimerCount()).toBe(before);
    h.client.destroy();
  });

  it("a send answered before send() returns arms no timer at all", async () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    // The in-memory peer answers synchronously, inside the client's own write.
    h.peer.onData(() => h.peerAck(ack("M1")));
    const before = vi.getTimerCount();
    const sent = h.client.send(message("M1"), { ackTimeoutMs: 1_000 });
    expect(vi.getTimerCount()).toBe(before);
    expect((await sent).toString("latin1")).toContain("MSA|AA|M1");
    h.client.destroy();
  });

  it("a send without it arms no timer of its own", () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const before = vi.getTimerCount();
    const sent = h.client.send(message("M1"));
    void sent.catch(() => undefined);
    expect(vi.getTimerCount()).toBe(before);
    h.client.destroy();
  });

  it("its timer never keeps the process alive", () => {
    const h = harness({ ackTimeoutMs: 10_000 });
    const armed: ReturnType<typeof setTimeout>[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((fn: () => void, ms?: number) => {
        const handle = realSetTimeout(fn, ms);
        if (ms === 1_000) armed.push(handle);
        return handle;
      });
    try {
      const sent = h.client.send(message("M1"), { ackTimeoutMs: 1_000 });
      void sent.catch(() => undefined);
    } finally {
      spy.mockRestore();
    }
    expect(armed).toHaveLength(1);
    expect(armed[0]?.hasRef()).toBe(false);
    h.client.destroy();
  });
});
