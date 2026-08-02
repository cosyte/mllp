---
"@cosyte/mllp": patch
---

**The PHI scanner no longer refuses a whole sweep because a file went away while it was reading.** A full-tree scan lists `test/` and `src/` first and reads each file afterwards, so anything created and removed inside that window made a read fail and took the entire scan down with it, reporting an invocation error over a file that no longer existed. The refusal was never the wrong behaviour; the enumeration was, so the enumeration is what changed.

Exactly one case is now tolerated: a file the scan enumerated itself, that git does not track, that is gone by the time the read arrives. It is reported on stderr as skipped, naming the path, so a skip is never silent. Everything else still refuses, and the bounds are deliberately narrow:

- A tracked file that cannot be read still refuses. The committed corpus is what the gate promises to have observed.
- Any failure other than a missing file still refuses. A permission error or a path replaced by a directory is a scan that failed, not a file that went away.
- A tolerated file that is back on disk when the sweep ends still refuses, because the scan skipped something that exists.
- A git that cannot report the tracked set, or reports an empty one, switches the tolerance off entirely rather than treating every file as untracked.
- A full-tree scan that observed no files at all refuses outright, so the tolerance can never decay into a clean report of nothing.

This mattered here more than the wording suggests. The package's own test suite writes capture fixtures into temporary directories under `test/`, which is one of the scanned roots, and removes them again; measured on this checkout, they exist for about half a second each per test run. A scan running beside that suite could enumerate one and then fail to read it, and refuse.

Eight tests pin the tolerance and every bound above except one, each of them mutation-tested. They run against throwaway trees under the system temp directory, seven of those trees a git repository and one deliberately not, and five of the eight are driven by a `git` stand-in on `PATH` that fires in the gap between the listing and the first read, so the race is exercised with no sleep and no build.

The back-on-disk bound is the exception and is deliberately left unpinned: stubbing it out leaves the whole suite green. Reaching it needs a timed re-create against a deliberately slowed sweep, and a load-sensitive test guarding a load-dependent race is the failure this defect argues against. Review drove the branch by hand and confirmed it behaves as described. Losing it would lose the re-check, never the tolerance's bounds.

Two further limits are disclosed rather than closed: the post-sweep re-check is keyed on the enumerated path, so an untracked file renamed mid-scan goes unread under a clean report, and the directory listing has a narrower race of its own that is untouched here.

Recorded as `PHI-SCAN-ENUMERATE-THEN-READ-CLASS`, porting the remedy from `ccda#80`.
