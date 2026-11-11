---
id: intro
title: Overview
sidebar_label: Overview
description: "An MLLP client and server for HL7 v2 in Node.js: framing, acknowledgment correlation, reconnect, backpressure and TLS, with no runtime dependencies."
---

# @cosyte/mllp

`@cosyte/mllp` is our MLLP client and server for HL7 v2 in Node.js and TypeScript. MLLP (the
Minimal Lower Layer Protocol) is how HL7 v2 messages travel over TCP: each message is wrapped in
three framing bytes, and the receiver answers with an acknowledgment. This package carries those
bytes and gives you the parts the protocol leaves to you:

- **Framing.** A strict encoder that always writes the canonical block (`VT` payload `FS` `CR`), and
  a decoder that tolerates the quirks real senders have, one opt-in flag at a time, with a stable
  warning code for each.
- **Acknowledgments.** A client whose `send()` resolves with the acknowledgment for that message,
  not the next bytes off the wire, and a server that only answers `AA` after your handler has
  committed the message.
- **A connection that lasts.** Auto-reconnect with backoff and jitter, dead-peer detection,
  backpressure with a bounded queue, and a shutdown that waits for outstanding acknowledgments.
- **TLS.** Verification on by default, mutual TLS, a TLS 1.2 floor, and the IHE ATNA cipher suites
  as an opt-in.
- **Testing.** An in-memory transport so your tests open no socket, and a harness that observes how
  an engine you name frames and acknowledges.

It has no runtime dependencies: the client, the server and the codec use Node.js built-ins only.
It is published on npm under the MIT license.

## Who it is for

Developers who connect a Node.js service to a hospital interface engine, a lab system or another
HL7 v2 sender or receiver, and who need the transport to fail safely: a message that was not
committed must never be acknowledged as if it were.

## What it is not

- **Not a parser.** It never reads the payload. Pair it with
  [`@cosyte/hl7`](https://docs.cosyte.com/hl7) or any other parser to read fields. The one
  exception is the optional `@cosyte/mllp/ack-from-hl7` subpath, which builds an acknowledgment
  through `@cosyte/hl7`.
- **Not a queue.** It holds a message in memory only until its acknowledgment settles it, and
  keeps nothing across a restart. MLLP with an HL7 acknowledgment is at-least-once at best, and
  de-duplication belongs to the application.
- **Not MLLP Release 2.** Only Release 1 framing is implemented.

[Known limitations and non-goals](./limitations.md) lists every bound, and is worth reading before
you depend on the package.

## The package at a glance

| Entry point                 | What it holds                                                                    |
| --------------------------- | -------------------------------------------------------------------------------- |
| `@cosyte/mllp`              | the client, the server, the framing codec, TLS, and the differential harness     |
| `@cosyte/mllp/testing`      | `InMemoryTransport`, two connected in-process ends for socket-free tests         |
| `@cosyte/mllp/ack-from-hl7` | acknowledgment builders over the optional `@cosyte/hl7` peer                     |
| `@cosyte/mllp/arbitraries`  | fast-check generators of frames and streams, over the optional `fast-check` peer |

## Next

- [Installation](./installation.md): install the package and the optional peer.
- [Quickstart](./quickstart.md): a server and a client on loopback, then the frame underneath.
- [Run a link end to end](./run-a-link-end-to-end.md): a tutorial that receives, commits,
  acknowledges and reconnects, one step at a time.
- [Coming from an interface engine or another library](./coming-from-an-engine.md): the listener,
  the auto-ACK and reconnect you already know, mapped to this package.
- [Send messages](./send-messages.md) and [Receive and acknowledge messages](./receive-messages.md):
  the two everyday tasks.
- [Testing and verification](./testing.md): the socket-free in-memory transport, and the
  differential harness for checking a real engine before go-live.
- [Property-test your code](./property-test-your-code.md): generated frames, messy streams and
  hostile bytes for testing code you build on this package.
- [ACKs and the commit contract](./acks.md): the page to read before you put this in front of a
  clinical system.
- [Conformance statement](./conformance.md): the declaration to hand a conformance reviewer.
- [Options, events and statistics](./options-and-events.md) and the [Glossary](./glossary.md):
  every option with its default, and every acknowledgment term.
- The [API reference](./api/README.md), generated from the source.
