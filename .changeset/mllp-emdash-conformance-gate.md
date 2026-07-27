---
"@cosyte/mllp": patch
---

Add the em-dash brand gate: `scripts/check-no-emdash.sh` (`pnpm check:no-emdash`) plus
`.github/workflows/no-emdash.yml`.

The founder directive written down in `knowledgebase/06-brand/voice-and-tone.md` ("No em dashes.
Ever.") bans `U+2014` outright across every cosyte surface and names commit messages explicitly,
and the meta-repo's `documentation/conventions.md` has claimed the rule is CI-gated since it was
written. This is the CI half of that rule for mllp. It scans BOTH halves: every tracked file, and
the PR title, body, and commit messages, the latter on the non-default `edited` activity type so
retitling a PR re-checks it. It is its own workflow rather than a job in `ci.yml` because `edited`
would otherwise re-run the whole Node 22 + 24 matrix every time someone fixes a typo in a PR
description.

mllp was already clean when this landed, and the measurement is the whole tree: all 152 tracked
files read byte by byte, zero `U+2014` in any form, literal or encoded. That distinction is the
point, because a markdown-only count is exactly what wrongly cleared `dicom`, which turned out to
carry six live em dashes in four non-markdown files. So this gate changed no content and exists
purely to stop a regression.

The script is composed from three sibling copies rather than taken from one. `website`'s
NUL-exclusion shape is the base: a file containing a NUL byte is excluded by an explicit,
reviewable rule and everything else is scanned without `grep -I`. That is what this repo needs,
because it tracks one binary (`vendor/cosyte-hl7-0.0.0.tgz`, the packed `@cosyte/hl7`
devDependency). The tarball does not contain the em dash byte sequence today, so the text-only
shape the other parsers run would pass over it right now; the reason to reject that shape is
durability, since a compressed stream can contain those three bytes by coincidence and the next
hand re-vendor could produce a red with no remediation available. On top of that base go `ncpdp`'s
two route fixes (a tracked file named exactly `-` was read by grep as standard input and never
opened, so the gate printed OK over a live em dash; `-d skip` silently passed a tracked symlink to
a directory) and `dicom`'s binary-match diagnostic branch, so a red caused by a match inside input
grep reads as binary names the real cause instead of blaming an I/O failure that did not happen.

The disclosed cost of the NUL exclusion is stated rather than buried: a tracked TEXT file holding
a NUL byte would also be silently exempt. mllp has none today, so the exclusion currently exempts
exactly one file and that file is a genuine binary. Seeding the real tarball with a live em dash
leaves this gate green, which is a miss and is written down as one. The at-risk fixture class is
not hypothetical: `git ls-files --eol` calls four files binary, the tarball plus the three
`test/differential/fixtures/*.frame.bin` captures (lone-CR HL7 v2 framing, no NUL). Those three
stay in scope, and each was seeded with a live em dash in turn to prove the gate genuinely reads
them rather than assuming it.

Every route by which the scan could report green without having read its input was checked red
with a seeded fixture, not assumed: a corrupt git index, an unreadable tracked file, a tracked
file named `-q`, a C-quoted non-ASCII path, a mis-encoded text file, an empty file list, a tracked
file named `-`, and a tracked symlink to a directory.

Tooling / brand only: no runtime, public-API, or wire-behaviour change.
