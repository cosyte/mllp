---
id: glossary
title: Glossary
sidebar_label: Glossary
description: "The acknowledgment codes AA, AE, AR, CA, CE and CR, original and enhanced mode, the commit contract, and the other MLLP terms these pages use."
---

# Glossary

The terms these pages use, each defined once. The acknowledgment codes come from HL7 v2 Table 0008;
section numbers refer to HL7 v2.5.1.

## Acknowledgment codes

An acknowledgment carries its code in `MSA-1`. Table 0008 has six codes in two halves: the
application half, sent in original mode and as the second acknowledgment of enhanced mode, and the
accept half, sent as the first acknowledgment of enhanced mode.

| Code | Name               | Half        | What it tells the sender                                                                   | Resend?       |
| ---- | ------------------ | ----------- | ------------------------------------------------------------------------------------------ | ------------- |
| `AA` | Application accept | application | the receiving application processed the message                                            | no            |
| `AE` | Application error  | application | the receiving application failed to process it; a retry may succeed                        | may resend    |
| `AR` | Application reject | application | the receiving application refused it; a retry of the same bytes will fail again            | not unchanged |
| `CA` | Commit accept      | accept      | the receiver has the message in safe storage; it is now responsible for it                 | no            |
| `CE` | Commit error       | accept      | the receiver could not take the message into safe storage; a retry may succeed             | may resend    |
| `CR` | Commit reject      | accept      | the receiver refused the message, for example an unsupported message type or trigger event | not unchanged |

What our server sends for each outcome of your handler, and for each value of `MSH-15`, is in
[ACKs and the commit contract](./acks.md#the-auto-ack-answers-in-the-half-of-table-0008-the-sender-asked-for).
How our client settles a send on each code is in
[Enhanced mode: one send, two acknowledgments](./acks.md#enhanced-mode-one-send-two-acknowledgments).

## Acknowledgment modes

### Original mode

The acknowledgment protocol of HL7 v2 section 2.9.2: one message, one acknowledgment, with `AA`,
`AE` or `AR`. A message uses it when `MSH-15` and `MSH-16` are both empty. Section 2.9 states it as
a case of enhanced mode: original mode is enhanced mode with `MSH-15` = `NE` and `MSH-16` = `AL`.

### Enhanced mode

The acknowledgment protocol of HL7 v2 section 2.9.3: up to two acknowledgments for one message. The
accept acknowledgment (`CA`, `CE` or `CR`) comes first and says whether the receiver has the
message in safe storage; the application acknowledgment (`AA`, `AE` or `AR`) comes later and says
what the receiving application did with it. A message asks for enhanced mode by carrying a value in
`MSH-15` or `MSH-16`. Our client correlates both acknowledgments when `correlateByControlId` is on;
our server sends one acknowledgment per message, in the half `MSH-15` asks for.

### Accept acknowledgment type (MSH-15)

When the sender wants the accept acknowledgment, from HL7 Table 0155: `AL` always, `NE` never, `ER`
only on an error or reject, `SU` only on success. A value outside the table is read as if the field
were empty and reported with `MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED`.

### Application acknowledgment type (MSH-16)

When the sender wants the application acknowledgment, from the same Table 0155. A value outside the
table is read as `AL` and reported with `MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED`.

### Commit acknowledgment

In these pages, the accept acknowledgment of enhanced mode: `CA`, `CE` or `CR`. The `onCommitAck`
option of `send()` reports a `CA`. MLLP Release 2 uses the same words for a framing-level byte
sequence that confirms receipt of a block; that is a different thing, and we do not implement it
(see [Known limitations](./limitations.md#it-does-not-speak-mllp-release-2)).

### Application acknowledgment

The acknowledgment that carries the receiving application's verdict: `AA`, `AE` or `AR`. In
original mode it is the only acknowledgment; in enhanced mode it follows the accept acknowledgment.

## The commit contract

Our rule that a positive acknowledgment can never go out before the message is committed. With
`autoAck: "AA"` and an `onMessage` handler, the server awaits the handler and answers `AA` (or
`CA`) only if it resolved; a handler that throws is answered `AE` (or `CE`), and one that throws an
`MllpAckError` with `ackCode: "AR"` is answered `AR` (or `CR`). The server also never answers
positively for a message it cannot correlate: no readable `MSH`, an empty `MSH-10`, a batch, several
messages in one frame, or a frame whose bytes the decoder had to discard. The contract is explained
in [ACKs and the commit contract](./acks.md#the-commit-contract).

### Transport accept

The `AA` sent by `autoAck: "AA"` with no `onMessage` handler. It goes out as soon as the frame is
decoded, so it means only that the bytes arrived and were framed, not that anything stored them.

## Correlation

### Control ID (MSH-10)

The message control ID a sender puts in `MSH-10`. The receiver echoes it in `MSA-2`, byte for byte,
and that echo is what lets a sender match an acknowledgment to the message it answers.

### FIFO correlation

Our client's default: acknowledgments are matched to sends in the order the sends were written.

### Correlation by control ID

With `correlateByControlId: true`, our client matches each acknowledgment by its `MSA-2` to the
`MSH-10` of a pending send, so a peer may answer out of order. Enhanced mode needs it.

## Framing

### MLLP

The Minimal Lower Layer Protocol: how HL7 v2 messages travel over TCP. We implement Release 1.

### Frame, or block

One message on the wire: the start byte `VT` (`0x0B`), the payload, then the end bytes `FS`
(`0x1C`) and `CR` (`0x0D`). [Framing and tolerance](./framing.md) covers what the decoder accepts.

### Tolerance flag

One of the four `FrameReaderOptions` that let the decoder accept a common deviation from the
canonical frame (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`,
`allowLeadingWhitespace`). Each accepted deviation is reported as a warning with a stable code; the
codes are listed in [Warning and error codes](./warning-and-error-codes.md#framing-warnings).

## Connections

### Auto-reconnect

The client's opt-in (`autoReconnect: true`) to connect again after a transient failure, with
exponential backoff and jitter. A permanent failure stops it. See
[Connection, reconnect and backpressure](./reliability.md#auto-reconnect).

### Backpressure

The bound on how many messages, or how many bytes, the client holds while they wait for an
acknowledgment (`highWaterMark`). At the bound, `send()` rejects or waits, as `onBackpressure`
says.

### Unknown fate

A message that was written to the socket and still had no acknowledgment when `close()` stopped
waiting. The receiver may or may not have committed it, so a resend may deliver it twice; our client
reports it to the `send()` caller as `MllpUnknownFateError` and resends nothing. See
[Shutdown](./reliability.md#shutdown-and-what-it-does-and-does-not-do-for-in-flight-messages).
