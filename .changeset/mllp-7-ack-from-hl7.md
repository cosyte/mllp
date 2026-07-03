---
"@cosyte/mllp": patch
---

`@cosyte/mllp/ack-from-hl7` ships real helpers (stub removed): `buildMllpAck` + `buildAckAA/AE/AR/CA/CE/CR` + `detectMode` — a thin, fail-safe transport adapter over `@cosyte/hl7`'s `buildAck` (parse → build → MLLP frame, MSA-2 echoes the inbound MSH-10 whole, unparseable inbound never yields a positive ACK). New stable warning code `MLLP_ACK_INBOUND_UNPARSEABLE`; typed `MllpPeerMissingError` on a missing optional peer.
