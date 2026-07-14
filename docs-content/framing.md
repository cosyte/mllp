---
id: framing
title: Framing & tolerance
sidebar_position: 2
---

# Framing & tolerance

MLLP is a thin envelope around a payload. A frame is three delimiters and the bytes between them:

```
<VT> payload <FS> <CR>
0x0B   ...    0x1C  0x0D
```

That is the whole protocol. Everything else — what the payload *means*, whether it was accepted,
whether it should be resent — belongs to the HL7 v2 message inside, not to MLLP. `@cosyte/mllp`
carries the bytes and never inspects them.

MLLP is **not byte-transparent**: the delimiters are literal byte values, so a payload must not
contain `0x0B` or `0x1C`. See [Limitations](./limitations.md) for what that means for charsets.

## Postel's Law: strict encoder, liberal decoder

The encoder is **always strict**. `encodeFrame()` emits canonical `VT + payload + FS + CR`, every
time — there is no option to emit a malformed frame. If the payload itself contains a framing byte,
it throws (`MLLP_PAYLOAD_CONTAINS_VT` / `MLLP_PAYLOAD_CONTAINS_FS`) rather than emitting a frame a
peer would mis-split.

The decoder is **liberal — but only where you opt in.** This is the part most easily misread:

> **`FrameReader` is strict by default.** Tolerance is opt-in, flag by flag. The **server** is what
> ships a tolerant default (it enables three of the four flags below), because it is the side that
> has to accept whatever a real-world sender emits.

```ts
import { FrameReader } from "@cosyte/mllp";

const reader = new FrameReader({
  onFrame: (payload, byteOffset, warnings) => handle(payload),
  onWarning: (w) => logger.warn({ code: w.code, byteOffset: w.byteOffset }),
  allowFsOnly: true, // accept a frame ending <FS> with no <CR>
  allowLfAfterFs: true, // tolerate a stray <LF> after <FS>
  allowLeadingWhitespace: true, // tolerate padding before <VT>
  allowMissingLeadingVt: false, // still reject a frame with no <VT>
});
reader.push(chunk); // chunk boundaries are irrelevant — frames may split across any number of chunks
```

`MllpServer` applies these defaults to every accepted connection, and merges anything you pass in
`ServerOptions.framing` over the top:

| Flag | `FrameReader` default | `MllpServer` default |
|---|---|---|
| `allowFsOnly` | `false` | **`true`** |
| `allowLfAfterFs` | `false` | **`true`** |
| `allowLeadingWhitespace` | `false` | **`true`** |
| `allowMissingLeadingVt` | `false` | `false` |

`allowMissingLeadingVt` stays **off** even on the server. A stream with no `<VT>` is not a
tolerable quirk — it is an unframed stream, and guessing where a message starts is how you
mis-split a clinical message. Turn it on only for a specific peer you have identified.

Setting `strict: true` overrides every opt-in above and rejects all four deviations.

## Warning codes are a public API

A tolerated deviation is never silent. It surfaces as a frozen `MllpWarning` carrying a **stable
code** and the **absolute stream byte offset** where the anomaly was detected. Renaming or removing
a code is a breaking change — log pipelines and dashboards key on them.

| Code | Meaning |
|---|---|
| `MLLP_MISSING_LEADING_VT` | Frame began without `<VT>` (requires `allowMissingLeadingVt`). |
| `MLLP_FS_WITHOUT_CR` | Frame ended `<FS>` with no trailing `<CR>`. |
| `MLLP_LF_AFTER_FS` | A stray `<LF>` followed `<FS>` — common from line-oriented senders. |
| `MLLP_LEADING_WHITESPACE` | Padding bytes before `<VT>`. |
| `MLLP_TRAILING_BYTES` | Bytes between one frame's `<CR>` and the next `<VT>` (keepalives, junk). |
| `MLLP_PAYLOAD_CONTAINS_VT` | **Encoder, strict:** payload contains `0x0B`. Throws. |
| `MLLP_PAYLOAD_CONTAINS_FS` | **Encoder, strict:** payload contains `0x1C`. Throws. |
| `MLLP_EMPTY_PAYLOAD` | Nothing between `<VT>` and `<FS>`. |
| `MLLP_FRAME_TOO_LARGE` | Accumulator exceeded `maxFrameSizeBytes`. **Throws** — see below. |
| `MLLP_ACK_UNMATCHED_CONTROL_ID` | An inbound ACK's MSA-2 matched no pending send. |
| `MLLP_ACK_AFTER_TIMEOUT` | A late ACK arrived after its send had already timed out. |

`MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` remain *warnings* even under `strict: true` — they
describe bytes around a well-formed frame, not a broken one.

A twelfth code, `MLLP_ACK_INBOUND_UNPARSEABLE`, is scoped to the
[`ack-from-hl7`](./acks.md) subpath and appears in `MllpAck.warnings`, not in the framing registry.

## Bounded accumulators

A decoder that buffers until it sees `<FS>` is a memory-exhaustion vector: a peer that opens a
socket, sends `<VT>`, and then streams forever will grow your process until it dies.

`FrameReader` is bounded. `maxFrameSizeBytes` defaults to **16 MB**; crossing it throws
`MllpFramingError('MLLP_FRAME_TOO_LARGE')` and the accumulator is not grown further.

```ts
new FrameReader({ onFrame, maxFrameSizeBytes: 4 * 1024 * 1024 }); // 4 MiB
```

This is the **one sanctioned fatal** on the decode path. Every other deviation is either tolerated
with a warning or rejected as a framing error — the lenient decoder never throws on a merely
*strange* frame, only on one that will not fit.

## Diagnostics never echo payload bytes

`MllpFramingError.snippet` carries **at most the single framing-boundary byte that broke the
structure** — never a run of payload content. The payload of an HL7 v2 message is PHI, and an error
message is the easiest way for PHI to escape into a log aggregator.

- `MLLP_FRAME_TOO_LARGE` carries an **empty** snippet. The anomaly is the frame's *size*, not any
  particular byte, so there is nothing to show.
- `MLLP_PAYLOAD_CONTAINS_VT` / `_FS` carry **only the offending delimiter byte** — itself a control
  byte the `code` already names.

Warning `message` fields are stable, human-readable descriptions and likewise never contain payload
bytes. Correlate on `code` + `byteOffset`, and if you need the message itself, log it deliberately
through your own PHI-aware channel.
