---
"@cosyte/mllp": patch
---

Correct the `docs-content/installation.md` publish-status note (README-ORG-SWEEP).

`@cosyte/mllp` is published on npm at `0.0.1` and public, so the page's "not yet published to npm …
the command below is the shape it will take at first publish" Status callout was stale and made the
live `npm install @cosyte/mllp` command read as aspirational. Rewritten to state the package is
published at `0.0.1` and public, still pre-alpha on the cosyte `0.0.x`-until-first-alpha ladder (no
API-stability promise), and that the install command is live. Docs only: no runtime or public-API
change.
