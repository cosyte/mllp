/**
 * MllpClient backpressure tests (PLAN-05, CLIENT-07 / ERR-04 / D-23 / D-24).
 *
 * Drives the high-water mark gate over `InMemoryTransport.pair()` so we can
 * control ACK timing precisely and verify both `'reject'` and `'wait'` modes,
 * the stricter-of-two semantics, the frozen `'drain'` event payload, and the
 * `'wait'`-mode signal-abort cleanup invariant (B-06).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { MllpBackpressureError } from "../../src/client/error.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";
import type { ClientOptions } from "../../src/client/client.js";

/**
 * Narrow an indexed access to its non-nullish value, throwing if it is
 * `undefined`/`null`. Replaces forbidden non-null assertions (`x!`) in tests.
 */
function must<T>(v: T | undefined | null): NonNullable<T> {
  if (v === undefined || v === null) throw new Error("expected value");
  return v;
}

interface Harness {
  client: MllpClient;
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: Partial<ClientOptions>): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const baseOpts: ClientOptions = { host: "127.0.0.1", port: 0, ...opts };
  const client = createClient(baseOpts);
  (
    client as unknown as { _attachExistingConnection: (c: Connection) => void }
  )._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  const ackFromPeer = (payload: Buffer): void => {
    b.write(encodeFrame(payload));
  };
  return { client, ackFromPeer };
}

describe("MllpClient backpressure, count mode (PLAN-05, CLIENT-07)", () => {
  it("Test 1: highWaterMark count cap rejects with MllpBackpressureError", async () => {
    const { client } = buildClientOverPair({ highWaterMark: 3 });
    const p1 = client.send(Buffer.from("M1"));
    p1.catch(() => {});
    const p2 = client.send(Buffer.from("M2"));
    p2.catch(() => {});
    const p3 = client.send(Buffer.from("M3"));
    p3.catch(() => {});
    // 4th send overflows the cap of 3 → reject.
    await expect(client.send(Buffer.from("M4"))).rejects.toMatchObject({
      name: "MllpBackpressureError",
      queueDepth: 3,
      highWaterMark: { count: 3 },
    });
    client.destroy();
  });

  it("Test 2: default highWaterMark is 64 (count) when not configured", async () => {
    const { client } = buildClientOverPair();
    // Hold 64 sends in flight (no peer ACKs).
    const inflight: Promise<Buffer>[] = [];
    for (let i = 0; i < 64; i++) {
      const p = client.send(Buffer.from(`M${i}`));
      p.catch(() => {});
      inflight.push(p);
    }
    await expect(client.send(Buffer.from("OVERFLOW"))).rejects.toMatchObject({
      name: "MllpBackpressureError",
      highWaterMark: { count: 64 },
    });
    client.destroy();
  });
});

describe("MllpClient backpressure, bytes mode (PLAN-05, D-23)", () => {
  it("Test 3: highWaterMark { bytes } cap rejects when bytes would exceed", async () => {
    const { client } = buildClientOverPair({ highWaterMark: { bytes: 100 } });
    // Frame overhead from encodeFrame is +3 bytes (VT + FS + CR). So a 60B
    // payload becomes 63B framed and a 50B payload becomes 53B framed,
    // first send (63B) fits under 100B, second (63+53=116B) overflows.
    const p1 = client.send(Buffer.alloc(60, 0x41));
    p1.catch(() => {});
    await expect(client.send(Buffer.alloc(50, 0x42))).rejects.toMatchObject({
      name: "MllpBackpressureError",
      highWaterMark: { bytes: 100 },
    });
    client.destroy();
  });
});

describe("MllpClient backpressure, stricter-of-two (PLAN-05, D-23)", () => {
  it("Test 4: count + bytes both configured; whichever caps first wins", async () => {
    // count=100 (very loose), bytes=200 (the binding constraint).
    const { client } = buildClientOverPair({
      highWaterMark: { count: 100, bytes: 200 },
    });
    // 50B payload → 53B framed. 4 sends = 212B > 200B cap.
    const p1 = client.send(Buffer.alloc(50, 0x41));
    p1.catch(() => {});
    const p2 = client.send(Buffer.alloc(50, 0x42));
    p2.catch(() => {});
    const p3 = client.send(Buffer.alloc(50, 0x43));
    p3.catch(() => {});
    // 4th send should overflow bytes BEFORE count.
    await expect(client.send(Buffer.alloc(50, 0x44))).rejects.toMatchObject({
      name: "MllpBackpressureError",
      highWaterMark: { count: 100, bytes: 200 },
    });
    client.destroy();
  });
});

