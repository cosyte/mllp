---
"@cosyte/mllp": patch
---

`ack-from-hl7`: a non-text `encoding` override is now rejected on a **`Buffer`** inbound too, not just on the text path (MLLP-ACK-NONTEXT-CODEC-BUFFER). This also fixes a flaky `verify` failure.

MLLP-ACK-NONTEXT-CODEC-FRAME rejected a non-text codec (`base64`/`base64url`/`hex`/`utf16le`/`ucs2`)
only on a `string`/`Hl7Message` inbound, sparing the `Buffer` path on the belief that a lossy `Buffer`
override was already caught loudly by the byte-level `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` check. That
premise holds for a lossy **charset** codec (`ascii` masking a high bit) but not for a genuinely
non-text one:

- A non-text codec garbles the **inbound** decode: `buf.toString("base64" | "hex" | "utf16le" |
  "ucs2")` never yields a string that begins with `MSH`, so it **always** routes to the unparseable
  fallback, whose MSA-2 is intentionally empty. `verifyVerbatimEcho` short-circuits on a `null`
  inbound control ID, so the `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` proof never runs — the supposed
  safety net is unreachable.
- The fallback ACK is then serialized with that same non-text codec: `Buffer.from(ackText, "base64")`
  decodes the ACK text to random bytes that, roughly 3–4 % of the time, contain a `VT`/`FS` delimiter
  byte and make the strict `encodeFrame` throw a nondeterministic `MllpFramingError`.

So the `Buffer`-plus-non-text-codec path was neither the "loud AE" it was documented to be nor caught
by any falsifiable check — it was an unreadable frame that sometimes crashed. This surfaced as a flaky
CI failure: the `verify` test `"a Buffer inbound with a non-text codec is NOT rejected"` asserted a
reliable `AE`, but the underlying draw of the fallback's generated MSH-10 tripped `encodeFrame` ~3–4 %
of the time on **both** Node 22 and Node 24 (the behavior is byte-identical across the two versions —
it was never a runtime divergence, only a coin-flip that happened to land differently on the two
matrix legs of one run).

`buildMllpAck` now throws a `TypeError` at the boundary for a non-text codec on **any** input shape,
deterministically. The legitimate byte-level escape hatch is preserved untouched: every codec that can
actually serialize an HL7 ACK — `latin1` (the byte-verbatim default for a `Buffer`), `ascii`, `utf8`,
`binary` — is still accepted, and a lossy charset override on a `Buffer` is still caught loudly by
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. No warning code or other public type changes.
