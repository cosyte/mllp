/**
 * Every socket-path case of `bench/socket-cases.mjs` runs, and measures what its name says.
 *
 * A benchmark that measures the wrong thing reads as a confident number all the same. So each case
 * runs once here, at a scale a test can afford, against the source, with the server in this
 * process: concurrent connections, TLS handshakes, TCP and TLS throughput, latency behind a slow
 * handler, and a reconnect storm. Beyond "it ran", each is held to the property that makes its
 * number mean something: a TLS row really negotiated TLS, no ACK came back before the slow handler
 * finished, and every client of the storm came back and was answered. Every message is synthetic
 * and built in code.
 *
 * Node.js only: the socket benchmarks run on Node.js (`bench.yml`), and they read Node's
 * `process.memoryUsage().arrayBuffers`, so under Bun and Deno this file is skipped.
 */

import { describe, expect, it } from "vitest";

import {
  CASES,
  inProcessHost,
  runCase,
  tlsMaterial,
  type CaseResult,
} from "../../bench/socket-cases.mjs";
import * as mllp from "../../src/index.js";
import { RUNTIME } from "../_helpers/runtime.js";

const tls = RUNTIME === "node" ? tlsMaterial() : { cert: "", key: "" };

async function run(name: string): Promise<CaseResult> {
  return runCase(mllp, inProcessHost(mllp), name, { scale: "test", tls });
}

// Skipped under Bun and Deno: the benchmarks run on Node.js only (see the header).
describe.skipIf(RUNTIME !== "node")("the socket-path cases", () => {
  it("names the five cases, in the order a reading runs them", () => {
    expect(CASES.map((c) => c.name)).toEqual([
      "concurrent connections",
      "TLS handshake",
      "TLS throughput",
      "slow handler",
      "reconnect storm",
    ]);
  });

  it("refuses a case it does not know", async () => {
    await expect(
      runCase(mllp, inProcessHost(mllp), "no such case", { scale: "test", tls }),
    ).rejects.toThrow(/no such case/);
  });

  it("answers every message from many connections at once, over TCP and TLS", async () => {
    const result = await run("concurrent connections");
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(result.rows.map((r) => r.transport))).toEqual(new Set(["TCP", "TLS"]));
    for (const row of result.rows) {
      expect(row.connections).toBeGreaterThan(1);
      expect(row.tlsConnections).toBe(row.transport === "TLS" ? row.connections : 0);
      expect(row.messages).toBe(row.connections * row.perConnection * row.rounds);
      expect(row.acked).toBe(row.messages);
      expect(row.opsPerSec).toBeGreaterThan(0);
      expect(row.latencyMs.min).toBeGreaterThan(0);
      expect(row.latencyMs.max).toBeGreaterThanOrEqual(row.latencyMs.min ?? Infinity);
      expect(row.connectAllMs).toBeGreaterThan(0);
      expect(Number.isFinite(row.serverIdlePerConnection.heapUsed)).toBe(true);
      expect(Number.isFinite(row.serverIdlePerConnection.arrayBuffers)).toBe(true);
    }
  }, 60_000);

  it("times a TLS handshake against a TCP connect, and the TLS one negotiates", async () => {
    const result = await run("TLS handshake");
    expect(result.rows.map((r) => r.transport)).toEqual(["TCP", "TLS"]);
    for (const row of result.rows) {
      expect(row.handshakes).toBeGreaterThan(0);
      expect(row.tlsConnections).toBe(row.transport === "TLS" ? row.handshakes : 0);
      expect(row.sequentialMs.min).toBeGreaterThan(0);
      expect(row.concurrentPerSec).toBeGreaterThan(0);
    }
  }, 60_000);

  it("sends each shape over TCP and over TLS, every send answered", async () => {
    const result = await run("TLS throughput");
    expect(new Set(result.rows.map((r) => r.transport))).toEqual(new Set(["TCP", "TLS"]));
    for (const row of result.rows) {
      expect(row.acked).toBe(row.messages);
      expect(row.tls).toBe(row.transport === "TLS");
      expect(row.bytesPerSec).toBeGreaterThan(0);
      expect(row.latencyMs.min).toBeGreaterThan(0);
      expect(row.latencyMs.max).toBeGreaterThanOrEqual(row.latencyMs.min ?? Infinity);
      expect(row.peak.sender).not.toBeNull();
      expect(row.peak.receiver).not.toBeNull();
    }
  }, 60_000);

  it("never reads an ACK back before the slow handler has finished", async () => {
    const result = await run("slow handler");
    expect(result.rows.length).toBeGreaterThanOrEqual(2);
    expect(new Set(result.rows.map((r) => r.window)).size).toBeGreaterThan(1);
    for (const row of result.rows) {
      expect(row.acked).toBe(row.messages);
      // The commit contract: the AA waits for the handler, so no latency is under its
      // delay. (A percentile needs 10 sends above it; at this scale only the least and most exist.)
      expect(row.latencyMs.min).toBeGreaterThanOrEqual(row.handlerDelayMs - 1);
    }
  }, 60_000);

  it("brings every client of a storm back and answers each, over TCP and TLS", async () => {
    const result = await run("reconnect storm");
    expect(result.rows.map((r) => r.transport)).toEqual(["TCP", "TLS"]);
    for (const row of result.rows) {
      expect(row.reconnected).toBe(row.clients);
      expect(row.acked).toBe(row.clients);
      expect(row.attempts).toBeGreaterThanOrEqual(row.clients);
      expect(row.allConnectedMs).toBeGreaterThan(0);
      expect(row.allAckedMs).toBeGreaterThanOrEqual(row.allConnectedMs);
    }
  }, 60_000);
});
