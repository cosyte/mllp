---
"@cosyte/mllp": patch
---

Phase 9 — real-world interop, differential conformance & PHI/observability audit (MLLP-9).

**PHI fix (framing).** `MllpFramingError.snippet` no longer carries a run of payload content bytes on **either** framing path — two leaks were closed: (1) the decoder's `MLLP_FRAME_TOO_LARGE` copied the last 32 accumulated payload bytes into `snippet` (the too-large frame is a full HL7 message); since the anomaly is the frame's *size*, not a byte, that snippet is now empty. (2) the encoder's `MLLP_PAYLOAD_CONTAINS_VT` / `MLLP_PAYLOAD_CONTAINS_FS` (strict, reachable from `client.send()`) copied up to 64 payload bytes *around* the offending delimiter — now just the single offending delimiter byte (itself a VT/FS control byte, which the `code` already names). Every framing throw now carries at most the single framing-boundary byte that violated the structure, never a payload run; the `snippet` PHI contract is documented on the field. No public-API change (the field type is unchanged). The PHI-safety property suite drives **both** `FrameReader` and `encodeFrame` over marker payloads, mutation-checked on each path.

**Differential conformance harness (`test/differential/`).** Byte-parity with the two dominant open-source R1 MLLP implementations — the Google Cloud Healthcare MLLP adapter and Mirth/NextGen Connect. Tier 1 (always on) asserts mllp decodes canonical R1 golden frames to the exact payload and `encodeFrame` reproduces them byte-for-byte, plus ACK correlation (MSA-2 echoes MSH-10). Tier 2 (opt-in via `MLLP_DIFF_ADAPTER=host:port`) sends to a live adapter and checks the same correlation; it skips cleanly when unset, so `verify` stays green without a Java/Go adapter — mirroring hl7's oracle-gated Phase-J harness.

**Quirk corpus (`test/conformance/`).** A consolidated interop bar that drives a realistic, multi-segment synthetic HL7 message through each roadmap §3 real-world deviation (missing VT, LF-for-CR, trailing junk, non-MLLP keepalive frames, leading whitespace, empty payload, large/oversized payloads, split across 1-byte TCP chunks) and asserts both the exact stable warning code / typed error AND that the recovered payload is byte-identical to the clean message. The lenient decoder never throws except the one sanctioned fatal `MLLP_FRAME_TOO_LARGE`.

**PHI-safety property suite (`test/property/phi-safety.property.test.ts`).** Generative proof that no framing diagnostic (error `snippet`/`message`, warning `message`) ever echoes a run of payload content, including the oversized path — mutation-checked against the fix above.

**Test-infra cleanup (MLLP-8.1 review ride-along).** The pre-existing `test/server/*` suites now use the shared `test/helpers/tracked-servers.ts` (`must()` + `makeServerTracker()`) instead of copy-pasted local helpers; `graceful-shutdown` keeps its own tracker (it needs a bounded `close({ drainTimeoutMs })` the generic helper doesn't express).
