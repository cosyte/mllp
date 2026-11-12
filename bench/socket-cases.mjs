// The socket paths `socket.mjs` does not cover, over a real 127.0.0.1 socket: many connections to
// one server, the TLS handshake, the same traffic over TLS and over TCP, ACK latency behind a slow
// commit step, and a reconnect storm.
//
//   pnpm build && pnpm bench:socket-cases [--out <dir>] [--target <entry>] [--quick]
//   pnpm bench:socket-cases --only "TLS handshake"
//
// - concurrent connections: 16, 128 and 512 clients against one server, each sending one message
//   at a time, all at once; throughput, latency from `send()` to its ACK, the time to connect them
//   all, and the server's memory for each idle connection and at its peak.
// - TLS handshake: the time from `connect()` to a connection ready to send, one at a time and 16
//   at once, over TLS and, for scale, over plain TCP.
// - TLS throughput: the traffic of `socket.mjs` over TLS and over TCP in the same run, with the
//   peak memory of each side.
// - slow handler: ACK latency when the server's `onMessage`, the commit step the auto-ACK waits
//   for, takes 5 or 25 ms, with one message in flight, 8 and 64.
// - reconnect storm: 100 and 500 clients with `autoReconnect` on, the server killed and started
//   again on the same port; how long until every client is back and answered, and how many
//   connection attempts that took.
//
// @cosyte/bench times a synchronous call and cannot wait for a socket, so, as `socket.mjs` does,
// this script measures the asynchronous path itself. Each server runs in a child process of its
// own, so its memory is read apart from the clients'. Every memory figure counts the V8 heap and the
// memory outside it that holds a Buffer's bytes, as heap + outside the heap.
//
// The cases are exported so a test runs each once, at a small scale, against the source, with the
// server in the test's own process (`inProcessHost`).
//
// Every message is synthetic and built in code by `corpus.mjs`; the TLS certificate is made in
// memory for the run and never written. The output names sizes, counts, timings and the machine
// (CPU model, cores, Node, runner image), never a host name or a path.

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { generate } from "selfsigned";

import { KIB, MIB, adtMessage, documentMessage, oruMessage } from "./corpus.mjs";
import {
  bytes,
  machine,
  median,
  ms,
  peakTracker,
  percentiles,
  settle,
  topPeak,
} from "./socket-measure.mjs";

const SELF = fileURLToPath(import.meta.url);

/** How many of everything, by scale: a reading, a quick look, and the test that runs every case. */
const SCALES = {
  full: {
    concurrent: { connections: [16, 128, 512], perConnection: 20, rounds: 3 },
    handshake: { sequential: 200, concurrent: 16, batches: 10 },
    throughput: { counts: [20_000, 5_000, 1_000, 20], rounds: 3, peakSends: 8 },
    slow: { delays: [5, 25], windows: [1, 8, 64], messages: 320 },
    storm: { clients: [100, 500], gapMs: 250 },
  },
  quick: {
    concurrent: { connections: [16, 128], perConnection: 10, rounds: 2 },
    handshake: { sequential: 50, concurrent: 16, batches: 3 },
    throughput: { counts: [2_000, 1_000, 200, 5], rounds: 2, peakSends: 4 },
    slow: { delays: [5, 25], windows: [1, 8, 64], messages: 96 },
    storm: { clients: [100], gapMs: 250 },
  },
  test: {
    concurrent: { connections: [4], perConnection: 3, rounds: 1 },
    handshake: { sequential: 3, concurrent: 2, batches: 1 },
    throughput: { counts: [64, 8, 4, 1], rounds: 1, peakSends: 1 },
    slow: { delays: [5], windows: [1, 4], messages: 8 },
    storm: { clients: [4], gapMs: 50 },
  },
};

const TRANSPORTS = ["TCP", "TLS"];

/** The shapes of the throughput case, as `socket.mjs` sends them; counts come from the scale. */
const SHAPES = [
  { label: "ADT^A01, 280 B, 64 in flight", make: (i) => adtMessage(i), window: 64 },
  { label: "ADT^A01, 280 B, one at a time", make: (i) => adtMessage(i), window: 1 },
  { label: "ORU^R01, 32 KiB, one at a time", make: (i) => oruMessage(i, 32 * KIB), window: 1 },
  {
    label: "MDM^T02, 1 MiB base64, one at a time",
    make: (i) => documentMessage(i, MIB),
    window: 1,
    distinct: 4,
  },
];

