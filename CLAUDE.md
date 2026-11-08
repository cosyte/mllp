# @cosyte/mllp

Our MLLP client and server for HL7 v2 in Node.js and TypeScript, on npm under MIT, with zero
runtime dependencies. Parsing is the optional peer `@cosyte/hl7`'s, used only by `ack-from-hl7`.

@AGENTS.md

## Gate

Required: `ci / verify` on Node 22 and 24, `ci / actionlint`, `no-emdash / tracked-files` and
`no-internal-refs / public-surface`. From the repo root, in order, with the `packageManager` pnpm
first on PATH: pnpm 12 refuses the frozen install, and tests spawn a bare `pnpm`.

```sh
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm format:check && pnpm phi-scan
pnpm test && pnpm test:coverage && pnpm build && pnpm attw && pnpm examples
pnpm check:no-emdash && pnpm check:no-internal-refs && pnpm check:documents
```

Lines 2 and 3 are the shared `ci / verify` job (Node 22, 24 and 26) and the `examples` job; line 4
is `no-emdash.yml` (it also reads the PR text), `no-internal-refs.yml` and the `documents` job.

## Hazard

Real patient traffic runs through this package. A framing or ACK defect drops a clinical message or
makes the sender resend it, so it arrives twice, and often nothing says so. Any byte we put in an
error, warning or event can carry PHI.

## Rules

- Read MSH-10 and MSA-2 only through `src/internal/control-id.ts`: a copy returned PID-3 (#12, #13).
- Never answer `AA` for a message we could not correlate, and keep an `FHS`/`BHS` batch on the
  warned `AE`: an `AA` there made the sender resend (#13, #14).
- On a string or `Hl7Message` inbound, warn `MLLP_ACK_CONTROL_ID_UNVERIFIABLE`, not `NOT_VERBATIM`:
  the wire bytes were decoded before we saw them, so a byte comparison there proves nothing (#19).
- No field content in a warning, an error message or an error's fields, and no value parameter in
  `src/client/ack-diagnostics.ts`: a 1,000,000-byte MSA-2 came back in `Error.message` (#44).
- Every `this.emit(` in `src/` goes through `src/internal/safe-emit.ts`: a throwing subscriber
  crashed the process, suppressed the negative ACK and hung `send()` (#8, #11).
- Classify a new `connectionCause` or `MLLP_*` code as permanent or transient on purpose: the
  transient `default:` turned an HTTP probe into a reconnect storm (#11).
- Never soften a `pnpm phi-scan` refusal or narrow what it reads: four routes printed `OK, no hits`
  over bytes never read (#50, #53, #56, #63).
- `pnpm attw` is the gate; the bare `attw` CLI exits 0 on a tarball with no types (#48).
- Install `@cosyte/hl7` from npm: a vendored `0.0.0` kept tests asserting a fixed MSA-2 bug (#64).
- Never hand-edit `CHANGELOG.md`; a release writes it from the changesets. With the generator off it
  shipped with no version headings (#57).
- Every changeset is a patch until the operator okays a minor (D56, 2026-11-07); say what a
  consumer gains in the summary, as ten patches once hid 45 new exports (#76).
