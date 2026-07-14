---
"@cosyte/mllp": patch
---

The client's ACK correlator now extracts MSH-10 / MSA-2 as `latin1`, not `ascii` (MLLP-CORRELATOR-ASCII).

`extractMshControlId` / `extractMsaControlId` in `src/client/correlator.ts` decoded the control-ID field bytes with Node's `ascii` codec, which masks the high bit (`byte & 0x7f`). That is the same class of bug MLLP-10 fixed in `buildRawAck` on the server side, left behind on the client side since Phase 5 — so the two control-ID code paths (the server echoing MSH-10 into MSA-2, and the client reading it back out) did not agree on what a control ID *is*.

The extracted string is the correlator's **key** — for the live store, the graveyard, and the ACK lookup — so a lossy decode is a lossy key. Under `ascii`, the two legal, distinct control IDs `MSGÉ1` and `MSGI1` (`0xC9 & 0x7F === 0x49`) collapse onto one key: the second `enqueue()` overwrites the first in the `Map`, and the first send can never be settled by its own ACK. The masked ID is also what got reported to `MLLP_ACK_UNMATCHED_CONTROL_ID` / `MLLP_ACK_AFTER_TIMEOUT` observers and to `MllpTimeoutError.messageControlId` — a control ID that was never on the wire, misdirecting the operator tracing a lost message.

Reachable when MSH-18 declares a non-ASCII charset (e.g. `8859/1`), where high-bit bytes are legal inside an ST-typed control ID. `latin1` is a 1:1 byte↔code-unit mapping, so every distinct byte string stays a distinct key and no framing byte (VT `0x0B` / FS `0x1C`) can be synthesized out of an ordinary payload byte. Six tests added under `test/client/correlator-controlid.test.ts` ("Task 3"), each of which fails under the old `ascii` decode, including a cross-path round-trip pinning `buildRawAck`'s echo and the client extractors to the same key.

Scope, stated precisely: the two paths now agree byte-for-byte for the `|`-delimited messages `buildRawAck` supports. `buildRawAck` still hardcodes `|` while the extractors read the separator from MSH-1 dynamically, and the `ack-from-hl7` subpath still round-trips control IDs through `utf8` — both pre-existing, both untouched here.

Behavior for pure-ASCII control IDs — every realistic deployment today — is unchanged.