/**
 * A throwaway certificate for 127.0.0.1, made in memory: the server's certificate and key, and
 * the same certificate as the client's trust anchor.
 */
export function tlsMaterial() {
  const pems = generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
    extensions: [
      {
        name: "subjectAltName",
        altNames: [
          { type: 2, value: "localhost" },
          { type: 7, ip: "127.0.0.1" },
        ],
      },
    ],
  });
  return { cert: pems.cert, key: pems.private };
}

/**
 * A server on 127.0.0.1 that answers every message with the auto-ACK once its `onMessage` settles,
 * waiting `handlerDelayMs` there when asked to, and answers the measuring requests: `settle`,
 * `peak-start`, `peak-stop` and `stats`. With `trackFromStart` its peak is read from the moment it
 * listens, without settling first, for a storm that arrives at once.
 */
async function listen(mllp, spec, port) {
  const peaks = peakTracker();
  if (spec.trackFromStart === true) peaks.startNow();
  const delay = spec.handlerDelayMs ?? 0;
  const server = mllp.createServer({
    autoAck: "AA",
    onMessage: () => {
      peaks.sample();
      return delay > 0 ? new Promise((done) => setTimeout(done, delay)) : undefined;
    },
    ...(spec.tls === undefined ? {} : { tls: spec.tls }),
  });
  await server.listen(port, "127.0.0.1");
  const answer = async (type) => {
    if (type === "settle") return settle();
    if (type === "peak-start") {
      await peaks.start();
      return {};
    }
    if (type === "peak-stop") return peaks.stop();
    if (type === "stats") {
      const s = server.getStats();
      return {
        connections: s.connections,
        acceptedTotal: s.acceptedTotal,
        tlsClientErrorsTotal: s.tlsClientErrorsTotal,
      };
    }
    throw new Error(`unknown request ${String(type)}`);
  };
  return { server, peaks, answer, port: server.getStats().port };
}

/** Servers in this process, for the test: a child process would cost more than it shows there. */
export function inProcessHost(mllp) {
  return {
    async start(spec, port = 0) {
      const s = await listen(mllp, spec, port);
      return {
        port: s.port,
        ask: (type) => s.answer(type),
        async stop() {
          s.peaks.stop();
          await s.server.close({ drainTimeoutMs: 1_000 });
        },
        async crash() {
          s.peaks.stop();
          await s.server.close({ drainTimeoutMs: 0 });
        },
      };
    },
  };
}

/** Servers each in a child process of their own, as a reading runs them; `crash` kills one. */
export function childHost(target) {
  return {
    async start(spec, port = 0) {
      const child = fork(SELF, ["--serve", JSON.stringify({ ...spec, port }), "--target", target], {
        execArgv: ["--expose-gc"],
        stdio: ["ignore", "inherit", "inherit", "ipc"],
      });
      let nextId = 0;
      const waiting = new Map();
      const exited = new Promise((done) => child.once("exit", done));
      const listening = await new Promise((done, fail) => {
        child.once("error", fail);
        void exited.then((code) => fail(new Error(`the server exited (${String(code)})`)));
        child.on("message", (message) => {
          if (message.type === "ready") done(message.port);
          else {
            const { id, ...body } = message;
            waiting.get(id)?.(body);
            waiting.delete(id);
          }
        });
      });
      return {
        port: listening,
        ask: (type) =>
          new Promise((done) => {
            const id = ++nextId;
            waiting.set(id, done);
            child.send({ id, type });
          }),
        async stop() {
          child.send({ type: "stop" });
          await exited;
        },
        async crash() {
          child.kill("SIGKILL");
          await exited;
        },
      };
    },
  };
}

/** A client of the server on `port`, over `transport`, counting the TLS sessions it negotiates. */
function makeClient(mllp, port, transport, tls, extra = {}) {
  const client = mllp.createClient({
    host: "127.0.0.1",
    port,
    autoReconnect: false,
    highWaterMark: 64,
    ...(transport === "TLS" ? { tls: { ca: tls.cert } } : {}),
    ...extra,
  });
  const counted = { client, negotiated: 0 };
  client.on("tlsNegotiated", () => {
    counted.negotiated += 1;
  });
  return counted;
}

function serverSpec(transport, tls, more = {}) {
  return { ...(transport === "TLS" ? { tls } : {}), ...more };
}

