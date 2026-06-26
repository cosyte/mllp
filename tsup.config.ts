import { cosyteTsup } from "@cosyte/tsup-config";

/**
 * tsup build for @cosyte/mllp — dual ESM + CJS + `.d.ts` from the shared @cosyte/tsup-config standard
 * (ES2023, Node platform, `.mjs`/`.cjs` out-extensions). Matches the `exports` map in package.json.
 *
 * Three entries (the package's three public subpaths): the root, the `/testing` in-memory transport,
 * and the `/ack-from-hl7` helpers. `@cosyte/hl7` is the optional peer dep behind `/ack-from-hl7` and
 * is never bundled.
 */
export default cosyteTsup({
  entry: {
    index: "src/index.ts",
    "testing/index": "src/testing/index.ts",
    "ack-from-hl7/index": "src/ack-from-hl7/index.ts",
  },
  external: ["@cosyte/hl7"],
});
