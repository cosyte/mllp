---
id: warning-and-error-codes
title: Warning and error codes
sidebar_label: Warning and error codes
description: "Every stable code @cosyte/mllp reports, by family: framing, correlation, acknowledgment mode, ack-from-hl7, TLS, connection causes, NACKs and error types."
---

# Warning and error codes

Every code on this page is part of the public API. Renaming or removing one is a breaking change,
so log pipelines and dashboards can key on them. No warning, error or event carries a run of message
content; where a code reports a field, it reports its byte length. The types behind each family are
in the [API reference](./api/src.md).

## Framing warnings

The decoder's and the encoder's codes, of type [`WarningCode`](./api/src.md#warningcode). Each
reaches you as an [`MllpWarning`](./api/src.md#mllpwarning) with a `byteOffset`, or, where it is
fatal, as an [`MllpFramingError`](./api/src.md#mllpframingerror) with the same `code`.

| Code                       | Raised when                                                                               | Warning or error                                          |
| -------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `MLLP_MISSING_LEADING_VT`  | a frame begins without `VT`                                                               | warning with `allowMissingLeadingVt`, otherwise an error  |
| `MLLP_FS_WITHOUT_CR`       | a frame ends `FS` with no `CR`                                                            | warning with `allowFsOnly`, otherwise an error            |
| `MLLP_LF_AFTER_FS`         | a line feed follows `FS`                                                                  | warning with `allowLfAfterFs`, otherwise an error         |
| `MLLP_LEADING_WHITESPACE`  | padding precedes `VT`                                                                     | warning with `allowLeadingWhitespace`, otherwise an error |
| `MLLP_TRAILING_BYTES`      | a `VT` arrives inside a payload: the bytes before it are discarded and a new frame starts | always a warning; the auto-ACK path never answers it `AA` |
| `MLLP_EMPTY_PAYLOAD`       | nothing lies between `VT` and `FS`                                                        | always a warning                                          |
| `MLLP_FRAME_TOO_LARGE`     | a frame grows past `maxFrameSizeBytes` (16 MiB by default)                                | always an error                                           |
| `MLLP_PAYLOAD_CONTAINS_VT` | the encoder is given a payload holding `0x0B`                                             | an error; a warning with `allowDelimiterBytesInPayload`   |
| `MLLP_PAYLOAD_CONTAINS_FS` | the encoder is given a payload holding `0x1C`                                             | an error; a warning with `allowDelimiterBytesInPayload`   |

`strict: true` makes the first four errors whatever their flags say. A framing error on a server or
a client closes that one connection, with `connectionCause: "framing-fatal"`, and a client does not
reconnect into it. [Framing and tolerance](./framing.md) explains why.

## Correlation warnings

Raised on the client's `warning` event, of type
[`AckCorrelationCode`](./api/src.md#ackcorrelationcode). Both are also members of `WarningCode`.
The payload is an [`AckCorrelationWarning`](./api/src.md#ackcorrelationwarning) carrying
`controlIdBytes` (the control ID's byte length) and `elapsedSinceSendMs`; its `message` is the fixed
text `ackDiagnosticMessage(code)` returns.

| Code                            | Raised when                                                                |
| ------------------------------- | -------------------------------------------------------------------------- |
| `MLLP_ACK_UNMATCHED_CONTROL_ID` | an acknowledgment's `MSA-2` matches no pending send                        |
| `MLLP_ACK_AFTER_TIMEOUT`        | an acknowledgment arrives for a send that already timed out; it is dropped |

## Acknowledgment-mode warnings

Codes about the enhanced acknowledgment protocol, of type [`AckModeCode`](./api/src.md#ackmodecode).
The client reports them on its `warning` event as an
[`AckModeWarning`](./api/src.md#ackmodewarning); the server reports
`MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED` on its `ackModeWarning` event. Their text is
`ackModeDiagnosticMessage(code)`. None of them refuses or changes a message.

| Code                                     | Raised when                                                                                               |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED`      | `MSH-15` holds a value outside HL7 Table 0155; it is read as its default                                  |
| `MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED` | `MSH-16` holds a value outside HL7 Table 0155; it is read as its default                                  |
| `MLLP_ACK_TWO_PHASE_UNAVAILABLE`         | an enhanced-mode send is made on a FIFO client, so the first acknowledgment matched settles it            |
| `MLLP_ACK_COMMIT_ALREADY_REPORTED`       | a further `CA` arrives for a send whose commit was already reported; the send stays pending               |
| `MLLP_ACK_MSA1_ABSENT`                   | an acknowledgment for an enhanced-mode send has no `MSA-1`; the send stays pending                        |
| `MLLP_ACK_MSA1_UNCLASSIFIABLE`           | an acknowledgment for an enhanced-mode send has an `MSA-1` outside HL7 Table 0008; the send stays pending |
| `MLLP_ACK_SEND_ALREADY_DISPOSED`         | an acknowledgment arrives for a send already settled or failed; it is dropped                             |

## ack-from-hl7 warnings

Carried in the `warnings` of an [`MllpAck`](./api/src/ack-from-hl7.md#mllpack) built by the
`@cosyte/mllp/ack-from-hl7` subpath.

| Code                               | Raised when                                                                                                                   |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `MLLP_ACK_INBOUND_UNPARSEABLE`     | the inbound could not be parsed, or is an `FHS`/`BHS` batch; the acknowledgment is a non-positive `AE` with no correlation ID |
| `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` | on a `Buffer` inbound, the `MSA-2` written differs from the inbound `MSH-10` bytes                                            |
| `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` | on a `string` or parsed inbound, the control ID holds a character outside ASCII, so the echo cannot be checked byte for byte  |
| `ACK_NO_CORRELATION_ID`            | from `@cosyte/hl7`: the inbound has no `MSH-10`, so a requested positive code was downgraded                                  |

## TLS and bind codes

Security warnings are emitted on the client's or the server's `securityWarning` event as a
[`SecurityWarning`](./api/src.md#securitywarning), and through `process.emitWarning`:

| Code                       | Raised when                                                                            |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `MLLP_TLS_VERIFY_DISABLED` | a client configured with `tls.allowUnverified` completes a handshake, on every connect |
| `MLLP_BIND_ALL_INTERFACES` | a server created with `allowWildcardBind: true` binds a wildcard host                  |

TLS configuration errors reject `connect()` or `listen()` with an
[`MllpTlsConfigurationError`](./api/src.md#mllptlsconfigurationerror) before any socket exists:

| Code                              | Raised when                                                                                      |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| `MLLP_TLS_CIPHER_LIST_REJECTED`   | the TLS library accepts no suite in the `ciphers` list; there is no fallback to its default list |
| `MLLP_TLS_CIPHER_OPTION_CONFLICT` | both `atnaTransportSecurity` and `ciphers` are set                                               |
| `MLLP_TLS_DH_PARAMETERS_REJECTED` | the server's `dhParameters` cannot be used                                                       |

## Connection causes

The `connectionCause` of an [`MllpConnectionError`](./api/src.md#mllpconnectionerror), of type
[`ConnectionErrorCause`](./api/src.md#connectionerrorcause). An error without one is a plain socket
failure, such as `ECONNREFUSED`.

| Cause              | Meaning                                                                                | Reconnect              |
| ------------------ | -------------------------------------------------------------------------------------- | ---------------------- |
| `in-flight-orphan` | a FIFO client lost the link with this send already written; it may have been committed | the link, not the send |
| `fifo-unsafe`      | a FIFO client lost the link with this send still queued; it was never written          | the link, not the send |
| `tls-verify`       | certificate verification failed on the initial `connect()`                             | no: permanent          |
| `tls-handshake`    | the TLS handshake failed for a protocol reason on the initial `connect()`              | no: permanent          |
| `framing-fatal`    | the peer sent bytes the decoder could not accept, or a frame past the size cap         | no: permanent          |

`isTransientConnectionError(err)` gives the same classification the client's reconnect uses, and
[Connection, reconnect and backpressure](./reliability.md#auto-reconnect) has the full table.

## Negative acknowledgment reasons

The `reason` of the server's `nack` event, a [`NackEvent`](./api/src.md#nackevent), of type
[`NackReason`](./api/src.md#nackreason):

| Reason                   | The server answered negatively because                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| `handler-rejected`       | your commit-gated `onMessage` handler threw or rejected                                                |
| `uncorrelatable-inbound` | the inbound had no readable `MSH`, an empty `MSH-10`, or more than one message (a batch, or two `MSH`) |
| `discarded-bytes`        | the decoder discarded part of the frame (`MLLP_TRAILING_BYTES`)                                        |

## Error types

Narrow with `instanceof`, never on the text of a message.

| Error                                | Reaches you when                                                                                      | Stable field               |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------- | -------------------------- |
| `MllpFramingError`                   | a `FrameReader` meets a fatal framing violation, or `encodeFrame` a payload it cannot frame           | `code`, `byteOffset`       |
| `MllpConnectionError`                | a socket-level failure, a send before the client is connected, or a refused bind                      | `phase`, `connectionCause` |
| `MllpTimeoutError`                   | no acknowledgment arrives within `ackTimeoutMs` of the write                                          | `messageControlIdBytes`    |
| `MllpBackpressureError`              | a send would pass `highWaterMark` with `onBackpressure: "reject"`                                     | `queueDepth`, `queueBytes` |
| `MllpCommitRejectedError`            | the peer answers an enhanced-mode send with `CE` or `CR`                                              | `commitCode`               |
| `MllpApplicationAckError`            | the peer committed an enhanced-mode send and its application acknowledgment never came                | `commitCode`, `reason`     |
| `MllpNeverDeliveredError`            | `close()` ends with this send never written; resending it is safe                                     | `byteCount`                |
| `MllpUnknownFateError`               | `close()` ends with this send written and unacknowledged; it may be committed                         | `flushedAt`, `byteCount`   |
| `MllpTlsConfigurationError`          | a TLS configuration is refused before any socket exists                                               | `code`                     |
| `MllpDifferentialConfigurationError` | `runDifferential` is given a peer address that is not `host:port` (code `MLLP_DIFF_PEER_UNPARSEABLE`) | `code`                     |
| `MllpPeerMissingError`               | `ack-from-hl7` is called without `@cosyte/hl7` installed (code `MLLP_PEER_MISSING`)                   | `code`                     |
| `MllpAckError`                       | not thrown by the package: you throw it from a handler to choose `AR` over `AE`                       | `ackCode`                  |

`buildMllpAck` and its siblings also throw a `TypeError` for an `encoding` that is not a text codec,
and for a `code` outside HL7 Table 0008.
