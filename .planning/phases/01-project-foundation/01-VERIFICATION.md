---
phase: 01-project-foundation
verified: 2026-04-24T10:32:00Z
status: gaps_found
score: 4/5 must-haves verified
gaps:
  - truth: "pnpm lint passes with zero warnings (SETUP-06)"
    status: failed
    reason: >
      Running `pnpm lint` emits an ESLintIgnoreWarning to stderr: "The '.eslintignore' file is
      no longer supported. Switch to using the 'ignores' property in 'eslint.config.js'."
      Plan 03 created .eslintignore as a 'legacy compat layer' despite the flat config already
      having the same ignores patterns in its `ignores` block. The file is redundant and
      its presence causes ESLint v9 to emit this deprecation warning on every lint run,
      violating SETUP-06's zero-warnings requirement.
    artifacts:
      - path: ".eslintignore"
        issue: "File is redundant — eslint.config.js already has ignores: ['dist/**', 'node_modules/**', 'coverage/**', ...]. Delete this file to eliminate the ESLintIgnoreWarning."
    missing:
      - "Delete .eslintignore — the flat config already covers all its patterns via the ignores block in eslint.config.js"
---

# Phase 1: Project Foundation Verification Report

**Phase Goal:** Scaffold the complete project infrastructure so every subsequent phase can build on a stable, lintable, testable, type-checked, and CI-gated foundation.
**Verified:** 2026-04-24T10:32:00Z
**Status:** gaps_found
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Developer can run `pnpm install && pnpm build && pnpm typecheck && pnpm lint && pnpm test` from a clean clone and every command exits 0 | PARTIAL | `pnpm build`, `pnpm typecheck`, `pnpm test` all exit 0. `pnpm lint` exits 0 but emits an `ESLintIgnoreWarning` to stderr (see gap). `pnpm install --frozen-lockfile` works. |
| 2 | ESM and CJS consumers both resolve correct entry + types; `/testing` and `/ack-from-hl7` subpaths resolve to distinct bundles with types | VERIFIED | All 12 dist artifacts confirmed (`.js`, `.cjs`, `.d.ts`, `.d.cts` per entry). Exports map has import/require/types conditions for all three subpaths. `dist/index.js` is ESM; `dist/index.cjs` is CJS with `'use strict'`. |
| 3 | `package.json` shows zero runtime deps, `@cosyte/hl7` as optional peer, `type:module`, engines `>=20.0.0` | VERIFIED | Confirmed: `dependencies: {}`, `peerDependencies: {"@cosyte/hl7":">=0.1.0"}`, `peerDependenciesMeta.optional: true`, `"type":"module"`, `engines.node:">=20.0.0"`. |
| 4 | Developer gets strict-mode errors and `Buffer.prototype.slice()` is forbidden by ESLint in `src/framing|server|client` | VERIFIED | `tsconfig.json` has `strict:true`, `noUncheckedIndexedAccess:true`. SETUP-07 `no-restricted-syntax` rule confirmed active in `eslint.config.js`, scoped to `src/framing/**`, `src/server/**`, `src/client/**`. Test verified: linting a `.slice()` call in `src/framing/` produces error with correct SETUP-07 message. |
| 5 | CI runs 3x3 matrix (Ubuntu/macOS/Windows × Node 20/22/24); lint/typecheck/coverage Ubuntu only | VERIFIED | `.github/workflows/ci.yml` confirmed: `os: [ubuntu-latest, macos-latest, windows-latest]`, `node: ['20','22','24']`, `fail-fast: false`, `cancel-in-progress: true`, `pnpm/action-setup@v4`, `cache:'pnpm'`. lint/typecheck/coverage/publish-gate all on `ubuntu-latest`. |

**Score:** 4/5 truths fully verified (Truth 1 is partial due to the SETUP-06 lint warning gap)

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `package.json` | Package manifest with engines, peerDeps, type:module | VERIFIED | All required fields confirmed present |
| `tsconfig.json` | Strict TypeScript, ES2022, NodeNext, noUncheckedIndexedAccess | VERIFIED | All flags confirmed |
| `tsconfig.build.json` | emitDeclarationOnly:true, extends tsconfig.json | VERIFIED | Confirmed |
| `src/index.ts` | Main barrel stub with @packageDocumentation | VERIFIED | Exports `VERSION`, has JSDoc |
| `src/testing/index.ts` | Testing subpath barrel stub | VERIFIED | Exports `TESTING_STUB`, has JSDoc |
| `src/ack-from-hl7/index.ts` | ACK peer-dep adapter barrel stub | VERIFIED | Exports `ACK_FROM_HL7_STUB`, has JSDoc |
| `tsup.config.ts` | 3 entries, ESM+CJS, sourcemap, dts, clean, external | VERIFIED | All tsup options confirmed, `external:['@cosyte/hl7']` present, no experimentalDts |
| `eslint.config.js` | Flat config with recommended-type-checked, projectService:true, SETUP-07 rule | VERIFIED | All three requirements confirmed |
| `.eslintignore` | Legacy compat shim (redundant in flat config) | BLOCKER | File emits ESLintIgnoreWarning on every lint run — violates SETUP-06 |
| `vitest.config.ts` | coverage-v8, 90% thresholds, explicit imports | VERIFIED | provider:'v8', all four thresholds at 90 |
| `test/sanity.test.ts` | 2 passing tests | VERIFIED | VERSION export + Node 20+ check, both pass |
| `.github/workflows/ci.yml` | 3x3 matrix, attw gate, Ubuntu-only lint/coverage | VERIFIED | All structural requirements confirmed |
| `scripts/generate-test-certs.mjs` | TLS cert generation via selfsigned | VERIFIED | File exists, uses selfsigned, outputs to gitignored path |
| `src/framing/.gitkeep` | Empty dir tracking | VERIFIED | Present |
| `src/server/.gitkeep` | Empty dir tracking | VERIFIED | Present |
| `src/client/.gitkeep` | Empty dir tracking | VERIFIED | Present |
| `LICENSE` | MIT 2026 Cosyte | VERIFIED | Present |
| `README.md` | Stub README | VERIFIED | Present |
| `.npmrc` | auto-install-peers=false | VERIFIED | Present (auto-fix from Plan 01 for pnpm 10) |
| `pnpm-workspace.yaml` | allowBuilds.esbuild:true | VERIFIED | Present (auto-fix from Plan 02 for CI) |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| `package.json` exports | `dist/index.js` | import condition | WIRED | Confirmed: `"."."import"."default":"./dist/index.js"` |
| `package.json` exports | `dist/index.cjs` | require condition | WIRED | Confirmed: `"."."require"."default":"./dist/index.cjs"` |
| `tsup.config.ts` | `dist/` (12 files) | `pnpm build` | WIRED | All 12 artifacts confirmed present |
| `eslint.config.js` | `src/framing/**/*.ts` | no-buffer-slice rule | WIRED | Rule fires on `.slice()` in `src/framing/` — confirmed with live test |
| `vitest.config.ts` | `src/framing, src/server, src/client` | coverage thresholds | WIRED | `thresholds: { lines:90, functions:90, branches:90, statements:90 }` confirmed |
| `.github/workflows/ci.yml` | `pnpm test` | matrix job run step | WIRED | `run: pnpm test` in matrix job |
| `.github/workflows/ci.yml` | `pnpm attw --pack` | publish-gate step | WIRED | `run: pnpm attw --pack` in publish-gate job |

