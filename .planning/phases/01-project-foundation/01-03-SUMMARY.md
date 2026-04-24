---
phase: 01-project-foundation
plan: "03"
subsystem: tooling
tags: [eslint, prettier, vitest, coverage-v8, typescript-eslint, flat-config, no-buffer-slice]
dependency_graph:
  requires:
    - phase: 01-01
      provides: package.json, tsconfig.json, stub barrels (src/index.ts, src/testing/index.ts, src/ack-from-hl7/index.ts), pnpm-lock.yaml
  provides:
    - eslint.config.js with recommended-type-checked preset and SETUP-07 no-buffer-slice rule
    - vitest.config.ts with @vitest/coverage-v8 and 90% per-directory thresholds
    - .prettierrc.json with community TypeScript/Node defaults
    - test/sanity.test.ts proving the Vitest harness works
    - src/framing/.gitkeep, src/server/.gitkeep, src/client/.gitkeep tracking empty dirs
  affects:
    - 01-04 (CI workflow that runs lint/test/coverage)
    - phase-02+ (all library source must pass the SETUP-07 no-buffer-slice rule)
tech_stack:
  added:
    - typescript-eslint@8.59.0 (unified package, replaces separate @typescript-eslint/eslint-plugin + parser)
    - "@eslint/js@9.39.4 (base recommended rules for flat config)"
  patterns:
    - ESLint v9 flat config format (eslint.config.js)
    - No-restricted-syntax for domain-specific rule enforcement (SETUP-07)
    - Vitest coverage-v8 with per-directory 90% gates
    - Explicit vitest imports (globals:false) for tree-shaking clarity
key_files:
  created:
    - eslint.config.js
    - .eslintignore
    - .prettierrc.json
    - .prettierignore
    - vitest.config.ts
    - test/sanity.test.ts
    - src/framing/.gitkeep
    - src/server/.gitkeep
    - src/client/.gitkeep
  modified:
    - package.json (replaced @typescript-eslint/eslint-plugin + @typescript-eslint/parser with typescript-eslint unified + @eslint/js)
    - pnpm-lock.yaml (updated after devDependency changes)
key_decisions:
  - "Replaced @typescript-eslint/eslint-plugin + @typescript-eslint/parser with unified typescript-eslint@8 package — required for tseslint.config() flat config helper and recommended-type-checked spread"
  - "SETUP-07 implemented via no-restricted-syntax selector targeting CallExpression[callee.property.name='slice'] — fires as error (not warn) in src/framing|server|client"
  - "strict-type-checked explicitly absent per D-03 — not semver-stable between minor versions"
  - "projectService:true in parserOptions enables TypeScript language service for type-aware rules without needing a tsconfig path reference"
patterns_established:
  - "ESLint flat config: recommended-type-checked base with targeted per-directory overrides for domain rules"
  - "Domain-specific lint rule via no-restricted-syntax (avoids custom plugin overhead)"
  - "Vitest coverage-v8 with explicit include/exclude lists (barrel files excluded from coverage)"
requirements_completed:
  - SETUP-06
  - SETUP-07
duration: 3min
completed: "2026-04-24"
---

# Phase 1 Plan 03: ESLint / Prettier / Vitest Setup Summary

**ESLint flat config with type-aware rules and SETUP-07 no-buffer-slice enforcement, Prettier, and Vitest coverage-v8 with 90% gates — all three toolchain checks exit 0.**

## Performance

- **Duration:** ~3 minutes
- **Started:** 2026-04-24T14:14:57Z
- **Completed:** 2026-04-24T14:17:17Z
- **Tasks:** 3
- **Files modified:** 9 created, 2 modified

## Accomplishments

- ESLint v9 flat config with `@typescript-eslint/recommended-type-checked`, `projectService:true`, and SETUP-07 `no-buffer-slice` rule enforced as `error` scoped to `src/framing|server|client`
- Prettier configured with community TypeScript/Node defaults (printWidth:100, singleQuote, trailingComma:all)
- Vitest with `@vitest/coverage-v8`, 90% thresholds on all four metrics, 2 sanity tests passing
- SETUP-07 rule verified: linting a `.slice()` call in `src/framing/` produces error with full guidance message

## Task Commits

Each task was committed atomically:

1. **Task 1: ESLint flat config with SETUP-07 no-buffer-slice rule** - `9c22a28` (chore)
2. **Task 2: Prettier config** - `01dd811` (chore)
3. **Task 3: Vitest config, coverage gates, and sanity test** - `ecfae33` (chore)

**Plan metadata:** (docs commit to follow)

## Files Created/Modified

- `eslint.config.js` — ESLint v9 flat config: recommended-type-checked base, projectService:true, no-buffer-slice error in framing|server|client, D-02 warn overrides for transport|connection
- `.eslintignore` — Legacy compat shim (dist/, node_modules/, coverage/)
- `.prettierrc.json` — printWidth:100, singleQuote:true, trailingComma:all, endOfLine:lf
- `.prettierignore` — Ignores dist/, node_modules/, coverage/, pnpm-lock.yaml, *.md
- `vitest.config.ts` — provider:v8, 90% thresholds (lines/functions/branches/statements), explicit include/exclude
- `test/sanity.test.ts` — VERSION export assertion + Node.js 20+ version check
- `src/framing/.gitkeep` — Tracks empty directory for Phase 2 framing code
- `src/server/.gitkeep` — Tracks empty directory for Phase 3 server code
- `src/client/.gitkeep` — Tracks empty directory for Phase 4 client code
- `package.json` — Replaced separate @typescript-eslint/* with unified typescript-eslint@8 + @eslint/js
- `pnpm-lock.yaml` — Updated lockfile after devDep changes

## Decisions Made

- Replaced `@typescript-eslint/eslint-plugin` + `@typescript-eslint/parser` with the unified `typescript-eslint@8` package. The plan specified this as the correct approach for flat config — `tseslint.config()` and `tseslint.configs.recommendedTypeChecked` are only available from the unified package.
- `strict-type-checked` explicitly absent per D-03 — it is not semver-stable and would break CI on minor version bumps.
- SETUP-07 implemented with `no-restricted-syntax` AST selector instead of a custom plugin — zero plugin overhead, same enforcement.

## Deviations from Plan

None — plan executed exactly as written. The unified `typescript-eslint` package swap was specified by the plan.

## Known Stubs

None — all files created in this plan are production tooling configuration (not library code) and do not introduce UI stubs or placeholder data.

## Threat Flags

None. ESLint rules and Vitest config are development-time tooling — no new network endpoints, auth paths, or runtime security surfaces introduced.

## Self-Check

Verified file existence:
- eslint.config.js: FOUND
- .prettierrc.json: FOUND
- vitest.config.ts: FOUND
- test/sanity.test.ts: FOUND
- src/framing/.gitkeep: FOUND
- src/server/.gitkeep: FOUND
- src/client/.gitkeep: FOUND

Verified commits exist: 9c22a28, 01dd811, ecfae33 — confirmed in git log.

Verified success criteria:
- `pnpm lint` exits 0: PASS
- `pnpm format:check` exits 0: PASS
- `pnpm test` exits 0 with 2 tests passing: PASS
- eslint.config.js uses recommendedTypeChecked (not strict-type-checked): PASS
- eslint.config.js has projectService:true in parserOptions: PASS
- eslint.config.js has no-restricted-syntax error targeting .slice() in src/framing|server|client: PASS (verified with test file)
- vitest.config.ts has provider:v8 and all four thresholds at 90: PASS

## Self-Check: PASSED
