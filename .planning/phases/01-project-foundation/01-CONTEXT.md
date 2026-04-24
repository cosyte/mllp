# Phase 1: Project Foundation - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Scaffold the repo, build, lint, and TypeScript toolchain so any subsequent phase can iterate without revisiting tooling. Delivers: `package.json` with correct `engines`/`peerDependenciesMeta`, dual ESM+CJS via tsup with three subpath entries, strict TypeScript config, ESLint flat config with custom SETUP-07 rule, Vitest + coverage-v8 with per-directory 90% gates, and a GitHub Actions CI workflow on a 3×3 OS × Node matrix. No library source beyond stub barrels in Phase 1.

</domain>

<decisions>
## Implementation Decisions

### ESLint configuration
- **D-01:** Base preset: `@typescript-eslint/recommended-type-checked` with `parserOptions.projectService: true` in the ESLint flat config. Enables type-aware rules (`no-floating-promises`, `no-misused-promises`, `await-thenable`) that are the primary bug vectors for a TCP async state-machine library.
- **D-02:** If `no-unsafe-*` false positives appear from `@types/node` gaps (e.g. `socket.read()` returning `Buffer | null` typed as `any`), add targeted per-directory `warn` or `off` overrides in `eslint.config.js` — do not downgrade the entire preset.
- **D-03:** `@typescript-eslint/strict-type-checked` is explicitly rejected: it is not semver-stable and its minor-version rule additions would break CI during Phases 2–7 without any code changes.
- **D-04:** SETUP-07 custom no-buffer-slice rule runs in addition to the preset, scoped to `src/framing`, `src/server`, `src/client`.

### CI workflow structure
- **D-05:** Triggers: `push` to `main` + `pull_request` targeting `main`. No push triggers on feature branches (avoids double-firing when a PR is open).
- **D-06:** Concurrency: `group: ${{ github.workflow }}-${{ github.head_ref || github.run_id }}` with `cancel-in-progress: true`. The `github.run_id` fallback prevents main-branch pushes from cancelling each other.
- **D-07:** Matrix job: `fail-fast: false` so all 9 cells (Ubuntu/macOS/Windows × Node 20/22/24) complete independently and produce distinct diagnostic signal. A failing macOS cell must not abort in-flight Windows cells.
- **D-08:** pnpm cache: `pnpm/action-setup@v4` for install + `cache: "pnpm"` on `actions/setup-node@v4` (official delegated approach — no manual `actions/cache` block keyed on lockfile path).
- **D-09:** Lint, typecheck, and coverage jobs run on Ubuntu only (not in the matrix). `@arethetypeswrong/cli` publish-gate runs as a separate step on Ubuntu.

### tsup build configuration
- **D-10:** `sourcemap: true` — external `.map` files in `dist/`. Debuggable stack traces for OSS contributors and consumers. Tarball weight is immaterial for a Node transport library.
- **D-11:** `dts: true` — tsup-bundled `.d.ts` + `.d.cts` per entry. Zero runtime deps means the known limitation (no `node_modules` type resolution) is irrelevant — all public types are local.
- **D-12:** `experimental-dts` / `@microsoft/api-extractor` is **explicitly excluded**: documented as single-entrypoint only; breaks on the three-subpath layout (main / testing / ack-from-hl7) per egoist/tsup#1046.
- **D-13:** `clean: true` before every build. Stale `dist/` artifacts from prior build configurations silently poison the publish-gate check.
- **D-14:** Fallback: if `@arethetypeswrong/cli` rejects the tsup-generated `.d.ts` for any subpath, switch to `tsc --emitDeclarationOnly` with a dedicated `tsconfig.build.json`. This is the known-good escape hatch, not the default.

### Claude's Discretion
- Exact Prettier configuration (print width, trailing commas, bracket spacing) — follow community defaults for TypeScript/Node libraries.
- Sanity test content in Vitest — a minimal passing test to verify the harness, no library logic.
- SPDX banner in tsup output — cosmetic; skip unless org style requires it.
- `pnpm-lock.yaml` committed on initial setup as lockfile.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and decisions
- `.planning/PROJECT.md` — Vision, constraints, key decisions (Buffer-first API, zero runtime deps, Node 20+, Postel's Law, 6-state FSM, peerDep structure)
- `.planning/REQUIREMENTS.md` — SETUP-01 through SETUP-07 (all Phase 1 REQ-IDs with acceptance criteria)
- `.planning/ROADMAP.md` §"Phase 1: Project Foundation" — Four-plan breakdown, success criteria (5 items), canonical plan slugs

### Research synthesis
- `.planning/research/SUMMARY.md` — Post-research accepted actions; Node 20 floor (SETUP-05 amendment), selfsigned cert-gen at pretest, @arethetypeswrong/cli as publish-gate

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — clean repo. Phase 1 creates everything from scratch.

### Established Patterns
- None yet — Phase 1 establishes the patterns all subsequent phases follow.

### Integration Points
- `src/index.ts`, `src/testing/index.ts`, `src/ack-from-hl7/index.ts` — stub barrels that Phase 2+ will populate.
- `examples/tls/certs/` — gitignored directory, TLS test certs generated at `pretest` via `selfsigned` (per SUMMARY.md research).

</code_context>

<specifics>
## Specific Ideas

- No specific references beyond the ROADMAP/REQUIREMENTS specs — the planner has complete lattice from locked decisions.

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within Phase 1 scope.

</deferred>

---

*Phase: 01-project-foundation*
*Context gathered: 2026-04-24*
