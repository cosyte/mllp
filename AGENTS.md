# AGENTS.md

`@cosyte/mllp` is our MLLP client and server for HL7 v2 in Node.js and TypeScript, published on npm
under MIT with zero runtime dependencies. Parsing belongs to the optional peer `@cosyte/hl7`, which
only the `@cosyte/mllp/ack-from-hl7` subpath uses.

## Build and test

Use Node.js 22 or later and the pnpm that `packageManager` in `package.json` pins.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## The gate

Run all of these from the repository root, in this order, before you push. CI runs the same checks.

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm phi-scan
pnpm test
pnpm test:coverage
pnpm build
pnpm attw
pnpm examples
pnpm check:no-emdash
pnpm check:no-internal-refs
pnpm check:documents
```

## Rules

- Synthetic data only. Real patient data never enters this repository: not in a fixture, a test, a
  log, an issue, or a commit. `pnpm phi-scan` runs on every commit.
- A change a consumer can see carries a changeset (`pnpm changeset`); `.changeset/README.md` says
  which bump to pick.
- No em or en dashes anywhere, commit messages included.

`CLAUDE.md` holds the rules that bind changes here and the failure behind each. Contributions follow
the organization's [contributing guide](https://github.com/cosyte/.github/blob/main/CONTRIBUTING.md).
