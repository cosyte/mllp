---
"@cosyte/mllp": patch
---

ACKs now echo the inbound MSH-10 into MSA-2 **byte-verbatim** (HL7 v2.5.1 §2.9.2.2), on both ACK
builders and for any delimiter set (MLLP-ACK-UTF8).

`ack-from-hl7`'s `buildMllpAck` decoded the inbound through the peer parser's charset machinery but
re-encoded the ACK through a hardcoded `utf8`. The two are not inverses: a control-ID byte `0x8B`
(legal under an `MSH-18` of `8859/1`) came back out of MSA-2 as the two bytes `0xC2 0x8B` — a
*different* control ID. A `@cosyte/mllp` client keys its in-flight store on the bytes it sent, so it
could not match that ACK: the send never settled → ACK timeout → resend → **duplicate clinical
message**. `Buffer` input is now decoded as `latin1` and re-encoded with the same codec — the only
codec whose byte round-trip is the exact identity. `string`/`Hl7Message` input keeps its `utf8`
default.

`buildRawAck` assumed `|` was the field separator instead of reading MSH-1 (§2.5.4), so a
`!`-delimited message produced an ACK with **no correlation id at all**. It now reads MSH-1, echoes
the inbound's own MSH-1/MSH-2, and tolerates `LF`/`CRLF` segment terminators.

The three places that each re-derived "read the control ID" — and each got it wrong differently —
are now one shared implementation. Adds the stable warning code
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM`: `buildMllpAck` verifies its own output against the scanners the
client correlates with, so a non-matchable ACK is loud rather than silent.
