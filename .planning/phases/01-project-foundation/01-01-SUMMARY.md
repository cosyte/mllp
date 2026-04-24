---
phase: 01-project-foundation
plan: "01"
subsystem: project-scaffold
tags: [package-json, tsconfig, typescript, pnpm, stub-barrels, license]
dependency_graph:
  requires: []
  provides:
    - package.json with @cosyte/hl7-mllp identity, engines, peerDependencies
    - tsconfig.json with strict + noUncheckedIndexedAccess + ES2022 + NodeNext
    - tsconfig.build.json with emitDeclarationOnly for tsc fallback
    - src/index.ts stub barrel (main)
    - src/testing/index.ts stub barrel (testing subpath)
    - src/ack-from-hl7/index.ts stub barrel (ack-from-hl7 subpath)
    - pnpm-lock.yaml (all devDependencies resolved)
    - LICENSE (MIT 2026 Cosyte)
    - README.md (stub)
    - .gitignore (including examples/tls/certs/ and bench/results/)
    - .npmrc (auto-install-peers=false)
  affects: []
tech_stack:
  added:
    - typescript@5.9.3
    - tsup@8.5.1
    - vitest@3.2.4
    - "@vitest/coverage-v8@3.2.4"
    - eslint@9.39.4
    - prettier@3.8.3
    - selfsigned@2.4.1
    - mitata@0.1.14
    - "@arethetypeswrong/cli@0.17.x"
    - "@types/node@20.x"
    - "@typescript-eslint/eslint-plugin@8.x"
    - "@typescript-eslint/parser@8.x"
  patterns:
    - pnpm as package manager
    - strict TypeScript (strict=true, noUncheckedIndexedAccess=true)
    - ES2022 target with NodeNext module resolution
    - optional peerDependency pattern for @cosyte/hl7
key_files:
  created:
    - package.json
    - tsconfig.json
    - tsconfig.build.json
    - src/index.ts
    - src/testing/index.ts
    - src/ack-from-hl7/index.ts
    - LICENSE
    - README.md
    - .npmrc
    - pnpm-lock.yaml
  modified:
    - .gitignore (added examples/tls/certs/ and bench/results/ entries)
decisions:
  - "Added .npmrc with auto-install-peers=false to prevent pnpm 10 from fetching optional @cosyte/hl7 peer dep from npm registry (package not yet published; sibling exists locally)"
metrics:
  duration: "~3 minutes"
  completed: "2026-04-24"
  tasks_completed: 3
  tasks_total: 3
  files_created: 10
  files_modified: 1
---

# Phase 1 Plan 01: Package Scaffold Summary

Package manifest, TypeScript config, license, README stub, .gitignore, and three empty barrel files scaffolded. `pnpm tsc --noEmit` exits 0; zero runtime dependencies; optional peerDependency pattern established for `@cosyte/hl7`.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Create package.json and .gitignore | 8175091 | package.json, .gitignore |
| 2 | Create tsconfig, stub barrels, LICENSE, README | a6da111 | tsconfig.json, tsconfig.build.json, src/index.ts, src/testing/index.ts, src/ack-from-hl7/index.ts, LICENSE, README.md |
| 3 | pnpm install | 2373bf9 | pnpm-lock.yaml, .npmrc |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking Issue] Added .npmrc to suppress optional peer dep resolution**
- **Found during:** Task 3 (pnpm install)
- **Issue:** pnpm 10 with `auto-install-peers` (default true) attempted to fetch `@cosyte/hl7` from the npm registry during install. The package is not yet published — it exists as a local sibling at `../hl7-parser`. Install failed with `ERR_PNPM_FETCH_404`.
- **Fix:** Added `.npmrc` with `auto-install-peers=false` to suppress automatic installation of peer dependencies. The `peerDependenciesMeta.optional = true` setting in package.json correctly declares the intent; the `.npmrc` tells pnpm 10 not to auto-fetch it.
- **Files modified:** `.npmrc` (new file)
- **Commit:** 2373bf9

## Known Stubs

The following stubs are intentional per the plan — they are placeholder exports that allow TypeScript to treat the files as modules. They will be replaced in later phases.

| File | Export | Reason | Resolving Phase |
|------|--------|--------|-----------------|
| src/index.ts | `VERSION = '0.1.0'` | Stub export so tsc treats file as a module | Phase 2+ |
| src/testing/index.ts | `TESTING_STUB = true` | Stub export so tsc treats file as a module | Phase 3 |
| src/ack-from-hl7/index.ts | `ACK_FROM_HL7_STUB = true` | Stub export so tsc treats file as a module | Phase 6 |

These stubs do not block the plan goal (skeleton scaffold). They are the intended output.

## Threat Flags

None. The `.npmrc` change is a dev-time configuration that only affects pnpm's install behavior; it introduces no new network endpoints, auth paths, or security-relevant surfaces.

## Self-Check

Verified file existence:
- package.json: FOUND
- tsconfig.json: FOUND
- tsconfig.build.json: FOUND
- src/index.ts: FOUND
- src/testing/index.ts: FOUND
- src/ack-from-hl7/index.ts: FOUND
- LICENSE: FOUND
- README.md: FOUND
- .npmrc: FOUND
- pnpm-lock.yaml: FOUND

Verified commits exist: 8175091, a6da111, 2373bf9 — all in git log.

Verified success criteria:
- `pnpm tsc --noEmit` exits 0 with no errors: PASS
- Zero runtime dependencies: PASS
- `engines.node = ">=20.0.0"`: PASS
- `@cosyte/hl7` in peerDependencies with optional=true: PASS
- `strict=true`, `noUncheckedIndexedAccess=true`, `target="ES2022"`, `module="NodeNext"`: PASS
- All three stub barrels have `@packageDocumentation` JSDoc: PASS

## Self-Check: PASSED
