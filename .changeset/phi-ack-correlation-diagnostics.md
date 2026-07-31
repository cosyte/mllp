---
"@cosyte/mllp": patch
---

**ACK-correlation diagnostics now report byte lengths instead of the control ID itself.** The opt-in `correlateByControlId` path built its diagnostics by interpolating a control ID that arrives on the wire, with no bound: an unmatched ACK put the peer's MSA-2 straight onto `MllpFramingError.message` and onto a `controlId` field of the `'error'` payload, so a peer sending a 1,000,000-byte MSA-2 produced a 1,000,026-byte `Error.message` headed for a log. The late-ACK warning and `MllpTimeoutError` did the same with the timed-out send's own MSH-10. A control ID is payload content, and an `Error` is logged and its `stack` shipped off the box.

Both messages now come from a frozen registry whose lookup takes no value parameter, so no caller can widen it into an interpolation site, and the correlator withholds the string at the source rather than trusting its consumers.

Breaking, and pre-alpha: `MllpTimeoutError.messageControlId` is now `messageControlIdBytes: number | undefined`; the `'error'` event's `controlId` is now `controlIdBytes`; the correlation `'warning'` payload is the new exported `AckCorrelationWarning`, a `MllpWarning` plus `controlIdBytes` and `elapsedSinceSendMs`. Warning codes are unchanged. You lose nothing you did not already hold: the outbound bytes are the payload you passed to `send()`, and the inbound ACK frame reaches you on the `'message'` event.
