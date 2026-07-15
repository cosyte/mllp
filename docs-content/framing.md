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
| `MLLP_TRAILING_BYTES` | **Not benign junk — read this one.** **Reserved** for a `<VT>` appearing *mid-payload*: the partial payload accumulated so far is **discarded** and a new frame started — i.e. the delivered payload is only the **remnant** of a truncated message. It is frame-scoped (attached to the delivered remnant, never a neighbour) and is what the server's auto-ACK path keys on to refuse a positive `AA` for a destroyed message. (A stray byte after `<FS>` under `allowFsOnly` is reported by `MLLP_FS_WITHOUT_CR`, not this code.) |
| `MLLP_PAYLOAD_CONTAINS_VT` | **Encoder, strict:** payload contains `0x0B`. Throws. |
| `MLLP_PAYLOAD_CONTAINS_FS` | **Encoder, strict:** payload contains `0x1C`. Throws. |
| `MLLP_EMPTY_PAYLOAD` | Nothing between `<VT>` and `<FS>`. |
| `MLLP_FRAME_TOO_LARGE` | Accumulator exceeded `maxFrameSizeBytes`. **Throws** — see below. |
| `MLLP_ACK_UNMATCHED_CONTROL_ID` | An inbound ACK's MSA-2 matched no pending send. |
| `MLLP_ACK_AFTER_TIMEOUT` | A late ACK arrived after its send had already timed out. |

`MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` remain *warnings* — never throws — even under
`strict: true`. Do not read `MLLP_TRAILING_BYTES` as cosmetic, though: its mid-payload `<VT>` case
means a message was **truncated**, and it is worth alerting on.

A twelfth code, `MLLP_ACK_INBOUND_UNPARSEABLE`, is scoped to the
[`ack-from-hl7`](./acks.md) subpath and appears in `MllpAck.warnings`, not in the framing registry.

## What throws, and what happens when it does

`FrameReader.push()` **throws** `MllpFramingError` in two situations:

1. **`MLLP_FRAME_TOO_LARGE`** — the accumulator crossed `maxFrameSizeBytes`. A decoder that buffers
   until it sees `<FS>` is otherwise a memory-exhaustion vector: a peer that opens a socket, sends
   `<VT>`, and then streams forever would grow your process until it died. The default cap is
   **16 MB**.

   ```ts
   new FrameReader({ onFrame, maxFrameSizeBytes: 4 * 1024 * 1024 }); // 4 MiB
   ```

2. **A structural violation whose tolerance opt-in is off** — `MLLP_MISSING_LEADING_VT`,
   `MLLP_FS_WITHOUT_CR`, or `MLLP_LF_AFTER_FS`. Since a bare `FrameReader` is strict by default,
   *all three* throw unless you enable them. On an `MllpServer`, two are enabled by default — but
   `allowMissingLeadingVt` is **not**, so a single non-whitespace byte where a `<VT>` was expected
   throws on a default server.

**A throw kills the connection, never the process.** `Connection` catches it, surfaces it as a
frozen `'error'` event (`phase: 'receive'`, `connectionCause: 'framing-fatal'`, with the
`MllpFramingError` preserved as `cause` so the stable `code` and `byteOffset` survive), and destroys
**that connection only**. A server drops the one bad peer and keeps serving everyone else.

This holds even when *your* code is the thing that throws. Node calls event listeners
**synchronously**, so a throwing subscriber unwinds the stack it was called from — and on this
package's hot paths that stack bottoms out in a socket callback. Every event emitted by `Connection`,
`MllpServer`, and `MllpClient` is therefore dispatched with containment: a throwing subscriber is
reported on `'error'` and cannot take the process down with it, nor skip the work queued behind it.
That last part matters as much as the crash: a throwing `'nack'` subscriber must not be able to
suppress the negative ACK, and a throwing `'message'` subscriber must not be able to break ACK
correlation. (A throwing `'error'` subscriber is the one case simply swallowed — reporting is what
just failed, so there is nowhere left to report it to.)

The one deliberate exception: if your **server** hits an accept-loop error (`EMFILE`/`ENFILE`) and you
have **no** `'error'` listener attached, it still crashes loudly, on purpose. A silent accept outage
on a healthcare listener is worse than a loud one.

The connection is dropped rather than resynchronized on purpose: once `push` has thrown, the reader's
position within the byte stream is no longer trustworthy, and guessing where the next frame begins is
how a clinical message gets silently mis-split.

`framing-fatal` is classified **permanent**, so a client does **not** auto-reconnect into it — a peer
speaking something that is not MLLP (an HTTP probe on the wrong port, a health check) would otherwise
be retried forever. See [Connection, reconnect & backpressure](./reliability.md).

If a peer's quirk is *expected* — it pads with junk, omits the leading `<VT>`, sends bare `<FS>` —
the tolerance opt-ins above are the supported answer. They turn the throw into a warning and recover
the payload.

## Diagnostics never echo payload bytes

`MllpFramingError.snippet` carries **at most a single byte** — the one at the structural violation —
and **never a run of payload content**. The payload of an HL7 v2 message is PHI, and an error message
is the easiest way for PHI to escape into a log aggregator.

- `MLLP_FRAME_TOO_LARGE` carries an **empty** snippet. The anomaly is the frame's *size*, not any
  particular byte, so there is nothing to show.
- `MLLP_PAYLOAD_CONTAINS_VT` / `_FS` carry **only the offending delimiter byte** — itself a control
  byte the `code` already names.
- `MLLP_MISSING_LEADING_VT` / `MLLP_FS_WITHOUT_CR` carry the **one byte found where a framing byte
  was expected**. Being fully precise: that byte is not itself a framing byte, so on a
  missing-`<VT>` stream it is the first byte of the unframed content (typically the `M` of `MSH`).
  One byte, never a run — but if even that is more than your threat model allows, do not log
  `snippet` directly.

Warning `message` fields are stable, human-readable descriptions and never contain payload bytes.

Correlate on `code` + `byteOffset`, and if you need the message itself, log it deliberately through
your own PHI-aware channel.
