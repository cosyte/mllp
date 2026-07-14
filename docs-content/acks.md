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

### MSA-2 echoes MSH-10 *verbatim* — and says so when it can't

HL7 v2.5.1 §2.9.2.2 requires MSA-2 to carry the inbound MSH-10 **verbatim**. That is not a
formality: the sender keys its in-flight store on the control-ID bytes it put on the wire, so an ACK
whose MSA-2 differs by a single byte is an ACK it cannot match — the send never settles, it times
out, it resends, and the receiver commits the clinical message **twice**.

So `buildMllpAck` decodes raw `Buffer` input as **`latin1`** and encodes the ACK back with the same
codec. `latin1` is a 1:1 map between the 256 byte values and `U+0000`–`U+00FF`, which makes the
round-trip the exact identity for *any* inbound bytes — including a high-bit control ID under an
`MSH-18` of `8859/1`. (It is the only codec for which that holds. `ascii` masks the high bit;
`utf8` folds invalid sequences onto `U+FFFD`; and a `TextDecoder`'s `iso-8859-1` is aliased by the
WHATWG Encoding Standard to **windows-1252**, which does not round-trip `0x80`–`0x9F` at all.)

Every build is then **checked** against the same byte-level scanners the `@cosyte/mllp` client uses
to correlate. If MSA-2 does not match the inbound MSH-10 byte-for-byte, the ACK still goes out — a
mismatched ACK tells the peer *something*, which beats silence — but it carries a
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` warning. The warning reports the two byte *lengths* and
withholds the field values: MSH-10 is inbound payload content, a warning goes to a log, and a log is
not a place PHI may reach. You already hold both byte strings — your inbound `payload`, and the
returned `MllpAck.payload`. **Check your warnings.**

```ts
import { buildAckAA, MLLP_ACK_CONTROL_ID_NOT_VERBATIM } from "@cosyte/mllp/ack-from-hl7";

const ack = buildAckAA(payload);
if (ack.warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM)) {
  // This ACK will NOT correlate at the sender. Investigate before you ship it.
}
conn.send(ack.frame);
```

**Five** things provoke it. The first is yours; the other four are `@cosyte/hl7`'s serializer, which
**re-emits MSH-10 in canonical form rather than copying its bytes** — so anything that form does not
preserve, it cannot echo verbatim:

1. **A lossy `encoding` override** — a codec that cannot round-trip the inbound bytes. The default
   never does; set it only when the receiving system genuinely demands a specific codec.
2. **Non-default delimiters** (`MSH-1`/`MSH-2`). `@cosyte/hl7` always emits the HL7 default `|^~\&`,
   so an MSH-10 of `ID#X` under a `#` component separator is re-delimited to `ID^X`.
3. **Escape sequences.** Unescaped on read, re-escaped on write: `ID\X` comes back as `ID\E\X`.
4. **Whitespace.** Fields are trimmed: `MSG42 ` comes back as `MSG42`.
5. **Trailing empty components or subcomponents.** Canonicalized away: `ID^` and `ID&` both come back
   as `ID`.

Each yields a *different* MSH-10 on the wire, and so an ACK the sender cannot match. All five warn.
And all five have the same answer: use **`buildRawAck`** (the root export, and what the server's
`autoAck` path uses). It is parser-free — it copies the MSH-10 bytes rather than re-serializing them
— so it holds the verbatim guarantee under any delimiter set, escape, padding, or empty component.

### `ack-from-hl7` refuses an HL7 batch, loudly

An HL7 batch (§2.10.3) is `[FHS] { [BHS] { MSH … } [BTS] } [FTS]` — a **sequence** of messages.
`@cosyte/mllp` does not implement batch ACK, so `buildMllpAck` will not pretend to: an `FHS`/`BHS`
envelope yields the warned, non-positive fallback (`AE` + `MLLP_ACK_INBOUND_UNPARSEABLE`, no
correlation id).

That is deliberate and it is the safe answer. Acknowledging the batch's *first* message with a
positive `AA` would tell the sender the whole batch was accepted, while messages 2..N were never
looked at — they would be lost outright, or time out and resend as duplicates. A positive ACK for a
message nobody read is precisely what the [commit contract](#the-commit-contract) exists to make
impossible. Split the batch and ACK each message yourself, or handle it with `autoAck: fn`.

### Limits of the builder

- **It trusts your disposition.** It never decides clinical accept/reject — you choose `AA`/`AE`/`AR`
  from your own commit outcome.
- **MSA-2 is byte-verbatim for a plain control ID under the HL7 default delimiters** — including a
  high-bit one — and *loud*, never silently wrong, in the five cases where it cannot be (above). It
  is the parser's canonical re-serialization, not a byte copy; `buildRawAck` is the byte copy.
- **It does not ACK a batch.** An `FHS`/`BHS` envelope is refused with a warned, non-positive `AE`.
- **No enhanced-mode two-phase sequencing.** The helpers build any of the six codes; *when* to send an
  accept-ack versus an application-ack is your orchestration.
- **No MLLP Release 2 commit-ack bytes.** See [Limitations](./limitations.md).
