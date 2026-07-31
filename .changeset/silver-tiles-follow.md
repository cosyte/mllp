---
"@cosyte/mllp": patch
---

The README now opens with the Cosyte logo, which follows your system light or dark theme.

- The header is a picture element carrying a dark and a light cut of the logo, so a reader on a dark theme gets the dark one and everyone else gets the light one. The light cut is what renders on the npm page, which is correct there because that page has no dark mode.
- The heading and the summary line beneath the header are unchanged. The logo reads "Cosyte" rather than the package name, so it repeats neither of them.
- The text a screen reader announces for the header describes the logo itself, rather than the package summary that sits directly beneath it.

Note on the wording of this entry, recorded rather than changed silently. Its opening sentence said
the logo replaced "one fixed image", and a bullet described what that previous header image had
looked like. Both were removed because they are false from where a consumer stands: the last
published version carries no README image at all, so there is nothing this replaces. The banner they
referred to existed only inside the unreleased window, between two commits on `main`. The
companion entry in this release carries the rest of that record.
