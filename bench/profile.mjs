// A CPU profile and a sampled heap profile of the hottest paths, against the built entry.
//
//   pnpm build && pnpm bench:profile [--out <dir>] [--target <entry>] [--seconds <n>]
//
// Each path runs warm for at least the given seconds under the V8 sampling profiler, then again
// under the sampling heap profiler. The raw profiles are written to the out directory
// (`.cpuprofile` and `.heapprofile` open in Chrome DevTools), and a Markdown summary of the
// functions with the most self time and the allocation sites with the most bytes goes to standard
// output and to `profile.md` beside them. Every message is synthetic and built in code by
// `corpus.mjs`; a profile names functions and lines of the library, never an input.

import { mkdirSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { MIB, SOCKET_READ_BYTES, adtMessage, documentMessage, frame, reads } from "./corpus.mjs";
import { counting, roundTrip, splitReads } from "./mllp.bench.mjs";

const { values } = parseArgs({
  options: {
    out: { type: "string", default: "bench-results/profile" },
    target: { type: "string", default: "dist/index.mjs" },
    seconds: { type: "string", default: "2" },
  },
});
const outDir = resolve(values.out);
const minMs = Number(values.seconds) * 1000;
const mllp = await import(pathToFileURL(resolve(values.target)).href);

const big = documentMessage(0, 4 * MIB);
const bigFrame = frame(big);
const bigReads = reads(bigFrame, SOCKET_READ_BYTES);
const adts = Array.from({ length: 64 }, (_, i) => adtMessage(i));
const adtReads = splitReads(adts);
const decoder = counting(mllp);
const exchange = roundTrip(mllp);

/** A client and a server on 127.0.0.1 in this process, for the socket path. */
const server = await mllp.createStarterServer({ host: "127.0.0.1", port: 0, onMessage: () => {} });
const client = await mllp.createStarterClient({
  host: "127.0.0.1",
  port: server.getStats().port,
  autoReconnect: false,
  highWaterMark: 64,
});

/** 640 ADT^A01 sends with 64 awaiting their ACK at a time. */
async function socketStream() {
  let next = 0;
  const lane = async () => {
    while (next < 640) await client.send(adts[next++ % adts.length]);
  };
  await Promise.all(Array.from({ length: 64 }, lane));
}

/**
 * The hottest paths: the large opaque frame each way, whole and in the reads a socket hands up
 * (a frame across reads is gathered and joined, one in a single read is copied out of it), the
 * small-message stream, and a socket.
 */
const PATHS = [
  {
    name: "decode-4mib",
    what: "FrameReader, a 4 MiB base64 document in one read",
    run: () => decoder.reader.push(bigFrame),
  },
  {
    name: "decode-4mib-reads",
    what: "FrameReader, a 4 MiB base64 document in 64 KiB reads",
    run: () => {
      for (const chunk of bigReads) decoder.reader.push(chunk);
    },
  },
  {
    name: "decode-adt-split",
    what: "FrameReader, 64 ADT^A01 in 1,460 byte reads",
    run: () => {
      for (const chunk of adtReads) decoder.reader.push(chunk);
    },
  },
  {
    name: "encode-4mib",
    what: "encodeFrame, a 4 MiB base64 document",
    run: () => mllp.encodeFrame(big),
  },
  {
    name: "connection-adt",
    what: "Connection, send then ACK, 64 ADT^A01 over the loopback transport",
    run: () => {
      for (const adt of adts) exchange(adt);
    },
  },
  {
    name: "socket-adt",
    what: "client and server over 127.0.0.1, 640 ADT^A01 sends, 64 in flight",
    run: socketStream,
  },
];

/** Run `fn` until `minMs` have passed, at least three times; return the calls made. */
async function repeat(fn) {
  let calls = 0;
  const start = performance.now();
  while (calls < 3 || performance.now() - start < minMs) {
    await fn();
    calls++;
  }
  return calls;
}

/** Where a call frame is, relative to the target's directory. */
function where(frame) {
  const file = frame.url === "" ? "(native)" : frame.url.slice(frame.url.lastIndexOf("/") + 1);
  return `${file}:${String(frame.lineNumber + 1)}`;
}

/** The functions with the most self time in a CPU profile, as rows of a table. */
function topSelfTime(profile, count) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  const deltas = profile.timeDeltas;
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    const dt = deltas[i] ?? 0;
    const callFrame = node.callFrame;
    // The profiler's own messages are not the library's time.
    if (callFrame.url.startsWith("node:inspector")) return;
    total += dt;
    const key = `${callFrame.functionName || "(anonymous)"} ${where(callFrame)}`;
    self.set(key, (self.get(key) ?? 0) + dt);
  });
  return [...self.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, us]) => `| ${key} | ${((100 * us) / total).toFixed(1)}% |`);
}

/** The allocation sites with the most sampled bytes in a heap profile, as rows of a table. */
function topAllocations(profile, count) {
  const sites = new Map();
  let total = 0;
  const walk = (node) => {
    const callFrame = node.callFrame;
    if (!callFrame.url.startsWith("node:inspector")) {
      const key = `${callFrame.functionName || "(anonymous)"} ${where(callFrame)}`;
      sites.set(key, (sites.get(key) ?? 0) + node.selfSize);
      total += node.selfSize;
    }
    for (const child of node.children) walk(child);
  };
  walk(profile.head);
  return [...sites.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, count)
    .map(([key, bytes]) => `| ${key} | ${((100 * bytes) / total).toFixed(1)}% |`);
}

mkdirSync(outDir, { recursive: true });
const session = new Session();
session.connect();
await session.post("Profiler.enable");
await session.post("Profiler.setSamplingInterval", { interval: 100 });
await session.post("HeapProfiler.enable");

const lines = [
  "### Profile: @cosyte/mllp",
  "",
  `Node ${process.version} on ${process.platform}-${process.arch}, ${new Date().toISOString()}.`,
  "Self time is the share of CPU samples taken in that function; allocations are the share of",
  "bytes the sampling heap profiler attributed to that site, on the V8 heap (a Buffer's bytes are",
  "outside it). Both are over every call of the path.",
];
for (const path of PATHS) {
  await repeat(path.run); // warm
  await session.post("Profiler.start");
  const start = performance.now();
  const calls = await repeat(path.run);
  const perCall = (performance.now() - start) / calls;
  const { profile } = await session.post("Profiler.stop");
  writeFileSync(join(outDir, `${path.name}.cpuprofile`), JSON.stringify(profile));

  // Every sampled allocation, including what the collector has already freed: the bytes a path
  // allocates, not only what is still live when the sampling stops.
  await session.post("HeapProfiler.startSampling", {
    samplingInterval: 4096,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  await repeat(path.run);
  const { profile: heap } = await session.post("HeapProfiler.stopSampling");
  writeFileSync(join(outDir, `${path.name}.heapprofile`), JSON.stringify(heap));

  lines.push(
    "",
    `#### ${path.what} (${String(calls)} calls, ${perCall.toFixed(3)} ms each under the profiler)`,
    "",
    "| Function, self time | Share |",
    "| --- | --- |",
    ...topSelfTime(profile, 12),
    "",
    "| Allocation site | Share |",
    "| --- | --- |",
    ...topAllocations(heap, 8),
  );
}
session.disconnect();
await client.close({ drainTimeoutMs: 1_000 });
await server.close({ drainTimeoutMs: 1_000 });

const summary = `${lines.join("\n")}\n`;
writeFileSync(join(outDir, "profile.md"), summary);
process.stdout.write(summary);
