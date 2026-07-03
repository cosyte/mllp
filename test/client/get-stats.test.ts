/**
 * client.getStats() tests (PLAN-06, OBS-01, D-26).
 *
 * Validates:
 * - JSON-serializable shape (OBS-04 — no Buffers, no class instances).
 * - epoch-ms timestamps (NOT Date) per D-26.
 * - Counter accuracy across send/ACK/timeout/reconnect cycles.
 * - inFlight vs queueDepth divergence (B-01).
 */

import { describe, it, expect, vi } from "vitest";
import { createClient, type MllpClient } from "../../src/client/client.js";
import type { ClientStats } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame } from "../../src/framing/index.js";

interface Harness {
  client: MllpClient;
  peer: InMemoryTransport;
  conn: Connection;
  ackFromPeer: (payload: Buffer) => void;
}

function buildClientOverPair(opts?: {
  ackTimeoutMs?: number;
  pipeline?: boolean;
  highWaterMark?: number;
}): Harness {
  const [a, b] = InMemoryTransport.pair();
  const conn = new Connection({ transport: a });
  const clientOpts: {
    host: string;
    port: number;
    ackTimeoutMs?: number;
    pipeline?: boolean;
    highWaterMark?: number;
  } = {
    host: "127.0.0.1",
    port: 0,
  };
  if (opts?.ackTimeoutMs !== undefined) clientOpts.ackTimeoutMs = opts.ackTimeoutMs;
  if (opts?.pipeline !== undefined) clientOpts.pipeline = opts.pipeline;
  if (opts?.highWaterMark !== undefined) clientOpts.highWaterMark = opts.highWaterMark;
  const client = createClient(clientOpts);
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  const ackFromPeer = (payload: Buffer): void => {
    b.write(encodeFrame(payload));
  };
  return { client, peer: b, conn, ackFromPeer };
}

const D26_KEYS = [
  "state",
  "connectionId",
  "queueDepth",
  "queueBytes",
  "inFlight",
  "warningsByCode",
  "totalBytesIn",
  "totalBytesOut",
  "sentTotal",
  "ackedTotal",
  "timedOutTotal",
  "reconnectAttempts",
  "lastConnectedAt",
  "lastAckAt",
  "tls",
] as const;

