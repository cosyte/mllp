---
id: send-messages
title: Send messages
sidebar_label: Send messages
description: "Connect a client, send HL7 v2 messages, bound each wait, tell a timeout from a full queue, and close without losing track of a message."
---

# Send messages

This guide sets up a client for a real link: connect, send, bound every wait, and shut down with a
clear record of what was delivered. Each sample starts a server on loopback to stand in for the
engine you connect to; on a real link you pass its host and port instead.

The reference entries used here are [`createStarterClient`](./api/src.md#createstarterclient),
[`createClient`](./api/src.md#createclient), [`MllpClient`](./api/src.md#mllpclient),
[`ClientOptions`](./api/src.md#clientoptions), [`MllpTimeoutError`](./api/src.md#mllptimeouterror)
and [`MllpBackpressureError`](./api/src.md#mllpbackpressureerror).

## Connect and send

`createStarterClient` connects before it returns and turns on auto-reconnect, so it is the shortest
route to a working link. `send()` takes the raw message bytes, adds the MLLP framing, and resolves
with the acknowledgment for that message, with the framing removed.

```ts runnable
import { createStarterClient, createStarterServer } from "@cosyte/mllp";

// Stands in for the engine you send to.
const engine = await createStarterServer({ port: 0, onMessage: () => {} });

const client = await createStarterClient({
  host: "127.0.0.1",
  port: engine.getStats().port ?? 0,
});

const ack = await client.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0101|P|2.5.1\r"),
);

const msa = ack
  .toString("latin1")
  .split("\r")
  .find((segment) => segment.startsWith("MSA|"))
  ?.split("|");
msa?.[1]; // => "AA"
msa?.[2]; // => "CTRL0101"

await client.close();
await engine.close();
```

Pass the payload as a `Buffer`. HL7 v2 is bytes on the wire, and which character set they are in is
the message's concern (`MSH-18`), not the transport's.

`createClient` takes the same options without connecting and without the starter defaults: call
`connect()` yourself, and pass `autoReconnect: true` if you want it.

| Option                 | `createStarterClient` | `createClient` |
| ---------------------- | --------------------- | -------------- |
| `autoReconnect`        | `true`                | `false`        |
| `ackTimeoutMs`         | `30_000`              | `30_000`       |
| `correlateByControlId` | `false`               | `false`        |
| `pipeline`             | `true`                | `true`         |
| `highWaterMark`        | `64`                  | `64`           |
| `onBackpressure`       | `"reject"`            | `"reject"`     |

## Bound every wait

An acknowledgment that never comes is the normal failure on an MLLP link. `ackTimeoutMs` bounds the
wait for each send; its clock starts when the bytes are flushed to the socket, not when you call
`send()`, so time a message spends queued is not charged to the peer. A timeout rejects with
`MllpTimeoutError`:

```ts runnable
import { createClient, createServer, MllpTimeoutError } from "@cosyte/mllp";

// An engine that reads every message and never answers.
const engine = createServer({ onMessage: () => {} });
await engine.listen(0);

const client = createClient({
  host: "127.0.0.1",
  port: engine.getStats().port ?? 0,
  ackTimeoutMs: 200,
});
await client.connect();

let outcome = "";
try {
  await client.send(
    Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0102|P|2.5.1\r"),
  );
} catch (err) {
  outcome = err instanceof MllpTimeoutError ? "timed out" : "other";
}
outcome; // => "timed out"

await client.close();
await engine.close();
```

A timeout does not mean the message was not delivered. The engine may have committed it and lost the
acknowledgment on the way back, so a resend can duplicate it. The receiver's de-duplication on
`MSH-10` and `MSH-7` is what makes a resend safe; [Known
limitations](./limitations.md#it-cannot-guarantee-delivery) explains why no transport can settle it.

To cancel a single wait, pass an `AbortSignal`. The send rejects with an `AbortError`:

```ts runnable
import { createClient, createServer } from "@cosyte/mllp";

const engine = createServer({ onMessage: () => {} });
await engine.listen(0);
const client = createClient({ host: "127.0.0.1", port: engine.getStats().port ?? 0 });
await client.connect();

const controller = new AbortController();
const pending = client.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0103|P|2.5.1\r"),
  { signal: controller.signal },
);
controller.abort();

const name = await pending.then(
  () => "resolved",
  (err: unknown) => (err instanceof Error ? err.name : "other"),
);
name; // => "AbortError"

await client.close();
await engine.close();
```

`AbortSignal.timeout(ms)` gives a signal that aborts on its own after `ms` milliseconds.

## Handle a full queue

The client bounds the messages it holds, in flight and queued, at `highWaterMark` (a count, a byte
cap such as `{ bytes: 8 * 1024 * 1024 }`, or both). At the cap, the default `onBackpressure:
"reject"` rejects the new send at once with `MllpBackpressureError`, so your code learns it is
producing faster than the peer accepts:

```ts runnable
import { createClient, createServer, MllpBackpressureError } from "@cosyte/mllp";

const engine = createServer({ onMessage: () => {} });
await engine.listen(0);

const client = createClient({
  host: "127.0.0.1",
  port: engine.getStats().port ?? 0,
  highWaterMark: 1,
  ackTimeoutMs: 300,
});
await client.connect();

const message = (id: string): Buffer =>
  Buffer.from(`MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|${id}|P|2.5.1\r`);

const first = client.send(message("CTRL0104")).catch(() => "no acknowledgment");
let second = "";
try {
  await client.send(message("CTRL0105"));
} catch (err) {
  second = err instanceof MllpBackpressureError ? "rejected: queue full" : "other";
}
second; // => "rejected: queue full"
await first;

await client.close();
await engine.close();
```

`onBackpressure: "wait"` makes `send()` wait for room instead, bounded by the send's `ackTimeoutMs`
and its `AbortSignal`. Choose it only when your producer can slow down; it turns backpressure into
latency.

## Match acknowledgments by control ID

By default the client matches acknowledgments to sends in order (FIFO), which is what most engines
do. For a peer that acknowledges out of order, set `correlateByControlId: true`: each acknowledgment
is matched by its `MSA-2` to the `MSH-10` of the message it answers. An acknowledgment that matches
nothing pending is reported with the warning `MLLP_ACK_UNMATCHED_CONTROL_ID`, and a late one for a
send that already timed out with `MLLP_ACK_AFTER_TIMEOUT`.

Correlating by control ID is also what lets one send receive both acknowledgments of the enhanced
protocol: the accept acknowledgment (`CA`) is reported through `onCommitAck` and the send stays
pending until the application acknowledgment arrives.

```ts runnable
import {
  buildRawAck,
  createClient,
  createServer,
  encodeFrame,
  type CommitAckReport,
} from "@cosyte/mllp";

// An engine that sends the accept acknowledgment, then the application acknowledgment.
const engine = createServer({
  onMessage: (payload, _meta, conn) => {
    conn.send(encodeFrame(buildRawAck(payload, "CA")));
    setTimeout(() => conn.send(encodeFrame(buildRawAck(payload, "AA"))), 20);
  },
});
await engine.listen(0);

const client = createClient({
  host: "127.0.0.1",
  port: engine.getStats().port ?? 0,
  correlateByControlId: true,
});
await client.connect();

const commits: CommitAckReport[] = [];
// MSH-15 and MSH-16 both AL: ask for both acknowledgments.
const ack = await client.send(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0106|P|2.5.1|||AL|AL\r"),
  { onCommitAck: (report) => commits.push(report) },
);

commits.map((report) => report.code); // => ["CA"]
ack.toString("latin1").includes("MSA|AA|CTRL0106"); // => true

await client.close();
await engine.close();
```

[ACKs and the commit contract](./acks.md#enhanced-mode-one-send-two-acknowledgments) explains the two
waits and what each outcome means.

## Close cleanly

`close()` waits for the acknowledgments of messages already written, bounded by `drainTimeoutMs`
(30 seconds by default), and then reports what is still unresolved to each `send()` caller:
`MllpNeverDeliveredError` for a message that was never written, which is safe to resend, and
`MllpUnknownFateError` for one that was written and never acknowledged, which may already be
committed. If you would rather have no such reports, settle your sends before you close:

```ts runnable
import { createStarterClient, createStarterServer } from "@cosyte/mllp";

const engine = await createStarterServer({ port: 0, onMessage: () => {} });
const client = await createStarterClient({ host: "127.0.0.1", port: engine.getStats().port ?? 0 });

const ids = ["CTRL0107", "CTRL0108", "CTRL0109"];
const sends = ids.map((id) =>
  client.send(Buffer.from(`MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|${id}|P|2.5.1\r`)),
);
const settled = await Promise.allSettled(sends);
settled.every((result) => result.status === "fulfilled"); // => true

await client.close();
await engine.close();
```

`destroy()` is the immediate alternative: it settles every pending send at once and waits for
nothing. The client also implements `Symbol.asyncDispose`, so `await using client = await
createStarterClient(...)` closes it when the scope ends. [Connection, reconnect and
backpressure](./reliability.md) explains the reconnect and shutdown behavior in full.
