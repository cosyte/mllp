---
id: limitations
title: Known limitations & non-goals
sidebar_position: 6
---

# Known limitations & non-goals

The honest list. A transport that oversells what it guarantees is how messages get lost, so this page
is a deliverable, not a footnote. **Do not rely on `@cosyte/mllp` to do any of the following.**

## It does not parse or validate HL7 v2

`@cosyte/mllp` moves bytes. It never inspects the payload, never validates a segment, never checks a
code system. Pair it with [`@cosyte/hl7`](https://github.com/cosyte/hl7). The one exception is the
optional [`ack-from-hl7`](./acks.md) subpath, which delegates the parsing to `@cosyte/hl7` anyway.

## It cannot guarantee delivery

MLLP plus an HL7 ACK is **at-least-once at best**, and the gap is unavoidable: if the receiver
commits your message and the ACK is lost on the way back, the sender cannot tell that apart from the
receiver never having got it. Both look like a timeout.

**The application owns idempotency and de-duplication**: key on `MSH-10` (message control ID) plus
`MSH-7` (timestamp). `@cosyte/mllp` surfaces unacked messages to you; it does **not** store them,
queue them, or replay them. There is no write-ahead log in this package. If you need one, it lives in
your application, not here.

## It drains in-flight messages on `close()`, and still cannot make delivery certain

`close()` **waits** for the ACKs of sends already written to the transport. `drainTimeoutMs` is what
bounds that wait (default `30_000` ms), and it is the whole bound: the drain ends the moment the last
outstanding ACK arrives, so a peer that answers promptly does not cost you the timeout. If the link
fails mid-drain, `close()` returns then rather than waiting the bound out.

What is still unresolved when the wait ends is reported to its own `send()` caller, and the two
populations are **told apart**, because a replay decision turns on which one a message is in:

- **Never delivered.** `MllpNeverDeliveredError`: the message was still held inside the client and no
  bytes were written for it, so the receiver cannot have seen it. Resending it cannot duplicate
  anything.
- **Fate unknown.** `MllpUnknownFateError`: the bytes went out and no ACK came back. It carries
  `flushedAt` (when they went out), `elapsedMs` and `byteCount`, and **no payload content at all**,
  not the control ID, only its byte length. The receiver may hold this message, so resending it may
  commit a clinical message twice.
- **Committed, application disposition unknown.** `MllpApplicationAckError({ reason:
  'connection-lost' })`, unchanged: an enhanced-mode send whose commit disposition had already
  arrived keeps the error that names that commit. The receiver's custody of those bytes is a known
  fact, and a shutdown never downgrades it to an unknown one.

Tell them apart with `instanceof`, never by reading an error message.

**A drain cannot make delivery certain, and this one does not pretend to.** A commit whose ACK is
lost in flight is indistinguishable from a message never received, and always will be: that is what
the unknown-fate report says out loud. Nothing is retried automatically, because the accept
acknowledgement is what releases a sender from resending, and the standard puts the retransmission
decision on the application and on its peer's duplicate detection (`MSH-10` + `MSH-7`). There is
still no write-ahead log, queue or replay in this package.

`destroy()` is the other half of the pair and is unchanged: it settles every pending send at once,
awaits no ACK and honours no drain timeout. Use it when you need the socket gone now. See
[Connection, reconnect & backpressure](./reliability.md).

## A fatal framing error drops the connection, and is not retried

If the decoder throws (an oversized frame, or a structural violation whose tolerance opt-in is off),
that **connection** is destroyed. It is not resynchronized: after a throw the reader's position in
the byte stream is untrustworthy, and guessing where the next message starts is how one gets silently
mis-split. Bytes already accumulated in that connection's partial frame are **lost**.

The failure is contained to the one connection (a server keeps serving every other peer) and it is
classified `framing-fatal`, i.e. **permanent**, so a client does not reconnect into it. That is
deliberate (a peer speaking the wrong protocol would otherwise be retried forever), but it means a
client facing a peer that emits *occasional* junk will **stop**, not heal. If a peer's quirk is
expected, use the tolerance opt-ins so the bytes are a warning rather than a fatal. See
[Framing & tolerance](./framing.md).

## It does not complete an enhanced-mode exchange on the server side

The client half is built: an enhanced-mode send correlated by control ID draws both its commit
disposition and its later application disposition, and neither is dropped
([ACKs](./acks.md#enhanced-mode-one-send-two-acknowledgements)). Three bounds on that:

- **This package's own server never sends the second acknowledgement.** It emits exactly one ACK per
  inbound message and picks the right half of Table 0008 for it. Pointing this client at this server
  with both MSH-15 and MSH-16 asking for acknowledgement therefore ends at the
  application-acknowledgement timeout. A consumer that needs the second exchange owns it.
- **Two-phase correlation needs `correlateByControlId: true`.** MSA-2 is the only thing that can
  attribute a second acknowledgement to a send, and the default is FIFO. On FIFO an enhanced-mode
  send gets the ordinary single-acknowledgement behaviour plus a warning.
- **A conditional application condition that is never met ends at that timeout.** MSH-16 `SU` whose
  peer applies the message unsuccessfully, or `ER` whose peer applies it successfully, never draws a
  second acknowledgement. The failure carries the commit disposition you did receive, so you know the
  peer took custody; what its application did is unknown and unknowable from here.

Enhanced mode over a **batch** frame stays refused, and no sequence-number protocol (MSH-13/MSA-4),
retransmission, queueing or replay is implemented here or planned for here.

## It does not decide clinical acceptance

The package builds *conformant* ACKs and structurally enforces *never-`AA`-without-commit*. It does
not, and cannot, decide whether your application should accept a message. `AA` / `AE` / `AR` is your
call, from your own processing outcome. See [the commit contract](./acks.md).

## It does not speak MLLP Release 2

Only **Release 1** (framing, with reliability delegated to the HL7 v2 ACK) is implemented: the
universal default for HL7 v2. The R2 commit-acknowledgement blocks (`<SB><ACK 0x06><EB><CR>` /
`<SB><NAK 0x15><EB><CR>`) and R2's synchronous "no new content until ack" discipline are **not
supported**. R2 is used mainly with HL7 v3 and is rarely needed for v2; if it ships, it will be
opt-in and off by default, and R1 framing will never silently downgrade to it.

## It is not differentially verified against Epic or Cerner

Interop is proven against **freely available** engines only: the Google Cloud Healthcare MLLP
adapter and Mirth/NextGen Connect (byte-parity on canonical R1 frames, plus a live-adapter tier).
Neither Epic nor Cerner is part of that harness. Their behavior is inferred from the spec, not
observed. Validate against your actual peer before you trust a production interface.

## It ships no PKI

TLS verifies **caller-supplied** certificates. This package bundles no CA, issues nothing, rotates
nothing, and has no opinion about your certificate lifecycle. See [MLLPS / TLS](./tls.md).

## It cannot claim an IHE option on your behalf

The offered cipher suites are a property of this package once you select `atnaTransportSecurity`,
and every completed handshake reports the protocol version and suite it agreed on. That is support
and evidence, and it is as far as a transport library can go: an IHE option is claimed by an
**actor**, in a conformance statement, and that statement is yours to make. With the option left
off, the offered suites are not this package's at all: they are the runtime's, which a Node
distribution can configure at build time and an operator can replace from outside the process. See
[MLLPS / TLS](./tls.md).

What this package *does* declare about itself, in the actor-and-option wording a Product Registry
entry or a Connectathon test is recorded in, is on one page: the
[Conformance statement](./conformance.md). It names what this package supplies for each option and
what stays yours, and it claims none of them on your behalf.

## It cannot carry charsets that collide with the framing bytes

MLLP is **not byte-transparent**. `0x0B` and `0x1C` are structural. A payload encoded in UTF-16 or
UTF-32 will contain those bytes inside ordinary characters, and any MLLP implementation (not just
this one) will mis-frame it. Use a single-byte encoding, UTF-8, or Shift_JIS. Which charset is in
play is the HL7 message's `MSH-18` concern, not the transport's.

## `ack-from-hl7` re-serializes the control ID; it does not copy its bytes

MSA-2 must carry the inbound MSH-10 **verbatim** (HL7 v2.5.1 §2.9.2.2), because that is the key the
sender correlates its ACK on. `buildMllpAck` (the `/ack-from-hl7` subpath) holds that guarantee
byte-for-byte for a plain control ID under the HL7 default delimiters (including a high-bit one
under an `MSH-18` of `8859/1`) but it builds through `@cosyte/hl7`, which **re-emits** MSH-10 in its
canonical form rather than copying the bytes. Five things that canonical form does not preserve:

- **Non-default delimiters.** `@cosyte/hl7` always emits `|^~\&`, so `ID#X` under a `#` component
  separator is re-delimited to `ID^X`.
- **Escape sequences.** Unescaped on read, re-escaped on write: `ID\X` comes back as `ID\E\X`.
- **Whitespace.** Fields are trimmed: `MSG42 ` comes back as `MSG42`.
- **Trailing empty components/subcomponents.** Canonicalized away: `ID^` and `ID&` both become `ID`.
- **A lossy `encoding` override.** Any codec that cannot round-trip the inbound bytes.

Each yields a *different* MSH-10, and so an ACK the sender cannot match. On a **`Buffer`** inbound none
of them is silent. The result carries `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. And all five have the same
answer: **`buildRawAck`**
(the root export, and what the server's `autoAck` path uses) is parser-free (it copies the MSH-10
bytes) so it holds the verbatim guarantee across escapes, padding, empty components, and **any**
delimiter set. It always emits the ACK under the inbound's own field separator (never a substituted
one), and MSH-10 provably cannot contain that separator, so the echo round-trips byte-for-byte
whatever the control ID contains. See [ACKs](./acks.md).

And the *verbatim proof* is a **`Buffer`** guarantee. On a `string` / `Hl7Message` inbound the wire
bytes were decoded before `buildMllpAck` ever saw them, so it re-encodes your text with the same codec
it decoded it with: the codec cancels on both sides, and `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` (a
byte-for-byte comparison) cannot fire. `buildAckAA(payload.toString("latin1"))` on a high-bit control
ID (`0x8B`) emits the two `utf8` bytes `0xC2 0x8B`, a *different* control ID the sender cannot
correlate. The encoding cannot be fixed from here (decoded text does not remember its bytes), and the
verbatim check cannot catch it (the bytes are gone), but the API no longer stays **silent** about it.
Whenever the emitted MSA-2 holds a non-ASCII byte on a text inbound, `buildMllpAck` emits
**`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`**: a distinct "cannot verify this echo; pass a `Buffer`" signal,
separate from the `Buffer`-path proof-of-mismatch. An all-ASCII control ID round-trips under every
codec and stays quiet. Pass a `Buffer`. That is what the `Buffer`-first API rule is for.

A **non-text** `encoding` override is a step past even that. It is **rejected**, not warned, on
**every** input shape. `"base64"`/`"base64url"`/`"hex"` reinterpret the ACK *string* as encoded data,
and `"utf16le"`/`"ucs2"` NUL-pad every byte, so the emitted frame is wholesale garbage a receiver
cannot parse. Because a garbage frame is a caller mistake rather than a runtime condition,
`buildMllpAck` throws a `TypeError` at the boundary for a non-text codec; only text codecs
(`"utf8"`/`"ascii"`/`"latin1"`/`"binary"`) are accepted. This includes a
`Buffer` inbound: a non-text codec there garbles the *inbound* decode into the unparseable fallback
(empty MSA-2, so the `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` proof never runs) and then serializes the
fallback ACK to garbage bytes that ~3–4 % of the time (identically on Node 22 and 24) contain a
`VT`/`FS` byte and trip the strict frame encoder with a nondeterministic `MllpFramingError`. It was
never the "loud AE" escape hatch it was documented to be. The legitimate byte-level escape hatch is
untouched: a **charset** codec on a `Buffer` (`"latin1"` byte-verbatim, or a lossy `"ascii"` that
still surfaces as the loud `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` proof) is what serves a peer that
demands a specific byte-level codec.

Neither builder **ACKs an HL7 batch** (§2.10.3) or a frame of concatenated messages. An `FHS`/`BHS`
envelope, or a second `MSH` in the same frame, yields the warned, non-positive `AE`, never a
positive `AA` correlated to the first message, which would tell the sender the whole batch was
accepted while messages 2..N went unread. `buildMllpAck` refuses via its unparseable fallback;
`buildRawAck` and the server's auto-ACK path refuse by downgrading a requested positive code. A raw
`VT` inside a payload is the same class of hazard from the transport side: the decoder discards the
accumulated bytes (`MLLP_TRAILING_BYTES`) and delivers only the fragment after it, and the auto-ACK
path downgrades that frame rather than positively acknowledge a destroyed message. Batch ACK is its
own unbuilt feature.

## The API is not stable yet

`@cosyte/mllp` is on the `0.0.x` ladder and **pre-alpha**. There is no API-stability promise and no
deprecation cycle: any release may change the public surface. The stable **warning codes** and
**security-warning codes** are treated as public API within that caveat (renaming one is a breaking
change) but the ladder itself makes no 1.0-style guarantees. Pin an exact version.

---

## The one thing this package exists to prevent

**A sender being told its message was accepted when it was lost.**

Everything above is a bound on what the transport promises. That single failure mode is the one it
refuses to allow, by construction: the commit contract makes a positive ACK structurally unable to
precede a durable commit, and an inbound message that cannot be understood can never produce a
positive acknowledgement. The rest of the package hardens the transport around that guarantee.
