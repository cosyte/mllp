---
id: acks
title: ACKs & the commit contract
sidebar_position: 3
---

# ACKs & the commit contract

This is the page that matters most. MLLP framing is trivial; **acknowledgement is where a transport
can hurt a patient.**

A positive acknowledgement (`AA`) means one thing to the sender: *"you may forget this message: I
have it."* A well-behaved sending system deletes its copy, or marks the message delivered and never
retries. So if a receiver says `AA` for a message it then drops (because the database was down,
because the handler threw, because the process was killed between "bytes received" and "row
committed") the message is **silently gone**. No error, no retry, no alarm. A lab result, an
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
    // throw from here and the sender gets a NEGATIVE ack, never AA
  },
});
await server.listen(2575, "127.0.0.1");
```

| Handler outcome | ACK the sender receives |
|---|---|
| Resolves | **`AA`**: application accept. MSA-2 echoes the inbound MSH-10. |
| Throws / rejects | **`AE`**: application error. The sender **may resend**; a retry could succeed. |
| Throws `new MllpAckError({ ackCode: "AR" })` | **`AR`**: application reject. Do not resend unchanged. |

`AE` is the default on failure precisely because it is the *safe* failure: it invites a retry. Use
`AR` only when a retry of the identical bytes is guaranteed to fail again (a malformed message, an
unsupported type). Telling a sender "don't bother resending" is a decision to lose the message if
you are wrong.

Do **not** call `conn.send()` inside `onMessage` when `autoAck` is set. The server is already
acknowledging, and you would emit two ACKs for one message.

## `autoAck: 'AA'` with no handler is a *transport*-accept

```ts
const server = createServer({ autoAck: "AA" }); // ⚠️ read this before using it
```

With no `onMessage` handler there is nothing to await, so the `AA` is sent on frame receipt. That
`AA` truthfully means **"bytes received and framed"**, and nothing more. It does **not** mean
"application-processed".

This is safe only when something downstream owns durability *before* the ACK goes out. On its own,
for clinical messages, it is exactly the failure mode described at the top of this page. If you are
reaching for it, reach for the commit-gated form instead.

Whichever form you use, the auto-ACK path **never answers `AA` for a message it could not
correlate**. A positive `AA`/`CA` is downgraded to a non-positive `AE`/`CE` when the inbound has no
readable `MSH`, an empty MSH-10, a batch or concatenated-message shape a single MSA-2 cannot
acknowledge, or bytes the decoder discarded mid-frame (`MLLP_TRAILING_BYTES`). An uncorrelatable
positive ACK is worse than a negative one: the sender believes a message you never received was
delivered, or resends it as a duplicate. The same downgrade guards `buildRawAck` directly.

## Full control

- **`autoAck: fn`**: `fn(payload, meta, conn)` returns the ACK bytes. You own MSA-1 entirely,
  including enhanced-mode `CA`/`CE`/`CR`. Your `onMessage` handler, if present, runs first as an
  observer and its return value is ignored.
- **`autoAck` unset (manual mode)**: your `onMessage` handler owns the response and sends it
  itself via `conn.send(encodeFrame(ackPayload))`.

The `'message'` event always fires **before** the ACK is sent, whichever mode you are in.

## Failures are reported PHI-safely

Whenever the server returns a negative ACK instead of `AA` on the auto-ACK path, it emits a `'nack'`
event carrying only `{ connectionId, ackCode, reason }`. The payload never appears in it, and
neither does the thrown error's message, which in real systems tends to contain exactly the record
that failed to write. Nothing from the failure reaches the wire beyond the ACK code itself. The
`reason` is a PHI-free enum: `'handler-rejected'` (a commit-gated handler threw/rejected),
`'uncorrelatable-inbound'` (no readable `MSH`, empty MSH-10, or a batch/concatenated frame), or
`'discarded-bytes'` (a mid-frame `VT` made the decoder discard bytes and deliver only a fragment).

```ts
server.on("nack", ({ connectionId, ackCode, reason }) =>
  metrics.increment("mllp.nack", { ackCode, reason }),
);
```

## ACK correlation on the client

`client.send()` resolves with **the ACK for your message**, not with whatever bytes arrive next.

- **FIFO (default).** ACKs are matched to sends in order.
- **`correlateByControlId: true`.** ACKs are matched by **MSH-10 → MSA-2**, which supports a peer
  that acknowledges out of order. An ACK whose MSA-2 matches nothing pending raises
  `MLLP_ACK_UNMATCHED_CONTROL_ID`; a late ACK for an already-timed-out send raises
  `MLLP_ACK_AFTER_TIMEOUT` and is dropped.

`ackTimeoutMs` (default 30 s) bounds the wait. Its clock starts at the socket **write-flush**, not
at the `send()` call. Time a message spent queued behind backpressure is not charged against the
peer's response budget.

**A timeout is not a failure to deliver.** It means you do not know. The message may have been
committed by the receiver and the ACK lost on the way back. This is the at-least-once boundary; see
[Limitations](./limitations.md).

## Building spec-correct ACKs: `ack-from-hl7`

Framing an ACK means building a real HL7 v2 `ACK^` message. That is *parsing* work, and this package
does not parse, so the optional `@cosyte/mllp/ack-from-hl7` subpath is a thin adapter over
[`@cosyte/hl7`](https://github.com/cosyte/hl7)'s `buildAck`. It is the only place the two packages
touch, and the peer is loaded lazily on first call.

```ts
import { buildAckAA, buildAckAE } from "@cosyte/mllp/ack-from-hl7";