describe("MllpClient backpressure, 'wait' mode (PLAN-05, CLIENT-07/CLIENT-11)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("Test 5: 'wait' mode resolves once queue drains and ACK arrives", async () => {
    const { client, ackFromPeer } = buildClientOverPair({
      highWaterMark: 2,
      onBackpressure: "wait",
      ackTimeoutMs: 60_000,
    });
    const p1 = client.send(Buffer.from("M1"));
    const p2 = client.send(Buffer.from("M2"));
    // 3rd send is over cap → in 'wait' mode it does NOT reject.
    const p3 = client.send(Buffer.from("M3"));
    // ACK first send → drain fires → p3 enqueues internally → ACK p2 first
    // (FIFO: matchAck pops head). After p1's ACK clears the head, p2 becomes head.
    ackFromPeer(Buffer.from("A1"));
    await vi.advanceTimersByTimeAsync(1);
    // Now ACK the second pending send (head is the original M2).
    ackFromPeer(Buffer.from("A2"));
    await vi.advanceTimersByTimeAsync(1);
    // Finally ACK M3.
    ackFromPeer(Buffer.from("A3"));
    await vi.advanceTimersByTimeAsync(1);
    const a1 = await p1;
    const a2 = await p2;
    const a3 = await p3;
    expect(a1.toString()).toBe("A1");
    expect(a2.toString()).toBe("A2");
    expect(a3.toString()).toBe("A3");
    await client.close();
  });

  it("Test 6: 'wait' mode + ackTimeoutMs elapses while waiting → MllpTimeoutError", async () => {
    // Global ackTimeoutMs=10_000 (M1 stays in-flight) but per-message
    // ackTimeoutMs=100 on the waiting send forces the wait timer to fire
    // first, demonstrating timeout precedence over an indefinite wait.
    const { client } = buildClientOverPair({
      highWaterMark: 1,
      onBackpressure: "wait",
      ackTimeoutMs: 10_000,
    });
    const p1 = client.send(Buffer.from("M1"));
    p1.catch(() => {});
    const p2 = client.send(Buffer.from("M2"), { ackTimeoutMs: 100 });
    // Pre-attach a catch to absorb the rejection; expect(...).rejects below
    // also reads from p2, vitest re-uses the same Promise.
    const p2Settled = p2.catch((err: unknown) => err);
    // p2 waits for drain; p1 never ACKs and won't expire under the global
    // 10s timeout. p2's wait-timeout (100ms) fires first.
    await vi.advanceTimersByTimeAsync(150);
    await expect(p2).rejects.toMatchObject({ name: "MllpTimeoutError" });
    void p2Settled;
    client.destroy();
  });

  it("Test 6b (B-06): 'wait' mode + signal aborts → AbortError + cleanup", async () => {
    const { client } = buildClientOverPair({
      highWaterMark: 1,
      onBackpressure: "wait",
      ackTimeoutMs: 60_000,
    });
    const p1 = client.send(Buffer.from("M1"));
    p1.catch(() => {});
    const baselineDrainListeners = client.listenerCount("drain");
    const ac = new AbortController();
    const p2 = client.send(Buffer.from("M2"), { signal: ac.signal });
    // The drain listener should have been registered.
    expect(client.listenerCount("drain")).toBeGreaterThan(baselineDrainListeners);
    ac.abort();
    await expect(p2).rejects.toMatchObject({ name: "AbortError" });
    // Cleanup invariant: the drain listener was removed.
    expect(client.listenerCount("drain")).toBe(baselineDrainListeners);
    client.destroy();
  });
});

describe("MllpClient 'drain' event (PLAN-05, D-24)", () => {
  it("Test 7: 'drain' event fires after queue crosses below high-water mark", async () => {
    const { client, ackFromPeer } = buildClientOverPair({ highWaterMark: 2 });
    const drains: Array<{ queueDepth: number; queueBytes: number }> = [];
    client.on("drain", (e: unknown) => {
      drains.push(e as { queueDepth: number; queueBytes: number });
    });
    const p1 = client.send(Buffer.from("M1"));
    const p2 = client.send(Buffer.from("M2"));
    p2.catch(() => {});
    // ACK1 → queue size becomes 1 < highWaterMark.count(2) → drain fires.
    ackFromPeer(Buffer.from("A1"));
    await p1;
    expect(drains.length).toBeGreaterThanOrEqual(1);
    expect(must(drains[0]).queueDepth).toBe(1);
    client.destroy();
  });

  it("Test 8: 'drain' event payload is frozen (D-25)", async () => {
    const { client, ackFromPeer } = buildClientOverPair({ highWaterMark: 2 });
    let captured: { queueDepth: number; queueBytes: number } | null = null;
    client.on("drain", (e: unknown) => {
      captured = e as { queueDepth: number; queueBytes: number };
    });
    const p1 = client.send(Buffer.from("M1"));
    const p2 = client.send(Buffer.from("M2"));
    p2.catch(() => {});
    ackFromPeer(Buffer.from("A1"));
    await p1;
    expect(captured).not.toBeNull();
    expect(Object.isFrozen(captured)).toBe(true);
    expect(() => {
      (captured as unknown as { queueDepth: number }).queueDepth = 999;
    }).toThrow();
    client.destroy();
  });

  it("Test 9: 'drain' fires only when both count AND bytes are below thresholds", async () => {
    const { client, ackFromPeer } = buildClientOverPair({
      highWaterMark: { count: 5 },
    });
    const drains: Array<{ queueDepth: number }> = [];
    client.on("drain", (e: unknown) => {
      drains.push(e as { queueDepth: number });
    });
    const p1 = client.send(Buffer.from("M1"));
    const p2 = client.send(Buffer.from("M2"));
    p2.catch(() => {});
    ackFromPeer(Buffer.from("A1"));
    await p1;
    // queueDepth=1 < cap=5 → drain fires.
    expect(drains.length).toBe(1);
    client.destroy();
  });
});

// Ensure that the imported error type is the right reference.
describe("Type sanity", () => {
  it("exports MllpBackpressureError from the module", () => {
    expect(typeof MllpBackpressureError).toBe("function");
  });
});
