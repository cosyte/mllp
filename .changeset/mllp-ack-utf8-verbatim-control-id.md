---
"@cosyte/mllp": patch
---

ACKs now echo the inbound MSH-10 into MSA-2 **byte-verbatim** (HL7 v2.5.1 §2.9.2.2) (MLLP-ACK-UTF8).
`buildRawAck` (the root export, and the server's `autoAck` path) holds this for **any** delimiter set;
`buildMllpAck` (the `ack-from-hl7` subpath) holds it for a plain control ID under the HL7 default
delimiters and **warns** (`MLLP_ACK_CONTROL_ID_NOT_VERBATIM`) in the cases it cannot represent — a
lossy `encoding`, non-default delimiters, an escape sequence, padding, or a trailing empty component.

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

Most seriously, the MSH-10 scan never stopped at the segment terminator, so on a **truncated MSH**
it counted separators on past the `CR` and returned the *next segment's* field. Against
`MSH|^~\&|EPIC|HOSP|MIRTH|LAB` + `PID|1||MRN00042|…` it returned **`PID-3` — the patient's MRN** —
as the control ID, which the client then used as its correlation key and reported in
`MllpTimeoutError.messageControlId` and its unmatched-ACK warnings. A patient identifier in a log
line, and a mis-read one. The scan is now bounded at the segment terminator: a field that does not
exist reads as absent, never as the next segment's contents.

The three places that each re-derived "read the MSH" — and each got it wrong differently — now
genuinely share one implementation, and they agree at the **tolerant** fixed point: `readMshSegment`
**locates** the MSH (the first `CR`/`LF`-delimited segment starting with `MSH`) rather than demanding
it at byte 0, so a leading `CR` cannot hide a control ID that is plainly present. `buildMllpAck`
strips leading segment terminators only — an `FHS`/`BHS` batch envelope is still refused with a
warned, non-positive `AE`, since acknowledging a batch's first message positively would tell the
sender the whole batch was accepted while messages 2..N went unread. Adds the stable warning code
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM`: `buildMllpAck` verifies its own output against the scanners the
client correlates with, so a non-matchable ACK is loud rather than silent. The warning reports byte
lengths and withholds the field values — MSH-10 is inbound payload content, and a warning goes to a
log.

The `buildMllpAck` verbatim guarantee (and the warning when it breaks) is a **`Buffer`** guarantee: on
a `string` / `Hl7Message` inbound the wire bytes are decoded before `buildMllpAck` sees them, so a
codec-induced mismatch is structurally invisible to the check. Documented, scoped, and tested — pass a
`Buffer`.

`buildRawAck` reads MSH-2 (the encoding characters) from the inbound and echoes them into the ACK. When
the inbound declares no usable MSH-2, the HL7 default `^~\&` is used — but if the inbound's field
separator is one of `^ ~ \ &`, that default *contains* the separator, which would corrupt the ACK
header (§2.16 — the delimiters must be distinct). `buildRawAck` substitutes only the one colliding
encoding character and **keeps the inbound's field separator unchanged**, because the field separator
is the only byte that can truncate MSA-2: switching it to `|` would silently truncate an MSH-10 like
`ID|X` down to `ID`, which — being plausible — could falsely settle a *different* in-flight send.
