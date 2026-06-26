/**
 * MllpBackpressureError tests (PLAN-05, ERR-04).
 *
 * Verifies the error class shape: readonly fields, name discrimination,
 * Error.captureStackTrace discipline, instanceof correctness, and that the
 * PLAN-01 sentinel for PLAN-05 fills has been removed (sentinel hygiene —
 * matches the PLAN-02 / PLAN-04 fill precedents).
 */

import { describe, it, expect } from "vitest";
import { MllpBackpressureError } from "../../src/client/error.js";

describe("MllpBackpressureError (PLAN-05 / ERR-04)", () => {
  it("Test 1: constructs with all fields readable as readonly", () => {
    const err = new MllpBackpressureError("queue full", {
      queueDepth: 64,
      queueBytes: 1024,
      highWaterMark: { count: 64 },
    });
    expect(err.message).toBe("queue full");
    expect(err.queueDepth).toBe(64);
    expect(err.queueBytes).toBe(1024);
    expect(err.highWaterMark).toEqual({ count: 64 });
  });

  it('Test 2: name is "MllpBackpressureError" and instanceof checks pass', () => {
    const err = new MllpBackpressureError("queue full", {
      queueDepth: 1,
      queueBytes: 10,
      highWaterMark: { count: 1 },
    });
    expect(err.name).toBe("MllpBackpressureError");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(MllpBackpressureError);
  });

  it("Test 3: highWaterMark accepts both count and bytes (stricter-of-two case)", () => {
    const err = new MllpBackpressureError("queue full", {
      queueDepth: 4,
      queueBytes: 200,
      highWaterMark: { count: 100, bytes: 200 },
    });
    expect(err.highWaterMark.count).toBe(100);
    expect(err.highWaterMark.bytes).toBe(200);
  });

  it("Test 3b: highWaterMark.count and highWaterMark.bytes are independently optional", () => {
    const errBytesOnly = new MllpBackpressureError("queue full", {
      queueDepth: 0,
      queueBytes: 100,
      highWaterMark: { bytes: 100 },
    });
    expect(errBytesOnly.highWaterMark.count).toBeUndefined();
    expect(errBytesOnly.highWaterMark.bytes).toBe(100);

    const errCountOnly = new MllpBackpressureError("queue full", {
      queueDepth: 64,
      queueBytes: 0,
      highWaterMark: { count: 64 },
    });
    expect(errCountOnly.highWaterMark.bytes).toBeUndefined();
    expect(errCountOnly.highWaterMark.count).toBe(64);
  });

  it("Test 4: stack trace excludes the constructor frame", () => {
    const err = new MllpBackpressureError("queue full", {
      queueDepth: 0,
      queueBytes: 0,
      highWaterMark: { count: 1 },
    });
    expect(err.stack).toBeDefined();
    expect(err.stack).not.toMatch(/at new MllpBackpressureError/);
  });

  it("Test 5: PLAN-05 fills sentinel is removed; PLAN-02 / PLAN-04 sentinels are already gone", async () => {
    const fs = await import("node:fs/promises");
    const url = new URL("../../src/client/error.ts", import.meta.url);
    const text = await fs.readFile(url, "utf8");
    expect(text).not.toMatch(/PLAN-05 fills/);
    // Sanity: earlier sentinels removed by PLAN-02 / PLAN-04.
    expect(text).not.toMatch(/PLAN-02 fills/);
    expect(text).not.toMatch(/PLAN-04 fills/);
  });

  it("Test 6: re-exported from package barrel and root index", async () => {
    const clientBarrel = await import("../../src/client/index.js");
    const rootBarrel = await import("../../src/index.js");
    expect(clientBarrel.MllpBackpressureError).toBe(MllpBackpressureError);
    expect(rootBarrel.MllpBackpressureError).toBe(MllpBackpressureError);
  });
});
