---
id: troubleshooting
title: Troubleshooting
sidebar_label: Troubleshooting
description: "What a failing MLLP link looks like from @cosyte/mllp, symptom by symptom: the error or code you see, what causes it, and what to do about it."
---

# Troubleshooting

Each entry starts from what you see: an error a call rejects with, a code on a warning, or a
behavior. Every code named here is listed in [Warning and error codes](./warning-and-error-codes.md).

## `send()` rejects with `MllpTimeoutError`

No acknowledgment arrived within `ackTimeoutMs` (30 seconds by default) of the bytes being written.

- **The peer is slow or not answering.** Raise `ackTimeoutMs` if the peer is known to be slow, and
  check that it acknowledges at all: some receivers are configured never to send an
  acknowledgment.
- **The peer answers out of order**, and the client correlates in order. Look for
  `MLLP_ACK_UNMATCHED_CONTROL_ID` warnings; set `correlateByControlId: true`.
- **The peer's `MSA-2` does not repeat your `MSH-10`.** With `correlateByControlId: true`, such an
  acknowledgment matches nothing, raises `MLLP_ACK_UNMATCHED_CONTROL_ID`, and the send times out.

A timeout does not tell you the message was lost: the peer may have committed it. Resend only when
the receiver de-duplicates on `MSH-10` and `MSH-7`. See
[Known limitations](./limitations.md#it-cannot-guarantee-delivery).

## `send()` rejects with `MllpBackpressureError`

The client already holds `highWaterMark` messages (64 by default) in flight and queued, and
`onBackpressure` is `"reject"`. Your code is producing faster than the peer acknowledges. Slow the
producer, raise `highWaterMark`, or use `onBackpressure: "wait"` with an `AbortSignal` to bound the
wait. See [Send messages](./send-messages.md#handle-a-full-queue).

## `send()` rejects with `MllpConnectionError`

Read its `phase` and `connectionCause`:

- **`phase: "send"` with no cause**: the client is not connected. `createClient` does not connect
  until you call `connect()`, and a client that is reconnecting refuses sends until it is back.
- **`connectionCause: "in-flight-orphan"` or `"fifo-unsafe"`**: the link dropped while the send was
  pending, on a client that correlates in order. The first may have been committed, the second was
  never written. See
  [What happens to pending sends when the link drops](./reliability.md#what-happens-to-pending-sends-when-the-link-drops).

## `connect()` hangs, or rejects with `connect-timeout`

A connect to an address that drops packets, or a TLS handshake against a peer that accepts the TCP
connection and never answers, waits on the operating system or indefinitely unless you set
`connectTimeoutMs`. With it set, the attempt is abandoned at the bound and `connect()` rejects with
an `MllpConnectionError` whose `connectionCause` is `connect-timeout`; nothing was sent. Check that
the host and port are right and reachable from this machine, and that the peer expects TLS when you
use it (a plaintext listener never answers a handshake). An auto-reconnecting client retries this
failure with backoff. See [Bounding a connect that never
completes](./reliability.md#bounding-a-connect-that-never-completes).

## The client stopped reconnecting

Auto-reconnect retries only failures it classifies as transient. It stops, and the client goes to
`CLOSED`, on:

- `tls-verify`: the certificate failed verification. Fix the trust anchors (`tls.ca`) or the host
  name; retrying meets the same certificate.
- `tls-handshake`: a TLS protocol failure, such as no shared cipher suite or a client certificate
  the server rejected.
- `framing-fatal`: the peer sent bytes that are not MLLP, often a health check or an HTTP client on
  the wrong port, or a frame past the size cap.
- `ENOTFOUND` or `EACCES`: the host name does not resolve, or the port is not permitted.

A `retryStrategy` of your own that returns `null` also stops it. `isTransientConnectionError(err)`
tells you which way a given error is classified.

## The server closes a sender's connection

A framing error the server's tolerance does not cover closes that one connection; the server keeps
serving every other one. The error event carries `connectionCause: "framing-fatal"` and the
`MllpFramingError` as its `cause`, with the `code` and `byteOffset`.

- `MLLP_MISSING_LEADING_VT`: the sender omits the `VT`. If you have identified it and trust it, set
  `framing: { allowMissingLeadingVt: true }` on the server.
- `MLLP_FRAME_TOO_LARGE`: a frame passed `maxFrameSizeBytes`. Raise it through `framing` if the
  sender's messages really are that large.
- A connection closed after a quiet period: `deadPeerTimeoutMs` closes a connection on which nothing
  arrived for that long. Set it above the longest quiet period of a healthy link, or leave it unset.
- A connection closed in the middle of a message: `partialFrameTimeoutMs` closes a connection whose
  frame stayed open for that long. Raise it if the sender's largest messages arrive that slowly.
- A connection closed as soon as it opened, with a `connectionRejected` event
  (`MLLP_CONNECTION_LIMIT_REACHED`): the server already held `maxConnections` connections. Raise the
  cap, or find the sender that opens connections and never closes them.

See [Tolerate a sender's framing quirks](./tolerate-sender-quirks.md).

## The sender receives `AE` where you expected `AA`

Watch the server's `nack` event; its `reason` says why:

- `handler-rejected`: your `onMessage` handler threw or rejected. Its error is not logged by the
  server; log it inside your handler.
- `uncorrelatable-inbound`: the message has no readable `MSH`, an empty `MSH-10`, or is a batch or
  several messages in one frame. A positive acknowledgment there could not be matched by the sender,
  so it is never sent. Split batches before they reach you, or answer them yourself with
  `autoAck` as a function.
- `discarded-bytes`: a `VT` arrived inside a frame and the decoder discarded the bytes before it
  (`MLLP_TRAILING_BYTES`). The message that arrived is a fragment.

## The sender cannot match your acknowledgments and resends

The sender matches `MSA-2` against the `MSH-10` it sent, byte for byte. An acknowledgment built
through a parser can change the control ID: `@cosyte/mllp/ack-from-hl7` reports this as
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` on a `Buffer` inbound. Build with `buildRawAck`, which copies the
bytes, or use the server's `autoAck: "AA"`, which uses it. See
[Build ACKs with @cosyte/hl7](./build-acks-from-hl7.md#pass-the-bytes-not-decoded-text).

## `listen()` rejects

- **With `MllpConnectionError` naming a wildcard host**: binding `0.0.0.0`, `::` or another
  wildcard needs `allowWildcardBind: true` on the server. Prefer binding the one interface your
  senders reach.
- **With `MllpConnectionError` on a server already listening**: `listen()` runs one at a time. Call
  `close()` before listening again.
- **With `MllpTlsConfigurationError`**: read its `code`. `MLLP_TLS_CIPHER_OPTION_CONFLICT` means
  both `atnaTransportSecurity` and `ciphers` are set; `MLLP_TLS_CIPHER_LIST_REJECTED` means no suite
  in `ciphers` is available; `MLLP_TLS_DH_PARAMETERS_REJECTED` means `dhParameters` is unusable. A
  code ending `_UNENFORCEABLE` means the runtime (Bun or Deno) would not enforce that option, so run
  on Node.js or drop the option. See [Secure a link with TLS](./tls.md#typed-failure-modes) and
  [Under Bun and Deno](./tls.md#under-bun-and-deno).

## `ack-from-hl7` throws `MllpPeerMissingError`

The subpath needs the optional peer `@cosyte/hl7`, and it is not installed. Run
`npm install @cosyte/hl7`. See [Installation](./installation.md#the-optional-cosytehl7-peer).

## An enhanced-mode send fails with `MllpApplicationAckError`

The peer sent the accept acknowledgment (`CA`) and no application acknowledgment followed within
`applicationAckTimeoutMs`, or the link dropped while waiting (its `reason` says which). The peer
holds the message, so do not resend it blindly. Our own server sends one acknowledgment per message,
so pointing this client at it with both `MSH-15` and `MSH-16` asking for acknowledgments always
ends here. See
[ACKs and the commit contract](./acks.md#enhanced-mode-one-send-two-acknowledgments).

## A `securityWarning` appears in your logs

- `MLLP_TLS_VERIFY_DISABLED`: a client runs with `tls.allowUnverified`, so it does not check the
  server's certificate. Remove the option outside a test.
- `MLLP_BIND_ALL_INTERFACES`: a server bound a wildcard host. Confirm that was intended.
