---
id: testing-and-quality
title: Testing and quality
sidebar_label: Testing and quality
description: "How we test @cosyte/mllp: unit tests, conformance checks, property-based tests, fuzzing, differential frames, TLS and PHI checks, and what each one misses."
---

# Testing and quality

This page describes how we test `@cosyte/mllp`, what each technique catches, and what it cannot.
The shared rules every Cosyte package follows (the coverage and mutation floors, the property-based
runners, what a pull request must prove) are written down in the testing standard in
[cosyte/config's decision records](https://github.com/cosyte/config/tree/main/documentation/decisions).
The numbers for the current release are in [Current numbers](#current-numbers) below. To test your
own code against this package, see [Test your code and verify an engine](./testing.md).

The failure we test hardest against is the quiet one. A message acknowledged `AA` and then lost, an
acknowledgment the sender cannot match so it resends and the receiver commits twice, a byte of a
message escaping into a log: none of these raises an error on its own. So most of what follows
checks outcomes on the wire, not only that nothing threw.

## What we run, and what each technique catches

| Technique                | What it catches                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | What it cannot catch                                                                                                                                            |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit tests               | each documented behavior and failure path of the framing codec, the connection, the client, the server, TLS and `ack-from-hl7`, run against the source                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | an input or a timing nobody thought to write down                                                                                                               |
| Conformance checks       | a drift between the [Conformance statement](./conformance.md) and the code: its declared tolerances, warning codes, acknowledgment verdicts and option names are read from the page and compared with what the package exports and does; a quirk corpus drives each tolerated framing deviation through a realistic synthetic message and checks the recovered payload byte for byte                                                                                                                                                                                                                                                                 | a behavior the statement does not declare                                                                                                                       |
| Property-based tests     | a whole class of input breaking a stated rule: any payload the encoder accepts decodes back byte for byte, a stream in any chunks decodes to its payloads in order, reading a stream and framing what it delivered again is idempotent, the decoder with its tolerance flags on never throws except on an oversized frame and reports the same thing however its input is split, warnings and events cannot be mutated, no diagnostic carries a run of payload, an acknowledgment's `MSA-2` repeats the inbound `MSH-10` bytes for any control ID and field separator (or `ack-from-hl7` says it cannot), a second acknowledgment is never discarded | a rule nobody stated; a case outside the cases run; a gap in what the generators produce                                                                        |
| Fuzzing                  | a crash, a hang or a runaway allocation on hostile input: random bytes into the decoder, mutated MLLP streams through the decoder and a connection, and mutated HL7 v2 messages through the acknowledgment readers and builders, the client's correlation and `ack-from-hl7`                                                                                                                                                                                                                                                                                                                                                                         | a wrong but plausible result, unless a property says what right is                                                                                              |
| Differential frames      | a framing regression: canonical Release 1 frames, written from the specification for the Google Cloud Healthcare MLLP adapter and Mirth/NextGen Connect, must decode to the exact payload and be reproduced byte for byte by the encoder; the same frames are the corpus `runDifferential` ships                                                                                                                                                                                                                                                                                                                                                     | behavior of a running engine: the frames are derived from the specification, not captured, and the live tier runs only when a developer points it at an engine  |
| TLS handshakes           | a regression in verification, mutual TLS, the TLS 1.2 floor, the cipher-suite option or the Diffie-Hellman parameter checks, through real handshakes on loopback with certificates generated in memory for each test                                                                                                                                                                                                                                                                                                                                                                                                                                 | a peer's TLS stack other than the Node.js one under test                                                                                                        |
| PHI checks               | a message byte reaching an error, a warning or an event: a table of every position a sender controls, driven through the client, the connection and `ack-from-hl7`, checked by the shared leak runner; and a scan of the repository for realistic patient identifiers                                                                                                                                                                                                                                                                                                                                                                                | a leak through a surface the table does not list; the scan detects after a write, it does not prevent one                                                       |
| Coverage gate            | code no test runs: lines, branches, functions and statements across `src/`, held at a floor that only rises, and every line a pull request changes run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | a test that runs code without checking what it returns                                                                                                          |
| Mutation testing         | a test that runs code but would not notice it changing: StrykerJS changes the source one small edit at a time (a flipped comparison, a removed call, a swapped constant) and the suite must fail for each                                                                                                                                                                                                                                                                                                                                                                                                                                            | an edit the operators do not make; a mutant that changes nothing observable (an equivalent mutant), which counts against the score though no test could kill it |
| Doc samples and examples | a sample or an example that no longer matches the code: every TypeScript sample on these pages is type-checked against the package's types and run against the built package, with its `// =>` values checked, and the programs under `examples/` run against the build                                                                                                                                                                                                                                                                                                                                                                              | prose that is wrong beside a sample that is right                                                                                                               |
| Type exports             | a published entry point whose types do not resolve: `attw` checks the root, `/testing`, `/ack-from-hl7` and `/arbitraries` for both `import` and `require`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | a type that resolves but is wrong                                                                                                                               |

## How each one runs

- **Unit tests, conformance checks, properties, fuzzing at its base size, differential frames, TLS
  handshakes, PHI checks and doc samples** run in one Vitest suite on every pull request and on
  `main`, on Node.js 22, 24 and 26, each on Linux, macOS and Windows, and the same suite runs again
  under Bun and under Deno. A test that cannot run on one system or runtime is skipped there by
  name, with its reason beside it in the code.
- **Property depth.** Every property runs 100 cases on a pull request and 10,000 every night.
  `COSYTE_PROPERTY_RUNS` sets the depth of a whole run; no property sets its own.
- **Seeds.** A pull request lets fast-check draw a new seed for each property, so a run can find a
  case an earlier one missed. The nightly run starts from a seed drawn from its run id and prints
  it first, so any night replays whole. A failure prints the seed and path that replay it exactly
  (`COSYTE_PROPERTY_SEED`, `COSYTE_PROPERTY_PATH`). The fuzz targets are the exception: they run
  with a fixed seed on a pull request, so a pull request sees the same inputs every time.
- **The standard properties.** Eleven checks prove the three properties every Cosyte parser proves
  (round trip, idempotent normalize, and never throws in lenient mode) on the generators we publish
  at `@cosyte/mllp/arbitraries`. [Property-test your code](./property-test-your-code.md) shows those
  generators on code of your own.
- **Nightly fuzzing.** Every night the fuzz targets run again for a time budget instead of a fixed
  count, from a seed that changes with every run, and a crash, hang or runaway allocation fails
  the run. `MLLP_FUZZ_SEED=<seed> pnpm fuzz` replays a failure.
- **The coverage gate** runs with the suite, at 100% of lines, branches, functions and statements,
  the floor in `quality-floor.json`. On a pull request every changed line coverage counts must have
  run, and no floor may be lowered.
- **Mutation testing** runs on every pull request over the source files it changed, and every
  mutant in the changed lines must be killed. Twice a week every source file is mutated, in eight
  parallel shards, and the score is held to the floor in `quality-floor.json`, which only rises.
- **The PHI scan** runs on every commit (a pre-commit hook) and in CI.
- **The examples** run in their own CI job, and **the type exports** are checked in the main job
  after the build, on Linux and macOS.
- **Static analysis.** CodeQL scans every pull request, `main`, and once a week.

## Run them yourself

```bash
pnpm install --frozen-lockfile
pnpm test               # the whole suite, including doc samples (it builds first)
pnpm test:coverage      # the same suite with the coverage gate
pnpm fuzz               # the fuzz targets on their own
pnpm test:property      # the property suites; COSYTE_PROPERTY_RUNS=10000 for the nightly depth
pnpm mutate:full        # mutate every source file (slow: CI runs it in eight shards)
pnpm quality:check      # coverage against quality-floor.json, after pnpm test:coverage
pnpm phi-scan           # the PHI scan over the repository
pnpm build && pnpm examples && pnpm attw

# The differential tier against a Release 1 engine you run locally:
MLLP_DIFF_ADAPTER=127.0.0.1:2575 pnpm test test/differential/differential.test.ts
```

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