// Only after your handler durably committed (the commit contract):
const { frame, code, correlationId } = buildAckAA(payload);
conn.send(frame); // VT + ACK + FS + CR, MSA-2 echoing the inbound MSH-10

// On a processing failure, never acknowledge what you did not commit:
conn.send(buildAckAE(payload, { error: { conditionCode: "207" } }).frame);
```

`buildMllpAck` is the core (explicit `code`); `buildAckAA/AE/AR/CA/CE/CR` are the six Table-0008
conveniences; `detectMode` reports original-vs-enhanced from the inbound MSH-15/16.

**Fail-safe by construction:** an inbound message with no findable MSH-10 **never** yields a positive
ACK. The disposition downgrades (`AA`→`AE`, `CA`→`CE`) and the result carries a warning:
`ACK_NO_CORRELATION_ID` from the peer, or `MLLP_ACK_INBOUND_UNPARSEABLE` when the inbound could not
be parsed at all. An unparseable message is one you cannot have understood, so it is one you must
not accept.

`@cosyte/hl7` is an **optional peer dependency**. Install it only if you use this subpath. Calling
in without it throws a typed `MllpPeerMissingError` rather than a bare module-not-found.

### MSA-2 echoes MSH-10 *verbatim*, and says so when it can't

HL7 v2.5.1 §2.9.2.2 requires MSA-2 to carry the inbound MSH-10 **verbatim**. That is not a
formality: the sender keys its in-flight store on the control-ID bytes it put on the wire, so an ACK
whose MSA-2 differs by a single byte is an ACK it cannot match. The send never settles, it times
out, it resends, and the receiver commits the clinical message **twice**.

So `buildMllpAck` decodes raw `Buffer` input as **`latin1`** and encodes the ACK back with the same
codec. `latin1` is a 1:1 map between the 256 byte values and `U+0000`–`U+00FF`, which makes the
round-trip the exact identity for *any* inbound bytes, including a high-bit control ID under an
`MSH-18` of `8859/1`. (It is the only codec for which that holds. `ascii` masks the high bit;
`utf8` folds invalid sequences onto `U+FFFD`; and a `TextDecoder`'s `iso-8859-1` is aliased by the
WHATWG Encoding Standard to **windows-1252**, which does not round-trip `0x80`–`0x9F` at all.)

Every build is then **checked** against the same byte-level scanners the `@cosyte/mllp` client uses
to correlate. If MSA-2 does not match the inbound MSH-10 byte-for-byte, the ACK still goes out (a
mismatched ACK tells the peer *something*, which beats silence) but it carries a
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` warning. The warning reports the two byte *lengths* and
withholds the field values: MSH-10 is inbound payload content, a warning goes to a log, and a log is
not a place PHI may reach. You already hold both byte strings: your inbound `payload`, and the
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
**re-emits MSH-10 in canonical form rather than copying its bytes**, so anything that form does not
preserve, it cannot echo verbatim:

1. **A lossy `encoding` override**: a codec that cannot round-trip the inbound bytes. The default
   never does; set it only when the receiving system genuinely demands a specific codec.
