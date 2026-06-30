---
"@cosyte/mllp": patch
---

Phase 6 — fail-safe ACK semantics & the commit contract (HL7 v2.5.1 §2.9.2). A positive
acknowledgement (`AA`) can now never precede a successful durable commit: with `autoAck: 'AA'` and an
`onMessage` handler, the server **awaits the handler** (the commit step) and only then ACKs — `AA` on
resolve, a **negative** code on throw/reject (`AE` by default; `AR` via the new `MllpAckError`), never
`AA` before commit. `autoAck: 'AA'` without a handler is documented as a **transport-accept**
(received+framed, not application-processed). New public surface: `buildRawAck` (parser-free byte-level
ACK builder echoing inbound `MSH-10` into `MSA-2`), the HL7 Table 0008 `AckCode` / `NegativeAckCode`
unions, `MllpAckError`, `resolveNackCode`, and a PHI-safe `'nack'` event (`{ connectionId, ackCode }`)
plus its `NackEvent` type. Handler failures in custom-ACK and manual modes are now caught and surfaced
as a connection `'error'` rather than escaping as an unhandled rejection. No payload content or thrown
error text ever reaches the wire, logs, or events — only routing/control metadata and the static
ack code.
