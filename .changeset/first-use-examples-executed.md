---
"@cosyte/mllp": patch
---

Docs: the README's usage example is now one complete program the test suite runs, and the quickstart's first example is held to a committed synthetic fixture.

The usage example used to be two fragments: a server on a fixed port whose handler called an undeclared `db`, and a client whose printed acknowledgement carried a timestamp and a control id that change on every run. It now starts the server on a port the operating system picks on loopback, sends one message, logs only the shape of the acknowledgement (its code, and whether MSA-2 echoed the control id sent), and closes both ends. The test suite reads it out of the README, runs it twice against the package, and compares its output with the block printed beside it. The message each first example puts on the wire is a byte-for-byte copy of a committed synthetic fixture, a changed value in either example fails the suite, and every install command the README and the installation page print is checked against the package's own name or a dependency it declares.

The quickstart's first example did not compile in a strict TypeScript project: it assigned the de-framed payload to an untyped `let` inside the `onFrame` callback and then called `.equals` on it. It now collects payloads into a `Buffer[]` and claims that exactly one came out. The suite compiles both first examples with the settings `tsc --init` writes for a new project, so an example that does not compile fails it.
