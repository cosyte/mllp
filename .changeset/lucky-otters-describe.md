---
"@cosyte/mllp": patch
---

The published documentation set gains a page contract, a page for the testing surface, and a test that validates the set as a set.

**A new page: Testing & verification.** `@cosyte/mllp/testing` is one of three published subpaths and `runDifferential` is a root export, and neither had a page. The in-memory transport appeared as a seven-line aside on the entry page and one paragraph in the quickstart, with no sidebar entry of its own; the differential harness was documented only inside the troubleshooting page, so a shipped capability was reachable only from the page about what the package cannot do. Both now have one page covering them together, in the sidebar under Guides and linked from the entry page and the quickstart. It covers `InMemoryTransport.pair()`, the four conditions a pair can simulate (chunked reads through `split(n)`, backpressure through `pause()`/`resume()`, a one-sided reset through `destroy(reason)`, a graceful close through `close()`), driving a whole `Connection` over a pair with no network underneath, and the differential harness end to end: what a run sends, what the report carries, what it deliberately does not carry, and how to aim it safely. Two of its examples are executed against the built package on every test run.

**Every page now declares a description.** None of them did, so every page on the docs site rendered with no meta description. Each one now carries a description written for a reader deciding whether the page answers their question.

**The navigation order is fixed.** Three pages all declared position 1 and no page declared the last two, which left the rendered order of the entry page, the installation page and the quickstart to the theme's tie-break. Positions now ascend across the whole set in the order the sidebar lists it.

**Two broken cross-references are repaired.** A link on the acknowledgements page pointed at a same-page fragment whose heading lives on the limitations page, so it went nowhere; it now points at the page that defines it. The installation page's link to the quickstart was the one sibling link in the set written without its file extension; it now matches the rest.

**The release-status claim is stated once.** Where this package sits on its release ladder, and what that means for the stability of its public surface, was restated on two pages that could drift apart. It now lives on the limitations page alone, and the installation page links to it. No page other than the conformance statement carries a literal version, so a release has one line to move and no forgotten copy.

**The set is formatted, and validated.** `docs-content/` is now covered by this package's `format` and `format:check` scripts like every other prose surface here, so tables and emphasis are consistent across the set. A new test validates the set against a stated contract: every page carries the four required frontmatter fields and an id matching its filename, the sidebar and the files are a bijection with positions ascending from 1, every relative link resolves and every fragment names a heading that exists on the page it targets, in-set links are written `./<id>.md`, and no file carries an en dash or an em dash. Each check names the offending file or id when it fails.

No source changed. No public surface, warning code, option name, per-role default or conformance verdict moved, and the conformance statement's verdicts, tables and declared version are untouched.
