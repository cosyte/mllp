# src/ack-from-hl7

ACK helpers that build a framed MLLP ACK from an inbound HL7 v2 message,
a THIN transport adapter over `@cosyte/hl7`'s `buildAck`.

`@cosyte/hl7` owns ACK **content** (MSH/MSA/ERR construction, control
vocabulary, the no-correlation fail-safe); this subpath owns **transport
policy**, accepting raw bytes or a parsed message, never fabricating a
positive disposition when the inbound is unparseable, and framing the
result via `encodeFrame`.

Requires `@cosyte/hl7` as an installed peer dependency; it is loaded lazily
on first call, so the rest of `@cosyte/mllp` stays fully dependency-free.

## Example

```typescript
import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const ack = buildAckAA(inboundBuffer);
socket.write(ack.frame);
```

## Classes

### MllpPeerMissingError

Thrown when `@cosyte/hl7`, the optional peer dependency required by
`@cosyte/mllp/ack-from-hl7`, cannot be resolved at runtime.

`@cosyte/hl7` is declared as an optional peer dependency, so a consumer of
the root `@cosyte/mllp` entry point is never forced to install it. Only
code that imports from the `/ack-from-hl7` subpath needs it, and only once
that code actually runs (the loader is lazy).

#### Example

```typescript
import { buildAckAA, MllpPeerMissingError } from '@cosyte/mllp/ack-from-hl7';
try {
  buildAckAA(inboundBuffer);
} catch (err) {
  if (err instanceof MllpPeerMissingError) {
    console.error(err.message); // explains how to install @cosyte/hl7
  }
}
```

#### Extends

- `Error`

#### Constructors

##### Constructor

