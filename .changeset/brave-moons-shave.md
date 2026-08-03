---
"@cosyte/mllp": patch
---

Make the `attw` publish gate report its own failure instead of passing on a typeless tarball
(`ATTW-FALSE-GREEN-PORT`, porting the remedy shipped in `terminology#28`, `bf153cb`).

`pnpm attw` was `attw --pack . --profile node16`, and `@arethetypeswrong/cli@0.18.4`'s
`getExitCode.js` opens with `if (!analysis.types) return 0`, returning before the problem list is
read. No `--profile`, `--ignore-rules` or config setting reaches that early return. For a package
that ships types, "does not contain types" means the declarations never made it into the tarball, so
a broken publish was being reported as a pass. A false red costs an hour; a false green merges.

Measured on this package at `0.0.6` with zero concurrency, under the old invocation: `rm -rf dist &&
pnpm attw` printed "This package does not contain types." and exited 0. Concurrency supplies only the
condition, so the remedy is not a lock, a lease or a build queue.

The exit-0 path needs the tarball to carry no declaration at all. `tsup` emits a shared type chunk
beside the three entry declarations, so deleting only the six entry files leaves that chunk shipping
and `attw` reds honestly at UntypedResolution; the same removal plus the chunk is what exits 0. The
build window lands in the exit-0 state regardless, because `tsup` writes JS in one pass and every
declaration in a later one: polling two real clean builds here for the JS and then the first
declaration of any kind gave windows of 4.25s and 3.31s, holding JS and zero declarations
throughout. The absolute timings move run to run, so the claim is that the gap is seconds rather
than milliseconds, not any single figure.

`pnpm attw` is now `node scripts/attw.mjs --profile node16`; the wrapper hardcodes `--pack .` and
forwards the rest, so the deliberate `--profile node16` is preserved. It runs a preflight that every
relative path `package.json` promises exists and is non-empty (twelve paths, across the three
subpaths), and a post-check that promotes the untyped sentence to a failure. Options that would hide
that sentence are refused by name and wholesale. Build and packaging only: no runtime, framing,
transport, or public-API change.
