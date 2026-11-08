# Changesets

This folder is managed by [Changesets](https://github.com/changesets/changesets). Changesets drives
the **version bump**, the **publish**, and the **release section in `CHANGELOG.md`**: a release
writes its own version heading there from the changesets it consumed. So **the changeset summary is
the changelog entry**. Write it there and do not hand-edit `CHANGELOG.md`, whose sections above
`## Released before this file was generated` are generated output.

Add a changeset for every meaningful change:

```bash
pnpm changeset
```

Every changeset is a **patch**, whatever the change: a fix, documentation, contributor-only
tooling, or a new export, option, event, stable code or artifact a consumer can use. We decided on
2026-11-07 that our versions move by patch only until we say otherwise, so a minor or a major waits
for the maintainer's explicit okay. The summary carries what the number no longer does: say what a
consumer gains, and spell out any break, because on a `0.x` release the version alone tells a
consumer nothing.

Once a minor is approved, the ladder is the one this file used to state: **minor** for anything a
consumer gains (a newly exported symbol, a new option, a new event, a new stable code, or a new
published artifact), **patch** for a fix, for documentation of a surface that already ships, and for
contributor-only tooling, and **major** only to declare `1.0.0`.

The standards every Cosyte repository follows are in `plans/standards.md` in the umbrella repository.
