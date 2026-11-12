# src/arbitraries

fast-check generators for MLLP, at `@cosyte/mllp/arbitraries`: payloads, canonical frames,
canonical byte streams split into chunks, messy streams a lenient reader accepts, and hostile
streams. We use them to test this library, and you can use them to test code you build on it.

`fast-check` is an optional peer dependency: install it to use this entry point. The main entry
point, `@cosyte/mllp`, never loads it. This entry point imports nothing from the library at run
time, only its types.

Every generated value is synthetic and random. Each one keeps a copy of itself, which fast-check
clones and prints, so code that changes the bytes it is given cannot change the case fast-check
reports.

## Example

```ts
import fc from "fast-check";
import { FrameReader, encodeFrame } from "@cosyte/mllp";
import { payload } from "@cosyte/mllp/arbitraries";

fc.assert(
  fc.property(payload(), (p) => {
    let got: Buffer | undefined;
    new FrameReader({ onFrame: (b) => (got = b) }).push(encodeFrame(p));
    return got?.equals(p) === true;
  }),
);
```

## Interfaces

### ChunkOptions

Options for [chunked](#chunked).

#### Extended by

- [`StreamOptions`](#streamoptions)

#### Properties

##### maxCuts?

> `readonly` `optional` **maxCuts?**: `number`

The most places the bytes are cut. Default `16`. Two cuts in one place leave an empty chunk.

***

### GeneratedFrame

A canonical frame and the payload it carries.

#### Properties

##### bytes

> `readonly` **bytes**: `Buffer`

The frame as it goes on the wire: `VT`, the payload, `FS`, `CR`.

##### payload

> `readonly` **payload**: `Buffer`

The payload: what a reader must deliver for these bytes.

***

### GeneratedStream

A canonical byte stream: frames back to back, as chunks, with the payloads it carries.

#### Extended by

- [`MessyStream`](#messystream)

#### Properties

##### bytes

> `readonly` **bytes**: `Buffer`

The whole stream: each payload's canonical frame, back to back.

##### chunks

> `readonly` **chunks**: readonly `Buffer`\<`ArrayBufferLike`\>[]

The same bytes split at random places, the reads a socket may deliver.

##### payloads

> `readonly` **payloads**: readonly `Buffer`\<`ArrayBufferLike`\>[]

The payloads in order: what a reader must deliver for this stream.

***

### HostileInputOptions

Options for [hostileInput](#hostileinput).

#### Properties

##### maxCuts?

> `readonly` `optional` **maxCuts?**: `number`

The most places the stream is cut into chunks. Default `16`.

##### maxLength?

> `readonly` `optional` **maxLength?**: `number`

The most bytes in the stream. Default `512`.

***

### MessyStream

A messy stream, with what a reader with the matching tolerances must deliver for it.

#### Extends

- [`GeneratedStream`](#generatedstream)

#### Properties

##### bytes

> `readonly` **bytes**: `Buffer`

The whole stream: each payload's canonical frame, back to back.

###### Inherited from

[`GeneratedStream`](#generatedstream).[`bytes`](#bytes-1)

##### chunks

> `readonly` **chunks**: readonly `Buffer`\<`ArrayBufferLike`\>[]

The same bytes split at random places, the reads a socket may deliver.

###### Inherited from

[`GeneratedStream`](#generatedstream).[`chunks`](#chunks)

##### payloads

> `readonly` **payloads**: readonly `Buffer`\<`ArrayBufferLike`\>[]

The payloads in order: what a reader must deliver for this stream.

###### Inherited from

[`GeneratedStream`](#generatedstream).[`payloads`](#payloads)

##### warnings

> `readonly` **warnings**: readonly (readonly [`WarningCode`](../src.md#warningcode)[])[]

The warning codes each delivered frame must carry, in the order they are raised, one list per
payload. A frame with no quirk has an empty list.

***

### MessyStreamOptions

Options for [messyStream](#messystream-1): the payloads, the frames and the cuts as for a canonical stream,
and the tolerances of the reader the stream is meant for. A quirk whose tolerance is `false` is
never generated, so pass the same flags your `FrameReader` or server has. Each defaults to `true`.

#### Extends

- [`StreamOptions`](#streamoptions)

#### Properties

##### allowFsOnly?

> `readonly` `optional` **allowFsOnly?**: `boolean`

Generate `FS` with no `CR` after it.

##### allowLeadingWhitespace?

> `readonly` `optional` **allowLeadingWhitespace?**: `boolean`

Generate spaces, tabs, line feeds and carriage returns before a frame.

##### allowLfAfterFs?

> `readonly` `optional` **allowLfAfterFs?**: `boolean`

Generate `FS` then `LF` in place of `FS` then `CR`.

##### allowMissingLeadingVt?

> `readonly` `optional` **allowMissingLeadingVt?**: `boolean`

Generate a frame that opens with no `VT`.

##### content?

> `readonly` `optional` **content?**: [`PayloadContent`](#payloadcontent)

What the payload holds.

- `"bytes"` (the default): any byte except `VT` (`0x0B`) and `FS` (`0x1C`), the two bytes the
  encoder refuses. `CR` and the other control bytes are in.
- `"text"`: printable ASCII with carriage returns, the shape of HL7 v2 text.
- `"hl7"`: a synthetic HL7 v2 message: an `MSH` segment with a generated control id in MSH-10,
  then up to four more segments, each ended by a carriage return. `minLength` and `maxLength`
  do not apply.

###### Inherited from

[`StreamOptions`](#streamoptions).[`content`](#content-2)

##### maxCuts?

> `readonly` `optional` **maxCuts?**: `number`

The most places the bytes are cut. Default `16`. Two cuts in one place leave an empty chunk.

###### Inherited from

[`StreamOptions`](#streamoptions).[`maxCuts`](#maxcuts-3)

##### maxFrames?

> `readonly` `optional` **maxFrames?**: `number`

The most frames in the stream. Default `5`.

###### Inherited from

[`StreamOptions`](#streamoptions).[`maxFrames`](#maxframes-1)

##### maxLength?

> `readonly` `optional` **maxLength?**: `number`

The most bytes in a `"bytes"` or `"text"` payload. Default `256`.

###### Inherited from

[`StreamOptions`](#streamoptions).[`maxLength`](#maxlength-3)

##### minFrames?

> `readonly` `optional` **minFrames?**: `number`

The fewest frames in the stream. Default `1`.

###### Inherited from

[`StreamOptions`](#streamoptions).[`minFrames`](#minframes-1)

##### minLength?

> `readonly` `optional` **minLength?**: `number`

The fewest bytes in a `"bytes"` or `"text"` payload. Default `1`.

###### Inherited from

[`StreamOptions`](#streamoptions).[`minLength`](#minlength-2)

***

### PayloadOptions

Options for [payload](#payload-1), and for the payloads inside frames and streams.

#### Extended by

- [`StreamOptions`](#streamoptions)

#### Properties

##### content?

> `readonly` `optional` **content?**: [`PayloadContent`](#payloadcontent)

What the payload holds.

- `"bytes"` (the default): any byte except `VT` (`0x0B`) and `FS` (`0x1C`), the two bytes the
  encoder refuses. `CR` and the other control bytes are in.
- `"text"`: printable ASCII with carriage returns, the shape of HL7 v2 text.
- `"hl7"`: a synthetic HL7 v2 message: an `MSH` segment with a generated control id in MSH-10,
  then up to four more segments, each ended by a carriage return. `minLength` and `maxLength`
  do not apply.

##### maxLength?

> `readonly` `optional` **maxLength?**: `number`

The most bytes in a `"bytes"` or `"text"` payload. Default `256`.

##### minLength?

> `readonly` `optional` **minLength?**: `number`

The fewest bytes in a `"bytes"` or `"text"` payload. Default `1`.

***

### StreamOptions

Options for [stream](#stream).

#### Extends

- [`PayloadOptions`](#payloadoptions)
- [`ChunkOptions`](#chunkoptions)

#### Extended by

- [`MessyStreamOptions`](#messystreamoptions)

#### Properties

##### content?

> `readonly` `optional` **content?**: [`PayloadContent`](#payloadcontent)

What the payload holds.

- `"bytes"` (the default): any byte except `VT` (`0x0B`) and `FS` (`0x1C`), the two bytes the
  encoder refuses. `CR` and the other control bytes are in.
- `"text"`: printable ASCII with carriage returns, the shape of HL7 v2 text.
- `"hl7"`: a synthetic HL7 v2 message: an `MSH` segment with a generated control id in MSH-10,
  then up to four more segments, each ended by a carriage return. `minLength` and `maxLength`
  do not apply.

###### Inherited from

[`PayloadOptions`](#payloadoptions).[`content`](#content-1)

##### maxCuts?

> `readonly` `optional` **maxCuts?**: `number`

The most places the bytes are cut. Default `16`. Two cuts in one place leave an empty chunk.

###### Inherited from

[`ChunkOptions`](#chunkoptions).[`maxCuts`](#maxcuts)

##### maxFrames?

> `readonly` `optional` **maxFrames?**: `number`

The most frames in the stream. Default `5`.

##### maxLength?

> `readonly` `optional` **maxLength?**: `number`

The most bytes in a `"bytes"` or `"text"` payload. Default `256`.

###### Inherited from

[`PayloadOptions`](#payloadoptions).[`maxLength`](#maxlength-2)

##### minFrames?

> `readonly` `optional` **minFrames?**: `number`

The fewest frames in the stream. Default `1`.

##### minLength?

> `readonly` `optional` **minLength?**: `number`

The fewest bytes in a `"bytes"` or `"text"` payload. Default `1`.

###### Inherited from

[`PayloadOptions`](#payloadoptions).[`minLength`](#minlength-1)

## Type Aliases

### PayloadContent

> **PayloadContent** = `"bytes"` \| `"text"` \| `"hl7"`

What a generated payload holds.

## Functions

### chunked()

> **chunked**(`bytes`, `options?`): `Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>[]\>

The given bytes split into chunks at random places, the way a socket may deliver them: a frame
across many reads, many frames in one read, and now and then an empty read. Concatenated, the
chunks are always the bytes given. A case shrinks toward one chunk.

#### Parameters

##### bytes

`Buffer`

The bytes to split.

##### options?

[`ChunkOptions`](#chunkoptions) = `{}`

How many cuts at most.

#### Returns

`Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>[]\>

An arbitrary of chunk lists.

#### Example

```ts
import fc from "fast-check";
import { chunked } from "@cosyte/mllp/arbitraries";

const bytes = Buffer.from("ABCDEF");
fc.assert(fc.property(chunked(bytes), (chunks) => Buffer.concat(chunks).equals(bytes)));
```

***

### frame()

> **frame**(`options?`): `Arbitrary`\<[`GeneratedFrame`](#generatedframe)\>

A canonical MLLP frame, `VT` + payload + `FS` + `CR`, with the payload it carries.

The bytes are written from the MLLP specification, not by `encodeFrame`, so they are an
independent check on the encoder: `encodeFrame(f.payload)` equals `f.bytes`.

#### Parameters

##### options?

[`PayloadOptions`](#payloadoptions) = `{}`

The payload's options, as for [payload](#payload-1).

#### Returns

`Arbitrary`\<[`GeneratedFrame`](#generatedframe)\>

An arbitrary of frames.

#### Example

```ts
import fc from "fast-check";
import { encodeFrame } from "@cosyte/mllp";
import { frame } from "@cosyte/mllp/arbitraries";

fc.assert(fc.property(frame(), (f) => encodeFrame(f.payload).equals(f.bytes)));
```

***

### hostileInput()

> **hostileInput**(`options?`): `Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>[]\>

A hostile MLLP byte stream as the chunks a socket delivers: random bytes, bytes thick with
`VT`, `FS`, `CR`, `LF` and whitespace, and messy streams with bytes inserted, deleted, replaced,
repeated and cut off. A reader may refuse one, but it must not hang, crash or throw anything it
does not document.

#### Parameters

##### options?

[`HostileInputOptions`](#hostileinputoptions) = `{}`

The most bytes, and the most cuts.

#### Returns

`Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>[]\>

An arbitrary of chunk lists.

#### Example

```ts
import fc from "fast-check";
import { FrameReader, MllpFramingError } from "@cosyte/mllp";
import { hostileInput } from "@cosyte/mllp/arbitraries";

fc.assert(
  fc.property(hostileInput(), (chunks) => {
    const reader = new FrameReader({ onFrame: () => {} });
    try {
      for (const chunk of chunks) reader.push(chunk);
    } catch (err) {
      if (!(err instanceof MllpFramingError)) throw err;
    }
  }),
);
```

***

### messyStream()

> **messyStream**(`options?`): `Arbitrary`\<[`MessyStream`](#messystream)\>

A messy MLLP byte stream a lenient reader accepts, split into chunks at random places, with the
payloads it must deliver and the warnings each must carry.

Each frame may open with spaces, tabs, line feeds or carriage returns before its `VT`, or with no
`VT` at all; carry an empty payload; and end with `FS` and `LF`, or with `FS` and the next frame's
`VT`. Give it the tolerances your reader has, and it generates only what that reader accepts. It
never puts a `VT` inside a frame, nor an `FS` with anything but `CR`, `LF` or the next `VT` after
it: a reader refuses such a frame whole (`MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`),
so no reader accepts it.

#### Parameters

##### options?

[`MessyStreamOptions`](#messystreamoptions) = `{}`

The payloads, frames, cuts and tolerances.

#### Returns

`Arbitrary`\<[`MessyStream`](#messystream)\>

An arbitrary of messy streams.

#### Example

```ts
import fc from "fast-check";
import { FrameReader } from "@cosyte/mllp";
import { messyStream } from "@cosyte/mllp/arbitraries";

const tolerances = { allowFsOnly: true, allowLfAfterFs: true, allowLeadingWhitespace: true };
fc.assert(
  fc.property(messyStream({ ...tolerances, allowMissingLeadingVt: false }), (s) => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ ...tolerances, onFrame: (p) => got.push(p) });
    for (const chunk of s.chunks) reader.push(chunk);
    return got.length === s.payloads.length;
  }),
);
```

***

### payload()

> **payload**(`options?`): `Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>\>

A payload the encoder accepts: a `Buffer` with no `VT` (`0x0B`) and no `FS` (`0x1C`) in it.

Framed with `encodeFrame` and read back with a `FrameReader`, every one comes back byte for
byte. With the default `minLength` of 1 it also comes back with no warning; an empty payload
comes back with `MLLP_EMPTY_PAYLOAD`.

#### Parameters

##### options?

[`PayloadOptions`](#payloadoptions) = `{}`

What the payload holds and how long it is.

#### Returns

`Arbitrary`\<`Buffer`\<`ArrayBufferLike`\>\>

An arbitrary of payload buffers.

#### Example

```ts
import fc from "fast-check";
import { encodeFrame } from "@cosyte/mllp";
import { payload } from "@cosyte/mllp/arbitraries";

fc.assert(fc.property(payload(), (p) => encodeFrame(p).length === p.length + 3));
```

***

### stream()

> **stream**(`options?`): `Arbitrary`\<[`GeneratedStream`](#generatedstream)\>

A canonical MLLP byte stream: one to five frames back to back, split into chunks at random
places, with the payloads a reader must deliver from it, in order and with no warning.

#### Parameters

##### options?

[`StreamOptions`](#streamoptions) = `{}`

The payloads' options, how many frames, and how many cuts at most.

#### Returns

`Arbitrary`\<[`GeneratedStream`](#generatedstream)\>

An arbitrary of streams.

#### Example

```ts
import fc from "fast-check";
import { FrameReader } from "@cosyte/mllp";
import { stream } from "@cosyte/mllp/arbitraries";

fc.assert(
  fc.property(stream(), (s) => {
    const got: Buffer[] = [];
    const reader = new FrameReader({ onFrame: (p) => got.push(p) });
    for (const chunk of s.chunks) reader.push(chunk);
    return got.length === s.payloads.length;
  }),
);
```
