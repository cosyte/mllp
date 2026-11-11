/**
 * What the scaling gate does when its warmup never settles: measure again, in the same job.
 *
 * The warmup rule in `@cosyte/test-utils/perf` waits for three consecutive 50 ms batches within 5%
 * of their median, for at most 5 s. On a shared runner the collector can fall into step with those
 * batches, so the per-pass timings alternate between two values for the whole 5 s and the rule
 * never fires: the receive path's size axis rose and fell by turns, between 8.5 and 21.8 ms per
 * pass, for 87 batches, on a change that did not touch the frame reader. The gate then skips
 * `warmup-unstable`, which the tests count as a failure, since a skip is not a pass.
 *
 * So that one outcome, and only that one, is measured again, up to {@link WARMUP_ATTEMPTS} times,
 * with every contract constant as it is. A ratio outside the band, a phase too short to time and a
 * self-check signal under the ceiling fail on the first attempt, as before. A warmup that settles in
 * no attempt still fails, with each attempt's diagnostic, so a gate that can never measure reads
 * red, never green. `unstable-warmup.test.ts` holds this rule without a clock.
 */

import { AssertionError } from "node:assert";

import type { ScalingGateReport, ScalingSelfCheckReport } from "@cosyte/test-utils/perf";

/** How many times one gate or self-check is measured before an unsettled warmup fails it. */
export const WARMUP_ATTEMPTS = 3;

/** Where the notes on each attempt go. */
export interface WarmupRetryOptions {
  /**
   * One line per attempt: why it is measured again, or the ratios it settled on. Defaults to
   * stderr, as the gate's own diagnostics.
   */
  readonly log?: (line: string) => void;
}

const toStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

/**
 * The text `assertScalingGateFires` throws when a warmup, the clean parse's or the regressed one's,
 * never settles. Should a release of `@cosyte/test-utils` reword it, nothing matches and the
 * self-check fails on its first attempt, as it did before this retry: the strict side.
 */
const SELF_CHECK_UNSETTLED = /warmup never settled/;

function unsettledAxes(report: ScalingGateReport): string[] {
  return [report.count, report.size]
    .filter((axis) => axis.status === "skipped" && axis.skipReason === "warmup-unstable")
    .map((axis) => axis.axis);
}

/** Each axis's ratio and warmup, or why it has none: sizes and timings only. */
function outcome(report: ScalingGateReport): string {
  return [report.count, report.size]
    .map((axis) =>
      axis.status === "measured"
        ? `${axis.axis} ratio ${String(axis.ratio)} (warmup ${String(Math.round(axis.warmup.elapsedMs))} ms)`
        : `${axis.axis} skipped (${axis.skipReason})`,
    )
    .join(", ");
}

function retryNote(attempt: number, what: string): string {
  return `[scaling gate] attempt ${String(attempt)} of ${String(WARMUP_ATTEMPTS)}: the warmup did not settle on ${what}; measuring again`;
}

function exhausted(diagnostics: readonly string[]): AssertionError {
  return new AssertionError({
    message: `[scaling gate] the warmup did not settle in ${String(WARMUP_ATTEMPTS)} attempts, so this gate could not measure. A skip is not a pass.\n${diagnostics.join("\n")}`,
    operator: "perf-warmup-retry",
  });
}

/**
 * Runs `scalingGate` until no axis skipped `warmup-unstable`, at most {@link WARMUP_ATTEMPTS}
 * times, and returns that report. Whatever `run` throws (a ratio outside the band) is thrown at
 * once. Throws when every attempt left an axis unsettled.
 */
export function gateUntilWarm(
  run: () => ScalingGateReport,
  options: WarmupRetryOptions = {},
): ScalingGateReport {
  const log = options.log ?? toStderr;
  const diagnostics: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const report = run();
    const unsettled = unsettledAxes(report);
    if (unsettled.length === 0) {
      log(
        `[scaling gate] ${report.name}: attempt ${String(attempt)} of ${String(WARMUP_ATTEMPTS)}: ${outcome(report)}`,
      );
      return report;
    }
    for (const axis of [report.count, report.size]) {
      if (unsettled.includes(axis.axis)) diagnostics.push(axis.diagnostic);
    }
    if (attempt === WARMUP_ATTEMPTS) throw exhausted(diagnostics);
    log(retryNote(attempt, `the ${unsettled.join(", ")} axis`));
  }
}

/**
 * Runs `assertScalingGateFires` until no warmup in it fails to settle, at most
 * {@link WARMUP_ATTEMPTS} times. Any other failure, a signal under the ceiling or a fixture too
 * small, is thrown at once. Throws when every attempt had a warmup that never settled.
 */
export function selfCheckUntilWarm(
  run: () => ScalingSelfCheckReport,
  options: WarmupRetryOptions = {},
): ScalingSelfCheckReport {
  const log = options.log ?? toStderr;
  const diagnostics: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      const report = run();
      log(
        `[scaling gate] ${report.name}: self-check attempt ${String(attempt)} of ${String(WARMUP_ATTEMPTS)}: signal ${String(report.signal)}, margin ${String(report.margin)}`,
      );
      return report;
    } catch (error) {
      if (!(error instanceof AssertionError) || !SELF_CHECK_UNSETTLED.test(error.message)) {
        throw error;
      }
      diagnostics.push(error.message);
      if (attempt === WARMUP_ATTEMPTS) throw exhausted(diagnostics);
      log(retryNote(attempt, "the self-check"));
    }
  }
}

/** Fails unless both axes produced a ratio: a skip of either kind is not a pass. */
export function expectMeasured(report: ScalingGateReport): void {
  for (const axis of [report.count, report.size]) {
    if (axis.status !== "measured") {
      throw new AssertionError({
        message: axis.diagnostic,
        actual: `skipped (${axis.skipReason})`,
        expected: "measured",
        operator: "perf-measured",
      });
    }
  }
}
