# src/testing

In-memory transport utilities for deterministic, socket-free tests.

Import from `@cosyte/mllp/testing`:

## Example

```typescript
import { InMemoryTransport } from '@cosyte/mllp/testing';

const [a, b] = InMemoryTransport.pair();
b.onData((chunk) => b.write(chunk)); // echo
a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
```

## Classes

### InMemoryTransport

Deterministic in-memory transport for socket-free tests.

Create connected pairs with `InMemoryTransport.pair()`. Writes to one end
deliver synchronously to the other end's `onData` handler, no async ceremony,
no `await` needed in tests.

Supports `split(n)` for chunked-read simulation, `pause()`/`resume()` for
backpressure simulation, and `destroy(reason)` for abrupt-disconnect simulation.

#### Example

```typescript
const [client, server] = InMemoryTransport.pair();
server.onData((chunk) => server.write(chunk)); // echo
client.onData((echo) => console.log('echo:', echo));
client.write(Buffer.from('hello'));
```

#### Implements

- [`Transport`](../src.md#transport-1)

#### Methods

##### close()

> **close**(): `void`

Initiate graceful close, fires `onClose` on this end and on the peer,
simulating a TCP FIN exchange.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`close`](../src.md#close-5)

##### destroy()

> **destroy**(`reason?`): `void`

Abruptly destroy this transport end.

Fires `onError(reason)` then `onClose` on this end only. Does NOT affect
the peer (simulates one-sided abrupt disconnect, e.g., ECONNRESET on
just one socket).

###### Parameters

###### reason?

`Error`

Optional error; defaults to `new Error('InMemoryTransport destroyed')`.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`destroy`](../src.md#destroy-4)

##### onClose()

> **onClose**(`fn`): `void`

Register the close handler. Replaces any previously registered handler.

###### Parameters

###### fn

() => `void`

Called when `close()` or `destroy()` is invoked on this end,
  or when the peer calls `close()`.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`onClose`](../src.md#onclose-2)

##### onConnect()

> **onConnect**(`fn`): `void`

Register the connect handler. Replaces any previously registered handler.
Use `simulateConnect()` to trigger this in tests.

###### Parameters

###### fn

() => `void`

Called when `simulateConnect()` is invoked on this end.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`onConnect`](../src.md#onconnect-2)

##### onData()

> **onData**(`fn`): `void`

Register the data handler. Replaces any previously registered handler.

###### Parameters

###### fn

(`chunk`) => `void`

Called with each chunk delivered by the peer.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`onData`](../src.md#ondata-2)

##### onError()

> **onError**(`fn`): `void`

Register the error handler. Replaces any previously registered handler.

###### Parameters

###### fn

(`err`) => `void`

Called when `destroy(reason)` is invoked on this end.

###### Returns

`void`

###### Implementation of

[`Transport`](../src.md#transport-1).[`onError`](../src.md#onerror-2)

##### pause()

> **pause**(): `void`

Pause delivery.

While paused, writes directed at this transport are queued internally and
the `onData` handler is NOT called. The queued chunks are flushed on `resume()`.

###### Returns

`void`

###### Example

```typescript
b.pause();
a.write(buf); // queued, b.onData not called
b.resume();   // flushes queue synchronously
```

##### resume()

> **resume**(): `void`

Resume delivery, flushes all queued chunks to the `onData` handler,
synchronously, in the order they were written.

###### Returns

`void`

##### simulateConnect()

> **simulateConnect**(): `void`

Fire the `onConnect` handler on this end.

Call after `pair()` to simulate TCP connect completion. In production code,
`NetTransport` fires the handler automatically when the socket emits `'connect'`.

###### Returns

`void`

###### Example

```typescript
const [a] = InMemoryTransport.pair();
a.onConnect(() => console.log('connected'));
a.simulateConnect(); // fires immediately
```

##### split()

> **split**(`bytesPerChunk`): `void`

Simulate chunked TCP reads.

After calling `split(n)`, any `write()` directed at this transport will be
delivered to the `onData` handler in chunks of `n` bytes rather than
all at once. Useful for verifying that a `FrameReader` reassembles frames
correctly across chunk boundaries.

###### Parameters

###### bytesPerChunk

`number`

Chunk size in bytes. Pass `0` to disable chunking.

###### Returns

`void`

###### Example

```typescript
const [a, b] = InMemoryTransport.pair();
b.split(1); // b receives one byte at a time
a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d])); // fires b.onData 4 times
```

##### write()

> **write**(`buf`): `boolean`

Write `buf` to the peer transport.

If the peer is paused, the buffer is copied and queued, returns `false`
(backpressure signal). Otherwise, the peer's `onData` handler fires
synchronously before this method returns.

###### Parameters

###### buf

`Buffer`

###### Returns

`boolean`

`true` if delivered immediately; `false` if queued or transport is destroyed.

###### Implementation of

[`Transport`](../src.md#transport-1).[`write`](../src.md#write-2)

##### pair()

> `static` **pair**(): \[[`InMemoryTransport`](#inmemorytransport), [`InMemoryTransport`](#inmemorytransport)\]

Create two connected InMemoryTransport ends.

Writes to `a` deliver to `b`'s `onData` handler synchronously (and vice versa).
Call `a.simulateConnect()` after `pair()` to fire the `onConnect` handler,
simulating TCP connect completion.

###### Returns

\[[`InMemoryTransport`](#inmemorytransport), [`InMemoryTransport`](#inmemorytransport)\]

Tuple `[a, b]` of two connected transports.

###### Example

```typescript
const [a, b] = InMemoryTransport.pair();
b.onData((chunk) => b.write(chunk)); // echo server
a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
```
