---
"@cosyte/mllp": patch
---

The PHI scanner refuses a target it enumerated and never read.

A whole-file `--allow-fixture` bypass used to withdraw a path at enumeration time, so a file that was read and found clean and a file that was never opened became the same state: the scan then reported on whatever was left. A corpus whose only violator was withdrawn printed `OK, no hits` and exited 0, and naming a bypass beside a positional path was a silent no-op that neither read the file nor said so.

The scanner now compares what a run declared it would read against what it actually opened, as a set difference rather than a count, and refuses (exit 2) naming every path it did not open. A bypass that names a path the run does not enumerate is refused for that instead, because such a flag subtracts nothing. Hits are still reported first, so a run that is both incomplete and carrying findings prints both.

`--allow-fixture` can no longer reach a clean run in any mode: it is recorded in the bypass log and then refused. Declaring the individual identifiers in `scripts/phi-allow-list.txt` is the only remedy that reaches exit 0, and the hit report now says so rather than advertising the bypass.
