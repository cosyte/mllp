---
"@cosyte/mllp": patch
---

Stop the test suite asserting an idle machine, mostly by making it cheaper rather than by moving a
number. Test-only: no runtime, public API or published artifact changes.

Measured with base and head interleaved on a shared box, under `pnpm test:coverage`, and the
load-sensitive parts under four concurrent coverage suites. Under that load the base commit failed
three runs out of three on correct code and head passed three out of three.

`hookTimeout: 10_000` was removed because Vitest 4.1.4 resolves exactly that as its own default.
`testTimeout: 10_000` stays, but not because the suite needs it: after the trims the slowest case
carrying no budget of its own peaks at 2.6 s under four concurrent suites, so the shared ceiling is
no longer what stands between this suite and a false red, and moving it either way would be churn.

Two sites gain a budget and no pre-existing number changes value. The larger is `test/tls/**`, where
every case generates an RSA key pair and completes a real handshake and the slowest peaked at 9.70 s
against a 10 s ceiling; both TLS files now carry a suite-level budget stated at the site. The smaller
is the one case this slice adds, which peaked at 9.20 s for the same reason.

Two trims did the rest. The phi-scan suite spawned the scanner through `tsx` dozens of times (466 ms
a start against 137 ms for bare `node`) and now spawns `node` with native type stripping, going from
29.7 s to 12.4 s while gaining a test that pins the `tsx` entry point `pnpm phi-scan` really uses.
And `toEqual` on a megabyte of Buffer, which walks it element by element in JS, was 8.46 s of a
framing test that exists to exercise a round trip costing tens of milliseconds; the two large-payload
assertions now use a native compare through a helper that reports the first differing offset, taking
those two files from 14.9 s to 1.2 s.

The whole-suite wall moved less, from 33.3 s to 27.8 s, because the critical path is the `attw`
gate's real `npm pack` calls, which this change deliberately left alone.
