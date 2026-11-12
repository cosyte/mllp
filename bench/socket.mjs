// The same traffic as `mllp.bench.mjs`, over a real 127.0.0.1 socket: a server from
// `createStarterServer` in a child process, a client from `createStarterClient` in this one, and
// every send resolved by the ACK the server's auto-ACK writes back.
//
//   pnpm build && pnpm bench:socket [--out <dir>] [--target <entry>] [--quick]
//
// @cosyte/bench times a synchronous call and cannot wait for a socket, so this script measures the
// asynchronous path itself, with the same kinds of number: throughput, latency per send (from the
// `send()` call to its ACK) at p50, p95 and p99, the peak memory of each side as a multiple of the
// message, and a long run that checks each side's settled memory stays flat. The server runs in its
// own process so the receive side's memory is measured apart from the sender's.
//
// Memory is reported in two parts: the V8 heap, and the memory outside it that holds a Buffer's
// bytes (`arrayBuffers`). A frame on its way through this package is almost all the second.
//
// Every message is synthetic and built in code by `corpus.mjs`. The output names sizes, counts,
// timings and the machine (CPU model, cores, Node, runner image), never a host name or a path.

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { KIB, MIB, adtMessage, documentMessage, oruMessage } from "./corpus.mjs";
import {
  bytes,
  machine,
  median,
  ms,
  peakTracker,
  quantile,
  settle,
  theilSen,
  topPeak,
} from "./socket-measure.mjs";

const { values } = parseArgs({
  options: {
    serve: { type: "boolean", default: false },
    out: { type: "string", default: "bench-results/socket" },
    target: { type: "string", default: "dist/index.mjs" },
    quick: { type: "boolean", default: false },
  },
});

const mllp = await import(pathToFileURL(resolve(values.target)).href);

if (typeof globalThis.gc !== "function") {
  throw new Error("run with --expose-gc: the memory measures need gc()");
}

// The server side: listen, answer every message with the auto-ACK, and report memory when asked.
if (values.serve) {
  const peaks = peakTracker();
  const server = await mllp.createStarterServer({
    host: "127.0.0.1",
    port: 0,
    onMessage: () => {
      peaks.sample();
    },
  });
  // The parent may die before it sends "stop" (a throw in main): leave with it, never keep listening.
  process.on("disconnect", () => process.exit(0));
  process.on("message", (request) => {
    const reply = (body) => process.send({ id: request.id, ...body });
    if (request.type === "settle") void settle().then(reply);
    else if (request.type === "peak-start") void peaks.start().then(() => reply({}));
    else if (request.type === "peak-stop") reply(peaks.stop());
    else if (request.type === "stop") void server.close().then(() => process.exit(0));
  });
  process.send({ type: "ready", port: server.getStats().port });
} else {
  await main();
}