describe("client.getStats (PLAN-06, OBS-01, D-26)", () => {
  it("Test 1: BEFORE connect() returns the D-26 zero-state shape", () => {
    const client = createClient({ host: "127.0.0.1", port: 0 });
    const stats = client.getStats();
    expect(stats.state).toBe("DISCONNECTED");
    expect(stats.connectionId).toBeNull();
    expect(stats.queueDepth).toBe(0);
    expect(stats.queueBytes).toBe(0);
    expect(stats.inFlight).toBe(0);
    expect(stats.warningsByCode).toEqual({});
    expect(stats.totalBytesIn).toBe(0);
    expect(stats.totalBytesOut).toBe(0);
    expect(stats.sentTotal).toBe(0);
    expect(stats.ackedTotal).toBe(0);
    expect(stats.timedOutTotal).toBe(0);
    expect(stats.reconnectAttempts).toBe(0);
    expect(stats.lastConnectedAt).toBeNull();
    expect(stats.lastAckAt).toBeNull();
    expect(stats.tls).toBe(false);
    // All required D-26 keys present
    for (const key of D26_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(stats, key)).toBe(true);
    }
  });

  it("Test 13 (Phase 8): getStats().tls is true when ClientOptions.tls is configured", () => {
    const client = createClient({ host: "127.0.0.1", port: 0, tls: true });
    expect(client.getStats().tls).toBe(true);
  });

  it("Test 2: AFTER connect() resolves, state=CONNECTED, connectionId is non-null string, lastConnectedAt is number", async () => {
    const { client, conn } = buildClientOverPair();
    // The harness already connected — getStats should reflect it.
    const stats = client.getStats();
    expect(stats.state).toBe("CONNECTED");
    expect(typeof stats.connectionId).toBe("string");
    expect(stats.connectionId).toBe(conn.connectionId);
    expect(typeof stats.lastConnectedAt).toBe("number");
    await client.close();
  });

  it("Test 3: JSON.stringify round-trips with no information loss (OBS-04)", async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const sendP = client.send(Buffer.from("PAY"));
    ackFromPeer(Buffer.from("ACK"));
    await sendP;
    const stats = client.getStats();
    const json = JSON.stringify(stats);
    const round = JSON.parse(json) as ClientStats;
    expect(round).toEqual(stats);
    // Ensure no Buffer / class instance leaks
    expect(json).not.toContain("Buffer");
    expect(json.length).toBeGreaterThan(0);
    await client.close();
  });

  it("Test 4: lastConnectedAt + lastAckAt are number | null (epoch ms), NOT Date", async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const sendP = client.send(Buffer.from("PAY"));
    ackFromPeer(Buffer.from("ACK"));
    await sendP;
    const stats = client.getStats();
    expect(typeof stats.lastConnectedAt).toBe("number");
    expect(typeof stats.lastAckAt).toBe("number");
    expect(stats.lastConnectedAt).not.toBeInstanceOf(Date);
    expect(stats.lastAckAt).not.toBeInstanceOf(Date);
    await client.close();
  });

  it("Test 5: After 3 sends with successful ACKs, sentTotal=3, ackedTotal=3, inFlight=0, queueDepth=0", async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const p1 = client.send(Buffer.from("A"));
    const p2 = client.send(Buffer.from("B"));
    const p3 = client.send(Buffer.from("C"));
    ackFromPeer(Buffer.from("A1"));
    ackFromPeer(Buffer.from("A2"));
    ackFromPeer(Buffer.from("A3"));
    await Promise.all([p1, p2, p3]);
    const stats = client.getStats();
    expect(stats.sentTotal).toBe(3);
    expect(stats.ackedTotal).toBe(3);
    expect(stats.inFlight).toBe(0);
    expect(stats.queueDepth).toBe(0);
    expect(stats.timedOutTotal).toBe(0);
    expect(typeof stats.lastAckAt).toBe("number");
    await client.close();
  });

  it("Test 6: After ACK timeout, sentTotal=1, timedOutTotal=1, ackedTotal=0, lastAckAt=null", async () => {
    vi.useFakeTimers();
    try {
      const { client } = buildClientOverPair({ ackTimeoutMs: 100 });
      const p = client.send(Buffer.from("PAYLOAD"));
      // Catch the rejection synchronously to avoid unhandled rejection.
      const caught = p.catch(() => undefined);
      // Advance fake clock past ackTimeout AND past sweep interval.
      await vi.advanceTimersByTimeAsync(500);
      await caught;
      const stats = client.getStats();
      expect(stats.sentTotal).toBe(1);
      expect(stats.timedOutTotal).toBe(1);
      expect(stats.ackedTotal).toBe(0);
      expect(stats.lastAckAt).toBeNull();
      await client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("Test 7: warningsByCode is a flat object whose keys are WarningCode union members", async () => {
    const { client } = buildClientOverPair();
    const stats = client.getStats();
    // Empty initially — type-only assertion that it is a plain object.
    expect(typeof stats.warningsByCode).toBe("object");
    expect(Array.isArray(stats.warningsByCode)).toBe(false);
    // No 'WarningCode' string key (it would only contain real code strings)
    expect(Object.keys(stats.warningsByCode)).toEqual([]);
    await client.close();
  });

  it("Test 9: lastAckAt updates on every successful ACK match", async () => {
    const { client, ackFromPeer } = buildClientOverPair();
    const before = Date.now();
    const p = client.send(Buffer.from("PAY"));
    ackFromPeer(Buffer.from("ACK"));
    await p;
    const stats = client.getStats();
    expect(typeof stats.lastAckAt).toBe("number");
    expect(stats.lastAckAt).not.toBeNull();
    expect((stats.lastAckAt as number) >= before).toBe(true);
    await client.close();
  });

  it("Test 10: getStats() callable from any state without throwing", async () => {
    const client = createClient({ host: "127.0.0.1", port: 0 });
    expect(() => client.getStats()).not.toThrow();
    expect(client.getStats().state).toBe("DISCONNECTED");

    const [a, _b] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    client._attachExistingConnection(conn);
    expect(() => client.getStats()).not.toThrow();
    conn.notifyConnect("127.0.0.1", 2575);
    expect(client.getStats().state).toBe("CONNECTED");

    await client.close();
    expect(() => client.getStats()).not.toThrow();
  });

  it("Test 11 (B-01): inFlight is distinct from queueDepth — divergence in pipeline:false", async () => {
    // pipeline:false → maxInFlight=1. Send A, then send B (which enters _waitThenSend
    // path because A occupies the slot). Before A's ACK arrives, B has not yet been
    // enqueued in the correlator (it's in the wait-for-drain queue). After A ACKs,
    // B advances. To observe the divergence we use the pipeline:false code path:
    // queueDepth (correlator.size) should equal inFlight (entries with sentAt!==null)
    // when no entry is pre-flush. Divergence appears whenever there's a pre-flush
    // entry (controlId mode FIFO does not pre-flush; pipeline:false send-after-drain
    // DOES NOT enqueue until the slot frees). The cleanest divergence check: drive
    // the correlator directly with an unflushed entry.
    const { client } = buildClientOverPair({ pipeline: false });
    const stats0 = client.getStats();
    expect(stats0.queueDepth).toBe(0);
    expect(stats0.inFlight).toBe(0);
    // Inspect via private-ish handle: enqueue without flushing through correlator.
    const correlator = (
      client as unknown as {
        _correlator: {
          enqueue: (
            frame: Buffer,
            cid: string | null,
            res: (b: Buffer) => void,
            rej: (e: Error) => void,
          ) => number | string | null;
          size: number;
        };
      }
    )._correlator;
    expect(correlator).not.toBeNull();
    // Force an unflushed entry into the live store
    correlator.enqueue(
      Buffer.from("xxx"),
      null,
      () => undefined,
      () => undefined,
    );
    const stats = client.getStats();
    // Divergence: queueDepth = 1 (one entry), inFlight = 0 (sentAt still null)
    expect(stats.queueDepth).toBe(1);
    expect(stats.inFlight).toBe(0);
    await client.close();
  });

  it("Test 12 (B-01 anti-pattern guard): inFlight reflects the dedicated counter, not corrStats.size", async () => {
    // After a send + ACK, both queueDepth and inFlight should be 0 (consistent).
    const { client, ackFromPeer } = buildClientOverPair();
    const p = client.send(Buffer.from("PAY"));
    ackFromPeer(Buffer.from("ACK"));
    await p;
    const stats = client.getStats();
    expect(stats.queueDepth).toBe(0);
    expect(stats.inFlight).toBe(0);
    await client.close();
  });

  it("Test 8: After a transient reconnect cycle, reconnectAttempts >= 1", async () => {
    // Use the existing reconnect path — drive a transient disconnect via the test seam.
    const [a, _b] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({
      host: "127.0.0.1",
      port: 0,
      autoReconnect: true,
      initialDelayMs: 1, // tiny — keeps the test fast even though we never run the timer
    });
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);

    // Install a no-op reconnect factory so the FSM doesn't try to open a real socket.
    (
      client as unknown as {
        _setReconnectFactory: (f: () => { conn: Connection; arm: () => void }) => void;
      }
    )._setReconnectFactory(() => {
      const [aa, _bb] = InMemoryTransport.pair();
      const c = new Connection({ transport: aa });
      return {
        conn: c,
        arm: (): void => {
          c.notifyConnect("127.0.0.1", 2575);
        },
      };
    });

    // Trigger a transient disconnect — ECONNRESET is classified transient.
    const transient: NodeJS.ErrnoException = Object.assign(new Error("ECONNRESET"), {
      code: "ECONNRESET",
    });
    conn.destroy(transient);

    // Allow the async reconnect cycle to schedule.
    await new Promise((r) => setTimeout(r, 30));

    const stats = client.getStats();
    expect(stats.reconnectAttempts).toBeGreaterThanOrEqual(1);
    client.destroy();
  });
});
