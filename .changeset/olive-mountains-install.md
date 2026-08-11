---
"@cosyte/mllp": patch
---

The `@cosyte/hl7` dev/test peer now installs from the npm registry instead of a
vendored packed tarball, and `vendor/` is deleted.

The tarball held `@cosyte/hl7` at `0.0.0` and never moved while that package
shipped ten releases. One of them made the MSA-2 control-id echo byte-verbatim
across the full escape alphabet. Because the pinned copy never picked it up,
this package's own test suite went on asserting the old behaviour as a
guarantee: an inbound `MSH-10` of `ID\X` echoed back as `ID\E\X`, which is a
different control id on the wire, so an ACK the sender cannot correlate, so a
resend, so a duplicate clinical message. That case is now pinned inverted, as a
round-trip through the parser path that must produce the same bytes as the
byte-copy path and must not warn.

No runtime behaviour of this package changes: `@cosyte/hl7` remains an optional
peer dependency referenced only from the `@cosyte/mllp/ack-from-hl7` subpath,
and the emitted framing, ACK and warning-code surfaces are untouched. What
changes is which version of the peer the tests run against, and therefore what
they can prove.
