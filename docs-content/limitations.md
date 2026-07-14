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

**The application owns idempotency and de-duplication** — key on `MSH-10` (message control ID) plus
`MSH-7` (timestamp). `@cosyte/mllp` surfaces unacked messages to you; it does **not** store them,
queue them, or replay them. There is no write-ahead log in this package. If you need one, it lives in
your application, not here.

## It does not drain in-flight messages on `close()`

`close()` **rejects** every in-flight send (`MllpConnectionError({ phase: 'close' })`) rather than
waiting for their ACKs. The `DRAINING` state exists in the connection machine, but no drain hook is
wired to it today, so `drainTimeoutMs` does not currently bound an in-flight ACK wait on the client —
there is no such wait.

A message in flight at shutdown is therefore an **unknown**, not a failure: it may have been
committed by the receiver with the ACK arriving after you stopped listening. Await your sends before
closing if that matters, and rely on receiver-side idempotency (`MSH-10` + `MSH-7`). See
[Connection, reconnect & backpressure](./reliability.md).

## A fatal framing error drops the connection, and is not retried

If the decoder throws — an oversized frame, or a structural violation whose tolerance opt-in is off —
that **connection** is destroyed. It is not resynchronized: after a throw the reader's position in
the byte stream is untrustworthy, and guessing where the next message starts is how one gets silently
mis-split. Bytes already accumulated in that connection's partial frame are **lost**.

The failure is contained to the one connection — a server keeps serving every other peer — and it is
classified `framing-fatal`, i.e. **permanent**, so a client does not reconnect into it. That is
deliberate (a peer speaking the wrong protocol would otherwise be retried forever), but it means a
client facing a peer that emits *occasional* junk will **stop**, not heal. If a peer's quirk is
expected, use the tolerance opt-ins so the bytes are a warning rather than a fatal — see
[Framing & tolerance](./framing.md).

## It does not decide clinical acceptance

The package builds *conformant* ACKs and structurally enforces *never-`AA`-without-commit*. It does
not, and cannot, decide whether your application should accept a message. `AA` / `AE` / `AR` is your
call, from your own processing outcome. See [the commit contract](./acks.md).

## It does not speak MLLP Release 2

Only **Release 1** (framing, with reliability delegated to the HL7 v2 ACK) is implemented — the
universal default for HL7 v2. The R2 commit-acknowledgement blocks (`<SB><ACK 0x06><EB><CR>` /
`<SB><NAK 0x15><EB><CR>`) and R2's synchronous "no new content until ack" discipline are **not
supported**. R2 is used mainly with HL7 v3 and is rarely needed for v2; if it ships, it will be
opt-in and off by default, and R1 framing will never silently downgrade to it.

## It is not differentially verified against Epic or Cerner

Interop is proven against **freely available** engines only — the Google Cloud Healthcare MLLP
adapter and Mirth/NextGen Connect (byte-parity on canonical R1 frames, plus a live-adapter tier).
Neither Epic nor Cerner is part of that harness. Their behavior is inferred from the spec, not
observed. Validate against your actual peer before you trust a production interface.

## It ships no PKI

TLS verifies **caller-supplied** certificates. This package bundles no CA, issues nothing, rotates
nothing, and has no opinion about your certificate lifecycle. See [MLLPS / TLS](./tls.md).

## It cannot carry charsets that collide with the framing bytes

MLLP is **not byte-transparent** — `0x0B` and `0x1C` are structural. A payload encoded in UTF-16 or
UTF-32 will contain those bytes inside ordinary characters, and any MLLP implementation (not just
this one) will mis-frame it. Use a single-byte encoding, UTF-8, or Shift_JIS. Which charset is in
play is the HL7 message's `MSH-18` concern, not the transport's.

## `ack-from-hl7` re-serializes the control ID; it does not copy its bytes

MSA-2 must carry the inbound MSH-10 **verbatim** (HL7 v2.5.1 §2.9.2.2), because that is the key the
sender correlates its ACK on. `buildMllpAck` (the `/ack-from-hl7` subpath) holds that guarantee
byte-for-byte for a plain control ID under the HL7 default delimiters — including a high-bit one
under an `MSH-18` of `8859/1` — but it builds through `@cosyte/hl7`, which **re-emits** MSH-10 in its
canonical form rather than copying the bytes. Five things that canonical form does not preserve:

- **Non-default delimiters.** `@cosyte/hl7` always emits `|^~\&`, so `ID#X` under a `#` component
  separator is re-delimited to `ID^X`.
- **Escape sequences.** Unescaped on read, re-escaped on write: `ID\X` comes back as `ID\E\X`.
- **Whitespace.** Fields are trimmed: `MSG42 ` comes back as `MSG42`.
- **Trailing empty components/subcomponents.** Canonicalized away: `ID^` and `ID&` both become `ID`.
- **A lossy `encoding` override.** Any codec that cannot round-trip the inbound bytes.

Each yields a *different* MSH-10, and so an ACK the sender cannot match. On a **`Buffer`** inbound none
of them is silent — the result carries `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. And all five have the same
answer: **`buildRawAck`**
(the root export, and what the server's `autoAck` path uses) is parser-free — it copies the MSH-10
bytes — so it holds the verbatim guarantee across escapes, padding, empty components, and custom
delimiters alike. Not *quite* unconditionally: an inbound that declares a colliding `MSH-1` (e.g. `^`)
with no usable `MSH-2` forces the ACK onto the HL7 default delimiters, and a `|` inside such a
message's MSH-10 then cannot survive into MSA-2 — the ACK carries an empty one. That inbound is
already malformed twice over (§2.16 requires MSH-2). See [ACKs](./acks.md).

And it is a **`Buffer`** guarantee. On a `string` / `Hl7Message` inbound the wire bytes were decoded
before `buildMllpAck` ever saw them, so it re-encodes your text with the same codec it decoded it
with: the codec cancels on both sides, and a codec-induced mismatch is **structurally invisible**.
`buildAckAA(payload.toString("latin1"))` on a high-bit control ID (`0x8B`) emits the two `utf8` bytes
`0xC2 0x8B` — a *different* control ID the sender cannot correlate — and warns about **nothing**. The
check cannot be extended to catch this; the bytes are gone by then. Pass a `Buffer`. That is what the
`Buffer`-first API rule is for.

`buildMllpAck` also **does not ACK an HL7 batch** (§2.10.3). An `FHS`/`BHS` envelope yields the
warned, non-positive `AE` fallback rather than a positive `AA` correlated to the batch's first
message — which would tell the sender the whole batch was accepted while messages 2..N went unread.

## The API is not stable yet

`@cosyte/mllp` is on the `0.0.x` ladder and **pre-alpha**. There is no API-stability promise and no
deprecation cycle: any release may change the public surface. The stable **warning codes** and
**security-warning codes** are treated as public API within that caveat — renaming one is a breaking
change — but the ladder itself makes no 1.0-style guarantees. Pin an exact version.

---

## The one thing this package exists to prevent

**A sender being told its message was accepted when it was lost.**

Everything above is a bound on what the transport promises. That single failure mode is the one it
refuses to allow, by construction: the commit contract makes a positive ACK structurally unable to
precede a durable commit, and an inbound message that cannot be understood can never produce a
positive acknowledgement. The rest of the package hardens the transport around that guarantee.
