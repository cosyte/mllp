---
id: reliability
title: Connection, reconnect & backpressure
sidebar_position: 4
---

# Connection, reconnect & backpressure

An MLLP link lives for months and fails in ways a request/response client never sees: the peer
half-closes and never tells you, a firewall silently evicts the NAT entry, an interface engine gets
restarted nightly. This page covers what `@cosyte/mllp` does about that, and — just as importantly —
what it hands back to you.

## The connection is an explicit state machine

Never socket flags. `connection.state` is exactly one of six values:

```
CONNECTING → CONNECTED ⇄ DRAINING
                 ↓
           DISCONNECTED → RECONNECTING → CONNECTING
                 ↓
              CLOSED  (terminal)
```

| State | Meaning |
|---|---|
| `CONNECTING` | Socket (and TLS handshake, if any) in progress. |
| `CONNECTED` | Framing both ways; sends permitted. |
| `DRAINING` | Graceful shutdown: no new sends, in-flight ACKs still awaited. |
| `RECONNECTING` | Waiting out backoff before the next attempt. |
| `DISCONNECTED` | Down, not (yet) retrying. |
| `CLOSED` | **Terminal.** Never re-enters any other state. |

Every transition emits a frozen `'stateChange'` event with `{ from, to, reason }` — which is what you
put on a dashboard. Like every public event payload in this package, it is `Object.freeze`'d;
subscribers cannot mutate shared state.

```ts
client.on("stateChange", ({ from, to, reason }) => logger.info({ from, to, reason }));
```

## Auto-reconnect

Off by default — an explicit `autoReconnect: true` opts in.

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
distinguishes a network blip — retry it — from a permanent, *configuration-shaped* failure. TLS
verification failures (`connectionCause: 'tls-verify'`) and TLS protocol failures
(`'tls-handshake'`) are classified **permanent** and halt reconnection, transitioning to `CLOSED`.
Auto-reconnecting into a certificate error is not resilience; it is an infinite loop against an
endpoint that is either misconfigured or being MITM'd.

Supply `retryStrategy` for full control — it receives a frozen `RetryContext` and returns the next
delay, or `null` to stop retrying.

## Detecting a peer that is gone but not closed

Two independent, complementary mechanisms — both off by default, and they are not substitutes:

- **`keepaliveIntervalMs`** — OS-level TCP keepalive (`socket.setKeepAlive`). Catches the cases where
  no bytes flow at all: half-open sockets, network partitions, NAT eviction. Cheap; costs nothing
  when the link is healthy.
- **`deadPeerTimeoutMs`** — application-level idle timeout, keyed on last inbound activity. Catches
  the case TCP cannot see: the socket is *fine*, the peer process is wedged and simply not
  answering. On trip, the connection is destroyed and (if `autoReconnect` is on) reconnects.

A quiet MLLP link is normal at 3 a.m. — set `deadPeerTimeoutMs` above your genuine idle period, or a
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
(`{ count, bytes }` — the stricter of the two wins). At the cap, `onBackpressure` decides:

- **`'reject'` (default)** — `send()` rejects with `MllpBackpressureError`. Your application learns
  immediately that it is producing faster than the peer can accept, and can shed load, spill to a
  queue, or page someone. This is the honest default.
- **`'wait'`** — `send()` awaits the `'drain'` event, the per-message `ackTimeoutMs`, or your
  `AbortSignal`, whichever fires first. Convenient, and the right choice when your producer *can*
  slow down — but it converts backpressure into latency, so bound it.

Set `pipeline: false` to collapse the in-flight set to one — strict send → await-ACK → send. Slower,
and required by peers that cannot handle concurrent messages on one connection.

## Graceful shutdown

`close()` moves the connection to `DRAINING`: no new sends are accepted, in-flight messages keep
awaiting their ACKs, and the socket closes once they settle or `drainTimeoutMs` (default 30 s)
expires. This is what stops a rolling deploy from turning in-flight clinical messages into unknowns.

Every closeable implements `Symbol.asyncDispose`, and every awaitable takes an `AbortSignal`:

```ts
await using client = await createStarterClient({ host, port });
await client.send(payload, { signal: AbortSignal.timeout(5_000) });
// disposed — drained — on scope exit, including on throw
```

## Observability

`getStats()` returns **plain JSON-serializable objects** — no Buffers, no class instances — so they
go straight into a log pipeline or a metrics exporter.

```ts
logger.info(client.getStats());
```

Nothing in the stats, the warnings, or the frozen event payloads carries message content. See
[Framing](./framing.md) for the PHI contract on diagnostics.