2. **Non-default delimiters** (`MSH-1`/`MSH-2`). `@cosyte/hl7` always emits the HL7 default `|^~\&`,
   so an MSH-10 of `ID#X` under a `#` component separator is re-delimited to `ID^X`.
3. **Escape sequences.** Unescaped on read, re-escaped on write: `ID\X` comes back as `ID\E\X`.
4. **Whitespace.** Fields are trimmed: `MSG42 ` comes back as `MSG42`.
5. **Trailing empty components or subcomponents.** Canonicalized away: `ID^` and `ID&` both come back
   as `ID`.

Each yields a *different* MSH-10 on the wire, and so an ACK the sender cannot match. All five warn.
And all five have the same answer: use **`buildRawAck`** (the root export, and what the server's
`autoAck` path uses). It is parser-free (it copies the MSH-10 bytes rather than re-serializing them)
so it holds the verbatim guarantee across escapes, padding, empty components, and **any** delimiter
set.

That last claim is exact, and it turns on one invariant worth stating: `buildRawAck` always emits the
ACK under the **inbound's own** field separator, never a substituted one. MSH-10 is a product of
splitting the inbound MSH *on* that separator, so it provably cannot contain it, and MSA-2 is read
back by splitting on that same separator, so the echo round-trips byte-for-byte regardless of what the
control ID contains (a `|`, a `^`, an escape, anything). When an inbound declares a field separator
that collides with the HL7 default encoding characters (`MSH-1` = `^`/`~`/`\`/`&`) and offers no
usable `MSH-2` of its own, `buildRawAck` substitutes only the one colliding **encoding** character.
It does **not** touch the field separator, precisely because the field separator is the only byte that
could truncate MSA-2.

### Pass a `Buffer`. The guarantee is a byte guarantee.

The verbatim *proof* (the byte-for-byte comparison, and `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` when it
fails) holds for a **`Buffer`** inbound, and *only* for a `Buffer`. A `Buffer` is the wire bytes, so
`buildMllpAck` can compare what it emitted against what actually arrived.

Hand it a `string` (or an already-parsed `Hl7Message`) and the wire bytes are **already gone**. It
re-encodes your text with the same codec it decodes it with, so the codec cancels on both sides and
the verbatim proof cannot run:

```ts
const wire = /* MSH-10 = A <0x8B> B, legal under MSH-18 = 8859/1 */;

buildAckAA(wire);                        // MSA-2 = A <0x8B> B         ✅ verbatim, verified
buildAckAA(wire.toString("latin1"));     // MSA-2 = A <0xC2 0x8B> B    ⚠️ different id, and it SAYS so
```

The second is the natural call for anyone already holding a decoded payload, and it still emits a
*different* control ID the sender cannot correlate. The encoding is unchanged, because from decoded
text there is no way to know the original bytes to encode back to. What changed is the **silence**:
because a text inbound's echo cannot be *verified*, `buildMllpAck` no longer passes it off as clean.
Whenever the ACK's MSA-2 control ID holds a non-ASCII **code unit** on a `string`/`Hl7Message`
inbound (the range where the codec is load-bearing) it emits **`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`**:
an explicit "this echo cannot be verified; pass the raw `Buffer` for the byte-level guarantee". An
all-ASCII control ID round-trips identically under every codec, so the common case stays quiet.

The check reads the control ID's **pre-encoding code units**, not the emitted bytes, on purpose. A
lossy `{ encoding: "ascii" }` override truncates a code unit to its low 8 bits, so a value above
`0xFF` (say `U+0153`, what a windows-1252 decode yields for a `0x9C` wire byte) is masked *into* the
ASCII byte range (`0x53`, `'S'`). An emitted-byte proxy would fall silent on exactly that corruption
(MLLP-ACK-ASCII-OVERRIDE-BLEED); the code units carry the high bit whatever the codec did to the byte,
so the strongly-discouraged text-plus-override path is flagged for the same reason the default is.

```ts
import { buildAckAA, MLLP_ACK_CONTROL_ID_UNVERIFIABLE } from "@cosyte/mllp/ack-from-hl7";

const ack = buildAckAA(decodedText);
if (ack.warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_UNVERIFIABLE)) {
  // Pass the raw payload Buffer instead. The echo cannot be verified from decoded text.
}
```

It is a *cannot-verify* signal, not a *known-broken* one: from a decoded string the two are
genuinely indistinguishable (a caller who decoded with `latin1` and re-encodes with `latin1` is
byte-safe; one who decoded with `latin1` and lets the `utf8` default re-encode is not, and the
string looks identical either way). This is why the package is `Buffer`-first on every public
surface. **Pass the raw payload.**

### Only a *text* codec is accepted, on every input shape

The `encoding` override serializes the ACK back to bytes, so it must be a codec that writes
characters as a byte stream a peer can read as HL7: `"utf8"`, `"ascii"`, `"latin1"`, or `"binary"`.
A **non-text** codec is not:

- `"base64"` / `"base64url"` / `"hex"` reinterpret the ACK **string** as encoded data and decode it to
  unrelated bytes;
- `"utf16le"` / `"ucs2"` interleave a NUL after every byte.

Either way the emitted frame is wholesale garbage the receiver cannot parse, so `buildMllpAck`
**throws a `TypeError` at the boundary** rather than hand back an unusable ACK:

```ts
buildAckAA(decodedText, { encoding: "base64" }); // ❌ throws TypeError, not a serializable ACK codec
buildAckAA(wireBuffer, { encoding: "base64" });  // ❌ throws too, same reason, on a Buffer
buildAckAA(wireBuffer, { encoding: "latin1" });  // ✅ charset codec: the byte-level escape hatch
```

This is a caller mistake, caught loudly and immediately. It applies to a **`Buffer` inbound too**
(MLLP-ACK-NONTEXT-CODEC-BUFFER): a non-text codec there garbles the *inbound* decode so it never
parses as `MSH` (routing to the unparseable fallback whose MSA-2 is empty, so the
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` check never runs) and then serializes that fallback ACK to
garbage bytes that intermittently contain a framing delimiter and trip the strict frame encoder
(`MllpFramingError`, ~3–4 % of calls, identically on Node 22 and 24). It was never the "loud AE" it
was once documented to be. The legitimate byte-level escape hatch is unchanged: a **charset** codec
on a `Buffer` (`"latin1"` byte-verbatim, or a lossy `"ascii"` that is still caught loudly by
`MLLP_ACK_CONTROL_ID_NOT_VERBATIM`) is exactly what serves a receiving system that demands a specific
byte-level codec.