/** Send `payloads` with at most `window` awaiting their ACK; the latency of each, and the time. */
async function run(client, payloads, window, onSent) {
  const latencies = new Array(payloads.length);
  let next = 0;
  let acked = 0;
  const start = performance.now();
  const lane = async () => {
    while (next < payloads.length) {
      const k = next++;
      const t0 = performance.now();
      await client.send(payloads[k]);
      latencies[k] = performance.now() - t0;
      acked += 1;
      onSent?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(window, payloads.length) }, lane));
  return { elapsed: performance.now() - start, latencies, acked };
}

const sleep = (msToWait) => new Promise((done) => setTimeout(done, msToWait));

/** Many clients at once against one server, each sending one message at a time. */
async function concurrentConnections(mllp, host, scale, tls) {
  const { connections, perConnection, rounds } = scale.concurrent;
  const payloads = Array.from({ length: perConnection }, (_, i) => adtMessage(i));
  const rows = [];
  for (const transport of TRANSPORTS) {
    for (const n of connections) {
      const server = await host.start(serverSpec(transport, tls));
      const before = await server.ask("settle");
      const clients = Array.from({ length: n }, () =>
        makeClient(mllp, server.port, transport, tls),
      );
      const t0 = performance.now();
      await Promise.all(clients.map((c) => c.client.connect()));
      const connectAllMs = performance.now() - t0;
      const idle = await server.ask("settle");
      await Promise.all(clients.map((c) => run(c.client, payloads.slice(0, 2), 1))); // warm
      const rates = [];
      const latencies = [];
      let acked = 0;
      for (let r = 0; r < rounds; r++) {
        const t = performance.now();
        const done = await Promise.all(clients.map((c) => run(c.client, payloads, 1)));
        rates.push(((n * perConnection) / (performance.now() - t)) * 1000);
        for (const d of done) {
          latencies.push(...d.latencies);
          acked += d.acked;
        }
      }
      // Memory over one more round, apart from the timed ones, so the sampling does not tax them.
      const local = peakTracker();
      await local.start();
      await server.ask("peak-start");
      await Promise.all(clients.map((c) => run(c.client, payloads, 1, local.sample)));
      const clientPeak = local.stop();
      const serverPeak = await server.ask("peak-stop");
      const tlsConnections = clients.filter((c) => c.negotiated > 0).length;
      await Promise.all(clients.map((c) => c.client.close({ drainTimeoutMs: 1_000 })));
      await server.stop();
      rows.push({
        transport,
        connections: n,
        perConnection,
        rounds,
        messages: n * perConnection * rounds,
        acked,
        tlsConnections,
        connectAllMs,
        opsPerSec: median(rates),
        latencyMs: percentiles(latencies),
        serverIdlePerConnection: {
          heapUsed: (idle.heapUsed - before.heapUsed) / n,
          arrayBuffers: (idle.arrayBuffers - before.arrayBuffers) / n,
        },
        serverPeak,
        clientPeak,
      });
    }
  }
  return rows;
}

/** The time from `connect()` to a connection ready to send, one at a time and many at once. */
async function tlsHandshake(mllp, host, scale, tls) {
  const { sequential, concurrent, batches } = scale.handshake;
  const rows = [];
  for (const transport of TRANSPORTS) {
    const server = await host.start(serverSpec(transport, tls));
    let tlsConnections = 0;
    const once = async () => {
      const c = makeClient(mllp, server.port, transport, tls);
      const t0 = performance.now();
      await c.client.connect();
      const took = performance.now() - t0;
      tlsConnections += c.negotiated > 0 ? 1 : 0;
      return { c, took };
    };
    for (let k = 0; k < 3; k++) {
      const { c } = await once(); // warm
      await c.client.close({ drainTimeoutMs: 1_000 });
    }
    tlsConnections = 0;
    const times = [];
    for (let k = 0; k < sequential; k++) {
      const { c, took } = await once();
      times.push(took);
      await c.client.close({ drainTimeoutMs: 1_000 });
    }
    let batchMs = 0;
    for (let b = 0; b < batches; b++) {
      const t0 = performance.now();
      const opened = await Promise.all(Array.from({ length: concurrent }, once));
      batchMs += performance.now() - t0;
      await Promise.all(opened.map(({ c }) => c.client.close({ drainTimeoutMs: 1_000 })));
    }
    const stats = await server.ask("stats");
    await server.stop();
    rows.push({
      transport,
      handshakes: sequential + concurrent * batches,
      tlsConnections,
      sequentialMs: percentiles(times),
      concurrent,
      concurrentPerSec: ((concurrent * batches) / batchMs) * 1000,
      tlsClientErrors: stats.tlsClientErrorsTotal,
    });
  }
  return rows;
}

