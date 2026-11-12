---
id: limitations
title: Known limitations and non-goals
sidebar_label: Known limitations and non-goals
description: "What not to trust this transport to do: delivery guarantees, batch acknowledgment, Release 2, colliding charsets, and where the public surface stands today."
---

# Known limitations and non-goals

The honest list. A transport that oversells what it guarantees is how messages get lost, so this page
is a deliverable, not a footnote. **Do not rely on `@cosyte/mllp` to do any of the following.**

## It does not parse or validate HL7 v2

`@cosyte/mllp` moves bytes. It never inspects the payload, never validates a segment, never checks a
code system. Pair it with [`@cosyte/hl7`](https://docs.cosyte.com/hl7). The one exception is the
optional [`ack-from-hl7`](./acks.md) subpath, which delegates the parsing to `@cosyte/hl7` anyway.

## It cannot guarantee delivery

MLLP plus an HL7 ACK is **at-least-once at best**, and the gap is unavoidable: if the receiver
commits your message and the ACK is lost on the way back, the sender cannot tell that apart from the
receiver never having got it. Both look like a timeout.

**The application owns idempotency and de-duplication**: key on `MSH-10` (message control ID) plus
`MSH-7` (timestamp). `@cosyte/mllp` surfaces unacknowledged messages to you. It holds a send in
memory only until it settles, and nothing survives a restart: there is no write-ahead log in this
package. If you need one, it lives in your application, not here. The one case in which the client
writes a message again by itself is a reconnect while correlating by control ID, described in
[What happens to pending sends when the link drops](./reliability.md#what-happens-to-pending-sends-when-the-link-drops);
that resend is exactly why the receiver's de-duplication matters.

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
- **Committed, application disposition unknown.**
  `MllpApplicationAckError({ reason: 'connection-lost' })`, unchanged: an enhanced-mode send whose
  commit disposition had already arrived keeps the error that names that commit. The receiver's
  custody of those bytes is a known fact, and a shutdown never downgrades it to an unknown one.

Tell them apart with `instanceof`, never by reading an error message.

**A drain cannot make delivery certain, and this one does not pretend to.** A commit whose ACK is
lost in flight is indistinguishable from a message never received, and always will be: that is what
the unknown-fate report says out loud. Nothing is retried at shutdown, because the accept
acknowledgment is what releases a sender from resending, and the standard puts the retransmission
decision on the application and on its peer's duplicate detection (`MSH-10` + `MSH-7`). There is
still no write-ahead log, queue, or replay in this package.

`destroy()` is the other half of the pair and is unchanged: it settles every pending send at once,
awaits no ACK and honors no drain timeout. Use it when you need the socket gone now. See
[Connection, reconnect and backpressure](./reliability.md).

## A fatal framing error drops the connection, and is not retried

If the decoder throws (an oversized frame, or a structural violation whose tolerance opt-in is off),
that **connection** is destroyed. It is not resynchronized: after a throw the reader's position in
the byte stream is untrustworthy, and guessing where the next message starts is how one gets silently
mis-split. Bytes already accumulated in that connection's partial frame are **lost**.

The failure is contained to the one connection (a server keeps serving every other peer) and it is
classified `framing-fatal`, i.e. **permanent**, so a client does not reconnect into it. That is
deliberate (a peer speaking the wrong protocol would otherwise be retried forever), but it means a
client facing a peer that emits _occasional_ junk will **stop**, not heal. If a peer's quirk is
expected, use the tolerance opt-ins so the bytes are a warning rather than a fatal. See
[Framing and tolerance](./framing.md).

## It does not bound its connections unless you ask it to

A server accepts every connection it is offered by default, so a sender that opens connections and
never closes them can use up the process's file descriptors. Set `maxConnections` to bound them: a
connection over the cap is closed at accept and reported as `connectionRejected`
(`MLLP_CONNECTION_LIMIT_REACHED`). That is the whole of it. There is no rate limit, no per-sender
quota and no allow-list: a sender that keeps the server full keeps others out, and choosing who may
connect belongs to your network layer or to a `connection` handler that closes what it does not
trust. See [Cap the number of connections](./receive-messages.md#cap-the-number-of-connections).

## It enforces its TLS cipher options on Node.js only

We build on Node's `node:tls`. Bun and Deno provide their own version of it, and neither enforces
every one of our cipher and Diffie-Hellman options. We do not pass an option to a runtime that would
not enforce it: `connect()` or `listen()` rejects with a typed `MllpTlsConfigurationError` instead,
before any socket exists.

- **Deno, `ciphers`, `atnaTransportSecurity` and `dhParameters`:** refused. Deno takes a cipher list
  and Diffie-Hellman parameters without applying them.
- **Bun, `atnaTransportSecurity` and `dhParameters`:** refused. Bun's TLS library has no
  finite-field Diffie-Hellman suite. `ciphers` is enforced on Bun.

So on Bun and Deno a restricted configuration fails loudly rather than running unrestricted. Run on
Node.js when you rely on these options. `maxConnections` holds on all three, with its
`connectionRejected` event. See [Under Bun and Deno](./tls.md#under-bun-and-deno).

## It does not complete an enhanced-mode exchange on the server side

The client half is built: an enhanced-mode send correlated by control ID draws both its commit
disposition and its later application disposition, and neither is dropped
([ACKs](./acks.md#enhanced-mode-one-send-two-acknowledgments)). Three bounds on that:

- **This package's own server never sends the second acknowledgment.** It emits exactly one ACK per
  inbound message and picks the right half of Table 0008 for it. Pointing this client at this server
  with both MSH-15 and MSH-16 asking for acknowledgment therefore ends at the
  application-acknowledgment timeout. A consumer that needs the second exchange owns it.
- **Two-phase correlation needs `correlateByControlId: true`.** MSA-2 is the only thing that can
  attribute a second acknowledgment to a send, and the default is FIFO. On FIFO an enhanced-mode
  send gets the ordinary single-acknowledgment behavior plus a warning.
- **A conditional application condition that is never met ends at that timeout.** MSH-16 `SU` whose
  peer applies the message unsuccessfully, or `ER` whose peer applies it successfully, never draws a
  second acknowledgment. The failure carries the commit disposition you did receive, so you know the
  peer took custody; what its application did is unknown and unknowable from here.

Enhanced mode over a **batch** frame stays refused, and the sequence-number protocol
(MSH-13/MSA-4) is not implemented.

## It does not decide clinical acceptance

The package builds _conformant_ ACKs and structurally enforces _never-`AA`-without-commit_. It does
not, and cannot, decide whether your application should accept a message. `AA` / `AE` / `AR` is your
call, from your own processing outcome. See [the commit contract](./acks.md).

## It does not speak MLLP Release 2

Only **Release 1** is implemented: the frame (`VT` + payload + `FS` + `CR`), with reliability left to
the HL7 v2 acknowledgment inside it. This section is the decision on Release 2, recorded so that it
is a choice a reader can check rather than a gap a reader has to discover.

**Decision.** Release 2 is not built: not its commit-acknowledgment blocks, not its synchronous "no
new content until acknowledged" discipline, and no option selects it.

**Why.** Release 2 adds a second acknowledgment below the HL7 one, and the one guarantee this
package exists for (never a positive acknowledgment before a durable commit) is built and tested
around the HL7 acknowledgment alone. A second positive signal would need that guarantee proved
again, for a link shape that nobody using this package has asked for: no issue on this repository
asks for Release 2.

**What would change it.** A user with a named peer that requires Release 2 on an HL7 v2 link, and
the Release 2 specification read for the build, not summarized from secondary sources. It would then
be its own piece of work, opt-in and off by default.

**Release 1 never silently downgrades.** There is no Release 2 code path for a Release 1 link to fall
into. A peer that answers with a frame holding a single `ACK` (`0x06`) or `NAK` (`0x15`) byte, which
is how Release 2 commit blocks are commonly described, gets Release 1 treatment:

- **The server** reads it as an ordinary frame with no readable `MSH`. The automatic acknowledgment
  never answers that `AA`: a requested `AA` becomes the non-positive `AE`, as for any frame it cannot
  correlate.
- **A client with `correlateByControlId: true`** finds no MSA-2 in it, reports it on `error` as
  `MLLP_ACK_UNMATCHED_CONTROL_ID` and settles nothing. The send keeps waiting for its real
  acknowledgment, or times out.
- **A FIFO client (the default)** settles the next send on whatever frame comes next, this one
  included, and `send()` resolves with that one byte. Resolving is not acceptance: `send()` hands you
  the acknowledgment and its MSA-1 is yours to read, and here there is none. If a peer may send such
  blocks, correlate by control ID.

## It does not acknowledge an HL7 batch

An HL7 batch (`FHS`/`BHS`, HL7 v2.5.1 §2.10.3) carries many messages in one frame. This section is
the decision on acknowledging one.

**Decision.** Batch acknowledgment is not built. A batch envelope, or a frame holding a second
`MSH`, is refused with a non-positive answer and is never acknowledged as a batch.

**Why.** An honest positive answer to a batch says every message in it was committed, and this
package cannot know that. It moves bytes and never parses a payload, the server's commit step is
one `onMessage` call per frame, and the one MSA-2 an acknowledgment carries can echo only one control
ID. The answer that fits in what we know is the one we give: a positive acknowledgment correlated to
the first message would tell the sender the whole batch was accepted while messages 2..N went
unread. No issue on this repository asks for batch acknowledgment.

**What would change it.** A user whose peer sends batches over MLLP and needs an answer it accepts,
with the batch acknowledgment rules read in the HL7 v2 standard for the build. Splitting a batch is
parsing, which belongs to `@cosyte/hl7`, and a positive answer would have to wait until every message
in it was committed. It would be its own piece of work.

**Release 1 never silently downgrades.** A Release 1 link stays one message per frame. A batch is
never split, never re-based on its first `MSH`, and never answered `AA`:

- **The server's automatic acknowledgment, and `buildRawAck` behind it,** downgrade a requested
  positive `AA` or `CA` to the non-positive `AE` or `CE`.
- **`buildMllpAck` on the `@cosyte/mllp/ack-from-hl7` subpath** answers a batch envelope with the
  warned, non-positive `AE`. A second `MSH` behind a readable first one is the exception it does not
  detect; [Batch and concatenated frames, route by
  route](./conformance.md#batch-and-concatenated-frames-route-by-route) records it, with
  `rawAckUncorrelatable(payload)` as the check to run first.
- **Enhanced mode over a batch frame** stays refused, as above.

## It is not differentially verified against Epic or Cerner, so verify your own engine

Our tests compare this package's framing, byte for byte, with canonical Release 1 frames written
from the specification for two freely available engines, the Google Cloud Healthcare MLLP adapter
and Mirth/NextGen Connect. Those frames are derived from the specification, not captured from a
running engine, and no live engine runs in our CI; a developer can point the same tests at one they
run locally. Neither Epic nor Cerner is part of any of it. Their behavior is inferred from the spec,
not observed, and this package will never tell you otherwise.

**What it gives you instead is the harness, so you can observe your own engine before go-live.**
`runDifferential` ships in the package. Point it at an engine you name and it reports, per exchange,
whether the frame that came back was byte-identical to the canonical Release 1 block
(`VT` + payload + `FS` + `CR`) and whether its `MSA-2` echoed the `MSH-10` of the message it
answered. What the report carries, what it deliberately does not, and how to aim a run safely are on
[Test your code and verify an engine](./testing.md#verify-your-own-engine-rundifferential).

That harness does not soften the non-goal above. A run is evidence **you** hold about **your** peer,
gathered by a corpus of synthetic messages; it is not a conformance verdict, and this package issues
none about an engine it has never met.

## It ships no PKI

TLS verifies **caller-supplied** certificates. This package bundles no CA, issues nothing, rotates
nothing, and has no opinion about your certificate lifecycle. See [Secure a link with TLS](./tls.md).

## It cannot claim an IHE option on your behalf

The offered cipher suites are a property of this package once you select `atnaTransportSecurity`,
and every completed handshake reports the protocol version and suite it agreed on. That is support
and evidence, and it is as far as a transport library can go: an IHE option is claimed by an
**actor**, in a conformance statement, and that statement is yours to make. With the option left
off, the offered suites are not this package's at all: they are the runtime's, which a Node
distribution can configure at build time and an operator can replace from outside the process. See
[Secure a link with TLS](./tls.md).

What this package _does_ declare about itself, in the actor-and-option wording a Product Registry
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

Each yields a _different_ MSH-10, and so an ACK the sender cannot match. On a **`Buffer`** inbound none
of them is silent. The result carries `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. And all five have the same
answer: **`buildRawAck`**
(the root export, and what the server's `autoAck` path uses) is parser-free (it copies the MSH-10
bytes) so it holds the verbatim guarantee across escapes, padding, empty components, and **any**
delimiter set. It always emits the ACK under the inbound's own field separator (never a substituted
one), and MSH-10 provably cannot contain that separator, so the echo round-trips byte-for-byte
whatever the control ID contains. See [ACKs](./acks.md).

And the _verbatim proof_ is a **`Buffer`** guarantee. On a `string` / `Hl7Message` inbound the wire
bytes were decoded before `buildMllpAck` ever saw them, so it re-encodes your text with the same codec
it decoded it with: the codec cancels on both sides, and `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` (a
byte-for-byte comparison) cannot fire. `buildAckAA(payload.toString("latin1"))` on a high-bit control
ID (`0x8B`) emits the two `utf8` bytes `0xC2 0x8B`, a _different_ control ID the sender cannot
correlate. The encoding cannot be fixed from here (decoded text does not remember its bytes), and the
verbatim check cannot catch it (the bytes are gone), but the API no longer stays **silent** about it.
Whenever the emitted MSA-2 holds a non-ASCII byte on a text inbound, `buildMllpAck` emits
**`MLLP_ACK_CONTROL_ID_UNVERIFIABLE`**: a distinct "cannot verify this echo; pass a `Buffer`" signal,
separate from the `Buffer`-path proof-of-mismatch. An all-ASCII control ID round-trips under every
codec and stays quiet. Pass a `Buffer`. That is what the `Buffer`-first API rule is for.

A **non-text** `encoding` override is a step past even that. It is **rejected**, not warned, on
**every** input shape. `"base64"`/`"base64url"`/`"hex"` reinterpret the ACK _string_ as encoded data,
and `"utf16le"`/`"ucs2"` NUL-pad every byte, so the emitted frame is wholesale garbage a receiver
cannot parse. Because a garbage frame is a caller mistake rather than a runtime condition,
`buildMllpAck` throws a `TypeError` at the boundary for a non-text codec; only text codecs
(`"utf8"`/`"ascii"`/`"latin1"`/`"binary"`) are accepted. This includes a
`Buffer` inbound: a non-text codec there garbles the _inbound_ decode into the unparseable fallback
(empty MSA-2, so the `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` proof never runs) and then serializes the
fallback ACK to garbage bytes that, depending on the bytes, can contain a `VT`/`FS` byte and trip
the strict frame encoder with an `MllpFramingError`. The legitimate byte-level escape hatch is
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
own unbuilt feature: see [It does not acknowledge an HL7 batch](#it-does-not-acknowledge-an-hl7-batch).

## API stability

`@cosyte/mllp` is at `0.1`: it has left the pre-alpha `0.0.x` ladder. The client, the server, the
framing codec, the in-memory transport, and the optional `ack-from-hl7` bridge are the surface we
keep stable. The stable **warning codes** and **security-warning codes** are part of that surface,
so renaming or removing one is a breaking change. Below 1.0 a breaking change moves the minor
version, and the changelog says how to migrate.

---

## The one thing this package exists to prevent

**A sender being told its message was accepted when it was lost.**

Everything above is a bound on what the transport promises. That single failure mode is the one it
refuses to allow, by construction: the commit contract makes a positive ACK structurally unable to
precede a durable commit, and an inbound message that cannot be understood can never produce a
positive acknowledgment. The rest of the package hardens the transport around that guarantee.
