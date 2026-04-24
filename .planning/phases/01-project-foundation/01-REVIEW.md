---
phase: 01-project-foundation
reviewed: 2026-04-24T00:00:00Z
depth: standard
files_reviewed: 18
files_reviewed_list:
  - .github/workflows/ci.yml
  - .gitignore
  - .eslintignore
  - .npmrc
  - .prettierignore
  - .prettierrc.json
  - eslint.config.js
  - package.json
  - pnpm-workspace.yaml
  - scripts/generate-test-certs.mjs
  - src/ack-from-hl7/index.ts
  - src/index.ts
  - src/testing/index.ts
  - test/sanity.test.ts
  - tsconfig.build.json
  - tsconfig.json
  - tsup.config.ts
  - vitest.config.ts
findings:
  critical: 0
  warning: 4
  info: 5
  total: 9
status: issues_found
---

# Phase 1: Code Review Report

**Reviewed:** 2026-04-24T00:00:00Z
**Depth:** standard
**Files Reviewed:** 18
**Status:** issues_found

## Summary

This phase establishes the project scaffold: package.json, TypeScript/tsup/ESLint/Vitest config, CI workflow, stub source barrels, and a cert generation script. The foundation is solid — the choices match the locked tech stack and the engineering guardrails are clearly reflected in config. Four warnings and five informational issues were found, none critical. The most actionable items are a CI coverage job that swallows failures silently, a `tsconfig.json` `rootDir` that excludes test files from type-checking, a `no-buffer-slice` ESLint rule whose AST selector has a false-positive gap, and a `pnpm-workspace.yaml` that may unintentionally enable workspace features.

## Warnings

### WR-01: CI coverage job uses `continue-on-error: true` — failures are silently swallowed

**File:** `.github/workflows/ci.yml:112`
**Issue:** The `coverage` job runs `pnpm test --coverage` with `continue-on-error: true`. This means the coverage threshold check (90% gates on framing/server/client configured in `vitest.config.ts`) will never actually block a PR — threshold violations are reported green. The intent was probably to keep the job non-blocking while coverage infra is bootstrapped, but once real source lands in Phase 2+, this will hide regressions silently.
**Fix:** Either remove `continue-on-error: true` once coverage thresholds are enforced, or add a comment with a TODO tracking the phase at which it should be removed. A safer intermediate: set `continue-on-error: true` only conditionally via an env variable that can be toggled per-run, or add coverage as a required check only after Phase 5.

### WR-02: `tsconfig.json` `rootDir: "src"` excludes test files from the default typecheck

**File:** `tsconfig.json:9`
**Issue:** `rootDir` is set to `"src"` and `include` is `["src/**/*.ts"]`. The `typecheck` script (`tsc --noEmit`) therefore never type-checks `test/**/*.ts`. Type errors in tests — including the `test/sanity.test.ts` import path `'../src/index.js'` — are invisible to CI's typecheck job. In a project with `noUncheckedIndexedAccess` and strict mode, test-file type errors are not cosmetic.
**Fix:** Add a separate `tsconfig.test.json` that extends the base config, sets `rootDir` to `.` (or removes it), and includes both `src/**/*.ts` and `test/**/*.ts`. Update the `typecheck` script to also run `tsc -p tsconfig.test.json --noEmit`, or use Vitest's own `typecheck` support (`vitest typecheck`).

### WR-03: `no-restricted-syntax` selector for `Buffer.slice` has a false-positive gap

**File:** `eslint.config.js:29-31`
**Issue:** The selector `CallExpression[callee.property.name='slice'][callee.object.type!='ArrayExpression']` blocks `.slice()` on anything that is not an array literal — but it would also flag `.slice()` on `string` values and `Array` variables that are not literals (e.g., `someArray.slice(0, 3)`). String `.slice()` and array `.slice()` calls in `src/framing|server|client` will trigger spurious lint errors when those files are populated. Conversely, a Buffer stored in a variable typed as `ArrayBuffer` would pass the check.
**Fix:** Tighten the selector to target the call more precisely. Because ESLint's AST cannot inspect runtime types, the most reliable approach is to restrict on the property name combined with file scope (already done), and document the known false-positive surface. Alternatively, use a `@typescript-eslint/no-restricted-types`-style approach at the type level, or suppress the rule per-line for legitimate string/array `.slice()` calls with an explanatory comment.

### WR-04: `pnpm-workspace.yaml` declares `allowBuilds` for esbuild without a `packages` field

