---
id: conformance
title: Conformance statement
sidebar_position: 7
---

# Conformance statement

This page is the one document to hand a conformance reviewer. It declares, in the terms a review is
recorded in, which framing behaviours, acknowledgement modes and transport-security options
`@cosyte/mllp` implements, and which it does not.

**Version declared:** `0.0.11`

Everything below describes that release. A conformance behaviour cannot move in this package without
this page moving in the same change: the declared tolerance sets on both halves of the codec, the
declared warning codes, the per-role acknowledgement verdicts, the declared option names and the
version above are all checked against the shipped code by the package's own test suite, which fails
and names what drifted.

## What this is, and who did the checking

This is a **self-declaration**. It is the package's own statement about its own behaviour, written by
the people who wrote the code and verified by the code's own test suite. It is **not** a third-party
attestation, and nothing on this page has been assessed by anyone outside this project.

That distinction is the whole reason IHE publishes two different kinds of record, and they differ in
**who did the checking**:

- **An IHE Integration Statement, entered in the Product Registry.** A vendor's own declaration
  about its own product. Nobody else checks it before it is published. This page is written to feed
  that route: it gives you the actor-and-option wording such an entry is recorded in.
- **Connectathon results, published by IHE.** IHE's own record of what was actually tested,
  vendor-to-vendor, under supervision, at a Connectathon. That is a third-party record, and it is the
  one this page cannot substitute for.

`@cosyte/mllp` is a **library, not an IHE actor**. An actor is a system a deployer builds and
operates; a transport library is one component inside it. So no option below is recorded as claimed,
by us or on anyone's behalf. Each one names what this package supplies and what remains yours to do
before you enter it in a Product Registry statement or take it to a Connectathon.

There is also no implementable profile of MLLP itself to conform to: HL7 v2's conformance profiles
profile **messages**, not the lower layer. The external bar for a transport is assembled from the
framing block, the HL7 v2 acknowledgement model, IHE's profile of that model, and the IHE ATNA
transport-security options, which is exactly what the sections below cover.

### How to read the verdicts

Every verdict on this page is one of exactly three words, and they are mutually exclusive:

