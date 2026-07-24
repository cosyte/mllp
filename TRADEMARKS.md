# Trademarks

`@cosyte/mllp` is an independent open-source project. cosyte is **not affiliated with, endorsed by,
or sponsored by** any company named in this repository or its documentation.

## Why these names appear

This package names other systems in two places: to identify the engines its differential test
harness runs against, and to state plainly which engines it has **not** been verified against.

Every reference is **descriptive**: it identifies whose engine was tested against, or whose behaviour is explicitly not covered. Naming a system is the only way to say
whether a library works with it.

## How these names are used

This package has no vendor profile system. The names identify freely available software used for
interoperability testing, or appear in documentation recording the limits of that testing,
including an explicit statement that Epic and Cerner are **not** part of the harness.

## Names referenced

| Name | Where it appears |
| ---- | ---------------- |
| Mirth Connect, NextGen | Named as an engine in the differential test harness. |
| Google Cloud Healthcare | Named as an engine in the differential test harness (the MLLP adapter). |
| Epic, Cerner | Named in `docs-content/limitations.md` to record that this package is **not** differentially verified against them. |

All product names, logos, and brands are the property of their respective owners. Use of a name here
does not imply any affiliation with, or endorsement by, its owner. If you own one of these marks and
would like a reference changed, please open an issue.
