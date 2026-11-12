// The cold import of one entry point of @cosyte/mllp, on @cosyte/bench.
//
// A reading measures the cold import of its `--target`: fresh processes importing it against fresh
// processes importing an empty module, and every file the import loads with its gzip size. The
// root entry point is read with the main suite (`mllp.bench.mjs`); this suite reads each subpath:
//   pnpm build
//   pnpm bench:import --target dist/testing/index.mjs --out bench-results/import-testing.json
//
// Its one benchmark reads the names the entry point exports, so the reading has a case to time;
// the number it is for is the import cost, not that case.

import { defineBenchmark, defineSuite } from "@cosyte/bench";

export default defineSuite({
  name: "@cosyte/mllp entry point",
  benchmarks: [
    defineBenchmark({
      name: "exports",
      sizes: [{ label: "the namespace", build: () => ({ inputs: [null] }) }],
      bind: (entry) => () => Object.keys(entry).length,
      weigh: (names) => names,
    }),
  ],
});
