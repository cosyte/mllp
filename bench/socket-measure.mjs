// The measuring helpers the socket benchmarks share: `socket.mjs` and `socket-cases.mjs`.
//
// Memory is read in two parts: the V8 heap (`heapUsed`), and the memory outside it that holds a
// Buffer's bytes (`arrayBuffers`). A frame on its way through this package is almost all the
// second, so every figure here counts both.

import { cpus, platform, arch } from "node:os";

import { KIB, MIB } from "./corpus.mjs";

/**
 * Collect until a round frees less than 64 KiB, twice running, letting freed buffers go between.
 * A run calls this with `--expose-gc`; without `gc()` (a test) it only lets the event loop turn.
 */
export async function settle() {
  let quiet = 0;
  let last = process.memoryUsage();
  for (let round = 0; round < 30 && quiet < 2; round++) {
    globalThis.gc?.();
    await new Promise((done) => setImmediate(done));
    const now = process.memoryUsage();
    const freed = last.heapUsed + last.arrayBuffers - (now.heapUsed + now.arrayBuffers);
    quiet = freed < 64 * KIB ? quiet + 1 : 0;
    last = now;
  }
  return { heapUsed: last.heapUsed, arrayBuffers: last.arrayBuffers };
}

/**
 * The highest heap and outside-heap memory seen since `start`, above the settled baseline: sampled
 * every millisecond, and whenever `sample()` is called at a moment a peak is likely (a frame just
 * delivered, a send just resolved). `startNow` takes the baseline as it is, without settling, for a
 * moment that cannot wait (a server that must listen at once).
 */
export function peakTracker() {
  let base = null;
  let peak = { heapUsed: 0, arrayBuffers: 0, total: 0 };
  let timer = null;
  const sample = () => {
    if (base === null) return;
    const now = process.memoryUsage();
    const heapUsed = now.heapUsed - base.heapUsed;
    const arrayBuffers = now.arrayBuffers - base.arrayBuffers;
    peak = {
      heapUsed: Math.max(peak.heapUsed, heapUsed),
      arrayBuffers: Math.max(peak.arrayBuffers, arrayBuffers),
      total: Math.max(peak.total, heapUsed + arrayBuffers),
    };
  };
  const begin = (from) => {
    clearInterval(timer);
    base = from;
    peak = { heapUsed: 0, arrayBuffers: 0, total: 0 };
    timer = setInterval(sample, 1);
  };
  return {
    sample,
    async start() {
      begin(await settle());
    },
    startNow() {
      const now = process.memoryUsage();
      begin({ heapUsed: now.heapUsed, arrayBuffers: now.arrayBuffers });
    },
    stop() {
      sample();
      clearInterval(timer);
      timer = null;
      base = null;
      return peak;
    },
  };
}

/** The higher of two peaks, figure by figure; `a` may be null. */
export function topPeak(a, b) {
  if (a === null) return b;
  return {
    heapUsed: Math.max(a.heapUsed, b.heapUsed),
    arrayBuffers: Math.max(a.arrayBuffers, b.arrayBuffers),
    total: Math.max(a.total, b.total),
  };
}

/** The value at quantile `q` of sorted `xs`, nearest rank; null without 10 values above it. */
export function quantile(sorted, q) {
  if (sorted.length * (1 - q) < 10) return null;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}

/** p50, p95 and p99 of `xs`, nearest rank, with the least and the most. */
export function percentiles(xs) {
  const sorted = [...xs].sort((a, b) => a - b);
  return {
    min: sorted[0] ?? null,
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    p99: quantile(sorted, 0.99),
    max: sorted[sorted.length - 1] ?? null,
  };
}

/** The median of `xs`. */
export function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** The Theil-Sen slope of `ys` over their index: the median of every pairwise slope. */
export function theilSen(ys) {
  const slopes = [];
  for (let i = 0; i < ys.length; i++) {
    for (let j = i + 1; j < ys.length; j++) slopes.push((ys[j] - ys[i]) / (j - i));
  }
  return median(slopes);
}

export function ms(x) {
  if (x === null) return "n/a";
  return x >= 1 ? `${x.toFixed(3)} ms` : `${(x * 1000).toFixed(1)} us`;
}

export function bytes(x) {
  const sign = x < 0 ? "-" : "";
  const a = Math.abs(x);
  if (a >= MIB) return `${sign}${(a / MIB).toFixed(2)} MiB`;
  if (a >= KIB) return `${sign}${(a / KIB).toFixed(1)} KiB`;
  return `${sign}${String(Math.round(a))} B`;
}

/** The machine a reading ran on: CPU model, cores and runner image, never a host name or a path. */
export function machine() {
  const cpu = cpus()[0]?.model ?? "unknown CPU";
  const runner = process.env.ImageOS
    ? `GitHub-hosted ${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim()
    : `local-${platform()}-${arch()}`;
  return { runner, cpu, logicalCpus: cpus().length };
}
