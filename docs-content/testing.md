---
id: testing
title: Testing & verification
description: >-
  Test against @cosyte/mllp without opening a socket using the in-memory transport, then verify the
  interface engine you are integrating with before go-live using the differential harness.
sidebar_position: 8
---

# Testing & verification

Two shipped tools, aimed at two different questions.

`@cosyte/mllp/testing` answers **"does my code drive this library correctly?"** It gives you a
socket-free transport, so a test that exercises framing, acknowledgement correlation, backpressure or
a dropped connection runs in-process, deterministically, with no ports and no certificates.

`runDifferential` answers **"does the engine on the other end behave the way I assume?"** It sends a
small corpus of synthetic messages at a peer you name and reports what came back. It is an
observation, never a verdict.

Both ship in the published package. Neither is a devDependency you have to add.

## Test without a socket: the in-memory transport

`InMemoryTransport.pair()` returns two connected, in-process ends. A write to one end delivers to the
other end's `onData` handler **synchronously**, before `write()` returns, so a test needs no `await`,
no fake timers and no cleanup of a listening port.

```ts runnable
import { encodeFrame, FrameReader } from "@cosyte/mllp";
import { InMemoryTransport } from "@cosyte/mllp/testing";

// Two connected, in-process ends.
const [clientSide, serverSide] = InMemoryTransport.pair();

// Stand a de-framer up on the receiving end, the way a server would.
const received = [];
const reader = new FrameReader({ onFrame: (payload) => received.push(payload) });
serverSide.onData((chunk) => reader.push(chunk));

// Synthetic bytes. The transport carries them and never reads them.
const message = Buffer.from("MSH|^~\\&|SEND|FAC|RECV|FAC|20260717||ADT^A01|MSG00001|P|2.5");
clientSide.write(encodeFrame(message));

// Already through, with nothing awaited.
received.length; // => 1
received[0].equals(message); // => true
```

### Simulating the conditions a real link produces

The pair models the four things a socket does to you, each on demand:

| Call                   | What it simulates                                                                                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `split(n)`             | Chunked reads. Every subsequent delivery to that end arrives `n` bytes at a time, so a frame is split across as many reads as you like. `split(0)` turns it off.                                                                  |
| `pause()` / `resume()` | Backpressure. While paused, writes aimed at that end are queued and `onData` is not called; `resume()` flushes the queue synchronously, in write order. A queued write returns `false`, the same signal a congested socket gives. |
| `destroy(reason)`      | A one-sided abrupt disconnect. Fires `onError(reason)` then `onClose` on that end only, leaving the peer untouched, which is what a reset on one socket looks like.                                                               |
| `close()`              | A graceful close. Fires `onClose` on both ends, the way a FIN exchange does.                                                                                                                                                      |

`simulateConnect()` fires the end's `onConnect` handler, standing in for the moment a real socket
finishes connecting.

Chunk boundaries are the ones worth exercising deliberately, because a frame split across reads is
the case a hand-rolled de-framer gets wrong:

```ts runnable
import { encodeFrame, FrameReader } from "@cosyte/mllp";
import { InMemoryTransport } from "@cosyte/mllp/testing";

const [clientSide, serverSide] = InMemoryTransport.pair();
serverSide.split(1); // one byte per read: the worst a real socket can do

const frames = [];
const reader = new FrameReader({ onFrame: (payload) => frames.push(payload) });
serverSide.onData((chunk) => reader.push(chunk));

clientSide.write(encodeFrame(Buffer.from("A")));

// Four separate reads, one reassembled frame.
frames.length; // => 1
frames[0].toString(); // => "A"
```

### Driving a whole `Connection` over it

A pair is a `Transport`, so it goes straight into a `Connection` and you get the state machine,
acknowledgement correlation and the warning stream with no network underneath:

```ts
import { Connection, encodeFrame } from "@cosyte/mllp";
import { InMemoryTransport } from "@cosyte/mllp/testing";

const [clientSide, serverSide] = InMemoryTransport.pair();

const conn = new Connection({
  transport: clientSide,
  onMessage: (payload) => handle(payload), // framing already stripped
  onWarning: (w) => logger.warn({ code: w.code, byteOffset: w.byteOffset }),
});

// The other end is your test double: answer, stay silent, or drop, whichever the case needs.
serverSide.onData(() => serverSide.write(encodeFrame(ackBytes)));
```

