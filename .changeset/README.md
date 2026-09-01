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

Pick the bump type from what the change does to the published package. On the `0.1.x` ladder:

- **minor** for anything a consumer gains: a newly exported symbol, a new option, a new event, a
  new stable code, or a new published artifact they can use. It takes `0.1.x` to `0.2.0`.
- **patch** for a fix, for documentation of a surface that already ships, and for contributor-only
  tooling. It takes `0.1.x` to `0.1.1`.
- **major** only when you mean to declare `1.0.0`. Before that, a breaking change is a **minor**,
  and the break has to be spelled out in the summary, because the number alone tells a consumer on
  a `0.x` release nothing.

See the cosyte version ladder in the meta-repo's `documentation/conventions.md`.