> **new MllpPeerMissingError**(`cause`): [`MllpPeerMissingError`](#mllppeermissingerror)

Construct an `MllpPeerMissingError`.

###### Parameters

###### cause

`unknown`

The original module-resolution error, preserved for debugging.

###### Returns

[`MllpPeerMissingError`](#mllppeermissingerror)

###### Overrides

`Error.constructor`

#### Properties

##### code

> `readonly` **code**: `"MLLP_PEER_MISSING"`

Stable machine-readable code identifying this error class.

##### name

> `readonly` **name**: `"MllpPeerMissingError"`

###### Overrides

`Error.name`

## Interfaces

### BuildMllpAckOptions

Options for [buildMllpAck](#buildmllpack) and its six convenience wrappers.

#### Example

```typescript
import type { BuildMllpAckOptions } from '@cosyte/mllp/ack-from-hl7';
const opts: BuildMllpAckOptions = { code: "AE", error: { conditionCode: "101" } };
```

#### Properties

##### allowDelimiterBytesInPayload?

> `readonly` `optional` **allowDelimiterBytesInPayload?**: `boolean`

Passthrough to `encodeFrame`'s `allowDelimiterBytesInPayload`. Defaults
to `false` (strict, throws if the serialized ACK somehow contains a
VT/FS byte, which a spec-clean `@cosyte/hl7` emit never does).

##### code

> `readonly` **code**: `AckCode`

Required acknowledgment disposition to emit in MSA-1 (HL7 Table 0008).

##### encoding?

> `readonly` `optional` **encoding?**: `BufferEncoding`

The codec used to move the ACK between bytes and text, **both** directions,
as a single symmetric choice. It decodes a raw-`Buffer` `inbound` on the way in
and encodes the serialized ACK on the way out, so the ACK is emitted in the same
codec the inbound was read in.

That symmetry is the whole point, and it is what makes MSA-2 echo MSH-10
**verbatim** (HL7 v2.5.1 §2.9.2.2). Decoding in one codec and encoding in another
corrupts every non-ASCII byte it round-trips: a `latin1`-decoded `0x8B` re-encoded
as `utf8` goes out as the two bytes `0xC2 0x8B`, which is a *different control ID*
and the sender, which keyed its in-flight store on `0x8B`, cannot match the ACK.

**Defaults, by inbound type:**

- `Buffer` → **`"latin1"`**. We own the decode, and `latin1` is the only codec
  that round-trips arbitrary bytes losslessly, so MSA-2 is byte-verbatim for any
  charset, including an MSH-18 of `8859/1` with high-bit bytes in the control ID.
- `string` / `Hl7Message` → **`"utf8"`**. The caller already decoded; we re-encode
  with the JS-native codec.

**Override with care, and only on a `Buffer`.** Any value other than `"latin1"` on a
raw-`Buffer` inbound gives up the verbatim guarantee for non-ASCII bytes (`"ascii"`
masks the high bit; `"utf8"` folds invalid sequences onto `U+FFFD`). On a `Buffer`,
`buildMllpAck` **checks** the result and emits [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim)
if the echo did not survive, so a bad override there is loud rather than silent, but
it is still a broken ACK. Set this only when the receiving system genuinely demands a
specific codec.

**On a `string` / `Hl7Message` inbound the verbatim check cannot see a codec problem,
so a *different* warning does the honest thing instead.** The wire bytes were decoded to
text *before* this function saw them, so there is nothing left to compare the ACK against
except that same text: the codec cancels on both sides and [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim)
can never fire. Concretely, `buildAckAA(payload.toString("latin1"))` on a high-bit control ID
(`0x8B`, legal under an `MSH-18` of `8859/1`) re-encodes it as the two `utf8` bytes `0xC2 0x8B`,
emitting a **different** control ID the sender cannot correlate. The verbatim check is blind to
that, but the byte-safety of a text inbound cannot be *proven*, so `buildMllpAck` refuses to
pass it off as verified: whenever the emitted MSA-2 holds a non-ASCII byte on a text inbound it
emits [MLLP\_ACK\_CONTROL\_ID\_UNVERIFIABLE](#mllp_ack_control_id_unverifiable), an explicit "cannot verify, pass a `Buffer`".
The guard is not grown to *catch* the mismatch (the bytes are gone by then); the API stops
being silent about the fact that it can't.

**`Buffer` is the byte-safe path.** Pass the raw payload. It is what the server hands
you, it is what the `Buffer`-first API rule exists for, and it is the only input for
which the verbatim guarantee, or a proof that it broke, actually means anything.

**Only a *text* codec is accepted, on every input shape.** This codec serializes the ACK
back to bytes, so it must be one that writes characters as a byte stream the peer can read as
HL7: `"utf8"`, `"ascii"`, `"latin1"`, or `"binary"`. A **non-text** codec,
`"base64"`/`"base64url"`/`"hex"` (which reinterpret the ACK *string* as encoded data) or
`"utf16le"`/`"ucs2"` (which NUL-pad every byte), emits a wholesale-garbage frame the receiver
cannot parse, so `buildMllpAck` **throws a `TypeError`** for it here rather than hand back an
unusable ACK. This applies to a `Buffer` inbound too: a
non-text codec there garbles the *inbound* decode into the unparseable fallback (empty MSA-2,
so the [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim) check never runs) and then serializes the
fallback ACK to garbage bytes that intermittently trip the strict frame encoder, it is never
the "loud AE" it was once documented to be. The legitimate byte-level escape hatch is
unchanged: a lossy **charset** override on a `Buffer` (`"ascii"` masking a high bit) is still
accepted and still caught loudly by [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim); only the
categorically-non-serializing codecs are refused.

##### error?

> `readonly` `optional` **error?**: `AckErrorDetail` \| readonly `AckErrorDetail`[]

Optional error detail; one entry emits one ERR segment.

***

### Hl7Peer

The subset of the `@cosyte/hl7` runtime surface the `ack-from-hl7` adapter
consumes. Kept narrow and typed via `import type` (erased at compile time)
so the runtime dependency stays fully lazy, only the shape is known
statically, the values are resolved via `require()` at first call.

#### Example

```typescript
import type { Hl7Peer } from '@cosyte/mllp/ack-from-hl7';
function useAck(peer: Hl7Peer) {
  return peer.buildAck;
}
```

#### Properties

##### ACK\_CODES

> `readonly` **ACK\_CODES**: `object`

##### buildAck

> `readonly` **buildAck**: (`inbound`, `options`) => `Hl7Message`

###### Parameters

###### inbound

`Hl7Message`

###### options

`BuildAckOptions`

###### Returns

`Hl7Message`

##### buildMessage

> `readonly` **buildMessage**: (`init`) => `Hl7Message`

###### Parameters

###### init

###### type

`string`

###### Returns

`Hl7Message`

##### detectAckMode

> `readonly` **detectAckMode**: (`inbound`) => `"original"` \| `"enhanced"`

###### Parameters

###### inbound

`Hl7Message`

###### Returns

`"original"` \| `"enhanced"`

##### downgradePositiveAck

> `readonly` **downgradePositiveAck**: (`code`) => `AckCode`

The peer's fail-safe downgrade primitive (`AA`→`AE`, `CA`→`CE`, everything
else unchanged), the single upstream source of truth for the pair; this
adapter never carries its own copy of the mapping.

###### Parameters

###### code

`AckCode`

###### Returns

`AckCode`

##### FATAL\_CODES

> `readonly` **FATAL\_CODES**: `object`

##### Hl7Message

> `readonly` **Hl7Message**: new (...`args`) => `Hl7Message`

The peer's own `Hl7Message` class. Exposed (not just used as a type) so
callers can detect a cross-realm instance, see the dual-package-hazard
note on `resolveInbound` in `build.ts`. Typed as `abstract new` (rather
than a concrete constructor signature) purely so TypeScript accepts it as
an `instanceof` right-hand side without also implying callers can `new`
it directly with arbitrary args.

###### Parameters

###### args

...`never`[]

###### Returns

`Hl7Message`

##### Hl7ParseError

> `readonly` **Hl7ParseError**: *typeof* `Hl7ParseError`

##### parseHL7

> `readonly` **parseHL7**: (`raw`) => `Hl7Message`

###### Parameters

###### raw

`string` \| `Buffer`\<`ArrayBufferLike`\>

###### Returns

`Hl7Message`

***

### MllpAck

Result of [buildMllpAck](#buildmllpack), a ready-to-write MLLP frame plus the
metadata needed to log or assert on what was actually emitted. Frozen
(including the `warnings` array) so subscribers cannot mutate shared state.

#### Example

```typescript
import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const ack = buildAckAA(inbound);
socket.write(ack.frame);
console.log(ack.code, ack.correlationId);
```

#### Properties

##### ack

> `readonly` **ack**: `Hl7Message`

The built ACK `Hl7Message`.

##### code

> `readonly` **code**: `AckCode`

The disposition MSA-1 actually carries (post fail-safe downgrade).

##### correlationId

> `readonly` **correlationId**: `string` \| `undefined`

Inbound MSH-10, echoed in MSA-2. `undefined` when unfindable.

##### frame

> `readonly` **frame**: `Buffer`

`VT + payload + FS + CR`, ready to write to a socket.

##### mode

> `readonly` **mode**: `AckMode` \| `undefined`

Detected from inbound MSH-15/16. `undefined` when inbound unparseable.

##### payload

> `readonly` **payload**: `Buffer`

The serialized ACK, unframed.

##### requestedCode

> `readonly` **requestedCode**: `AckCode`

The disposition the caller asked for.

##### warnings

> `readonly` **warnings**: readonly [`MllpAckWarning`](#mllpackwarning)[]

Warnings collected while building the ACK.

***

### MllpAckWarning

A single ACK-generation warning, surfaced by [buildMllpAck](#buildmllpack).

`code` is either an upstream `@cosyte/hl7` warning code passed through
verbatim (e.g. `"ACK_NO_CORRELATION_ID"`) or the one `mllp`-owned code,
[MLLP\_ACK\_INBOUND\_UNPARSEABLE](#mllp_ack_inbound_unparseable).

#### Example

```typescript
import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const { warnings } = buildAckAA(inbound);
for (const w of warnings) console.warn(w.code, w.message);
```

#### Properties

##### code

> `readonly` **code**: `string`

##### message

> `readonly` **message**: `string`

## Variables

### MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM

> `const` **MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM**: `"MLLP_ACK_CONTROL_ID_NOT_VERBATIM"` = `"MLLP_ACK_CONTROL_ID_NOT_VERBATIM"`

Warning code emitted when the built ACK's MSA-2 bytes are **not** byte-identical
to the inbound MSH-10 bytes, i.e. the ACK does not echo the message control ID
verbatim, as HL7 v2.5.1 §2.9.2.2 requires.

This is a **correlation failure**, and the reason it is a loud warning rather
than a silent success: the sender keys its in-flight store on the MSH-10 bytes
it put on the wire. An ACK whose MSA-2 differs by even one byte will not match
that key, so the send is never settled → ACK timeout → resend → **duplicate
clinical message**. Emitting the ACK anyway (rather than throwing) is the
fail-safe choice, a mismatched ACK still tells the peer *something*, but the
mismatch must never pass unremarked.

`buildMllpAck` verifies this on every build, against the very same byte-level
scanners the `@cosyte/mllp` client uses to correlate (`src/internal/control-id.ts`).

**The verification is meaningful for a `Buffer` inbound, and only for a `Buffer`.**
A `Buffer` *is* the wire bytes, so comparing the ACK to it is a real byte-level check
and a clean result means a `@cosyte/mllp` sender will match this ACK. A
`string`/`Hl7Message` inbound has **already been decoded** before this module sees it:
the only thing left to compare against is that same text, encoded with the same codec,
so the codec cancels on both sides and a codec-induced mismatch is **structurally
invisible**, it warns about nothing. See [BuildMllpAckOptions.encoding](#encoding). Pass a
`Buffer` if you want this guarantee to mean anything.

Two known ways to provoke it, both documented in the package limitations:

  1. Overriding [BuildMllpAckOptions.encoding](#encoding) to a codec that cannot
     round-trip the inbound bytes (`"utf8"`/`"ascii"` against a high-bit,
     8859/1-charset control ID). The default never does this.
  2. An inbound that declares **non-default encoding characters** (MSH-1/MSH-2).
     `@cosyte/hl7`'s `buildMessage` always emits the HL7 default `|^~\&`, so an
     inbound MSH-10 of `ID#X` under a `#` component separator is re-delimited to
     `ID^X` in MSA-2, different bytes, unmatchable key. Use `buildRawAck` (root
     export), which echoes the inbound's own MSH-1/MSH-2, if you must serve such
     a peer.

#### Example

```typescript
import { MLLP_ACK_CONTROL_ID_NOT_VERBATIM, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const { warnings } = buildAckAA(inbound, { encoding: "ascii" });
if (warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM)) {
  // this ACK will NOT correlate at the sender, investigate before shipping it
}
```

***

### MLLP\_ACK\_CONTROL\_ID\_UNVERIFIABLE

> `const` **MLLP\_ACK\_CONTROL\_ID\_UNVERIFIABLE**: `"MLLP_ACK_CONTROL_ID_UNVERIFIABLE"` = `"MLLP_ACK_CONTROL_ID_UNVERIFIABLE"`

Warning code emitted when the inbound was handed in as **text** (a `string` or an
already-parsed `Hl7Message`) rather than as raw `Buffer` bytes, and the ACK's MSA-2
carries a **non-ASCII** control ID, a combination whose byte-verbatim echo
(HL7 v2.5.1 §2.9.2.2) `buildMllpAck` **cannot verify**, and may silently be breaking.

**Why a distinct code from [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim)**

`MLLP_ACK_CONTROL_ID_NOT_VERBATIM` is a *proof of failure*: on a `Buffer` inbound the
wire bytes are in hand, the check compares MSA-2 against them, and it fires only when
they provably differ. This code is the opposite, a *confession that the proof cannot
be run*. A `string`/`Hl7Message` inbound was decoded from its wire bytes **before** this
module ever saw it, so the only thing left to compare the ACK against is that same text
re-encoded with the same codec: the codec cancels on both sides and the verbatim check
becomes a tautology that always passes (see verifyVerbatimEcho). It would report
clean even for `buildAckAA(payload.toString("latin1"))` on a high-bit control ID, where
a `latin1`-decoded `0x8B` is re-encoded as the two `utf8` bytes `0xC2 0x8B`, a *different*
control ID the sender cannot correlate (timeout → resend → **duplicate clinical message**).

The guard cannot be grown to catch that; by the time text arrives the bytes are gone.
The API can, and does: rather than let the text path pass a codec-sensitive control ID
off as verified, `buildMllpAck` refuses to stay silent about it. Whenever the ACK's MSA-2
control ID holds a code unit outside `0x00` to `0x7F` on a text inbound, the range where the
codec choice is load-bearing, it emits this warning. An all-ASCII control ID round-trips
identically under every codec, so the common case stays quiet; a non-ASCII one is flagged as
*unverifiable*, not as *known-broken*, because from a decoded string the two are genuinely
indistinguishable.

The check reads the **pre-encoding code units** of MSA-2, not the emitted bytes, so a lossy
`{ encoding: "ascii" }` override, which truncates a code unit to its low 8 bits (`str -> byte &
0xFF`) and so masks a code unit above `0xFF` *into* the ASCII byte range on the way out (`U+0153`
-\> `0x53`), cannot slip a corrupted control ID past it silently.
The strongly-discouraged text-plus-override path is covered for the same reason the default `utf8`
text path is; the `Buffer` overload remains the answer.

**The fix the warning points at is the `Buffer`-first API rule.** Pass the raw payload,
the bytes the server handed you, and you get the real byte-level check (and, if it breaks,
the definite [MLLP\_ACK\_CONTROL\_ID\_NOT\_VERBATIM](#mllp_ack_control_id_not_verbatim)) instead of this "cannot tell".

Like its sibling, this warning carries byte **lengths** only, never the field bytes
(MSH-10 is inbound payload content and a warning goes to a log; see verifyVerbatimEcho).

#### Example

```typescript
import { MLLP_ACK_CONTROL_ID_UNVERIFIABLE, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const { warnings } = buildAckAA(payload.toString("latin1")); // text inbound, high-bit id
if (warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_UNVERIFIABLE)) {
  // pass the raw Buffer instead, the echo cannot be verified from decoded text
}
```

***

### MLLP\_ACK\_INBOUND\_UNPARSEABLE

> `const` **MLLP\_ACK\_INBOUND\_UNPARSEABLE**: `"MLLP_ACK_INBOUND_UNPARSEABLE"` = `"MLLP_ACK_INBOUND_UNPARSEABLE"`

Warning code emitted when the inbound message could not be parsed at all
(a fatal `Hl7ParseError`) and [buildMllpAck](#buildmllpack) fell back to a minimal,
uncorrelated ACK rather than fabricating a positive disposition.

#### Example

```typescript
import { MLLP_ACK_INBOUND_UNPARSEABLE, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
const { warnings } = buildAckAA("not hl7 at all");
warnings.some((w) => w.code === MLLP_ACK_INBOUND_UNPARSEABLE); // true
```

## Functions

### buildAckAA()

> **buildAckAA**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build an `AA` (Application Accept) MLLP ACK.

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckAA(inboundBuffer).frame);
```

***

### buildAckAE()

> **buildAckAE**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build an `AE` (Application Error) MLLP ACK.

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckAE } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckAE(inboundBuffer, { error: { conditionCode: "101" } }).frame);
```

***

### buildAckAR()

> **buildAckAR**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build an `AR` (Application Reject) MLLP ACK.

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckAR } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckAR(inboundBuffer, { error: { conditionCode: "200" } }).frame);
```

***

### buildAckCA()

> **buildAckCA**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build a `CA` (Commit Accept) MLLP ACK (enhanced mode).

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckCA } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckCA(inboundBuffer).frame);
```

***

### buildAckCE()

> **buildAckCE**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build a `CE` (Commit Error) MLLP ACK (enhanced mode).

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckCE } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckCE(inboundBuffer, { error: { conditionCode: "101" } }).frame);
```

***

### buildAckCR()

> **buildAckCR**(`inbound`, `options?`): [`MllpAck`](#mllpack)

Build a `CR` (Commit Reject) MLLP ACK (enhanced mode).

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options?

`Omit`\<[`BuildMllpAckOptions`](#buildmllpackoptions), `"code"`\>

#### Returns

[`MllpAck`](#mllpack)

#### Example

```typescript
import { buildAckCR } from '@cosyte/mllp/ack-from-hl7';
socket.write(buildAckCR(inboundBuffer, { error: { conditionCode: "200" } }).frame);
```

***

### buildMllpAck()

> **buildMllpAck**(`inbound`, `options`): [`MllpAck`](#mllpack)

Build a framed MLLP ACK from an inbound HL7 v2 message, the core
`ack-from-hl7` adapter. `inbound` may be an already-parsed `Hl7Message`, or
raw bytes/text to parse first.

Behavior:
- **Fatally unparseable inbound** (`Hl7ParseError`), never emits a
  positive code: `AA`→`AE`, `CA`→`CE`; other codes pass through. MSA-2 is
  empty, `correlationId` and `mode` are `undefined`, and `warnings`
  contains one [MLLP\_ACK\_INBOUND\_UNPARSEABLE](#mllp_ack_inbound_unparseable) entry naming the fatal
  code, never any inbound payload bytes.
- **Normal path**, detects the ack mode from inbound MSH-15/16, delegates
  to `@cosyte/hl7`'s `buildAck` (which applies its own no-correlation
  fail-safe), and forwards `buildAck`'s own warnings (mapped to
  `{ code, message }`). Inbound parse warnings are NOT forwarded, they are
  the caller's concern if they parsed the inbound themselves.

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

##### options

[`BuildMllpAckOptions`](#buildmllpackoptions)

#### Returns

[`MllpAck`](#mllpack)

#### Throws

when `@cosyte/hl7` is not installed.

#### Throws

when `options.code` is not a known HL7 Table 0008 code, or when
  `options.encoding` is a **non-text** codec (`base64`/`base64url`/`hex`/`utf16le`/`ucs2`)
  on **any** inbound, it would serialize a garbage frame the receiver cannot parse.
  See [BuildMllpAckOptions.encoding](#encoding).

#### Example

```typescript
import { buildMllpAck } from '@cosyte/mllp/ack-from-hl7';
const ack = buildMllpAck(inboundBuffer, { code: "AA" });
socket.write(ack.frame);
```

***

### detectMode()

> **detectMode**(`inbound`): `AckMode`

Detect the HL7 acknowledgment mode (`"original"` vs `"enhanced"`) of an
inbound message, from MSH-15/16. Named `detectMode` (not `detectAckMode`)
to avoid colliding with the peer's own `detectAckMode` export for callers
who import both from `@cosyte/hl7` and `@cosyte/mllp/ack-from-hl7`.

`inbound` may be an already-parsed `Hl7Message`, or raw bytes/text to parse
first. A fatal parse failure rethrows the `Hl7ParseError` as-is, unlike
[buildMllpAck](#buildmllpack), there is no ACK to build here, so there is no
fallback to construct.

**Module-realm note:** this adapter loads `@cosyte/hl7` lazily via
`createRequire` (see `peer.ts`). If your code ALSO does
`import { Hl7ParseError } from "@cosyte/hl7"` directly, Node's module
resolution can, depending on your bundler/runtime, hand you a distinct
module instance than the one this adapter loaded, in which case
`caught instanceof Hl7ParseError` (your import) may be `false` even though
`caught.name === "Hl7ParseError"` and `caught.code` is a valid HL7 fatal
code (`NO_MSH_SEGMENT` / `MSH_TOO_SHORT` / `INVALID_ENCODING_CHARACTERS` /
`EMPTY_INPUT`). Prefer narrowing on `.code`/`.name`, or obtain the exact
class via this subpath's own `loadHl7Peer().Hl7ParseError`.

#### Parameters

##### inbound

`string` \| `Buffer`\<`ArrayBufferLike`\> \| `Hl7Message`

#### Returns

`AckMode`

#### Throws

when `@cosyte/hl7` is not installed.

#### Throws

when `inbound` is raw bytes/text that fails to parse.

#### Example

```typescript
import { detectMode } from '@cosyte/mllp/ack-from-hl7';
detectMode(inboundBuffer); // "original" | "enhanced"
```

***

### loadHl7Peer()

> **loadHl7Peer**(`requireFn?`): [`Hl7Peer`](#hl7peer)

**`Internal`**

Load the `@cosyte/hl7` peer module, caching the result for subsequent
calls. The public adapter functions in `build.ts` call this internally,
most consumers never call it directly.

#### Parameters

##### requireFn?

(`id`) => `unknown`

Injectable `require`-like function, used by tests to
  simulate a missing peer without actually uninstalling it. Defaults to a
  real `createRequire(import.meta.url)`.

#### Returns

[`Hl7Peer`](#hl7peer)

#### Example

```typescript
import { loadHl7Peer } from '@cosyte/mllp/ack-from-hl7';
const hl7 = loadHl7Peer();
const ack = hl7.buildAck(hl7.parseHL7(raw), { code: "AA" });
```
