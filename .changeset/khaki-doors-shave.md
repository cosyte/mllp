---
"@cosyte/mllp": patch
---

Close three holes in the PHI commit-gate, two of them on `--staged`, which is the pre-commit half.
Tooling and documentation only: no runtime code, no public API and no published artifact changes.

A staged **rename or copy** was not enumerated at all. Both statuses carry a second path and
`--diff-filter=AMT` deletes such a record outright, so `git mv <link> test/<name>` staged as
`R100` at mode `120000` and the scan printed `OK, no hits` over a link sitting under a scan root,
and a rename that also substituted a real name staged as `R051` and passed the same way over live
`PID-5` / `PID-7` / `PID-3` values. `--no-renames` closes it with no work on the record shape: the
destination arrives as an ordinary single-path add and the source as a delete the filter already
drops, so the enumeration is a strict superset of the previous one and the two-field stride becomes
structural rather than conditional. Verified under `diff.renames` set to `true`, `copies`, `false`
and `1`, and under `diff.renameLimit=1`, so a caller's own configuration cannot reopen it.

A **regular blob staged at exactly a scan root** was in scope for the refusal and out of scope for
the read, so nothing looked at it and the scan exited 0 over the same three fields. Both read
predicates now admit the root's own path, and the entry is judged with that root's own limits: a
blob replacing the fixture root earns the structured scan, one replacing the source root keeps the
conservative pass. Admitting it to the read set alone was not enough, and a draft that stopped
there still reported clean.

A **walk root that is not a directory** threw `ENOTDIR` out of the directory read, uncaught, and an
uncaught throw exits 1, the code this gate reserves for "hits found", so it published a finding it
had never made. A dangling link at a root was the silent half: the existence check follows, so the
sweep reported OK over the whole corpus that root stood for. Both refuse now, naming the root and
its kind and never the link target, and no directory-read failure can leave the process any more.
A root that links to a directory is still followed, an absent root is still legitimate, and both
are pinned so that changing either stays a decision.

Also corrected: the changelog's unreleased preamble said the first pre-alpha release "will ship"
the surface below, which has been false since the package first published. It now states the
publish state without naming a version, because a number copied into prose goes stale on its own.

12 new cases, 9 of which run red against the previous scanner; the other three are deliberate
controls.
