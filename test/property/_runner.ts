/**
 * How this repository's properties run: how many cases, from which seed, and what a failure
 * prints so it replays exactly.
 *
 * Every property outside the fuzz targets runs through {@link assertProperty} or
 * {@link assertAsyncProperty} here, never through a bare `fc.assert`, and none sets its own depth,
 * so one number decides how deep a run goes (`test/property/depth.test.ts` holds that). The fuzz
 * targets (`*fuzz.property.test.ts`) keep their own knobs in `./_fuzz-config.ts`: a pinned seed on
 * a pull request and a time budget in the nightly fuzz run.
 *
 * - **Depth.** {@link DEFAULT_NUM_RUNS} (100) cases a property on a pull request.
 *   `COSYTE_PROPERTY_RUNS` sets the depth of every property in a run, and the nightly property job
 *   (`.github/workflows/nightly-properties.yml`) sets it to 10,000.
 * - **Seeds.** A run that names no seed lets fast-check draw one, so each run explores new input.
 *   The nightly job names one drawn from its run id and prints it first, so a whole night replays.
 *   A failure prints its own seed and path; setting `COSYTE_PROPERTY_SEED` and
 *   `COSYTE_PROPERTY_PATH` to them runs that one failing case again, already shrunk.
 * - A value that is set but malformed throws, so a job that typed its depth wrong cannot quietly
 *   run the default.
 *
 * The synchronous runner and the depth rules are the shared kit's (`@cosyte/test-utils`). The kit
 * has no runner for an asynchronous property, which the connection and client properties need, so
 * {@link assertAsyncProperty} is the kit's runner with `fc.check` awaited, on the kit's own depth
 * and failure message.
 */

import {
  DEFAULT_NUM_RUNS,
  PROPERTY_ENV,
  assertProperty as kitAssertProperty,
  propertyFailureMessage,
  resolvePropertyRun,
} from "@cosyte/test-utils";
import fc from "fast-check";
import type { IAsyncProperty, IProperty, Parameters as FcParameters } from "fast-check";
import { expect, vi } from "vitest";

export { DEFAULT_NUM_RUNS, PROPERTY_ENV, propertyFailureMessage, resolvePropertyRun };

/** The run options a property takes. The environment wins over each. */
export interface PropertyRunOptions {
  readonly numRuns?: number;
  readonly seed?: number;
  readonly path?: string;
}

type Env = Readonly<Record<string, string | undefined>>;

/**
 * Run a property at the resolved depth and seed, and throw a replayable error when it fails.
 *
 * @throws {Error} When the property fails, with the seed and path in the message.
 */
export function assertProperty<Ts>(
  name: string,
  property: IProperty<Ts>,
  options: PropertyRunOptions = {},
  env: Env = process.env,
): void {
  kitAssertProperty(name, property, options, env);
}

/**
 * Run an asynchronous property at the resolved depth and seed, and throw a replayable error when it
 * fails: {@link assertProperty} for a property built with `fc.asyncProperty`.
 *
 * @throws {Error} When the property fails, with the seed and path in the message.
 */
export async function assertAsyncProperty<Ts>(
  name: string,
  property: IAsyncProperty<Ts>,
  options: PropertyRunOptions = {},
  env: Env = process.env,
): Promise<void> {
  const run = resolvePropertyRun(options, env);
  // A replay stops at the case its path names: that case is already shrunk.
  const parameters: FcParameters<Ts> = {
    ...run,
    endOnFailure: run.path !== undefined,
    includeErrorInReport: true,
  };
  const details = await fc.check(property, parameters);
  if (!details.failed) return;
  throw new Error(propertyFailureMessage(name, details), { cause: details.errorInstance });
}

/**
 * A test's time budget for a property at the resolved depth: the suite's 10 s floor, or 10 ms a
 * case, whichever is longer, so a deep run (`COSYTE_PROPERTY_RUNS=10000`) is not cut off by the
 * budget a 100-case run needs.
 */
export function propertyTimeout(env: Env = process.env): number {
  return Math.max(10_000, resolvePropertyRun({}, env).numRuns * 10);
}

/** Give every test in the calling file the budget of a property at this run's depth. */
export function usePropertyBudget(): void {
  vi.setConfig({ testTimeout: propertyTimeout() });
}

/** The name of the test running now, which leads a failure message. */
function currentTestName(): string {
  return expect.getState().currentTestName ?? "property";
}

/**
 * Run one property at this run's depth, named for the test that runs it, so a failure leads with
 * the test's name and then the seed and path that replay it.
 *
 * @throws {Error} When the property fails, with the replay seed and path in the message.
 */
export function checkProperty<Ts>(property: IProperty<Ts>): void {
  assertProperty(currentTestName(), property);
}

/**
 * {@link checkProperty} for a property built with `fc.asyncProperty`.
 *
 * @throws {Error} When the property fails, with the replay seed and path in the message.
 */
export async function checkAsyncProperty<Ts>(property: IAsyncProperty<Ts>): Promise<void> {
  await assertAsyncProperty(currentTestName(), property);
}
