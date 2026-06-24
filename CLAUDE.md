# @cosyte/hl7-mllp — Project Guide for Claude

## Project

**`@cosyte/hl7-mllp`** — a developer-focused MLLP (Minimal Lower Layer Protocol) client + server for Node.js/TypeScript, published under the Cosyte brand. Open-source (MIT). Transport-only sibling to `@cosyte/hl7` (the parser).

**North star:** A developer can send and receive HL7 v2 messages over a production-grade MLLP connection with three lines of code, and trust framing, ACKs, reconnects, and backpressure under load and on flaky networks — without reading the MLLP spec.

## Status

- **Phase 5 of 8** — Phase 5 executed (521/521 tests passing); awaiting verification.
- Sibling package: `@cosyte/hl7` at `../hl7-parser` (peer dep, not runtime dep)

## Tech Stack (locked)

- **Language:** TypeScript (strict, `noUncheckedIndexedAccess`)
- **Target:** ES2022, dual ESM + CJS via `tsup`
- **Node:** **22+** (`engines.node >=22.0.0`; Node 18 EOL 2025-04-30)
- **Package manager:** pnpm
- **Testing:** Vitest + `@vitest/coverage-v8` with per-directory 90% gates on `src/framing|server|client`
- **Linting:** ESLint + Prettier
- **Runtime deps:** **Zero.** Node stdlib only (`net`, `tls`, `stream`, `events`, `buffer`, `timers`).
- **Peer deps:** `@cosyte/hl7` as an **optional** peer dep, referenced only from the `@cosyte/hl7-mllp/ack-from-hl7` subpath (tsup `external`).
- **TLS test certs:** generated at `pretest` via `selfsigned` into gitignored `examples/tls/certs/`; never committed.
- **Benchmarking (local only):** `mitata`; not a CI gate.
- **CI matrix:** Ubuntu / macOS / Windows × Node 20 / 22 / 24 for the test job; Ubuntu-only for lint / typecheck / coverage. `@arethetypeswrong/cli` is a publish-gate.
- **License:** MIT

## Engineering Guardrails

- No `any`. No unjustified `as` casts. Use `unknown` and narrow.
- JSDoc (with `@example`) on every public export — feeds IntelliSense.
- **Buffer-first API** on every public surface — never string. HL7 v2 payloads are raw bytes with caller-managed charset decoding.
- **`Buffer.prototype.slice()` is forbidden** in `src/framing|server|client` (enforced by the SETUP-07 ESLint rule). Use `.subarray()` — `.slice()` copies in modern Node.
- **Postel's Law:** decoder is liberal (tolerance opt-ins + warnings with stable codes + byte offsets), encoder is strict (always emits canonical `VT + payload + FS + CR`).
- **Stable warning codes** are a public API. Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`, `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT` (11 total).
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.
- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances — log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % on `src/framing/`, `src/server/`, `src/client/`.
- **In-memory transport is a first-class deliverable** (`@cosyte/hl7-mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.

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
