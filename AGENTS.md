# AGENTS.md

`@cosyte/mllp` is our MLLP client and server for HL7 v2 in Node.js and TypeScript, published on npm
under MIT with zero runtime dependencies. Parsing belongs to the optional peer `@cosyte/hl7`, which
only the `@cosyte/mllp/ack-from-hl7` subpath uses.

## Build and test

Use Node.js 22.22.2 or later (the shared tooling in `@cosyte/process` needs it; the published
package itself runs on any Node.js 22) and the pnpm that `packageManager` in `package.json` pins.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## The gate

Run all of these from the repository root, in this order, before you push. CI runs the same checks.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm phi-scan
pnpm test
pnpm test:coverage
pnpm test:perf
pnpm build
pnpm attw
pnpm examples
pnpm check:no-emdash
pnpm check:no-internal-refs
pnpm check:documents
pnpm check:process
```

`pnpm check:documents` ends with `pnpm check:docs-reference`: the API reference in
`docs-content/api/` is generated from the TSDoc comments of every entry point in `exports`, and the
check fails when the committed pages differ from a fresh generation or an export has no TSDoc
summary. After changing a public export or its comment, run `pnpm docs:reference` and commit the
pages. The `version` script regenerates them, since they print `VERSION`.

## Mutation testing and the floor

`quality-floor.json` holds the coverage and mutation floors, which only rise. On a pull request CI
holds coverage to it (`ci / coverage-ratchet`) and mutates the source files the change touched
(`ci / mutation`, with `stryker.config.mjs` and `vitest.mutation.config.ts`): every mutant in the
changed lines must be killed. `weekly-mutation.yml` mutates every source file in eight shards and
holds the score to the floor. To raise a floor after a full run:

```sh
pnpm mutate:full
pnpm quality:raise --skip coverage
```

Properties run 100 cases on a pull request; `nightly-properties.yml` runs them at
`COSYTE_PROPERTY_RUNS=10000` from a seed it prints. A failure prints the `COSYTE_PROPERTY_SEED` and
`COSYTE_PROPERTY_PATH` that replay it.

## Benchmarks

`bench/mllp.bench.mjs` is the suite on `@cosyte/bench`: the frame decoder (whole frames, and frames
split across reads), the encoder, and a round trip through two connections, each on a stream of
280 byte ADT^A01 messages, a 32 KiB ORU^R01, and a 1 MiB and a 4 MiB base64 document. Every input
is synthetic and built in code by `bench/corpus.mjs`. After `pnpm build`:

```sh
pnpm bench:reading --out bench-results/reading.json   # throughput, latency, memory, import cost
pnpm bench:socket                                      # the same traffic over a 127.0.0.1 socket
pnpm bench:profile                                     # CPU and heap profiles of the hot paths
```

`pnpm test:perf` is the scaling gate (`test/perf/scaling-gate.perf.ts`), never run under coverage.
CI runs it, and an advisory base against head timing, on every pull request; `bench.yml` takes the
full reading on a hosted runner on demand and when `bench/` changes.

## Rules

- Synthetic data only. Real patient data never enters this repository: not in a fixture, a test, a
  log, an issue, or a commit. `pnpm phi-scan` runs on every commit.
- A change a consumer can see carries a changeset (`pnpm changeset`); `.changeset/README.md` says
  which bump to pick.
- No em or en dashes anywhere, commit messages included.

`CLAUDE.md` holds the rules that bind changes here and the failure behind each. Contributions follow
the organization's [contributing guide](https://github.com/cosyte/.github/blob/main/CONTRIBUTING.md).
