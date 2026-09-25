---
"@cosyte/mllp": patch
---

The Quickstart page now opens with the same program as the README: a server and a client on loopback, one message sent and its acknowledgement read.

Before this, the page opened with framing bytes by hand while the README opened with a server and a client, so a reader arriving from npm and one arriving from the documentation site met two different first programs. The framing, tolerance and encoder examples follow it unchanged. The test suite now fails if the page's first program or the output printed beside it differs from the README's, runs it against the built package, and compares what it prints with that output. Documentation and test change only.