### `ack-from-hl7` refuses an HL7 batch, loudly

An HL7 batch (§2.10.3) is `[FHS] { [BHS] { MSH … } [BTS] } [FTS]`: a **sequence** of messages.
`@cosyte/mllp` does not implement batch ACK, so `buildMllpAck` will not pretend to: an `FHS`/`BHS`
envelope yields the warned, non-positive fallback (`AE` + `MLLP_ACK_INBOUND_UNPARSEABLE`, no
correlation id).

That is deliberate and it is the safe answer. Acknowledging the batch's *first* message with a
positive `AA` would tell the sender the whole batch was accepted, while messages 2..N were never
looked at. They would be lost outright, or time out and resend as duplicates. A positive ACK for a
message nobody read is precisely what the [commit contract](#the-commit-contract) exists to make
impossible. Split the batch and ACK each message yourself, or handle it with `autoAck: fn`.

### Limits of the builder

- **It trusts your disposition, with one fail-safe exception.** It never decides clinical
  accept/reject: you choose `AA`/`AE`/`AR` from your own commit outcome. The exception is a
  message it cannot correlate (no readable `MSH`, an empty MSH-10, or a batch/concatenated frame)
  where a requested positive `AA`/`CA` is **downgraded** to `AE`/`CE` rather than fabricate a
  positive disposition the sender cannot match. Both builders do this (`buildRawAck` on the raw
  path; `buildMllpAck` on an unparseable inbound).
- **MSA-2 is byte-verbatim for a plain control ID under the HL7 default delimiters** (including a
  high-bit one) and, **on a `Buffer` inbound**, *loud* rather than silently wrong in the five cases
  where it cannot be (above). It
  is the parser's canonical re-serialization, not a byte copy; `buildRawAck` is the byte copy.
- **It does not ACK a batch.** An `FHS`/`BHS` envelope is refused with a warned, non-positive `AE`.
- **No enhanced-mode two-phase sequencing.** The helpers build any of the six codes; *when* to send an
  accept-ack versus an application-ack is your orchestration.
- **No MLLP Release 2 commit-ack bytes.** See [Limitations](./limitations.md).
