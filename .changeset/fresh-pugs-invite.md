---
"@cosyte/mllp": patch
---

The README is rewritten to the house package front-page standard, so the text npm freezes at publish is complete and correct rather than half-written.

**`Status` now describes this release.** It names the version the page documents, says in plain terms that the public API is settled and safe to depend on, and names what is still moving rather than implying nothing is: batch acknowledgement is not built, verified engine coverage is a growing list rather than a complete one, and MLLP Release 2 is not spoken. The old line describing the package as unstable is gone.

**Six sections a reader needs are now written:** `Why this exists`, `Status`, `Install`, `Usage`, `PHI and safety` and `Contributing`. `Why this exists` states the problem and the nearest alternative rather than restating the feature list. `Install` gives the Node floor, the package manager and the dual ESM plus CJS format in one copy-pasteable block. `Contributing` says where to ask, that pull requests are welcome, that no contributor guide exists yet, and exactly which checks a change has to clear.

**`PHI and safety` is new, and it states bounds rather than absolutes.** What the transport does with a payload, which is hold it in memory only while it is in flight, and reuse its receive buffer for the next frame rather than scrub it. The reads it performs: the `MSH` header an acknowledgement is built from, and the `MSA` of an inbound acknowledgement, each bounded at that segment's own terminator, so no segment carrying clinical content is reached. The exception, named rather than glossed and opt-in either way: the `ack-from-hl7` subpath decodes a whole message and hands it to the optional parser peer, which resolves every field of every segment. What it does not do: no disk write, no queue, no replay store, no logger call. Exactly what a diagnostic can carry, including the two framing warning codes that render the hex of the single byte found where a framing byte was expected, and what to log instead if that is more than your threat model allows. And what you still own: encryption in transit, your own logging and retention, idempotency, and any decision to widen the loopback bind default.

**Every example is verifiable.** The client example shows the acknowledgement it actually receives, with `MSA-2` echoing the control id that was sent, and a new framing example shows the bytes `encodeFrame` emits and a chunked `FrameReader` delivering one frame from two partial pushes, each with its real output printed beneath it.

**Banner and head.** The banner alt text now matches the shared brand declaration for the tile it shows, character for character, instead of a hand-written description that had drifted from it. The one-line description under the badges is now the same string the package publishes, so the page and the registry no longer say two different things. The tagline is shortened to one readable line, and a table of contents was added.

No runtime code, framing, acknowledgement, transport or TLS behaviour changes here. Documentation only.