| Verdict           | Meaning                                                                                                                                                                                                                                                                                                         |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Supported**     | The behaviour is implemented in this release and is exercised by this package's own tests.                                                                                                                                                                                                                      |
| **Not supported** | The behaviour is **absent**. It is not implemented, and nothing here approximates it.                                                                                                                                                                                                                           |
| **Unverified**    | The behaviour is neither claimed present nor claimed absent. Something is delegated or untested, so we have not established it, and an inference from a specification is not an observation. Every one is listed with its reason under [Behaviours recorded as unverified](#behaviours-recorded-as-unverified). |

## Framing tolerances

The strict block is `<VT>` payload `<FS>` `<CR>`. Both halves of the codec default to it, and every
departure from it, in either direction, is an explicit opt-in that emits a stable warning code. Each
row in the two tables below is therefore a **declared deviation from the strict block**, never a
silent one.

The decoder is where nearly all of it lives: it is the side that has to survive what a real sender
emits.

| Option                   | Strict-block behaviour it deviates from                    | Warning code              | Standalone reader | Server |
| ------------------------ | ---------------------------------------------------------- | ------------------------- | ----------------- | ------ |
| `allowFsOnly`            | A frame ends `<FS>` `<CR>`; the `<CR>` is required.        | `MLLP_FS_WITHOUT_CR`      | off               | on     |
| `allowLfAfterFs`         | The byte after `<FS>` is `<CR>`, never `<LF>`.             | `MLLP_LF_AFTER_FS`        | off               | on     |
| `allowLeadingWhitespace` | A frame opens at `<VT>` with no padding before it.         | `MLLP_LEADING_WHITESPACE` | off               | on     |
| `allowMissingLeadingVt`  | A frame opens at `<VT>`; a stream without one is unframed. | `MLLP_MISSING_LEADING_VT` | off               | off    |

"Standalone reader" is a `FrameReader` you construct yourself. "Server" is every connection an
`MllpServer` accepts, which applies the defaults above and merges anything you pass in
`ServerOptions.framing` over the top. So three of the four deviations are **on by default on the
server** and none is on by default for a standalone reader: a reviewer can tell a deviation the
package ships on from one a deployment opted into by reading that pair of columns.

With a tolerance **off**, the deviation is not tolerated at all: `FrameReader.push()` throws
`MllpFramingError`, and `Connection` destroys that connection rather than resynchronizing it. With
it **on**, the deviation becomes the warning code in the table and the payload is recovered.

Two more rules bound the set:

- **`strict: true` overrides every opt-in above.** Every deviation in the table throws again even
  where its individual option is enabled. There is no configuration in which these are tolerated
  more widely than this table says, and every row is exercised in both directions to keep that
  true.
- **`allowMissingLeadingVt` stays off even on the server.** A stream with no `<VT>` is not a
  tolerable quirk; it is an unframed stream, and guessing where a message starts is how a clinical
  message gets mis-split.

The warning codes are a **public API** of this package: renaming or removing one is a breaking
change. Two further framing warnings (`MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES`) are **not**
tolerance opt-ins, are always warnings and never throw, and are therefore not rows above; see
[Framing and tolerance](./framing.md) for the full code table.

### Encoder deviations

The encoder defaults to strict and, on the default, has no deviation to declare: `encodeFrame()`
emits the canonical block every time, and refuses a payload it could not frame unambiguously rather
than emitting one a peer would mis-split. There is nonetheless **one** encoder-side opt-in, and a
reviewer should see it here rather than discover it in the type signature:

| Option                         | Strict-block behaviour it deviates from                                                                            | Warning code                                           | Default |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------- |
| `allowDelimiterBytesInPayload` | The payload contains no `0x0B` and no `0x1C`, because MLLP is not byte-transparent and those bytes are structural. | `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS` | off     |

Off, a payload carrying either byte throws `MllpFramingError` with the matching code and no frame is
produced. On, the offending bytes are passed through verbatim, one warning is emitted per byte, and
the frame that goes out is one **a conformant peer will mis-split**: its decoder will read the
embedded `0x0B` as the start of a new frame or the embedded `0x1C` as the end of this one. Turning it
on is therefore a deliberate decision to emit a non-conformant block, and it is off on every path
this package takes by itself, including the acknowledgement builder that exposes it as a passthrough.

The honest reading for a conformance review: on defaults, this package cannot emit a non-canonical
block. That property is a **default**, not a structural guarantee, and this page will not record it
as the latter.

## Acknowledgement modes

HL7 v2.5.1 §2.9 splits acknowledgement into two protocols. In the **original** protocol one message
draws one acknowledgement. In the **enhanced** protocol it draws two: an _accept_ acknowledgement
(`CA`/`CE`/`CR`, "I have your bytes in safe storage; stop resending") and a later, separate
_application_ acknowledgement (`AA`/`AE`/`AR`, "here is what my application did with it"). The
original protocol is the enhanced protocol with MSH-15 = `NE` and MSH-16 = `AL`.

Each mode is recorded separately for the two roles this package ships, because the two do not agree:

| Acknowledgement mode                       | Client role   | Server role   |
| ------------------------------------------ | ------------- | ------------- |
| Original mode                              | Supported     | Supported     |
| Enhanced mode, accept acknowledgement      | Supported     | Supported     |
| Enhanced mode, application acknowledgement | Supported     | Not supported |
| MLLP Release 2 commit acknowledgement      | Not supported | Not supported |
| Batch acknowledgement                      | Not supported | Not supported |

Row by row:

- **Original mode.** One acknowledgement per message, correlated to the send. The client correlates
  FIFO by default, or by MSH-10 to MSA-2 with `correlateByControlId: true`. On the server the
  automatic acknowledgement is **opt-in**: with `autoAck` set, every inbound message is answered,
  and with `autoAck` left unset the server sends nothing of its own, because the message handler
  owns the response through `conn.send()`. The starter server sets `autoAck` to `AA` for you; the
  plain server does not. Where the automatic acknowledgement is paired with a message handler, the
  handler is awaited and a positive `AA` is structurally unable to precede it; with no handler there
  is nothing to await, and the `AA` truthfully means "bytes received and framed" and nothing more.
- **Enhanced mode, accept acknowledgement.** The client accepts a `CA` without settling the send,
  reports it through the per-send `onCommitAck` callback, and rejects the send at once on a `CE` or
  `CR`. The server answers in the accept half of Table 0008 when the inbound message's MSH-15 asks
  for it, evaluated against the disposition its handler reached.
- **Enhanced mode, application acknowledgement.** **Supported in the client role, not supported in
  the server role**, and that asymmetry is deliberate rather than an oversight. The client waits for
  the later application acknowledgement on its own bound and settles the send on it. **This package's
  server emits exactly one acknowledgement per inbound message, in every mode**, so the second
  exchange is the consumer's to orchestrate: a system that must answer twice sends the later
  acknowledgement itself. Pointing this client at this server with both MSH-15 and MSH-16 asking for
  acknowledgement therefore ends at the application-acknowledgement timeout.
- **MLLP Release 2 commit acknowledgement.** Absent on both roles. The Release 2 commit blocks and
  Release 2's synchronous "no new content until acknowledged" discipline are not implemented at all,
  so there is no Release 2 code path a Release 1 link could downgrade into.
- **Batch acknowledgement.** Absent on both roles. Nothing here parses a batch, re-bases on the
  batch's first `MSH`, or answers a `BTS-1` count of messages with one acknowledgement. A positive
  acknowledgement correlated to the batch's first message would tell a sender the whole batch was
  accepted while messages 2..N went unread, so refusing is the safe answer, not a gap waiting to be
  filled with a guess. **What is refused, and by which of this package's two acknowledgement-building
  routes, is not uniform**, and a responder-builder has to know the difference: it is stated route by
  route in [Batch and concatenated frames, route by
  route](#batch-and-concatenated-frames-route-by-route) below rather than summarized here.

Enhanced-mode correlation of both halves requires `correlateByControlId: true`, because MSA-2 is the
only thing that can attribute a second acknowledgement to a send. An enhanced-mode send on a
FIFO client keeps the ordinary single-acknowledgement behaviour and warns rather than being refused.
Full detail: [ACKs and the commit contract](./acks.md).

### Batch and concatenated frames, route by route

Two frame shapes carry more than one message: an `FHS`/`BHS` batch envelope (§2.10.3), and two or
more complete messages concatenated into a single frame, one `MSH` after another. Neither is
acknowledged as a batch, per the row above. But this package ships **two** acknowledgement-building
routes, and they do not detect those two shapes equally, so the answer is recorded per route rather
than as one sentence covering both:

| Acknowledgement route                                                            | An `FHS`/`BHS` batch envelope                                                                         | A second `MSH` in the same frame                                                    |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| The server's automatic acknowledgement, `autoAck`, and the raw builder behind it | Refused: a requested positive `AA`/`CA` is downgraded to the non-positive `AE`/`CE`                   | Refused: a requested positive `AA`/`CA` is downgraded to the non-positive `AE`/`CE` |
| The parser-backed builder on the `@cosyte/mllp/ack-from-hl7` subpath             | Refused: the warned, non-positive `AE`, carrying `MLLP_ACK_INBOUND_UNPARSEABLE` and no correlation id | Not detected: a positive `AA` correlated to the **first** message, with no warning  |

**The one cell that is not a refusal is a limitation of this release, named here rather than left for
a reviewer to discover.** The parser-backed builder strips leading segment terminators and hands what
follows to the parser, which reads the first message and stops; a batch envelope has no parseable
message at its head and so falls out into the warned refusal, but a second message sitting behind a
perfectly good first one is neither read nor reported. Concatenated frames are rarer than batch
envelopes and are not what that route is documented for, which is why the gap has stood; it is a
gap all the same.

What that means for a deploying actor: if you answer inbound messages through that subpath, **detect
the shape yourself before you choose a disposition**. `rawAckUncorrelatable(payload)` is exported for
exactly this and returns `true` for both shapes in the table. The server's automatic acknowledgement
already applies it, which is why its row reads the way it does, and a system on that route needs to
do nothing further.

All four cells are exercised against the shipped package on every test run of this repository,
including the one that is not a refusal. If any of the four outcomes moves, this table fails the
build until it moves with it.

## IHE options

Each row names the **actor** the option is recorded against, the **transaction** it belongs to, and
the option **spelled as ITI TF-2 spells it**, which is the wording a Product Registry entry or a
Connectathon test is written in. "Package option" is the `@cosyte/mllp` option that turns the
mechanism on.

The role columns record **this package's support for the mechanism**. They are not a claim on the
option: see the split below, and note that no row is claimed here.

| IHE actor                     | Transaction                          | Option, as ITI TF-2 spells it                | Package option          | Client role | Server role   |
| ----------------------------- | ------------------------------------ | -------------------------------------------- | ----------------------- | ----------- | ------------- |
| Secure Node                   | Authenticate Node [ITI-19]           | STX: TLS 1.2 floor using BCP195 Option       | `atnaTransportSecurity` | Supported   | Supported     |
| Secure Node                   | Authenticate Node [ITI-19]           | STX: No Secure Transport                     | none                    | Supported   | Supported     |
| Secure Node                   | Authenticate Node [ITI-19]           | FQDN Validation of Server Certificate Option | `servername`            | Unverified  | Unverified    |
| Patient Demographics Supplier | Patient Identity Management [ITI-30] | Acknowledgement Support Option               | `correlateByControlId`  | Supported   | Not supported |

The IHE actor named in each row is the actor a **deployer** would be claiming the option for. This
package is a component inside such an actor, never the actor itself.

### What this package supplies, and what stays yours

| Option                                       | What this package supplies                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | What the deploying actor must still do                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Claimed here |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| STX: TLS 1.2 floor using BCP195 Option       | A TLS 1.2 floor that cannot be lowered through this API (`minVersion` defaults to `TLSv1.2` and only `TLSv1.2`/`TLSv1.3` are expressible); with `atnaTransportSecurity: true`, the four TLS 1.2 cipher suites ITI TF-2 §3.19.6.2.3 names and no other TLS 1.2 suite, offered alongside the three TLS 1.3 suites the runtime enables by default so that selecting the option never removes a protocol version that was reachable without it; mutual node authentication through `clientAuth` plus a client certificate and key; and a `'tlsNegotiated'` event per completed handshake reporting, in the IANA spelling the standard prints, what that link actually agreed on. | Supply and manage all certificate material and trust anchors, because this package ships no PKI and issues, rotates and revokes nothing; turn the option on, since it is off by default and with it off the offered suites are the runtime's rather than this package's; configure mutual authentication for the actor's own trust model; retain the negotiated-parameter evidence; **ship with certificate verification on**, because the client's `tls.allowUnverified` switch turns node authentication off wholesale and only announces it, emitting `MLLP_TLS_VERIFY_DISABLED` on every successful connection rather than refusing to connect; and write and enter the Integration Statement. | No           |
| STX: No Secure Transport                     | Plaintext MLLP on both roles, which is the transport this option describes and for which ITI-19 requires no actions. Nothing about the unsecured case is quiet: a server binds `127.0.0.1` by default, a wildcard bind has to be asked for by name and emits `MLLP_BIND_ALL_INTERFACES` when it is, and the strict framing and commit-contract behaviour is identical to the TLS case.                                                                                                                                                                                                                                                                                       | Establish that an unsecured transport is permitted by the local security policy for the information crossing the link, and declare the option deliberately rather than arriving at it by leaving TLS unconfigured.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | No           |
| FQDN Validation of Server Certificate Option | Nothing of its own. The client's identity check is whatever `node:tls` performs by default against `servername` (which defaults to the configured host), and this package neither implements RFC6125 section 6 matching nor overrides the runtime's check. A failed identity check surfaces as a typed `'tls-verify'` failure classified permanent, so a misconfigured endpoint is not retried.                                                                                                                                                                                                                                                                              | Establish that the runtime's identity check satisfies the option for the deployment; ensure every server certificate carries a `subjectAltName` entry of type DNS-ID; set `servername` to the reference identifier the certificate is meant to match rather than relying on a host that is an address literal; and leave `tls.allowUnverified` off, which is the one switch that removes the identity check along with the rest of certificate verification.                                                                                                                                                                                                                                       | No           |
| Acknowledgement Support Option               | Enhanced acknowledgement mode on the client role: MSH-15 and MSH-16 are read byte-level and never validated, both halves of the exchange are correlated by MSA-2, and each disposition is surfaced with a typed result. On the server role, the accept half only: the server selects the correct half of Table 0008 for the message it answers.                                                                                                                                                                                                                                                                                                                              | Own the later application acknowledgement in any system built on this package's server, because that server emits exactly one acknowledgement per inbound message; and set `correlateByControlId: true`, without which an enhanced-mode send falls back to single-acknowledgement behaviour with a warning.                                                                                                                                                                                                                                                                                                                                                                                        | No           |

**Claimed here is `No` on every row, and it always will be.** An IHE option is claimed by an actor,
in a statement that actor makes about itself. A library can supply a mechanism and produce evidence,
and that is exactly as far as this page goes.

## Behaviours recorded as unverified

An unverified behaviour is not a missing one. These are the places where something is delegated,
untested, or inferred rather than observed, and recording them as either supported or not supported
would hand a reviewer a guess dressed as a finding.

| Behaviour                                                                | Verdict    | Why it is unverified rather than absent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FQDN Validation of Server Certificate Option (ITI-19 section 3.19.6.1.4) | Unverified | The client half is delegated wholesale to the runtime's default identity check, which this package neither implements nor overrides, and this package's own harness exercises only the rejection direction, with an address literal as the reference identifier rather than a DNS-ID. The server half is a property of certificates the deployer supplies and this package examines none of them. The mechanism is very probably adequate; it has not been established here, and probably is not a verdict.                                                                                                                                                                                                                                                                                                                                                                                                |
| Interoperability with Epic and Cerner interfaces                         | Unverified | Byte-level interoperability is proven here against freely available engines only. Neither of those two is part of this package's own verification, so their behaviour is inferred from the specification rather than observed, and no claim about either is made anywhere on this page. What the package supplies instead is the differential harness itself: `runDifferential` ships in the published artifact, so a deploying actor can point it at the engine they are integrating with and obtain a per-exchange frame-parity and `MSA-2` correlation report for that engine, named by the stable warning codes this page already declares. The run sends synthetic messages into whatever engine it is aimed at, so aim it at a test or staging endpoint. The resulting report is evidence the actor holds, not a conformance verdict this package issues. See [Known limitations](./limitations.md). |

## Evidence you can run

The blocks below execute against the built package on every test run of this repository, so they
cannot drift from it. Both carry synthetic bytes only: this page contains no patient data, real or
realistic, and the payloads are single ASCII letters chosen because they mean nothing.

A declared framing tolerance, exercised, emitting the code this page declares for it:

```ts runnable
import { FrameReader } from "@cosyte/mllp";

// Synthetic: <VT> "A" <FS> then the next frame's <VT>, with no <CR> between the frames.
const twoFrames = Buffer.from([0x0b, 0x41, 0x1c, 0x0b, 0x42, 0x1c, 0x0d]);

const codes = [];
const reader = new FrameReader({
  onFrame: () => {},
  onWarning: (w) => codes.push(w.code),
  allowFsOnly: true, // the declared opt-in
});
reader.push(twoFrames);

codes; // => ["MLLP_FS_WITHOUT_CR"]
```

The cipher suites the transport-security option offers, and the TLS 1.3 suites carried alongside them
so that selecting the option never turns a reachable protocol version off:

```ts runnable
import { ATNA_CIPHER_SUITES, TLS13_DEFAULT_CIPHER_SUITES, ATNA_CIPHER_LIST } from "@cosyte/mllp";

ATNA_CIPHER_SUITES.length; // => 4
TLS13_DEFAULT_CIPHER_SUITES.length; // => 3
ATNA_CIPHER_LIST.split(":").length; // => 7
TLS13_DEFAULT_CIPHER_SUITES.every((suite) => ATNA_CIPHER_LIST.includes(suite)); // => true
```

## Where the detail lives

This page is the declaration. The behaviour behind each line is documented at length elsewhere:

- [Framing and tolerance](./framing.md): the flag-by-flag table, every warning code, and what throws.
- [ACKs and the commit contract](./acks.md): the commit contract, the Table 0008 selection, and both
  halves of the enhanced-mode exchange.
- [MLLPS / TLS](./tls.md): enabling TLS, mutual TLS, the cipher-suite option and the negotiated-parameter event.
- [Known limitations and non-goals](./limitations.md): every bound on what this transport promises.