/** The traffic of `socket.mjs` over TLS and over TCP, with the peak memory of each side. */
async function tlsThroughput(mllp, host, scale, tls) {
  const { counts, rounds, peakSends } = scale.throughput;
  const rows = [];
  for (const transport of TRANSPORTS) {
    const server = await host.start(serverSpec(transport, tls));
    const c = makeClient(mllp, server.port, transport, tls);
    await c.client.connect();
    const local = peakTracker();
    for (const [i, shape] of SHAPES.entries()) {
      const count = counts[i];
      const distinct = Array.from({ length: shape.distinct ?? Math.min(count, 256) }, (_, k) =>
        shape.make(k),
      );
      const payloads = Array.from({ length: count }, (_, k) => distinct[k % distinct.length]);
      await run(c.client, payloads.slice(0, Math.max(1, Math.floor(count / 4))), shape.window);
      const rates = [];
      const latencies = [];
      let acked = 0;
      for (let r = 0; r < rounds; r++) {
        const done = await run(c.client, payloads, shape.window);
        rates.push((count / done.elapsed) * 1000);
        latencies.push(...done.latencies);
        acked += done.acked;
      }
      // One message at a time: each side settled before each send, the highest peak kept. Many in
      // flight: the peak over one whole round.
      const peak = { per: shape.window === 1 ? "message" : "round", sender: null, receiver: null };
      const batches =
        shape.window === 1 ? distinct.slice(0, peakSends).map((p) => [p]) : [payloads];
      for (const batch of batches) {
        await local.start();
        await server.ask("peak-start");
        await run(c.client, batch, shape.window, local.sample);
        peak.sender = topPeak(peak.sender, local.stop());
        peak.receiver = topPeak(peak.receiver, await server.ask("peak-stop"));
      }
      const opsPerSec = median(rates);
      rows.push({
        transport,
        label: shape.label,
        window: shape.window,
        tls: c.negotiated > 0,
        messageBytes: distinct[0].length,
        messages: count * rounds,
        acked,
        opsPerSec,
        bytesPerSec: opsPerSec * distinct[0].length,
        latencyMs: percentiles(latencies),
        peak,
      });
    }
    await c.client.close({ drainTimeoutMs: 1_000 });
    await server.stop();
  }
  return rows;
}

/** ACK latency when the commit step the auto-ACK waits for is slow, by messages in flight. */
async function slowHandler(mllp, host, scale, tls) {
  const { delays, windows, messages } = scale.slow;
  const payloads = Array.from({ length: messages }, (_, i) => adtMessage(i));
  const rows = [];
  for (const handlerDelayMs of delays) {
    const server = await host.start(serverSpec("TCP", tls, { handlerDelayMs }));
    const c = makeClient(mllp, server.port, "TCP", tls);
    await c.client.connect();
    for (const window of windows) {
      await run(c.client, payloads.slice(0, Math.min(messages, window * 2)), window); // warm
      const done = await run(c.client, payloads, window);
      const latencyMs = percentiles(done.latencies);
      rows.push({
        transport: "TCP",
        handlerDelayMs,
        window,
        messages,
        acked: done.acked,
        opsPerSec: (messages / done.elapsed) * 1000,
        latencyMs,
        p50OverDelay: latencyMs.p50 === null ? null : latencyMs.p50 / handlerDelayMs,
      });
    }
    await c.client.close({ drainTimeoutMs: 5_000 });
    await server.stop();
  }
  return rows;
}

