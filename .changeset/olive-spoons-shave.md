---
"@cosyte/mllp": patch
---

Stop the test suite asserting an idle machine, mostly by making it cheaper rather than by moving a
number. Test-only: no runtime, public API or published artifact changes.

`hookTimeout: 10_000` was removed because it is exactly Vitest 4.1.4's own default, measured on this
repo rather than read. `testTimeout: 10_000` stays: deleting it does not remove a ceiling, it halves
it to the framework's 5,000 ms, which measurement says would sit close enough to red correct code.

What was actually asserting an idle box is `test/tls/**`, where every case generates an RSA key pair
and completes a real handshake, and one case was caught timing out just past 10 s on correct code
under four concurrent coverage suites. Both TLS files now carry a suite-level budget stated at the
site.

Two trims did the rest. The phi-scan suite spawned the scanner through `tsx` dozens of times and now
spawns `node` with native type stripping, going from around 32 s to around 13 s under coverage while
gaining a test that pins the `tsx` entry point `pnpm phi-scan` really uses. And `toEqual` on a
megabyte of Buffer, which walks it element by element in JS, turned out to be the entire cost of the
framing corpus test; the two large-payload assertions now use a native compare through a helper that
reports the first differing offset, taking those two files from around 13 s to around 4 s.

The whole-suite wall moved less, from roughly 34 s to roughly 28 s, because the critical path is the
`attw` gate's real `npm pack` calls, which this change deliberately left alone.
