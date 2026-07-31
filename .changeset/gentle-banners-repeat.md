---
"@cosyte/mllp": patch
---

Correct four README claims and two published JSDoc examples that did not match the code.

- The "Fail-safe ACKs" section said a resolved handler yields `AA`, full stop. It does not. A commit that succeeds is still answered `AE` when the inbound could not carry a correlatable positive ACK: no readable `MSH`, an empty `MSH-10`, a batch or concatenated payload, or trailing bytes the framer discarded. That matters to a reader because an `AE` is a resend, so a sender can be told to resend a message the receiver has already durably committed. The section now states the downgrade and the `nack` event that reports it.
- The Quickstart server example claimed `onMessage` echoed the received frame straight back as the ACK. It does not. `createStarterServer` defaults to `autoAck: 'AA'`, so with a handler present the server awaits that handler as the durable-commit step and then sends a generated ACK correlated to the inbound message; the handler's return value is discarded. The example now shows the commit-gated shape the server actually runs, matching the "Fail-safe ACKs" section further down the page.
- The same wrong shape shipped in two published JSDoc examples, which compile into the type declarations of all three entry points and so are what an editor renders on hover: `StarterServerOptions`, and `createStarterServer` itself, which is the copy a consumer actually hovers. Each also called a helper the package does not export, `buildAckBuffer` and `buildAck` respectively.
- The two TLS snippets each declared `const server` and `const client` twice inside a single code block, so neither block compiled if copied.

Note on the wording of this entry, recorded rather than changed silently (ASSETS-P8). Its opening
sentence originally also announced adding a per-package banner image to the README, and that clause
has been removed. The banner was replaced by the shared Cosyte lockup before any of it reached npm,
so it was never a fact about a version anyone can install, and the two entries standing together
would have told a reader of the release notes that a header image was added and then replaced inside
one release. The clause was removed while this changeset was still pending, which is the only window
in which rewriting is the right fix: once published, an entry is annotated and never rewritten.

Worth keeping alongside it, because the reason was stated and is now superseded. The banner
deliberately used a plain markdown image rather than a `<picture>` element, on the grounds that it
was not then known whether `<picture>` survived npm's README sanitizer. It does, and that is now
verified on a sibling package rather than assumed: in dark mode `currentSrc` resolves to the on-dark
tile with parent element `PICTURE`, and on npm the `<img>` is hoisted out of the `<picture>` so the
light cut renders, which is correct there because npmjs.com has no dark mode. The header change is
carried by the lockup entry in this same release.
