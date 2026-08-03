---
"@cosyte/mllp": patch
---

PHI scanner: refuse a non-regular entry under a scan root, blind on both routes.

A symbolic link under `test/` or `src/` read clean on BOTH enumerating routes, so a link pointing at
a PHI-bearing file passed the gate twice over. `walk()` enumerates `Dirent.isFile()`, an lstat
answer, so a link is neither a file nor a directory and fell out of the loop, taking a whole subtree
with it when the link was to a directory; `--staged` read content with `git show :<path>`, and git
stores a symbolic link as its target path under mode `120000`, so that route scanned the path text.
Neither route now follows a link: a non-regular in-scope entry refuses the scan (exit 2) and every
offender is named, by its own repo-relative path and an engine-owned kind token, never the link
target. `--staged` reads `git diff --cached --raw -z --diff-filter=AMT` so the destination mode is
visible; `T` is load-bearing, because replacing a tracked file with a link is neither an add nor a
modify and the record was previously dropped before any mode could be read.

Staged renames and copies are still not enumerated by `--staged` at all (pre-existing), and
explicit-path mode still reads through a link; both are disclosed rather than closed here.
