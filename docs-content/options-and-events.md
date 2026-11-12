---
id: options-and-events
title: Options, events and statistics
sidebar_label: Options, events and statistics
description: "Every server, client, TLS and framing option with its default, the message metadata, every event and its payload, and the statistics each object reports."
---

# Options, events and statistics

Every option on one page, with its default, and every event and statistic with its fields. The
[generated reference](./api/src.md) has the full type of each, and the guides show them in use.
"Unset" means the option is off, or has no bound of ours, until you set it.

## Server options

[`ServerOptions`](./api/src.md#serveroptions), passed to `createServer(options)`.

| Option                | Type                                                           | Default                   | What it does                                                                                                              |
| --------------------- | -------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `onMessage`           | `(payload, meta, conn) => void \| Promise<void>`               | unset                     | Called for each message. With `autoAck: "AA"` it is the commit step, awaited before the answer                            |
| `autoAck`             | `"AA"` or `(payload, meta, conn) => Buffer \| Promise<Buffer>` | unset (manual mode)       | `"AA"`: the server answers each message itself. A function: the server sends the bytes it returns, framed                 |
| `framing`             | `FrameReaderOptions` without `onFrame` and `onWarning`         | the server defaults below | Tolerance flags and the frame size cap for every accepted connection                                                      |
| `onWarning`           | `(warning: MllpWarning) => void`                               | unset                     | Called for each framing warning on every connection                                                                       |
| `keepaliveIntervalMs` | `number`                                                       | unset (off)               | TCP keepalive interval on each accepted socket                                                                            |
| `noDelay`             | `boolean`                                                      | `true`                    | Turn off Nagle's algorithm (TCP_NODELAY) on each accepted socket; `false` keeps the operating system's default            |
| `deadPeerTimeoutMs`   | `number`                                                       | unset (off)               | Closes a connection that delivers no message for this long                                                                |
| `drainTimeoutMs`      | `number`                                                       | `30_000`                  | Bound on the wait `close()` gives each connection, and on the wait to answer delivered frames after a fatal framing error |
| `tls`                 | `ServerTlsOptions`                                             | unset (plain TCP)         | Serve MLLP over TLS                                                                                                       |
| `allowWildcardBind`   | `boolean`                                                      | `false`                   | Allow `listen()` on a wildcard host such as `0.0.0.0`; binding one emits `securityWarning`                                |
| `maxConnections`      | `number` (a positive integer)                                  | unset (no cap)            | Close a connection at accept when the server already holds this many, and emit `connectionRejected`                       |

`server.listen(port, host)` binds `127.0.0.1` when you name no host; port `0` lets the operating
system pick one. `server.close({ drainTimeoutMs })` overrides `drainTimeoutMs` for one call.

### Starter server options

[`StarterServerOptions`](./api/src.md#starterserveroptions), passed to `createStarterServer(options)`,
which creates the server and starts listening before it returns. It takes every server option, and:

| Option          | Type      | Default       | What it does                                                    |
| --------------- | --------- | ------------- | --------------------------------------------------------------- |
| `port`          | `number`  | required      | The port to listen on                                           |
| `host`          | `string`  | `"127.0.0.1"` | The host to bind                                                |
| `handleSignals` | `boolean` | `false`       | On `SIGTERM` or `SIGINT`, close the server and exit the process |
| `autoAck`       | as above  | `"AA"`        | The starter's default; set it to change it                      |

## Client options

[`ClientOptions`](./api/src.md#clientoptions), passed to `createClient(options)`. The
`createStarterClient` column gives that function's default where it differs, and is empty where the
default is the same.

| Option                    | Type                                                   | `createClient`                  | `createStarterClient` | What it does                                                                                                                            |
| ------------------------- | ------------------------------------------------------ | ------------------------------- | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `host`                    | `string`                                               | required                        | required              | The host to connect to                                                                                                                  |
| `port`                    | `number`                                               | required                        | required              | The port to connect to                                                                                                                  |
| `ackTimeoutMs`            | `number`                                               | `30_000`                        |                       | Bound on the wait for each acknowledgment, from the moment the bytes are flushed to the socket                                          |
| `applicationAckTimeoutMs` | `number`                                               | the send's `ackTimeoutMs`       | not offered           | Bound on the wait for an application acknowledgment after a `CA`, in enhanced mode                                                      |
| `correlateByControlId`    | `boolean`                                              | `false` (first in, first out)   |                       | Match acknowledgments by `MSA-2` to the `MSH-10` of each send                                                                           |
| `fifoUnreadableAck`       | `"warn"` or `"reject"`                                 | `"warn"`                        |                       | In order, what a send settled on a frame with no readable `MSA-1` does: resolve with a warning, or reject with `MllpUnreadableAckError` |
| `pipeline`                | `boolean`                                              | `true`                          |                       | `false` allows one message in flight at a time                                                                                          |
| `highWaterMark`           | `number` or `{ count?, bytes? }`                       | `64`                            |                       | Bound on the messages in flight and queued; with both, the stricter wins                                                                |
| `onBackpressure`          | `"reject"` or `"wait"`                                 | `"reject"`                      |                       | At the bound, reject the new send with `MllpBackpressureError`, or wait for room                                                        |
| `autoReconnect`           | `boolean`                                              | `false`                         | `true`                | Connect again after a transient failure                                                                                                 |
| `retryStrategy`           | `(context: RetryContext) => number \| null`            | the exponential backoff below   |                       | Return the next delay in milliseconds, or `null` to stop                                                                                |
| `initialDelayMs`          | `number`                                               | `100`                           | not offered           | First reconnect delay                                                                                                                   |
| `maxDelayMs`              | `number`                                               | `30_000`                        | not offered           | Cap on the reconnect delay                                                                                                              |
| `multiplier`              | `number`                                               | `2`                             | not offered           | Growth of the delay from one attempt to the next                                                                                        |
| `jitter`                  | `number`                                               | `0.2` (plus or minus 20%)       | not offered           | Random spread applied to each delay                                                                                                     |
| `connectTimeoutMs`        | `number` (an integer, 1 to 2147483647)                 | unset (no bound of ours)        |                       | Bound on the TCP connect and the TLS handshake                                                                                          |
| `keepaliveIntervalMs`     | `number`                                               | unset (off)                     |                       | TCP keepalive interval                                                                                                                  |
| `noDelay`                 | `boolean`                                              | `true`                          |                       | Turn off Nagle's algorithm (TCP_NODELAY) on each connection; `false` keeps the operating system's default                               |
| `deadPeerTimeoutMs`       | `number`                                               | unset (off)                     |                       | Destroy the connection when nothing arrives for this long; reconnects if `autoReconnect` is on                                          |
| `drainTimeoutMs`          | `number`                                               | `30_000`                        |                       | Bound on the wait `close()` gives sends already written                                                                                 |
| `framing`                 | `FrameReaderOptions` without `onFrame` and `onWarning` | the frame reader defaults below |                       | Tolerance flags and the frame size cap for the acknowledgments the client reads                                                         |
| `tls`                     | `TlsOptions` or `true`                                 | unset (plain TCP)               |                       | Connect over TLS; `true` is TLS with every default                                                                                      |

[`StarterClientOptions`](./api/src.md#starterclientoptions) adds two options of its own: `onMessage`
(`(payload: Buffer) => void`, called for every frame the peer sends) and `handleSignals` (`false`
by default: on `SIGTERM` or `SIGINT`, close the client and exit the process). "Not offered" marks
the client options it does not pass on.

### Send options

The second argument of `client.send(payload, options)`.

| Option                    | Type                                | Default                                       | What it does                                                                                                                                       |
| ------------------------- | ----------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signal`                  | `AbortSignal`                       | unset                                         | Aborting it rejects the send with an `AbortError`                                                                                                  |
| `ackTimeoutMs`            | `number`                            | the client's `ackTimeoutMs`                   | Bound on this send's wait for its acknowledgment, from the moment its bytes are flushed; under `onBackpressure: "wait"`, also on its wait for room |
| `applicationAckTimeoutMs` | `number`                            | the client's, then this send's `ackTimeoutMs` | Bound on this send's wait for an application acknowledgment after a `CA`                                                                           |
| `onCommitAck`             | `(report: CommitAckReport) => void` | unset                                         | Called with the `CA` when an application acknowledgment is still to come                                                                           |

## TLS options

### Client TLS options

[`TlsOptions`](./api/src.md#tlsoptions), the `tls` option of a client.

| Option                  | Type                       | Default                       | What it does                                                                                          |
| ----------------------- | -------------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ca`                    | `PemInput`                 | the runtime's trust store     | Trust anchors for the server's certificate                                                            |
| `cert`                  | `PemInput`                 | unset                         | Client certificate, for mutual TLS                                                                    |
| `key`                   | `PemInput`                 | unset                         | Private key for `cert`                                                                                |
| `pfx`                   | `Buffer`                   | unset                         | Client certificate and key as one PKCS#12 file, in place of `cert` and `key`                          |
| `passphrase`            | `string`                   | unset                         | Passphrase for an encrypted `key`, or for `pfx`                                                       |
| `servername`            | `string`                   | the client's `host`           | Server name for SNI and for the certificate identity check; an IP address is never sent as SNI        |
| `minVersion`            | `"TLSv1.2"` or `"TLSv1.3"` | `"TLSv1.2"`                   | Lowest protocol version; nothing below TLS 1.2 can be set                                             |
| `maxVersion`            | `"TLSv1.2"` or `"TLSv1.3"` | unset (the runtime's highest) | Highest protocol version                                                                              |
| `atnaTransportSecurity` | `boolean`                  | `false`                       | Offer exactly the IHE ATNA cipher suites; cannot be combined with `ciphers`                           |
| `ciphers`               | `string`                   | unset (the runtime's list)    | An OpenSSL cipher list of your own                                                                    |
| `allowUnverified`       | `boolean`                  | `false`                       | Turn off certificate verification, with a `securityWarning` on every connection; for development only |

`PemInput` is a string, a `Buffer`, or an array of them.

### Server TLS options

[`ServerTlsOptions`](./api/src.md#servertlsoptions), the `tls` option of a server.

| Option                  | Type                           | Default                       | What it does                                                                                            |
| ----------------------- | ------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `cert`                  | `PemInput`                     | required unless `pfx` is set  | Server certificate                                                                                      |
| `key`                   | `PemInput`                     | required unless `pfx` is set  | Private key for `cert`                                                                                  |
| `pfx`                   | `Buffer`                       | unset                         | Server certificate and key as one PKCS#12 file, in place of `cert` and `key`                            |
| `ca`                    | `PemInput`                     | unset                         | Trust anchors for client certificates                                                                   |
| `passphrase`            | `string`                       | unset                         | Passphrase for an encrypted `key`, or for `pfx`                                                         |
| `clientAuth`            | `"NONE"`, `"WANT"` or `"MUST"` | `"NONE"`                      | Request a client certificate (`WANT`), or require and verify one (`MUST`)                               |
| `minVersion`            | `"TLSv1.2"` or `"TLSv1.3"`     | `"TLSv1.2"`                   | Lowest protocol version                                                                                 |
| `maxVersion`            | `"TLSv1.2"` or `"TLSv1.3"`     | unset (the runtime's highest) | Highest protocol version                                                                                |
| `atnaTransportSecurity` | `boolean`                      | `false`                       | Offer exactly the IHE ATNA cipher suites, with Diffie-Hellman parameters; not with `ciphers`            |
| `ciphers`               | `string`                       | unset (the runtime's list)    | An OpenSSL cipher list of your own                                                                      |
| `dhParameters`          | `string` or `Buffer` (PEM)     | unset                         | Diffie-Hellman parameters for DHE suites; takes precedence over the group `atnaTransportSecurity` picks |

What each runtime enforces, and the errors a setting it cannot honour raises, are in
[Secure a link with TLS](./tls.md).

## Frame reader options

[`FrameReaderOptions`](./api/src.md#framereaderoptions), passed to `new FrameReader(options)`, and,
without `onFrame` and `onWarning`, as the `framing` option of a server or a client.

| Option                   | Type                                      | `FrameReader` and client default | Server default    | What it does                                                                    |
| ------------------------ | ----------------------------------------- | -------------------------------- | ----------------- | ------------------------------------------------------------------------------- |
| `onFrame`                | `(payload, byteOffset, warnings) => void` | required                         | set by the server | Called for each complete payload                                                |
| `onWarning`              | `(warning: MllpWarning) => void`          | unset                            | set by the server | Called for each tolerated deviation                                             |
| `maxFrameSizeBytes`      | `number`                                  | 16 MiB (`16 * 1024 * 1024`)      | 16 MiB            | A larger frame throws `MLLP_FRAME_TOO_LARGE`                                    |
| `allowFsOnly`            | `boolean`                                 | `false`                          | `true`            | Accept `FS` with no `CR` after it; warns `MLLP_FS_WITHOUT_CR`                   |
| `allowLfAfterFs`         | `boolean`                                 | `false`                          | `true`            | Accept `FS` then `LF`; warns `MLLP_LF_AFTER_FS`                                 |
| `allowLeadingWhitespace` | `boolean`                                 | `false`                          | `true`            | Accept spaces, tabs or line breaks before `VT`; warns `MLLP_LEADING_WHITESPACE` |
| `allowMissingLeadingVt`  | `boolean`                                 | `false`                          | `false`           | Accept a frame with no `VT`; warns `MLLP_MISSING_LEADING_VT`                    |
| `strict`                 | `boolean`                                 | `false`                          | `false`           | Throw on the four deviations above even where a flag allows them                |

A `framing` option you pass to a server is merged over the server defaults, so a flag you leave out
keeps its server default. [Tolerate a sender's framing quirks](./tolerate-sender-quirks.md) shows
the flags in use.

## Message metadata

[`MessageMeta`](./api/src.md#messagemeta), the second argument of `onMessage` and of an `autoAck`
function, and the `meta` field of the server's `message` event. The object is frozen.

| Field          | Type                     | What it holds                                               |
| -------------- | ------------------------ | ----------------------------------------------------------- |
| `connectionId` | `string`                 | The ID of the connection the message arrived on, a UUID     |
| `byteOffset`   | `number`                 | Where the frame started in the connection's stream of bytes |
| `warnings`     | `readonly MllpWarning[]` | The framing warnings raised while this frame was decoded    |

## Events

Every event payload is frozen before it is emitted, and none carries a byte of the payload except
the `message` and `ack` events, which hand you the message or its acknowledgment itself, and the
`ack` event's `controlId`. A subscriber that throws does not stop the server or the client; the throw
is reported on `error`. [What is safe to log](#what-is-safe-to-log) goes through every field.

### Server events

| Event                | Payload                                                                                                                                      | When                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `listening`          | `{ port, host }`                                                                                                                             | `listen()` has bound                                                                        |
| `connection`         | `{ connectionId, remoteAddress, remotePort, peerCertificate }`                                                                               | A connection was accepted; `peerCertificate` is set only with `clientAuth` `WANT` or `MUST` |
| `message`            | `{ payload, meta }`                                                                                                                          | A message was decoded; it fires before the acknowledgment is sent                           |
| `nack`               | [`NackEvent`](./api/src.md#nackevent): `{ connectionId, ackCode, reason }`                                                                   | The auto-ACK path sent a negative acknowledgment                                            |
| `ackModeWarning`     | [`AckModeWarningEvent`](./api/src.md#ackmodewarningevent): `{ connectionId, code, message, timestamp }`                                      | `MSH-15` held a value outside Table 0155                                                    |
| `connectionRejected` | [`ConnectionRejectedEvent`](./api/src.md#connectionrejectedevent): `{ code, message, maxConnections, remoteAddress, remotePort, timestamp }` | A connection was closed at accept by `maxConnections`                                       |
| `tlsClientError`     | `{ remoteAddress, remotePort, message, code, timestamp }`                                                                                    | A TLS handshake failed; the server keeps serving                                            |
| `tlsNegotiated`      | [`NegotiatedTlsParameters`](./api/src.md#negotiatedtlsparameters): `{ protocolVersion, cipherSuite, host, port, timestamp }`                 | A TLS handshake completed                                                                   |
| `securityWarning`    | [`SecurityWarning`](./api/src.md#securitywarning): `{ code, message, host, port, timestamp }`                                                | A wildcard host was bound with `allowWildcardBind`                                          |
| `error`              | an `Error` for the server itself or a subscriber that threw, or `{ connectionId, error }` for an error on one connection                     | A server error, a connection error, or a subscriber that threw                              |
| `close`              | `{}`                                                                                                                                         | The server has closed                                                                       |

### Client events

| Event             | Payload                                                                                                                                                                                                                         | When                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `stateChange`     | [`StateChangeEvent`](./api/src.md#statechangeevent): `{ from, to, reason? }`                                                                                                                                                    | The connection changed state                                                                     |
| `connect`         | `{ connectionId }`                                                                                                                                                                                                              | A connection reached `CONNECTED`, the first time and after each reconnect                        |
| `disconnect`      | `{ connectionId }`                                                                                                                                                                                                              | The connection reached `DISCONNECTED`                                                            |
| `reconnecting`    | [`ReconnectingEvent`](./api/src.md#reconnectingevent): `{ connectionId, attempt, delayMs }`                                                                                                                                     | A reconnect was scheduled; `attempt` counts from 0                                               |
| `close`           | `{ connectionId }`                                                                                                                                                                                                              | The connection reached `CLOSED`                                                                  |
| `message`         | `{ payload, connectionId, byteOffset, warnings }`                                                                                                                                                                               | A frame arrived from the peer, an acknowledgment or any other message                            |
| `ack`             | `{ payload, controlId, latencyMs }`                                                                                                                                                                                             | An acknowledgment was matched to a send; `controlId` is `null` in first-in, first-out mode       |
| `drain`           | `{ queueDepth, queueBytes }`                                                                                                                                                                                                    | The queue fell below `highWaterMark`                                                             |
| `warning`         | `MllpWarning`, `AckCorrelationWarning` or `AckModeWarning`                                                                                                                                                                      | A framing, correlation or acknowledgment-mode warning; narrow on `code`                          |
| `tlsNegotiated`   | [`NegotiatedTlsParameters`](./api/src.md#negotiatedtlsparameters)                                                                                                                                                               | A TLS handshake completed                                                                        |
| `securityWarning` | [`SecurityWarning`](./api/src.md#securitywarning)                                                                                                                                                                               | A TLS connection was made with `allowUnverified: true`                                           |
| `error`           | `{ connectionId, error }`, the `error` often an [`MllpConnectionError`](./api/src.md#mllpconnectionerror), or the `Error` a subscriber threw; an unmatched acknowledgment adds `controlIdBytes`, the byte length of its `MSA-2` | A connection or correlation error, or a subscriber that threw; with no listener it is not thrown |

A [`Connection`](./api/src.md#connection) on its own emits `stateChange`, `connect`, `disconnect`,
`reconnecting` (with `connectionId` only), `close`, `message`, `warning` and `error`, with the
payloads above.

The warning codes and the error types are listed in
[Warning and error codes](./warning-and-error-codes.md).

## Statistics

Each `getStats()` returns a plain object that `JSON.stringify` can write, and none of its fields
holds message content.

### Connection statistics

[`ConnectionStats`](./api/src.md#connectionstats), from `connection.getStats()`.

| Field               | Type                     | What it holds                                                                                   |
| ------------------- | ------------------------ | ----------------------------------------------------------------------------------------------- |
| `state`             | `ConnectionState`        | The current state                                                                               |
| `connectionId`      | `string`                 | The connection's ID                                                                             |
| `remoteAddress`     | `string \| null`         | The peer's address                                                                              |
| `remotePort`        | `number \| null`         | The peer's port                                                                                 |
| `warningsByCode`    | `Record<string, number>` | How many warnings of each code this connection raised                                           |
| `bytesIn`           | `number`                 | Bytes received                                                                                  |
| `bytesOut`          | `number`                 | Bytes sent                                                                                      |
| `lastByteInAt`      | `Date \| null`           | When the last byte arrived                                                                      |
| `lastByteOutAt`     | `Date \| null`           | When the last byte was sent                                                                     |
| `connectedAt`       | `Date \| null`           | When the connection reached `CONNECTED`                                                         |
| `warningsTruncated` | `boolean`                | Whether more than 100 warnings arrived, so the oldest were dropped from the connection's record |

### Client statistics

[`ClientStats`](./api/src.md#clientstats), from `client.getStats()`. Times are milliseconds since
the epoch.

| Field               | Type                                   | What it holds                                        |
| ------------------- | -------------------------------------- | ---------------------------------------------------- |
| `state`             | `ConnectionState`                      | The current state                                    |
| `connectionId`      | `string \| null`                       | The current connection's ID                          |
| `queueDepth`        | `number`                               | Sends in flight and queued                           |
| `queueBytes`        | `number`                               | Their size in bytes                                  |
| `inFlight`          | `number`                               | Sends written and waiting for an acknowledgment      |
| `warningsByCode`    | `Partial<Record<WarningCode, number>>` | Framing and correlation warnings, by code            |
| `totalBytesIn`      | `number`                               | Bytes received on the current connection             |
| `totalBytesOut`     | `number`                               | Bytes sent on the current connection                 |
| `sentTotal`         | `number`                               | Messages written since the client was created        |
| `ackedTotal`        | `number`                               | Acknowledgments matched since the client was created |
| `timedOutTotal`     | `number`                               | Acknowledgment timeouts since the client was created |
| `reconnectAttempts` | `number`                               | Reconnect attempts since the client was created      |
| `lastConnectedAt`   | `number \| null`                       | When the client last reached `CONNECTED`             |
| `lastAckAt`         | `number \| null`                       | When the last acknowledgment was matched             |
| `tls`               | `boolean`                              | Whether the client uses TLS                          |

### Server statistics

[`ServerStats`](./api/src.md#serverstats), from `server.getStats()`.

| Field                  | Type             | What it holds                               |
| ---------------------- | ---------------- | ------------------------------------------- |
| `listening`            | `boolean`        | Whether the server is accepting connections |
| `port`                 | `number \| null` | The bound port                              |
| `host`                 | `string \| null` | The bound host                              |
| `connections`          | `number`         | Open connections                            |
| `activeConnections`    | `number`         | Open connections, the same number           |
| `totalBytesIn`         | `number`         | Bytes received across the open connections  |
| `totalBytesOut`        | `number`         | Bytes sent across the open connections      |
| `acceptedTotal`        | `number`         | Connections accepted since `listen()`       |
| `closedTotal`          | `number`         | Connections closed since `listen()`         |
| `tls`                  | `boolean`        | Whether the server uses TLS                 |
| `tlsClientErrorsTotal` | `number`         | Failed TLS handshakes since `listen()`      |

```ts runnable
import { createStarterClient, createStarterServer } from "@cosyte/mllp";

const server = await createStarterServer({ port: 0, onMessage: async () => {} });
const client = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });
await client.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|OPT00001|P|2.5.1\r"),
);

const clientStats = client.getStats();
clientStats.state; // => "CONNECTED"
clientStats.ackedTotal; // => 1
server.getStats().acceptedTotal; // => 1
typeof JSON.stringify(clientStats); // => "string"

await client.close();
await server.close();
```

## What is safe to log

The package calls no logger. What reaches yours is what you pass it, and a handler on a live link is
where that is decided. Below, for every event, hook, error and report, are the fields that can hold
the bytes of a message, and the fields that hold only codes, counts, byte lengths, offsets, times and
your own configuration. A field in the middle column is message content under your PHI handling:
keep it out of logs, metrics and error reports. The fields in the last column can be logged as they
are, with the two exceptions below.

- **Error text.** A few fields carry the text of an error: an `MllpConnectionError`'s `message` and
  `cause`, a `stateChange` event's `reason`, a `RetryContext`'s `lastError`. The text this package
  writes holds no run of message content: a framing error names its code and offset, and for two
  codes the hex of one byte. A socket or TLS error from Node.js names an address or a TLS reason.
  An error you pass in yourself, to `destroy(reason)` or by throwing from a subscriber or a hook,
  carries whatever you put in it.
- **One byte.** `MLLP_MISSING_LEADING_VT` and `MLLP_FS_WITHOUT_CR` render in their `message` the hex
  of the single byte found where a framing byte was expected. On a stream with no leading `VT`, that
  is the first byte of the message. If one byte is more than you allow, log `code` and `byteOffset`.

### Events

| Event                                                                      | Can hold message bytes                                                          | Safe to log                                                                                                                                                                                       |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message`                                                                  | `payload`: the whole message (server) or the whole frame the peer sent (client) | `meta` on the server; `connectionId`, `byteOffset` and `warnings` on a client or a `Connection`                                                                                                   |
| `ack`                                                                      | `payload`: the whole acknowledgment; `controlId`: your `MSH-10`, as text        | `latencyMs`                                                                                                                                                                                       |
| `warning`                                                                  | none                                                                            | every field of the warning: see `MllpWarning`, `AckCorrelationWarning` and `AckModeWarning` below                                                                                                 |
| `nack`, `ackModeWarning`                                                   | none                                                                            | every field                                                                                                                                                                                       |
| `stateChange`                                                              | none                                                                            | `from`, `to`; `reason` is error text                                                                                                                                                              |
| `connect`, `disconnect`, `close`, `reconnecting`, `drain`, `listening`     | none                                                                            | every field                                                                                                                                                                                       |
| `connection`                                                               | none                                                                            | `connectionId`, `remoteAddress`, `remotePort`; `peerCertificate`, whose names are those of the peer system's certificate                                                                          |
| `connectionRejected`, `tlsClientError`, `tlsNegotiated`, `securityWarning` | none                                                                            | every field; a `tlsClientError` `message` is the TLS library's text about a handshake, which fails before any message is sent                                                                     |
| `error`                                                                    | none of ours                                                                    | `connectionId`; `controlIdBytes`, the byte length of an unmatched acknowledgment's `MSA-2`; `error`, or on a server the bare `Error` that is the payload, by its fields in the errors table below |

### Hooks

| Hook                                              | Can hold message bytes                   | Safe to log                                                                                                 |
| ------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `onMessage` and an `autoAck` function on a server | `payload`: the whole message             | `meta`, and `payload.length`                                                                                |
| `onMessage` on a starter client or a `Connection` | `payload`: the whole frame the peer sent | `payload.length`                                                                                            |
| `onFrame` of a `FrameReader`                      | `payload`: the whole frame's content     | `byteOffset`, `warnings`, and `payload.length`                                                              |
| `onWarning`                                       | none                                     | every field of the `MllpWarning`                                                                            |
| `onCommitAck`                                     | the `CommitAckReport`'s `payload`        | `code`, `latencyMs`                                                                                         |
| `retryStrategy`, with its `RetryContext`          | none                                     | `attempt`, `lastDelayMs`, `totalElapsedMs`, `sinceLastSuccessMs`, `classifiedAs`; `lastError` is error text |
| `onData` of an `InMemoryTransport` end            | the chunk: raw bytes off the wire        | the chunk's `length`                                                                                        |

### Errors

| Error                                | Can hold message bytes                                                                                                   | Safe to log                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `MllpFramingError`                   | `snippet`: at most the one byte that broke the frame, empty for `MLLP_FRAME_TOO_LARGE`; `message` names that byte in hex | `code`, `byteOffset`                                                                        |
| `MllpConnectionError`                | none of its own                                                                                                          | `phase`, `connectionCause`; `message` and `cause` are error text                            |
| `MllpTimeoutError`                   | none                                                                                                                     | `message`, `messageControlIdBytes`, `elapsedMs`, `sentAt`                                   |
| `MllpApplicationAckError`            | none                                                                                                                     | `message`, `reason`, `commitCode`, `messageControlIdBytes`, `elapsedMs`, `commitReceivedAt` |
| `MllpCommitRejectedError`            | none                                                                                                                     | `message`, `commitCode`, `messageControlIdBytes`, `elapsedMs`                               |
| `MllpUnreadableAckError`             | none                                                                                                                     | `message`, `msa1Bytes`, `byteOffset`, `elapsedMs`                                           |
| `MllpBackpressureError`              | none                                                                                                                     | `message`, `queueDepth`, `queueBytes`, `highWaterMark`                                      |
| `MllpNeverDeliveredError`            | none                                                                                                                     | `message`, a fixed text; `byteCount`, `messageControlIdBytes`                               |
| `MllpUnknownFateError`               | none                                                                                                                     | `message`, a fixed text; `flushedAt`, `elapsedMs`, `byteCount`, `messageControlIdBytes`     |
| `MllpAckError`                       | what you put in its `message` and `cause`: you throw it, and the server never sends or emits that text                   | `ackCode`                                                                                   |
| `MllpTlsConfigurationError`          | none                                                                                                                     | `message`, `code`; `cause` is the TLS library's error about your own settings               |
| `MllpDifferentialConfigurationError` | none                                                                                                                     | `message`, `code`, `value`: the peer address you configured                                 |
| `MllpPeerMissingError`               | none                                                                                                                     | `message`, `code`                                                                           |

### Reports and results

The shutdown report is a client's `MllpNeverDeliveredError` and `MllpUnknownFateError`, one per
unresolved send, and a server's `MllpConnectionError` with `phase: "close"`, which counts what was
left by kind and names no message. All three are in the table above.

| Report                                               | Can hold message bytes                                                                                 | Safe to log                                                                                                                                                                                 |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageMeta`                                        | none                                                                                                   | `connectionId`, `byteOffset`, `warnings`                                                                                                                                                    |
| `NackEvent`                                          | none                                                                                                   | `connectionId`, `ackCode`, `reason`                                                                                                                                                         |
| `MllpWarning`                                        | none                                                                                                   | `code`, `message` (one byte, above), `byteOffset`, `connectionId`, `timestamp`                                                                                                              |
| `AckCorrelationWarning`                              | none                                                                                                   | the `MllpWarning` fields, `code`, `controlIdBytes`, `elapsedSinceSendMs`; its `message` is a fixed text for the code                                                                        |
| `AckModeWarning`                                     | none                                                                                                   | `code`, `message` (a fixed text for the code), `byteOffset`, `msa1Bytes`, `ackCode`, `controlIdBytes`, `elapsedSinceSendMs`, `connectionId`, `timestamp`                                    |
| `CommitAckReport`                                    | `payload`: the whole accept acknowledgment                                                             | `code`, `latencyMs`                                                                                                                                                                         |
| `getStats()` of a client, a server or a `Connection` | none                                                                                                   | every field                                                                                                                                                                                 |
| `DifferentialReport`                                 | none: it is built to attach to a ticket                                                                | `peer` (the address you configured), `result`, `skipReason`, `exchanges`, `exchangesAttempted`, `exchangesAnswered`, `deadlineMs`, `startedAt`, `finishedAt`                                |
| `DifferentialExchangeReport`                         | none                                                                                                   | `exchangeId`, `outcome`, `byteParity`, `correlation`, `warningCodes`, `deviations`, `requestByteCount`, `responseByteCount`, `deadlineMs`, `elapsedMs`                                      |
| `MllpAck`, from `@cosyte/mllp/ack-from-hl7`          | `frame`, `payload` and `ack`: the whole acknowledgment; `correlationId`: the inbound `MSH-10`, as text | `code`, `requestedCode`, `mode`, and each of the `warnings` by its `code`; a warning's `message` holds byte lengths only for an `MLLP_` code, and is `@cosyte/hl7`'s own text for any other |
| `canonicalExchanges()`                               | `payload`: a whole synthetic message                                                                   | `id`, `description`, `controlId`: they name the corpus, never a patient                                                                                                                     |
