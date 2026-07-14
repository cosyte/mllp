---
"@cosyte/mllp": patch
---

Phase 10 — release readiness for `0.0.1` (MLLP-10).

**Release-pipeline fix (this was a hard blocker).** The shared `cosyte/.github` release workflow drives Changesets with `version: pnpm run version`, but no `version` script existed — `pnpm run version` failed with `ERR_PNPM_NO_SCRIPT`, so the "Version Packages" PR could never be opened and `0.0.1` could never have been released. Added `"version": "changeset version && node scripts/sync-version.mjs && prettier --write package.json src/index.ts"`.

**`VERSION` export no longer lies about the release.** `VERSION` was hardcoded `"0.0.0"` in `src/index.ts` while `changeset version` bumps only `package.json` — the published `0.0.1` would have exported `"0.0.0"`. The new `scripts/sync-version.mjs` rewrites the constant from `package.json` as part of the `version` script, so the bump and the constant land in the same commit. `test/sanity.test.ts` now compares the export against `package.json` instead of asserting one hardcoded literal against another (the old test would have stayed green through exactly this drift).

**`VERSION` is now typed `string`, not a literal.** The published `.d.ts` declared `const VERSION = "0.0.0"`, leaking the current release into consumers' types and making an equality check against any other version a compile error. Now `export const VERSION: string`.

**Publish pipeline proven without burning a version.** Added `publish:dry` (`pnpm publish --dry-run --no-git-checks`). Verified end to end: `prepublishOnly` (clean → typecheck → lint → test → build → `attw`) green; `pnpm run version` consumes the pending changesets to exactly `0.0.1` and syncs the `VERSION` export; the dry-run packs 24 files (`dist/` + README + LICENSE + CHANGELOG) with public access and no `src/`, `test/`, or `vendor/` leakage; `pack:docs` produces both docs artifacts. No version was published.

**Full `docs-content/` transport guide.** New pages — **Framing & tolerance** (wire format, the opt-in tolerance flags with a `FrameReader`-vs-`MllpServer` default table, the stable warning-code registry, bounded accumulators, and the PHI contract on diagnostics), **ACKs & the commit contract** (the fail-safe ACK semantics, `autoAck` modes, the transport-accept caveat, correlation, `ack-from-hl7`), **Connection, reconnect & backpressure** (the 6-state machine, jittered backoff, the transient-vs-permanent classifier, keepalive vs dead-peer timeout, high-water marks, graceful drain), and **Known limitations & non-goals** (the "do not over-trust" statement: at-least-once at best, no queue/replay, no R2, no Epic/Cerner differential verification, no PKI, not byte-transparent, pre-stable API). Sidebar updated; all examples synthetic.

**Docs accuracy fix.** `intro.md` claimed the decoder is liberal outright. It is **strict by default** — tolerance is opt-in per flag, and it is `MllpServer` that ships tolerant defaults (`allowFsOnly`, `allowLfAfterFs`, `allowLeadingWhitespace`; `allowMissingLeadingVt` stays off even there). Corrected, and the README now documents the commit contract and the non-goals rather than only the feature list.
