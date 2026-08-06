---
"@cosyte/mllp": patch
---

`CHANGELOG.md` ships inside the tarball and is now written by the release rather than by hand, so it stops describing this package's already-published code as unreleased and starts carrying a version heading for every release.

`.changeset/config.json` set `"changelog": false`, which is a legal value that makes Changesets bump
the version and write no changelog at all. So no release ever wrote a version heading here, and
nothing ever rolled `[Unreleased]` over. Every published version of this package carried a changelog
with **no version headings in it**: one `[Unreleased]` heading spanning the entire history, and a
preamble in the future tense about a release that had already gone out. `CHANGELOG.md` is listed in
`package.json` `files`, so that was text on the disk of everyone who installed the package, not
internal bookkeeping.

**The flag is what changed, not the prose.** Correcting the sentence by hand leaves the mechanism
that wrote it, and the next release drifts the same way. `changelog` now names the generator that
ships with Changesets, so a release writes its own version heading and its own entry from the
changesets it consumed, and **the changeset summary is now the changelog entry**. Nothing new is
depended on: the generator is an entry point of `@changesets/cli`, already a dev dependency.

**The file's shape changed with it, deliberately.** Changesets prepends a release by replacing the
first newline in the file, so exactly one line can sit above generated output. The hand-written
preamble sat on line 3, which means a release would have inserted itself between the heading and the
preamble and split the header in two. The hand-maintained history has therefore moved under a
`## Released before this file was generated` heading, with an accurate preamble in place of the old
one. Four pieces of hand-workflow scaffolding were dropped and no entry was reworded or re-sorted:
the `[Unreleased]` heading, its link definition at the foot of the file, and the two empty section
stubs waiting for the next hand-written entry. The history is left as it was written rather than
split into version sections, because the file never recorded which release any entry went out in
and that text is already on disk in published copies.

**The release's Prettier pass is turned off, and that is specific to this package.** Changesets runs
the document it writes through Prettier unless `"prettier": false` says otherwise. This repo's
markdown is deliberately not Prettier-managed: `.prettierignore` lists `*.md`, so the archived
history has never been Prettier-canonical, and leaving the pass on would not tidy it but would
rewrite already-published text on every release. Measured on this archive: emphasis markers, list
bullets and continuation indents all move, and one paragraph whose bold span contains an inline code
literal ending in `**` comes back with the spaces around that literal eaten, which is corruption
inside a shipped tarball rather than a formatting preference. A sibling package that does
Prettier-manage its markdown needs the opposite setting, so this is not a value to copy between
repos.

Pinned by `test/scripts/changelog-generation.test.ts`, which runs the real `changeset version`
against the real `CHANGELOG.md` and the real config in a throwaway package rather than
reimplementing where the tool inserts text, and which builds that config from the committed one so a
setting added later is exercised instead of silently diverging. Ten of its thirteen cases are red
against the previous state, measured on the tree this change was written against rather than
recalled. **The rule it enforces is that nothing but the H1 sits above the first heading, and it is
asserted on the released document as well as the committed one**: a rule phrased as "the archive
heading comes second" holds only until the first release writes its own version heading there, which
would have redded the first Version PR this configuration ever opened, and `prepublishOnly` runs the
same suite under `changeset publish`. Version headings are compared as whole headings and never as
substrings, which the suite demonstrates rather than asserts: on a released document whose only
version heading is `## 0.0.10`, a substring search for `## 0.0.1` answers yes to a heading that is
not there. Three controls: the same inputs with `"changelog": false` must write no version heading
at all, so the flag is proved load-bearing rather than incidental; the same inputs with the Prettier
pass back on must change the archived history, so that setting is proved load-bearing too; and the
old file shape must reproduce the split header, so the shape rule is demonstrated rather than
asserted.

One upstream behaviour is worth knowing before debugging a release, and is recorded in that file:
Changesets wraps the changelog write in a try/catch that only warns. A tree whose declared Prettier
config cannot be resolved bumps the version, consumes the changeset, and writes no changelog at all.
Reproduced here on this repo's inputs. A release that publishes with an unchanged changelog is that
failure, not a setting that quietly reverted.

`.changeset/README.md` said to keep the release notes in `CHANGELOG.md` by hand and now says to
write them in the changeset. No runtime code, no public API, no warning code, no framing or
transport behaviour changed.
