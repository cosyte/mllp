---
"@cosyte/mllp": patch
---

The README now opens with the shared Cosyte logo, which follows your system light or dark theme instead of being one fixed image.

- The previous header image baked the package name and its one line summary into the artwork, so the same two strings appeared three times in the first four lines of the page. The heading and the summary line beneath it are unchanged, so only the duplicated pixels are gone.
- The header is now a picture element with a dark and a light cut of the logo, so a reader on a dark theme gets the dark one and everyone else gets the light one. The light cut is what renders on the npm page, which is correct there because that page has no dark mode.
- The text a screen reader announces for the header now describes the logo itself, rather than repeating the package summary that sits directly beneath it.
