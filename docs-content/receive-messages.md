---
id: receive-messages
title: Receive and acknowledge messages
sidebar_label: Receive and acknowledge messages
description: "Run a server that commits each message before it answers, reject what should not be resent, watch negative acknowledgments, or build the ACK yourself."
---

# Receive and acknowledge messages

This guide sets up a server that receives HL7 v2 messages and acknowledges each one only after your
code has handled it. Each sample sends from a client on loopback to stand in for the system that
sends to you. [ACKs and the commit contract](./acks.md) explains why the server answers the way it
does.

The reference entries used here are [`createServer`](./api/src.md#createserver),
[`createStarterServer`](./api/src.md#createstarterserver), [`ServerOptions`](./api/src.md#serveroptions),
[`MllpAckError`](./api/src.md#mllpackerror), [`NackEvent`](./api/src.md#nackevent) and
[`buildRawAck`](./api/src.md#buildrawack).

## Commit, then acknowledge

Pair `autoAck: "AA"` with an `onMessage` handler. The server awaits the handler, which is where you
store the message durably, and answers only when it settles: `AA` if it resolved, `AE` if it threw.
A positive acknowledgment can never go out before your handler has finished.

```ts runnable
import { createServer, createStarterClient } from "@cosyte/mllp";

const stored: Buffer[] = [];

const server = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    stored.push(payload); // your durable commit; a throw here answers AE, never AA
  },
});
await server.listen(0); // port 0: the operating system picks one; the host defaults to 127.0.0.1

// A sender, standing in for the system that sends to you.
const sender = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });
const ack = await sender.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0201|P|2.5.1\r"),
);

ack.toString("latin1").includes("MSA|AA|CTRL0201"); // => true
stored.length; // => 1

await sender.close();
await server.close();
```

`createStarterServer({ port, onMessage })` does the same in one call: it sets `autoAck: "AA"` for
you and starts listening before it returns.

The payload reaches your handler as a `Buffer` with the framing removed. Decoding it is yours to do,
with the character set the message declares in `MSH-18`.

## Reject a message that must not be resent

Any error your handler throws is answered `AE`, an application error: the sender may resend, and a
retry may succeed. When a retry of the same bytes can only fail again (an unsupported message type,
a message you will never accept), throw an `MllpAckError` with `ackCode: "AR"` instead:

```ts runnable
import { createServer, createStarterClient, MllpAckError } from "@cosyte/mllp";

const server = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    if (payload.toString("latin1").includes("|ADT^A99|")) {
      throw new MllpAckError("unsupported trigger event", { ackCode: "AR" });
    }
    throw new Error("the database is unavailable");
  },
});
await server.listen(0);

const sender = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });
const rejected = await sender.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A99|CTRL0202|P|2.5.1\r"),
);
const failed = await sender.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0203|P|2.5.1\r"),
);

rejected.toString("latin1").includes("MSA|AR|CTRL0202"); // => true
failed.toString("latin1").includes("MSA|AE|CTRL0203"); // => true

await sender.close();
await server.close();
```

The message of the error you throw is never put on the wire or into an event, since it may describe
the record that failed. The acknowledgment carries a fixed text instead.

## Watch negative acknowledgments

Every time the server answers with a negative code on the auto-ACK path, it emits a `nack` event
carrying only the connection id, the code it sent and a reason: `handler-rejected` (your handler
threw), `uncorrelatable-inbound` (no readable `MSH`, an empty `MSH-10`, or a batch or several
messages in one frame), or `discarded-bytes` (the decoder had to discard part of the frame). Count
them; never log the payload from here.

```ts runnable
import { createServer, createStarterClient, type NackEvent } from "@cosyte/mllp";

const server = createServer({
  autoAck: "AA",
  onMessage: async () => {
    throw new Error("the database is unavailable");
  },
});
const nacks: NackEvent[] = [];
server.on("nack", (event: NackEvent) => nacks.push(event));
await server.listen(0);

const sender = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });
await sender.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0204|P|2.5.1\r"),
);

nacks.map((event) => `${event.ackCode} ${event.reason}`); // => ["AE handler-rejected"]

await sender.close();
await server.close();
```

## Answer in the half of Table 0008 the sender asked for

You do not choose between `AA` and `CA` yourself. When an inbound message's `MSH-15` asks for an
accept acknowledgment, the auto-ACK path answers in the accept half (`CA`, `CE`, `CR`) for the
outcome your handler reached, and in the application half otherwise. The full table is in
[ACKs and the commit contract](./acks.md#the-auto-ack-answers-in-the-half-of-table-0008-the-sender-asked-for).

## Build the acknowledgment yourself

Two modes hand the acknowledgment to you:

- **`autoAck` as a function.** The server calls `autoAck(payload, meta, conn)` and sends the bytes it
  returns. Your `onMessage` handler, if any, runs first as an observer.
- **`autoAck` unset (manual mode).** The server sends nothing of its own. Your `onMessage` handler
  sends the acknowledgment through `conn.send(encodeFrame(ack))`.

`buildRawAck(payload, code)` builds an acknowledgment without a parser: it copies the inbound
`MSH-10` bytes into `MSA-2`, and it downgrades a requested `AA` or `CA` to `AE` or `CE` when the
inbound cannot be correlated. In manual mode:

```ts runnable
import { buildRawAck, createServer, createStarterClient, encodeFrame } from "@cosyte/mllp";

const server = createServer({
  onMessage: (payload, _meta, conn) => {
    // Commit first, then answer.
    conn.send(encodeFrame(buildRawAck(payload, "AA")));
  },
});
await server.listen(0);

const sender = await createStarterClient({ host: "127.0.0.1", port: server.getStats().port ?? 0 });
const ack = await sender.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0205|P|2.5.1\r"),
);
ack.toString("latin1").includes("MSA|AA|CTRL0205"); // => true

await sender.close();
await server.close();
```

Do not call `conn.send()` from `onMessage` while `autoAck` is set: the server is already answering,
and the sender would receive two acknowledgments for one message. To build the acknowledgment with
a parser, see [Build ACKs with @cosyte/hl7](./build-acks-from-hl7.md).

## Bind beyond loopback

`listen(port)` binds `127.0.0.1` unless you name a host. A wildcard host such as `0.0.0.0` is
refused unless the server was created with `allowWildcardBind: true`, and binding one emits a
`securityWarning` with the code `MLLP_BIND_ALL_INTERFACES`. To accept connections from other
machines, bind the one interface they reach, or opt in to the wildcard deliberately:

```ts no-run binds every network interface of the machine it runs on
import { createServer } from "@cosyte/mllp";

const server = createServer({ autoAck: "AA", allowWildcardBind: true });
await server.listen(2575, "0.0.0.0");
```

## Cap the number of connections

A server accepts every connection it is offered unless you set `maxConnections`. With it set, a
connection that arrives while the server already holds that many is closed at accept: it never
reaches your handler or the `connection` event, and the server emits `connectionRejected` with the
code `MLLP_CONNECTION_LIMIT_REACHED`, the cap, and the peer's address and port. The sender sees its
connection close and may try again; once a connection closes, its place is free.

```ts runnable
import { createServer, createStarterClient, type ConnectionRejectedEvent } from "@cosyte/mllp";

const server = createServer({ autoAck: "AA", maxConnections: 1 });
const rejected: ConnectionRejectedEvent[] = [];
server.on("connectionRejected", (event: ConnectionRejectedEvent) => rejected.push(event));
await server.listen(0);
const port = server.getStats().port ?? 0;

const first = await createStarterClient({ host: "127.0.0.1", port });
await first.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0206|P|2.5.1\r"),
);

const second = await createStarterClient({ host: "127.0.0.1", port });
while (rejected.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));

rejected.map((event) => `${event.code} ${event.maxConnections}`); // => ["MLLP_CONNECTION_LIMIT_REACHED 1"]
server.getStats().activeConnections; // => 1

second.destroy();
await first.close();
await server.close();
```

The cap counts open sockets, which is what bounds file descriptors. A TLS connection counts from
the moment it is accepted, handshake included, and an over-cap one is closed before its handshake.
A connection counts until its socket has fully closed, so one the sender has just closed may hold
its place for a moment. The value must be a positive integer; anything else throws a `RangeError`
when the server is created.

[Secure a link with TLS](./tls.md) covers TLS on the server, and [Connection, reconnect and
backpressure](./reliability.md#shutdown-and-what-it-does-and-does-not-do-for-in-flight-messages)
covers what `close()` does to a handler that is still running.
