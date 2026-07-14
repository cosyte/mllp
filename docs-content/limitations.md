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

## `ack-from-hl7` cannot echo a control ID under non-default delimiters

MSA-2 must carry the inbound MSH-10 **verbatim** (HL7 v2.5.1 §2.9.2.2), because that is the key the
sender correlates its ACK on. `buildMllpAck` (the `/ack-from-hl7` subpath) holds that guarantee
byte-for-byte under the HL7 default delimiters `|^~\&` — including high-bit control IDs — but it
builds through `@cosyte/hl7`, which always **emits** the default delimiters and **trims** field
whitespace. So an inbound that declares its own `MSH-1`/`MSH-2`, or a control ID padded with
whitespace, comes back re-delimited or trimmed: different bytes, and an ACK the sender cannot match.

It never does this silently — the result carries `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. And there is a
way out: **`buildRawAck`** (the root export, used by the server's `autoAck` path) is parser-free and
echoes the inbound's own `MSH-1`/`MSH-2`, so it holds the verbatim guarantee under *any* delimiter
set. See [ACKs](./acks.md).

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
