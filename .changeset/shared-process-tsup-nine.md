---
"@cosyte/mllp": patch
---

The package is now built by tsup 9, through our shared `@cosyte/process` tooling. The API and the
runtime JavaScript are unchanged; the published files differ only in how they are laid out. The
declaration files list type-only exports in a separate `export type { ... }` statement, the
`@cosyte/mllp/testing` declarations import `Transport` through the root entry point rather than an
internal chunk, and the CommonJS build's source maps and one shim comment name the new tsup path.
