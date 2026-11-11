// Acknowledgment latency at a fixed send rate, over a real 127.0.0.1 socket, with TCP_NODELAY in
// three states: the package's default, the `noDelay: false` option on client and server, and set
// by this script on the raw sockets from outside the package.
//
//   pnpm build && pnpm bench:open-loop [--out <dir>] [--target <entry>] [--quick]
//
// Open loop: each message is sent when it is due, whether or not the earlier ones have been
// answered, and its latency runs from when it was due to its ACK. Messages arrive as a Poisson
// process at 100, 200 and 400 a second (random gaps from a fixed seed, so every run sends the same
// schedule), as independent senders do: evenly spaced messages each answered before the next never
// put two ACKs in flight at once, and so never meet Nagle's algorithm. A server from `createServer`
// in a child process answers every message with the auto-ACK after an asynchronous commit step, as
// an engine that stores each message does; the client from `createClient` sends from this one, over
// plain TCP and over TLS.
//
// What it is for: with Nagle's algorithm on, a small write that finds unacknowledged data in flight
// waits for the peer's ACK, and Linux delays that ACK by up to about 40 ms. The third state works on
// any build, so a run of a build that never sets TCP_NODELAY shows what setting it changes; on a
// build that does, the `noDelay: false` state shows what turning it back off costs. A build that
// does not know the option ignores it, so that state reads the same as the default there.
//
// Every message is synthetic and built in code by `corpus.mjs`. The output names rates, counts,
// timings and the machine (CPU model, cores, Node, runner image), never a host name or a path.

import { fork } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, platform, arch } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { generate } from "selfsigned";

import { adtMessage } from "./corpus.mjs";

const { values } = parseArgs({
  options: {
    serve: { type: "string" },
    out: { type: "string", default: "bench-results/open-loop" },
    target: { type: "string", default: "dist/index.mjs" },
    quick: { type: "boolean", default: false },
  },
});

const mllp = await import(pathToFileURL(resolve(values.target)).href);

/** The three TCP_NODELAY states, by what each passes to client and server. */
const MODES = [
  { key: "default", label: "package default", option: {}, outside: false },
  { key: "off", label: "`noDelay: false` option", option: { noDelay: false }, outside: false },
  { key: "outside", label: "TCP_NODELAY set from outside", option: {}, outside: true },
];

// The server side: listen with the mode's options, answer every message with the auto-ACK.
if (values.serve !== undefined) {
  const { mode, tls } = JSON.parse(values.serve);
  const chosen = MODES.find((m) => m.key === mode);
  const server = mllp.createServer({
    autoAck: "AA",
    // The commit step: the ACK waits for it, as it waits for a store in an engine.
    onMessage: () => new Promise((done) => setImmediate(done)),
    ...chosen.option,
    ...(tls === undefined ? {} : { tls }),
  });
  if (chosen.outside) {
    // The listening socket is the package's own; 'connection' hands over each raw TCP socket, on
    // a TLS server too, before the package sees it.
    server._netServer.on("connection", (socket) => socket.setNoDelay(true));
  }
  await server.listen(0, "127.0.0.1");
  process.on("disconnect", () => process.exit(0));
  process.on("message", (request) => {
    if (request.type === "stop") void server.close().then(() => process.exit(0));
  });
  process.send({ type: "ready", port: server.getStats().port });
} else {
  await main();
}

/** The value at quantile `q` of sorted `xs`, nearest rank. */
function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

function ms(x) {
  return `${x.toFixed(2)} ms`;
}

/** Starts a server for `mode` in a child process; its port and a stop function. */
async function startServer(mode, tls) {
  const child = fork(
    fileURLToPath(import.meta.url),
    ["--serve", JSON.stringify({ mode, tls }), "--target", values.target],
    { stdio: ["ignore", "inherit", "inherit", "ipc"] },
  );
  const port = await new Promise((done, fail) => {
    child.once("error", fail);
    child.on("message", (message) => {
      if (message.type === "ready") done(message.port);
    });
  });
  return {
    port,
    async stop() {
      const exited = new Promise((done) => child.once("exit", done));
      child.send({ type: "stop" });
      await exited;
    },
  };
}

/** A small seeded generator (mulberry32): the same gaps on every run. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Sends `count` messages at an average `rate` a second, Poisson arrivals, open loop; each one's
 * latency from when it was due to its ACK.
 */
