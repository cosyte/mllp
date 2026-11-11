---
id: run-a-link-end-to-end
title: Run a link end to end
sidebar_label: Run a link end to end
description: "Build a receiver that commits each message before it answers, send to it, watch a failed commit draw AE, and keep sending after the link drops."
---

# Run a link end to end

In this tutorial we build both ends of one MLLP link on your machine: a receiver that stores each
message before it acknowledges it, and a sender that reads every acknowledgment and keeps going
after the connection drops. By the end you will have seen the four things every HL7 v2 link does:
receive, commit, acknowledge and reconnect.

Every step is a whole program. Save it as a `.ts` file and run it with Node.js 22 or later (or with
`tsx`); each one starts on a port the operating system picks, on `127.0.0.1`, and closes everything
it opened. The messages are synthetic: a header with invented application names and control IDs,
and nothing else.

You need the package installed, as on [Installation](./installation.md).

## Step 1: receive a message and commit it

The receiver is a server with `autoAck: "AA"` and an `onMessage` handler. The handler is the commit
step: here it puts the message in a `Map` keyed by its control ID (`MSH-10`), where your code would
write to a database. The server waits for the handler to finish before it answers.

The sender is a client. `send()` takes the message as bytes and resolves with the acknowledgment
the receiver sent back.

```ts runnable
import { createClient, createServer } from "@cosyte/mllp";

// Stands in for your database: one entry per control ID.
const store = new Map<string, Buffer>();

const receiver = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    const controlId = payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
    store.set(controlId, payload);
  },
});
await receiver.listen(0);

const sender = createClient({ host: "127.0.0.1", port: receiver.getStats().port ?? 0 });
await sender.connect();

const ack = await sender.send(
  Buffer.from(
    "MSH|^~\\&|LAB_APP|LAB_FAC|EHR_APP|EHR_FAC|20260101120000||ORU^R01|TUT00001|P|2.5.1\r",
  ),
);

store.has("TUT00001"); // => true
ack.length > 0; // => true

await sender.close();
await receiver.close();
```

The message is in the store, and an acknowledgment came back. Next we read it.

## Step 2: read the acknowledgment

An acknowledgment is itself an HL7 v2 message. Its `MSA` segment carries the two fields that matter:
`MSA-1` is the code (`AA` means "accepted"), and `MSA-2` echoes the control ID of the message it
answers. We split out the `MSA` segment and read both.

```ts runnable
import { createClient, createServer } from "@cosyte/mllp";

const store = new Map<string, Buffer>();

const receiver = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    const controlId = payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
    store.set(controlId, payload);
  },
});
await receiver.listen(0);

const sender = createClient({ host: "127.0.0.1", port: receiver.getStats().port ?? 0 });
await sender.connect();

const ack = await sender.send(
  Buffer.from(
    "MSH|^~\\&|LAB_APP|LAB_FAC|EHR_APP|EHR_FAC|20260101120000||ORU^R01|TUT00002|P|2.5.1\r",
  ),
);

const msa = ack
  .toString("latin1")
  .split("\r")
  .find((segment) => segment.startsWith("MSA|"))
  ?.split("|");
msa?.[1]; // => "AA"
msa?.[2]; // => "TUT00002"

await sender.close();
await receiver.close();
```

`AA` here means more than "bytes arrived": the server sent it only after the handler resolved, so
the message was in the store first. That ordering is the commit contract.

## Step 3: see a failed commit answered with AE

Now we make the store fail once, as a database might during a restart. When the handler throws,
the server answers `AE` (application error) instead of `AA`, and the sender knows to send the
message again. The second attempt succeeds and is answered `AA`.

