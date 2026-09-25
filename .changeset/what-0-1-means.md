---
"@cosyte/mllp": minor
---

`0.1.0` is the first release of `@cosyte/mllp` whose public API we ask you to build on.

**What is covered, and what you can depend on.** Sending and receiving HL7 v2 over MLLP: the client and the server (`createClient`, `createServer` and their starter forms), strict framing through `encodeFrame` and `FrameReader`, acknowledgement correlation on MSA-2, and the commit contract, under which the server's positive acknowledgement never comes before your handler's commit and a handler that throws is answered `AE`. Auto-reconnect with backoff, backpressure, a `close()` that drains and then tells a message that was never written apart from one whose fate is unknown, TLS with certificate verification on by default, and a server that binds loopback unless you opt in to more. The socket-free `InMemoryTransport` at `@cosyte/mllp/testing`, acknowledgements built from a parsed message at `@cosyte/mllp/ack-from-hl7` (with the optional `@cosyte/hl7` peer), and `runDifferential`, which reports how the engine you point it at frames and acknowledges. The stable warning codes and security-warning codes are part of this API. Node.js 22 and 24, ESM and CommonJS, with type declarations for both.

**What the version promises.** Until 1.0, a breaking change raises the minor version (0.1 to 0.2), and the changelog entry says what broke and what to change. A patch release (0.1.x) does not break you, so a `^0.1.0` range takes the patches and stops before 0.2.0.

**What is not covered yet.** Batch acknowledgement: an `FHS`/`BHS` envelope is answered with a warned `AE`, never a positive one. MLLP Release 2. A queue or replay store for unacknowledged messages. Differential coverage of engines other than the freely available ones it runs against, so Epic and Cerner are not in it. The documentation at https://docs.cosyte.com/mllp lists the known limitations in full.

The repository now carries runnable examples under `examples/`, run against the built package on every change.
