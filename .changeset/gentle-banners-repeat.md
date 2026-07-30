---
"@cosyte/mllp": patch
---

Add the cosyte package banner to the README, and correct four README claims and three published JSDoc examples that did not match the code (ASSETS-P8).

- The "Fail-safe ACKs" section said a resolved handler yields `AA`, full stop. It does not. A commit that succeeds is still answered `AE` when the inbound could not carry a correlatable positive ACK: no readable `MSH`, an empty `MSH-10`, a batch or concatenated payload, or trailing bytes the framer discarded. That matters to a reader because an `AE` is a resend, so a sender can be told to resend a message the receiver has already durably committed. The section now states the downgrade and the `nack` event that reports it.
- The Quickstart server example claimed `onMessage` echoed the received frame straight back as the ACK. It does not. `createStarterServer` defaults to `autoAck: 'AA'`, so with a handler present the server awaits that handler as the durable-commit step and then sends a generated ACK correlated to the inbound message; the handler's return value is discarded. The example now shows the commit-gated shape the server actually runs, matching the "Fail-safe ACKs" section further down the page.
- The same wrong shape shipped in three published JSDoc examples, which compile into the type declarations of all three entry points and so are what an editor renders on hover. Each also called a helper that the package does not export: `buildAckBuffer` on `StarterServerOptions`, and `buildAck` on both `createStarterServer` itself (the copy a consumer actually hovers) and `ServerOptions`. The last of those is a legitimate manual-mode shape and now calls the exported `buildRawAck`.
- The two TLS snippets each declared `const server` and `const client` twice inside a single code block, so neither block compiled if copied.
