# @cosyte/mllp — Project Guide for Claude

## Project

**`@cosyte/mllp`** — a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.

## Status

- **Phase 7 of 11** — client/server/framing/connection/transport shipped; Phase 6 (fail-safe ACK
  commit contract) and Phase 7 (`ack-from-hl7` — real helpers over `@cosyte/hl7`'s `buildAck`,
  stub removed) done. Next: Phase 8 TLS/MLLPS hardening (harness exists via `selfsigned`/`certs:gen`,
  tests pending). For dev/test the unpublished `@cosyte/hl7` peer is consumed as a **vendored packed
  tarball** (`vendor/cosyte-hl7-0.0.0.tgz`, a devDependency) — an interim mechanism until the
  cross-repo consumption decision (umbrella `PW-5` gate) lands; refresh it by re-running
  `pnpm -C ../hl7 build && pnpm -C ../hl7 pack --out ../mllp/vendor/cosyte-hl7-0.0.0.tgz`
  (`--out` resolves relative to the `-C` directory) then `pnpm remove @cosyte/hl7 &&
  pnpm add -D @cosyte/hl7@file:vendor/cosyte-hl7-0.0.0.tgz` — and note `pnpm remove` also
  strips the `peerDependencies` entry; restore it (`"@cosyte/hl7": ">=0.0.0"`) after.
- Migrated onto the shared `@cosyte/*` engineering standard (Phase E) and **renamed
  `@cosyte/hl7-mllp` → `@cosyte/mllp`** — not yet published, so the rename is free.
- Sibling package: `@cosyte/hl7` (optional peer dep, not a runtime dep).

## Tech Stack (the shared `@cosyte/*` standard)

mllp inherits the canonical toolchain by depending on the published `@cosyte/*` config packages, not
by copying files. The source of truth is the meta-repo's `documentation/conventions.md` — this is a
summary.

- **Language:** TypeScript (strict, full rigor set incl. `noUncheckedIndexedAccess`) via
  `@cosyte/tsconfig`. **Target ES2023**, `NodeNext`.
- **Build:** dual ESM + CJS + `.d.ts` via `tsup` (`@cosyte/tsup-config`); `attw` is a publish gate
  (per-condition types: `.d.ts` for `import`, `.d.cts` for `require`) across all three subpaths
  (root, `/testing`, `/ack-from-hl7`).
- **Node:** **>= 22** (CI matrix 22 + 24).
- **Package manager:** `pnpm@10`.
- **Lint/format:** **ESLint 10** + unified `typescript-eslint` (type-checked) via
  `@cosyte/eslint-config`; Prettier via `@cosyte/prettier-config`. Lint at `--max-warnings=0`.
- **Testing:** **Vitest 4** + v8 coverage (`@cosyte/vitest-config`), per-directory >= 90 gates on
  `src/framing|client|connection|server|transport`.
- **CI/CD:** thin callers of the reusable `cosyte/.github` workflows.
- **Runtime deps:** **Zero.** Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`).
- **Peer deps:** `@cosyte/hl7` as an **optional** peer dep, referenced only from the
  `@cosyte/mllp/ack-from-hl7` subpath (tsup `external`, never bundled).
- **TLS test certs:** generated via `selfsigned` (`pnpm certs:gen`) into gitignored
  `examples/tls/certs/`; never committed.
- **License:** MIT

## Engineering Guardrails

- No `any`. No unjustified `as` casts. Use `unknown` and narrow.
- JSDoc (with `@example`) on every public export — feeds IntelliSense.
- **Buffer-first API** on every public surface — never string. HL7 v2 payloads are raw bytes with caller-managed charset decoding.
- **`Buffer.prototype.slice()` is forbidden** in `src/framing|server|client` (enforced by the local `no-restricted-syntax` ESLint rule in `eslint.config.js`). Use `.subarray()` — `.slice()` copies in modern Node.
- **Postel's Law:** decoder is liberal (tolerance opt-ins + warnings with stable codes + byte offsets), encoder is strict (always emits canonical `VT + payload + FS + CR`).
- **Stable warning codes** are a public API. Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`, `MLLP_ACK_INBOUND_UNPARSEABLE` (12 total; the last is `ack-from-hl7`-scoped — emitted in `MllpAck.warnings`, not through the framing registry).
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.
- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances — log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % per-directory on `src/framing/`, `src/client/`, `src/connection/`, `src/server/`, `src/transport/` (enforced by `pnpm test:coverage`).
- **In-memory transport is a first-class deliverable** (`@cosyte/mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.

## Standing disciplines (every change)

These three bind every change in this repo (mirrored from the cosyte meta-repo's
`documentation/conventions.md`):

1. **Documentation follows code.** A public-surface / stack / status change isn't done until its
   docs are: this package's own docs (`docs-content/` + JSDoc), and — in the meta-repo — its
   `documentation/repos/<repo>.md` and the `ecosystem-map.md` status table.
2. **Version + changelog every meaningful change.** Add a Changeset (`pnpm changeset`, `patch`
   during pre-alpha) and keep `CHANGELOG.md`'s `[Unreleased]` current. Stay on `0.0.x` until first alpha.
3. **Crew + knowledgebase feedback loop.** When a standard, decision, or public surface changes,
   flag whether a `crew` skill or `knowledgebase` doc needs creating/updating — never silently skip.

Build, lint, format, and TypeScript settings come from the shared `@cosyte/*` config packages
(`@cosyte/tsconfig` · `@cosyte/eslint-config` · `@cosyte/prettier-config`; see
`documentation/conventions.md` → "Canonical toolchain (enforced)"). Node ≥ 22.
