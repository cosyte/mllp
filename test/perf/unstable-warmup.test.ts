/**
 * The scaling gate's rule for a warmup that never settles, checked without a clock.
 *
 * On a shared runner the collector can fall into a rhythm with the warmup's 50 ms batches, so the
 * per-pass timings alternate between two values and no three batches in a row agree within 5%:
 * the gate then skips `warmup-unstable` on a change that never touched the timed code. The rule is
 * that such a skip is measured again, up to a fixed number of times in the same job, and only that
 * skip: a ratio outside the band, or a fixture too small to time, fails on the first attempt, and a
 * warmup that never settles in any attempt still fails. These cases hold each half of that rule
 * with stand-in reports, so they run in `pnpm test` and read no clock.
 */

import { AssertionError } from "node:assert";

import {
  PERF_CONTRACT,
  type AxisReport,
  type PerfAxis,
  type ScalingGateReport,
  type ScalingSelfCheckReport,
} from "@cosyte/test-utils/perf";
import { describe, expect, it } from "vitest";

import {
  WARMUP_ATTEMPTS,
  expectMeasured,
  gateUntilWarm,
  selfCheckUntilWarm,
} from "./unstable-warmup.js";

const WARMUP = { stable: true, elapsedMs: 600, passes: 50, batches: [10, 10, 10] } as const;

function measured<A extends PerfAxis>(axis: A): AxisReport<A> {
  const phase = { inputs: 1, size: null, samples: [10], min: 10, median: 10 } as const;
  return {
    axis,
    status: "measured",
    warmup: WARMUP,
    base: { phase: "base", ...phase },
    scaled: { phase: "scaled", ...phase, min: 40, median: 40, samples: [40] },
    ratio: 4,
    diagnostic: `${axis} axis: measured, ratio 4`,
  };
}

function skipped<A extends PerfAxis>(
  axis: A,
  skipReason: "warmup-unstable" | "phase-too-short",
): AxisReport<A> {
  return {
    axis,
    status: "skipped",
    skipReason,
    warmup: { ...WARMUP, stable: skipReason !== "warmup-unstable" },
    base: null,
    scaled: null,
    diagnostic: `${axis} axis: SKIPPED (${skipReason})`,
  };
}

function gate(count: AxisReport<"count">, size: AxisReport<"size">): ScalingGateReport {
  return { name: "stand-in", contract: PERF_CONTRACT, count, size };
}

/** A run that hands out the given outcomes in order, one per call, and counts the calls. */
function scripted<T>(outcomes: readonly (T | Error)[]): { run: () => T; calls: () => number } {
  let calls = 0;
  return {
    run: () => {
      const outcome = outcomes[Math.min(calls, outcomes.length - 1)] as T | Error;
      calls++;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
    calls: () => calls,
  };
}

const quiet = (): void => undefined;

describe("the scaling gate on an unstable warmup", () => {
  it("measures again in the same job, and passes once the warmup settles", () => {
    const run = scripted([
      gate(measured("count"), skipped("size", "warmup-unstable")),
      gate(measured("count"), measured("size")),
    ]);
    const report = gateUntilWarm(run.run, { log: quiet });
    expect(run.calls()).toBe(2);
    expect(report.size.status).toBe("measured");
    expect(() => {
      expectMeasured(report);
    }).not.toThrow();
  });

  it("still fails when the warmup settles in none of its attempts", () => {
    const run = scripted([gate(skipped("count", "warmup-unstable"), measured("size"))]);
    expect(() => gateUntilWarm(run.run, { log: quiet })).toThrow(
      /warmup did not settle in 3 attempts/,
    );
    expect(run.calls()).toBe(WARMUP_ATTEMPTS);
    expect(WARMUP_ATTEMPTS).toBe(3);
  });

  it("fails a ratio outside the band on the first attempt, with no retry", () => {
    const regression = new AssertionError({ message: "ratio 12 exceeds RATIO_CEILING 8" });
    const run = scripted<ScalingGateReport>([regression]);
    expect(() => gateUntilWarm(run.run, { log: quiet })).toThrow(regression);
    expect(run.calls()).toBe(1);
  });

  it("does not retry a phase too short to time, and that report fails", () => {
    const run = scripted([gate(measured("count"), skipped("size", "phase-too-short"))]);
    const report = gateUntilWarm(run.run, { log: quiet });
    expect(run.calls()).toBe(1);
    expect(() => {
      expectMeasured(report);
    }).toThrow(/phase-too-short/);
  });

  it("names every unsettled attempt in the log, sizes and timings only", () => {
    const lines: string[] = [];
    const run = scripted([
      gate(skipped("count", "warmup-unstable"), skipped("size", "warmup-unstable")),
      gate(measured("count"), measured("size")),
    ]);
    gateUntilWarm(run.run, { log: (line) => lines.push(line) });
    expect(lines).toEqual([
      "[scaling gate] attempt 1 of 3: the warmup did not settle on the count, size axis; measuring again",
    ]);
  });
});

describe("the self-check on an unstable warmup", () => {
  const settled: ScalingSelfCheckReport = {
    name: "stand-in",
    axis: "size",
    baseSize: 8,
    inputs: [1, 1],
    signal: 12,
    margin: 1.5,
    cleanBaseMinMs: { count: 10, size: 10 },
    samples: { base: [10], scaled: [120] },
    diagnostic: "self-check on the size axis: signal 12",
  };

  it("runs again when a warmup never settled, and returns the check that did", () => {
    const run = scripted<ScalingSelfCheckReport>([
      new AssertionError({
        message: "precondition: FAILED, the CLEAN parse's warmup never settled",
      }),
      settled,
    ]);
    expect(selfCheckUntilWarm(run.run, { log: quiet })).toBe(settled);
    expect(run.calls()).toBe(2);
  });

  it("fails a signal under the ceiling on the first attempt", () => {
    const blind = new AssertionError({
      message: "a real complexity regression ... does not clear",
    });
    const run = scripted<ScalingSelfCheckReport>([blind, settled]);
    expect(() => selfCheckUntilWarm(run.run, { log: quiet })).toThrow(blind);
    expect(run.calls()).toBe(1);
  });

  it("fails an error that is not an assertion on the first attempt", () => {
    const bug = new TypeError("warmup never settled");
    const run = scripted<ScalingSelfCheckReport>([bug, settled]);
    expect(() => selfCheckUntilWarm(run.run, { log: quiet })).toThrow(bug);
    expect(run.calls()).toBe(1);
  });

  it("still fails when no attempt settles, with the last diagnostic", () => {
    const run = scripted<ScalingSelfCheckReport>([
      new AssertionError({ message: "FAILED, warmup never settled (5000 ms)" }),
    ]);
    expect(() => selfCheckUntilWarm(run.run, { log: quiet })).toThrow(
      /warmup did not settle in 3 attempts[\s\S]*warmup never settled \(5000 ms\)/,
    );
    expect(run.calls()).toBe(WARMUP_ATTEMPTS);
  });
});
