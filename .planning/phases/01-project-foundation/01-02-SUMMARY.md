---
phase: 01-project-foundation
plan: "02"
subsystem: build-config
tags: [tsup, esm, cjs, dual-output, exports-map, typescript-declarations]
dependency_graph:
  requires:
    - "01-01: package.json, tsconfig.json, stub barrels, pnpm-lock.yaml"
  provides:
    - tsup.config.ts with 3 entries, ESM+CJS, sourcemap, dts, clean, external
    - package.json exports map with import/require/types conditions for 3 subpaths
    - dist/ artifacts (12 files: .js/.cjs/.d.ts/.d.cts per entry)
    - pnpm-workspace.yaml allowing esbuild builds non-interactively
  affects:
    - "01-03: ESLint/Vitest config — builds on established dist/ layout"
    - "01-04: CI workflow — pnpm build is a CI gate step"
tech_stack:
  added:
    - tsup@8.5.1 (configured, was installed in 01-01)
    - pnpm-workspace.yaml (allowBuilds.esbuild for non-interactive CI)
  patterns:
    - dual ESM+CJS output via tsup format:['esm','cjs']
    - TypeScript 5 NodeNext exports map pattern (types inside import/require blocks)
    - external peer dep pattern (@cosyte/hl7 never bundled)
    - clean build on every run (D-13)
    - sourcemap:true for debuggable dist/ (D-10)
    - dts:true for tsup-bundled declarations (D-11)
    - splitting:false for self-contained subpath bundles
key_files:
  created:
    - tsup.config.ts
    - pnpm-workspace.yaml
  modified:
    - package.json (exports map, main/module/types fields)
decisions:
  - "pnpm-workspace.yaml with allowBuilds.esbuild=true added to unblock tsup in non-interactive environments (CI). pnpm 10 requires explicit build approval for postinstall scripts; interactive approve-builds cannot run in CI."
  - "Sourcemap files (.map) and .d.ts files contain '@cosyte/hl7' string as JSDoc comments — this is expected and does not indicate bundling. Verified peer dep absent from actual .js/.cjs bundle files."
metrics:
  duration: "~4 minutes"
  completed: "2026-04-24"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 1
---

# Phase 1 Plan 02: tsup Build Config Summary

tsup configured for dual ESM+CJS output across three subpath entries; package.json exports map wired with TypeScript 5 NodeNext-compatible import/require/types conditions; `pnpm build` exits 0 producing 12 dist artifacts.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Create tsup.config.ts | 4f3d60b | tsup.config.ts |
| 2 | Populate package.json exports map and run build | bee6e0d | package.json, pnpm-workspace.yaml |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking Issue] Added pnpm-workspace.yaml to approve esbuild build scripts**
- **Found during:** Task 2 (pnpm build)
- **Issue:** `pnpm install` in the worktree environment warned "Ignored build scripts: esbuild@0.27.7" because pnpm 10 requires explicit approval for postinstall scripts. Without esbuild's native binary installed, `tsup` exits with "command not found" or silently produces no output.
- **Fix:** Ran `pnpm approve-builds --all` which created `pnpm-workspace.yaml` with `allowBuilds.esbuild: true`. This file is committed so CI and other developers get esbuild built automatically without interactive prompts.
- **Files modified:** `pnpm-workspace.yaml` (new file)
- **Commit:** bee6e0d

## Known Stubs

The dist/ artifacts are built from stub barrels created in 01-01. The dist/ outputs correctly expose stub exports (VERSION, TESTING_STUB, ACK_FROM_HL7_STUB). These are intentional per 01-01 and will be replaced in later phases.

| File | Export | Resolving Phase |
|------|--------|-----------------|
| dist/index.js | `VERSION = '0.1.0'` | Phase 2+ |
| dist/testing/index.js | `TESTING_STUB = true` | Phase 3 |
| dist/ack-from-hl7/index.js | `ACK_FROM_HL7_STUB = true` | Phase 6 |

## Threat Flags

None. The peer dep (`@cosyte/hl7`) is verified absent from all `.js` and `.cjs` bundle files. String appearances in `.map` and `.d.ts` files are JSDoc comments from source — not bundled code.

## Self-Check

Verified file existence:
- tsup.config.ts: FOUND
- pnpm-workspace.yaml: FOUND
- package.json (updated): FOUND

Verified dist/ artifacts (12 files):
- dist/index.js: FOUND
- dist/index.cjs: FOUND
- dist/index.d.ts: FOUND
- dist/index.d.cts: FOUND
- dist/testing/index.js: FOUND
- dist/testing/index.cjs: FOUND
- dist/testing/index.d.ts: FOUND
- dist/testing/index.d.cts: FOUND
- dist/ack-from-hl7/index.js: FOUND
- dist/ack-from-hl7/index.cjs: FOUND
- dist/ack-from-hl7/index.d.ts: FOUND
- dist/ack-from-hl7/index.d.cts: FOUND

Verified commits exist: 4f3d60b, bee6e0d — both in git log.

Verified success criteria:
- `pnpm build` exits 0: PASS
- 12 dist artifacts present: PASS
- exports map has 3 subpaths with import/require/types conditions: PASS
- `@cosyte/hl7` not bundled in JS/CJS: PASS
- `dist/index.js` is ESM (no `use strict`): PASS
- `dist/index.cjs` is CJS (`use strict` present): PASS

## Self-Check: PASSED
