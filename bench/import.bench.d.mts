// Types for import.bench.mjs, so the TypeScript test that runs its case once type-checks.

import type { BenchSuite } from "@cosyte/bench";

declare const suite: BenchSuite<Record<string, unknown>>;
export default suite;
