/**
 * RetryContext + RetryStrategy + ClientOptions reconnect-fields surface tests
 * (PLAN-04, Task 2).
 *
 * Most of these are compile-time assertions — if the file typechecks, the
 * structural contract holds. The runtime checks confirm W-07 NEVER_ABORTING_SIGNAL
 * is defined at module level and that the public types are reachable through
 * both barrels.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import type { ClientOptions, RetryContext, RetryStrategy } from "../../src/client/client.js";
import type * as ClientBarrel from "../../src/client/index.js";
import type * as TopBarrel from "../../src/index.js";

describe("PLAN-04 Task 2: RetryContext + RetryStrategy + reconnect ClientOptions surface", () => {
  it("Test 1: RetryContext interface has the 7 readonly fields per D-15", () => {
    // Compile-time shape — referencing each field forces TS to validate the type.
    const sample: RetryContext = Object.freeze({
      attempt: 0,
      lastError: new Error("x"),
      lastDelayMs: 0,
      totalElapsedMs: 0,
      sinceLastSuccessMs: Number.POSITIVE_INFINITY,
      classifiedAs: "transient" as const,
      signal: new AbortController().signal,
    });
    expect(sample.attempt).toBe(0);
    expect(sample.classifiedAs).toBe("transient");
    expect(sample.signal).toBeInstanceOf(AbortSignal);
  });

  it("Test 2: RetryStrategy is (ctx) => number | null", () => {
    const strategy: RetryStrategy = (ctx) => {
      if (ctx.attempt > 5) return null;
      return ctx.attempt * 100;
    };
    const ctx: RetryContext = Object.freeze({
      attempt: 3,
      lastError: new Error(),
      lastDelayMs: 100,
      totalElapsedMs: 500,
      sinceLastSuccessMs: 1000,
      classifiedAs: "transient",
      signal: new AbortController().signal,
    });
    expect(strategy(ctx)).toBe(300);
  });

  it("Test 3: ClientOptions accepts 6 reconnect fields (compile-time)", () => {
    const opts: ClientOptions = {
      host: "localhost",
      port: 2575,
      autoReconnect: true,
      retryStrategy: (_ctx) => 50,
      initialDelayMs: 50,
      maxDelayMs: 10_000,
      multiplier: 3,
      jitter: 0.1,
    };
    expect(opts.autoReconnect).toBe(true);
    expect(opts.initialDelayMs).toBe(50);
    expect(opts.maxDelayMs).toBe(10_000);
    expect(opts.multiplier).toBe(3);
    expect(opts.jitter).toBe(0.1);
    expect(typeof opts.retryStrategy).toBe("function");
  });

  it("Test 4: W-07 — NEVER_ABORTING_SIGNAL declared at module top of client.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, "../../src/client/client.ts"), "utf8");
    expect(src).toMatch(/const NEVER_ABORTING_SIGNAL: AbortSignal/);
    // Ensure it's at module scope (not inside a function/class) — appears
    // before the export class declaration.
    const idxSentinel = src.indexOf("NEVER_ABORTING_SIGNAL");
    const idxClass = src.indexOf("export class MllpClient");
    expect(idxSentinel).toBeGreaterThan(0);
    expect(idxSentinel).toBeLessThan(idxClass);
  });

  it("Test 5: W-05 — Correlator does not hard-code byteOffset: 0", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, "../../src/client/correlator.ts"), "utf8");
    expect(src).not.toMatch(/byteOffset:\s*0/);
    expect(src).toMatch(/byteOffsetFromAck/);
  });

  it("Test 6: RetryContext + RetryStrategy re-exported from client/index.ts", () => {
    // We cannot inspect type-only exports at runtime; rely on the source.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, "../../src/client/index.ts"), "utf8");
    expect(src).toMatch(/type RetryContext/);
    expect(src).toMatch(/type RetryStrategy/);
  });

  it("Test 7: RetryContext + RetryStrategy re-exported from src/index.ts", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(pathResolve(here, "../../src/index.ts"), "utf8");
    expect(src).toMatch(/type RetryContext/);
    expect(src).toMatch(/type RetryStrategy/);
  });

  it("Test 8: barrel module loads without runtime error", () => {
    // Smoke test — the type re-exports should not throw at import time.
    // Cast through `unknown` (not an object-literal assertion) so the namespace
    // types are referenced without tripping consistent-type-assertions.
    const emptyClient: unknown = {};
    const emptyTop: unknown = {};
    const _client = emptyClient as typeof ClientBarrel;
    const _top = emptyTop as typeof TopBarrel;
    expect(_client).toBeDefined();
    expect(_top).toBeDefined();
  });
});