```ts runnable
import { createClient, createServer } from "@cosyte/mllp";

const store = new Map<string, Buffer>();
let failuresLeft = 1;

const receiver = createServer({
  autoAck: "AA",
  onMessage: async (payload) => {
    if (failuresLeft > 0) {
      failuresLeft -= 1;
      throw new Error("the store is unavailable");
    }
    const controlId = payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
    store.set(controlId, payload);
  },
});
await receiver.listen(0);

const sender = createClient({ host: "127.0.0.1", port: receiver.getStats().port ?? 0 });
await sender.connect();

const message = Buffer.from(
  "MSH|^~\\&|LAB_APP|LAB_FAC|EHR_APP|EHR_FAC|20260101120000||ORU^R01|TUT00003|P|2.5.1\r",
);
const ackCode = (ack: Buffer): string | undefined =>
  ack
    .toString("latin1")
    .split("\r")
    .find((segment) => segment.startsWith("MSA|"))
    ?.split("|")[1];

const first = await sender.send(message);
ackCode(first); // => "AE"
store.has("TUT00003"); // => false

const second = await sender.send(message);
ackCode(second); // => "AA"
store.has("TUT00003"); // => true

await sender.close();
await receiver.close();
```

The receiver never said `AA` for a message it did not have. The text of the error we threw never
reaches the wire or an event, since an error in a real system often describes the record that
failed.

## Step 4: keep sending after the link drops

Links drop: an engine restarts, a firewall closes an idle connection. We turn on `autoReconnect` in
the sender, then have the receiver drop the connection after the first message. The sender emits
`reconnecting`, connects again with a short backoff, and the next `send()` goes through on the new
connection.

```ts runnable
import { createClient, createServer, type Connection } from "@cosyte/mllp";

const store = new Map<string, Buffer>();
const links: Connection[] = [];

const receiver = createServer({
  autoAck: "AA",
  onMessage: async (payload, _meta, conn) => {
    const controlId = payload.toString("latin1").split("\r")[0]?.split("|")[9] ?? "";
    store.set(controlId, payload);
    links.push(conn);
  },
});
await receiver.listen(0);

const sender = createClient({
  host: "127.0.0.1",
  port: receiver.getStats().port ?? 0,
  autoReconnect: true,
  initialDelayMs: 50,
});
const attempts: number[] = [];
sender.on("reconnecting", (event: { attempt?: number }) => attempts.push(event.attempt ?? -1));
await sender.connect();

const message = (controlId: string): Buffer =>
  Buffer.from(
    `MSH|^~\\&|LAB_APP|LAB_FAC|EHR_APP|EHR_FAC|20260101120000||ORU^R01|${controlId}|P|2.5.1\r`,
  );

await sender.send(message("TUT00004"));

// The receiver drops the connection, as a restarting engine would.
const reconnected = new Promise((resolve) => sender.once("connect", resolve));
links[0]?.destroy();
await reconnected;

const ack = await sender.send(message("TUT00005"));
ack.toString("latin1").includes("MSA|AA|TUT00005"); // => true

attempts; // => [0]
store.size; // => 2
sender.getStats().reconnectAttempts; // => 1
receiver.getStats().acceptedTotal; // => 2

await sender.close();
await receiver.close();
```

The receiver accepted two connections, one before the drop and one after, and stored both
messages.

A drop while a message is waiting for its acknowledgment is the harder case: the receiver may have
stored it and lost the answer on the way back. A sender cannot know, so a resend can deliver it
twice. That is why our store is keyed by control ID: storing the same `MSH-10` again replaces the
entry rather than adding a second one.

## What you built

- A receiver that commits each message before it answers, and answers `AE` when the commit fails.
- A sender that reads `MSA-1` and `MSA-2` from each acknowledgment.
- A link that recovers on its own after the connection drops.

## Next

- [Receive and acknowledge messages](./receive-messages.md): reject a message with `AR`, watch
  negative acknowledgments, and build the acknowledgment yourself.
- [Send messages](./send-messages.md): timeouts, a full queue and a clean shutdown.
- [ACKs and the commit contract](./acks.md): why the server answers the way it does.
- [Connection, reconnect and backpressure](./reliability.md): what happens to messages in flight
  when a link drops.
- [Options, events and statistics](./options-and-events.md) and the [Glossary](./glossary.md).
