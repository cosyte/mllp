---
"@cosyte/mllp": patch
---

Gate this repository's two-file guidance contract, so a dangling pointer or an emptied section cannot land unnoticed.

`scripts/check-agent-notes.ts` (`pnpm check:agent-notes`) checks three things: that
`documentation/agent-notes.md` is tracked, that every section under a heading has a body, and that
every pointer at it from any tracked file resolves to an anchor GitHub would actually mint. Splitting
the guidance in two moved the reasoning behind a link, which made the link load-bearing, and nothing
checked it. A rename, an emptied section, or an anchor edited on one side of the pair and not the
other would all have been silent.

The check is named for what it checks and asserts no universal. Measured across the sibling
repositories on 2026-08-06, three carry no such file at all, so a check written as though every
repository kept the same contract would assert something those three disprove. This one asserts this
repository's promise only, and it runs in this repository's own tests.

It refuses rather than reporting clean over a corpus it never opened. The file list comes from
`git ls-files`, every path is accounted for as opened or skipped for a named reason, the arithmetic
is printed on the success line, and it exits 2 if the count does not balance, if nothing is tracked,
if a tracked path is missing or is not a regular file, or if it finds no pointers at all. A finding
exits 1 and a refusal exits 2, so a broken checker can never be read as a list of real findings.

Both heading shapes that defeat a naive leading-hash rule are handled and reproduced end to end: a
heading indented by a space, and one underlined rather than hashed. Both are false-red bypasses,
because a missed heading is a missing anchor. So is the opposite direction, where a hash line inside
a code fence must not mint an anchor or a dangling pointer would pass. A pointer split across a line
wrap resolves, and the join is attempted only after the unwrapped anchor has already failed, so it
can rescue a false red but cannot manufacture a pass.

Measured against the parent commit by running it there: zero violations, 18 pointers resolving, 19
sections with a body, 155 tracked paths reconciled. This changes no content and exists to stop a
regression. `test/scripts/agent-notes.test.ts` runs it against this tree and seeds each violation
class into throwaway repositories, including the control that a check pointed at nothing must refuse
rather than report clean. It scans its own source and its own tests with no exemption, which is why
the sample pointers in that test are assembled rather than written out: a checker's own tests are
exactly where a broken pointer would hide.

Repository tooling and guidance only. No runtime code, no public API, no warning code, and no
framing or transport behaviour changed.
