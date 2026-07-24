# Differential golden frames

These `*.frame.bin` files are **canonical MLLP Release 1 frames**: the exact wire bytes
(`VT 0x0B + payload + FS 0x1C + CR 0x0D`) that the two dominant open-source R1 MLLP
implementations emit for the synthetic messages below, per their documented framing:

- **Google Cloud Healthcare MLLP adapter** (Go, Apache-2.0): <https://github.com/GoogleCloudPlatform/mllp>
- **Mirth / NextGen Connect** (Java, MPL): <https://github.com/nextgenhealthcare/connect>

R1 framing is fully specified and identical across conformant implementations, so these
goldens are **spec-derived, not a live capture**. They encode the interop contract mllp must
match on both the decode and encode side. `differential.test.ts` (Tier 1) asserts mllp's
`FrameReader` decodes each golden to the exact payload and mllp's `encodeFrame` reproduces the
golden byte-for-byte; a framing regression surfaces as a byte diff.

To compare against a **live** adapter instead (Tier 2), run one locally and point the suite at
it: `MLLP_DIFF_ADAPTER=127.0.0.1:2575 pnpm test`. With the env var unset, the live tier skips.

## Fixtures (all synthetic, no real PHI)

| File | Message | Notes |
|------|---------|-------|
| `r1-adt-a01.frame.bin` | `ADT^A01` admit, control id `MSG00001` | multi-segment (MSH/EVN/PID/PV1) |
| `r1-oru-r01.frame.bin` | `ORU^R01` result, control id `MSG00002` | MSH/PID/OBR/OBX |
| `r1-ack-aa.frame.bin`  | `ACK^A01`, `MSA\|AA\|MSG00001` | positive ACK; MSA-2 echoes the ADT's MSH-10 |

## Regenerating

The goldens are deterministic canonical R1 frames of the messages above. Regenerate by framing
each payload as `VT + payload + FS + CR` (see the generator inline in the MLLP-9 ship notes), or
replace any file with a real capture from a live adapter run. The Tier-1 assertions hold for any
conformant R1 frame.