/** Every client of a server that dies and comes back on the same port, reconnecting at once. */
async function reconnectStorm(mllp, host, scale, tls) {
  const { clients: sizes, gapMs } = scale.storm;
  const rows = [];
  for (const transport of TRANSPORTS) {
    for (const n of sizes) {
      const first = await host.start(serverSpec(transport, tls));
      const port = first.port;
      const clients = Array.from({ length: n }, () =>
        makeClient(mllp, port, transport, tls, { autoReconnect: true }),
      );
      await Promise.all(clients.map((c) => c.client.connect()));
      await Promise.all(clients.map((c, i) => c.client.send(adtMessage(i))));
      const attemptsBefore = clients.map((c) => c.client.getStats().reconnectAttempts);
      const back = clients.map(
        (c) => new Promise((done) => c.client.once("connect", () => done(performance.now()))),
      );
      const crashed = performance.now();
      await first.crash();
      await sleep(gapMs);
      const second = await host.start(serverSpec(transport, tls, { trackFromStart: true }), port);
      const serverBackMs = performance.now() - crashed;
      let timer;
      const times = await Promise.race([
        Promise.all(back),
        new Promise((_, fail) => {
          timer = setTimeout(() => fail(new Error("the storm did not settle in 60 s")), 60_000);
        }),
      ]);
      clearTimeout(timer);
      const allConnectedMs = Math.max(...times) - crashed;
      const sent = await Promise.allSettled(
        clients.map((c, i) => c.client.send(adtMessage(n + i))),
      );
      const allAckedMs = performance.now() - crashed;
      const serverPeak = await second.ask("peak-stop");
      const stats = await second.ask("stats");
      const attempts = clients.map(
        (c, i) => c.client.getStats().reconnectAttempts - attemptsBefore[i],
      );
      await Promise.all(clients.map((c) => c.client.close({ drainTimeoutMs: 1_000 })));
      await second.stop();
      rows.push({
        transport,
        clients: n,
        gapMs,
        serverBackMs,
        reconnected: times.length,
        acked: sent.filter((s) => s.status === "fulfilled").length,
        attempts: attempts.reduce((a, b) => a + b, 0),
        maxAttemptsPerClient: Math.max(...attempts),
        firstConnectedMs: Math.min(...times) - crashed,
        allConnectedMs,
        allAckedMs,
        acceptedByNewServer: stats.acceptedTotal,
        tlsClientErrors: stats.tlsClientErrorsTotal,
        serverPeak,
      });
    }
  }
  return rows;
}

/** The cases, in the order a reading runs them. */
export const CASES = [
  { name: "concurrent connections", run: concurrentConnections },
  { name: "TLS handshake", run: tlsHandshake },
  { name: "TLS throughput", run: tlsThroughput },
  { name: "slow handler", run: slowHandler },
  { name: "reconnect storm", run: reconnectStorm },
];

/** Run one case by name against `mllp`, its servers started by `host`. */
export async function runCase(mllp, host, name, { scale = "full", tls }) {
  const found = CASES.find((c) => c.name === name);
  if (found === undefined) throw new Error(`no such case: ${name}`);
  const rows = await found.run(mllp, host, SCALES[scale], tls);
  return { name, scale, rows };
}

/** heap + outside the heap, as the tables print a peak. */
function split(peak) {
  return `${bytes(peak.heapUsed)} + ${bytes(peak.arrayBuffers)}`;
}

function lat(l) {
  return `${ms(l.p50)} | ${ms(l.p95)} | ${ms(l.p99)}`;
}

