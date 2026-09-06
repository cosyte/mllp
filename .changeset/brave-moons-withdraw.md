---
"@cosyte/mllp": patch
---

`pnpm phi-scan` now refuses a run (exit 2) that withdrew a target it had enumerated, instead of reporting on the targets that were left.

`--allow-fixture <path>` used to subtract a path from the read set and let the scan carry on, so the same invocation over a corpus whose only violator had been withdrawn printed `OK, no hits` and exited 0. A scan that did not open a file has no clean verdict about it, which is the rule every other incompleteness in this scanner already follows: an unreadable tracked file, a non-regular entry, an unmerged path, an emptied walk root and an empty index all refuse. The bypass was the one route to a clean report that worked by not reading something, and it was the one a caller could take deliberately.

The refusal is printed after any hits found in the targets the run did read, so a real finding is never swallowed by it, and it exits 2 rather than 1, because 1 means "hits found" and an incomplete sweep makes no such claim. A run that passes no `--allow-fixture`, or one whose `--allow-fixture` matched no enumerated target, is unchanged: the tolerated mid-sweep vanish, the per-walk-root observed-nothing refusal, `--staged` and the index corpus all behave exactly as before. To keep a synthetic fixture passing, declare its identifiers in `scripts/phi-allow-list.txt`, which leaves the file scanned.

Also in this release: the advisory override for `js-yaml` widens to `>=4.0.0 <4.3.0` and resolves at `4.3.0`, matching the extended advisory range, and a `pnpm-workspace.yaml` declares a 24 hour publication cooldown (`minimumReleaseAge: 1440`) and a `no-downgrade` trust policy. Both settings postdate the pnpm this package pins, so they are declared now and take force when that pin is raised.

No runtime behaviour of this package changes. The framing, ACK, warning-code and TLS surfaces are untouched, `js-yaml` is reached only through development tooling, and nothing here alters what is published in `dist`.
