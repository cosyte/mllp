---
id: performance
title: Performance
sidebar_label: Performance
description: "What we will measure on @cosyte/mllp and how, the settings that shape its throughput and memory today, and why no benchmark figures are published yet."
---

# Performance

This page describes what we measure on `@cosyte/mllp`, how, and the settings that shape its
performance in your deployment. The shared method every Cosyte package follows (throughput, latency
percentiles, memory, import time and bundle size, and how a pull request is compared with `main`)
is written down in the performance standard in
[cosyte/config's decision records](https://github.com/cosyte/config/tree/main/documentation/decisions).
The numbers for the current release are in [Current numbers](#current-numbers) below.

## What we measure

This package does not have a benchmark of its own yet, so no figure on this page comes from one.
When it does, it will measure what the performance standard names, for a transport:

- **Throughput**: messages a second through a client and a server on loopback, from small to very
  large messages.
- **Latency**: from `send()` to the acknowledgment, at p50, p95 and p99.
- **Memory**: peak heap and allocations over a long run, which should stay flat.
- **Import time and bundle size** of each entry point.

Until then, the [Current numbers](#current-numbers) section says "not measured for this release"
for each of them, with the reason. We do not publish a figure measured once on one machine.

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
