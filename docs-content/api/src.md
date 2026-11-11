# src

`@cosyte/mllp`: an MLLP client and server for Node.js.

Transport-only sibling to `@cosyte/hl7`. Handles framing, ACKs, reconnects,
backpressure, and TLS without requiring knowledge of the MLLP spec.

## Example

```typescript
import { createStarterServer } from '@cosyte/mllp';
const server = await createStarterServer({ port: 2575, onMessage: (buf) => buf });
```

## Classes

### Connection

A single MLLP connection wrapping a [Transport](#transport-1) with a 6-state FSM,
lifecycle events, per-connection warning streams, and `getStats()` observability.

Emits events: `stateChange`, `connect`, `disconnect`, `reconnecting`, `close`,
`message`, `warning`, `error`.

#### Example

```typescript
import { Connection, NetTransport } from '@cosyte/mllp';
import { createConnection } from 'node:net';

const socket = createConnection({ host: 'localhost', port: 2575 });
const conn = new Connection({ transport: new NetTransport(socket) });
conn.on('stateChange', ({ from, to }) => console.log(from, '->', to));
conn.on('message', ({ payload }) => console.log('received', payload.length, 'bytes'));
socket.on('connect', () =>
  conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null)
);
```

#### Extends

- `EventEmitter`

#### Constructors

##### Constructor

> **new Connection**(`opts`): [`Connection`](#connection)

Construct a connection over the given transport. Starts in `CONNECTING`; call
[Connection.notifyConnect](#notifyconnect) once the transport handshake completes.

###### Parameters

###### opts

[`ConnectionOptions`](#connectionoptions)

Connection options (the transport, message/warning handlers, drain timeout, framing).

###### Returns

[`Connection`](#connection)

###### Overrides

`EventEmitter.constructor`

#### Properties

##### beforeClose

> **beforeClose**: (`drainTimeoutMs`) => `Promise`\<`void`\>

beforeClose hook, no-op default that resolves immediately.

An owner may replace this instance property to run work before the socket
closes. Connection calls it during `close()`, racing against `drainTimeoutMs`.

###### Parameters

###### drainTimeoutMs

`number`

###### Returns

`Promise`\<`void`\>

##### connectionId

> `readonly` **connectionId**: `string`

Stable UUIDv4 identifier for this connection.

#### Accessors

##### state

###### Get Signature

> **get** **state**(): [`ConnectionState`](#connectionstate-1)

Current FSM state. One of the 6 `ConnectionState` values.

Subscribe to `'stateChange'` events for reactive state monitoring.

###### Returns

[`ConnectionState`](#connectionstate-1)

#### Methods

##### close()

> **close**(`opts?`): `Promise`\<`void`\>

Initiate graceful close of the connection.

- If `CONNECTING` or `RECONNECTING`: cancels the pending attempt, transitions
  directly to `CLOSED`, and calls `transport.destroy()`.
- If `CONNECTED`: transitions to `DRAINING`, calls `beforeClose(drainTimeoutMs)`,
  then `DRAINING → DISCONNECTED` once the hook resolves, or `DRAINING → CLOSED`
  if the drain timeout elapses first.
- If `DRAINING`: waits for the existing drain to complete (idempotent).

Every pending `close()` resolves as soon as the connection leaves `DRAINING`, by whatever
route: the hook resolving, the drain timeout, a `destroy()`, or the peer closing. A
`destroy()` during a long drain therefore ends the wait at once, not at the drain timeout.
- If `CLOSED` or `DISCONNECTED`: no-op.

###### Parameters

###### opts?

###### drainTimeoutMs?

`number`

Override drain timeout (default: `opts.drainTimeoutMs ?? 30_000`).

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await conn.close({ drainTimeoutMs: 5_000 });
```

##### destroy()

> **destroy**(`reason?`): `void`

Abruptly destroy the connection, discarding any pending writes.

Transitions from any non-terminal state directly to `CLOSED` and calls
`transport.destroy(reason)`. Emits `'close'` event. Idempotent, safe to
call multiple times.

###### Parameters

###### reason?

`Error`

Optional error to propagate to the transport.

###### Returns

`void`

###### Example

```typescript
conn.destroy(new Error('Timeout exceeded'));
```

##### getStats()

> **getStats**(): [`ConnectionStats`](#connectionstats)

Return a JSON-serializable observability snapshot.

All timestamp fields are `Date | null` (not epoch milliseconds). `JSON.stringify()`
serialises them to ISO 8601 strings with no information loss.

`warningsByCode` reflects every warning ever received regardless of ring buffer truncation.
`warningsTruncated` is `true` if the 100-entry ring buffer has overflowed.

###### Returns

[`ConnectionStats`](#connectionstats)

###### Example

```typescript
const stats = conn.getStats();
console.log(JSON.stringify(stats)); // log-pipeline friendly
```

##### notifyConnect()

> **notifyConnect**(`remoteAddress`, `remotePort`): `void`

Notify the connection that the transport handshake has completed.

Transitions `CONNECTING → CONNECTED` and emits the `'connect'` event.
Called externally by Server/Client after the socket connects. In any other state it does
nothing: a connection closed before its socket connected stays `CLOSED` and emits no
`'connect'`, and a second call on a `CONNECTED` connection emits no second one.

###### Parameters

###### remoteAddress

`string` \| `null`

Remote peer IP address, or `null` if unavailable.

###### remotePort

`number` \| `null`

Remote peer port, or `null` if unavailable.

###### Returns

`void`

###### Example

```typescript
socket.on('connect', () =>
  conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null)
);
```

##### onWarning()

> **onWarning**(`fn`): `void`

Register or replace the per-connection warning subscriber.

Subsequent calls replace the previous handler (set-once semantics prevent leaks).
The handler is called synchronously and any exception it throws is swallowed.

###### Parameters

###### fn

(`w`) => `void`

###### Returns

`void`

###### Example

```typescript
conn.onWarning((w) => logger.warn({ code: w.code, connectionId: w.connectionId }));
```

##### send()

> **send**(`data`): `boolean`

Write raw bytes to the transport (no framing applied).

The server and the client wrap this with `encodeFrame()` to add MLLP framing.
Returns `false` if the connection is CLOSED or DISCONNECTED (no bytes written).

###### Parameters

###### data

`Buffer`

###### Returns

`boolean`

`true` if bytes flushed immediately; `false` if buffered (backpressure) or not writable.

###### Example

```typescript
const flushed = conn.send(encodeFrame(payload));
if (!flushed) logger.warn('backpressure detected');
```

***

### FrameReader

Stateful MLLP frame decoder. Feed raw TCP byte chunks via `push(chunk)`.
Complete frames fire synchronously via `onFrame` callback during `push()`.

The decoder operates as a 3-state FSM:
- `SCANNING_FOR_VT`, waiting for the 0x0B frame-start byte
- `READING_PAYLOAD`, accumulating payload bytes until FS (0x1C)
- `EXPECTING_CR`, received FS, waiting for CR (0x0D) to complete the frame

#### Example

```typescript
const reader = new FrameReader({
  onFrame: (payload, byteOffset, warnings) => process(payload, byteOffset, warnings),
  onWarning: (w) => logger.warn(w),
});
socket.on('data', (chunk) => reader.push(chunk));
```

#### Constructors

##### Constructor

> **new FrameReader**(`opts`): [`FrameReader`](#framereader)

Construct a chunked MLLP frame reader.

###### Parameters

###### opts

[`FrameReaderOptions`](#framereaderoptions)

Reader options (`onFrame`/`onWarning` callbacks, tolerance, `maxFrameSizeBytes`).

###### Returns

[`FrameReader`](#framereader)

#### Methods

##### push()

> **push**(`chunk`): `void`

Feed a chunk of raw TCP bytes into the FSM. Frames fire synchronously via `onFrame`
during this call. May throw `MllpFramingError` for unrecoverable framing violations
when the matching tolerance is not enabled.

###### Parameters

###### chunk

`Buffer`

###### Returns

`void`

###### Example

```typescript
socket.on('data', (chunk) => reader.push(chunk));
```

##### reset()

> **reset**(): `void`

Clear internal accumulator state and reset byte offset to 0.

Call on reconnect / connection reuse to start fresh without allocating a new reader.
Pending partial frame state is discarded silently.

###### Returns

`void`

###### Example

```typescript
socket.on('close', () => reader.reset());
```

***

### MllpAckError

Error a message handler throws to control the negative acknowledgement the server
returns. Throwing **any** error from a commit-gated handler yields `AE` by default;
throw an `MllpAckError` to choose `AR` (application reject) instead.

The `message` is **never** copied into the ACK bytes or any emitted event, it may
carry PHI. Only the static, non-PHI `ackCode` influences the wire response.

#### Example

```typescript
import { createServer, MllpAckError } from '@cosyte/mllp';

createServer({
  autoAck: 'AA',
  onMessage: async (payload) => {
    if (!isAcceptable(payload)) {
      // sender should NOT resend unchanged -> AR
      throw new MllpAckError('unsupported message type', { ackCode: 'AR' });
    }
    await db.commit(payload); // throw here -> AE (resend may succeed)
  },
});
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpAckError**(`message`, `opts?`): [`MllpAckError`](#mllpackerror)

###### Parameters

###### message

`string`

Diagnostic text for the thrower. Never placed on the wire (may carry PHI).

###### opts?

###### ackCode?

[`NegativeAckCode`](#negativeackcode)

Negative code to return. Default `'AE'`.

###### cause?

`unknown`

Underlying error, preserved on `.cause`.

###### Returns

[`MllpAckError`](#mllpackerror)

###### Overrides

`Error.constructor`

#### Properties

##### ackCode

> `readonly` **ackCode**: [`NegativeAckCode`](#negativeackcode)

The negative acknowledgement code to return (`AE` or `AR`).

***

### MllpApplicationAckError

Rejects a `send()` whose peer **committed** the message and then never reported what its
application did with it.

This is the enhanced-mode outcome that has no original-mode counterpart, and it is
deliberately a distinct type from [MllpTimeoutError](#mllptimeouterror): that one means "no
acknowledgement at all arrived", and this one means "the accept acknowledgement arrived,
the peer took custody, and the application acknowledgement did not follow". Confusing the
two would tell an operator a message may never have been received when the peer has said
in writing that it was.

`commitCode` is the Table 0008 code already received, so a caller can act on the custody
transfer even though the application disposition is unknown. It is a member of a closed
six-code set, never wire content.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpApplicationAckError) {
    logger.warn({ commit: err.commitCode, reason: err.reason, elapsedMs: err.elapsedMs });
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpApplicationAckError**(`message`, `opts`): [`MllpApplicationAckError`](#mllpapplicationackerror)

Construct an application-acknowledgement failure.

###### Parameters

###### message

`string`

Human-readable error message. Structural facts only, never field content.

###### opts

Failure context (why, the commit code, control-id byte length, timings).

###### commitCode

`"CA"`

###### commitReceivedAt

`number`

###### elapsedMs

`number`

###### messageControlIdBytes

`number` \| `undefined`

###### reason

[`ApplicationAckFailure`](#applicationackfailure)

###### Returns

[`MllpApplicationAckError`](#mllpapplicationackerror)

###### Overrides

`Error.constructor`

#### Properties

##### commitCode

> `readonly` **commitCode**: `"CA"`

The commit disposition already received. Always the positive accept-mode code.

##### commitReceivedAt

> `readonly` **commitReceivedAt**: `number`

Epoch ms at which the accept acknowledgement was received.

##### elapsedMs

> `readonly` **elapsedMs**: `number`

Milliseconds between the accept acknowledgement and this failure.

##### messageControlIdBytes

> `readonly` **messageControlIdBytes**: `number` \| `undefined`

Byte length of the send's MSH-10 control ID, or `undefined` when there was none to
read. The control ID itself is deliberately not here, for the reason given on
[MllpTimeoutError.messageControlIdBytes](#messagecontrolidbytes-3).

##### name

> `readonly` **name**: `"MllpApplicationAckError"`

###### Overrides

`Error.name`

##### reason

> `readonly` **reason**: [`ApplicationAckFailure`](#applicationackfailure)

Why the wait ended. See [ApplicationAckFailure](#applicationackfailure).

***

### MllpBackpressureError

Thrown (or rejects the `send()` promise) when the in-flight queue exceeds
the configured high-water mark and `onBackpressure: 'reject'` is set.

`highWaterMark` accepts a count cap, a byte cap, or both, when both are
present, the stricter-of-two trigger wins.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpBackpressureError) {
    logger.warn({
      queueDepth: err.queueDepth,
      queueBytes: err.queueBytes,
      cap: err.highWaterMark,
    });
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpBackpressureError**(`message`, `opts`): [`MllpBackpressureError`](#mllpbackpressureerror)

Construct an MLLP backpressure error.

###### Parameters

###### message

`string`

Human-readable error message.

###### opts

Backpressure context (queue depth, queued bytes, the high-water-mark hit).

###### highWaterMark

\{ `bytes?`: `number`; `count?`: `number`; \}

###### highWaterMark.bytes?

`number`

###### highWaterMark.count?

`number`

###### queueBytes

`number`

###### queueDepth

`number`

###### Returns

[`MllpBackpressureError`](#mllpbackpressureerror)

###### Overrides

`Error.constructor`

#### Properties

##### highWaterMark

> `readonly` **highWaterMark**: `object`

The high-water-mark configuration that was triggered.

###### bytes?

> `readonly` `optional` **bytes?**: `number`

###### count?

> `readonly` `optional` **count?**: `number`

##### name

> `readonly` **name**: `"MllpBackpressureError"`

###### Overrides

`Error.name`

##### queueBytes

> `readonly` **queueBytes**: `number`

Total bytes of in-flight + queued frames at the moment of rejection.

##### queueDepth

> `readonly` **queueDepth**: `number`

Number of in-flight + queued sends at the moment of rejection.

***

### MllpClient

MLLP client, composes a single [Connection](#connection) over a [NetTransport](#nettransport)
(production) or any other `Transport` (testing via InMemoryTransport).

Public events, every payload `Object.freeze`'d before emission:
- `'stateChange'`, `{ from, to, reason? }` from the underlying Connection FSM
- `'connect'`, `{ connectionId }` once the FSM enters `CONNECTED`
- `'disconnect'`, `{ connectionId }` once the FSM enters `DISCONNECTED`
- `'reconnecting'`, `{ connectionId, attempt?, delayMs? }`
- `'close'`, `{ connectionId }` once the FSM enters terminal `CLOSED`
- `'message'`, `{ payload, connectionId, byteOffset, warnings }` for every inbound frame
- `'warning'`, `MllpWarning | AckCorrelationWarning`. A framing deviation arrives as a
  `MllpWarning` enriched with `connectionId` from the Connection layer; the two
  ACK-correlation codes arrive as [AckCorrelationWarning](#ackcorrelationwarning), which adds
  `controlIdBytes` and `elapsedSinceSendMs`. Narrow on `code` before reading either.
- `'securityWarning'`, `SecurityWarning`. Emitted on every successful
  `secureConnect` (initial + every reconnect) when `tls.allowUnverified` is `true`
  with code `MLLP_TLS_VERIFY_DISABLED`. Also mirrored to `process.emitWarning`.
- `'tlsNegotiated'`, [NegotiatedTlsParameters](#negotiatedtlsparameters). Emitted once per completed TLS
  handshake (initial + every reconnect) with the negotiated protocol version and
  cipher suite. Never emitted on a plaintext connection.
- `'error'`, re-emitted from Connection. Guarded by `listenerCount('error') > 0` so
  absence of a listener does NOT crash the process (server precedent).

#### Example

```typescript
const client = createClient({ host: 'localhost', port: 2575 });
client.on('stateChange', ({ from, to }) => logger.info({ from, to }));
client.on('message', ({ payload }) => logger.info({ bytes: payload.length }));
await client.connect();
const ack = await client.send(payloadBuffer);
await client.close();
```

#### Extends

- `EventEmitter`

#### Constructors

##### Constructor

> **new MllpClient**(`opts`): [`MllpClient`](#mllpclient)

Construct an MLLP client. Created idle; call `connect()` (or use
[createClient](#createclient)/[createStarterClient](#createstarterclient)) to open the connection.

###### Parameters

###### opts

[`ClientOptions`](#clientoptions)

Client options (host/port, ACK timeout, reconnect/backpressure policy, …).

###### Returns

[`MllpClient`](#mllpclient)

###### Overrides

`EventEmitter.constructor`

#### Accessors

##### state

###### Get Signature

> **get** **state**(): [`ConnectionState`](#connectionstate-1)

Current FSM state. Mirrors the underlying Connection's state once attached;
before `connect()` (or after a `CLOSED` Connection is dropped) reports
the client-level baseline (`'DISCONNECTED'`).

###### Returns

[`ConnectionState`](#connectionstate-1)

#### Methods

##### \_attachExistingConnection()

> **\_attachExistingConnection**(`conn`): `void`

**`Internal`**

**Test seam**, attach an externally-built [Connection](#connection) directly,
bypassing the `net.createConnection` + `NetTransport` path. Used by
lifecycle tests driving `InMemoryTransport.pair()` for determinism.

###### Parameters

###### conn

[`Connection`](#connection)

###### Returns

`void`

##### \_captureConnectSignal()

> **\_captureConnectSignal**(`signal`): `void`

**`Internal`**

Test seam, capture or rebind the connect-signal mid-flight.

###### Parameters

###### signal

`AbortSignal`

###### Returns

`void`

##### \_setReconnectFactory()

> **\_setReconnectFactory**(`factory`): `void`

**`Internal`**

Test seam, install a factory that produces the next reconnect Connection.

###### Parameters

###### factory

() => `object`

###### Returns

`void`

##### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Async disposal, delegates to [MllpClient.close](#close-1) for `await using` support.

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await using client = createClient({ host: 'localhost', port: 2575 });
await client.connect();
// client.close() is called automatically at end of block
```

##### close()

> **close**(`opts?`): `Promise`\<`void`\>

Gracefully close the client, awaiting the acknowledgements of sends already written to
the transport.

Delegates to [Connection.close](#close), which transitions `CONNECTED → DRAINING
→ DISCONNECTED` (or `CLOSED` on drain timeout). No-op if no Connection is
attached, or if the close has already completed.

The drain ends as soon as the last outstanding acknowledgement arrives, so a caller whose
peer answers promptly does not wait out `drainTimeoutMs`. Whatever is still unresolved
when it does end is reported to its own `send()` caller under one rule, and the whole
point of this method is that the two halves of that rule are told apart:

  * a send already written to the transport rejects with [MllpUnknownFateError](#mllpunknownfateerror),
    carrying the timestamp at which its bytes went out. It may have been committed;
    resending it may duplicate a clinical message. Nothing is retried here.
  * a send still held inside the client rejects with [MllpNeverDeliveredError](#mllpneverdeliverederror).
    The peer never saw those bytes, so resending them is safe.
  * a send whose commit disposition the peer had already reported keeps its
    [MllpApplicationAckError](#mllpapplicationackerror), which names that disposition. The peer's custody of
    those bytes is known, and a shutdown never downgrades a known fact to an unknown one.

Rejects with `DOMException('Aborted', 'AbortError')` if `signal` aborts mid-drain;
on abort, the underlying Connection is force-destroyed and every still-pending send is
settled under the same rule rather than left pending.

A drain cannot make delivery certain, and nothing here claims otherwise: an
acknowledgement lost in flight is indistinguishable from a message never received. That is
what the unknown-fate report says, and it is why the application still owns idempotency,
keyed on MSH-10 plus MSH-7.

###### Parameters

###### opts?

###### drainTimeoutMs?

`number`

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await client.close({ drainTimeoutMs: 5_000 });
```

##### connect()

> **connect**(`opts?`): `Promise`\<`void`\>

Open a TCP (or TLS) connection to the configured `host:port`
and attach a [Connection](#connection) to it. Resolves once the FSM
enters `CONNECTED`, for TLS, on `'secureConnect'` (handshake complete,
including certificate verification when it is on).

Rejects with:
- `DOMException('Aborted', 'AbortError')` if `signal` is provided and aborts
  before the connect resolves.
- `MllpConnectionError({ phase: 'connect' })` if the underlying socket emits
  `error` before connecting, OR if the client is already connecting/connected.
  TLS failures carry a `connectionCause`: `'tls-verify'` for certificate
  verification failures, `'tls-handshake'` for TLS-protocol-shaped failures
  ([isTlsProtocolError](#istlsprotocolerror)); pure TCP failures carry none.
- `MllpConnectionError({ phase: 'connect', connectionCause: 'connect-timeout' })` if
  [ClientOptions.connectTimeoutMs](#connecttimeoutms) is set and the TCP connect, or the TLS handshake
  after it, did not complete in time. The socket is destroyed; nothing was written.
- `MllpConnectionError({ phase: 'connect' })` if [MllpClient.destroy](#destroy-1) is called while
  `connect()` is still connecting, over TCP or TLS, before or during the handshake. Its
  `cause` is the reason passed to `destroy(reason)`, as it is, and its message is that
  reason's; with no reason the cause is an `Error` whose message is `closed before connect`,
  the same as for any socket that closes before connecting with no error. It carries no
  `connectionCause` either way: a reason is the caller's own, so one whose message or `code`
  reads like a TLS failure (`alert`, `ERR_SSL_*`, `EPROTO`, a certificate code) is never
  sorted into `'tls-handshake'` or `'tls-verify'`. The first `destroy()` decides: a second
  call before `connect()` settles, with a reason or without one, changes nothing.
- `MllpTlsConfigurationError` if the configured cipher-suite list cannot be
  honoured (the runtime rejects it, the runtime does not enforce cipher lists
  at all, or `atnaTransportSecurity` and `ciphers` both declare one). Raised
  **before** a socket is opened, so nothing is left connected; identify it by
  `instanceof` plus its stable `code`.
- `MllpTlsConfigurationError` with `MLLP_TLS_PFX_REJECTED` if `tls.pfx` cannot be loaded
  with `tls.passphrase` (see [TlsOptions.pfx](#pfx-1)), also before a socket is opened.

**Dual failure signal on initial connect:** the Connection's transport
error handler is attached before this promise's own error listener, so a
pre-connect socket error produces BOTH the promise rejection AND a
client `'error'` event (when an `'error'` listener is attached). Handle
whichever fits your flow; they describe the same underlying failure.

**TLS 1.3 + mutual TLS caveat (RFC 8446 §4.4.2):** `connect()` resolving
does NOT guarantee that a `clientAuth: 'MUST'` server accepted your
client certificate. Under TLS 1.3 the client's handshake, and its
`'secureConnect'`, can complete before the server finishes validating
the certificate; a rejection then surfaces moments later as a typed
post-connect error (`'error'` event with an `ERR_SSL_*`/alert cause,
classified **permanent**, no auto-reconnect loop). ACK correlation via
[MllpClient.send](#send-1) remains the delivery guarantee: no send resolves
without its ACK, so a rejected session can never silently "deliver".

###### Parameters

###### opts?

###### signal?

`AbortSignal`

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
const ac = new AbortController();
setTimeout(() => ac.abort(), 5_000);
await client.connect({ signal: ac.signal });
```

##### destroy()

> **destroy**(`reason?`): `void`

Abruptly destroy the client, force-transitions the underlying Connection
to `CLOSED` immediately. No-op if no Connection is attached. Idempotent.

Every pending send is settled at once: no acknowledgement is awaited and no drain timeout
is honoured, which is exactly what separates this from [MllpClient.close](#close-1). A
`close()` already waiting on acknowledgements stops waiting here and returns. A send still
held inside the client is failed with [MllpNeverDeliveredError](#mllpneverdeliverederror), because nothing was
ever written for it; that is a statement about the bytes, not about how the client was
shut down, so it holds on this path too.

A [MllpClient.connect](#connect) still connecting rejects with an `MllpConnectionError` whose
`phase` is `'connect'` and no `connectionCause`. Its `cause` is `reason` when one is given,
never classified as a TLS failure whatever its message or `code`, and otherwise an `Error`
whose message is `closed before connect`. Only the first call reaches the socket, so a
second `destroy()` before `connect()` settles, with or without a reason, changes nothing.

###### Parameters

###### reason?

`Error`

###### Returns

`void`

###### Example

```typescript
client.destroy(new Error('shutting down'));
```

##### getStats()

> **getStats**(): [`ClientStats`](#clientstats)

Returns a JSON-serializable observability snapshot.

All fields are plain values, no Buffers, no class instances, no Maps,
no circular refs. Safe to `JSON.stringify` directly.

`inFlight` is the count of correlator entries with `sentAt !== null`
(entries actually written to the wire and awaiting ACK), distinct from
`queueDepth` which counts ALL live correlator entries (including
pre-flush and serialization-queued sends).

###### Returns

[`ClientStats`](#clientstats)

###### Example

```typescript
setInterval(() => logger.info(JSON.stringify(client.getStats())), 60_000);
```

##### send()

> **send**(`payload`, `opts?`): `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

Send an MLLP-framed payload and await the inbound ACK.

Resolves with the ACK Buffer (framing stripped). Rejects with:
- `DOMException('Aborted', 'AbortError')` if `signal` aborts before the ACK.
- `MllpTimeoutError` if no ACK arrives within `ackTimeoutMs` (this send's own, else the
  client's). The clock starts at the underlying `write()` flush callback, NOT at
  the `send()` call.
- `MllpConnectionError({ phase: 'send' })` if the client is not connected.

Emits a frozen `'ack'` event on every successful match.

**Enhanced acknowledgement mode**

A message whose MSH-15 or MSH-16 is not null asks for the two-part protocol of HL7
v2.5.1 §2.9, and on a client correlating by control ID this method delivers it: the
accept acknowledgement (`CA`) is reported through `onCommitAck` **without** settling
the send, and the later application acknowledgement (`AA`/`AE`/`AR`) is what resolves
it. All three application-mode codes resolve, because which of them the receiving
application chose is its clinical verdict and not this transport's to judge; read MSA-1
off the acknowledgement you are handed. A negative commit (`CE`/`CR`) rejects with
[MllpCommitRejectedError](#mllpcommitrejectederror) at once, since no application acknowledgement follows a
refusal to take custody.

A message with both fields empty is an original-mode send and behaves exactly as it
always has, one acknowledgement, settled by the first match.

###### Parameters

###### payload

`Buffer`

Raw bytes; MLLP framing is added internally via `encodeFrame`.

###### opts?

###### ackTimeoutMs?

`number`

This send's bound on the wait for its acknowledgement, from the
  moment its bytes are flushed, in place of the client's `ackTimeoutMs`. Under
  `onBackpressure: "wait"` it also bounds the wait for queue room, and the
  acknowledgement wait then starts afresh once the send is written.

###### applicationAckTimeoutMs?

`number`

Per-send override of the second wait's bound.

###### onCommitAck?

(`report`) => `void`

Called with the commit disposition when the peer commits the
  message ahead of its application acknowledgement. See [CommitAckReport](#commitackreport).

###### signal?

`AbortSignal`

AbortSignal, aborting cancels the ACK wait.

###### Returns

`Promise`\<`Buffer`\<`ArrayBufferLike`\>\>

###### Example

```typescript
const ack = await client.send(payloadBuffer);
logger.info({ ack: ack.toString('utf8') });
```

***

### MllpCommitRejectedError

Rejects a `send()` whose peer answered with a **negative commit**: HL7 Table 0008 `CE`
(commit error) or `CR` (commit reject).

Either says the peer did not take custody of the bytes, so no application acknowledgement
is coming and there is nothing to wait for. The send fails immediately rather than sitting
out a window that would report the same failure later and less precisely.

`commitCode` is a member of a closed six-code set, never wire content.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpCommitRejectedError && err.commitCode === 'CR') {
    // the peer will not take this message; do not resend it unchanged
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpCommitRejectedError**(`message`, `opts`): [`MllpCommitRejectedError`](#mllpcommitrejectederror)

Construct a negative-commit error.

###### Parameters

###### message

`string`

Human-readable error message. Structural facts only, never field content.

###### opts

Failure context (the commit code, control-id byte length, elapsed time).

###### commitCode

`"CE"` \| `"CR"`

###### elapsedMs

`number`

###### messageControlIdBytes

`number` \| `undefined`

###### Returns

[`MllpCommitRejectedError`](#mllpcommitrejectederror)

###### Overrides

`Error.constructor`

#### Properties

##### commitCode

> `readonly` **commitCode**: `"CE"` \| `"CR"`

The negative accept-mode code the peer sent.

##### elapsedMs

> `readonly` **elapsedMs**: `number`

Milliseconds between the send's write-flush and this acknowledgement.

##### messageControlIdBytes

> `readonly` **messageControlIdBytes**: `number` \| `undefined`

Byte length of the send's MSH-10 control ID, or `undefined` when there was none to
read. The control ID itself is deliberately not here.

##### name

> `readonly` **name**: `"MllpCommitRejectedError"`

###### Overrides

`Error.name`

***

### MllpConnectionError

Thrown (or emitted via `onError`) for socket-layer problems such as
connection refused, ECONNRESET, ETIMEDOUT, or DNS failure.

- `cause`, the original OS or TLS error
- `phase`, which connection lifecycle phase the failure occurred in
- `connectionCause`, optional stable cause-code (e.g. for FIFO reconnect rejections)

#### Example

```typescript
throw new MllpConnectionError('Connection refused', {
  cause: osError,
  phase: 'connect',
});
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpConnectionError**(`message`, `opts`): [`MllpConnectionError`](#mllpconnectionerror)

Construct an MLLP connection error.

###### Parameters

###### message

`string`

Human-readable error message.

###### opts

Error context (underlying `cause`, the lifecycle `phase`, optional stable cause code).

###### cause

`Error`

###### connectionCause?

[`ConnectionErrorCause`](#connectionerrorcause)

###### phase

[`ConnectionErrorPhase`](#connectionerrorphase)

###### Returns

[`MllpConnectionError`](#mllpconnectionerror)

###### Overrides

`Error.constructor`

#### Properties

##### cause

> `readonly` **cause**: `Error`

The original OS or TLS error that caused this connection failure.

###### Overrides

`Error.cause`

##### connectionCause?

> `readonly` `optional` **connectionCause?**: [`ConnectionErrorCause`](#connectionerrorcause)

Optional stable cause code. Present on FIFO reconnect rejections
(`'fifo-unsafe'` for queued sends, `'in-flight-orphan'` for in-flight sends).

The set of values is a **public API**; see [ConnectionErrorCause](#connectionerrorcause).

##### name

> `readonly` **name**: `"MllpConnectionError"`

###### Overrides

`Error.name`

##### phase

> `readonly` **phase**: [`ConnectionErrorPhase`](#connectionerrorphase)

Which connection lifecycle phase the failure occurred in.

***

### MllpDifferentialConfigurationError

Thrown when the differential harness is configured with a peer address it cannot use.

Rejects the originating `runDifferential()` call. No socket is opened, no canonical
message is sent, and no report is produced: there is nothing to report about.

Identify it by `instanceof` **and** by the stable
[MllpDifferentialConfigurationError.code](#code), never by matching on the message text.

#### Example

```typescript
import { MllpDifferentialConfigurationError } from '@cosyte/mllp';
try {
  await runDifferential({ peer: 'not-an-address' });
} catch (err) {
  if (err instanceof MllpDifferentialConfigurationError) logger.error({ value: err.value });
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpDifferentialConfigurationError**(`code`, `value`): [`MllpDifferentialConfigurationError`](#mllpdifferentialconfigurationerror)

Construct a differential configuration error.

###### Parameters

###### code

`"MLLP_DIFF_PEER_UNPARSEABLE"`

The stable configuration-error code; also selects the message.

###### value

`string`

The offending configured value, reported verbatim.

###### Returns

[`MllpDifferentialConfigurationError`](#mllpdifferentialconfigurationerror)

###### Overrides

`Error.constructor`

#### Properties

##### code

> `readonly` **code**: `"MLLP_DIFF_PEER_UNPARSEABLE"`

The stable configuration-error code. Public API; branch on this rather than on the
message.

##### name

> `readonly` **name**: `"MllpDifferentialConfigurationError"`

###### Overrides

`Error.name`

##### value

> `readonly` **value**: `string`

The offending value exactly as it was configured, so the operator can see which of
their settings is wrong without guessing. It is caller configuration, never anything
read off a peer.

***

### MllpFramingError

Thrown for unrecoverable MLLP wire-format violations.

- `code`, stable `WarningCode` identifying the violation
- `byteOffset`, absolute stream position where the violation was detected
- `snippet`, the single framing-boundary byte that broke the structure, or empty when the
  anomaly is not a specific byte. **Never a run of payload content** (see the `snippet` PHI
  contract below); the constructor caps whatever it is given to 64 bytes as a backstop.

#### Example

```typescript
// Pass only the offending framing-boundary byte, never a slice of payload content.
throw new MllpFramingError('MLLP_MISSING_LEADING_VT', byteOffset, Buffer.from([byte]));
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpFramingError**(`code`, `byteOffset`, `snippet`, `message?`): [`MllpFramingError`](#mllpframingerror)

Construct an MLLP framing error.

###### Parameters

###### code

[`WarningCode`](#warningcode)

The stable warning code classifying the violation.

###### byteOffset

`number`

Absolute stream byte offset where the violation was detected.

###### snippet

`Buffer`

Raw bytes copied from around the anomaly (capped to 64 bytes).

###### message?

`string`

Optional human-readable override message.

###### Returns

[`MllpFramingError`](#mllpframingerror)

###### Overrides

`Error.constructor`

#### Properties

##### byteOffset

> `readonly` **byteOffset**: `number`

Absolute byte offset in the stream where the error was detected.

##### code

> `readonly` **code**: [`WarningCode`](#warningcode)

Stable warning code identifying the violation type.

##### name

> `readonly` **name**: `"MllpFramingError"`

###### Overrides

`Error.name`

##### snippet

> `readonly` **snippet**: `Buffer`

Up to 64 bytes copied from around the anomaly.

This is a **copied** Buffer, isolated from the source buffer so it remains
valid after the underlying buffer is reused or overwritten.

**PHI contract:** the decoder only ever populates this with the single
framing-boundary byte that violated the frame structure (whose hex value the
`message` already discloses), never a run of payload content bytes. For anomalies
whose fault is not a specific byte (`MLLP_FRAME_TOO_LARGE`, the accumulated size),
the snippet is **empty**: a payload slice on a public error field would leak a
field-body slice of clinical content. Callers constructing this directly are
responsible for the same discipline.

***

### MllpNeverDeliveredError

Rejects a `send()` whose bytes **never reached the transport**: the message was still held
inside the client when the client shut down, waiting for room in the send queue or for the
single in-flight slot.

This is the safe half of a shutdown report. Nothing was written, so the peer cannot have
seen this message, cannot have committed it, and cannot produce a duplicate if the
application sends it again. It is deliberately a distinct type from
[MllpUnknownFateError](#mllpunknownfateerror), so a caller decides between resending and escalating on
`instanceof` rather than on the wording of a message.

Every field is a count. There is nothing else to carry: the caller passed the payload to
`send()` and still holds it.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpNeverDeliveredError) {
    // safe to resend: these bytes were never written
    await backupClient.send(payload);
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpNeverDeliveredError**(`opts`): [`MllpNeverDeliveredError`](#mllpneverdeliverederror)

Construct a never-delivered report.

There is no `message` parameter, deliberately: see NEVER\_DELIVERED\_MESSAGE.

###### Parameters

###### opts

Report context (framed byte count, control-id byte length).

###### byteCount

`number`

###### messageControlIdBytes

`number` \| `undefined`

###### Returns

[`MllpNeverDeliveredError`](#mllpneverdeliverederror)

###### Overrides

`Error.constructor`

#### Properties

##### byteCount

> `readonly` **byteCount**: `number`

Byte count of the framed message this send would have written.

##### messageControlIdBytes

> `readonly` **messageControlIdBytes**: `number` \| `undefined`

Byte length of the send's MSH-10 control ID, or `undefined` when there was none to read.
The control ID itself is deliberately not here, for the reason given on
[MllpTimeoutError.messageControlIdBytes](#messagecontrolidbytes-3).

##### name

> `readonly` **name**: `"MllpNeverDeliveredError"`

###### Overrides

`Error.name`

***

### MllpServer

MLLP TCP server, wraps `net.Server` without extending it.

Each accepted socket is wrapped in a `NetTransport`, connected to a `Connection`
with server-level framing options, and added to `_connections`. Messages are
surfaced via the `'message'` event and the `onMessage` callback.

Public events: `'listening'`, `'connection'`, `'message'`, `'nack'`, `'error'`, `'close'`.
The `'nack'` event ([NackEvent](#nackevent)) fires whenever the server returns a negative ACK
instead of `AA` on the auto-ACK path, a commit-gated `autoAck: 'AA'` handler failing, or
a positive auto-ACK **downgraded** because the inbound could not be correlated (an
unreadable/uncorrelatable message, or one whose bytes the decoder discarded). The
[NackReason](#nackreason) distinguishes the causes.

**`'error'` contract:** underlying `net.Server`/`tls.Server` errors are forwarded to the
`'error'` event whenever a listener is attached. With **no** listener, the outcome depends on
server state: during a `listen()` (the bind window) the error **rejects the `listen()` promise**
the primary error surface, and the process never crashes on a bind error; with no `listen()`
in flight and the server not serving (e.g. a stale async error after `close()`) the error is
dropped; but **while serving**, an unlistened runtime error (e.g. accept-loop `EMFILE`) keeps
Node's fail-loud crash-on-unlistened-`'error'` convention, a silent accept outage is
impossible. Caveat for `'error'` listeners: the forwarder runs **before** the internal
`listen()` rejection handler, so an `'error'` listener that synchronously calls `close()`
during the bind window changes the `listen()` rejection from the bind error to the typed
close-during-listen `MllpConnectionError`, match on the `'error'` event payload, not the
rejection, if you do that.
TLS (MLLPS) adds three more: `'tlsClientError'` (a failed TLS handshake, the
server logs it and keeps serving other connections), `'securityWarning'` (loud,
one-time notice when a wildcard host is bound via `allowWildcardBind: true`), and
`'tlsNegotiated'` ([NegotiatedTlsParameters](#negotiatedtlsparameters), the protocol version and cipher
suite each accepted link actually negotiated, once per completed handshake and never
on a plaintext listener).
With [ServerOptions.maxConnections](#maxconnections-1) set, `'connectionRejected'`
([ConnectionRejectedEvent](#connectionrejectedevent)) reports each connection closed at accept because the server
was already full; such a connection never fires `'connection'` and never reaches `onMessage`.
All event payloads are `Object.freeze()`'d before emission.

#### Example

```typescript
import { createServer } from '@cosyte/mllp';

const server = createServer({
  onMessage: (payload, meta, conn) => {
    console.log('received from', meta.connectionId);
  },
});
await server.listen(2575);
// await using server = createServer({ ... }); // Symbol.asyncDispose
```

#### Extends

- `EventEmitter`

#### Constructors

##### Constructor

> **new MllpServer**(`opts`): [`MllpServer`](#mllpserver)

Construct an MLLP server. Created idle; call `listen()` (or use
[createServer](#createserver)/[createStarterServer](#createstarterserver)) to begin accepting connections.

###### Parameters

###### opts

[`ServerOptions`](#serveroptions)

Server options (bind host/port, auto-ACK policy, message handler, framing, …).

###### Returns

[`MllpServer`](#mllpserver)

###### Overrides

`EventEmitter.constructor`

#### Methods

##### \[asyncDispose\]()

> **\[asyncDispose\]**(): `Promise`\<`void`\>

Async disposal, delegates to `close()` for `await using` support.

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await using server = createServer({ onMessage: handler });
await server.listen(2575);
// server.close() is called automatically at end of block
```

##### close()

> **close**(`opts?`): `Promise`\<`void`\>

Stop accepting new connections and gracefully close all active connections.

Sequence:
1. `net.Server.close()`, stops accepting new connections immediately
2. If `_connections` is empty: resolves immediately (no drain needed)
3. Calls `_drainAll(drainTimeoutMs)`, Promise.all + side-effect setTimeout
   that force-destroys stragglers after the drain window

Calling `close()` while a `listen()` is still in flight proactively
settles that `listen()` with a typed `MllpConnectionError` rejection
and clears the single-flight guard, the server is immediately
re-listenable. `Symbol.asyncDispose` (which delegates here) is
therefore safe before `listen()` settles. **Qualification:** a
`close({ signal })` whose signal is **already aborted** rejects
immediately with `AbortError` and performs no work, it does NOT close
the server and does NOT settle the in-flight `listen()`, which simply
continues and settles on its own bind outcome.

###### Parameters

###### opts?

###### drainTimeoutMs?

`number`

Override drain timeout (default: `opts.drainTimeoutMs ?? 30_000`).

###### signal?

`AbortSignal`

AbortSignal to cancel the close operation. On abort, all
  active connections are destroyed and the promise rejects with AbortError.

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await server.close({ drainTimeoutMs: 5_000 });
```

##### getStats()

> **getStats**(): [`ServerStats`](#serverstats)

Return a JSON-serializable observability snapshot.

`totalBytesIn` and `totalBytesOut` aggregate from live connections at call time.

###### Returns

[`ServerStats`](#serverstats)

###### Example

```typescript
const stats = server.getStats();
logger.info(JSON.stringify(stats));
```

##### listen()

> **listen**(`port`, `hostOrOpts?`): `Promise`\<`void`\>

Start listening on the given port.

Resolves once the TCP socket is bound and emits `'listening'` with
`Object.freeze({ port: actualPort, host: actualHost })`.

**Single-flight:** one `listen()` per server lifecycle at a time. A call
while the server is already listening, or while another `listen()` is
still in flight, rejects with a typed `MllpConnectionError` (concurrent
binds raced each other's post-bind safety checks). Call `close()` before
re-listening; sequential `listen()` → `close()` → `listen()` is fine.

**A refused TLS configuration** (the runtime rejects the offered suite
list, `tls.atnaTransportSecurity` and `tls.ciphers` both declare one, or
`tls.dhParameters` are not usable) rejects every `listen()` on this server
with a typed `MllpTlsConfigurationError`, checked before the bind. Such a
server never listens, never negotiates on any other list and never runs
without the Diffie-Hellman parameters it was given; construct a new one
with a configuration that resolves.

**`close()` during an in-flight `listen()`** rejects that `listen()` with
a typed `MllpConnectionError` (never a hang) and clears the single-flight
guard, a subsequent `listen()` on the same server works. This makes
`Symbol.asyncDispose` (which delegates to `close()`) safe even before a
`listen()` has settled. (Exception: `close({ signal })` with an
already-aborted signal is a no-op AbortError rejection, the in-flight
`listen()` is left to settle on its own bind outcome; see `close()`.)

###### Parameters

###### port

`number`

TCP port to bind. Use `0` to let the OS assign an ephemeral port.

###### hostOrOpts?

`string` \| \{ `host?`: `string`; `signal?`: `AbortSignal`; \}

Host string or object with `host` and optional `signal`.
  Default host: `'127.0.0.1'` (bind-safety hardening). Wildcard hosts
  are rejected unless `ServerOptions.allowWildcardBind: true`, literal
  spellings pre-bind, resolver-only shorthands post-bind via the
  OS-normalized bound address.

###### Returns

`Promise`\<`void`\>

###### Example

```typescript
await server.listen(2575); // binds 127.0.0.1
await server.listen(0, '127.0.0.1');
await server.listen(0, { host: '127.0.0.1', signal: ac.signal });
```

***

### MllpTimeoutError

Thrown (or rejects the `send()` promise) when an ACK does not arrive within
the configured `ackTimeoutMs`.

The timeout clock starts at the underlying `write()` flush callback, NOT
at the `send()` call, pre-flush queue time is not charged to the peer.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpTimeoutError) {
    logger.warn({ elapsedMs: err.elapsedMs, idBytes: err.messageControlIdBytes });
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpTimeoutError**(`message`, `opts`): [`MllpTimeoutError`](#mllptimeouterror)

Construct an MLLP timeout error.

###### Parameters

###### message

`string`

Human-readable error message. Structural facts only, never field content.

###### opts

Timeout context (control-id byte length, elapsed time, flush timestamp).

###### elapsedMs

`number`

###### messageControlIdBytes

`number` \| `undefined`

###### sentAt

`number`

###### Returns

[`MllpTimeoutError`](#mllptimeouterror)

###### Overrides

`Error.constructor`

#### Properties

##### elapsedMs

> `readonly` **elapsedMs**: `number`

Milliseconds elapsed between write-flush and timeout fire.

##### messageControlIdBytes

> `readonly` **messageControlIdBytes**: `number` \| `undefined`

Byte length of the timed-out send's MSH-10 control ID, or `undefined` when
there was none to read (FIFO mode, or a payload with no MSH-10).

**The control ID itself is deliberately not here.** An `Error` is a
diagnostic surface: it is logged, and its `stack` is what an error reporter
ships off the box. MSH-10 is payload content, and a scanner that returns
the wrong field returns payload content of some other kind, which is how a
patient identifier reaches a log line. Nothing is lost by withholding it,
because this error rejects the very `send()` whose payload the caller
passed in, so the caller already holds the bytes. Control IDs are decoded
`latin1`, a 1:1 byte to code-unit map, so this count is a byte count.

##### name

> `readonly` **name**: `"MllpTimeoutError"`

###### Overrides

`Error.name`

##### sentAt

> `readonly` **sentAt**: `number`

Epoch ms timestamp recorded at write-flush callback.

***

### MllpTlsConfigurationError

Thrown for a TLS configuration this package will not open a connection on.
Rejects the originating `MllpClient.connect()` or `MllpServer.listen()`; no
socket is opened and no listener is left bound.

Identify it by `instanceof` **and** by the stable [MllpTlsConfigurationError.code](#code-2),
never by matching on the message text. `message` is a fixed registry entry
and carries no key material and no passphrase; `cause`, when present, is the
TLS library's own error for one input on its own (the suite list and the
Diffie-Hellman parameters are each validated with no credential in scope; a
PKCS#12 file is validated with its passphrase, and the library's error for it
names the failure without repeating either).

#### Example

```typescript
import { MllpTlsConfigurationError } from '@cosyte/mllp';
try {
  await server.listen(2575);
} catch (err) {
  if (err instanceof MllpTlsConfigurationError) logger.error({ code: err.code });
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpTlsConfigurationError**(`code`, `opts?`): [`MllpTlsConfigurationError`](#mllptlsconfigurationerror)

Construct a TLS configuration error.

###### Parameters

###### code

[`TlsConfigurationErrorCode`](#tlsconfigurationerrorcode)

The stable configuration-error code; also selects the message.

###### opts?

Optional underlying `cause` from the TLS library.

###### cause?

`Error`

###### Returns

[`MllpTlsConfigurationError`](#mllptlsconfigurationerror)

###### Overrides

`Error.constructor`

#### Properties

##### cause

> `readonly` **cause**: `Error` \| `undefined`

The TLS library's own error, when the runtime is what refused the input
(or, for an `_UNENFORCEABLE` code, refused one of the probes).
`undefined` when this package refused the configuration itself.

###### Overrides

`Error.cause`

##### code

> `readonly` **code**: [`TlsConfigurationErrorCode`](#tlsconfigurationerrorcode)

The stable configuration-error code. Public API; branch on this rather
than on the message.

##### name

> `readonly` **name**: `"MllpTlsConfigurationError"`

###### Overrides

`Error.name`

***

### MllpUnknownFateError

Rejects a `send()` that **was** written to the transport and whose acknowledgement had still
not arrived when the client finished closing.

The ambiguous half of a shutdown report, and it is reported as ambiguous because it is: an
acknowledgement lost on the way back is indistinguishable from a message the peer never
received. Nothing is retried automatically. HL7 makes the accept acknowledgement the thing
that releases a sender from resending, and puts the retransmission decision on the
application and on its peer's duplicate detection, keyed on MSH-10 plus MSH-7.

Distinct from [MllpNeverDeliveredError](#mllpneverdeliverederror) (nothing was written, so a resend is safe) and
from [MllpApplicationAckError](#mllpapplicationackerror) (the peer said in writing that it took custody, so a
resend would commit the message twice). Confusing the three is how a consumer's replay logic
either duplicates a clinical message or drops one.

`flushedAt` is what a replay decision reasons about: it says when these bytes went out, so a
caller can compare it against the peer's own record.

**Every field is a byte count or a timestamp, and the message is a constant.** No part of
the payload reaches this error, not the control ID, not a truncation of it, and not a hex
rendering. An `Error` is a diagnostic surface: it is logged, and its `stack` plus its own
properties are what an error reporter ships off the box.

#### Example

```typescript
try {
  await client.send(payload);
} catch (err) {
  if (err instanceof MllpUnknownFateError) {
    // do NOT blindly resend: the peer may already hold this message
    logger.warn({ flushedAt: err.flushedAt, bytes: err.byteCount });
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpUnknownFateError**(`opts`): [`MllpUnknownFateError`](#mllpunknownfateerror)

Construct an unknown-fate report.

There is no `message` parameter, deliberately: see UNKNOWN\_FATE\_MESSAGE.

###### Parameters

###### opts

Report context (flush timestamp, elapsed time, byte counts).

###### byteCount

`number`

###### elapsedMs

`number`

###### flushedAt

`number`

###### messageControlIdBytes

`number` \| `undefined`

###### Returns

[`MllpUnknownFateError`](#mllpunknownfateerror)

###### Overrides

`Error.constructor`

#### Properties

##### byteCount

> `readonly` **byteCount**: `number`

Byte count of the framed message that was written.

##### elapsedMs

> `readonly` **elapsedMs**: `number`

Milliseconds between that write and this report.

##### flushedAt

> `readonly` **flushedAt**: `number`

Epoch ms at which this send's bytes were written to the transport.

##### messageControlIdBytes

> `readonly` **messageControlIdBytes**: `number` \| `undefined`

Byte length of the send's MSH-10 control ID, or `undefined` when there was none to read.
The control ID itself is deliberately not here, for the reason given on
[MllpTimeoutError.messageControlIdBytes](#messagecontrolidbytes-3).

##### name

> `readonly` **name**: `"MllpUnknownFateError"`

###### Overrides

`Error.name`

***

### NetTransport

Wraps a `net.Socket` as a `Transport`, mapping socket EventEmitter events
to registered single-handler callbacks.

Each `onXxx(fn)` call replaces the prior handler and re-registers on the socket
(uses `socket.removeAllListeners(event)` + `socket.on(event, fn)`).

#### Example

```typescript
const t = new NetTransport(socket);
t.onData((chunk) => process(chunk));
t.onError((err) => handleError(err));
```

#### Implements

- [`Transport`](#transport-1)

#### Constructors

##### Constructor

> **new NetTransport**(`socket`): [`NetTransport`](#nettransport)

Wrap an existing `net.Socket` (or `tls.TLSSocket`) as a `Transport`.

###### Parameters

###### socket

`Socket`

The connected (or connecting) socket to adapt.

###### Returns

[`NetTransport`](#nettransport)

#### Methods

##### close()

> **close**(): `void`

See [Transport.close](#close-5).

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`close`](#close-5)

##### destroy()

> **destroy**(`reason?`): `void`

See [Transport.destroy](#destroy-4).

###### Parameters

###### reason?

`Error`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`destroy`](#destroy-4)

##### onClose()

> **onClose**(`fn`): `void`

See [Transport.onClose](#onclose-2).

###### Parameters

###### fn

() => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onClose`](#onclose-2)

##### onConnect()

> **onConnect**(`fn`): `void`

See [Transport.onConnect](#onconnect-2).

###### Parameters

###### fn

() => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onConnect`](#onconnect-2)

##### onData()

> **onData**(`fn`): `void`

See [Transport.onData](#ondata-2).

###### Parameters

###### fn

(`chunk`) => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onData`](#ondata-2)

##### onError()

> **onError**(`fn`): `void`

See [Transport.onError](#onerror-2).

###### Parameters

###### fn

(`err`) => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onError`](#onerror-2)

##### write()

> **write**(`buf`): `boolean`

See [Transport.write](#write-2).

###### Parameters

###### buf

`Buffer`

###### Returns

`boolean`

###### Implementation of

[`Transport`](#transport-1).[`write`](#write-2)

***

### TlsTransport

Wraps a `tls.TLSSocket` as a `Transport`. `onConnect(fn)` is armed on the
`'secureConnect'` event (handshake complete, including certificate
verification when `rejectUnauthorized` is on) rather than the raw TCP
`'connect'` event that `NetTransport` uses.

Each `onXxx(fn)` call replaces the prior handler and re-registers on the
socket (`socket.removeAllListeners(event)` + `socket.on(event, fn)`),
the same set-once semantics as `NetTransport`.

#### Example

```typescript
const t = new TlsTransport(tlsSocket);
t.onConnect(() => logger.info('secure'));
t.onError((err) => handleTlsError(err));
```

#### Implements

- [`Transport`](#transport-1)

#### Constructors

##### Constructor

> **new TlsTransport**(`socket`): [`TlsTransport`](#tlstransport)

Wrap an existing `tls.TLSSocket` (connecting or already secure) as a `Transport`.

###### Parameters

###### socket

`TLSSocket`

The TLS socket to adapt.

###### Returns

[`TlsTransport`](#tlstransport)

#### Methods

##### close()

> **close**(): `void`

See [Transport.close](#close-5).

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`close`](#close-5)

##### destroy()

> **destroy**(`reason?`): `void`

See [Transport.destroy](#destroy-4).

###### Parameters

###### reason?

`Error`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`destroy`](#destroy-4)

##### onClose()

> **onClose**(`fn`): `void`

See [Transport.onClose](#onclose-2).

###### Parameters

###### fn

() => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onClose`](#onclose-2)

##### onConnect()

> **onConnect**(`fn`): `void`

See [Transport.onConnect](#onconnect-2). Armed on `'secureConnect'`, the TLS
handshake-complete event, not the raw TCP `'connect'` event.

###### Parameters

###### fn

() => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onConnect`](#onconnect-2)

##### onData()

> **onData**(`fn`): `void`

See [Transport.onData](#ondata-2).

###### Parameters

###### fn

(`chunk`) => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onData`](#ondata-2)

##### onError()

> **onError**(`fn`): `void`

See [Transport.onError](#onerror-2).

###### Parameters

###### fn

(`err`) => `void`

###### Returns

`void`

###### Implementation of

[`Transport`](#transport-1).[`onError`](#onerror-2)

##### write()

> **write**(`buf`): `boolean`

See [Transport.write](#write-2).

###### Parameters

###### buf

`Buffer`

###### Returns

`boolean`

###### Implementation of

[`Transport`](#transport-1).[`write`](#write-2)

## Interfaces

### AckCodeSelection

What [selectAckCode](#selectackcode) decided. A frozen object; it carries no field text.

#### Example

```typescript
import { selectAckCode, type AckCodeSelection } from '@cosyte/mllp';
const selection: AckCodeSelection = selectAckCode({ msh15: 'AL', outcome: 'AA' });
selection.code; // 'CA'
```

#### Properties

##### acceptTypeUnrecognised

> `readonly` **acceptTypeUnrecognised**: `boolean`

MSH-15 held a value outside Table 0155. It was read as NULL: `code` is `outcome`, unchanged,
as the server answers (and reports with `MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED`).

##### applicationAckRequested

> `readonly` **applicationAckRequested**: `boolean`

Whether MSH-16 asks for an application acknowledgement carrying this outcome: `AL` always, `NE`
never, `ER` on `AE` or `AR` only, `SU` on `AA` only. A NULL or unrecognised MSH-16 reads as
`AL`, which is the original protocol. Where `code` is an accept-mode code and this is `true`,
the application acknowledgement is a second message, and sending it is the caller's; where
`code` is an application-mode code, `code` is that acknowledgement.

##### applicationTypeUnrecognised

> `readonly` **applicationTypeUnrecognised**: `boolean`

MSH-16 held a value outside Table 0155. It was read as NULL, so as `AL`.

##### code

> `readonly` **code**: [`AckCode`](#ackcode-3)

The one code to send now. The accept-mode counterpart of `outcome` (`CA`, `CE` or `CR`) when
MSH-15 asks for an accept acknowledgement on that outcome, and `outcome` itself otherwise. This
is the code the server's auto-ACK sends for the same fields and outcome.

##### mode

> `readonly` **mode**: `"original"` \| `"enhanced"`

`'enhanced'` when MSH-15 or MSH-16 is non-NULL (the standard's own test for the enhanced
protocol), `'original'` when both are NULL.

***

### AckCodeSelectionInput

Input to [selectAckCode](#selectackcode).

#### Example

```typescript
import type { AckCodeSelectionInput } from '@cosyte/mllp';
const input: AckCodeSelectionInput = { msh15: 'AL', msh16: 'NE', outcome: 'AA' };
```

#### Properties

##### encodingCharacters?

> `readonly` `optional` **encodingCharacters?**: `string`

The message's MSH-2 encoding characters, which name its component (first byte) and repetition
(second byte) separators. Unset means the standard `^~\&`.

###### Default

```ts
'^~\\&'
```

##### msh15?

> `readonly` `optional` **msh15?**: `string`

MSH-15, accept acknowledgment type (HL7 Table 0155), as the field's text: `AL`, `NE`, `ER`,
`SU`, or anything else the sender put there. Read the way the server reads it: the text before
the first repetition separator, then before the first component separator, with leading and
trailing spaces dropped, compared case-sensitively. Unset, empty, or the HL7 explicit null
`""` is a NULL field.

##### msh16?

> `readonly` `optional` **msh16?**: `string`

MSH-16, application acknowledgment type (HL7 Table 0155), read the same way as `msh15`.

##### outcome

> `readonly` **outcome**: `"AA"` \| `"AE"` \| `"AR"`

What the receiving application did with the message, as an application-mode code: `AA` it was
accepted, `AE` it failed, `AR` it was rejected. Any other value throws a `RangeError`.

***

### AckCorrelationWarning

The `'warning'` payload the client emits for an ACK-correlation deviation
(`MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`).

A `MllpWarning` with two extra numeric fields. `message` is a **frozen
registry entry**, byte-for-byte identical for a given code no matter what
arrived on the wire, and everything input-derived is a number: the control
ID's byte length and the elapsed time. A warning is a log line, so it carries
no field content.

#### Example

```typescript
client.on('warning', (w: AckCorrelationWarning) => {
  logger.warn({ code: w.code, idBytes: w.controlIdBytes, elapsedMs: w.elapsedSinceSendMs });
});
```

#### Extends

- [`MllpWarning`](#mllpwarning)

#### Properties

##### byteOffset

> `readonly` **byteOffset**: `number`

Absolute stream byte offset where the anomaly was detected.

###### Inherited from

[`MllpWarning`](#mllpwarning).[`byteOffset`](#byteoffset-5)

##### code

> `readonly` **code**: [`AckCorrelationCode`](#ackcorrelationcode)

The correlation code this warning reports.

###### Overrides

[`MllpWarning`](#mllpwarning).[`code`](#code-10)

##### connectionId

> `readonly` **connectionId**: `string` \| `undefined`

Connection identifier. `undefined` at the framing layer;
enriched by `Connection` before emitting upstream.

###### Inherited from

[`MllpWarning`](#mllpwarning).[`connectionId`](#connectionid-7)

##### controlIdBytes

> `readonly` **controlIdBytes**: `number` \| `null`

Byte length of the control ID involved, or `null` when there was none to
read. Control IDs are decoded `latin1`, so a code-unit count is a byte count.

##### elapsedSinceSendMs

> `readonly` **elapsedSinceSendMs**: `number`

Milliseconds between the send's write-flush (or its timeout, for a late
ACK) and this warning.

##### message

> `readonly` **message**: `string`

Stable human-readable description. It carries structural facts (a byte
offset, an accumulated size) and **never a run of payload content**.

Two codes carry exactly one input byte, and it is worth knowing which:
`MLLP_MISSING_LEADING_VT` and `MLLP_FS_WITHOUT_CR` render the hex of the
single byte found where a framing byte was expected, and on a stream that
omits its leading `VT` that byte is the first byte of the unframed content.
One byte, never a run, the same bound `MllpFramingError.snippet` carries. If
that is more than your threat model allows, log `code` and `byteOffset`
rather than `message`.

The ACK-correlation codes are stricter: their text comes from a frozen
registry and does not vary with the wire at all.

###### Inherited from

[`MllpWarning`](#mllpwarning).[`message`](#message-4)

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

###### Inherited from

[`MllpWarning`](#mllpwarning).[`timestamp`](#timestamp-4)

***

### AckModeWarning

The `'warning'` payload the client emits for an **acknowledgement-mode** deviation: an
enhanced-mode send on a client that cannot correlate two acknowledgements, a Table 0155
value it did not recognise, an acknowledgement it could not classify into a mode, and a
further acknowledgement for a send that is already settled or failed.

It arrives on the same `'warning'` event as a framing warning and an
[AckCorrelationWarning](#ackcorrelationwarning), so narrow on `code` before reading its fields. It is
**not** an `MllpWarning`: its `code` is an [AckModeCode](#ackmodecode), deliberately a family of
its own rather than an addition to the decoder's registry, and it is not counted in
`getStats().warningsByCode`, whose keys are the decoder's codes.

Everything input-derived on it is a number or a member of the closed six-code Table 0008
set. `message` is a **frozen registry entry**, byte-for-byte identical for a given code
no matter what arrived on the wire. A warning is a log line, so it carries no field
content: an MSA-1 nobody could classify is reported by its byte length alone.

#### Example

```typescript
client.on('warning', (w: AckModeWarning) => {
  if (w.code === 'MLLP_ACK_MSA1_UNCLASSIFIABLE') {
    logger.warn({ code: w.code, msa1Bytes: w.msa1Bytes, at: w.byteOffset });
  }
});
```

#### Properties

##### ackCode

> `readonly` **ackCode**: `"AA"` \| `"AE"` \| `"AR"` \| `"CA"` \| `"CE"` \| `"CR"` \| `null`

Table 0008 code involved, or `null` when the code reports none.

##### byteOffset

> `readonly` **byteOffset**: `number`

Inbound frame's stream byte offset; `0` for a warning raised on an outbound send.

##### code

> `readonly` **code**: [`AckModeCode`](#ackmodecode)

The acknowledgement-mode code this warning reports.

##### connectionId

> `readonly` **connectionId**: `string` \| `undefined`

Connection identifier, `undefined` before a connection is attached.

##### controlIdBytes

> `readonly` **controlIdBytes**: `number` \| `null`

Byte length of the control ID involved, or `null` when there was none to read.

##### elapsedSinceSendMs

> `readonly` **elapsedSinceSendMs**: `number`

Milliseconds since the send's write-flush, or since its disposal for a late ACK.

##### message

> `readonly` **message**: `string`

Frozen registry text for `code`. Never interpolated.

##### msa1Bytes

> `readonly` **msa1Bytes**: `number` \| `null`

Byte length of the MSA-1 field involved, or `null` when the code reports none.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### AckModeWarningEvent

Payload of the server `'ackModeWarning'` event: something about an inbound message's
acknowledgement-mode request was read and reported, and the acknowledgement went out
anyway.

Emitted when MSH-15 carries a value outside HL7 Table 0155. The acknowledgement is **not**
downgraded, negated or otherwise changed for that reason: reading a field is not
validating it, and answering a message the handler committed with anything but a positive
code would make a sender resend a message that is already stored.

**PHI-safe by construction:** a connection ID, a stable code and a frozen registry
message, never the payload and never the field's value. The object is `Object.freeze()`'d
before emission.

#### Example

```typescript
server.on('ackModeWarning', ({ code }) => metrics.increment('mllp.ack_mode', { code }));
```

#### Properties

##### code

> `readonly` **code**: [`AckModeCode`](#ackmodecode)

The acknowledgement-mode code being reported.

##### connectionId

> `readonly` **connectionId**: `string`

Connection the inbound message arrived on.

##### message

> `readonly` **message**: `string`

Frozen registry text for `code`. Never interpolated.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### CanonicalExchange

One send-and-await-response pair the harness runs against a peer.

`payload` is the HL7 v2 message body with **no** MLLP framing on it. The harness frames
it canonically (`VT` + payload + `FS` + `CR`) with the package's own strict encoder
before it goes on the wire, so what a peer receives is the Release 1 block this package
emits for every message.

#### Example

```typescript
const [first] = canonicalExchanges();
// first?.id === 'adt-a01'; first?.controlId === 'MSG00001'
```

#### Properties

##### controlId

> `readonly` **controlId**: `string`

The `MSH-10` message control ID this message carries. A conformant peer echoes it in
the `MSA-2` of its acknowledgement, which is the correlation the harness checks.

##### description

> `readonly` **description**: `string`

One-line description of what the message is, for a human reading the report.

##### id

> `readonly` **id**: `string`

Stable identifier for this exchange, and the identifier the report uses. It names the
message, never a patient, so it is safe to log.

##### payload

> `readonly` **payload**: `Buffer`

The unframed HL7 v2 message bytes. A fresh copy per call; mutating it is harmless.

***

### ClientOptions

Options for [createClient](#createclient) and the [MllpClient](#mllpclient) constructor.

#### Example

```typescript
const opts: ClientOptions = { host: 'localhost', port: 2575, drainTimeoutMs: 10_000 };
```

#### Properties

##### ackTimeoutMs?

> `readonly` `optional` **ackTimeoutMs?**: `number`

Per-message ACK timeout in milliseconds. The clock starts at
the underlying `write()` flush callback, NOT at the `send()` call,
pre-flush queue time is not charged to the peer. Default: `30_000`.

A send can set its own with `send(payload, { ackTimeoutMs })`, which replaces this value
for that send's acknowledgement wait.

##### applicationAckTimeoutMs?

> `readonly` `optional` **applicationAckTimeoutMs?**: `number`

Bound, in milliseconds, on the **second** wait an enhanced-mode send can enter: the
one that starts when an accept acknowledgement (`CA`) reports that the peer has
committed the message, and ends when the application acknowledgement arrives.

Measured from the moment that accept acknowledgement was received, not from the send,
so a peer that commits at 9 s and applies at 12 s settles the send successfully at
12 s. Defaults to whatever `ackTimeoutMs` is in force for the send, and can be
overridden per send. It only ever applies to a send whose MSH-16 asks for an
application acknowledgement, so it changes nothing for an original-mode interface.

###### Default

the send's own `ackTimeoutMs`

##### autoReconnect?

> `readonly` `optional` **autoReconnect?**: `boolean`

Auto-reconnect on transient disconnect. Default `false`.

When `true`, dropped connections caused by transient errors (per
[isTransientConnectionError](#istransientconnectionerror)) trigger the FSM cycle
`CONNECTED → DISCONNECTED → RECONNECTING → CONNECTING → CONNECTED`
with exponential backoff unless overridden by
[ClientOptions.retryStrategy](#retrystrategy). Permanent errors halt and
transition directly to `CLOSED`.

##### connectTimeoutMs?

> `readonly` `optional` **connectTimeoutMs?**: `number`

Bound, in milliseconds, on establishing each connection: the TCP connect and, when
[ClientOptions.tls](#tls) is set, the TLS handshake after it. The clock starts when the
socket is created and stops at `'connect'` (plaintext) or `'secureConnect'` (TLS).

On expiry the socket is destroyed. On `connect()` the promise rejects with an
`MllpConnectionError` whose `phase` is `'connect'` and whose `connectionCause` is
`'connect-timeout'`; nothing was written, so no message can have reached the peer. On an
auto-reconnect attempt the failure feeds the reconnect policy like any other connect
failure: `RetryContext.lastError` carries `code: 'ETIMEDOUT'` and it is classified
**transient**, so the client backs off and tries again.

Must be an integer from 1 to 2147483647 (the largest delay a Node timer takes); anything else
throws a `RangeError` at construction. Unset means no bound of our own: a connect waits on
the operating system, and a TLS handshake against a peer that accepts the TCP connection and
never answers waits indefinitely.

###### Default

```ts
undefined (no bound)
```

##### correlateByControlId?

> `readonly` `optional` **correlateByControlId?**: `boolean`

If `true`, ACKs are matched against outgoing sends by MSH-10 → MSA-2.
Default `false` (FIFO mode).

Out-of-order ACKs from the peer are supported in this mode. MSH-10 is
extracted from the outbound payload before send; MSA-2 is extracted from
the inbound ACK payload. An ACK whose MSA-2 matches no pending send
(and is not in the late-ACK graveyard) emits a frozen
`MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to the `'error'` event.
A late ACK whose MSA-2 matches a graveyard entry emits a
`MLLP_ACK_AFTER_TIMEOUT` warning and is dropped.

###### Default

```ts
false
```

##### deadPeerTimeoutMs?

> `readonly` `optional` **deadPeerTimeoutMs?**: `number`

Application-idle timeout (ms) keyed on last inbound bytes / ACK / warning.
On trip, calls `connection.destroy(new Error('dead
peer timeout'))` which surfaces as `MllpConnectionError({ phase: 'receive' })`.
Trip honors [ClientOptions.autoReconnect](#autoreconnect). Independent of
[ClientOptions.keepaliveIntervalMs](#keepaliveintervalms).

###### Default

```ts
undefined (off)
```

##### drainTimeoutMs?

> `readonly` `optional` **drainTimeoutMs?**: `number`

Bound on the acknowledgement wait [MllpClient.close](#close-1) performs (default: `30_000`
ms). Sends already written to the transport are awaited until it elapses; the wait ends
early the moment the last of them is answered.

##### framing?

> `readonly` `optional` **framing?**: `Omit`\<[`FrameReaderOptions`](#framereaderoptions), `"onFrame"` \| `"onWarning"`\>

FrameReader tolerance / size options. `onFrame` and `onWarning` are managed internally.

##### highWaterMark?

> `readonly` `optional` **highWaterMark?**: `HighWaterMark`

Application-level high-water mark on the in-flight + queued send set.
`number` configures a count cap (default 64);
`{ bytes }` configures a byte cap; `{ count, bytes }` configures
both, with the stricter-of-two trigger winning.

When the cap is exceeded, behavior is governed by
[ClientOptions.onBackpressure](#onbackpressure).

###### Default

```ts
64
```

##### host

> `readonly` **host**: `string`

Host to connect to (e.g. `'localhost'` or `'mllp.example.com'`).

##### initialDelayMs?

> `readonly` `optional` **initialDelayMs?**: `number`

First delay (ms) on auto-reconnect; default 100.

##### jitter?

> `readonly` `optional` **jitter?**: `number`

Jitter fraction, e.g. 0.2 = ±20%; default 0.2.

##### keepaliveIntervalMs?

> `readonly` `optional` **keepaliveIntervalMs?**: `number`

TCP keepalive interval (ms). Sets `socket.setKeepAlive(true, ms)` on
the underlying `net.Socket` BEFORE wrapping in `NetTransport`. OS-level
half-open detection (network partitions, NAT-table eviction). Independent
of [ClientOptions.deadPeerTimeoutMs](#deadpeertimeoutms).

###### Default

```ts
undefined (off)
```

##### maxDelayMs?

> `readonly` `optional` **maxDelayMs?**: `number`

Maximum backoff cap (ms); default 30_000.

##### multiplier?

> `readonly` `optional` **multiplier?**: `number`

Backoff multiplier; default 2.

##### noDelay?

> `readonly` `optional` **noDelay?**: `boolean`

Whether to turn off Nagle's algorithm (`socket.setNoDelay(noDelay)`) on each connection,
the first and every reconnect. With it on (`false` here), a frame written while an earlier
one is still unacknowledged at the TCP level waits for that acknowledgment, which Linux
delays by up to about 40 ms. Set `false` only to restore the operating system's default.

###### Default

```ts
true
```

##### onBackpressure?

> `readonly` `optional` **onBackpressure?**: `"reject"` \| `"wait"`

Behavior when the high-water mark is exceeded.

- `'reject'` (default), `send()` rejects with `MllpBackpressureError`.
- `'wait'`, `send()` awaits the `'drain'` event OR the per-message
  `ackTimeoutMs` OR `signal` abort, whichever fires first.

###### Default

```ts
'reject'
```

##### pipeline?

> `readonly` `optional` **pipeline?**: `boolean`

Strict serialization send → await-ACK → send.

- `true` (default), concurrent in-flight sends up to
  [ClientOptions.highWaterMark](#highwatermark-1).
- `false`, collapses the in-flight set to ≤1 (the unified Correlator's
  `maxInFlight=1`); the next `send()` waits for the prior ACK before
  reaching the wire.

###### Default

```ts
true
```

##### port

> `readonly` **port**: `number`

TCP port.

##### retryStrategy?

> `readonly` `optional` **retryStrategy?**: [`RetryStrategy`](#retrystrategy-2)

Custom reconnect-backoff hook. Return `null` to halt
reconnection. Receives a frozen [RetryContext](#retrycontext). Defaults
to the exponential strategy.

##### tls?

> `readonly` `optional` **tls?**: `true` \| [`TlsOptions`](#tlsoptions)

Enable TLS (MLLPS) for this connection. `true` enables TLS with
all defaults, including certificate verification **on**. Pass a
[TlsOptions](#tlsoptions) object to customize (`ca`/`cert`/`key`, minimum
version, ciphers, `allowUnverified`, …).

Spec anchor: IHE ATNA ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).

###### Default

```ts
undefined (plaintext TCP)
```

***

### ClientStats

Observability snapshot returned by [MllpClient.getStats](#getstats-1).

All fields are JSON-serializable, no Buffers, no class instances,
no Maps, no circular references. `lastConnectedAt` and `lastAckAt` are
**epoch milliseconds** (numbers), NOT `Date` instances, log-pipeline
friendly.

`warningsByCode` keys are constrained to the public [WarningCode](#warningcode)
union, adding/removing a code is a breaking change (CLAUDE.md
stable-codes guardrail enforced at the type boundary).

#### Example

```typescript
const stats = client.getStats();
logger.info(JSON.stringify(stats));
// {"state":"CONNECTED","connectionId":"…","queueDepth":0, … }
```

#### Properties

##### ackedTotal

> `readonly` **ackedTotal**: `number`

Total ACKs matched + resolved since construction.

##### connectionId

> `readonly` **connectionId**: `string` \| `null`

Live Connection's id, or `null` before the first connect (or post-CLOSED).

##### inFlight

> `readonly` **inFlight**: `number`

Entries with `sentAt !== null`, actually written to the wire / awaiting ACK.

##### lastAckAt

> `readonly` **lastAckAt**: `number` \| `null`

Epoch ms of the most recent successful ACK. `null` until first ACK.

##### lastConnectedAt

> `readonly` **lastConnectedAt**: `number` \| `null`

Epoch ms of the last `CONNECTED` transition. `null` until first connect.

##### queueBytes

> `readonly` **queueBytes**: `number`

Sum of `frame.length` across live correlator entries.

##### queueDepth

> `readonly` **queueDepth**: `number`

Total live correlator entries (in-flight + pre-flush + serialization-queued).

##### reconnectAttempts

> `readonly` **reconnectAttempts**: `number`

Total reconnect attempts since construction.

##### sentTotal

> `readonly` **sentTotal**: `number`

Total successful `connection.send()` calls since construction.

##### state

> `readonly` **state**: [`ConnectionState`](#connectionstate-1)

Current FSM state, mirrors `client.state`.

##### timedOutTotal

> `readonly` **timedOutTotal**: `number`

Total ACK timeouts since construction.

##### tls

> `readonly` **tls**: `boolean`

Whether this client is configured for TLS. Mirrors `ClientOptions.tls` being set.

##### totalBytesIn

> `readonly` **totalBytesIn**: `number`

Bytes received from the peer (current Connection).

##### totalBytesOut

> `readonly` **totalBytesOut**: `number`

Bytes written to the peer (current Connection).

##### warningsByCode

> `readonly` **warningsByCode**: `Partial`\<`Record`\<[`WarningCode`](#warningcode), `number`\>\>

Aggregated warning counts. Keys are constrained to the public
[WarningCode](#warningcode) union. Connection-level warnings + Correlator
`MLLP_ACK_*` warnings are merged.

***

### CommitAckReport

Per-send report that the peer has **committed** a message but has not yet said what its
application did with it, handed to the `onCommitAck` callback of the `send()` that drew
it.

It is scoped to one caller's own send, and it arrives at a point where that send has not
settled: `send()` is still pending and will resolve on the application acknowledgement,
or reject if none arrives. That scoping is the point. The commit disposition belongs to
one send, and a caller learns which send it belongs to by being the one that made it,
never by anything being logged.

#### Example

```typescript
const ack = await client.send(payload, {
  onCommitAck: ({ code }) => logger.info({ commit: code }), // 'CA': the peer has custody
});
```

#### Properties

##### code

> `readonly` **code**: `"CA"`

The accept-mode Table 0008 code received. Always the positive `CA`.

##### latencyMs

> `readonly` **latencyMs**: `number`

Milliseconds between the send's write-flush and this acknowledgement.

##### payload

> `readonly` **payload**: `Buffer`

The accept acknowledgement's own payload bytes, framing stripped.

***

### ConnectionOptions

Options for constructing a [Connection](#connection).

#### Example

```typescript
const opts: ConnectionOptions = {
  transport: new NetTransport(socket),
  onMessage: (payload) => handleMessage(payload),
  onWarning: (w) => logger.warn(w),
  drainTimeoutMs: 10_000,
};
```

#### Properties

##### drainTimeoutMs?

> `optional` **drainTimeoutMs?**: `number`

Drain timeout used by close() (default: 30_000 ms).

##### framing?

> `optional` **framing?**: `Omit`\<[`FrameReaderOptions`](#framereaderoptions), `"onFrame"` \| `"onWarning"`\>

FrameReader options (tolerance, maxFrameSizeBytes). onFrame/onWarning are managed internally.

##### onMessage?

> `optional` **onMessage?**: (`payload`) => `void`

Called for each decoded MLLP frame (raw payload bytes, framing stripped).

###### Parameters

###### payload

`Buffer`

###### Returns

`void`

##### onWarning?

> `optional` **onWarning?**: (`w`) => `void`

Per-connection warning subscriber. Replaces previous subscription.

###### Parameters

###### w

[`MllpWarning`](#mllpwarning)

###### Returns

`void`

##### transport

> **transport**: [`Transport`](#transport-1)

The transport this Connection will drive.

***

### ConnectionRejectedEvent

Payload of the server `'connectionRejected'` event: a connection was closed at accept and never
reached the server's handler.

Emitted when a connection arrives while the server already holds
[ServerOptions.maxConnections](#maxconnections-1) sockets. The socket is closed before any byte is read from
it and before any TLS handshake, so the rejected peer never becomes a `Connection`, never fires
`'connection'` and never reaches `onMessage`. The peer sees its connection close; a client that
reconnects will try again.

**PHI-safe by construction:** a stable code, a fixed message, the configured cap and the peer's
address and port (the routing metadata the `'connection'` event already carries), never a byte
of payload. The object is `Object.freeze()`'d before emission.

#### Example

```typescript
server.on('connectionRejected', ({ code, remoteAddress }) => {
  logger.warn({ code, remoteAddress });
});
```

#### Properties

##### code

> `readonly` **code**: `"MLLP_CONNECTION_LIMIT_REACHED"`

Why the connection was closed.

##### maxConnections

> `readonly` **maxConnections**: `number`

The configured [ServerOptions.maxConnections](#maxconnections-1).

##### message

> `readonly` **message**: `string`

Fixed text for `code`. Never interpolated.

##### remoteAddress

> `readonly` **remoteAddress**: `string` \| `null`

The rejected peer's address, or `null` if it could not be read.

##### remotePort

> `readonly` **remotePort**: `number` \| `null`

The rejected peer's port, or `null` if it could not be read.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### ConnectionStats

Return type of `connection.getStats()`, JSON-serializable.

All timestamps are `Date | null` (not epoch milliseconds). `JSON.stringify()`
serialises them to ISO 8601 strings by default with no information loss.

#### Example

```typescript
const stats = conn.getStats();
logger.info(JSON.stringify(stats)); // safe: all values are JSON-serializable
```

#### Properties

##### bytesIn

> `readonly` **bytesIn**: `number`

##### bytesOut

> `readonly` **bytesOut**: `number`

##### connectedAt

> `readonly` **connectedAt**: `Date` \| `null`

##### connectionId

> `readonly` **connectionId**: `string`

##### lastByteInAt

> `readonly` **lastByteInAt**: `Date` \| `null`

##### lastByteOutAt

> `readonly` **lastByteOutAt**: `Date` \| `null`

##### remoteAddress

> `readonly` **remoteAddress**: `string` \| `null`

##### remotePort

> `readonly` **remotePort**: `number` \| `null`

##### state

> `readonly` **state**: [`ConnectionState`](#connectionstate-1)

##### warningsByCode

> `readonly` **warningsByCode**: `Record`\<`string`, `number`\>

##### warningsTruncated

> `readonly` **warningsTruncated**: `boolean`

***

### DifferentialDeviation

One named deviation, located by offset.

#### Example

```typescript
const deviation: DifferentialDeviation = { code: 'MLLP_MISSING_LEADING_VT', byteOffset: 0 };
```

#### Properties

##### byteOffset

> `readonly` **byteOffset**: `number`

Byte offset within the peer's response stream where it was detected.

##### code

> `readonly` **code**: [`WarningCode`](#warningcode)

The package's stable warning code for this deviation.

***

### DifferentialExchangeReport

What one canonical exchange produced.

#### Example

```typescript
for (const exchange of report.exchanges) {
  console.log(exchange.exchangeId, exchange.outcome, exchange.byteParity);
}
```

#### Properties

##### byteParity

> `readonly` **byteParity**: [`DifferentialParityOutcome`](#differentialparityoutcome)

Whether the response frame matched the canonical Release 1 block byte for byte.

##### correlation

> `readonly` **correlation**: [`DifferentialCorrelationOutcome`](#differentialcorrelationoutcome)

Whether the response echoed the control ID of the message that was sent.

##### deadlineMs

> `readonly` **deadlineMs**: `number`

The response deadline this exchange waited, in milliseconds.

##### deviations

> `readonly` **deviations**: readonly [`DifferentialDeviation`](#differentialdeviation)[]

The same deviations with the byte offset each was detected at.

##### elapsedMs

> `readonly` **elapsedMs**: `number`

How long the exchange actually took, in milliseconds.

##### exchangeId

> `readonly` **exchangeId**: `string`

The corpus identifier of the message that was sent. Names a message, never a patient.

##### outcome

> `readonly` **outcome**: [`DifferentialExchangeOutcome`](#differentialexchangeoutcome)

What became of the exchange.

##### requestByteCount

> `readonly` **requestByteCount**: `number`

How many bytes were sent to the peer, framing included. A count, never content.

##### responseByteCount

> `readonly` **responseByteCount**: `number`

How many bytes were read back before the exchange concluded. A count, never content.

##### warningCodes

> `readonly` **warningCodes**: readonly [`WarningCode`](#warningcode)[]

Every stable warning code observed on this exchange, in the order they were seen.

***

### DifferentialPeer

A resolved peer endpoint: where the harness opens its connections.

#### Example

```typescript
const peer: DifferentialPeer = { host: '127.0.0.1', port: 2575 };
```

#### Properties

##### host

> `readonly` **host**: `string`

Host name or address literal, with any IPv6 brackets already removed.

##### port

> `readonly` **port**: `number`

TCP port, an integer in 1..65535.

***

### DifferentialReport

The report a run returns. Frozen, and JSON-serializable throughout.

#### Example

```typescript
const report = await runDifferential({ peer: '127.0.0.1:2575' });
console.log(JSON.stringify(report, null, 2));
```

#### Properties

##### deadlineMs

> `readonly` **deadlineMs**: `number`

The per-exchange response deadline the run used, in milliseconds.

##### exchanges

> `readonly` **exchanges**: readonly [`DifferentialExchangeReport`](#differentialexchangereport)[]

One entry per canonical exchange attempted, in the order they ran.

##### exchangesAnswered

> `readonly` **exchangesAnswered**: `number`

How many of them the peer answered with a decodable frame.

##### exchangesAttempted

> `readonly` **exchangesAttempted**: `number`

How many exchanges were attempted.

##### finishedAt

> `readonly` **finishedAt**: `string`

When the run finished, as an ISO 8601 string.

##### peer

> `readonly` **peer**: [`DifferentialReportPeer`](#differentialreportpeer-1) \| `undefined`

The peer that was contacted, or `undefined` when the run was skipped.

##### result

> `readonly` **result**: [`DifferentialRunResult`](#differentialrunresult)

What the run as a whole observed. Never a conformance verdict.

##### skipReason

> `readonly` **skipReason**: `"no-peer-configured"` \| `undefined`

Why the run was skipped, or `undefined` when it ran.

##### startedAt

> `readonly` **startedAt**: `string`

When the run started, as an ISO 8601 string.

***

### DifferentialReportPeer

The peer a report describes. Host and port as configured, nothing resolved or probed.

#### Example

```typescript
const peer: DifferentialReportPeer = { host: '127.0.0.1', port: 2575 };
```

#### Properties

##### host

> `readonly` **host**: `string`

Host name or address literal the run connected to.

##### port

> `readonly` **port**: `number`

TCP port the run connected to.

***

### DifferentialRunOptions

Options for [runDifferential](#rundifferential).

#### Example

```typescript
const report = await runDifferential({ peer: '127.0.0.1:2575', deadlineMs: 5_000 });
```

#### Properties

##### connect?

> `readonly` `optional` **connect?**: [`DifferentialConnect`](#differentialconnect)

How to open each connection. Defaults to a plain TCP socket.

##### deadlineMs?

> `readonly` `optional` **deadlineMs?**: `number`

Per-exchange response deadline in milliseconds. Default 10000.

##### exchanges?

> `readonly` `optional` **exchanges?**: readonly [`CanonicalExchange`](#canonicalexchange)[]

The exchanges to run. Defaults to the shipped canonical corpus.

##### maxFrameSizeBytes?

> `readonly` `optional` **maxFrameSizeBytes?**: `number`

Largest response payload the decoder will accumulate before it refuses, in bytes.
Defaults to the package's own 16 MiB frame cap. A peer that exceeds it is reported as
a deviation named by the oversize warning code, not as an unhandled error.

##### peer?

> `readonly` `optional` **peer?**: `string`

The peer to run against, as `host:port`. Absent or empty means no peer is configured,
and the run skips cleanly. A value that is present and cannot be resolved into a host
and a port is refused by name instead, because a silent skip there would read as
proof the harness ran.

##### signal?

> `readonly` `optional` **signal?**: `AbortSignal`

Aborts the run. The rejection carries the signal's own reason.

***

### EncoderOptions

Options for [encodeFrame](#encodeframe).

#### Example

```typescript
const frame = encodeFrame(payload, {
  allowDelimiterBytesInPayload: true,
  onWarning: (w) => logger.warn(w),
});
```

#### Properties

##### allowDelimiterBytesInPayload?

> `optional` **allowDelimiterBytesInPayload?**: `boolean`

When `true`, VT (0x0B) or FS (0x1C) bytes within the payload are preserved
verbatim in the output frame instead of throwing `MllpFramingError`.
An `MllpWarning` is emitted per offending byte if `onWarning` is provided.

Default: `false` (strict, throws on delimiter bytes).

##### onWarning?

> `optional` **onWarning?**: (`w`) => `void`

Called for each offending delimiter byte when `allowDelimiterBytesInPayload` is `true`.
Invocation is wrapped in try/catch, a throwing handler does not interrupt encoding.

###### Parameters

###### w

[`MllpWarning`](#mllpwarning)

###### Returns

`void`

###### Example

```typescript
const frame = encodeFrame(payload, {
  allowDelimiterBytesInPayload: true,
  onWarning: (w) => logger.warn({ code: w.code, offset: w.byteOffset }),
});
```

***

### FrameReaderOptions

Options for `FrameReader`.

All tolerance opts default to `false`, every framing deviation throws unless
explicitly enabled. Server-level defaults (allowFsOnly, allowLfAfterFs, allowLeadingWhitespace)
are applied by the server when constructing readers.

#### Example

```typescript
const opts: FrameReaderOptions = {
  onFrame: (payload, byteOffset, warnings) => process(payload, byteOffset, warnings),
  onWarning: (w) => logger.warn(w),
  maxFrameSizeBytes: 4 * 1024 * 1024, // 4 MiB limit
  allowFsOnly: true,
  allowLfAfterFs: true,
};
```

#### Properties

##### allowFsOnly?

> `optional` **allowFsOnly?**: `boolean`

Tolerate FS without trailing CR; emits `MLLP_FS_WITHOUT_CR`.

##### allowLeadingWhitespace?

> `optional` **allowLeadingWhitespace?**: `boolean`

Tolerate SP/TAB/LF/CR before VT; emits `MLLP_LEADING_WHITESPACE`.

##### allowLfAfterFs?

> `optional` **allowLfAfterFs?**: `boolean`

Tolerate FS+LF instead of FS+CR; emits `MLLP_LF_AFTER_FS`.

##### allowMissingLeadingVt?

> `optional` **allowMissingLeadingVt?**: `boolean`

Tolerate missing leading VT; emits `MLLP_MISSING_LEADING_VT`.

##### maxFrameSizeBytes?

> `optional` **maxFrameSizeBytes?**: `number`

Maximum accumulated payload bytes before `MllpFramingError('MLLP_FRAME_TOO_LARGE')`.
Default: 16 MiB (DoS prevention).

##### onFrame

> **onFrame**: (`payload`, `byteOffset`, `warnings`) => `void`

Called synchronously during `push()` for each complete MLLP payload.

###### Parameters

###### payload

`Buffer`

Raw MLLP payload bytes (framing stripped).

###### byteOffset

`number`

Stream byte offset of the VT byte that opened this frame.
  Monotonic across the connection lifetime; reset to 0 by `reset()`.

###### warnings

readonly [`MllpWarning`](#mllpwarning)[]

Framing warnings emitted during decoding of this specific frame.
  Empty array when no tolerance deviations were detected.

###### Returns

`void`

##### onWarning?

> `optional` **onWarning?**: (`w`) => `void`

Called for each tolerated framing deviation. Wrapped in try/catch.
A throwing handler will not corrupt FSM state.

###### Parameters

###### w

[`MllpWarning`](#mllpwarning)

###### Returns

`void`

##### strict?

> `optional` **strict?**: `boolean`

When `true`, escalates the following tolerances to thrown `MllpFramingError`
even if individual opt-ins (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`,
`allowLeadingWhitespace`) are enabled:
- `MLLP_MISSING_LEADING_VT`
- `MLLP_FS_WITHOUT_CR`
- `MLLP_LF_AFTER_FS`
- `MLLP_LEADING_WHITESPACE` (leading whitespace escalates as `MLLP_MISSING_LEADING_VT`)

`MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` remain warnings even in strict mode.

###### Example

```typescript
// Hardened enforcement, no tolerance, all violations throw
const reader = new FrameReader({ onFrame: fn, strict: true });
```

***

### MessageMeta

Metadata attached to each decoded MLLP message.

All fields are `readonly`, the object is `Object.freeze()`'d before emission.

#### Example

```typescript
server.on('message', ({ payload, meta }) => {
  console.log(meta.connectionId, '@', meta.byteOffset, 'warnings:', meta.warnings.length);
});
```

#### Properties

##### byteOffset

> `readonly` **byteOffset**: `number`

Byte offset of the frame start in the connection's data stream.

##### connectionId

> `readonly` **connectionId**: `string`

Stable UUID identifying the connection that delivered this message.

##### warnings

> `readonly` **warnings**: readonly [`MllpWarning`](#mllpwarning)[]

Framing warnings emitted during decoding of this frame.

***

### MllpWarning

A frozen warning object emitted when the decoder tolerates a framing deviation.

`connectionId` is `undefined` when emitted by a standalone `FrameReader`.
`Connection` enriches it to the real UUIDv4 before forwarding upstream.

#### Example

```typescript
const reader = new FrameReader({
  onFrame: (p) => process(p),
  onWarning: (w: MllpWarning) => logger.warn(w),
  allowFsOnly: true,
});
```

#### Extended by

- [`AckCorrelationWarning`](#ackcorrelationwarning)

#### Properties

##### byteOffset

> `readonly` **byteOffset**: `number`

Absolute stream byte offset where the anomaly was detected.

##### code

> `readonly` **code**: [`WarningCode`](#warningcode)

##### connectionId

> `readonly` **connectionId**: `string` \| `undefined`

Connection identifier. `undefined` at the framing layer;
enriched by `Connection` before emitting upstream.

##### message

> `readonly` **message**: `string`

Stable human-readable description. It carries structural facts (a byte
offset, an accumulated size) and **never a run of payload content**.

Two codes carry exactly one input byte, and it is worth knowing which:
`MLLP_MISSING_LEADING_VT` and `MLLP_FS_WITHOUT_CR` render the hex of the
single byte found where a framing byte was expected, and on a stream that
omits its leading `VT` that byte is the first byte of the unframed content.
One byte, never a run, the same bound `MllpFramingError.snippet` carries. If
that is more than your threat model allows, log `code` and `byteOffset`
rather than `message`.

The ACK-correlation codes are stricter: their text comes from a frozen
registry and does not vary with the wire at all.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### NackEvent

Payload of the server `'nack'` event, emitted whenever the server responds with a
**negative** acknowledgement instead of `AA` on the auto-ACK path (the fail-safe commit
contract). This fires both when a commit-gated `autoAck: 'AA'` handler throws/rejects and
when the server **downgrades** a positive auto-ACK because the inbound could not be
correlated ([NackReason](#nackreason)).

**PHI-safe by construction:** carries only the connection ID, the resolved
acknowledgement code, and a static `reason`, never the payload, the inbound control ID,
or the thrown error's message (which may carry PHI). The object is `Object.freeze()`'d
before emission.

#### Example

```typescript
server.on('nack', ({ connectionId, ackCode, reason }) => {
  metrics.increment('mllp.nack', { code: ackCode, reason }); // e.g. reason='discarded-bytes'
});
```

#### Properties

##### ackCode

> `readonly` **ackCode**: [`NackAckCode`](#nackackcode)

The negative acknowledgement code actually sent to the peer.

`AE` or `AR` for a message acknowledged in the original mode, and the accept-mode
counterparts `CE` or `CR` where the inbound MSH-15 asked for an accept acknowledgement
for this disposition. It is always the code that went on the wire, so an observer
counting negative acknowledgements sees what the peer saw.

##### connectionId

> `readonly` **connectionId**: `string`

Connection that produced the negative acknowledgement.

##### reason

> `readonly` **reason**: [`NackReason`](#nackreason)

Why the negative acknowledgement was sent (PHI-free).

***

### NegotiatedTlsParameters

Frozen payload of the `'tlsNegotiated'` event, emitted by both
[MllpClient](#mllpclient) and [MllpServer](#mllpserver) once per completed TLS handshake,
including every reconnect. Never emitted on a plaintext connection.

Carries no HL7 payload content and no certificate or key material: only the
two negotiated names and the same routing metadata a `SecurityWarning`
carries. It is emitted at handshake-completion time, before any HL7 byte has
crossed the link.

#### Example

```typescript
server.on('tlsNegotiated', (p: NegotiatedTlsParameters) => {
  if (p.protocolVersion !== 'TLSv1.3') metrics.increment('mllp.tls12_link');
});
```

#### Properties

##### cipherSuite

> `readonly` **cipherSuite**: `string`

Negotiated cipher suite in its **IANA** spelling, e.g.
`'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256'`. That is the spelling the IHE
and IETF documents print, so it can be compared with a conformance claim
directly. The OpenSSL spelling, which is what a `ciphers` list is written
in, is a different rendering of the same suite.

##### host

> `readonly` **host**: `string`

Host associated with the link (the target host for clients; the bind host for servers).

##### port

> `readonly` **port**: `number`

Port associated with the link.

##### protocolVersion

> `readonly` **protocolVersion**: `string`

Negotiated protocol version as the TLS library reports it, e.g.
`'TLSv1.2'` or `'TLSv1.3'`.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### ReconnectingEvent

Payload for the 'reconnecting' event. Always `Object.freeze`'d.

`attempt` and `delayMs` are populated by `MllpClient` when it schedules a
reconnect. A `Connection` emitting on its own supplies `connectionId` only.

#### Example

```typescript
conn.on('reconnecting', ({ connectionId }) => {
  logger.info(`Reconnecting connection ${connectionId}`);
});
```

#### Properties

##### attempt?

> `readonly` `optional` **attempt?**: `number`

##### connectionId

> `readonly` **connectionId**: `string`

##### delayMs?

> `readonly` `optional` **delayMs?**: `number`

***

### ResolvedTlsCipherPolicy

The TLS-context fields the resolved policy contributes. Empty when the
option is off and no `ciphers` passthrough is set: this package then imposes
no cipher list at all, exactly as before the option existed.

#### Properties

##### ciphers?

> `readonly` `optional` **ciphers?**: `string`

OpenSSL cipher-list string, or absent to impose none.

##### dhparam?

> `readonly` `optional` **dhparam?**: `string` \| `Buffer`\<`ArrayBufferLike`\>

Ephemeral Diffie-Hellman parameters, server-side only. Two of the four
named suites are DHE, and a server with no DH parameters cannot offer a
DHE suite at all: without this it would advertise the list and then fail
every DHE handshake in it.

Exactly two things reach this field. The literal `'auto'` is the TLS
library's own spelling for the selection it makes from the certificate in
use, which is what `atnaTransportSecurity: true` alone yields. Anything
else is PEM content: the caller's own group, taken verbatim from
`ServerTlsOptions.dhParameters` and preferred over the automatic selection.
Absent when neither was asked for, so the not-selected path is untouched.

Typed `string | Buffer` rather than `'auto' | string | Buffer` because the
literal is absorbed by `string` in a union and says nothing to a reader
there; it is stated here instead.

***

### RetryContext

Context passed to a custom `retryStrategy` hook on each reconnect attempt.

Frozen via `Object.freeze` before invocation, handlers cannot mutate.

#### Example

```typescript
const retryStrategy: RetryStrategy = (ctx) => {
  if (ctx.attempt >= 5) return null;
  if (ctx.classifiedAs === 'permanent') return null;
  return Math.min(30_000, 1000 * (ctx.attempt + 1));
};
```

#### Properties

##### attempt

> `readonly` **attempt**: `number`

0-indexed attempt counter for the current reconnect cycle.

##### classifiedAs

> `readonly` **classifiedAs**: `"transient"` \| `"permanent"`

How the failure that triggered this reconnect attempt was classified.

##### lastDelayMs

> `readonly` **lastDelayMs**: `number`

Delay used for the previous attempt (ms). 0 on the first attempt.

##### lastError

> `readonly` **lastError**: `Error`

The error that triggered the disconnect.

##### signal

> `readonly` **signal**: `AbortSignal`

The same `AbortSignal` passed into `connect()`. If no signal was
supplied, the module-level `NEVER_ABORTING_SIGNAL` sentinel is provided
so handlers always have a real `AbortSignal` to inspect.

##### sinceLastSuccessMs

> `readonly` **sinceLastSuccessMs**: `number`

Ms since the last successful ACK. `Infinity` if no success seen.

##### totalElapsedMs

> `readonly` **totalElapsedMs**: `number`

Total wall-clock ms elapsed since the disconnect that started this cycle.

***

### SecurityWarning

Frozen payload of the `'securityWarning'` event, emitted by both
[MllpClient](#mllpclient) (`MLLP_TLS_VERIFY_DISABLED`) and [MllpServer](#mllpserver)
(`MLLP_BIND_ALL_INTERFACES`).

Never carries payload bytes or PHI, only routing metadata (host/port) and
a fixed, static message string.

#### Example

```typescript
client.on('securityWarning', (w: SecurityWarning) => {
  logger.warn({ code: w.code, host: w.host, port: w.port });
});
```

#### Properties

##### code

> `readonly` **code**: [`SecurityWarningCode`](#securitywarningcode-1)

The stable security-warning code.

##### host

> `readonly` **host**: `string`

Host associated with the warning (the target host for clients; the bind host for servers).

##### message

> `readonly` **message**: `string`

Fixed, human-readable description. Never contains payload bytes or PHI.

##### port

> `readonly` **port**: `number`

Port associated with the warning.

##### timestamp

> `readonly` **timestamp**: `Date`

Wall-clock time at point of emission.

***

### ServerOptions

Options for `createServer()`.

#### Example

```typescript
const opts: ServerOptions = {
  onMessage: (payload, meta, conn) => {
    const ack = buildAck(payload);
    conn.send(ack);
  },
  framing: { maxFrameSizeBytes: 4 * 1024 * 1024 },
  keepaliveIntervalMs: 60_000,
  deadPeerTimeoutMs: 300_000,
  drainTimeoutMs: 30_000,
};
```

#### Extended by

- [`StarterServerOptions`](#starterserveroptions)

#### Properties

##### allowWildcardBind?

> `optional` **allowWildcardBind?**: `boolean`

Opt-in required to bind a wildcard host, a bind-safety guardrail.
Without this flag, `listen()` rejects a wildcard host in
two tiers: **literal spellings** (`'0.0.0.0'`, `'::'`, `''`, `'::0'`,
`'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`, …) reject **pre-bind** (fast
path, nothing is ever bound); **resolver-only shorthands** (`'0'`,
`'0.0'`, `'0x0.0.0.0'`, hostnames resolving to the unspecified
address, …) are caught **post-bind** against the OS-normalized bound
address, the just-bound server closes before any connection can be
accepted and `listen()` rejects, with no listening state and no
`'listening'` event either way. When `true`, binding a wildcard host
emits a one-time `'securityWarning'` (`MLLP_BIND_ALL_INTERFACES`) at
listen time.

###### Default

```ts
false
```

##### autoAck?

> `optional` **autoAck?**: `"AA"` \| ((`payload`, `meta`, `conn`) => `Buffer`\<`ArrayBufferLike`\> \| `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>)

Auto-ACK mode. When set, the server builds and sends the ACK for each message.

- **`'AA'`**, auto-acknowledge with the fail-safe **commit contract**:
  - **With an `onMessage` handler ⇒ commit-gated (recommended).** The server awaits
    `onMessage` (the durable-commit step), then sends `AA` on success or a **negative**
    ACK on failure (`AE` by default; `AR` via [MllpAckError](#mllpackerror)). The positive ACK
    **cannot precede a successful commit**, a handler throw can never yield `AA`.
  - **Without an `onMessage` handler ⇒ transport-accept.** `AA` is sent on frame
    receipt. This `AA` means only **"bytes received and framed"**, *not*
    "application-processed". ⚠️ For clinical messages this is unsafe on its own:
    pair `'AA'` with an `onMessage` handler that durably commits, so the ACK reflects
    real processing.
- **`fn`**, `fn(payload, meta, conn)` builds the ACK bytes the server sends; the
  caller fully owns MSA-1 (e.g. to emit enhanced-mode `CA`/`CE`/`CR`).

The `'message'` event always fires BEFORE the ACK is sent. Do NOT call
`conn.send()` in `onMessage` when `autoAck` is set, this results in two ACKs.

##### deadPeerTimeoutMs?

> `optional` **deadPeerTimeoutMs?**: `number`

Application-level idle close timeout in ms.
If no HL7 messages are received on a connection for this interval, the connection
is destroyed via `conn.destroy(new Error('idle timeout'))`.
Resets on every `'message'` event. Distinct from `keepaliveIntervalMs` (OS TCP probe).

##### drainTimeoutMs?

> `optional` **drainTimeoutMs?**: `number`

Graceful drain timeout passed to `conn.close()` during `server.close()`.
Default: 30 000 ms.

##### framing?

> `optional` **framing?**: `Omit`\<[`FrameReaderOptions`](#framereaderoptions), `"onFrame"` \| `"onWarning"`\>

FrameReader tolerance options applied to every accepted connection.
Merged with SERVER_DEFAULT_FRAMING, caller-supplied values override defaults.
`onFrame` and `onWarning` are managed internally and must not be supplied here.

##### keepaliveIntervalMs?

> `optional` **keepaliveIntervalMs?**: `number`

TCP keepalive probe interval in ms.
Calls `socket.setKeepAlive(true, ms)` on each accepted socket.
Uses OS TCP stack to detect dead peers (half-open, network partitions).
Distinct from `deadPeerTimeoutMs` (application-level idle close).

##### maxConnections?

> `optional` **maxConnections?**: `number`

The most connections this server holds at once. A connection that arrives while the server
already holds this many is closed at accept: it never reaches `onMessage` or the
`'connection'` event, and the server emits `'connectionRejected'`
([ConnectionRejectedEvent](#connectionrejectedevent), code `MLLP_CONNECTION_LIMIT_REACHED`) instead.

The count is of open sockets, the number that bounds file descriptors: it includes a TLS
handshake still in progress, and a connection counts until its socket has fully closed. An
over-cap TLS connection is closed before its handshake, so it costs no handshake work and is
not a `'tlsClientError'`.

The server counts its connections itself rather than handing the cap to the runtime's
listener, so the cap and `'connectionRejected'` hold the same on Node.js, Bun and Deno (Deno's
own listener cap closed the connection and reported nothing).

Must be a positive integer; anything else throws a `RangeError` at construction. Unset means
no cap.

###### Default

```ts
undefined (no cap)
```

##### noDelay?

> `optional` **noDelay?**: `boolean`

Whether to turn off Nagle's algorithm (`socket.setNoDelay(noDelay)`) on each accepted
socket. With it on (`false` here), an ACK written while an earlier one is still
unacknowledged at the TCP level waits for that acknowledgment, which Linux delays by up to
about 40 ms. Set `false` only to restore the operating system's default.

###### Default

```ts
true
```

##### onMessage?

> `optional` **onMessage?**: (`payload`, `meta`, `conn`) => `void` \| `Promise`\<`void`\>

Called for each decoded MLLP message.

Its role depends on `autoAck`, this is the **commit contract** (HL7 v2.5.1 §2.9.2):

- **`autoAck: 'AA'` + this handler ⇒ commit-gated (the safe default).** The handler
  is the durable-commit step. The server **awaits** it and only then sends the ACK:
  resolve ⇒ `AA`; **throw/reject ⇒ `AE`** (or `AR` via [MllpAckError](#mllpackerror)), a
  positive ACK can never precede a successful commit. Do **not** call `conn.send()`
  here in this mode.
- **`autoAck` unset ⇒ manual mode.** The handler owns the response; build and send the
  ACK yourself via `conn.send(encodeFrame(ackPayload))`. Its return value is ignored.
- **`autoAck: fn` ⇒ observation only.** `fn` builds the ACK; this handler runs first as
  a side effect and its return value is ignored. Do not call `conn.send()` here.

May be sync or async; an async handler is awaited in commit-gated mode.

###### Parameters

###### payload

`Buffer`

###### meta

[`MessageMeta`](#messagemeta)

###### conn

[`Connection`](#connection)

###### Returns

`void` \| `Promise`\<`void`\>

##### onWarning?

> `optional` **onWarning?**: (`w`) => `void`

Per-connection warning subscriber. Called for every framing warning on every connection.

###### Parameters

###### w

[`MllpWarning`](#mllpwarning)

###### Returns

`void`

##### tls?

> `optional` **tls?**: [`ServerTlsOptions`](#servertlsoptions)

Enable TLS (MLLPS) for this server. When set, the server binds a
`tls.Server` instead of a plain `net.Server`, consumes `'secureConnection'`
(post-handshake sockets) instead of `'connection'`, and surfaces failed
handshakes via the `'tlsClientError'` event rather than crashing.

We set no handshake time limit of our own: the runtime's applies. On Node.js that is its
`handshakeTimeout` default of 120 seconds, after which the socket is closed and
`'tlsClientError'` fires with code `ERR_TLS_HANDSHAKE_TIMEOUT`. Until then a peer that
connects and never completes the handshake holds a [ServerOptions.maxConnections](#maxconnections-1)
place, and `deadPeerTimeoutMs` does not apply, because it starts only once the connection is
accepted after its handshake. We have not measured what bounds a handshake on Bun or Deno,
which may set no limit at all.

Spec anchor: IHE ATNA ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).

###### Default

```ts
undefined (plaintext TCP)
```

***

### ServerStats

Observability snapshot returned by `server.getStats()`.

All fields are JSON-serializable. `connections` and `activeConnections` both
reflect the current live connection count.

#### Example

```typescript
const stats = server.getStats();
console.log(JSON.stringify(stats)); // log-pipeline friendly
```

#### Properties

##### acceptedTotal

> `readonly` **acceptedTotal**: `number`

Total connections accepted since listen() (monotonically increasing).

##### activeConnections

> `readonly` **activeConnections**: `number`

Current live connection count. Same value as `connections`.

##### closedTotal

> `readonly` **closedTotal**: `number`

Total connections closed since listen() (monotonically increasing).

##### connections

> `readonly` **connections**: `number`

Current live connection count.
Same value as `activeConnections`.

##### host

> `readonly` **host**: `string` \| `null`

Bound host, or `null` before listen().

##### listening

> `readonly` **listening**: `boolean`

Whether the server is currently accepting connections.

##### port

> `readonly` **port**: `number` \| `null`

Bound port, or `null` before listen().

##### tls

> `readonly` **tls**: `boolean`

Whether this server is configured for TLS. Mirrors `ServerOptions.tls` being set.

##### tlsClientErrorsTotal

> `readonly` **tlsClientErrorsTotal**: `number`

Total `'tlsClientError'` events (failed TLS handshakes, incl. rejected client certs) since listen().

##### totalBytesIn

> `readonly` **totalBytesIn**: `number`

Aggregate bytes received across all current connections.

##### totalBytesOut

> `readonly` **totalBytesOut**: `number`

Aggregate bytes sent across all current connections.

***

### ServerTlsOptions

Server-side TLS options (`ServerOptions.tls`).

#### Example

```typescript
import { createServer } from '@cosyte/mllp';
const server = createServer({
  tls: { cert: certPem, key: keyPem, clientAuth: 'MUST', ca: clientCaPem },
});
```

#### Properties

##### atnaTransportSecurity?

> `readonly` `optional` **atnaTransportSecurity?**: `boolean`

Offer exactly the cipher suites the IHE ATNA ITI-19 transport-security
option names (ITI TF-2 §3.19.6.2.3), rather than inheriting the runtime's
own list. Off by default; turning it on only ever **narrows** what is
offered.

The server side additionally provides ephemeral Diffie-Hellman parameters,
because two of the four named suites are DHE and a server without them
cannot actually offer a DHE suite. The group is the one the runtime selects
for the certificate in use unless [ServerTlsOptions.dhParameters](#dhparameters)
names another, which takes precedence. See
[TlsOptions.atnaTransportSecurity](#atnatransportsecurity-2) for the rest, including what this
setting does **not** claim on your behalf.

Mutually exclusive with [ServerTlsOptions.ciphers](#ciphers-1): setting both
rejects `listen()` with a typed `MllpTlsConfigurationError`.

**On a runtime that cannot honour it, `listen()` rejects** with a typed
`MllpTlsConfigurationError` carrying `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`,
before anything is bound: under Bun, whose TLS library refuses the automatic
Diffie-Hellman selection (its own error is the `cause`), and under Deno,
whose `node:tls` takes parameters and a cipher list without applying them.
Construction never throws for it. Node.js honours it.

###### Default

```ts
false
```

##### ca?

> `readonly` `optional` **ca?**: [`PemInput`](#peminput)

Trust anchor(s) for verifying client certificates under `WANT`/`MUST`.

##### cert?

> `readonly` `optional` **cert?**: [`PemInput`](#peminput)

Server certificate (PEM). Required with [ServerTlsOptions.key](#key) unless
[ServerTlsOptions.pfx](#pfx) is set: a server given neither pair nor file throws a
`TypeError` at construction.

##### ciphers?

> `readonly` `optional` **ciphers?**: `string`

OpenSSL cipher-list string passthrough. Unset uses Node's defaults
(includes both ATNA-mandated ECDHE suites). For the ATNA option's own four
suites prefer [ServerTlsOptions.atnaTransportSecurity](#atnatransportsecurity).

A list the runtime rejects rejects `listen()` with a typed
`MllpTlsConfigurationError`; it never silently falls back to the default
list. **So does any list on a runtime that does not enforce cipher lists**
(Deno), with `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before anything is bound.
Node.js and Bun enforce a list.

###### Default

```ts
undefined (Node defaults)
```

##### clientAuth?

> `readonly` `optional` **clientAuth?**: [`ClientAuth`](#clientauth-1)

ATNA ITI-19 mutual-authentication mode. `'WANT'` requests a client
certificate without rejecting unauthorized/absent ones (surfaced, not
enforced); `'MUST'` requests AND enforces verification (ATNA mutual
auth). See [ClientAuth](#clientauth-1).

###### Default

```ts
'NONE'
```

##### dhParameters?

> `readonly` `optional` **dhParameters?**: `string` \| `Buffer`\<`ArrayBufferLike`\>

Ephemeral Diffie-Hellman parameters this server answers a DHE key exchange
with, as **PEM content**. There is deliberately no filesystem-path input:
every credential on this type is content, and this package performs no disk
IO for any of it. Generate a group with `openssl dhparam` and read it in
yourself.

A DHE cipher suite is unofferable by a server with no parameters, so this
is what makes one reachable through [ServerTlsOptions.ciphers](#ciphers-1): a
list restricted to a DHE suite without this advertises that suite and then
fails every handshake in it.

**It takes precedence over the group
[ServerTlsOptions.atnaTransportSecurity](#atnatransportsecurity) selects automatically**, and
setting both is not a conflict: the option picks a group when nothing else
says which, and this says which. That is how a deployment whose own policy
names a group puts it in force while still offering exactly the ITI TF-2
§3.19.6.2.3 suites.

Parameters this package or the TLS library cannot use reject `listen()`
with a typed `MllpTlsConfigurationError` carrying
`MLLP_TLS_DH_PARAMETERS_REJECTED`, before anything is bound. Nothing falls
back to a server running without them, which matters because the TLS
library's own behaviour for unreadable parameters is to discard them in
silence. `'auto'` is not accepted here; that selection is what
`atnaTransportSecurity` already makes.

**On a runtime that does not enforce Diffie-Hellman parameters, `listen()`
rejects** with `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`, before anything is
bound, rather than serving without them: under Deno, whose `node:tls` takes
parameters without using them, and under Bun, whose TLS library has no
finite-field Diffie-Hellman (its own refusal is the `cause`). Node.js
enforces them.

There is no counterpart on [TlsOptions](#tlsoptions): the side that answers the
key exchange supplies the parameters.

###### Default

undefined (no Diffie-Hellman parameters unless `atnaTransportSecurity` selects them)

##### key?

> `readonly` `optional` **key?**: [`PemInput`](#peminput)

Private key matching [ServerTlsOptions.cert](#cert). Required with it unless `pfx` is set.

##### maxVersion?

> `readonly` `optional` **maxVersion?**: `"TLSv1.2"` \| `"TLSv1.3"`

Maximum negotiated TLS protocol version.

##### minVersion?

> `readonly` `optional` **minVersion?**: `"TLSv1.2"` \| `"TLSv1.3"`

Minimum negotiated TLS protocol version, the IHE ATNA ITI-19 "TLS 1.2
Floor" (BCP195) floor (ITI TF-2 §3.19.6.2.3).

###### Default

```ts
'TLSv1.2'
```

##### passphrase?

> `readonly` `optional` **passphrase?**: `string`

Passphrase for an encrypted [ServerTlsOptions.key](#key), or for the PKCS#12 file in
[ServerTlsOptions.pfx](#pfx).

##### pfx?

> `readonly` `optional` **pfx?**: `Buffer`\<`ArrayBufferLike`\>

The server certificate and its private key as one PKCS#12 file (`.pfx` / `.p12`), in place of
[ServerTlsOptions.cert](#cert) and [ServerTlsOptions.key](#key), unlocked with
[ServerTlsOptions.passphrase](#passphrase). The file's bytes, as `readFileSync` returns them; this
package reads no file itself.

The file is loaded before anything is bound. One the TLS library cannot load rejects
`listen()` with a typed `MllpTlsConfigurationError` carrying `MLLP_TLS_PFX_REJECTED`, whose
message names this option and never its value: a wrong passphrase, bytes that are not
PKCS#12, or a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy`, OpenSSL 1.x and
older Windows exports write it) that Node.js, on OpenSSL 3, does not load. Re-export such a
file with AES-256. Construction never throws for it.

###### Default

```ts
undefined (no PKCS#12 file)
```

***

### StarterClientOptions

Options for [createStarterClient](#createstarterclient).

The starter applies opinionated defaults on top of `ClientOptions`,
so every override here is optional except `host` + `port`. The
starter-specific addition is `handleSignals` (mirrors `createStarterServer`).

#### Example

```typescript
const opts: StarterClientOptions = {
  host: 'localhost',
  port: 2575,
  onMessage: (payload) => logger.info({ bytes: payload.length }),
  handleSignals: true,
};
```

#### Properties

##### ackTimeoutMs?

> `readonly` `optional` **ackTimeoutMs?**: `number`

Override default `30_000`.

##### autoReconnect?

> `readonly` `optional` **autoReconnect?**: `boolean`

Override default `true` (auto-reconnect on transient errors).

##### connectTimeoutMs?

> `readonly` `optional` **connectTimeoutMs?**: `number`

Bound on the TCP connect and TLS handshake, in ms. Passthrough to
`ClientOptions.connectTimeoutMs`; unset means no bound, as there.

##### correlateByControlId?

> `readonly` `optional` **correlateByControlId?**: `boolean`

Override default `false` (FIFO mode).

##### deadPeerTimeoutMs?

> `readonly` `optional` **deadPeerTimeoutMs?**: `number`

Application-idle dead-peer timeout ms.

##### drainTimeoutMs?

> `readonly` `optional` **drainTimeoutMs?**: `number`

Drain timeout for `close()` (default `30_000`).

##### framing?

> `readonly` `optional` **framing?**: `Omit`\<[`FrameReaderOptions`](#framereaderoptions), `"onFrame"` \| `"onWarning"`\>

FrameReader options (passthrough).

##### handleSignals?

> `readonly` `optional` **handleSignals?**: `boolean`

Register process SIGTERM/SIGINT handlers that close the client. Default
`false`. When `true`, SIGTERM/SIGINT both call `client.close()`
and exit the process. Handlers self-deregister on `'close'`.

##### highWaterMark?

> `readonly` `optional` **highWaterMark?**: `HighWaterMark`

Override default `64`.

##### host

> `readonly` **host**: `string`

Host to connect to.

##### keepaliveIntervalMs?

> `readonly` `optional` **keepaliveIntervalMs?**: `number`

TCP keepalive interval ms.

##### noDelay?

> `readonly` `optional` **noDelay?**: `boolean`

Turn off Nagle's algorithm. Passthrough to `ClientOptions.noDelay`, default `true`.

##### onBackpressure?

> `readonly` `optional` **onBackpressure?**: `"reject"` \| `"wait"`

Override default `'reject'`.

##### onMessage?

> `readonly` `optional` **onMessage?**: (`payload`) => `void`

Inbound-message callback (any framed payload from the peer, including
non-ACK messages on bidirectional channels). Mirrors the server-side
`onMessage` ergonomics.

###### Parameters

###### payload

`Buffer`

###### Returns

`void`

##### pipeline?

> `readonly` `optional` **pipeline?**: `boolean`

Override default `true` (parallel up to highWaterMark).

##### port

> `readonly` **port**: `number`

TCP port.

##### retryStrategy?

> `readonly` `optional` **retryStrategy?**: [`RetryStrategy`](#retrystrategy-2)

Custom reconnect-backoff hook.

##### tls?

> `readonly` `optional` **tls?**: `true` \| [`TlsOptions`](#tlsoptions)

Enable TLS (MLLPS) for this connection. Passthrough to `ClientOptions.tls`.

***

### StarterServerOptions

Options for `createStarterServer()`, the "three lines of code" factory.

Extends `ServerOptions` with `port`, `host`, and `handleSignals`. Defaults:
`autoAck: 'AA'`, `drainTimeoutMs: 30_000`, `Symbol.asyncDispose` wired.

#### Example

```typescript
import { createStarterServer } from '@cosyte/mllp';

const server = await createStarterServer({
  port: 2575,
  onMessage: async (payload) => {
    await db.commit(payload); // the durable-commit step; a throw answers a negative ACK
  },
});
// server is listening, auto-ACK enabled, Symbol.asyncDispose wired
await using _ = server; // closes on scope exit
```

#### Extends

- [`ServerOptions`](#serveroptions)

#### Properties

##### allowWildcardBind?

> `optional` **allowWildcardBind?**: `boolean`

Opt-in required to bind a wildcard host, a bind-safety guardrail.
Without this flag, `listen()` rejects a wildcard host in
two tiers: **literal spellings** (`'0.0.0.0'`, `'::'`, `''`, `'::0'`,
`'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`, …) reject **pre-bind** (fast
path, nothing is ever bound); **resolver-only shorthands** (`'0'`,
`'0.0'`, `'0x0.0.0.0'`, hostnames resolving to the unspecified
address, …) are caught **post-bind** against the OS-normalized bound
address, the just-bound server closes before any connection can be
accepted and `listen()` rejects, with no listening state and no
`'listening'` event either way. When `true`, binding a wildcard host
emits a one-time `'securityWarning'` (`MLLP_BIND_ALL_INTERFACES`) at
listen time.

###### Default

```ts
false
```

###### Inherited from

[`ServerOptions`](#serveroptions).[`allowWildcardBind`](#allowwildcardbind)

##### autoAck?

> `optional` **autoAck?**: `"AA"` \| ((`payload`, `meta`, `conn`) => `Buffer`\<`ArrayBufferLike`\> \| `Promise`\<`Buffer`\<`ArrayBufferLike`\>\>)

Auto-ACK mode. When set, the server builds and sends the ACK for each message.

- **`'AA'`**, auto-acknowledge with the fail-safe **commit contract**:
  - **With an `onMessage` handler ⇒ commit-gated (recommended).** The server awaits
    `onMessage` (the durable-commit step), then sends `AA` on success or a **negative**
    ACK on failure (`AE` by default; `AR` via [MllpAckError](#mllpackerror)). The positive ACK
    **cannot precede a successful commit**, a handler throw can never yield `AA`.
  - **Without an `onMessage` handler ⇒ transport-accept.** `AA` is sent on frame
    receipt. This `AA` means only **"bytes received and framed"**, *not*
    "application-processed". ⚠️ For clinical messages this is unsafe on its own:
    pair `'AA'` with an `onMessage` handler that durably commits, so the ACK reflects
    real processing.
- **`fn`**, `fn(payload, meta, conn)` builds the ACK bytes the server sends; the
  caller fully owns MSA-1 (e.g. to emit enhanced-mode `CA`/`CE`/`CR`).

The `'message'` event always fires BEFORE the ACK is sent. Do NOT call
`conn.send()` in `onMessage` when `autoAck` is set, this results in two ACKs.

###### Inherited from

[`ServerOptions`](#serveroptions).[`autoAck`](#autoack)

##### deadPeerTimeoutMs?

> `optional` **deadPeerTimeoutMs?**: `number`

Application-level idle close timeout in ms.
If no HL7 messages are received on a connection for this interval, the connection
is destroyed via `conn.destroy(new Error('idle timeout'))`.
Resets on every `'message'` event. Distinct from `keepaliveIntervalMs` (OS TCP probe).

###### Inherited from

[`ServerOptions`](#serveroptions).[`deadPeerTimeoutMs`](#deadpeertimeoutms-1)

##### drainTimeoutMs?

> `optional` **drainTimeoutMs?**: `number`

Graceful drain timeout passed to `conn.close()` during `server.close()`.
Default: 30 000 ms.

###### Inherited from

[`ServerOptions`](#serveroptions).[`drainTimeoutMs`](#draintimeoutms-2)

##### framing?

> `optional` **framing?**: `Omit`\<[`FrameReaderOptions`](#framereaderoptions), `"onFrame"` \| `"onWarning"`\>

FrameReader tolerance options applied to every accepted connection.
Merged with SERVER_DEFAULT_FRAMING, caller-supplied values override defaults.
`onFrame` and `onWarning` are managed internally and must not be supplied here.

###### Inherited from

[`ServerOptions`](#serveroptions).[`framing`](#framing-2)

##### handleSignals?

> `optional` **handleSignals?**: `boolean`

Register `process.once('SIGTERM')` and `process.once('SIGINT')` handlers that
call `server.close()` then `process.exit(0)`. Default: `false`.

Handlers are automatically removed when `server.close()` is called, so
`process.listenerCount('SIGTERM') === 0` after close() completes, preventing
handler accumulation across test instances or multiple server restarts.

##### host?

> `optional` **host?**: `string`

Host to bind to. Default `'127.0.0.1'` (bind-safety hardening,
was `'0.0.0.0'`; binding all interfaces now requires
`ServerOptions.allowWildcardBind: true`).

##### keepaliveIntervalMs?

> `optional` **keepaliveIntervalMs?**: `number`

TCP keepalive probe interval in ms.
Calls `socket.setKeepAlive(true, ms)` on each accepted socket.
Uses OS TCP stack to detect dead peers (half-open, network partitions).
Distinct from `deadPeerTimeoutMs` (application-level idle close).

###### Inherited from

[`ServerOptions`](#serveroptions).[`keepaliveIntervalMs`](#keepaliveintervalms-1)

##### maxConnections?

> `optional` **maxConnections?**: `number`

The most connections this server holds at once. A connection that arrives while the server
already holds this many is closed at accept: it never reaches `onMessage` or the
`'connection'` event, and the server emits `'connectionRejected'`
([ConnectionRejectedEvent](#connectionrejectedevent), code `MLLP_CONNECTION_LIMIT_REACHED`) instead.

The count is of open sockets, the number that bounds file descriptors: it includes a TLS
handshake still in progress, and a connection counts until its socket has fully closed. An
over-cap TLS connection is closed before its handshake, so it costs no handshake work and is
not a `'tlsClientError'`.

The server counts its connections itself rather than handing the cap to the runtime's
listener, so the cap and `'connectionRejected'` hold the same on Node.js, Bun and Deno (Deno's
own listener cap closed the connection and reported nothing).

Must be a positive integer; anything else throws a `RangeError` at construction. Unset means
no cap.

###### Default

```ts
undefined (no cap)
```

###### Inherited from

[`ServerOptions`](#serveroptions).[`maxConnections`](#maxconnections-1)

##### noDelay?

> `optional` **noDelay?**: `boolean`

Whether to turn off Nagle's algorithm (`socket.setNoDelay(noDelay)`) on each accepted
socket. With it on (`false` here), an ACK written while an earlier one is still
unacknowledged at the TCP level waits for that acknowledgment, which Linux delays by up to
about 40 ms. Set `false` only to restore the operating system's default.

###### Default

```ts
true
```

###### Inherited from

[`ServerOptions`](#serveroptions).[`noDelay`](#nodelay-1)

##### onMessage?

> `optional` **onMessage?**: (`payload`, `meta`, `conn`) => `void` \| `Promise`\<`void`\>

Called for each decoded MLLP message.

Its role depends on `autoAck`, this is the **commit contract** (HL7 v2.5.1 §2.9.2):

- **`autoAck: 'AA'` + this handler ⇒ commit-gated (the safe default).** The handler
  is the durable-commit step. The server **awaits** it and only then sends the ACK:
  resolve ⇒ `AA`; **throw/reject ⇒ `AE`** (or `AR` via [MllpAckError](#mllpackerror)), a
  positive ACK can never precede a successful commit. Do **not** call `conn.send()`
  here in this mode.
- **`autoAck` unset ⇒ manual mode.** The handler owns the response; build and send the
  ACK yourself via `conn.send(encodeFrame(ackPayload))`. Its return value is ignored.
- **`autoAck: fn` ⇒ observation only.** `fn` builds the ACK; this handler runs first as
  a side effect and its return value is ignored. Do not call `conn.send()` here.

May be sync or async; an async handler is awaited in commit-gated mode.

###### Parameters

###### payload

`Buffer`

###### meta

[`MessageMeta`](#messagemeta)

###### conn

[`Connection`](#connection)

###### Returns

`void` \| `Promise`\<`void`\>

###### Inherited from

[`ServerOptions`](#serveroptions).[`onMessage`](#onmessage-1)

##### onWarning?

> `optional` **onWarning?**: (`w`) => `void`

Per-connection warning subscriber. Called for every framing warning on every connection.

###### Parameters

###### w

[`MllpWarning`](#mllpwarning)

###### Returns

`void`

###### Inherited from

[`ServerOptions`](#serveroptions).[`onWarning`](#onwarning-4)

##### port

> **port**: `number`

Port to listen on.

##### tls?

> `optional` **tls?**: [`ServerTlsOptions`](#servertlsoptions)

Enable TLS (MLLPS) for this server. When set, the server binds a
`tls.Server` instead of a plain `net.Server`, consumes `'secureConnection'`
(post-handshake sockets) instead of `'connection'`, and surfaces failed
handshakes via the `'tlsClientError'` event rather than crashing.

We set no handshake time limit of our own: the runtime's applies. On Node.js that is its
`handshakeTimeout` default of 120 seconds, after which the socket is closed and
`'tlsClientError'` fires with code `ERR_TLS_HANDSHAKE_TIMEOUT`. Until then a peer that
connects and never completes the handshake holds a [ServerOptions.maxConnections](#maxconnections-1)
place, and `deadPeerTimeoutMs` does not apply, because it starts only once the connection is
accepted after its handshake. We have not measured what bounds a handshake on Bun or Deno,
which may set no limit at all.

Spec anchor: IHE ATNA ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).

###### Default

```ts
undefined (plaintext TCP)
```

###### Inherited from

[`ServerOptions`](#serveroptions).[`tls`](#tls-2)

***

### StateChangeEvent

Payload for the 'stateChange' event. Always `Object.freeze`'d.

#### Example

```typescript
conn.on('stateChange', ({ from, to, reason }) => {
  logger.info({ from, to, reason });
});
```

#### Properties

##### from

> `readonly` **from**: [`ConnectionState`](#connectionstate-1)

##### reason?

> `readonly` `optional` **reason?**: `string`

##### to

> `readonly` **to**: [`ConnectionState`](#connectionstate-1)

***

### TlsCipherPolicyInput

The cipher-suite half of a client's or server's TLS options, the two fields
that can declare what is offered.

#### Properties

##### atnaTransportSecurity?

> `readonly` `optional` **atnaTransportSecurity?**: `boolean`

See `TlsOptions.atnaTransportSecurity`.

##### ciphers?

> `readonly` `optional` **ciphers?**: `string`

See `TlsOptions.ciphers`.

##### dhParameters?

> `readonly` `optional` **dhParameters?**: `string` \| `Buffer`\<`ArrayBufferLike`\>

See `ServerTlsOptions.dhParameters`. Diffie-Hellman parameters are supplied
by the end that answers the key exchange, so this is read when `side` is
`'server'` and **ignored, without an error, when `side` is `'client'`**.

That asymmetry is stated rather than enforced because the field is
unreachable from the client option type in the first place: `TlsOptions`
carries no Diffie-Hellman parameter field at all, so a client value can
only arrive through a direct call to
[resolveTlsCipherPolicy](#resolvetlscipherpolicy).

***

### TlsOptions

Client-side TLS options (`ClientOptions.tls`).

Passing `true` for `ClientOptions.tls` is equivalent to `{}`, TLS enabled
with all defaults, including certificate verification **on**.

#### Example

```typescript
import { createClient } from '@cosyte/mllp';
const client = createClient({
  host: 'mllp.example.com',
  port: 2575,
  tls: { ca: caPem, minVersion: 'TLSv1.2' },
});
```

#### Properties

##### allowUnverified?

> `readonly` `optional` **allowUnverified?**: `boolean`

Loud, explicit dev opt-out from certificate verification (maps to
`tls.connect`'s `rejectUnauthorized: false`). There is deliberately no
raw `rejectUnauthorized` surface on this type, this is the only door,
and it is loud: every successful connection (initial + every reconnect)
emits a `'securityWarning'` (`MLLP_TLS_VERIFY_DISABLED`) event and calls
`process.emitWarning`.

Never set this in production against an untrusted network.

###### Default

```ts
false
```

##### atnaTransportSecurity?

> `readonly` `optional` **atnaTransportSecurity?**: `boolean`

Offer exactly the cipher suites the IHE ATNA ITI-19 transport-security
option names (ITI TF-2 §3.19.6.2.3), rather than inheriting the runtime's
own list. Off by default; turning it on only ever **narrows** what is
offered.

This is the **cipher-suite half** of that option, and it does not make the
declaration on your behalf. Mutual node authentication is
`ServerTlsOptions.clientAuth` plus a client `cert`/`key`, and the TLS 1.2
floor is [TlsOptions.minVersion](#minversion-1), which already defaults to it.

The four TLS 1.2 suites are offered together with the three TLS 1.3 suites
the runtime enables by default, so selecting this never removes a protocol
version that was reachable without it. A peer that supports none of them
fails the handshake rather than falling back, which is the point.

Mutually exclusive with [TlsOptions.ciphers](#ciphers-3): both declare the
offered list, so setting both rejects `connect()` with a typed
`MllpTlsConfigurationError`.

**On a runtime that cannot offer the list it rejects `connect()`** with a
typed `MllpTlsConfigurationError` carrying
`MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before any socket exists: under Deno,
whose `node:tls` takes a cipher list without applying it, and under Bun,
whose TLS library has none of the DHE suites the option names. Node.js
offers it.

###### Default

```ts
false
```

##### ca?

> `readonly` `optional` **ca?**: [`PemInput`](#peminput)

Trust anchor(s) for verifying the server's certificate chain.

##### cert?

> `readonly` `optional` **cert?**: [`PemInput`](#peminput)

Client certificate presented for mutual TLS (ATNA ITI-19).

##### ciphers?

> `readonly` `optional` **ciphers?**: `string`

OpenSSL cipher-list string passthrough (`tls.connect`'s `ciphers`).
Unset uses Node's compiled-in defaults, which already include both
ATNA-mandated ECDHE suites (see the module doc comment). Set this to
restrict to a stricter list of your own choosing; for the ATNA option's
own four suites prefer [TlsOptions.atnaTransportSecurity](#atnatransportsecurity-2), which is
the same declaration made once and reported on `'tlsNegotiated'`.

A list the runtime rejects rejects `connect()` with a typed
`MllpTlsConfigurationError`; it never silently falls back to the default
list. **So does any list on a runtime that does not enforce cipher lists**
(Deno, whose `node:tls` takes a list without applying it), with
`MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before any socket exists. Node.js and
Bun enforce a list.

###### Default

```ts
undefined (Node defaults)
```

##### key?

> `readonly` `optional` **key?**: [`PemInput`](#peminput)

Private key matching [TlsOptions.cert](#cert-1).

##### maxVersion?

> `readonly` `optional` **maxVersion?**: `"TLSv1.2"` \| `"TLSv1.3"`

Maximum negotiated TLS protocol version.

##### minVersion?

> `readonly` `optional` **minVersion?**: `"TLSv1.2"` \| `"TLSv1.3"`

Minimum negotiated TLS protocol version.

Default `'TLSv1.2'`, the IHE ATNA ITI-19 "TLS 1.2 Floor" (BCP195) floor
(ITI TF-2 §3.19.6.2.3). `'TLSv1.0'`/`'TLSv1.1'` are intentionally **not**
expressible by this type, the floor cannot be lowered through this API.

###### Default

```ts
'TLSv1.2'
```

##### passphrase?

> `readonly` `optional` **passphrase?**: `string`

Passphrase for an encrypted [TlsOptions.key](#key-1), or for the PKCS#12 file in
[TlsOptions.pfx](#pfx-1).

##### pfx?

> `readonly` `optional` **pfx?**: `Buffer`\<`ArrayBufferLike`\>

The client certificate and its private key as one PKCS#12 file (`.pfx` / `.p12`), for mutual
TLS, in place of [TlsOptions.cert](#cert-1) and [TlsOptions.key](#key-1), unlocked with
[TlsOptions.passphrase](#passphrase-1). The file's bytes, as `readFileSync` returns them; this package
reads no file itself.

The file is loaded before a socket is opened. One the TLS library cannot load rejects
`connect()` with a typed `MllpTlsConfigurationError` carrying `MLLP_TLS_PFX_REJECTED`, whose
message names this option and never its value: a wrong passphrase, bytes that are not
PKCS#12, or a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy`, OpenSSL 1.x and
older Windows exports write it) that Node.js, on OpenSSL 3, does not load. Re-export such a
file with AES-256. The refusal is permanent: a client does not retry it.

###### Default

```ts
undefined (no PKCS#12 file)
```

##### servername?

> `readonly` `optional` **servername?**: `string`

SNI hostname and the identity-check target (matched against the server
certificate's Subject/SAN). Defaults to `ClientOptions.host` when unset.
An IP address, set here or as the host, is checked against the
certificate but never sent as SNI, which RFC 6066 reserves for host names.

***

### Transport

Pure callback-bag transport abstraction.

Each `onXxx` registration is **set-once**: calling `onData(fn)` a second time
replaces the first handler. This prevents listener leaks across reconnect cycles
where Connection re-registers handlers on a fresh Transport.

#### Example

```typescript
function writeAll(t: Transport, chunks: Buffer[]): void {
  for (const chunk of chunks) t.write(chunk);
}
```

#### Methods

##### close()

> **close**(): `void`

Initiate graceful close of the underlying transport.
The registered `onClose` handler fires once the socket is fully closed.

###### Returns

`void`

##### destroy()

> **destroy**(`reason?`): `void`

Abruptly destroy the transport, discarding any pending writes.
Fires `onError(reason)` (if provided) then `onClose`.

###### Parameters

###### reason?

`Error`

Optional error describing why the transport was destroyed.

###### Returns

`void`

##### onClose()

> **onClose**(`fn`): `void`

Register the close handler. Called once when the underlying socket is fully closed.
Replaces any previously registered handler (set-once semantics).

###### Parameters

###### fn

() => `void`

###### Returns

`void`

##### onConnect()

> **onConnect**(`fn`): `void`

Register the connect handler. Called once after TCP (or TLS) handshake completes.
Replaces any previously registered handler (set-once semantics).

###### Parameters

###### fn

() => `void`

###### Returns

`void`

##### onData()

> **onData**(`fn`): `void`

Register the data handler. Called synchronously for each received chunk.
Replaces any previously registered handler (set-once semantics).

###### Parameters

###### fn

(`chunk`) => `void`

Called with each raw chunk as it arrives from the OS.

###### Returns

`void`

##### onError()

> **onError**(`fn`): `void`

Register the error handler. Called for socket-level errors (ECONNRESET, ETIMEDOUT, etc.).
Replaces any previously registered handler (set-once semantics).

###### Parameters

###### fn

(`err`) => `void`

Receives the underlying OS or TLS error.

###### Returns

`void`

##### write()

> **write**(`buf`): `boolean`

Write `buf` to the underlying transport.

###### Parameters

###### buf

`Buffer`

###### Returns

`boolean`

`true` if the bytes were flushed to the kernel immediately;
`false` if the write was buffered (backpressure, caller should pause sending
until the `onDrain` event fires at the Connection layer).

## Type Aliases

### AckCode

> **AckCode** = `"AA"` \| `"AE"` \| `"AR"` \| `"CA"` \| `"CE"` \| `"CR"`

HL7 Table 0008, Acknowledgment Code. A **stable public API**.

Two families, by mode (HL7 v2.5.1 §2.9):

- **Original mode (§2.9.2):** `AA` accept, `AE` application error, `AR` application
  reject. The single ACK reports application-level outcome.
- **Enhanced mode (§2.9.3):** `CA` commit accept, `CE` commit error, `CR` commit
  reject, the *accept* acknowledgement, distinct from a later application ACK.

`AE` vs `AR`: `AE` is a processing **error** (the sender may resend later, e.g. a
transient downstream outage); `AR` is a **reject** (the sender should not resend the
message unchanged, e.g. it is structurally unacceptable). `@cosyte/mllp` builds
original-mode ACKs; the `C*` codes are surfaced in the type for completeness and for
callers that build their own enhanced-mode ACKs via `autoAck: fn`.

#### Example

```typescript
import type { AckCode } from '@cosyte/mllp';
const code: AckCode = 'AE';
```

***

### AckCorrelationCode

> **AckCorrelationCode** = `"MLLP_ACK_UNMATCHED_CONTROL_ID"` \| `"MLLP_ACK_AFTER_TIMEOUT"`

The two warning codes emitted by ACK correlation rather than by framing.

A subset of the framing `WarningCode` union; named separately so the
registry below is exhaustive over exactly the codes it owns and a new
correlation code cannot be added without a message for it.

***

### AckModeCode

> **AckModeCode** = `"MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED"` \| `"MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED"` \| `"MLLP_ACK_TWO_PHASE_UNAVAILABLE"` \| `"MLLP_ACK_COMMIT_ALREADY_REPORTED"` \| `"MLLP_ACK_MSA1_ABSENT"` \| `"MLLP_ACK_MSA1_UNCLASSIFIABLE"` \| `"MLLP_ACK_SEND_ALREADY_DISPOSED"`

The stable codes acknowledgement-mode reporting emits.

A **public API**: consumers narrow on them in warning handlers, log pipelines and
monitoring. Renaming or removing one is a breaking change. They are deliberately a
family of their own rather than additions to the framing warning-code union, because
that union is the decoder's registry and these are not decoder events.

#### Example

```typescript
import type { AckModeCode } from '@cosyte/mllp';
const code: AckModeCode = 'MLLP_ACK_TWO_PHASE_UNAVAILABLE';
```

***

### ApplicationAckFailure

> **ApplicationAckFailure** = `"timeout"` \| `"connection-lost"`

Why a send waiting on its application acknowledgement was failed.

- `'timeout'`, the wait that started at the accept acknowledgement expired.
- `'connection-lost'`, the link failed or was closed while the send was still pending on
  it. The send is failed rather than left pending or reported as successful, because
  nobody can say what the receiving application did with a message whose second
  acknowledgement never arrived.

#### Example

```typescript
import { MllpApplicationAckError } from '@cosyte/mllp';
if (err instanceof MllpApplicationAckError && err.reason === 'timeout') {
  // committed by the peer, application disposition unknown
}
```

***

### ClientAuth

> **ClientAuth** = `"NONE"` \| `"WANT"` \| `"MUST"`

ATNA ITI-19 mutual-authentication modes for [ServerTlsOptions.clientAuth](#clientauth).

Mirrors the IHE ATNA "Authenticate Node" mutual-auth requirement
(https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html):

- `'NONE'`, no client certificate requested (default).
- `'WANT'`, client certificate requested but NOT required; an untrusted or
  absent client certificate does not reject the connection. The peer
  certificate (if any) is surfaced on the `'connection'` event.
- `'MUST'`, client certificate required AND verified against
  [ServerTlsOptions.ca](#ca); the ATNA mutual-authentication mode. A
  missing or untrusted client certificate rejects the handshake.

#### Example

```typescript
import type { ClientAuth } from '@cosyte/mllp';
const mode: ClientAuth = 'MUST'; // ATNA ITI-19 mutual node authentication
```

***

### ConnectionErrorCause

> **ConnectionErrorCause** = `"fifo-unsafe"` \| `"in-flight-orphan"` \| `"tls-verify"` \| `"tls-handshake"` \| `"framing-fatal"` \| `"connect-timeout"`

Stable cause codes for `MllpConnectionError`.

These codes are a **public API**, they appear in error inspection
by callers, log pipelines, and monitoring dashboards. Renaming or
removing a member is a breaking change.

- `'fifo-unsafe'`, A queued send was rejected during reconnect because
  FIFO ordering cannot be safely resumed across sessions.
- `'in-flight-orphan'`, An in-flight send (already write-flushed,
  ACK timer started) was rejected during reconnect in FIFO mode because
  the at-most-once delivery contract cannot be preserved across a
  socket drop (healthcare medication/orders semantics).
- `'tls-verify'`, The TLS handshake failed certificate
  verification (untrusted chain, expired/not-yet-valid cert, hostname
  mismatch, revocation, …). See [isTlsVerificationErrorCode](#istlsverificationerrorcode) for the
  exact underlying error codes. Classified **permanent** by
  `isTransientConnectionError`, never auto-reconnect-looped into a
  misconfigured or MITM'd endpoint.
- `'tls-handshake'`, A TLS-**protocol**-shaped handshake
  failure observed before `'secureConnect'`: `ERR_SSL_*` codes, `EPROTO`,
  or an OpenSSL alert-bearing error (protocol version mismatch, no shared
  cipher, a required mutual-TLS client certificate rejected by the
  server, …). See `isTlsProtocolError` for the boundary. Pure TCP-level
  failures (`ECONNREFUSED`, `ETIMEDOUT`, …) on a TLS-configured
  connection carry **no** `connectionCause`, the same shape as plaintext.
- `'framing-fatal'`, the peer sent bytes the decoder could not accept, or a
  frame past the size cap. Classified **permanent**.
- `'connect-timeout'`, the connection was not established within
  `ClientOptions.connectTimeoutMs`: the TCP connect, or the TLS handshake
  after it, did not complete in time and the socket was destroyed. Nothing
  was written, so no message reached the peer. The `cause` carries
  `code: 'ETIMEDOUT'`, and it is classified **transient** by
  `isTransientConnectionError`, like the operating system's own connect
  timeout: a peer that is down or unreachable now may answer later.

Scope note: the `'tls-verify'`/`'tls-handshake'`/`'connect-timeout'` values
are attached on the client's **initial `connect()` path**. Failures on the auto-reconnect
path surface as raw socket errors, their transient/permanent
classification still applies, but they do not (yet) carry a
`connectionCause`.

#### Example

```typescript
if (err instanceof MllpConnectionError && err.connectionCause === 'in-flight-orphan') {
  // Treat as at-most-once: do NOT auto-retry; bubble up to caller for
  // application-level dedupe / replay decisions.
}
```

***

### ConnectionErrorPhase

> **ConnectionErrorPhase** = `"connect"` \| `"send"` \| `"receive"` \| `"close"` \| `"reconnect"`

Connection lifecycle phase where the error occurred.

All 5 phases are defined even though `'reconnect'` is only
exercised by the client. Locking the full union now prevents a
breaking type change later.

***

### ConnectionState

> **ConnectionState** = `"CONNECTING"` \| `"CONNECTED"` \| `"DRAINING"` \| `"RECONNECTING"` \| `"DISCONNECTED"` \| `"CLOSED"`

The 6 connection states.

Transitions are validated against the legal-transition edge graph. Illegal transitions
are silently ignored to preserve FSM integrity.

***

### DifferentialConfigurationErrorCode

> **DifferentialConfigurationErrorCode** = *typeof* [`MLLP_DIFF_PEER_UNPARSEABLE`](#mllp_diff_peer_unparseable)

Union of the stable differential-configuration error codes.

#### Example

```typescript
const code: DifferentialConfigurationErrorCode = 'MLLP_DIFF_PEER_UNPARSEABLE';
```

***

### DifferentialConnect

> **DifferentialConnect** = (`peer`) => [`Transport`](#transport-1)

Opens a connection to the peer. Supply your own to run the harness over something other
than a plain TCP socket, a TLS transport for an MLLPS peer being the obvious case.

The returned transport must not be connected yet: the harness registers its handlers
first and writes only once `onConnect` fires.

#### Parameters

##### peer

[`DifferentialPeer`](#differentialpeer)

#### Returns

[`Transport`](#transport-1)

#### Example

```typescript
const connect: DifferentialConnect = (peer) =>
  new TlsTransport(tls.connect({ host: peer.host, port: peer.port }));
```

***

### DifferentialCorrelationOutcome

> **DifferentialCorrelationOutcome** = `"match"` \| `"mismatch"` \| `"absent"` \| `"not-observed"`

Whether the peer's acknowledgement echoed the control ID of the message it answered.

`absent` means the response carried no readable acknowledged control ID at all, which
is a different failure from echoing the wrong one and is worth telling apart.

#### Example

```typescript
const correlation: DifferentialCorrelationOutcome = 'match';
```

***

### DifferentialExchangeOutcome

> **DifferentialExchangeOutcome** = `"answered"` \| `"unanswered"` \| `"undecodable-response"` \| `"connection-refused"` \| `"connection-failed"` \| `"connection-dropped"`

What became of one canonical exchange.

- `answered`, the peer returned a decodable frame, so parity and correlation are
  reported for it.
- `unanswered`, the connection held and no complete frame arrived before the deadline.
- `undecodable-response`, bytes arrived and the decoder could not complete a frame from
  them even with every tolerance enabled. The deviation is still named by its code.
- `connection-refused`, the peer refused the connection outright.
- `connection-failed`, the connection could not be established for some other reason.
- `connection-dropped`, the connection was established and then went away mid-exchange.

#### Example

```typescript
const outcome: DifferentialExchangeOutcome = 'answered';
```

***

### DifferentialParityOutcome

> **DifferentialParityOutcome** = `"match"` \| `"deviation"` \| `"not-observed"`

Whether the peer's response frame was byte-identical to the canonical Release 1 block.

`not-observed` is the honest answer when no frame arrived: an exchange that was never
answered has no parity, and reporting one as a failure would confuse a silent peer with
a mis-framing one.

#### Example

```typescript
const parity: DifferentialParityOutcome = 'match';
```

***

### DifferentialRunResult

> **DifferentialRunResult** = `"parity-observed"` \| `"deviations-observed"` \| `"no-observation"` \| `"skipped"`

The overall shape of a run, in three values plus the skip.

- `parity-observed`, every attempted exchange was answered with a byte-identical
  canonical block and a correlating acknowledgement.
- `deviations-observed`, at least one exchange was answered and at least one exchange
  deviated, went unanswered or failed.
- `no-observation`, nothing was answered, so the run observed nothing about the peer.
- `skipped`, no peer was configured and nothing was sent.

**None of these is a pass**, and `parity-observed` in particular is not one: it says
what this corpus saw on this run, not that a peer is conformant.

#### Example

```typescript
const result: DifferentialRunResult = 'no-observation';
```

***

### DifferentialSkipReason

> **DifferentialSkipReason** = `"no-peer-configured"`

Why a run was skipped, when it was.

#### Example

```typescript
const reason: DifferentialSkipReason = 'no-peer-configured';
```

***

### NackAckCode

> **NackAckCode** = `"AE"` \| `"AR"` \| `"CE"` \| `"CR"`

The negative acknowledgement codes a [NackEvent](#nackevent) can carry: both halves of the
negative side of HL7 Table 0008.

#### Example

```typescript
import type { NackAckCode } from '@cosyte/mllp';
const code: NackAckCode = 'CR';
```

***

### NackReason

> **NackReason** = `"handler-rejected"` \| `"uncorrelatable-inbound"` \| `"discarded-bytes"`

Why the server sent a **negative** acknowledgement instead of `AA` on the auto-ACK path.
A stable, **PHI-free** enum (no payload bytes, no control ID), safe to log and to key
metrics on.

- `'handler-rejected'`, a commit-gated `onMessage` handler threw/rejected (the commit
  contract: a positive ACK cannot precede a successful commit).
- `'uncorrelatable-inbound'`, the inbound could not carry a correlatable positive ACK
  (no readable `MSH`, an empty MSH-10, or a batch/concatenated-message shape). A positive
  `AA` here names a control ID the sender cannot match → timeout → resend → **duplicate
  clinical message**. See [rawAckUncorrelatable](#rawackuncorrelatable).
- `'discarded-bytes'`, the decoder flagged `MLLP_TRAILING_BYTES` for this frame: a
  mid-payload `VT` made it **discard accumulated bytes** and deliver only the fragment
  after it. The clinical message was destroyed in transit; a positive `AA` would tell the
  sender a message we never received was delivered.

***

### NegativeAckCode

> **NegativeAckCode** = `"AE"` \| `"AR"`

The negative original-mode acknowledgement codes a failed handler can produce.

#### Example

```typescript
import type { NegativeAckCode } from '@cosyte/mllp';
const code: NegativeAckCode = 'AR';
```

***

### PemInput

> **PemInput** = `string` \| `Buffer` \| (`string` \| `Buffer`)[]

A PEM-encoded credential (certificate, key, or CA), matching Node's
`tls.connect`/`tls.createServer` input shape, a single PEM string/Buffer,
or an array of them (chain / multiple trust anchors).

#### Example

```typescript
import { readFileSync } from 'node:fs';
const ca: PemInput = readFileSync('ca.pem');
```

***

### RetryStrategy

> **RetryStrategy** = (`ctx`) => `number` \| `null`

Custom reconnect-backoff hook. Return `null` to halt
reconnection, the FSM transitions to `CLOSED`.

#### Parameters

##### ctx

[`RetryContext`](#retrycontext)

#### Returns

`number` \| `null`

***

### SecurityWarningCode

> **SecurityWarningCode** = *typeof* [`MLLP_TLS_VERIFY_DISABLED`](#mllp_tls_verify_disabled) \| *typeof* [`MLLP_BIND_ALL_INTERFACES`](#mllp_bind_all_interfaces)

Union of the two stable security-warning codes.

#### Example

```typescript
const code: SecurityWarningCode = 'MLLP_TLS_VERIFY_DISABLED';
```

***

### TlsConfigurationErrorCode

> **TlsConfigurationErrorCode** = *typeof* [`MLLP_TLS_CIPHER_LIST_REJECTED`](#mllp_tls_cipher_list_rejected) \| *typeof* [`MLLP_TLS_CIPHER_OPTION_CONFLICT`](#mllp_tls_cipher_option_conflict) \| *typeof* [`MLLP_TLS_DH_PARAMETERS_REJECTED`](#mllp_tls_dh_parameters_rejected) \| *typeof* [`MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`](#mllp_tls_cipher_list_unenforceable) \| *typeof* [`MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`](#mllp_tls_dh_parameters_unenforceable) \| *typeof* [`MLLP_TLS_PFX_REJECTED`](#mllp_tls_pfx_rejected)

Union of the stable TLS-configuration error codes.

#### Example

```typescript
const code: TlsConfigurationErrorCode = 'MLLP_TLS_CIPHER_LIST_REJECTED';
```

***

### WarningCode

> **WarningCode** = `"MLLP_MISSING_LEADING_VT"` \| `"MLLP_FS_WITHOUT_CR"` \| `"MLLP_LF_AFTER_FS"` \| `"MLLP_LEADING_WHITESPACE"` \| `"MLLP_TRAILING_BYTES"` \| `"MLLP_PAYLOAD_CONTAINS_VT"` \| `"MLLP_PAYLOAD_CONTAINS_FS"` \| `"MLLP_EMPTY_PAYLOAD"` \| `"MLLP_FRAME_TOO_LARGE"` \| `"MLLP_ACK_UNMATCHED_CONTROL_ID"` \| `"MLLP_ACK_AFTER_TIMEOUT"`

Union of all stable MLLP warning codes.

These codes are a **public API**, they appear in `onWarning` handlers, log pipelines,
monitoring dashboards, and error messages. Renaming is a breaking change.

#### Example

```typescript
const code: WarningCode = 'MLLP_FS_WITHOUT_CR';
```

## Variables

### ATNA\_CIPHER\_LIST

> `const` **ATNA\_CIPHER\_LIST**: `string`

The OpenSSL cipher-list string `tls.atnaTransportSecurity: true` offers:
the three TLS 1.3 default suites followed by the four ITI TF-2 §3.19.6.2.3
suites, and nothing else.

#### Example

```typescript
import { ATNA_CIPHER_LIST } from '@cosyte/mllp';
console.log(ATNA_CIPHER_LIST.split(':').length); // => 7
```

***

### ATNA\_CIPHER\_SUITES

> `const` **ATNA\_CIPHER\_SUITES**: readonly `string`[]

The four TLS 1.2 cipher suites ITI TF-2 §3.19.6.2.3 names, in the OpenSSL
spelling a cipher-list string is written in. Their IANA spellings, which are
what the standard prints and what the `'tlsNegotiated'` event reports, are
the same four prefixed `TLS_` and joined with `_WITH_`.

#### Example

```typescript
import { ATNA_CIPHER_SUITES } from '@cosyte/mllp';
console.log(ATNA_CIPHER_SUITES.includes('ECDHE-RSA-AES128-GCM-SHA256')); // => true
```

***

### MLLP\_BIND\_ALL\_INTERFACES

> `const` **MLLP\_BIND\_ALL\_INTERFACES**: `"MLLP_BIND_ALL_INTERFACES"` = `"MLLP_BIND_ALL_INTERFACES"`

Emitted (server-side) once at `listen()` time when the server binds a
wildcard host (`'0.0.0.0'` or `'::'`) with `ServerOptions.allowWildcardBind: true`.
Binding all interfaces widens the network exposure of the listener; this is
the loud, one-time reminder that the operator opted in.

#### Example

```typescript
import { MLLP_BIND_ALL_INTERFACES } from '@cosyte/mllp';
server.on('securityWarning', (w) => {
  if (w.code === MLLP_BIND_ALL_INTERFACES) logger.warn(w.message);
});
```

***

### MLLP\_CONNECTION\_LIMIT\_REACHED

> `const` **MLLP\_CONNECTION\_LIMIT\_REACHED**: `"MLLP_CONNECTION_LIMIT_REACHED"` = `"MLLP_CONNECTION_LIMIT_REACHED"`

The stable code on a [ConnectionRejectedEvent](#connectionrejectedevent): a connection arrived while the server
already held [ServerOptions.maxConnections](#maxconnections-1) connections, and it was closed at accept.

Part of the public surface: renaming or removing it is a breaking change.

#### Example

```typescript
import { MLLP_CONNECTION_LIMIT_REACHED } from '@cosyte/mllp';
server.on('connectionRejected', (e) => {
  if (e.code === MLLP_CONNECTION_LIMIT_REACHED) metrics.increment('mllp.over_cap');
});
```

***

### MLLP\_DIFF\_PEER\_UNPARSEABLE

> `const` **MLLP\_DIFF\_PEER\_UNPARSEABLE**: `"MLLP_DIFF_PEER_UNPARSEABLE"` = `"MLLP_DIFF_PEER_UNPARSEABLE"`

A peer address was configured and could not be resolved into a host and a port.

Distinct from no peer at all, which is not an error and skips the run.

#### Example

```typescript
import { MLLP_DIFF_PEER_UNPARSEABLE } from '@cosyte/mllp';
if (err.code === MLLP_DIFF_PEER_UNPARSEABLE) process.exit(78); // EX_CONFIG
```

***

### MLLP\_TLS\_CIPHER\_LIST\_REJECTED

> `const` **MLLP\_TLS\_CIPHER\_LIST\_REJECTED**: `"MLLP_TLS_CIPHER_LIST_REJECTED"` = `"MLLP_TLS_CIPHER_LIST_REJECTED"`

The runtime refused the cipher-suite list it was handed: no suite in it is
available in this Node build's TLS library. Nothing falls back to the
runtime default list, the connection or the bind is refused instead.

#### Example

```typescript
import { MLLP_TLS_CIPHER_LIST_REJECTED } from '@cosyte/mllp';
if (err.code === MLLP_TLS_CIPHER_LIST_REJECTED) process.exit(78); // EX_CONFIG
```

***

### MLLP\_TLS\_CIPHER\_LIST\_UNENFORCEABLE

> `const` **MLLP\_TLS\_CIPHER\_LIST\_UNENFORCEABLE**: `"MLLP_TLS_CIPHER_LIST_UNENFORCEABLE"` = `"MLLP_TLS_CIPHER_LIST_UNENFORCEABLE"`

The runtime's TLS library does not enforce a cipher-suite list: it accepts a list and then
offers its own, or it cannot offer a suite the configuration names. Raised for `ciphers` and for
`atnaTransportSecurity`, before any socket exists.

This is a property of the runtime, not of the list: Node.js enforces both options, and the same
configuration fails here on a runtime whose `node:tls` takes a `ciphers` list without applying
it, or whose TLS library has no finite-field Diffie-Hellman suite for the ATNA option to offer.
It is proved with a probe rather than read off a runtime name: a list that names a suite and then
removes it, so selects none, must be refused, and each suite the ATNA option names must be
accepted on its own.

Distinct from [MLLP\_TLS\_CIPHER\_LIST\_REJECTED](#mllp_tls_cipher_list_rejected), where the runtime does enforce lists and
refused this one: the remedy here is a different runtime, or no cipher option at all.

#### Example

```typescript
import { MLLP_TLS_CIPHER_LIST_UNENFORCEABLE } from '@cosyte/mllp';
if (err.code === MLLP_TLS_CIPHER_LIST_UNENFORCEABLE) logger.error('run this link on Node.js');
```

***

### MLLP\_TLS\_CIPHER\_OPTION\_CONFLICT

> `const` **MLLP\_TLS\_CIPHER\_OPTION\_CONFLICT**: `"MLLP_TLS_CIPHER_OPTION_CONFLICT"` = `"MLLP_TLS_CIPHER_OPTION_CONFLICT"`

Two different offered-suite declarations were made at once:
`atnaTransportSecurity: true` fixes the list, and `ciphers` replaces it.
Honouring either one silently discards the other, so both are refused.

#### Example

```typescript
import { MLLP_TLS_CIPHER_OPTION_CONFLICT } from '@cosyte/mllp';
if (err.code === MLLP_TLS_CIPHER_OPTION_CONFLICT) logger.error('pick one of the two');
```

***

### MLLP\_TLS\_DH\_PARAMETERS\_REJECTED

> `const` **MLLP\_TLS\_DH\_PARAMETERS\_REJECTED**: `"MLLP_TLS_DH_PARAMETERS_REJECTED"` = `"MLLP_TLS_DH_PARAMETERS_REJECTED"`

The ephemeral Diffie-Hellman parameters a server supplied are not usable: not
PEM content, not a Diffie-Hellman parameter block, or a group the TLS library
refuses. Distinct from [MLLP\_TLS\_CIPHER\_LIST\_REJECTED](#mllp_tls_cipher_list_rejected) because the
remedy is different: one is the offered suite list, the other is the key
exchange behind it.

Nothing is bound and nothing falls back to a server running with no
Diffie-Hellman parameters, which would advertise its DHE suites and then fail
every handshake in them.

#### Example

```typescript
import { MLLP_TLS_DH_PARAMETERS_REJECTED } from '@cosyte/mllp';
if (err.code === MLLP_TLS_DH_PARAMETERS_REJECTED) process.exit(78); // EX_CONFIG
```

***

### MLLP\_TLS\_DH\_PARAMETERS\_UNENFORCEABLE

> `const` **MLLP\_TLS\_DH\_PARAMETERS\_UNENFORCEABLE**: `"MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE"` = `"MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE"`

The runtime's TLS library does not enforce server-side ephemeral Diffie-Hellman parameters: it
accepts parameters and then runs without them, or it refuses the automatic selection the ATNA
option makes. Raised for `ServerTlsOptions.dhParameters` and for a server's
`atnaTransportSecurity`, before anything is bound.

Proved with a probe rather than read off a runtime name: the automatic selection must be
accepted, and a group far too small to use must be refused. A runtime that takes the small group
in silence would take the caller's group in silence too, and nothing would say it went unused.
When the runtime refused the probe itself, its own error is the `cause`.

Distinct from [MLLP\_TLS\_DH\_PARAMETERS\_REJECTED](#mllp_tls_dh_parameters_rejected), where the runtime does enforce parameters
and refused these: the remedy here is a different runtime, or no Diffie-Hellman option at all.

#### Example

```typescript
import { MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE } from '@cosyte/mllp';
if (err.code === MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE) logger.error('run this server on Node.js');
```

***

### MLLP\_TLS\_PFX\_REJECTED

> `const` **MLLP\_TLS\_PFX\_REJECTED**: `"MLLP_TLS_PFX_REJECTED"` = `"MLLP_TLS_PFX_REJECTED"`

The TLS library could not load `tls.pfx`, the PKCS#12 file, with `tls.passphrase`. Raised for
`ServerTlsOptions.pfx` by `listen()`, before anything is bound, and for `TlsOptions.pfx` by a
client's `connect()`, before a socket is opened.

Three causes share it: the passphrase is wrong, the bytes are not a PKCS#12 file, or the file
uses a legacy encryption the library does not load. The last is the one that surprises: a file
written by `openssl pkcs12 -export -legacy`, by OpenSSL 1.x, or by an older Windows export
protects its certificates with RC2-40, and Node.js runs OpenSSL 3 without the legacy provider
that holds RC2, so it refuses the file. Re-export it with AES-256
(`openssl pkcs12 -export` on OpenSSL 3 does by default). The TLS library's own error is the
`cause`; it names the failure and carries neither the passphrase nor any of the file.

#### Example

```typescript
import { MLLP_TLS_PFX_REJECTED } from '@cosyte/mllp';
if (err.code === MLLP_TLS_PFX_REJECTED) logger.error('re-export the PKCS#12 file with AES-256');
```

***

### MLLP\_TLS\_VERIFY\_DISABLED

> `const` **MLLP\_TLS\_VERIFY\_DISABLED**: `"MLLP_TLS_VERIFY_DISABLED"` = `"MLLP_TLS_VERIFY_DISABLED"`

Emitted (client-side) on every successful `secureConnect`, initial connect
AND every reconnect, when [TlsOptions.allowUnverified](#allowunverified) is `true`.
Certificate verification is disabled for the connection; this is the loud,
per-connection reminder that the channel is not authenticated per IHE ATNA
ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).

#### Example

```typescript
import { MLLP_TLS_VERIFY_DISABLED } from '@cosyte/mllp';
client.on('securityWarning', (w) => {
  if (w.code === MLLP_TLS_VERIFY_DISABLED) metrics.increment('mllp.tls_verify_disabled');
});
```

***

### TLS13\_DEFAULT\_CIPHER\_SUITES

> `const` **TLS13\_DEFAULT\_CIPHER\_SUITES**: readonly `string`[]

The three TLS 1.3 cipher suites the runtime enables by default.

They are carried alongside the four above for one reason: a TLS 1.3 suite is
enabled only by its full name in the cipher list, so a list holding the four
TLS 1.2 suites alone would turn TLS 1.3 **off**. Selecting the option must
never remove a protocol version that was reachable without it, so these are
restated rather than dropped.

#### Example

```typescript
import { TLS13_DEFAULT_CIPHER_SUITES } from '@cosyte/mllp';
console.log(TLS13_DEFAULT_CIPHER_SUITES.length); // => 3
```

***

### VERSION

> `const` **VERSION**: `string` = `"0.1.11"`

Package version marker exported from the `@cosyte/mllp` root.

Kept in lockstep with `package.json` by `scripts/sync-version.mjs`, which the `version` script
runs immediately after `changeset version`. The `: string` annotation is deliberate, without it
TypeScript infers the *literal* type (`declare const VERSION = "0.0.0"`), which leaks the current
release into consumers' types and makes an equality check against any other version a compile
error.

#### Example

```typescript
import { VERSION } from '@cosyte/mllp';
console.log(VERSION);
```

## Functions

### ackDiagnosticMessage()

> **ackDiagnosticMessage**(`code`): `string`

Look up the frozen diagnostic text for an ACK-correlation code.

A pure table read. It takes no value, so no caller can widen it into an
interpolation site.

#### Parameters

##### code

[`AckCorrelationCode`](#ackcorrelationcode)

The correlation code being reported.

#### Returns

`string`

The registered message for that code, byte-for-byte.

#### Example

```typescript
const message = ackDiagnosticMessage('MLLP_ACK_AFTER_TIMEOUT');
```

***

### ackModeDiagnosticMessage()

> **ackModeDiagnosticMessage**(`code`): `string`

Look up the frozen diagnostic text for an acknowledgement-mode code.

A pure table read. It takes no value, so no caller can widen it into an interpolation
site.

#### Parameters

##### code

[`AckModeCode`](#ackmodecode)

The acknowledgement-mode code being reported.

#### Returns

`string`

The registered message for that code, byte-for-byte.

#### Example

```typescript
const message = ackModeDiagnosticMessage('MLLP_ACK_MSA1_UNCLASSIFIABLE');
```

***

### buildRawAck()

> **buildRawAck**(`payload`, `code`): `Buffer`

Build a minimal original-mode HL7 v2 acknowledgement from raw inbound payload bytes,
**without a parser** (parser-driven ACKs are the `@cosyte/mllp/ack-from-hl7` subpath).

Locates the `MSH` segment (the first `CR`/`LF`-delimited segment starting with `MSH`,
so a leading `CR` or an `FHS`/`BHS` batch header does not hide it), reads the field
separator from **MSH-1** and the encoding characters from **MSH-2**, then splits that
segment on that separator to read fields. The ACK swaps sender/receiver per HL7 ACK
rules, echoes the inbound MSH-10 into MSA-2 (§2.9.2.2), sets MSA-1 to `code`, and, for
negative codes, adds a **static, PHI-free** MSA-3 reason. A fresh control ID fills the
ACK's own MSH-10.

**Why the delimiters are read, not assumed**

MSH-1 **is** the field separator (HL7 v2.5.1 §2.5.4): the byte at offset 3 of the MSH
segment *defines* it for the whole message. `|` is overwhelmingly common but it is a
convention, not the spec. Assuming it was wrong in two compounding ways:

  1. **Reading.** Splitting a `!`-delimited message on `|` yields ONE field, so every
     echoed field, including MSH-10, came back empty. The ACK went out as
     `MSA|AA|` with **no correlation id at all**: the sender cannot match it, times
     out, and resends → a duplicate clinical message. That is the exact failure this
     package's correlator exists to prevent, manufactured by the ACK builder itself.
  2. **Writing.** The echoed MSH-3..6 and MSH-10 field *content* is copied verbatim
     from the inbound, still escaped against the **inbound's** encoding characters. Re-
     emitting that content under a different delimiter set silently reinterprets it:
     an inbound whose component separator is `#` and whose MSH-10 is `ID#X` would be
     re-emitted under `^~\&` as the literal `ID#X`, which the sender then reads as a
     single component rather than two. Echoing MSH-1 and MSH-2 keeps the content and
     the delimiters that define it together.

**It reads the MSH through the SHARED scanner**

The MSH read is `readMshSegment` from `src/internal/control-id.ts`, the same call the
client's correlator makes to derive the key it will later match this ACK against. That
is deliberate and it is the whole point: this builder used to re-derive the read itself
(`payload.toString("latin1").split("\r")`, hunting for an `MSH` anywhere in the
payload), and the two disagreed on real inputs. On a **truncated MSH** followed by a
`PID` the correlator keyed on the PID's MRN while this builder echoed an empty MSA-2. On
a payload with a **leading `CR`**, which the MLLP decoder passes straight through, and
which real senders emit, this builder found the `MSH` and echoed MSH-10 correctly while
the correlator, requiring `MSH` at byte 0, gave up. Every such disagreement is an ACK the
sender cannot match → timeout → resend → **duplicate clinical message**.

The fix is one scan, but note *which* scan. The first attempt made them agree by
requiring `MSH` at byte 0 everywhere, which "resolved" the leading-`CR` disagreement by
degrading the side that had been **right**: `buildRawAck` began emitting a positive `AA`
with an empty MSA-2, silently, for a message whose MSH-10 was plainly present. Agreement
is not the goal; agreeing on the *correct*, *tolerant* answer is. A lenient reader may
never drop data that is there (Postel's Law, CLAUDE.md).

**The fail-safe downgrade: never a positive `AA`/`CA` it cannot correlate**

A positive acknowledgement is a promise the sender may forget the message. If it names a
control ID the sender cannot match, or names one message out of several it never read,
the sender times out and resends, committing a **duplicate clinical message**. So a
requested positive code is **downgraded** to its non-positive counterpart (`AA`→`AE`,
`CA`→`CE`) whenever the payload cannot carry a correlatable positive ACK: no readable
`MSH`, an empty MSH-10, or a batch/concatenated-message shape that a single MSA-2 cannot
acknowledge. See [rawAckUncorrelatable](#rawackuncorrelatable) for the exact conditions and why each is a
refusal rather than a widened reader. A requested **negative** code (`AE`/`AR`/`CE`/`CR`)
is never touched. This mirrors the parser-backed `buildMllpAck`, which downgrades and
warns on an unparseable inbound, the two builders' fail-safe semantics now agree.

**Never throws** and **never copies payload content** beyond the routing/control
metadata above, `readMshSegment` stops at the MSH's segment terminator, so no field of
any later segment (PID and friends) can be reached, let alone echoed. On a missing or
unreadable `MSH` it returns a minimal well-formed ACK carrying the (downgraded) `code` so
the caller can still respond.

#### Parameters

##### payload

`Buffer`

Raw decoded HL7 v2 payload bytes (MLLP framing already stripped).

##### code

[`AckCode`](#ackcode-3)

Requested MSA-1 acknowledgement code. A positive `AA`/`CA` is downgraded to
  `AE`/`CE` when the message cannot be correlated (see above).

#### Returns

`Buffer`

ACK payload bytes (no framing, the caller wraps with `encodeFrame`).

#### Example

```typescript
import { buildRawAck } from '@cosyte/mllp';
const ack = buildRawAck(inboundPayload, 'AE'); // MSA|AE|<inbound MSH-10>|message could not be processed
```

***

### canonicalAcknowledgement()

> **canonicalAcknowledgement**(): `Buffer`

The canonical positive acknowledgement, unframed, freshly built on every call.

This is what a conformant Release 1 peer's answer to the first canonical exchange looks
like on the wire once the framing is stripped. The harness never sends it; it is here so
a test double, or a consumer building one, can answer with the shape the package itself
emits.

#### Returns

`Buffer`

The unframed acknowledgement bytes.

#### Example

```typescript
import { canonicalAcknowledgement, encodeFrame } from '@cosyte/mllp';
const wire = encodeFrame(canonicalAcknowledgement());
// wire[0] === 0x0b
```

***

### canonicalExchanges()

> **canonicalExchanges**(): readonly [`CanonicalExchange`](#canonicalexchange)[]

The canonical exchange corpus, freshly built on every call so a caller cannot mutate the
corpus another caller will send.

Two messages, both drawn from the framing goldens this package already pins itself
against, so what a consumer sends at their own engine is byte-identical to what this
package's own framing tests assert. The positive acknowledgement golden is deliberately
NOT one of them: it is the reference ANSWER (see [canonicalAcknowledgement](#canonicalacknowledgement)), and
an engine that correctly declines to acknowledge an unsolicited acknowledgement would
otherwise be reported as having failed to answer.

#### Returns

readonly [`CanonicalExchange`](#canonicalexchange)[]

One entry per exchange, in the order the harness runs them.

#### Example

```typescript
const exchanges = canonicalExchanges();
// exchanges.map((e) => e.id) is ['adt-a01', 'oru-r01']
```

***

### createClient()

> **createClient**(`opts`): [`MllpClient`](#mllpclient)

Create an [MllpClient](#mllpclient). Equivalent to `new MllpClient(opts)`.

#### Parameters

##### opts

[`ClientOptions`](#clientoptions)

#### Returns

[`MllpClient`](#mllpclient)

#### Example

```typescript
import { createClient } from '@cosyte/mllp';

const client = createClient({ host: 'localhost', port: 2575 });
await client.connect();
const ack = await client.send(payloadBuffer);
await client.close();
```

***

### createServer()

> **createServer**(`opts?`): [`MllpServer`](#mllpserver)

Factory function, creates a new `MllpServer` with the supplied options.

Prefer `createServer()` over `new MllpServer()` for forward-compatible construction.

#### Parameters

##### opts?

[`ServerOptions`](#serveroptions) = `{}`

#### Returns

[`MllpServer`](#mllpserver)

#### Example

```typescript
import { createServer } from '@cosyte/mllp';

const server = createServer({
  onMessage: (payload, meta, conn) => {
    console.log('received', payload.length, 'bytes');
  },
});
await server.listen(2575);
```

***

### createStarterClient()

> **createStarterClient**(`opts`): `Promise`\<[`MllpClient`](#mllpclient)\>

Three-line MLLP client with batteries-included defaults. The returned
client is already CONNECTED, `connect()` has been awaited.

Defaults:
- `autoReconnect: true`
- `ackTimeoutMs: 30_000`
- `correlateByControlId: false` (FIFO mode, simplest mental model)
- `pipeline: true`
- `highWaterMark: 64`
- `onBackpressure: 'reject'`
- `handleSignals: false` (opt-in)

The factory is **async**, so the literal three-line north-star snippet
has an explicit `await` BEFORE `createStarterClient(...)`, without it,
the `using` declaration would receive a `Promise`, not an `MllpClient`,
and `Symbol.asyncDispose` would not run at scope exit.

#### Parameters

##### opts

[`StarterClientOptions`](#starterclientoptions)

#### Returns

`Promise`\<[`MllpClient`](#mllpclient)\>

#### Example

```typescript
import { createStarterClient } from '@cosyte/mllp';
await using c = await createStarterClient({ host: 'localhost', port: 2575 });
const ack = await c.send(payloadBuffer);
```

***

### createStarterServer()

> **createStarterServer**(`opts`): `Promise`\<[`MllpServer`](#mllpserver)\>

Starter factory, creates, configures, and starts an `MllpServer` in one call.

Provides the "three lines of code" north-star experience with sensible defaults:
`autoAck: 'AA'`, `drainTimeoutMs: 30_000`, `Symbol.asyncDispose` wired.

#### Parameters

##### opts

[`StarterServerOptions`](#starterserveroptions)

#### Returns

`Promise`\<[`MllpServer`](#mllpserver)\>

#### Example

```typescript
import { createStarterServer } from '@cosyte/mllp';

const server = await createStarterServer({
  port: 2575,
  onMessage: async (payload) => {
    await db.commit(payload); // the durable-commit step; a throw answers a negative ACK
  },
});
```

***

### createWarning()

> **createWarning**(`code`, `byteOffset`, `message`): [`MllpWarning`](#mllpwarning)

Create a frozen `MllpWarning` object. The returned object is `Object.freeze()`'d
so subscribers cannot mutate shared warning state.

`connectionId` is always `undefined` here; `Connection` enriches it via
`{ ...w, connectionId: this.connectionId }` then re-freezes.

#### Parameters

##### code

[`WarningCode`](#warningcode)

##### byteOffset

`number`

##### message

`string`

#### Returns

[`MllpWarning`](#mllpwarning)

#### Example

```typescript
const w = createWarning('MLLP_EMPTY_PAYLOAD', 64, 'Empty payload between VT and FS');
// w.connectionId === undefined
```

***

### differentialConfigurationMessage()

> **differentialConfigurationMessage**(`code`): `string`

Fixed, human-readable description for a differential-configuration code.

Byte-for-byte identical for a given code, whatever was configured.

#### Parameters

##### code

`"MLLP_DIFF_PEER_UNPARSEABLE"`

The stable configuration-error code.

#### Returns

`string`

The frozen registry text for `code`.

#### Example

```typescript
import { differentialConfigurationMessage, MLLP_DIFF_PEER_UNPARSEABLE } from '@cosyte/mllp';
logger.error(differentialConfigurationMessage(MLLP_DIFF_PEER_UNPARSEABLE));
```

***

### encodeFrame()

> **encodeFrame**(`payload`, `opts?`): `Buffer`

Encode `payload` in canonical MLLP framing: `VT (0x0B) + payload + FS (0x1C) + CR (0x0D)`.

Strict by default: throws `MllpFramingError` if the payload contains VT or FS bytes.
Set `{ allowDelimiterBytesInPayload: true }` to pass those bytes through verbatim
and receive an `MllpWarning` per offending byte via `onWarning` instead.

The returned Buffer has length `payload.length + 3`. Bytes at positions 1 through
`payload.length` are an exact copy of the payload (independent of the input buffer).

#### Parameters

##### payload

`Buffer`

##### opts?

[`EncoderOptions`](#encoderoptions)

#### Returns

`Buffer`

#### Throws

with code `MLLP_PAYLOAD_CONTAINS_VT` when payload contains
  byte `0x0B` and `allowDelimiterBytesInPayload` is `false` (default).

#### Throws

with code `MLLP_PAYLOAD_CONTAINS_FS` when payload contains
  byte `0x1C` and `allowDelimiterBytesInPayload` is `false` (default).

#### Example

```typescript
import { encodeFrame } from '@cosyte/mllp';

// Strict (default), throws on delimiter bytes in payload
const frame = encodeFrame(Buffer.from('MSH|^~\\&|SEND|FAC|RECV|FAC|...'));
socket.write(frame);

// Tolerant, passes delimiter bytes through with a warning
const frame2 = encodeFrame(dirtyPayload, {
  allowDelimiterBytesInPayload: true,
  onWarning: (w) => logger.warn(w),
});
```

***

### isTlsProtocolError()

> **isTlsProtocolError**(`err`): `boolean`

Detects **TLS-protocol-shaped** errors, failures of the TLS protocol
itself, as opposed to plain TCP-level network failures.

Apply this only to errors raised on a **TLS** connection; `MllpClient`
does exactly that (the predicate is consulted only when `ClientOptions.tls`
is set). The boundary:

**TLS-protocol-shaped (`true`):**
- `code` starting `ERR_SSL_` (Node's TLS alert codes, e.g.
  `ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED`, a `clientAuth: 'MUST'`
  server rejecting the client's certificate).
- `code === 'EPROTO'`, on a TLS connection this is OpenSSL failing the
  handshake (protocol version mismatch, no shared cipher, a TLS ≤1.2
  mTLS rejection).
- `message` containing `ssl` or `alert` (`/\bssl\b|\balert\b/i`, "SSL
  routines", "tlsv13 alert certificate required", …). This message check
  is a **heuristic backstop** over the code-based checks above, not a
  precise boundary: it exists to catch OpenSSL errors that surface without
  a usable `code`, and `MllpClient` consults it only on connections where
  TLS is configured. An arbitrary non-TLS error whose message happens to
  contain those words would also match.

**NOT TLS-protocol-shaped (`false`), plain network failures, which stay
transient for the reconnect classifier:** `ECONNREFUSED`, `ETIMEDOUT`,
`EHOSTUNREACH`, `ENETUNREACH`, `EPIPE`, and a plain `ECONNRESET` carrying
no TLS alert context, a network blip during (or after) a handshake
should still auto-heal.

Certificate-**verification** failures are a separate class, see
[isTlsVerificationErrorCode](#istlsverificationerrorcode); `MllpClient` checks that first and
labels those `connectionCause: 'tls-verify'`.

Why this matters: under TLS 1.3 (RFC 8446 §4.4.2) a `clientAuth: 'MUST'`
server can reject the client's certificate AFTER the client's own
`'secureConnect'`, the rejection then surfaces as a post-connect socket
error. A misconfigured mTLS client must never auto-reconnect-loop against
a server that will always reject it, so `MllpClient` classifies
TLS-protocol-shaped errors as **permanent**.

#### Parameters

##### err

`unknown`

#### Returns

`boolean`

#### Example

```typescript
import { isTlsProtocolError, MllpConnectionError } from '@cosyte/mllp';
client.on('error', ({ error }) => {
  if (error instanceof MllpConnectionError && isTlsProtocolError(error.cause)) {
    // TLS protocol failure, a configuration problem, not a network blip.
  }
});
```

***

### isTlsVerificationErrorCode()

> **isTlsVerificationErrorCode**(`code`): `boolean`

Set of Node/OpenSSL error codes that indicate a **certificate-verification**
failure (as opposed to some other TLS handshake failure), untrusted chain,
expired/not-yet-valid certificate, hostname mismatch, revocation, etc.

Used by `MllpClient` to classify a TLS connect failure's
`connectionCause` as `'tls-verify'` (this set) vs `'tls-handshake'`
(everything else observed before `'secureConnect'`). Exported so callers
can apply the same classification to their own error handling.

#### Parameters

##### code

`string`

#### Returns

`boolean`

#### Example

```typescript
import { isTlsVerificationErrorCode } from '@cosyte/mllp';
if (isTlsVerificationErrorCode('CERT_HAS_EXPIRED')) {
  // definitely a verification failure, not a protocol/cipher mismatch
}
```

***

### isTransientConnectionError()

> **isTransientConnectionError**(`err`): `boolean`

Classifies a connection error as transient (eligible for auto-reconnect)
or permanent (halts auto-reconnect, transitions to CLOSED).

Used internally by `MllpClient` BEFORE invoking `retryStrategy`
(see `RetryContext.classifiedAs`). Re-exported so callers can implement
their own retry policies.

Classification table:
- `ENOTFOUND`, `EACCES` → **permanent** (`false`)
- `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
  `ENETUNREACH`, `EPIPE` → **transient** (`true`). An expired
  `ClientOptions.connectTimeoutMs` is one of these: its error carries
  `ETIMEDOUT`, the code of the operating system's own connect timeout.
- `CERT_*` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
  `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN`
  (any [isTlsVerificationErrorCode](#istlsverificationerrorcode) code) → **permanent** (`false`),
  never auto-reconnect-loop into a misconfigured or MITM'd endpoint.
- `ERR_SSL_*` (Node TLS alert codes) → **permanent** (`false`), a TLS
  protocol failure such as a `clientAuth: 'MUST'` server rejecting the
  client certificate recurs on every attempt. On TLS-configured
  connections `MllpClient` additionally consults [isTlsProtocolError](#istlsprotocolerror),
  which also catches `EPROTO`/alert-bearing OpenSSL errors that this
  generic classifier (which cannot know the connection was TLS) leaves
  transient.
- `MLLP_*` (any [MllpFramingError](#mllpframingerror) code, a fatal decoder throw, surfaced with
  `connectionCause: 'framing-fatal'`) → **permanent** (`false`). The peer is not
  speaking MLLP, an HTTP probe, a health check, a wrong-port misconfiguration, or is emitting
  frames past `maxFrameSizeBytes`. Every reconnect meets the same bytes, so retrying is an
  unbounded storm against a peer that is already misconfigured. If a peer's quirk is *expected*,
  the decoder's tolerance opt-ins are the supported answer, they make it a warning, not a fatal.
- non-Error / unknown / no-code → **transient** (`true`), Postel's Law
  default. Reconnect attempts are bounded by `retryStrategy` and the
  30s backoff cap, so the default is safe.

#### Parameters

##### err

`unknown`

#### Returns

`boolean`

#### Example

```typescript
import { isTransientConnectionError } from '@cosyte/mllp';
client.on('error', (err) => {
  if (isTransientConnectionError(err)) {
    metrics.increment('mllp.transient_error');
  } else {
    metrics.increment('mllp.permanent_error');
  }
});
```

***

### rawAckUncorrelatable()

> **rawAckUncorrelatable**(`payload`): `boolean`

True iff a **positive** raw acknowledgement (`AA`/`CA`) cannot be safely correlated to
this payload, so [buildRawAck](#buildrawack) (and the server's auto-ACK path) must **downgrade**
it to a non-positive `AE`/`CE` rather than tell the sender "I have it."

The rule this enforces: **never answer `AA` for a message you could not correlate.** A
positive ACK is a promise the sender may forget the message; if it names a control ID
the sender cannot match, or names one of several messages it never read, the sender
times out and resends, committing a **duplicate clinical message** (or worse, believes a
destroyed message was delivered). Three payload-shaped reasons make a positive ACK
uncorrelatable, all peer-reachable off the wire:

  1. **No readable `MSH`.** `readMshSegment` returns `null`, e.g. a `BOM`/`SP`/`TAB`
     before `MSH` (which shares the `MSH`'s segment line, so `MSH` heads no segment), or
     a bare fragment delivered after a mid-payload `VT` discard (`MLLP_TRAILING_BYTES`).
     MSA-2 would be empty: an ACK that correlates to nothing.
  2. **Empty MSH-10.** The `MSH` is readable but carries no message control ID, so there
     is nothing to echo, again `MSA|AA|` with an empty MSA-2.
  3. **A batch or concatenated messages.** An `FHS`/`BHS`/`BTS`/`FTS` envelope (§2.10.3)
     or a second `MSH` in the same frame: a single MSA-2 can echo only ONE control ID, so
     a positive ACK naming the first silently drops the rest (see
     containsBatchOrExtraMessage). Batch ACK is its own feature; until it is
     designed, a batch must stay a **loud non-positive** answer.

This is a **refusal**, not a tolerance widening: it never makes an unreadable message
readable, never re-bases on a located `MSH`, never parses a batch. It only recognizes
the shapes for which a positive disposition would be a lie, so the builder can fall back
to `AE`. A **negative** requested code (`AE`/`AR`/`CE`/`CR`) is unaffected, it is
already non-positive, and echoing whatever control ID it can find is still useful.

Pure, byte-level, never throws.

#### Parameters

##### payload

`Buffer`

#### Returns

`boolean`

#### Example

```typescript
import { rawAckUncorrelatable } from '@cosyte/mllp';
rawAckUncorrelatable(oneGoodMessage); // false → AA is safe
rawAckUncorrelatable(twoConcatenatedMsh); // true → downgrade AA to AE
```

***

### readNegotiatedTlsParameters()

> **readNegotiatedTlsParameters**(`socket`, `host`, `port`): [`NegotiatedTlsParameters`](#negotiatedtlsparameters) \| `null`

Read the negotiated parameters off a socket whose handshake has completed.

Returns `null` for a socket that is not a TLS socket at all, and for a TLS
socket with no session to report. That is what keeps a plaintext connection
from producing an event: it is a structural property of the read, not a
caller-side condition anyone has to remember.

#### Parameters

##### socket

`Socket` \| `TLSSocket`

The socket whose handshake completed; plaintext is allowed and yields `null`.

##### host

`string`

Routing metadata for the payload's `host`.

##### port

`number`

Routing metadata for the payload's `port`.

#### Returns

[`NegotiatedTlsParameters`](#negotiatedtlsparameters) \| `null`

A frozen payload, or `null` when there is nothing negotiated to report.

#### Example

```typescript
const params = readNegotiatedTlsParameters(tlsSocket, 'mllp.example.com', 2575);
if (params !== null) logger.info({ suite: params.cipherSuite });
```

***

### resolveDifferentialPeer()

> **resolveDifferentialPeer**(`raw`): [`DifferentialPeer`](#differentialpeer) \| `undefined`

Resolve a configured peer address into a host and a port.

The address is split on its **last** colon, so an IPv6 literal resolves as well as a
host name: `[::1]:2575` and `::1:2575` both give host `::1`. A naive split on the first
colon mangles the host and produces a NaN port, which is precisely how a live run gets
skipped while the operator believes it happened.

#### Parameters

##### raw

`string` \| `null` \| `undefined`

The configured address, or `undefined`/`null`/empty for no peer at all.

#### Returns

[`DifferentialPeer`](#differentialpeer) \| `undefined`

The resolved peer, or `undefined` when no peer is configured.

#### Throws

MllpDifferentialConfigurationError when an address is present and unusable.

#### Example

```typescript
import { resolveDifferentialPeer } from '@cosyte/mllp';
const peer = resolveDifferentialPeer('127.0.0.1:2575');
// peer?.host === '127.0.0.1'; peer?.port === 2575
// resolveDifferentialPeer(undefined) === undefined
```

***

### resolveNackCode()

> **resolveNackCode**(`err`): [`NegativeAckCode`](#negativeackcode)

Resolve the negative acknowledgement code for a handler failure.

An [MllpAckError](#mllpackerror) carries an explicit `ackCode`; any other thrown value maps to
`AE` (application error, the default, since most handler failures are transient and
a resend may succeed).

#### Parameters

##### err

`unknown`

#### Returns

[`NegativeAckCode`](#negativeackcode)

#### Example

```typescript
import { resolveNackCode, MllpAckError } from '@cosyte/mllp';
resolveNackCode(new Error('boom'));                          // 'AE'
resolveNackCode(new MllpAckError('nope', { ackCode: 'AR' })); // 'AR'
```

***

### resolveTlsCipherPolicy()

> **resolveTlsCipherPolicy**(`opts`, `side`): [`ResolvedTlsCipherPolicy`](#resolvedtlscipherpolicy)

Resolve the offered-cipher-suite policy for one side of a connection, and
prove the runtime accepts it before any socket is opened.

Refuses, rather than picking a winner, when both `atnaTransportSecurity` and
`ciphers` are set: each declares the offered list, and honouring one would
silently discard the other on a link whose whole point is being able to say
what it offered.

**Diffie-Hellman parameters are the one place a winner IS picked, and the
caller wins.** `atnaTransportSecurity: true` selects a group automatically
because two of its four suites are DHE; a caller that also names its own
group is stating site policy, and site policy is more specific than a default
this package chose. So the two are not in conflict and the configuration is
accepted with the caller's group in force.

Each input is validated **alone**, with no certificate, key or passphrase in
scope, so a rejection can only ever be about that input and the error it
raises cannot carry credential material.

#### Parameters

##### opts

[`TlsCipherPolicyInput`](#tlscipherpolicyinput)

The cipher-suite half of the caller's TLS options.

##### side

`"client"` \| `"server"`

Which end of the connection is being configured.

#### Returns

[`ResolvedTlsCipherPolicy`](#resolvedtlscipherpolicy)

The TLS-context fields to spread into `tls.connect` / `tls.createServer`.
**A runtime that would not enforce what was asked for is refused too.** Before
a list or parameters are handed over, probes with no caller input in scope
prove that this runtime's TLS library enforces that kind of input at all; one
that would accept it and then run without it (a `node:tls` that takes a list
and offers its own) gets an `_UNENFORCEABLE` code instead of a link that is
not what it says. Node.js passes every probe.

#### Throws

On a conflicting declaration, a list the
runtime rejects, Diffie-Hellman parameters it cannot use, or a list or
parameters this runtime does not enforce. Never falls back to the runtime
default list, and never to a server with no Diffie-Hellman parameters.

#### Example

```typescript
import { resolveTlsCipherPolicy } from '@cosyte/mllp';
const policy = resolveTlsCipherPolicy({ atnaTransportSecurity: true }, 'server');
console.log(policy.dhparam); // => 'auto'
```

***

### runDifferential()

> **runDifferential**(`options?`): `Promise`\<[`DifferentialReport`](#differentialreport)\>

Run the canonical exchanges against a peer and report what was observed.

With no peer configured the run skips cleanly and returns a report saying so, so a
default verification stays green on a machine that has no engine to point at. With a
peer configured that cannot be resolved into a host and a port, the run is refused by
name instead of skipped.

The returned report is frozen and JSON-serializable, and carries no content read off the
peer: deviations are named by stable code and byte offset, never by quoting bytes.

**The run sends synthetic patient messages into whatever engine it is aimed at.** Aim it
at a test or staging endpoint.

#### Parameters

##### options?

[`DifferentialRunOptions`](#differentialrunoptions) = `{}`

Peer address, deadline, corpus, connection factory and abort signal.

#### Returns

`Promise`\<[`DifferentialReport`](#differentialreport)\>

The report for the whole run, whatever each exchange did.

#### Throws

MllpDifferentialConfigurationError when a peer address is configured and unusable.

#### Example

```typescript
import { runDifferential } from '@cosyte/mllp';
const report = await runDifferential({ peer: process.env['MLLP_DIFF_PEER'] });
console.log(JSON.stringify(report, null, 2));
```

***

### selectAckCode()

> **selectAckCode**(`input`): [`AckCodeSelection`](#ackcodeselection)

Select the acknowledgement code for a message from its MSH-15, MSH-16 and what the application
did with it, by the table the server's auto-ACK uses.

Rows are MSH-15, columns the outcome:

| MSH-15             | `AA`  | `AE`  | `AR`  |
| ------------------ | ----- | ----- | ----- |
| NULL               | `AA`  | `AE`  | `AR`  |
| `NE`               | `AA`  | `AE`  | `AR`  |
| `AL`               | `CA`  | `CE`  | `CR`  |
| `ER`               | `AA`  | `CE`  | `CR`  |
| `SU`               | `CA`  | `AE`  | `AR`  |
| outside Table 0155 | `AA`  | `AE`  | `AR`  |

MSH-16 never changes the code; it decides [AckCodeSelection.applicationAckRequested](#applicationackrequested).

Two things the server does are not in this function, because they are about the whole message
rather than its fields: a batch or concatenated frame keeps its warned non-positive answer, and
a message with no usable MSH-10 is never answered positively. A caller building its own
acknowledgement for such a message applies those rules itself.

#### Parameters

##### input

[`AckCodeSelectionInput`](#ackcodeselectioninput)

MSH-15, MSH-16, the message's MSH-2 and the outcome.

#### Returns

[`AckCodeSelection`](#ackcodeselection)

The code to send, the mode, whether an application acknowledgement is asked for, and
  whether either field held a value outside Table 0155.

#### Throws

when `outcome` is not `AA`, `AE` or `AR`. The message does not repeat the
  value.

#### Example

```typescript
import { selectAckCode } from '@cosyte/mllp';
selectAckCode({ msh15: 'AL', msh16: 'AL', outcome: 'AA' }).code; // 'CA'
selectAckCode({ msh15: 'ER', outcome: 'AA' }).code;               // 'AA'
selectAckCode({ msh15: 'ER', outcome: 'AE' }).code;               // 'CE'
selectAckCode({ outcome: 'AR' }).code;                            // 'AR'
```

***

### tlsConfigurationMessage()

> **tlsConfigurationMessage**(`code`): `string`

Fixed, human-readable description for a TLS-configuration code.

Byte-for-byte identical for a given code, whatever the configuration was.

#### Parameters

##### code

[`TlsConfigurationErrorCode`](#tlsconfigurationerrorcode)

The stable configuration-error code.

#### Returns

`string`

The fixed registry text for `code`.

#### Example

```typescript
import { tlsConfigurationMessage, MLLP_TLS_CIPHER_OPTION_CONFLICT } from '@cosyte/mllp';
logger.error(tlsConfigurationMessage(MLLP_TLS_CIPHER_OPTION_CONFLICT));
```
