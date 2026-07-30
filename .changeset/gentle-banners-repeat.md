---
"@cosyte/mllp": patch
---

Add the cosyte package banner to the README, and correct three examples on the package page that did not match the code (ASSETS-P8).

- The Quickstart server example claimed `onMessage` echoed the received frame straight back as the ACK. It does not. `createStarterServer` defaults to `autoAck: 'AA'`, so with a handler present the server awaits that handler as the durable-commit step and then sends a generated ACK correlated to the inbound message; the handler's return value is discarded. The example now shows the commit-gated shape the server actually runs, matching the "Fail-safe ACKs" section further down the page.
- The same wrong shape shipped in the published `StarterServerOptions` JSDoc, which reaches every consumer's editor through the generated declarations, and it called a `buildAckBuffer` helper that does not exist anywhere in the package.
- The two TLS snippets each declared `const server` and `const client` twice inside a single code block, so neither block compiled if copied.
