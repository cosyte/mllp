---
id: reliability
title: Connection, reconnect & backpressure
sidebar_position: 4
---

# Connection, reconnect & backpressure

An MLLP link lives for months and fails in ways a request/response client never sees: the peer
half-closes and never tells you, a firewall silently evicts the NAT entry, an interface engine gets
restarted nightly. This page covers what `@cosyte/mllp` does about that, and (just as importantly)
what it hands back to you.

## The connection is an explicit state machine

Never socket flags. `connection.state` is exactly one of six values, and the legal transitions are
exactly these:

```
CONNECTING    → CONNECTED | RECONNECTING | CLOSED
CONNECTED     → DRAINING | RECONNECTING | DISCONNECTED | CLOSED
DRAINING      → DISCONNECTED | CLOSED
RECONNECTING  → CONNECTING | CLOSED
DISCONNECTED  → CLOSED          ← note: DISCONNECTED does NOT go back to RECONNECTING
CLOSED        → (terminal)
```

| State | Meaning |
|---|---|
| `CONNECTING` | Socket (and TLS handshake, if any) in progress. |
| `CONNECTED` | Framing both ways; sends permitted. |
| `DRAINING` | Graceful shutdown: no new sends, in-flight ACKs still awaited. |
| `RECONNECTING` | Waiting out backoff before the next attempt. |
| `DISCONNECTED` | Down, not (yet) retrying. |
| `CLOSED` | **Terminal.** Never re-enters any other state. |

Every transition emits a frozen `'stateChange'` event with `{ from, to, reason }`, which is what you
put on a dashboard. Like every public event payload in this package, it is `Object.freeze`'d;
subscribers cannot mutate shared state.

```ts
client.on("stateChange", ({ from, to, reason }) => logger.info({ from, to, reason }));
```

**What you will actually observe on a client reconnect.** `MllpClient` builds a **fresh
`Connection`** for each attempt rather than cycling one connection through `RECONNECTING`. So the
`stateChange` stream you see across a reconnect is `CONNECTED → DISCONNECTED` on the old connection,
then `CONNECTING → CONNECTED` on the new one. The client's own **`'reconnecting'` event** is what
tells you a retry is in progress. Dashboard on that, not on a `RECONNECTING` state you will not see.

## Auto-reconnect

`createClient` leaves it **off**. Pass `autoReconnect: true` to opt in. **`createStarterClient`
turns it on for you** (it is the batteries-included path), so if you started from the quickstart you
already have it.

```ts
const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  autoReconnect: true,
  initialDelayMs: 100, // default
  maxDelayMs: 30_000, // default cap
  multiplier: 2, // default
  jitter: 0.2, // default ±20%
});
```

Backoff is exponential with jitter, capped at 30 s. Jitter is not decoration: without it, a hospital
network blip reconnects every client on the floor in the same millisecond and you have built a
thundering herd against an interface engine that is already unwell.

**Only transient errors are retried.** The classifier (exported as `isTransientConnectionError`)
distinguishes a network blip (retry it) from a permanent, *configuration-shaped* failure.
Auto-reconnecting into a misconfiguration is not resilience; it is an infinite loop against an
endpoint that cannot possibly answer, and the backoff turns it into a storm.

Classified **permanent** (reconnection halts):

| Cause | Why retrying is pointless |
|---|---|
| `tls-verify` | Certificate verification failed. The next attempt meets the same certificate. |
| `tls-handshake` | TLS protocol failure (`ERR_SSL_*`, `EPROTO`, OpenSSL alerts). Same. |
| `framing-fatal` | The peer is not speaking MLLP (an HTTP probe, a health check, a wrong-port misconfiguration) or is emitting frames past the size cap. Every reconnect meets the same bytes. |
| `ENOTFOUND`, `EACCES` | The name does not resolve; the port is not permitted. |

Everything else (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `EPIPE`, …) is treated as transient and
retried: Postel's Law, applied to peer behavior.

Supply `retryStrategy` for full control. It receives a frozen `RetryContext` and returns the next
delay, or `null` to stop retrying.

