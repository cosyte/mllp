---
"@cosyte/mllp": patch
---

`ack-from-hl7`: a lossy `{ encoding: "ascii" }` override on a text inbound can no longer corrupt a control ID silently (MLLP-ACK-ASCII-OVERRIDE-BLEED).

The residual path the `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` fix did not close. That signal originally
flagged a `string`/`Hl7Message` inbound by inspecting the **emitted** MSA-2 bytes for a non-ASCII
value: a proxy with a blind spot on a lossy `encoding` override. Node's `ascii` codec truncates a
code unit to its low 8 bits, so a control-ID code unit above `0xFF`, e.g. `U+0153` (`œ`, what a
windows-1252 decode yields for a `0x9C` wire byte), is masked *into* the ASCII byte range (`0x53`,
`'S'`). The emitted MSA-2 is then all-ASCII, so the proxy stayed silent while a positive `AA` went out
echoing a **different** control ID the sender cannot correlate: ACK timeout → resend → **duplicate
clinical message**.

The check now reads the MSA-2's **pre-encoding code units** rather than the emitted bytes, so a
non-ASCII code unit is flagged whatever the codec did to the byte. This is a strict superset of the
old emitted-byte test (encoding ASCII code units can never produce a non-ASCII byte) so the default
`utf8` text path is unchanged, all-ASCII control IDs stay quiet, and no public surface changes. The
warning still carries lengths only, never field content (PHI discipline), and names the same remedy:
pass the raw `Buffer`.
