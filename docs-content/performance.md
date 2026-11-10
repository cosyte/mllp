---
id: performance
title: Performance
sidebar_label: Performance
description: "What we measure on @cosyte/mllp and how, the settings that shape its throughput and memory, and where the published figures come from."
---

# Performance

This page describes what we measure on `@cosyte/mllp`, how, and the settings that shape its
performance in your deployment. The shared method every Cosyte package follows (throughput, latency
percentiles, memory, import time and bundle size, and how a pull request is compared with `main`)
is written down in the performance standard in
[cosyte/config's decision records](https://github.com/cosyte/config/tree/main/documentation/decisions).
The numbers for the current release are in [Current numbers](#current-numbers) below.

## What we measure

The benchmarks live in the repository's `bench/` directory and run against the built package, the
way you import it. Every message they send is synthetic and built in code: a stream of 280 byte
ADT^A01 messages, a 32 KiB ORU^R01, and an MDM^T02 carrying a 1 MiB or a 4 MiB base64 document.
They measure what the performance standard names, for a transport:

- **Throughput**: messages and bytes a second through the frame decoder, the encoder and a round
  trip through two connections, and through a client and a server over a real 127.0.0.1 socket.
- **Latency**: per call, and from `send()` to the acknowledgment over the socket, at p50, p95 and
  p99.
- **Memory**: allocations per operation, the peak of one message on each side of the socket as a
  multiple of its size (the bytes of a frame sit outside the JavaScript heap, so both are counted),
  and a long run that checks memory stays flat.
- **Import time and bundle size** of the root entry point.

Frames are decoded whole and split across reads the way a socket delivers them: small messages many
to a 1,460 byte TCP segment, a large message in 64 KiB reads.

To take a reading yourself, after `pnpm build`:

```sh
pnpm bench:reading --out bench-results/reading.json
pnpm bench:socket
pnpm bench:profile
```

On every pull request CI runs a scaling gate, which fails when the decoder's or a round trip's cost
grows faster than its input, and an advisory timing comparison of the change against `main`. Until
the numbers below are filled in at a release, the [Current numbers](#current-numbers) section says
"not measured for this release" for each of them. We do not publish a figure measured once on one
machine.

## What shapes performance in your deployment

These are properties of the code and its defaults, not measurements:

- **Pipelining.** By default a client writes the next message without waiting for the previous
  acknowledgment, up to its `highWaterMark`. `pipeline: false` sends one message at a time and waits
  for each acknowledgment, which some peers require and which bounds throughput by the round trip.
- **The queue bound.** `highWaterMark` (64 messages by default, or a byte cap) bounds what a client
  holds in flight and queued, so a peer that stops acknowledging cannot grow the client's memory
  without limit.
- **The frame bound.** `maxFrameSizeBytes` (16 MiB by default) bounds what one connection buffers
  for an incomplete frame.
- **The commit contract.** With `autoAck: "AA"` and a handler, a server answers each message only
  after your handler settles, so your handler's time is part of the sender's round trip.
- **No runtime dependencies.** Importing the package loads its own code and Node.js built-ins
  only. `@cosyte/hl7` is loaded only when `ack-from-hl7` is first called.

[Connection, reconnect and backpressure](./reliability.md) explains the first two in full.

## What these numbers are not

- **Not a comparison with other libraries.** That is a separate suite with its own written method.
- **Not a property of your network.** On a real link the round trip to the peer and the peer's
  own commit time usually dominate.

## Current numbers

The numbers for this section are measured on `main` at each release and filled in when the release
is built. They are never typed by hand.