### Data-Flow Trace (Level 4)

Not applicable — this phase produces tooling infrastructure and stub barrels, not components that render dynamic data.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| `pnpm build` exits 0 with 12 dist artifacts | `pnpm build` | Exit 0, all 12 files present | PASS |
| `pnpm typecheck` exits 0 | `pnpm typecheck` | Exit 0, no errors | PASS |
| `pnpm lint` exits 0 | `pnpm lint` | Exit 0 but emits ESLintIgnoreWarning | PARTIAL |
| `pnpm test` exits 0, 2 tests pass | `pnpm test` | Exit 0, 2 passed | PASS |
| `pnpm format:check` exits 0 | `pnpm format:check` | Exit 0 | PASS |
| SETUP-07 rule fires on `.slice()` | lint test file in `src/framing/` | Error with SETUP-07 message | PASS |
| `@cosyte/hl7` absent from JS/CJS bundles | `grep -r "@cosyte/hl7" dist/*.js dist/*.cjs` | Not found | PASS |
| dist/index.js is ESM | head of file | `export { VERSION }` — no `use strict` | PASS |
| dist/index.cjs is CJS | head of file | `'use strict';` present | PASS |
| TLS certs gitignored | `git check-ignore examples/tls/certs/server-key.pem` | Gitignored | PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SETUP-01 | 01-01, 01-04 | pnpm install+build+test from clean clone | PARTIAL | All exit 0; lint emits a process warning — see SETUP-06 gap |
| SETUP-02 | 01-02 | Dual ESM+CJS, exports map, subpaths, attw gate | SATISFIED | 12 dist artifacts, exports map wired, attw in CI |
| SETUP-03 | 01-01, 01-02 | Zero runtime deps, @cosyte/hl7 optional peer, ack-from-hl7 external | SATISFIED | Confirmed in package.json and tsup.config.ts |
| SETUP-04 | 01-01 | Full IntelliSense on every public API | SATISFIED | .d.ts/.d.cts per entry, JSDoc @packageDocumentation on all three stubs |
| SETUP-05 | 01-01 | Node 20+, ES2022, strict:true, noUncheckedIndexedAccess | SATISFIED | tsconfig.json confirmed; engines.node:">=20.0.0" |
| SETUP-06 | 01-03, 01-04 | `pnpm lint` and `pnpm typecheck` pass with zero warnings | BLOCKED | `pnpm typecheck` exits 0 cleanly; `pnpm lint` exits 0 but emits ESLintIgnoreWarning from redundant .eslintignore file |
| SETUP-07 | 01-03 | ESLint no-buffer-slice error in src/framing|server|client | SATISFIED | Rule confirmed in eslint.config.js and tested live |

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| `.eslintignore` | N/A | Deprecated flat-config era file causes ESLint v9 to emit `ESLintIgnoreWarning` on every lint invocation | WARNING | Violates SETUP-06 "zero warnings" from `pnpm lint`; the file is entirely redundant since `eslint.config.js` already has identical ignores patterns |

Note: The stub exports in `src/index.ts`, `src/testing/index.ts`, and `src/ack-from-hl7/index.ts` are intentional per the plan design (placeholders for Phases 2, 3, and 6 respectively) and are not anti-patterns.

### Human Verification Required

None. All success criteria for this phase are verifiable programmatically.

### Gaps Summary

One gap found: the presence of `.eslintignore` causes a process-level `ESLintIgnoreWarning` to be emitted to stderr every time `pnpm lint` runs. ESLint v9 flat config does not support `.eslintignore` — it logs a deprecation warning and ignores the file's contents. Since `eslint.config.js` already has a complete `ignores` block covering `dist/**`, `node_modules/**`, and `coverage/**`, the `.eslintignore` file is both redundant and harmful.

The fix is a single file deletion. All other phase deliverables are fully verified.

---

_Verified: 2026-04-24T10:32:00Z_
_Verifier: Claude (gsd-verifier)_
