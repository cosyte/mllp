---
id: framing
title: Framing and tolerance
sidebar_label: Framing and tolerance
description: "The MLLP wire format, why the encoder is strict and the decoder tolerant only by opt-in, what throws and what then happens, and why diagnostics hold no payload."
---

# Framing and tolerance

MLLP is a thin envelope around a payload. A frame is three delimiters and the bytes between them:

```
<VT> payload <FS> <CR>
0x0B   ...    0x1C  0x0D
```

That is the whole protocol. Everything else (what the payload _means_, whether it was accepted,
whether it should be resent) belongs to the HL7 v2 message inside, not to MLLP. `@cosyte/mllp`
carries the bytes and never inspects them.

MLLP is **not byte-transparent**: the delimiters are literal byte values, so a payload must not
contain `0x0B` or `0x1C`. See
[Known limitations](./limitations.md#it-cannot-carry-charsets-that-collide-with-the-framing-bytes)
for what that means for charsets.

## Postel's Law: strict encoder, liberal decoder

The encoder is **strict by default**. `encodeFrame()` emits canonical `VT + payload + FS + CR`, and
if the payload itself contains a framing byte it throws (`MLLP_PAYLOAD_CONTAINS_VT` /
`MLLP_PAYLOAD_CONTAINS_FS`) rather than emitting a frame a peer would mis-split. The one opt-in that
changes that is `allowDelimiterBytesInPayload`, which passes those bytes through verbatim with a
warning each; the frame it produces _is_ one a conformant peer will mis-split, so turning it on is a
deliberate decision to emit a non-conformant block. It is off by default on every path, including the
`ack-from-hl7` builder that exposes it as a passthrough. It is declared, with the rest, on the
[Conformance statement](./conformance.md#encoder-deviations).

The decoder is **liberal, but only where you opt in.** This is the part most easily misread:

> **`FrameReader` is strict by default.** Tolerance is opt-in, flag by flag. The **server** is what
> ships a tolerant default (it enables three of the four flags below), because it is the side that
> has to accept whatever a real-world sender emits.

```ts no-run a fragment: handle, logger and chunk stand for your own code and data
import { FrameReader } from "@cosyte/mllp";

const reader = new FrameReader({
  onFrame: (payload, byteOffset, warnings) => handle(payload),
  onWarning: (w) => logger.warn({ code: w.code, byteOffset: w.byteOffset }),
  allowFsOnly: true, // accept a frame ending <FS> with no <CR>
  allowLfAfterFs: true, // tolerate a stray <LF> after <FS>
  allowLeadingWhitespace: true, // tolerate padding before <VT>
  allowMissingLeadingVt: false, // still reject a frame with no <VT>
});
reader.push(chunk); // chunk boundaries are irrelevant, frames may split across any number of chunks
```

`MllpServer` applies these defaults to every accepted connection, and merges anything you pass in
`ServerOptions.framing` over the top:

| Flag                     | `FrameReader` default | `MllpServer` default |
| ------------------------ | --------------------- | -------------------- |
| `allowFsOnly`            | `false`               | **`true`**           |
| `allowLfAfterFs`         | `false`               | **`true`**           |
| `allowLeadingWhitespace` | `false`               | **`true`**           |
| `allowMissingLeadingVt`  | `false`               | `false`              |

The same four flags are declared as deviations from the strict block, each with its warning code and
its per-role default, on the [Conformance statement](./conformance.md#framing-tolerances).

`allowMissingLeadingVt` stays **off** even on the server. A stream with no `<VT>` is not a
tolerable quirk. It is an unframed stream, and guessing where a message starts is how you
mis-split a clinical message. Turn it on only for a specific peer you have identified.

Setting `strict: true` overrides every opt-in above and rejects all four deviations.

## Warning codes are a public API

A tolerated deviation is never silent. It surfaces as a frozen `MllpWarning` carrying a **stable
code** and the **absolute stream byte offset** where the anomaly was detected. Renaming or removing
a code is a breaking change. Log pipelines and dashboards key on them.

| Code                            | Meaning                                                                                                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MLLP_MISSING_LEADING_VT`       | Frame began without `<VT>` (requires `allowMissingLeadingVt`).                                                                                                                                                                               |
| `MLLP_FS_WITHOUT_CR`            | Frame ended `<FS>` with no trailing `<CR>`, the next frame's `<VT>` straight after it.                                                                                                                                                       |
| `MLLP_LF_AFTER_FS`              | A stray `<LF>` followed `<FS>`, common from line-oriented senders.                                                                                                                                                                           |
| `MLLP_LEADING_WHITESPACE`       | Padding bytes before `<VT>`.                                                                                                                                                                                                                 |
| `MLLP_TRAILING_BYTES`           | No longer raised by the decoder. It named a frame delivered as the fragment after a mid-payload `<VT>`; such a frame is now refused whole (`MLLP_PAYLOAD_CONTAINS_VT`). The code stays in the registry so code that names it still compiles. |
| `MLLP_PAYLOAD_CONTAINS_VT`      | **Encoder, strict:** payload contains `0x0B`. **Decoder:** a `<VT>` inside a frame, which is refused whole. Throws.                                                                                                                          |
| `MLLP_PAYLOAD_CONTAINS_FS`      | **Encoder, strict:** payload contains `0x1C`. **Decoder, with `allowFsOnly`:** an `<FS>` that no `<CR>`, `<LF>` or next `<VT>` follows, so the frame is refused whole. Throws.                                                               |
| `MLLP_EMPTY_PAYLOAD`            | Nothing between `<VT>` and `<FS>`.                                                                                                                                                                                                           |
| `MLLP_FRAME_TOO_LARGE`          | Accumulator exceeded `maxFrameSizeBytes`. **Throws**. See below.                                                                                                                                                                             |
| `MLLP_ACK_UNMATCHED_CONTROL_ID` | An inbound ACK's MSA-2 matched no pending send.                                                                                                                                                                                              |
| `MLLP_ACK_AFTER_TIMEOUT`        | A late ACK arrived after its send had already timed out.                                                                                                                                                                                     |

[Tolerate a sender's framing quirks](./tolerate-sender-quirks.md) shows the flags in use, and
[Warning and error codes](./warning-and-error-codes.md) lists every code the package reports.

`MLLP_EMPTY_PAYLOAD` remains a _warning_ (never throws) even under `strict: true`.

Three further codes (`MLLP_ACK_INBOUND_UNPARSEABLE`, `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`, and
`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`) are scoped to the [`ack-from-hl7`](./acks.md) subpath and appear
in `MllpAck.warnings`, not in the framing registry.

## What throws, and what happens when it does

`FrameReader.push()` **throws** `MllpFramingError` in three situations:

1. **`MLLP_FRAME_TOO_LARGE`**: the accumulator crossed `maxFrameSizeBytes`. A decoder that buffers
   until it sees `<FS>` is otherwise a memory-exhaustion vector: a peer that opens a socket, sends
   `<VT>`, and then streams forever would grow your process until it died. The default cap is
   **16 MiB**.

   ```ts no-run a fragment: onFrame stands for your own frame handler
   new FrameReader({ onFrame, maxFrameSizeBytes: 4 * 1024 * 1024 }); // 4 MiB
   ```

2. **A structural violation whose tolerance opt-in is off**: `MLLP_MISSING_LEADING_VT`,
   `MLLP_FS_WITHOUT_CR`, or `MLLP_LF_AFTER_FS`. Since a bare `FrameReader` is strict by default,
   _all three_ throw unless you enable them. On an `MllpServer`, two are enabled by default, but
   `allowMissingLeadingVt` is **not**, so a single non-whitespace byte where a `<VT>` was expected
   throws on a default server.

3. **A frame whose end cannot be told**: a stray `<VT>` or `<FS>` inside it, whatever the
   tolerances. See the next section.

**A throw kills the connection, never the process.** `Connection` catches it, surfaces it as a
frozen `'error'` event (`phase: 'receive'`, `connectionCause: 'framing-fatal'`, with the
`MllpFramingError` preserved as `cause` so the stable `code` and `byteOffset` survive), and closes
**that connection only**. A server drops the one bad peer and keeps serving everyone else.

### Frames before the refused one are still answered

A sender that writes its next frame before the previous acknowledgement arrives can put a good
frame and a refused one in the same read. The good frame has been delivered by then and its handler
is running; its acknowledgement goes out only once the handler settles. So the connection does not
close at once:

1. **It reads nothing more.** Bytes after the refused one, in the same read or later, are dropped
   unread, and no further frame reaches a handler.
2. **It answers what it delivered.** Every frame delivered before the refused one has its handler
   run to the end and its acknowledgement written: `AA` on a commit, `AE` or `AR` on a handler that
   throws, the builder's bytes in custom-ACK mode, and whatever a manual-mode handler sends. The
   connection is `DRAINING` meanwhile. A manual-mode handler's acknowledgement is waited for only
   until the handler's promise settles: a `conn.send()` it makes after that, from a timer or from a
   promise it did not return, is not waited for and may find the connection closed.
3. **It closes.** Once that work has settled the connection goes to `CLOSED` and the socket is
   ended gracefully, so the acknowledgements written reach the sender.
4. **The wait is bounded** by the server's `drainTimeoutMs` (30 seconds by default). A handler that
   has not settled by then is abandoned, its acknowledgement is never sent, and the socket is
   destroyed. A handler that never settles cannot hold the connection open past it. If
   `server.close()` is called during the wait, the work abandoned when the wait ends unsettled is
   reported as a shutdown's is, with an `MllpConnectionError` with `phase: 'close'` on `'error'`.

With no handler still running the connection is destroyed at once, as before. The refused frame
itself is never delivered and never answered (see the next section). On a bare `Connection` the
same wait applies to the work you pass to `conn.holdOpenFor(work)`; `MllpServer` passes every
message's work itself. Unlike `server.close()`, this wait includes a custom-ACK mode `onMessage`
observer. `server.close()` waits the same way on every connection, manual-mode rule included, but
not for that observer; see [Connection, reconnect and
backpressure](./reliability.md#shutdown-and-what-it-does-and-does-not-do-for-in-flight-messages).

This holds even when _your_ code is the thing that throws. Node calls event listeners
**synchronously**, so a throwing subscriber unwinds the stack it was called from, and on this
package's hot paths that stack bottoms out in a socket callback. Every event emitted by `Connection`,
`MllpServer`, and `MllpClient` is therefore dispatched with containment: a throwing subscriber is
reported on `'error'` and cannot take the process down with it, nor skip the work queued behind it.
That last part matters as much as the crash: a throwing `'nack'` subscriber must not be able to
suppress the negative ACK, and a throwing `'message'` subscriber must not be able to break ACK
correlation. (A throwing `'error'` subscriber is the one case simply swallowed: reporting is what
just failed, so there is nowhere left to report it to.)

The one deliberate exception: if your **server** hits an accept-loop error (`EMFILE`/`ENFILE`) and you
have **no** `'error'` listener attached, it still crashes loudly, on purpose. A silent accept outage
on a healthcare listener is worse than a loud one.

The connection is dropped rather than resynchronized on purpose: once `push` has thrown, the reader's
position within the byte stream is no longer trustworthy, and guessing where the next frame begins is
how a clinical message gets silently mis-split.

`framing-fatal` is classified **permanent**, so a client does **not** auto-reconnect into it. A peer
speaking something that is not MLLP (an HTTP probe on the wrong port, a health check) would otherwise
be retried forever. See [Connection, reconnect and backpressure](./reliability.md).

If a peer's quirk is _expected_ (it pads with whitespace, omits the leading `<VT>`, ends a frame
with a bare `<FS>` before the next `<VT>`)
the tolerance opt-ins above are the supported answer. They turn the throw into a warning and recover
the payload.

## A stray `<FS>` or `<VT>` inside a frame

Two messages joined inside one frame, by a bare `<FS>` or by a `<VT>`, leave no way to tell where the
sender meant the frame to end. The bytes before the stray byte may be a whole message whose trailer
went missing, or a fragment the sender gave up on, and the bytes after it may be a second message
or the rest of the first. Keeping either part is a guess, and each guess loses a message with
nothing said: a delivered first message whose acknowledgement never goes out, or a second message
handed on as though it were the frame.

So a receiver refuses such a frame **whole**:

| Bytes inside one frame         | `MllpServer` default (`allowFsOnly` on) | Bare `FrameReader` (strict default) |
| ------------------------------ | --------------------------------------- | ----------------------------------- |
| `<VT> A <VT> B <FS> <CR>`      | refused, `MLLP_PAYLOAD_CONTAINS_VT`     | refused, `MLLP_PAYLOAD_CONTAINS_VT` |
| `<VT> A <FS> B <FS> <CR>`      | refused, `MLLP_PAYLOAD_CONTAINS_FS`     | refused, `MLLP_FS_WITHOUT_CR`       |
| `<VT> A <FS> <VT> B <FS> <CR>` | two frames, `A` then `B`, each answered | refused, `MLLP_FS_WITHOUT_CR`       |

- **Nothing of a refused frame is delivered**, so no handler commits any part of it and no
  acknowledgement names it. Frames delivered before it are untouched and still answered before the
  connection closes, as [the section above](#frames-before-the-refused-one-are-still-answered)
  says.
- **The caller sees a coded error.** `push()` throws an `MllpFramingError` whose `code` names the
  stray byte and whose `byteOffset` is that byte's own offset; its `snippet` is that one framing
  byte, and its `message` holds the offset and nothing of the payload.
- **The connection's state is defined afterwards.** On a server or a client the error arrives on
  `'error'` with `connectionCause: 'framing-fatal'`, and that connection is closed (`CLOSED`) with
  no acknowledgement sent for the refused frame. A sender that waits for one times out and resends; if it resends the same
  bytes, the same refusal follows, so alert on the code. A bare `FrameReader` is left scanning for the
  next `<VT>`; call `reset()` before reusing it, as after any throw.
- **However the bytes arrive.** The outcome is the same whether the frame comes in one read or is
  split across reads at the stray byte or anywhere else.

An `<FS>` followed by the next frame's `<VT>` is the quirk `allowFsOnly` exists for, and stays two
frames, delivered and acknowledged in order.

## Diagnostics never echo a run of payload bytes

`MllpFramingError.snippet` carries **at most a single byte** (the one at the structural violation)
and **never a run of payload content**. The payload of an HL7 v2 message is PHI, and an error message
is the easiest way for PHI to escape into a log aggregator.

- `MLLP_FRAME_TOO_LARGE` carries an **empty** snippet. The anomaly is the frame's _size_, not any
  particular byte, so there is nothing to show.
- `MLLP_PAYLOAD_CONTAINS_VT` / `_FS` carry **only the offending delimiter byte**, itself a control
  byte the `code` already names.
- `MLLP_MISSING_LEADING_VT` / `MLLP_FS_WITHOUT_CR` carry the **one byte found where a framing byte
  was expected**. Being fully precise: that byte is not itself a framing byte, so on a
  missing-`<VT>` stream it is the first byte of the unframed content (typically the `M` of `MSH`).
  One byte, never a run, but if even that is more than your threat model allows, do not log
  `snippet` directly.

Warning `message` fields are stable, human-readable descriptions. They carry structural facts (a
byte offset, an accumulated size) and **never a run of payload content**. The same one-byte
exception the list above spells out applies here too: `MLLP_MISSING_LEADING_VT` and
`MLLP_FS_WITHOUT_CR` render the hex of the single byte found where a framing byte was expected,
which on a missing-`<VT>` stream is the first byte of the unframed content.

The ACK-correlation warnings go further, because the value they report on is a **field**, not one
byte. `MLLP_ACK_UNMATCHED_CONTROL_ID` and `MLLP_ACK_AFTER_TIMEOUT` take their `message`
from a frozen registry: the text is identical for a given code no matter what arrived on the
wire, and the control ID is reported only as `controlIdBytes`, its byte length. The ID itself is
withheld because a warning goes to a log and MSH-10 is payload content. Nothing is lost by that:
the outbound bytes are the payload you handed to `send()`, and the inbound frame reaches you on
the `'message'` event.

Correlate on `code` + `byteOffset`, and if you need the field values themselves, log them
deliberately through your own PHI-aware channel.

## Guides that apply this

- [Tolerate a sender's framing quirks](./tolerate-sender-quirks.md)
- [Receive and acknowledge messages](./receive-messages.md)
- [Test your code and verify an engine](./testing.md)