Answering nothing is how you exercise an acknowledgement timeout without waiting on a real peer;
`serverSide.destroy()` is how you exercise a reset; `serverSide.pause()` is how you exercise
backpressure. This package holds itself to the same rule: every test here that can run over the pair
does, and real sockets are reserved for integration smoke tests. See
[Connection, reconnect & backpressure](./reliability.md) for the states and events you will observe.

One thing the pair deliberately refuses: writing to a peer from inside that peer's own `onData`
handler throws. Re-entrant delivery would either recurse without end or reorder frames, and a
transport that silently reordered frames would make every test above prove the wrong thing.

## Verify your own engine: `runDifferential`

Interoperability is proven in this repository against freely available engines only. Whatever you are
integrating with is very probably not one of them, and its behaviour is not something this package
will claim to know. See
[It is not differentially verified against Epic or Cerner](./limitations.md#it-is-not-differentially-verified-against-epic-or-cerner-so-verify-your-own-engine).

What ships instead is the harness, so you can observe your own engine before go-live.
`runDifferential` opens one connection per message, sends a small corpus of synthetic messages, and
reports for each exchange whether the frame that came back was byte-identical to the canonical
Release 1 block (`VT` + payload + `FS` + `CR`) and whether its `MSA-2` echoed the `MSH-10` of the
message it answered.

```ts
// differential.ts
import { runDifferential } from "@cosyte/mllp";

const report = await runDifferential({ peer: process.env["MLLP_DIFF_PEER"] });
console.log(JSON.stringify(report, null, 2));
```

```bash
MLLP_DIFF_PEER=engine.staging.example:2575 node differential.js
```

> **The run sends messages INTO whatever engine you aim it at.** They are synthetic patients, and an
> engine that accepts them stores synthetic patients: an admit and an observation result will land in
> whatever that endpoint feeds. Aim it at a test or staging endpoint. Never at a production interface
> carrying live traffic, and never at an endpoint you do not own.

Four things about the report, so you know what you are holding:

- **It is an observation, not a verdict.** `result` is one of `parity-observed`,
  `deviations-observed`, `no-observation` or `skipped`. None of them says a peer is conformant, and a
  run in which nothing was answered is never presented as a success. Whether an interface is fit to
  carry clinical traffic is your call, with this evidence in front of you.
- **A deviation is named, not guessed at.** Each one carries a stable warning code and a byte offset:
  `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE` and
  `MLLP_FRAME_TOO_LARGE` for the block, and `MLLP_ACK_UNMATCHED_CONTROL_ID` when an acknowledgement
  does not echo the control ID it answered. See [Framing & tolerance](./framing.md).
- **It carries no payload content, by construction.** A code, a byte offset and structural counts.
  Not a run of the peer's bytes, not the acknowledged control ID, not a truncation of either, so a
  report is safe to attach to a ticket. That matters, because the engine you aim this at may hold
  real patients.
- **It is JSON.** Plain objects, numbers and strings throughout, so a pipeline reads it without
  scraping text.

Per exchange you get `outcome` (`answered`, `unanswered`, `undecodable-response`,
`connection-refused`, `connection-failed` or `connection-dropped`), `byteParity`, `correlation`, the
warning codes with their byte offsets, byte counts in both directions, and the elapsed time. The
deadline is per exchange and defaults to 10 seconds, so one cold or unreachable endpoint costs one
exchange rather than the whole run.

With no peer configured (`MLLP_DIFF_PEER` unset or empty) the run **skips** and returns
`result: 'skipped'`, so it is safe to leave in a test suite that also runs where no engine exists. An
address that is _present_ and is not a `host:port` is a different case: it throws
`MllpDifferentialConfigurationError` naming the value, because a silent skip there would read as
proof the harness ran.

Byte parity means the MLLP **envelope**, compared against the canonical block this package emits. It
is not equality of message content, which can never hold: an acknowledgement carries the peer's own
control ID, its own timestamp and its own sending application, and it is supposed to.

Point it at something you can reach over TLS by supplying your own `connect`, which is handed the
resolved peer and returns a transport that is not connected yet:

```ts
import tls from "node:tls";
import { runDifferential, TlsTransport } from "@cosyte/mllp";

const report = await runDifferential({
  peer: process.env["MLLP_DIFF_PEER"],
  connect: (peer) => new TlsTransport(tls.connect({ host: peer.host, port: peer.port, ca })),
});
```

## Next

- [Framing & tolerance](./framing.md): the wire format and every warning code a report can name.
- [Connection, reconnect & backpressure](./reliability.md): the states and events a pair-driven
  `Connection` walks through.
- [Known limitations & non-goals](./limitations.md): what an observation is evidence of, and what it
  is not.
