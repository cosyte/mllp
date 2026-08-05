---
"@cosyte/mllp": patch
---

Scan the test sources the PHI commit-gate was never opening, and stop one healthy scan root
vouching for an empty one. Tooling and documentation only: no runtime code, no public API and no
published artifact changes.

**A `.ts` source under the fixture root was scanned by neither route.** The walk covered all of
`test/`, but the read filter then dropped every `.ts` file under it, and this repo's fixture corpus
is overwhelmingly `.ts`: 72 of the 76 tracked files under `test/` were removed from the gate,
leaving it standing on three framed binaries, and twelve of the 72 carried inline `PID|` literals.
This is an HL7 transport package, so a message written straight into a test source is the most
common fixture shape here, not an exotic one.

**The remedy is two-sided, and either half alone would have shipped nothing.** Widening the
enumeration is the visible half: a blanket extension rule cannot tell a file that carries violator
literals on purpose from one that carries them by accident, so it is replaced by an explicit
per-path exemption, which is a reviewed act exactly like adding an allow-list token. The half that
actually finds anything is recognition. Every detector in the scanner assumed the file **is** the
document and worked from a segment id at the start of a line, so in a source whose lines start with
`const` or with a quote it matched nothing: a probe carrying a full patient identity in a string
literal exited 0 "OK, no hits" even when named explicitly on the command line, which bypasses the
enumeration entirely, while the identical payload written to a message file reported all five
fields. Embedded segments are now recovered out of string literals, with TypeScript escapes
resolved so the encoding characters an HL7 header declares are the ones the scanner reads, and with
a template placeholder neither guessed at nor dropped. The recogniser anchors on the HL7 field
separator: anchoring on any delimiter turns prose and identifiers into segments and would have
driven the name backstop over English words, and a gate that reds on prose is a gate someone turns
off. Five synthetic tokens the widening made visible for
the first time, including a deliberate leak canary, are now declared in the allow-list.

**A sweep that observed nothing under one root still reported OK.** The guard that refuses an
empty sweep counted every root together, so it could only fire when all of them came back empty and
one healthy root masked an empty one indefinitely: with the fixture root emptied, the run printed
"OK, no hits" and exited 0 on the strength of the source root alone, under a comment asserting the
sweep "always reaches" the fixture corpus that nothing checked. A denominator would not have caught
it and would have looked like a fix, because a count counts the roots that did exist. The check is
now per root and keyed on the roots the walk actually entered, so an absent root stays legitimate
while an emptied one refuses.

**An unmerged path was enumerated by nothing.** It has no single staged blob, so the status filter
deletes the record and the pre-commit route printed "OK, no hits" over a conflicted fixture whose
both sides carried live-shaped identifiers. It now refuses, because neither side of a conflict is
what a commit would contain, so reading one would be a claim about content that may never exist.
Minor, and honestly so: the commit itself is refused earlier by git, so this is not a route by
which anything reaches a commit. What it fixes is the gate answering a question it cannot answer.

17 new cases, 11 of which run red against the base scanner; the other six are controls that pin
the absence of false positives, the `src/` decision that this work deliberately does not reverse,
and the recogniser's disclosed limits.
