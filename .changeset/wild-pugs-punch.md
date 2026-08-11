---
"@cosyte/mllp": patch
---

The PHI scanner refuses a target it enumerated and never read.

A whole-file `--allow-fixture` bypass used to withdraw a path at enumeration time, so a file that was read and found clean and a file that was never opened became the same state: the scan then reported on whatever was left. A corpus whose only violator was withdrawn printed `OK, no hits` and exited 0, and naming a bypass beside a positional path was a silent no-op that neither read the file nor said so.

The scanner now compares what a run declared it would read against what it actually opened, as a set difference rather than a count, and refuses (exit 2) naming every path it did not open. The one exception is a file that genuinely vanished mid-sweep, which is already reported on its own terms. A bypass that names a path the run does not enumerate is refused for that instead, because such a flag subtracts nothing. Hits are still reported first, so a run that is both incomplete and carrying findings prints both.

`--allow-fixture` can no longer reach a clean run in any mode: it is recorded in the bypass log and then refused. For most findings the remedy is to declare the individual identifiers in `scripts/phi-allow-list.txt`, and the hit report now says so rather than advertising the bypass. Two checks have no such declaration and are keyed on a convention instead: a phone number is cleared by the 555 fake-exchange convention, and a dashed-SSN shape is reported wherever it appears. Those two lose the bypass without gaining a declaration, so a fixture that trips them has to be changed rather than acknowledged. The hit report names that too.
