---
"@cosyte/mllp": patch
---

Gate this repository's two-file guidance contract, so a dangling pointer or an emptied section cannot land unnoticed.

`scripts/check-agent-notes.ts` (`pnpm check:agent-notes`) checks three things: that
`documentation/agent-notes.md` is tracked, that every section under a heading has a body, and that
every pointer at it, in a file the check opened, resolves to an anchor GitHub would actually mint.
A heading immediately followed by a deeper one is a container whose body is its subsections, so it
is not reported; the obligation moves down to the deeper heading, which means an emptied leaf is
still a finding and a trailing heading is never a container.
Splitting the guidance in two moved the reasoning behind a link, which made the link load-bearing,
and nothing
checked it. A rename, an emptied section, or an anchor edited on one side of the pair and not the
other would all have been silent.

The check is named for what it checks and asserts no universal. Measured across the sibling
repositories on 2026-08-06, three carry no such file at all, so a check written as though every
repository kept the same contract would assert something those three disprove. This one asserts this
repository's promise only, and it runs in this repository's own tests.

It refuses rather than reporting clean over a corpus it never opened. There is no declared root to
be wrong about: the file list comes from `git ls-files`, every path in it is opened or refused, and
the only silent skip is a file containing a NUL byte, which is counted and named on the success
line as a disclosed miss rather than a pass. It exits 2 when nothing is tracked, when a tracked
path is missing, unreadable, a symlink or not a regular file, when a path is unmerged, and when it
finds no pointers at all. A finding exits 1 and a refusal exits 2, so a broken checker can never be
read as a list of real findings.

Each tracked path is resolved exactly once, by a single open, and the symlink and regular-file
questions are asked of the resulting descriptor rather than of the path a second time. Checking a
path and then reading it again is a time-of-check/time-of-use race, and the refusal it threatens is
the symlink one, which is what stops bytes from outside the tree being scanned under a tracked
path's name. Opening with the no-follow flag makes that refusal part of the open itself, and the
non-blocking flag is what keeps a tracked path replaced by a FIFO from hanging the check instead of
refusing it.

Both heading shapes that defeat a naive leading-hash rule are handled and reproduced end to end: a
heading indented by a space, and one underlined rather than hashed. Both are false-red bypasses,
because a missed heading is a missing anchor. So is the opposite direction, where a hash line inside
a code fence, or a YAML front-matter key, must not mint an anchor or a dangling pointer would pass.
The slug transformation is measured against github-slugger rather than assumed, including four
shapes that diverge from the obvious implementation: a dropped leading character leaves a leading
hyphen behind, a repeated heading is re-suffixed until its slug is free, a space separator other
than the plain one is deleted, and a heading wrapped across two lines has the break deleted rather
than turned into a hyphen.

Measured against the parent commit by running it there: zero violations. This changes no content and
exists to stop a regression. `test/scripts/agent-notes.test.ts` runs it against this tree, seeds each
violation class into throwaway repositories, pins each disclosed miss that has anything to execute in
the direction it actually fails, and includes the control that a check pointed at nothing must refuse
rather than report clean. Two of the disclosed misses are statements of scope rather than behaviour,
so there is nothing to run for them and none is claimed.

Repository tooling and guidance only. No runtime code, no public API, no warning code, and no
framing or transport behaviour changed.
