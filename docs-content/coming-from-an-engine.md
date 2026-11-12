---
id: coming-from-an-engine
title: Coming from an interface engine or another library
sidebar_label: Coming from an engine or library
description: "How the listener, auto-ACK, commit and application acknowledgments and reconnect you know from an engine or another MLLP library map to our API."
---

# Coming from an interface engine or another library

If you have run HL7 v2 interfaces through an interface engine, or written one with an MLLP library
in another language, you already know the moving parts: something listens, something answers with
an acknowledgment, and something reconnects when the link drops. This page maps those parts to
`@cosyte/mllp`, and says where our model differs from the one you may be used to.

The short version: `@cosyte/mllp` is the transport layer of an engine and nothing more. It frames
bytes, correlates acknowledgments and keeps the connection up. Parsing, routing, transformation and
a persistent queue are not in it, so the parts of an engine that do those things map to your own
code, or to [`@cosyte/hl7`](https://docs.cosyte.com/hl7) for parsing.

## The concepts, side by side

| What you know                                                        | What it is here                                                                                                                             |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An inbound channel, a listener, a source connector in MLLP mode      | [`createServer`](./api/src.md#createserver) and `listen(port, host)`, or `createStarterServer` in one call                                  |
| An outbound channel, a sender, a destination connector               | [`createClient`](./api/src.md#createclient) and `connect()`, or `createStarterClient` in one call                                           |
| "Auto-respond" or "auto-generate ACK" after the message is processed | `autoAck: "AA"` with an `onMessage` handler: the server awaits the handler, then answers `AA`, or `AE` if it threw                          |
| "Auto-respond" before the message is processed, on receipt           | `autoAck: "AA"` with no handler: the `AA` means only that the bytes arrived and were framed                                                 |
| A response built by a script or a transformer                        | `autoAck` as a function that returns the acknowledgment's bytes, or no `autoAck` and `conn.send()` from your handler                        |
| The response timeout on a sender                                     | `ackTimeoutMs`, measured from the moment the bytes are flushed to the socket                                                                |
| Reconnect, retry interval, retry count                               | `autoReconnect`, `initialDelayMs`, `maxDelayMs`, `multiplier`, `jitter`, and `retryStrategy` for a policy of your own                       |
| A send queue, "queue on error"                                       | an in-memory bound on messages waiting for an acknowledgment (`highWaterMark`); nothing is kept across a restart                            |
| Commit acknowledgment (`CA`) and application acknowledgment (`AA`)   | the enhanced mode of HL7 v2.5.1 section 2.9: the server answers in the half of Table 0008 the sender asked for, and the client reports both |
| Message store, message browser, reprocessing                         | not provided: store the payload yourself in your `onMessage` handler                                                                        |
| Filters, transformers, routing to several destinations               | not provided: your code, between the server's handler and a client's `send()`                                                               |
| Strict or lenient frame parsing                                      | the `framing` option: four tolerance flags, each one reported as a warning with a stable code                                               |
| TLS on a listener or a sender                                        | the `tls` option on either side; verification is on by default                                                                              |

The rest of this page goes through the four rows that change how you write an interface: the
listener, the auto-ACK, commit and application acknowledgments, and reconnect. The
[Glossary](./glossary.md) defines the acknowledgment codes, and
[Options, events and statistics](./options-and-events.md) lists every option with its default.

## The listener

An engine's inbound channel binds a port, decodes each frame and hands the message to the rest of
the channel. Here the server does the first two, and the rest of the channel is your `onMessage`
handler. It receives the payload as a `Buffer` with the framing removed, a `MessageMeta` with the
connection's ID, and the `Connection` the message arrived on.

```ts runnable
import { createServer, createStarterClient, type MessageMeta } from "@cosyte/mllp";

const seen: string[] = [];

const listener = createServer({
  autoAck: "AA",
  onMessage: async (payload, meta: MessageMeta) => {
    // MSH-10, the control ID; meta.connectionId says which connection it came on.
    if (meta.connectionId !== "") seen.push(payload.toString("latin1").split("|")[9] ?? "");
  },
});
await listener.listen(0); // port 0: the operating system picks one; the host defaults to 127.0.0.1

const sender = await createStarterClient({
  host: "127.0.0.1",
  port: listener.getStats().port ?? 0,
});
await sender.send(
  Buffer.from(
    "MSH|^~\\&|SRC_APP|SRC_FAC|DST_APP|DST_FAC|20260101120000||ADT^A01|MAP00001|P|2.5.1\r",
  ),
);

seen; // => ["MAP00001"]
listener.getStats().acceptedTotal; // => 1

await sender.close();
await listener.close();
```

Two differences from most engines. The server binds `127.0.0.1` unless you name a host, and a
wildcard host such as `0.0.0.0` is refused unless you set `allowWildcardBind: true`. And a server
accepts any number of connections unless you set `maxConnections`.

## The auto-ACK

Engines usually let you choose when the automatic acknowledgment is sent: as soon as the message
arrives, or after the channel has processed it. The choice decides what `AA` means to the sender,
and a sender that receives `AA` stops resending. We offer the same two moments, and the safe one is
the one the starter server uses:

- **After processing.** `autoAck: "AA"` with an `onMessage` handler. The server awaits the handler
  and answers `AA` if it resolved, `AE` if it threw, and `AR` if it threw an `MllpAckError` with
  `ackCode: "AR"`. A positive acknowledgment cannot go out before your handler finishes. This is
  the commit contract.
- **On receipt.** `autoAck: "AA"` with no handler. The `AA` goes out as soon as the frame is
  decoded, so it means only that the bytes arrived. Use it only when something downstream has
  already made the message durable.

```ts runnable
import { createServer, createStarterClient, MllpAckError } from "@cosyte/mllp";

const listener = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    const text = payload.toString("latin1");
    if (text.includes("|ZZZ^Z01|")) {
      throw new MllpAckError("unsupported message type", { ackCode: "AR" });
    }
    if (text.includes("|MAP00003|")) throw new Error("the store is unavailable");
    // Otherwise the commit succeeded.
  },
});
await listener.listen(0);

const sender = await createStarterClient({
  host: "127.0.0.1",
  port: listener.getStats().port ?? 0,
});
const send = async (type: string, controlId: string): Promise<string> => {
  const ack = await sender.send(
    Buffer.from(
      `MSH|^~\\&|SRC_APP|SRC_FAC|DST_APP|DST_FAC|20260101120000||${type}|${controlId}|P|2.5.1\r`,
    ),
  );
  // MSA-1 and MSA-2: the code and the control ID it answers.
  const msa = ack.toString("latin1").split("\r")[1]?.split("|") ?? [];
  return `${msa[1]} ${msa[2]}`;
};

await send("ADT^A01", "MAP00002"); // => "AA MAP00002"
await send("ADT^A01", "MAP00003"); // => "AE MAP00003"
await send("ZZZ^Z01", "MAP00004"); // => "AR MAP00004"

await sender.close();
await listener.close();
```

When an engine builds the response in a script, the equivalent here is `autoAck` as a function: the
server calls it with the payload and sends the bytes it returns, framed. Your `onMessage` handler,
if you set one, runs first as an observer. With no `autoAck` at all, the server sends nothing, and
your handler answers through `conn.send(encodeFrame(ack))`.

```ts runnable
import { buildRawAck, createServer, createStarterClient } from "@cosyte/mllp";

const listener = createServer({
  autoAck: (payload) => buildRawAck(payload, "AA"),
});
await listener.listen(0);

const sender = await createStarterClient({
  host: "127.0.0.1",
  port: listener.getStats().port ?? 0,
});
const ack = await sender.send(
  Buffer.from(
    "MSH|^~\\&|SRC_APP|SRC_FAC|DST_APP|DST_FAC|20260101120000||ADT^A01|MAP00005|P|2.5.1\r",
  ),
);
ack.toString("latin1").includes("MSA|AA|MAP00005"); // => true

await sender.close();
await listener.close();
```

`buildRawAck` copies the inbound `MSH-10` into `MSA-2` byte for byte, and turns a requested `AA`
into `AE` when the inbound has no control ID it can echo. [Receive and acknowledge
messages](./receive-messages.md) shows each mode in full.

## Commit and application acknowledgments

Some engines and some senders use the enhanced acknowledgment mode of HL7 v2: a first, accept
acknowledgment (`CA`, `CE` or `CR`) says the receiver has the message in safe storage, and a later
application acknowledgment (`AA`, `AE` or `AR`) says what the receiving application did with it.
A message asks for this with `MSH-15` (when to send the accept acknowledgment) and `MSH-16` (when to
send the application acknowledgment). With both empty, a message uses the original mode: one
acknowledgment, `AA`, `AE` or `AR`.

On the server, the auto-ACK path reads `MSH-15` and answers in the half of Table 0008 the sender
asked for. Here a sender asks for an accept acknowledgment always (`AL`) and an application
acknowledgment never (`NE`), so the commit is answered `CA` and that one acknowledgment settles the
send:

```ts runnable
import { createClient, createServer } from "@cosyte/mllp";

const listener = createServer({ autoAck: "AA", onMessage: async () => {} });
await listener.listen(0);

// Two-phase correlation needs acknowledgments matched by control ID.
const sender = createClient({
  host: "127.0.0.1",
  port: listener.getStats().port ?? 0,
  correlateByControlId: true,
});
await sender.connect();

const enhanced = await sender.send(
  Buffer.from(
    "MSH|^~\\&|SRC_APP|SRC_FAC|DST_APP|DST_FAC|20260101120000||ADT^A01|MAP00006|P|2.5.1|||AL|NE\r",
  ),
);
const original = await sender.send(
  Buffer.from(
    "MSH|^~\\&|SRC_APP|SRC_FAC|DST_APP|DST_FAC|20260101120000||ADT^A01|MAP00007|P|2.5.1\r",
  ),
);

// MSA-1 of each acknowledgment: the code, never the whole segment.
const msa1 = (ack: Buffer): string | undefined =>
  ack.toString("latin1").split("\r")[1]?.split("|")[1];
msa1(enhanced); // => "CA"
msa1(original); // => "AA"
enhanced.toString("latin1").includes("MSA|CA|MAP00006"); // => true

await sender.close();
await listener.close();
```

When the sender asks for both (`MSH-16` other than `NE`), the client reports the `CA` through the
`onCommitAck` option of `send()` and keeps the send pending until the application acknowledgment
arrives; [Send messages](./send-messages.md#match-acknowledgments-by-control-id) shows it. Our
server sends exactly one acknowledgment per message, so sending the later application
acknowledgment as a receiver is your code's job: see
[Known limitations](./limitations.md#it-does-not-complete-an-enhanced-mode-exchange-on-the-server-side).

A note on names: the "commit acknowledgment" of HL7 enhanced mode is the `CA`, `CE` or `CR` message
above. MLLP Release 2 has a commit acknowledgment of its own, a framing-level byte sequence, which
we do not implement. The [Glossary](./glossary.md) keeps the two apart.

## Reconnect

An engine's sender usually reconnects on its own and retries on an interval. Our client does the
same when you set `autoReconnect: true` (the starter client sets it for you), with exponential
backoff and jitter capped at 30 seconds by default. Two things may differ from what you know:

- **Only transient failures are retried.** A refused or reset connection is retried; a host name
  that does not resolve, a certificate that fails verification, or a peer that is not speaking MLLP
  stops the client instead, since every attempt would meet the same failure.
  `isTransientConnectionError` is the classifier, exported so a `retryStrategy` of your own can use
  it.
- **Messages waiting for an acknowledgment are not silently resent.** In the default first-in,
  first-out mode, a drop rejects each pending send with an `MllpConnectionError` that says whether
  it had been written; with `correlateByControlId: true`, pending sends are written again on the
  new connection. Either way the receiver's de-duplication on `MSH-10` is what makes a resend safe.

```ts runnable
import { isTransientConnectionError } from "@cosyte/mllp";

const reset = Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
const unknownHost = Object.assign(new Error("host not found"), { code: "ENOTFOUND" });

isTransientConnectionError(reset); // => true
isTransientConnectionError(unknownHost); // => false
```

The [tutorial](./run-a-link-end-to-end.md#step-4-keep-sending-after-the-link-drops) drops a link and
watches the client reconnect, and [Connection, reconnect and backpressure](./reliability.md) covers
the backoff, the connection states and what happens to messages in flight.

## Where names from products and libraries fit

If you are moving an interface from a specific product, these are the names you will look for. We
give them to orient you, not to describe those products fully: each product's own documentation is
the authority on its settings, and names change between versions.

| Product or library              | Where the listener and the auto-ACK live there                                                                                                                    | Here                                                             |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Mirth Connect (NextGen Connect) | a TCP Listener source connector with MLLP transmission mode; the source's Response setting, which can auto-generate the acknowledgment before or after processing | `createServer` with `autoAck: "AA"`, with or without `onMessage` |
| HAPI (Java)                     | a server with a receiving application whose method returns the response message                                                                                   | `autoAck` as a function, or manual mode                          |
| python-hl7                      | an MLLP client, and an asyncio server whose handler writes the response                                                                                           | `createClient`; a server in manual mode                          |
| simple-hl7 (Node.js)            | a TCP server with middleware, where the handler ends the response to send an acknowledgment                                                                       | `createServer` and an `onMessage` handler                        |

Product names are the trademarks of their owners. We are not affiliated with any of them, and naming
one does not mean we have verified our package against it: [Known
limitations](./limitations.md#it-is-not-differentially-verified-against-epic-or-cerner-so-verify-your-own-engine)
says which engines we have checked, and [Test your code and verify an engine](./testing.md) shows how
to check yours.

## Guides that apply this

- [Run a link end to end](./run-a-link-end-to-end.md): a receiver and a sender, built step by step.
- [Receive and acknowledge messages](./receive-messages.md): every acknowledgment mode on a server.
- [Send messages](./send-messages.md): timeouts, reconnect, enhanced mode and shutdown on a client.
- [Tolerate a sender's framing quirks](./tolerate-sender-quirks.md): the lenient parsing an engine
  may have given you.
- [Secure a link with TLS](./tls.md): the TLS settings on either side.
