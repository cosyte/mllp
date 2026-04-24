---
phase: 01-project-foundation
plan: "04"
subsystem: ci-pipeline
tags: [github-actions, ci, matrix, attw, tls-certs, selfsigned, publish-gate]
dependency_graph:
  requires:
    - "01-02: pnpm build (tsup dual output)"
    - "01-03: pnpm lint, pnpm test, pnpm typecheck (ESLint/Vitest configured)"
  provides:
    - .github/workflows/ci.yml with 3x3 OS x Node matrix + Ubuntu-only lint/typecheck/coverage/publish-gate
    - scripts/generate-test-certs.mjs for Phase 8 TLS examples
    - attw script entry in package.json
  affects:
    - All future phases: CI gates every PR and main push
tech_stack:
  added:
    - GitHub Actions (pnpm/action-setup@v4, actions/setup-node@v4, actions/checkout@v4)
    - "@arethetypeswrong/cli (publish-gate step, soft until Phase 8)"
  patterns:
    - 3x3 OS x Node matrix with fail-fast:false (D-07)
    - concurrency cancel-in-progress with run_id fallback for main (D-06)
    - pnpm cache via setup-node cache:pnpm (D-08)
    - Ubuntu-only for lint/typecheck/coverage/publish-gate (D-09)
    - Soft continue-on-error on coverage and attw gates until Phase 7/8
key_files:
  created:
    - .github/workflows/ci.yml
    - scripts/generate-test-certs.mjs
  modified:
    - package.json (added attw script entry)
decisions:
  - "attw script added to package.json as a standalone script entry so CI can invoke pnpm attw --pack cleanly — prepublishOnly already used attw but no standalone script existed"
  - "continue-on-error:true on coverage job (Phase 7 will harden) and publish-gate job (Phase 8 fully wires types)"
  - "examples/tls/certs/ is gitignored per T-04-01 threat mitigation; script warns NEVER commit in inline comments"
metrics:
  duration: "~5 minutes"
  completed: "2026-04-24"
  tasks_completed: 2
  tasks_total: 2
  files_created: 2
  files_modified: 1
---

# Phase 1 Plan 04: CI Workflow + TLS Cert Script Summary

GitHub Actions CI workflow with 3x3 OS x Node matrix (9 cells), Ubuntu-only lint/typecheck/coverage/publish-gate jobs, and `scripts/generate-test-certs.mjs` using selfsigned; full pipeline smoke test (`pnpm install && build && typecheck && lint && test`) exits 0.

## Tasks Completed

| Task | Name | Commit | Key Files |
|------|------|--------|-----------|
| 1 | Create GitHub Actions CI workflow | d035774 | .github/workflows/ci.yml, package.json |
| 2 | Create TLS cert generation script and run full pipeline smoke test | b616083 | scripts/generate-test-certs.mjs |

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical Functionality] Added standalone attw script to package.json**
- **Found during:** Task 1 (creating CI workflow)
- **Issue:** The CI workflow invokes `pnpm attw --pack` but package.json had no `attw` script — only `prepublishOnly` which bakes in `pnpm build && attw --pack`. Without a standalone script, `pnpm attw` would fail in CI.
- **Fix:** Added `"attw": "attw"` to the scripts section of package.json.
- **Files modified:** `package.json`
- **Commit:** d035774

## Known Stubs

None. Both files created are production artifacts (CI config + utility script), not library stubs.

## Threat Flags

None. The threat mitigations from the plan's threat model are all addressed:
- T-04-01: `examples/tls/certs/` gitignored (verified via `git check-ignore`); script warns "NEVER commit"
- T-04-02: All CI jobs use `pnpm install --frozen-lockfile`
- T-04-03: `fail-fast:false` accepted per D-07
- T-04-04: No `permissions:` block — workflow is read-only (no write/deploy steps)

## Self-Check

Verified file existence:
- .github/workflows/ci.yml: FOUND
- scripts/generate-test-certs.mjs: FOUND
- examples/tls/certs/server-key.pem: FOUND (gitignored)
- examples/tls/certs/server-cert.pem: FOUND (gitignored)
- examples/tls/certs/ca-cert.pem: FOUND (gitignored)

Verified commits exist: d035774, b616083 — confirmed in git log.

Verified CI workflow structure:
- fail-fast: false: PASS
- cancel-in-progress: true: PASS
- pnpm/action-setup@v4 (5 occurrences): PASS
- cache: pnpm (5 occurrences): PASS
- windows-latest in matrix: PASS
- node: ['20', '22', '24']: PASS
- publish-gate needs [test, lint, typecheck]: PASS

Verified full pipeline (SETUP-01 acceptance criterion):
- pnpm install --frozen-lockfile: PASS
- pnpm build: PASS (12 dist artifacts)
- pnpm typecheck: PASS (exit 0)
- pnpm lint: PASS (exit 0)
- pnpm test: PASS (2 tests passing)

Verified gitignore:
- git check-ignore examples/tls/certs/server-key.pem: PASS

## Self-Check: PASSED
