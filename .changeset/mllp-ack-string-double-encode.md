---
"@cosyte/mllp": patch
---

`ack-from-hl7`: the `string`/`Hl7Message` overload no longer double-encodes a high-bit control ID silently.

`buildMllpAck` (and its `buildAckAA`/`buildAckAE`/… wrappers) re-encode a decoded-text inbound with
the JS-native `utf8` default, so a control ID like `A <0x8B> B` (legal under `MSH-18` = `8859/1`),
handed in as `payload.toString("latin1")`, went out in MSA-2 as the two bytes `0xC2 0x8B` — a
*different* control ID. The sender keyed its in-flight store on `0x8B`, so it could not match the
ACK: timeout → resend → **duplicate clinical message**. The existing `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`
guard structurally could not see it — on a text inbound it re-derives "the inbound bytes" from the
same text with the same codec, so the codec cancels on both sides and the comparison is a tautology.

The encoding cannot be fixed from decoded text (a string does not remember which codec produced it),
so this is an **API-shape** fix, not a guard fix: the text path now emits a new, distinct warning
code, **`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`**, whenever the emitted MSA-2 holds a non-ASCII byte on a
`string`/`Hl7Message` inbound. It is a *cannot-verify* signal (the echo may be broken and we cannot
prove otherwise), deliberately separate from the `Buffer`-path *proof-of-mismatch*
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` — the text path must never claim a proof it cannot run. An
all-ASCII control ID round-trips identically under every codec, so the common case stays quiet. The
warning carries byte lengths only, never field content (PHI discipline). The remedy it names is the
`Buffer`-first API rule: pass the raw payload for the real byte-level guarantee.

New public warning code `MLLP_ACK_CONTROL_ID_UNVERIFIABLE`, exported from `@cosyte/mllp/ack-from-hl7`.
