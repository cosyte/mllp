---
"@cosyte/mllp": patch
---

Bring `docs-content/` to the full canonical Diátaxis spine (DOCS-CONTENT-P2).

The flat sidebar (`intro`, `framing`, `acks`, `reliability`, `tls`, `limitations`) is re-categorized
into the canonical spine every `@cosyte/*` package shares: Overview → Installation → Quickstart →
Core Concepts (`framing`, `acks`) → Guides (`reliability`, `tls`) → API Reference (resolver-injected)
→ Troubleshooting (`limitations`). Two new tutorials are added (**Installation** and **Quickstart**)
and every example honors the "transport, not parsing" boundary. Runnable snippets are gated by the
shared doc/code-agreement harness (`docSnippetSuite`), so a documented example can never drift from
the shipped surface; two `intro.md` snippets that referenced non-existent API are corrected. Bumps
the `@cosyte/vitest-config` devDependency to `^0.0.2` for its `/snippets` export. Docs and tests
only: no runtime or public-API change.