/** The Markdown summary of a reading: one table a case. */
export function render(document) {
  const { runner, cpu, logicalCpus } = document.machine;
  const lines = [
    `### Reading: ${document.suite}`,
    "",
    `Node ${document.node} on ${runner} (${cpu}, ${String(logicalCpus)} logical CPUs), ${document.date}. Scale: ${document.scale}.`,
    "",
    "Clients in this process, each server in a child process of its own, on one machine. Latency is from `send()` (or `connect()`) to its ACK (or a connection ready to send), nearest rank. Memory is heap + outside the heap (the Buffer bytes), above a settled baseline.",
  ];
  for (const result of document.cases) {
    lines.push("", `#### ${result.name}`, "");
    if (result.name === "concurrent connections") {
      lines.push(
        "| Transport | Connections | Messages | Msgs/s | p50 | p95 | p99 | Connect all | Server, each idle connection | Server peak | Client peak |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...result.rows.map(
          (r) =>
            `| ${r.transport} | ${String(r.connections)} | ${String(r.acked)}/${String(r.messages)} | ${r.opsPerSec.toFixed(0)} | ${lat(r.latencyMs)} | ${ms(r.connectAllMs)} | ${split(r.serverIdlePerConnection)} | ${split(r.serverPeak)} | ${split(r.clientPeak)} |`,
        ),
      );
    } else if (result.name === "TLS handshake") {
      lines.push(
        "| Transport | Handshakes | One at a time p50 | p95 | p99 | Connections a second, 16 at once | Handshake errors |",
        "| --- | --- | --- | --- | --- | --- | --- |",
        ...result.rows.map(
          (r) =>
            `| ${r.transport} | ${String(r.handshakes)} | ${lat(r.sequentialMs)} | ${r.concurrentPerSec.toFixed(0)} | ${String(r.tlsClientErrors)} |`,
        ),
      );
    } else if (result.name === "TLS throughput") {
      lines.push(
        "| Transport | Case | Messages | Msgs/s | Bytes/s | p50 | p95 | p99 | Sender peak | Receiver peak |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...result.rows.map((r) => {
          const times = (side) =>
            r.peak.per === "message"
              ? `${split(side)} (${(side.total / r.messageBytes).toFixed(2)}x)`
              : `${split(side)} (a round)`;
          return `| ${r.transport} | ${r.label} | ${String(r.acked)}/${String(r.messages)} | ${r.opsPerSec.toFixed(0)} | ${bytes(r.bytesPerSec)}/s | ${lat(r.latencyMs)} | ${times(r.peak.sender)} | ${times(r.peak.receiver)} |`;
        }),
      );
    } else if (result.name === "slow handler") {
      lines.push(
        "| Handler delay | In flight | Messages | Msgs/s | Least | p50 | p95 | p99 | p50 / delay |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...result.rows.map(
          (r) =>
            `| ${String(r.handlerDelayMs)} ms | ${String(r.window)} | ${String(r.acked)}/${String(r.messages)} | ${r.opsPerSec.toFixed(0)} | ${ms(r.latencyMs.min)} | ${lat(r.latencyMs)} | ${r.p50OverDelay === null ? "n/a" : r.p50OverDelay.toFixed(1)} |`,
        ),
      );
    } else if (result.name === "reconnect storm") {
      lines.push(
        "Times are from the moment the server was killed; it listens again after the gap, plus its start.",
        "",
        "| Transport | Clients | Server back | First back | All back | All answered | Attempts | Most by one client | Accepted | Handshake errors | New server peak |",
        "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
        ...result.rows.map(
          (r) =>
            `| ${r.transport} | ${String(r.reconnected)}/${String(r.clients)} | ${ms(r.serverBackMs)} | ${ms(r.firstConnectedMs)} | ${ms(r.allConnectedMs)} | ${String(r.acked)} in ${ms(r.allAckedMs)} | ${String(r.attempts)} | ${String(r.maxAttemptsPerClient)} | ${String(r.acceptedByNewServer)} | ${String(r.tlsClientErrors)} | ${split(r.serverPeak)} |`,
        ),
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

async function main(values) {
  const mllp = await import(pathToFileURL(resolve(values.target)).href);
  if (typeof globalThis.gc !== "function") {
    throw new Error("run with --expose-gc: the memory measures need gc()");
  }
  const scale = values.quick ? "quick" : "full";
  const tls = tlsMaterial();
  const host = childHost(values.target);
  const names = values.only === undefined ? CASES.map((c) => c.name) : [values.only];
  const cases = [];
  for (const name of names) {
    process.stderr.write(`[socket-cases] ${name}\n`);
    cases.push(await runCase(mllp, host, name, { scale, tls }));
  }
  const document = {
    suite: "@cosyte/mllp socket-path cases over 127.0.0.1",
    node: process.version,
    machine: machine(),
    date: new Date().toISOString(),
    scale,
    cases,
  };
  const summary = render(document);
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "socket-cases.json"), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, "socket-cases.md"), summary);
  process.stdout.write(summary);
}

/** The child process a `childHost` server runs in. */
async function serve(values) {
  const mllp = await import(pathToFileURL(resolve(values.target)).href);
  const { port, ...spec } = JSON.parse(values.serve);
  const s = await listen(mllp, spec, port);
  // The parent may die before it sends "stop": leave with it, never keep listening.
  process.on("disconnect", () => process.exit(0));
  process.on("message", (request) => {
    if (request.type === "stop") {
      s.peaks.stop();
      void s.server.close({ drainTimeoutMs: 1_000 }).then(() => process.exit(0));
    } else void s.answer(request.type).then((body) => process.send({ id: request.id, ...body }));
  });
  process.send({ type: "ready", port: s.port });
}

// Run as a script, not imported by the test.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(resolve(entry)).href === import.meta.url) {
  const { values } = parseArgs({
    options: {
      serve: { type: "string" },
      out: { type: "string", default: "bench-results/socket-cases" },
      target: { type: "string", default: "dist/index.mjs" },
      quick: { type: "boolean", default: false },
      only: { type: "string" },
    },
  });
  if (values.serve !== undefined) await serve(values);
  else await main(values);
}