**File:** `pnpm-workspace.yaml:1-2`
**Issue:** The file contains only `allowBuilds: esbuild: true` and no `packages:` array. Without a `packages` field, pnpm treats the repo as a single-package workspace — the `allowBuilds` key is an `onlyBuiltDependencies`-related security option (pnpm v9+). If pnpm ever resolves this repo as a true monorepo context (e.g., when referenced from a parent workspace), the missing `packages:` could cause unexpected dependency resolution. More immediately: the YAML syntax for `allowBuilds` in pnpm v9 is `onlyBuiltDependencies: [esbuild]`, not `allowBuilds: esbuild: true`. If the intended pnpm version uses a different key name, this config silently does nothing.
**Fix:** Verify the correct key name for the installed pnpm version (`onlyBuiltDependencies` vs `allowBuilds`). If this is a standalone package repo, remove the `pnpm-workspace.yaml` entirely and put `onlyBuiltDependencies` in `.npmrc` or `package.json#pnpm`. If a workspace file is required, add `packages: ['.']` to make intent explicit.

## Info

### IN-01: `publish-gate` job uses `continue-on-error: true` on `attw`

**File:** `.github/workflows/ci.yml:139`
**Issue:** `attw --pack` runs with `continue-on-error: true`, so type-wrong failures never block publishing. This is understandable while the package is a stub, but the comment says it is a publish-gate. The non-blocking flag undermines the gate.
**Fix:** Add a TODO comment referencing the phase at which `continue-on-error` should be removed (Phase 5 or before first publish), so it is not accidentally left in place permanently.

### IN-02: `eslint.config.js` ignores `*.config.*` — this file ignores itself

**File:** `eslint.config.js:53`
**Issue:** The `ignores` array includes `'*.config.*'`, which means `eslint.config.js`, `tsup.config.ts`, `vitest.config.ts` are all excluded from ESLint. These files are source code with meaningful logic and can contain bugs. The `tsup.config.ts` and `vitest.config.ts` files have non-trivial configuration that benefits from linting.
**Fix:** If the intent is to skip linting config files to avoid false positives from `recommendedTypeChecked` (which requires tsconfig project service), add only the specific config files that cause issues to `ignores`, or set up a separate override block with relaxed rules for `*.config.ts` files rather than silencing them entirely.

### IN-03: `scripts/generate-test-certs.mjs` uses `console.log` — acceptable in a script but worth noting

**File:** `scripts/generate-test-certs.mjs:39-42`
**Issue:** The CLAUDE.md guardrail "No `console.*` in library code" applies to `src/`. This script is a dev utility (not library code), so `console.log` is fine here. However, the script is not linted (it is in `scripts/`, which is not in ESLint's `src` target), so future additions to scripts will also be silently unguarded.
**Fix:** No change required. Documented for awareness. Consider adding `scripts/` to the ESLint target if scripts grow in complexity.

### IN-04: `src/index.ts` VERSION constant is hardcoded — will drift from `package.json`

**File:** `src/index.ts:17`
**Issue:** `export const VERSION = '0.1.0'` duplicates the version in `package.json`. When the package is bumped to 0.2.0, this constant must be manually updated. The `test/sanity.test.ts:6` asserts `VERSION === '0.1.0'`, which means a version bump without updating this constant will break CI — good — but the source of truth is split.
**Fix:** Consider deriving `VERSION` from `package.json` at build time via a tsup `define` substitution, or use `import pkg from '../package.json' assert { type: 'json' }` (Node 20+ supports this with `resolveJsonModule: true`). For now, the manual approach is acceptable as long as the CI test catches it.

### IN-05: `vitest.config.ts` coverage thresholds are global, not per-directory

**File:** `vitest.config.ts:16-21`
**Issue:** CLAUDE.md specifies "per-directory 90% gates on `src/framing/`, `src/server/`, `src/client/`." The current config sets global thresholds (`lines: 90`, `functions: 90`, etc.) but not per-directory thresholds. With global thresholds, well-covered utility code can mask under-covered framing/server/client code. Vitest v1+ supports `thresholds.perFile` and per-path overrides.
**Fix:** When Phase 2+ populates those directories, add per-directory threshold config using Vitest's `thresholds` with `include` patterns, or use a coverage reporter that enforces per-file minimums. The comment in the config already notes this is deferred — ensure it is tracked for Phase 2 at the latest.

---

_Reviewed: 2026-04-24T00:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
