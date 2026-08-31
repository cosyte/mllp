---
"@cosyte/mllp": patch
---

The README is rewritten to the house package-front-page standard, so the text npm freezes at publish is complete and correct rather than half-written.

**The status line was the worst of it.** The file's only status statement read "under active development. API not yet stable (`0.0.x`)", which is the opposite of what this release claims. `## Status` now names the version the page describes, says in plain terms that the public API is settled and safe to depend on, and names what is still moving instead of implying nothing is: batch acknowledgement is not built, verified engine coverage is a growing list rather than a complete one, and MLLP Release 2 is not spoken.

**Six sections a reader needs were simply absent** and are now written: `Why this exists`, `Status`, `Install`, `Usage`, `PHI and safety` and `Contributing`. `Why this exists` states the problem and the nearest alternative rather than restating the feature list. `Install` gives the Node floor, the package manager and the dual ESM plus CJS format in one copy-pasteable block. `Contributing` says where to ask, that pull requests are welcome, that no contributor guide exists yet, and exactly which checks a change has to clear.

**`PHI and safety` is new and is the section a healthcare integrator opens first.** It states what the transport does with a payload (holds it in memory only while it is in flight), what it never does (no parse, no disk write, no queue, no replay store, no logger call, and diagnostics that report shape rather than content), and what the consumer still owns: encryption in transit, their own logging, idempotency on `MSH-10` plus `MSH-7`, and any decision to widen the loopback bind default.

**Every example was made verifiable.** The client example now shows the acknowledgement it actually receives, `MSA-2` echoing the control id that was sent, and a new framing example shows the bytes `encodeFrame` emits and the chunked `FrameReader` delivering one frame from two partial pushes, with their real output printed beneath them. Roughly half of documentation traffic is now agents lifting blocks verbatim, so an example that cannot run is a defect.

**Banner and head.** The banner alt text now matches the shared brand declaration for the tile it shows, character for character, instead of a hand-written description that had drifted from it. The one-line description under the badges is now the same string the package publishes, so the page and the registry no longer say two different things. The tagline is shortened to one readable line, and a table of contents was added.

No runtime code, framing, acknowledgement, transport or TLS behaviour changes here. Documentation only.
