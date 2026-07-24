---
id: installation
title: Installation
sidebar_position: 1
---

# Installation

`@cosyte/mllp` is a **zero-dependency** TypeScript MLLP client + server for Node.js. It ships dual
**ESM + CJS** builds with per-condition type declarations, so it works from either module system
without configuration. It is **transport, not parsing**. It moves HL7 v2 bytes over TCP and never
inspects the payload.

> **Status:** published on npm at `0.0.1` and public, still pre-alpha on the cosyte
> `0.0.x`-until-first-alpha ladder, so the API can change with no deprecation cycle. The
> `npm install @cosyte/mllp` command below is live, not aspirational.

## Prerequisites

- **Node.js >= 22.** The whole `@cosyte/*` suite targets ES2023 / Node 22+. This package leans on
  `Symbol.asyncDispose` and `AbortSignal` on its public surface, both 2026 Node baseline.
- A package manager: `pnpm`, `npm`, or `yarn`.
- **No runtime dependencies.** The client, server, and framing are Node stdlib only (`net`, `tls`,
  `stream`, `events`, `buffer`, `timers`).

## Install

```bash
npm install @cosyte/mllp
```

### The optional `@cosyte/hl7` peer

`@cosyte/hl7` is an **optional** peer dependency, needed **only** if you use the
[`ack-from-hl7`](./acks.md) subpath (which builds spec-correct ACKs by delegating the parsing to
`@cosyte/hl7`). Everything else (framing, the client, the server, TLS, the in-memory transport)
works without it. Install it only if you reach for that subpath:

```bash
npm install @cosyte/hl7
```

Calling `ack-from-hl7` without the peer installed throws a typed `MllpPeerMissingError`, not a bare
module-not-found.

## Smoke test

Confirm the package resolves and its version symbol is present:

```ts runnable
import { VERSION } from "@cosyte/mllp";

typeof VERSION; // => "string"
```

If that resolves, the install is good. Head to the [Quickstart](./quickstart).

## Module systems

`@cosyte/mllp` is `"type": "module"` and exposes both conditions, so both of these resolve to the
right build without extra configuration:

```ts
// ESM / TypeScript
import { MllpClient, MllpServer } from "@cosyte/mllp";
```

```js
// CommonJS
const { MllpClient, MllpServer } = require("@cosyte/mllp");
```

The types are published per-condition (`.d.ts` for `import`, `.d.cts` for `require`) and gated by
`attw` on every release, across all three subpaths (root, `/testing`, `/ack-from-hl7`), so editor
IntelliSense matches the build you actually load.
