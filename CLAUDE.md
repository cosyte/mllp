# @cosyte/mllp

An MLLP client and server for HL7 v2 in Node.js and TypeScript, published on npm as `@cosyte/mllp` under MIT: the
transport sibling of the Cosyte parsers, with zero runtime dependencies and Buffers on every public surface. Parsing
belongs to the optional peer `@cosyte/hl7`, which only the `@cosyte/mllp/ack-from-hl7` subpath uses.

## Gate

Run these from the repo root, in this order, with the pnpm that `packageManager` pins first on PATH: pnpm 12 ignores
`pnpm.overrides` and refuses the frozen install, and tests spawn a bare `pnpm`. If `pnpm --version` prints another
version, run `corepack enable --install-directory <dir> pnpm` and put `<dir>` first on PATH.

1. `pnpm install --frozen-lockfile`
2. `pnpm typecheck`
3. `pnpm lint`
4. `pnpm format:check`
5. `pnpm phi-scan`
6. `pnpm test`
7. `pnpm test:coverage`
8. `pnpm build`
9. `pnpm attw`
10. `pnpm examples` (runs against the build from step 8)
11. `pnpm check:no-emdash`, `pnpm check:no-internal-refs`

Steps 1 to 9 are the shared `ci / verify` job (Node 22 and 24), 10 the `examples` job in `.github/workflows/ci.yml`,
11 `no-emdash.yml` (which also reads the PR text and commit messages) and `no-internal-refs.yml`. CI alone adds an
ESM/CJS import smoke, actionlint (its action installs it) and the shared pre-publish manifest and pack-install checks.

## Hazard

Real patient traffic runs through this package. A framing or ACK defect drops a clinical message or makes the sender
resend it, so it arrives twice, and often nothing says so. Any byte we put in an error, warning or event can carry PHI.

## Rules that bind here

Each names the failure that proved it. `pnpm test` fails if a pointer into `documentation/agent-notes.md` breaks.

- Read MSH-10 and MSA-2 only through `src/internal/control-id.ts`: three call sites each re-derived it and got it wrong, one masking the high bit and one returning PID-3 (the MRN) as the control ID (#12, #13).
  `documentation/agent-notes.md#the-msh-is-read-once-mllp-ack-utf8`
- Never answer `AA` for a message we could not correlate, and keep an `FHS`/`BHS` batch on the warned `AE` fallback: `buildRawAck` and the default auto-ACK said `AA` to both, so the sender resends (#13, #14).
  `documentation/agent-notes.md#tolerate-terminator-noise-never-skip-data-mllp-ack-utf8`
- On a `string` or `Hl7Message` inbound, warn `MLLP_ACK_CONTROL_ID_UNVERIFIABLE`; never claim `NOT_VERBATIM`'s byte proof there: that check was a tautology on text and let a double-encoded control ID through (#19).
  `documentation/agent-notes.md#stable-warning-codes-not_verbatim-and-unverifiable`
- Put no field content in a warning, an error message or an error's fields, only codes and numbers, and give `src/client/ack-diagnostics.ts` no value parameter: a 1,000,000-byte MSA-2 came back in a 1,000,026-byte `Error.message` (#44).
  `documentation/agent-notes.md#a-warning-message-is-a-log-line-phi-warning-message-leak`
- Put every `this.emit(` in `src/` inside a containment wrapper (`src/internal/safe-emit.ts`): a throwing subscriber crashed the process, suppressed the negative ACK and hung `send()` (#8, #11).
  `documentation/agent-notes.md#no-uncontained-emit-mllp-10`
- Classify a new `connectionCause` or `MLLP_*` code as permanent or transient on purpose: the classifier's transient `default:` turned an HTTP probe into an unbounded reconnect storm (#11).
  `documentation/agent-notes.md#mllpconnectionerrorconnectioncause`
- Never soften a `pnpm phi-scan` refusal or narrow what it reads: #50, #53, #56 and #63 each closed a route that printed `OK, no hits` at exit 0 over bytes it never read.
  `documentation/agent-notes.md#phi-scan-walk-root-scope-and-phi-scan-observed-nothing-is-global`
- Keep `pnpm attw` on `scripts/attw.mjs`: `@arethetypeswrong/cli` alone exits 0 on a tarball with no type declarations (#48).
  `documentation/agent-notes.md#the-attw-wrapper-and-why-the-bare-cli-is-not-a-gate`
- Install `@cosyte/hl7` from npm and never vendor a tarball of it: a vendored `0.0.0` kept the tests asserting an MSA-2 echo bug that `@cosyte/hl7` had since fixed (#64).
  `documentation/agent-notes.md#shipped-phases-and-the-vendored-hl7-peer-tarball`
- Never hand-edit `CHANGELOG.md`; a release writes it from the changeset summaries. With the generator off it shipped with no version headings at all (#57).
  `documentation/agent-notes.md#changelog-generation`
- Pick a changeset's bump (`pnpm changeset`) from `.changeset/README.md`: `minor` for anything a consumer gains. A standing `patch` rule queued ten patches over 45 new exports (#76).
  `documentation/agent-notes.md#the-version-ladder-and-the-pre-alpha-instruction-it-replaced`
