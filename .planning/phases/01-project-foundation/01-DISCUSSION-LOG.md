# Phase 1: Project Foundation - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 01-project-foundation
**Areas discussed:** ESLint rule set, CI trigger strategy, tsup build config details

---

## ESLint rule set

| Option | Description | Selected |
|--------|-------------|----------|
| `recommended-type-checked` | Type-aware rules (no-floating-promises, no-misused-promises, await-thenable). Semver-stable. Lint time ~= tsc. | ✓ |
| `recommended-type-checked` + per-dir overrides | Same base; per-directory warn/off overrides pre-configured for @types/node gaps. | |
| `recommended` (no type-aware) | Fastest. Misses all async-promise rules. | |
| `strict-type-checked` | Most comprehensive but not semver-stable — minor bumps add rules that break CI mid-project. | |

**User's choice:** `recommended-type-checked` (Recommended)
**Notes:** If `no-unsafe-*` false positives appear from @types/node gaps, add targeted per-directory overrides — don't downgrade the preset.

---

## CI trigger strategy

| Option | Description | Selected |
|--------|-------------|----------|
| main + PRs + concurrency cancel | push to main + PR triggers; concurrency group cancels stale runs on rebase; fail-fast: false; pnpm cache. | ✓ |
| Push to main + all PRs (simple) | Standard pattern, no concurrency block. Stale PR runs waste matrix slots on rapid rebases. | |
| PRs only | Cheapest. Main never independently validated. | |
| Push to any branch + PRs | Double-fires (18 matrix cells) when PR is open. | |

**User's choice:** main + PRs + concurrency cancel (Recommended)
**Notes:** `fail-fast: false` is intentional — each of the 9 matrix cells provides independent diagnostic signal.

---

## tsup build config details

| Option | Description | Selected |
|--------|-------------|----------|
| sourcemap: true, dts: true, clean: true | Standard OSS baseline. External .map files. tsup-bundled .d.ts for multi-entry. Clean on each build. | ✓ |
| sourcemap: false, dts: true, clean: true | Smaller tarball. Stack traces point to dist/ line numbers. | |
| sourcemap: true, dts: true, clean: true + SPDX banner | Adds // SPDX-License-Identifier: MIT header. Cosmetic only. | |
| sourcemap: true, tsc --emitDeclarationOnly | tsc for declarations instead of tsup dts. Full compiler fidelity but two-step build. | |

**User's choice:** sourcemap: true, dts: true, clean: true (Recommended)
**Notes:** `experimental-dts` explicitly excluded — broken for multi-entry builds (egoist/tsup#1046). If @arethetypeswrong/cli rejects output, fall back to tsc --emitDeclarationOnly.

---

## Claude's Discretion

- Prettier configuration — follow community defaults
- Sanity test content — minimal passing test
- SPDX banner — skip unless org style requires

## Deferred Ideas

None — discussion stayed within Phase 1 scope.
