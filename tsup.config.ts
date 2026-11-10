import { cosyteTsup } from "@cosyte/tsup-config";

/**
 * tsup build for @cosyte/mllp, dual ESM + CJS + `.d.ts` from the shared @cosyte/tsup-config standard
 * (ES2023, Node platform, `.mjs`/`.cjs` out-extensions). Matches the `exports` map in package.json.
 *
 * Four entries (the package's four public subpaths): the root, the `/testing` in-memory transport,
 * the `/ack-from-hl7` helpers and the `/arbitraries` fast-check generators. `@cosyte/hl7` is the
 * optional peer dep behind `/ack-from-hl7` and `fast-check` the one behind `/arbitraries`; neither
 * is ever bundled, and nothing the root entry reaches imports either. `/arbitraries` imports only
 * types from the library, so it carries no copy of a class a consumer could compare against. `shims: true` polyfills `import.meta.url` in the CJS build, `ack-from-hl7`'s
 * lazy peer loader (`src/ack-from-hl7/peer.ts`) needs it for `createRequire(import.meta.url)`.
 */
export default cosyteTsup({
  entry: {
    index: "src/index.ts",
    "testing/index": "src/testing/index.ts",
    "ack-from-hl7/index": "src/ack-from-hl7/index.ts",
    "arbitraries/index": "src/arbitraries/index.ts",
  },
  external: ["@cosyte/hl7", "fast-check"],
  shims: true,
});
