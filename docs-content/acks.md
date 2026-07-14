---
id: acks
title: ACKs & the commit contract
sidebar_position: 3
---

# ACKs & the commit contract

This is the page that matters most. MLLP framing is trivial; **acknowledgement is where a transport
can hurt a patient.**

A positive acknowledgement (`AA`) means one thing to the sender: *"you may forget this message — I
have it."* A well-behaved sending system deletes its copy, or marks the message delivered and never
retries. So if a receiver says `AA` for a message it then drops — because the database was down,
because the handler threw, because the process was killed between "bytes received" and "row
committed" — the message is **silently gone**. No error, no retry, no alarm. A lab result, an
allergy update, a discharge order: acknowledged and lost.

`@cosyte/mllp` is built so that this is hard to do by accident.

## The commit contract

**A positive ACK can never precede a successful durable commit.**

Pair `autoAck: 'AA'` with an `onMessage` handler and the server treats your handler *as* the commit
step: it **awaits** it, and only then acknowledges.

```ts
import { createServer } from "@cosyte/mllp";

const server = createServer({
  autoAck: "AA",
  onMessage: async (payload, meta, conn) => {
    await db.commit(payload); // the durable-commit step
    // throw from here and the sender gets a NEGATIVE ack — never AA
  },
});
await server.listen(2575, "127.0.0.1");
```

| Handler outcome | ACK the sender receives |
|---|---|
| Resolves | **`AA`** — application accept. MSA-2 echoes the inbound MSH-10. |
| Throws / rejects | **`AE`** — application error. The sender **may resend**; a retry could succeed. |
| Throws `new MllpAckError({ ackCode: "AR" })` | **`AR`** — application reject. Do not resend unchanged. |

`AE` is the default on failure precisely because it is the *safe* failure: it invites a retry. Use
`AR` only when a retry of the identical bytes is guaranteed to fail again (a malformed message, an
unsupported type) — telling a sender "don't bother resending" is a decision to lose the message if
you are wrong.

Do **not** call `conn.send()` inside `onMessage` when `autoAck` is set — the server is already
acknowledging, and you would emit two ACKs for one message.

## `autoAck: 'AA'` with no handler is a *transport*-accept

```ts
const server = createServer({ autoAck: "AA" }); // ⚠️ read this before using it
```

With no `onMessage` handler there is nothing to await, so the `AA` is sent on frame receipt. That
`AA` truthfully means **"bytes received and framed"** — and nothing more. It does **not** mean
"application-processed".

This is safe only when something downstream owns durability *before* the ACK goes out. On its own,
for clinical messages, it is exactly the failure mode described at the top of this page. If you are
reaching for it, reach for the commit-gated form instead.

## Full control

- **`autoAck: fn`** — `fn(payload, meta, conn)` returns the ACK bytes. You own MSA-1 entirely,
  including enhanced-mode `CA`/`CE`/`CR`. Your `onMessage` handler, if present, runs first as an
  observer and its return value is ignored.
- **`autoAck` unset (manual mode)** — your `onMessage` handler owns the response and sends it
  itself via `conn.send(encodeFrame(ackPayload))`.

The `'message'` event always fires **before** the ACK is sent, whichever mode you are in.

## Failures are reported PHI-safely

When a commit-gated handler fails, the server emits a `'nack'` event carrying only
`{ connectionId, ackCode }`. The payload never appears in it — and neither does the thrown error's
message, which in real systems tends to contain exactly the record that failed to write. Nothing
from the failure reaches the wire beyond the ACK code itself.

```ts
server.on("nack", ({ connectionId, ackCode }) => metrics.increment("mllp.nack", { ackCode }));
```

## ACK correlation on the client

`client.send()` resolves with **the ACK for your message**, not with whatever bytes arrive next.

- **FIFO (default).** ACKs are matched to sends in order.
- **`correlateByControlId: true`.** ACKs are matched by **MSH-10 → MSA-2**, which supports a peer
  that acknowledges out of order. An ACK whose MSA-2 matches nothing pending raises
  `MLLP_ACK_UNMATCHED_CONTROL_ID`; a late ACK for an already-timed-out send raises
  `MLLP_ACK_AFTER_TIMEOUT` and is dropped.

`ackTimeoutMs` (default 30 s) bounds the wait. Its clock starts at the socket **write-flush**, not
at the `send()` call — time a message spent queued behind backpressure is not charged against the
peer's response budget.

**A timeout is not a failure to deliver.** It means you do not know. The message may have been
committed by the receiver and the ACK lost on the way back. This is the at-least-once boundary; see
[Limitations](./limitations.md).

## Building spec-correct ACKs: `ack-from-hl7`

Framing an ACK means building a real HL7 v2 `ACK^` message. That is *parsing* work, and this package
does not parse — so the optional `@cosyte/mllp/ack-from-hl7` subpath is a thin adapter over
[`@cosyte/hl7`](https://github.com/cosyte/hl7)'s `buildAck`. It is the only place the two packages
touch, and the peer is loaded lazily on first call.

```ts
import { buildAckAA, buildAckAE } from "@cosyte/mllp/ack-from-hl7";

// Only after your handler durably committed — the commit contract:
const { frame, code, correlationId } = buildAckAA(payload);
conn.send(frame); // VT + ACK + FS + CR, MSA-2 echoing the inbound MSH-10

// On a processing failure — never acknowledge what you did not commit:
conn.send(buildAckAE(payload, { error: { conditionCode: "207" } }).frame);
```

`buildMllpAck` is the core (explicit `code`); `buildAckAA/AE/AR/CA/CE/CR` are the six Table-0008
conveniences; `detectMode` reports original-vs-enhanced from the inbound MSH-15/16.

**Fail-safe by construction:** an inbound message with no findable MSH-10 **never** yields a positive
ACK. The disposition downgrades (`AA`→`AE`, `CA`→`CE`) and the result carries a warning —
`ACK_NO_CORRELATION_ID` from the peer, or `MLLP_ACK_INBOUND_UNPARSEABLE` when the inbound could not
be parsed at all. An unparseable message is one you cannot have understood, so it is one you must
not accept.

`@cosyte/hl7` is an **optional peer dependency** — install it only if you use this subpath. Calling
in without it throws a typed `MllpPeerMissingError` rather than a bare module-not-found.

### Limits of the builder

- **It trusts your disposition.** It never decides clinical accept/reject — you choose `AA`/`AE`/`AR`
  from your own commit outcome.
- **MSA-2 is the inbound MSH-10's canonical re-serialization,** not its original bytes. Plain and
  delimiter-bearing ids (`ID^X`) echo byte-exact; hex escapes decode (`\X41\` → `A`); custom-delimiter
  senders are re-delimited spec-cleanly; trailing insignificant empties canonicalize.
- **A non-default `encoding` can silently mangle non-ASCII header content** — single-byte encodings
  map out-of-repertoire characters with no warning.
- **No enhanced-mode two-phase sequencing.** The helpers build any of the six codes; *when* to send an
  accept-ack versus an application-ack is your orchestration.
- **No MLLP Release 2 commit-ack bytes.** See [Limitations](./limitations.md).