## Detecting a peer that is gone but not closed

Two independent, complementary mechanisms, both off by default, and they are not substitutes:

- **`keepaliveIntervalMs`**: OS-level TCP keepalive (`socket.setKeepAlive`). Catches the cases where
  no bytes flow at all: half-open sockets, network partitions, NAT eviction. Cheap; costs nothing
  when the link is healthy.
- **`deadPeerTimeoutMs`**: application-level idle timeout, keyed on last inbound activity. Catches
  the case TCP cannot see: the socket is *fine*, the peer process is wedged and simply not
  answering. On trip, the connection is destroyed and (if `autoReconnect` is on) reconnects.

A quiet MLLP link is normal at 3 a.m. Set `deadPeerTimeoutMs` above your genuine idle period, or a
healthy connection will be torn down all night.

## Backpressure

If a peer stops ACKing but the socket still accepts writes, an unbounded client buffers every message
your application hands it until the process dies. `@cosyte/mllp` bounds the in-flight + queued set.

```ts
const client = createClient({
  host,
  port,
  highWaterMark: 64, // default: max 64 in-flight + queued
  onBackpressure: "reject", // default
});
```

`highWaterMark` takes a count (`64`), a byte cap (`{ bytes: 8 * 1024 * 1024 }`), or both
(`{ count, bytes }`, the stricter of the two wins). At the cap, `onBackpressure` decides:

- **`'reject'` (default)**: `send()` rejects with `MllpBackpressureError`. Your application learns
  immediately that it is producing faster than the peer can accept, and can shed load, spill to a
  queue, or page someone. This is the honest default.
- **`'wait'`**: `send()` awaits the `'drain'` event, the per-message `ackTimeoutMs`, or your
  `AbortSignal`, whichever fires first. Convenient, and the right choice when your producer *can*
  slow down, but it converts backpressure into latency, so bound it.

Set `pipeline: false` to collapse the in-flight set to one: strict send → await-ACK → send. Slower,
and required by peers that cannot handle concurrent messages on one connection.

## Shutdown, and what it does *not* do for in-flight messages

⚠️ **Read this before you rely on `close()` during a deploy.**

`close()` **rejects every in-flight send immediately**. It does *not* wait for their ACKs. Each
pending `send()` promise rejects with `MllpConnectionError({ phase: 'close' })`, and the connection
then closes. The `DRAINING` state exists in the machine, but no drain hook is wired to it today.
`drainTimeoutMs` (default 30 s) is therefore not currently what bounds an in-flight ACK wait on the
client, because there is no such wait.

**This means a message in flight at shutdown becomes an *unknown*, not a failure.** The rejection
tells you the send did not complete *locally*. It does **not** tell you the receiver did not commit
it. The message may well have been written, with the ACK arriving after you stopped listening. It
is the same at-least-once boundary as an ACK timeout, and it is resolved the same way: by the
receiver's idempotency on `MSH-10` + `MSH-7`, not by this library.

If you need in-flight messages to settle before you exit, **await them yourself** before calling
`close()`:

```ts
const inFlight = messages.map((m) => client.send(m));
await Promise.allSettled(inFlight); // settle first,
await client.close(); //                 then close
```

Every closeable implements `Symbol.asyncDispose`, and every awaitable takes an `AbortSignal`:

```ts
await using client = await createStarterClient({ host, port });
await client.send(payload, { signal: AbortSignal.timeout(5_000) });
// disposed on scope exit (including on throw). Note this closes, it does not drain
```

Server-side, `close()` stops accepting new connections and closes existing ones. A commit-gated
`onMessage` handler that is mid-`await` is **not** waited on, so the same rule applies: durability is
your handler's job, and it must not depend on the process staying alive to finish.

## Observability

`getStats()` returns **plain JSON-serializable objects** (no Buffers, no class instances) so they
go straight into a log pipeline or a metrics exporter.

```ts
logger.info(client.getStats());
```

Nothing in the stats, the warnings, or the frozen event payloads carries message content. See
[Framing](./framing.md) for the PHI contract on diagnostics.