async function main() {
  const quick = values.quick;
  const child = fork(fileURLToPath(import.meta.url), ["--serve", "--target", values.target], {
    execArgv: ["--expose-gc"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  let nextId = 0;
  const waiting = new Map();
  const ready = new Promise((done) => {
    child.on("message", (message) => {
      if (message.type === "ready") done(message.port);
      else {
        waiting.get(message.id)?.(message);
        waiting.delete(message.id);
      }
    });
  });
  const ask = (type) =>
    new Promise((done) => {
      const id = ++nextId;
      waiting.set(id, done);
      child.send({ id, type });
    });

  const port = await ready;
  const client = await mllp.createStarterClient({
    host: "127.0.0.1",
    port,
    autoReconnect: false,
    highWaterMark: 64,
  });
  const peaks = peakTracker();

  /** Send `payloads` with at most `window` awaiting their ACK; the latency of each, and the time. */
  async function run(payloads, window) {
    const latencies = new Array(payloads.length);
    let next = 0;
    const start = performance.now();
    const lane = async () => {
      while (next < payloads.length) {
        const k = next++;
        const t0 = performance.now();
        await client.send(payloads[k]);
        latencies[k] = performance.now() - t0;
        peaks.sample();
      }
    };
    await Promise.all(Array.from({ length: window }, lane));
    return { elapsed: performance.now() - start, latencies };
  }

  const cases = [
    {
      label: "ADT^A01, 280 B, 64 in flight",
      make: (i) => adtMessage(i),
      count: quick ? 2_000 : 20_000,
      window: 64,
      rounds: 3,
    },
    {
      label: "ADT^A01, 280 B, one at a time",
      make: (i) => adtMessage(i),
      count: quick ? 1_000 : 5_000,
      window: 1,
      rounds: 3,
    },
    {
      label: "ORU^R01, 32 KiB, one at a time",
      make: (i) => oruMessage(i, 32 * KIB),
      count: quick ? 200 : 1_000,
      window: 1,
      rounds: 3,
    },
    {
      label: "MDM^T02, 1 MiB base64, one at a time",
      make: (i) => documentMessage(i, MIB),
      count: quick ? 5 : 20,
      window: 1,
      rounds: 3,
      distinct: 4,
    },
    {
      label: "MDM^T02, 4 MiB base64, one at a time",
      make: (i) => documentMessage(i, 4 * MIB),
      count: quick ? 3 : 10,
      window: 1,
      rounds: 3,
      distinct: 2,
    },
  ];

  // The floor of the peak measure: what each side reads with nothing sent at all, over as long as
  // one small send takes, the median of eight windows each settled first. A peak near it is the
  // measuring, not the package.
  const idle = { sender: [], receiver: [] };
  for (let k = 0; k < 8; k++) {
    await peaks.start();
    await ask("peak-start");
    await new Promise((done) => setTimeout(done, 2));
    idle.sender.push(peaks.stop().total);
    idle.receiver.push((await ask("peak-stop")).total);
  }
  const floor = { sender: median(idle.sender), receiver: median(idle.receiver) };

  const results = [];
  let beforeLarge = null;
  for (const c of cases) {
    const distinct = Array.from({ length: c.distinct ?? Math.min(c.count, 256) }, (_, i) =>
      c.make(i),
    );
    const payloads = Array.from({ length: c.count }, (_, i) => distinct[i % distinct.length]);
    const size = distinct[0].length;
    // The receiver's settled memory before the first document message (a 1 MiB one is a few bytes
    // under 1 MiB), to read what it still holds after the last.
    if (size > MIB / 2 && beforeLarge === null) beforeLarge = await ask("settle");
    await run(payloads.slice(0, Math.max(1, Math.floor(payloads.length / 4))), c.window); // warm
    const rates = [];
    const latencies = [];
    for (let r = 0; r < c.rounds; r++) {
      const { elapsed, latencies: round } = await run(payloads, c.window);
      rates.push((payloads.length / elapsed) * 1000);
      latencies.push(...round);
    }
    // Memory apart from the timed rounds, so the sampling does not tax them. One message at a
    // time: each side settled before each send, and the highest peak of any one send kept, as
    // @cosyte/bench takes its peak per call. Many in flight: the peak over one whole round.
    const peak = { per: c.window === 1 ? "message" : "round", sender: null, receiver: null };
    const batches = c.window === 1 ? distinct.slice(0, 8).map((p) => [p]) : [payloads];
    for (const batch of batches) {
      await peaks.start();
      await ask("peak-start");
      await run(batch, c.window);
      peak.sender = topPeak(peak.sender, peaks.stop());
      const { id: _id, ...receiver } = await ask("peak-stop");
      peak.receiver = topPeak(peak.receiver, receiver);
    }
    latencies.sort((a, b) => a - b);
    const opsPerSec = median(rates);
    results.push({
      label: c.label,
      messageBytes: size,
      messages: payloads.length,
      opsPerSec,
      bytesPerSec: opsPerSec * size,
      latencyMs: {
        p50: quantile(latencies, 0.5),
        p95: quantile(latencies, 0.95),
        p99: quantile(latencies, 0.99),
      },
      peak,
    });
  }
  const afterLarge = await ask("settle");

  // The long run: rounds of small sends with each side's memory settled after every round. The
  // slope over the last 24 rounds is how fast settled memory grows; 64 KiB over the run is growing.
  const longRounds = 30;
  const settleRounds = 6;
  const perRound = quick ? 500 : 2_000;
  const longPayloads = Array.from({ length: perRound }, (_, i) => adtMessage(i));
  const sender = [];
  const receiver = [];
  for (let r = 0; r < longRounds; r++) {
    await run(longPayloads, 64);
    const s = await settle();
    const t = await ask("settle");
    sender.push(s.heapUsed + s.arrayBuffers);
    receiver.push(t.heapUsed + t.arrayBuffers);
  }
  const measured = longRounds - settleRounds;
  const growth = (series) => theilSen(series.slice(settleRounds)) * (measured - 1);
  const longRun = {
    rounds: longRounds,
    messagesPerRound: perRound,
    sender: { growthBytes: growth(sender), perOpBytes: growth(sender) / (measured * perRound) },
    receiver: {
      growthBytes: growth(receiver),
      perOpBytes: growth(receiver) / (measured * perRound),
    },
  };

  await client.close({ drainTimeoutMs: 1_000 });
  // The server answers a stop by exiting, not with a reply.
  const exited = new Promise((done) => child.once("exit", done));
  child.send({ id: ++nextId, type: "stop" });
  await exited;

  const host = machine();
  const { runner, cpu } = host;
  const document = {
    suite: "@cosyte/mllp over a 127.0.0.1 socket",
    node: process.version,
    machine: host,
    date: new Date().toISOString(),
    cases: results,
    peakFloor: floor,
    retainedAfterLargeMessages: {
      receiverHeapBytes: afterLarge.heapUsed - beforeLarge.heapUsed,
      receiverOutsideHeapBytes: afterLarge.arrayBuffers - beforeLarge.arrayBuffers,
    },
    longRun,
  };

  const flat = (side) =>
    `${Math.abs(side.growthBytes) < 64 * KIB ? "flat" : "growing"} (${bytes(side.growthBytes)} over ${String(measured * perRound)} sends, ${side.perOpBytes.toFixed(3)} B/send)`;
  const times = (r, side) => {
    const peak = r.peak[side];
    const split = `${bytes(peak.heapUsed)} + ${bytes(peak.arrayBuffers)}`;
    if (r.peak.per !== "message") return `${split} (a round)`;
    return `${split} (${(peak.total / r.messageBytes).toFixed(2)}x)`;
  };
  const lines = [
    `### Reading: ${document.suite}`,
    "",
    `Node ${document.node} on ${runner} (${cpu}, ${String(document.machine.logicalCpus)} logical CPUs), ${document.date}.`,
    "",
    "Client and server in two processes on one machine. Throughput is the median of three timed rounds; latency is from `send()` to its ACK, nearest rank over all three. Peak is the most memory each side held above its settled baseline, as heap + outside the heap: one message at a time, the highest of eight sends each settled first, and as a multiple of the message; 64 in flight, over one whole round, garbage not yet collected included.",
    "",
    "| Case | Messages | Msgs/s | Bytes/s | p50 | p95 | p99 | Sender peak | Receiver peak |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${r.label} | ${String(r.messages)} | ${r.opsPerSec.toFixed(0)} | ${bytes(r.bytesPerSec)}/s | ${ms(r.latencyMs.p50)} | ${ms(r.latencyMs.p95)} | ${ms(r.latencyMs.p99)} | ${times(r, "sender")} | ${times(r, "receiver")} |`,
    ),
    "",
    `The peak measure's floor, nothing sent, median of eight windows: sender ${bytes(floor.sender)}, receiver ${bytes(floor.receiver)}.`,
    "",
    `Receiver memory still held, settled, after the large messages, with the connection open: ${bytes(document.retainedAfterLargeMessages.receiverHeapBytes)} heap, ${bytes(document.retainedAfterLargeMessages.receiverOutsideHeapBytes)} outside the heap.`,
    "",
    `Long run, ${String(longRounds)} rounds of ${String(perRound)} ADT^A01 sends, 64 in flight: sender ${flat(longRun.sender)}; receiver ${flat(longRun.receiver)}.`,
  ];
  const summary = `${lines.join("\n")}\n`;
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "socket.json"), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, "socket.md"), summary);
  process.stdout.write(summary);
}
