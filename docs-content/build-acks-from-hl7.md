---
id: build-acks-from-hl7
title: Build ACKs with @cosyte/hl7
sidebar_label: Build ACKs with @cosyte/hl7
description: "Build a framed HL7 v2 acknowledgment from an inbound message with the ack-from-hl7 subpath, check its warnings, and know when to use buildRawAck instead."
---

# Build ACKs with @cosyte/hl7

The `@cosyte/mllp/ack-from-hl7` subpath builds a complete acknowledgment message (`MSH`, `MSA`,
and `ERR` when you give an error) from an inbound HL7 v2 message, and frames it for the wire. It
parses the inbound with [`@cosyte/hl7`](https://docs.cosyte.com/hl7), so install that peer first:

```bash
npm install @cosyte/hl7
```

The reference entries used here are on the
[`ack-from-hl7` reference page](./api/src/ack-from-hl7.md): [`buildMllpAck`](./api/src/ack-from-hl7.md#buildmllpack),
[`buildAckAA`](./api/src/ack-from-hl7.md#buildackaa), [`MllpAck`](./api/src/ack-from-hl7.md#mllpack)
and [`detectMode`](./api/src/ack-from-hl7.md#detectmode).

## Build an acknowledgment

Build the acknowledgment only after you have committed the message. `buildAckAA` and its siblings
(`buildAckAE`, `buildAckAR`, `buildAckCA`, `buildAckCE`, `buildAckCR`) each fix one code from HL7
Table 0008; `buildMllpAck(inbound, { code })` takes the code as an option.

```ts runnable
import { buildAckAA, buildAckAE } from "@cosyte/mllp/ack-from-hl7";

const inbound = Buffer.from(
  "MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0401|P|2.5.1\r",
);

const accepted = buildAckAA(inbound);
accepted.code; // => "AA"
accepted.correlationId; // => "CTRL0401"
accepted.warnings; // => []
accepted.frame[0]; // => 0x0b

// On a processing failure, never acknowledge what you did not commit.
const failed = buildAckAE(inbound, { error: { conditionCode: "207" } });
failed.payload.toString("latin1").includes("MSA|AE|CTRL0401"); // => true
```

`frame` is the framed acknowledgment, ready for `conn.send(frame)`. `payload` is the same message
without the framing, and `ack` is the parsed acknowledgment as an `@cosyte/hl7` message.

## Check the warnings

The builder never answers a positive code it cannot correlate. When the inbound has no `MSH-10`,
cannot be parsed, or is an `FHS`/`BHS` batch, a requested `AA` or `CA` comes back as `AE` or `CE`,
and `warnings` says why:

```ts runnable
import { buildAckAA } from "@cosyte/mllp/ack-from-hl7";

const unparseable = buildAckAA(Buffer.from("this is not an HL7 message"));
unparseable.requestedCode; // => "AA"
unparseable.code; // => "AE"
unparseable.warnings.map((warning) => warning.code); // => ["MLLP_ACK_INBOUND_UNPARSEABLE"]

const noControlId = buildAckAA(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01||P|2.5.1\r"),
);
noControlId.code; // => "AE"
noControlId.warnings.map((warning) => warning.code); // => ["ACK_NO_CORRELATION_ID"]
```

`ACK_NO_CORRELATION_ID` comes from `@cosyte/hl7`; the `MLLP_` codes come from this subpath. A
warning carries a code and a fixed message, never field content.

## Pass the bytes, not decoded text

`MSA-2` has to repeat the inbound `MSH-10` byte for byte, or the sender cannot match the
acknowledgment to its message. With a `Buffer`, the builder compares what it wrote against what
arrived and reports any difference as `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. A parser re-serializes the
control ID rather than copying it, so trailing spaces, escape sequences, empty trailing components
and non-default delimiters can all change it:

```ts runnable
import { buildAckAA, MLLP_ACK_CONTROL_ID_NOT_VERBATIM } from "@cosyte/mllp/ack-from-hl7";

// MSH-10 is "MSG42 ", with a trailing space the parser trims.
const ack = buildAckAA(
  Buffer.from("MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|MSG42 |P|2.5.1\r"),
);
ack.warnings.some((warning) => warning.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM); // => true
```

With a `string` or an already parsed message, the original bytes are gone and the comparison cannot
run. When the control ID holds a character outside ASCII, the builder says so with
`MLLP_ACK_CONTROL_ID_UNVERIFIABLE` instead.

## Use buildRawAck when the echo must hold

When the control ID has to come back exactly as it arrived, whatever it contains, use
`buildRawAck(payload, code)` from the package root. It needs no parser: it copies the `MSH-10` bytes
into `MSA-2` under the inbound's own delimiters, and it is what the server's `autoAck: "AA"` path
uses. [Receive and acknowledge messages](./receive-messages.md#build-the-acknowledgment-yourself)
shows it in a server.

## Read the acknowledgment mode

`detectMode(inbound)` reports whether the inbound asks for the original protocol or the enhanced
one, from `MSH-15` and `MSH-16`:

```ts runnable
import { detectMode } from "@cosyte/mllp/ack-from-hl7";

const original = Buffer.from(
  "MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0403|P|2.5.1\r",
);
// MSH-15 is AL (always send an accept acknowledgment) and MSH-16 is NE (never an application one).
const enhanced = Buffer.from(
  "MSH|^~\\&|APP|FAC|RECV|RFAC|20260101120000||ADT^A01|CTRL0404|P|2.5.1|||AL|NE\r",
);

detectMode(original); // => "original"
detectMode(enhanced); // => "enhanced"
```

## Limits

- The `encoding` option takes only a text codec (`"utf8"`, `"ascii"`, `"latin1"` or `"binary"`); any
  other throws a `TypeError`. The default reads a `Buffer` as `latin1`, which round-trips every byte.
- A frame that holds two messages one after the other is not detected by this builder: it
  acknowledges the first. `rawAckUncorrelatable(payload)` from the package root detects both that
  shape and a batch; check it first if such frames can reach you.
- The builder trusts the code you give it. Choosing `AA`, `AE` or `AR` from your own outcome is
  yours.

[ACKs and the commit contract](./acks.md#msa-2-echoes-msh-10-verbatim-and-says-so-when-it-cant)
explains the verbatim rule and the five cases in full.
