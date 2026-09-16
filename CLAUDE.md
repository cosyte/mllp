# @cosyte/mllp: Project Guide for Claude

**The narrative lives in [`documentation/agent-notes.md`](documentation/agent-notes.md).** This file is the cursor, the rules and the traps: one imperative line each, pointing into that file for the
incident, the measurement and the reasoning behind it. Split 2026-08-04; **nothing was deleted**. If a rule below looks arbitrary, read its section before relaxing it. New narrative goes there, not
here.

**Five sections moved one hop further out**, into `documentation/`, when this file went over its byte budget: each keeps its heading here, above a pointer at the file that now carries it, unchanged
and under that same heading. Nothing was deleted.

**The pair is gated** (`pnpm check:agent-notes`, enforced by `test/scripts/agent-notes.test.ts`): that file must be tracked, every section must have a body (a container's is its subsections), and
every pointer at it **in a file the gate opened** must resolve. **A NUL-bearing file is skipped: a disclosed miss, not a pass**; the
tell is the skipped count. It asserts **this repo's promise, not a universal** (`config`, `hl7` and `workflow` carry no `agent-notes.md`), and **refuses (exit 2) rather than reporting green over a
corpus it never opened**, reconciling paths as sets against `git ls-files`. **Never clear a red by deleting the pointer or the heading.** Why, and every disclosed miss:
`documentation/agent-notes.md#the-two-file-contract-and-why-this-gate-is-not-universal`

## Project

**`@cosyte/mllp`**: a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks, without reading the MLLP spec.

## Status

- **Phase 9 of 11.** Client / server / framing / connection / transport shipped; Phases 6, 7, 8 and 9 are done. Next: `operations/roadmaps/mllp.md`. What each phase actually shipped:
  `documentation/agent-notes.md#shipped-phases-and-the-vendored-hl7-peer-tarball`
- **The `@cosyte/hl7` peer installs from npm**, like every other `@cosyte/*` dep. The vendored tarball is GONE: it pinned dev/test to a `0.0.0` snapshot and hid a FIXED MSA-2 correlation bug
  for ten releases. **Never re-vendor one:** `documentation/agent-notes.md#shipped-phases-and-the-vendored-hl7-peer-tarball`
- **This package is on the npm registry, and this file names no version, deliberately** (derive it: `npm view @cosyte/mllp version`). Never quote a version here, never move a published version
  backwards, and never infer repo visibility from publish state or the reverse: they are independent. The competing "not yet published to npm" claim is **closed, measured stale
  2026-08-06**, and the rename from `@cosyte/hl7-mllp` was free only because it predated the first publish; it would not be free now. Why both claims go stale:
  `documentation/agent-notes.md#the-package-rename-and-the-publish-state-claim`

### The em-dash brand gate is armed

`scripts/check-no-emdash.sh` (`pnpm check:no-emdash`) + `.github/workflows/no-emdash.yml` enforce the founder ban on `U+2014` over **every tracked file AND the PR title, body and commit messages**.
Full rationale, measurements and residuals: `documentation/agent-notes.md#the-em-dash-brand-gate`

- **When it goes red, never re-encode the character.** Rewrite with a period, colon, comma or parentheses.
- **Never add `grep -I`.** Measured on GNU grep 3.8: it skips a text file whose bad byte shares a line with the em dash, in total silence, and the gate prints OK.
- **Never switch this copy to the text-only shape the other parsers run.** The tarball that forced it is gone; the shape stays. A binary carrying `E2 80 94` by coincidence is a red with no possible
  fix, which is a gate someone disables.
- **The NUL exclusion is a disclosed miss, not a pass**, and the tell is the excluded count on the OK line: **it reads 0 today**, 1 until the tarball left. If a NUL-bearing text fixture ever lands,
  revisit the partition, never the ban. The at-risk class exists, so do not call this hypothetical.
- **Never count over markdown alone.** A markdown-only count is what wrongly cleared `dicom`.
- **The script is composed from three sibling copies; understand the composition before editing it**, and fix shared limits in the script header, not here.

### The PHI scanner (`pnpm phi-scan`)

Moved whole and unchanged: [`documentation/phi-scan-rules.md`](documentation/phi-scan-rules.md). Read it before you touch a walk root, a detector, an exemption or the refusal path.

## Tech Stack (the shared `@cosyte/*` standard)

Inherited by depending on the published `@cosyte/*` config packages, never by copying files. Source of truth: the meta-repo's `documentation/conventions.md`. This is a summary.

- **Language:** TypeScript (strict, full rigor set incl. `noUncheckedIndexedAccess`) via `@cosyte/tsconfig`. **Target ES2023**, `NodeNext`.
- **Build:** dual ESM + CJS + `.d.ts` via `tsup` (`@cosyte/tsup-config`); `attw` is a publish gate (per-condition types: `.d.ts` for `import`, `.d.cts` for `require`) across all three subpaths
  (root, `/testing`, `/ack-from-hl7`). **The `attw` script is `node scripts/attw.mjs --profile node16`, NOT the bare CLI** (see the guardrail below); the CLI reports a tarball with no
  declarations as "does not contain types" and **exits 0**.
- **Node:** **>= 22** (CI matrix 22 + 24).
- **Package manager:** `pnpm@10`.
- **Lint/format:** **ESLint 10** + unified `typescript-eslint` (type-checked) via `@cosyte/eslint-config`; Prettier via `@cosyte/prettier-config`. Lint at `--max-warnings=0`.
- **Testing:** **Vitest 4** + v8 coverage (`@cosyte/vitest-config`), per-directory >= 90 gates on `src/framing|client|connection|server|transport`.
  **A slow case states its own budget at its own site; the suite-wide `testTimeout` is not for widening**, because raising the global buys a false green everywhere to spend a false red in one
  place. **No list of those sites is kept anywhere: read them off the tests, and know there are two spellings** (the options object and a bare trailing number on `it`), because every list two drafts
  kept was wrong. **A budget equal to the framework default is a no-op** (Vitest 4.1.4: 5,000 ms per test, 10,000 ms per hook), and **trim before you
  bound**. Method, conditions, figures and the repo-specific caveat that does not port: `documentation/agent-notes.md#test-timeouts-measured-not-read`
- **CI/CD:** thin callers of the reusable `cosyte/.github` workflows.
- **Runtime deps:** **Zero.** Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`).
- **Peer deps:** `@cosyte/hl7` as an **optional** peer dep, referenced only from the `@cosyte/mllp/ack-from-hl7` subpath (tsup `external`, never bundled).
- **TLS test certs:** generated via `selfsigned` (`pnpm certs:gen`) into gitignored `examples/tls/certs/`; never committed.
- **License:** MIT

## Engineering Guardrails

- No `any`. No unjustified `as` casts. Use `unknown` and narrow.
- JSDoc (with `@example`) on every public export: feeds IntelliSense.
- **Buffer-first API** on every public surface, never string. HL7 v2 payloads are raw bytes with caller-managed charset decoding.
- **`Buffer.prototype.slice()` is forbidden** in `src/framing|server|client` (enforced by the local `no-restricted-syntax` ESLint rule in `eslint.config.js`). Use `.subarray()`. `.slice()` copies in modern Node.
- **Postel's Law:** decoder is liberal (tolerance opt-ins + warnings with stable codes + byte offsets), encoder is strict (always emits canonical `VT + payload + FS + CR`).

### Framing and ACK correlation (the clinical-safety core)

Moved whole and unchanged: [`documentation/engineering-guardrails.md`](documentation/engineering-guardrails.md#framing-and-ack-correlation-the-clinical-safety-core). Read it before you touch framing, `buildMllpAck`, a warning code or control-id correlation.

### Connection, transport and TLS

Moved whole and unchanged: [`documentation/engineering-guardrails.md`](documentation/engineering-guardrails.md#connection-transport-and-tls). Read it before you touch an emit, the reconnect classifier, the state machine or a bind.

### General

Moved whole and unchanged: [`documentation/engineering-guardrails.md`](documentation/engineering-guardrails.md#general). Read it before you touch an event payload, `getStats()`, the coverage floor or the `attw` wrapper.

## Standing disciplines (every change)

Moved whole and unchanged: [`documentation/standing-disciplines.md`](documentation/standing-disciplines.md). All four bind every change here, the changeset and the public-surface gate included.
