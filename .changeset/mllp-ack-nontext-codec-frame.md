---
"@cosyte/mllp": patch
---

`ack-from-hl7`: a non-text `encoding` override on a text inbound is now rejected at the boundary rather than emitting a garbage frame (MLLP-ACK-NONTEXT-CODEC-FRAME).

On a `string` / `Hl7Message` inbound the resolved codec is used only to serialize the built ACK back
to bytes. A **text** codec (`utf8`/`ascii`/`latin1`) writes the ACK's characters as a byte stream a
peer reads back as HL7; a **non-text** one does not: `base64`/`base64url`/`hex` reinterpret the ACK
*string* as encoded data and decode it to unrelated bytes, and `utf16le`/`ucs2` NUL-pad every byte, so
the emitted frame is wholesale garbage the receiver cannot parse.

This was never the silent-corruption class the `ascii`-override bleed was: a garbage frame yields no
readable MSA-2, so the receiver's `extractMsaControlId` returns `null` and the ACK-FAILSAFE path
downgrades to a loud `AE`. The class was already fail-safe. What was missing was ergonomics: the ACK
was handed back for the caller to write to a socket and discover broken a round trip later. `buildMllpAck`
now throws a `TypeError` at the boundary for a non-text codec on a text inbound (exactly as it already
does for an unknown `code`), naming the remedy: use a text codec, or pass the raw `Buffer`.

Scoped to the text path only. On a `Buffer` inbound a codec override remains the documented escape
hatch for a peer that demands a specific byte-level codec, and a lossy one there is already caught
loudly by the byte-level `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` check. The default `utf8`/`latin1` paths
and all-ASCII control IDs are unaffected; no warning code or other public type changes.