async function openLoop(client, rate, count) {
  const latencies = [];
  const pending = [];
  const next = random(rate * 7919 + count);
  let failed = 0;
  let due = performance.now();
  for (let n = 0; n < count; n++) {
    due += (-Math.log(1 - next()) * 1000) / rate;
    // A timer for the whole milliseconds, which may wake up to one early, then a spin for what is
    // left of it: a message sent before it is due would read as faster than it was.
    const wait = Math.floor(due - performance.now());
    if (wait >= 1) await new Promise((done) => setTimeout(done, wait));
    while (performance.now() < due) {
      // Under a millisecond.
    }
    const sentDue = due;
    pending.push(
      client.send(adtMessage(n)).then(
        () => latencies.push(performance.now() - sentDue),
        () => {
          failed += 1;
        },
      ),
    );
  }
  await Promise.all(pending);
  latencies.sort((a, b) => a - b);
  return {
    messages: count,
    failed,
    p50: quantile(latencies, 0.5),
    p90: quantile(latencies, 0.9),
    p99: quantile(latencies, 0.99),
    max: latencies[latencies.length - 1],
    over20ms: latencies.filter((x) => x > 20).length,
  };
}

async function main() {
  const quick = values.quick;
  const seconds = quick ? 2 : 8;
  const rates = [100, 200, 400];
  const rounds = 2;

  // A throwaway certificate for this run, made in memory, never written.
  const pems = generate([{ name: "commonName", value: "localhost" }], {
    keySize: 2048,
    days: 1,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }] }],
  });
  const transports = [
    { label: "TCP", server: undefined, client: undefined, host: "127.0.0.1" },
    {
      label: "TLS",
      server: { cert: pems.cert, key: pems.private },
      client: { ca: pems.cert },
      host: "localhost",
    },
  ];

  const results = [];
  // Rounds outermost, so each state is read more than once at different moments of the run.
  for (let round = 1; round <= rounds; round++) {
    for (const transport of transports) {
      for (const mode of MODES) {
        const server = await startServer(mode.key, transport.server);
        const client = mllp.createClient({
          host: transport.host,
          port: server.port,
          autoReconnect: false,
          highWaterMark: 4096,
          ...mode.option,
          ...(transport.client === undefined ? {} : { tls: transport.client }),
        });
        await client.connect();
        if (mode.outside) client._socket.setNoDelay(true);
        // Warm the connection and the code path before anything is timed.
        await openLoop(client, 200, 200);
        for (const rate of rates) {
          const reading = await openLoop(client, rate, rate * seconds);
          results.push({ round, transport: transport.label, mode: mode.label, rate, ...reading });
        }
        await client.close({ drainTimeoutMs: 1_000 });
        await server.stop();
      }
    }
  }

  const cpu = cpus()[0]?.model ?? "unknown CPU";
  const runner = process.env.ImageOS
    ? `GitHub-hosted ${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim()
    : `local-${platform()}-${arch()}`;
  const document = {
    suite: "@cosyte/mllp open-loop acknowledgment latency over a 127.0.0.1 socket",
    node: process.version,
    machine: { runner, cpu, logicalCpus: cpus().length },
    date: new Date().toISOString(),
    secondsPerRate: seconds,
    results,
  };
  const lines = [
    `### Reading: ${document.suite}`,
    "",
    `Node ${document.node} on ${runner} (${cpu}, ${String(document.machine.logicalCpus)} logical CPUs), ${document.date}.`,
    "",
    `Client and server in two processes on one machine. Each rate runs ${String(seconds)} seconds, open loop, Poisson arrivals from a fixed seed, and the server answers after an asynchronous commit step; latency is from when a message was due to its ACK, nearest rank. Every state is read in each of ${String(rounds)} rounds.`,
    "",
    "| Round | Transport | TCP_NODELAY | Msgs/s | Messages | Failed | p50 | p90 | p99 | Max | Over 20 ms |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...results.map(
      (r) =>
        `| ${String(r.round)} | ${r.transport} | ${r.mode} | ${String(r.rate)} | ${String(r.messages)} | ${String(r.failed)} | ${ms(r.p50)} | ${ms(r.p90)} | ${ms(r.p99)} | ${ms(r.max)} | ${String(r.over20ms)} |`,
    ),
  ];
  const summary = `${lines.join("\n")}\n`;
  const outDir = resolve(values.out);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "open-loop.json"), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(outDir, "open-loop.md"), summary);
  process.stdout.write(summary);
}
