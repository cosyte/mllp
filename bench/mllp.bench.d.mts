// Types for mllp.bench.mjs, so the TypeScript tests that run every case once type-check.

import type { BenchSuite } from "@cosyte/bench";

import type * as Mllp from "../src/index.js";

export declare function splitReads(payloads: readonly Buffer[]): Buffer[];
export declare function counting(mllp: typeof Mllp): {
  reader: Mllp.FrameReader;
  seen: { frames: number; bytes: number };
};
export declare function roundTrip(mllp: typeof Mllp): (payload: Buffer) => Buffer | null;

declare const suite: BenchSuite<typeof Mllp>;
export default suite;
