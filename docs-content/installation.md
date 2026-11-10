---
id: installation
title: Installation
sidebar_label: Installation
description: "Install @cosyte/mllp and the optional @cosyte/hl7 peer, check the Node.js version, and confirm the install with a smoke test."
---

# Installation

> **Status:** published on npm and public, so the `npm install @cosyte/mllp` command below is live.
> Where the package sits on the release ladder, and what that means for the stability of its public
> surface, is stated in one place: [API stability](./limitations.md#api-stability). Read it before
> you pin.

## Prerequisites

- **Node.js 22 or later.** CI runs every pull request on Node.js 22, 24 and 26. The public surface
  uses `Symbol.asyncDispose` and `AbortSignal`, both available on every supported line.
- A package manager: `npm`, `pnpm` or `yarn`.

## Install

```bash
npm install @cosyte/mllp
```

The package has no runtime dependencies. The client, the server and the framing codec use Node.js
built-ins only (`net`, `tls`, `events` and `crypto`).

### The optional `@cosyte/hl7` peer

`@cosyte/hl7` is an optional peer dependency, needed only for the `@cosyte/mllp/ack-from-hl7`
subpath, which builds acknowledgments by parsing the inbound message with it. Everything else
(framing, the client, the server, TLS and the in-memory transport) works without it.

```bash
npm install @cosyte/hl7
```

Calling into `ack-from-hl7` without the peer installed throws a typed `MllpPeerMissingError`, not a
bare module-not-found error. The peer is loaded on first use, so importing the subpath alone does
not need it.

## Smoke test

Confirm the package resolves and its version marker is present:

```ts runnable
import { VERSION } from "@cosyte/mllp";

typeof VERSION; // => "string"
```

If that runs, the install is good. Continue with the [Quickstart](./quickstart.md).

## Module systems

`@cosyte/mllp` is an ES module package that also ships a CommonJS build, and each condition carries
its own type declarations (`.d.ts` for `import`, `.d.cts` for `require`), on all three entry points:
the root, `/testing` and `/ack-from-hl7`.

```ts runnable
// ES modules and TypeScript
import { MllpClient, MllpServer } from "@cosyte/mllp";

typeof MllpClient; // => "function"
typeof MllpServer; // => "function"
```

```js no-run CommonJS needs require, and the sample runner loads every sample as an ES module
// CommonJS
const { MllpClient, MllpServer } = require("@cosyte/mllp");
```

Every release is checked with `attw` (Are the Types Wrong) across the three entry points, so the
types an editor shows match the build that loads.
