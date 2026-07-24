# phi-scan bypass log

This file logs every `--allow-fixture <path>` bypass invocation of
`scripts/phi-scan.ts`. The scanner refuses to honor a `--allow-fixture <path>`
flag UNLESS this file contains an entry referencing the same path. The committed
log is intentionally annoying. It discourages bypass and creates an audit
trail. Prefer extending `scripts/phi-allow-list.txt` (a token-level, reviewed
declaration) over a whole-file bypass.

## How the scanner detects PHI

mllp is a TRANSPORT / framing library: it wraps HL7 v2 messages in MLLP frames
(`VT 0x0B + payload + FS 0x1C + CR 0x0D`). Its data fixtures are MLLP-framed HL7
v2 messages (`test/**/*.frame.bin`), so the PHI shapes inside them are IDENTICAL
to `@cosyte/hl7`'s. `scripts/phi-scan.ts` is therefore a direct port of hl7's
segment/field-position-aware detector, with **one transport-layer addition**: it
**unwraps the MLLP frame** (strips the leading `VT` start-block(s) and the
trailing `FS CR` end-block) BEFORE the HL7-aware scan (`unwrapMllpFrame`). A
framed fixture's HL7 payload then gets exactly the scan an un-framed `.hl7` file
would; the framing bytes cannot defeat delimiter/segment detection.

The unwrap only ever REMOVES framing bytes, never gates the scan on their
presence, so malformed frames cannot bypass detection:

- **Missing end-block** (`VT + payload`, no `FS CR`): the `VT` is stripped and
  the payload is still scanned.
- **Double-framing** (two leading `VT`s, or a trailing `FS CR FS CR`): all
  leading `VT`s are stripped and the outer `FS CR` removed; any residual
  mid-payload `FS`/`VT` byte clings to at most one field of one segment (segments
  are split on `CR`/`LF`), while every other field is still scanned.

After the unwrap, the scanner reads the message delimiters from `MSH-1` / `MSH-2`
(defaulting to `|^~\&` for a header-less message), splits segments → fields →
repetitions → components, and inspects only the fields that actually carry each
PHI category. A naive `Family^Given` text regex is deliberately NOT used. It
trips on coded values like `CBC^Complete Blood Count^LN` or `Boston^MA`, which
would be false confidence, not safety.

Two properties keep the structured scan from being silently bypassed (both were
caught by the conformance-refuter on the hl7 pilot and inherited here): a
**header-less** fixture (first segment not `MSH`) still gets the full structured
scan: any fixture-like file with a recognizable segment line is parsed, not just
one whose first byte is `MSH`; and segment ids are matched **case-insensitively**
(`pid` is normalized to `PID`), because the lenient parser accepts lowercase
segment ids and the scanner must not go blind where the parser stays tolerant.

Scope: `all`-mode sweeps EVERY data file under `test/` EXCEPT `.ts` sources (and
`.md` docs), plus all of `src/`. Test `.ts` SOURCES are deliberately excluded:
they carry intentional violator literals for the positive tests, so sweeping them
would be self-defeating (the hl7 pilot excludes test `.ts` for the same reason).
Every other `test/` file is dispatched by `looksLikeHl7`: a file that contains a
recognizable HL7 segment line after MLLP unwrap, whether a `.frame.bin` frame, a `.hl7`
file, OR a `.txt` / `.json` / extensionless live-adapter capture (the differential
README tells developers to drop real captures under
`test/differential/fixtures/`), gets the full STRUCTURED scan; a genuinely
non-HL7 binary blob falls through to the conservative dashed-SSN + email pass: no
crash, no binary-noise false positive. `src/` gets the conservative pass only.
It is hand-written code, and its `@example` HL7 snippets must not be parsed as
HL7. A real SSN/email committed in `src/` code is still caught there. This
extension-agnostic `test/` rule is deliberate: an earlier version restricted the
sweep to a `.bin` / `.hl7` allow-list, which silently dropped `.txt` /
extensionless captures from ALL scanning: the exact false negative this gate
exists to stop (caught by the conformance-refuter).

| Category                     | Where it looks                                                                                                                                                                                                   | Rule                                                                                                                                                                                                                                             |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Patient / person names       | PID-5/-6/-9, NK1-2/-30, GT1-3, IN1-16, MRG-7, STF-3 (XPN comp1-3); PV1-7/-8/-9/-17/-52, PD1-4, ORC-10/-11/-12/-19, OBR-10/-16/-28/-32..35, OBX-16/-25, DG1-16, PR1-11, AIP-3, TXA-9/-10/-11, ROL-4 (XCN comp2-4) | each significant name token must be in the `NAME` allow-list (case-insensitive). Single Latin initials are skipped; single CJK ideographs are kept (Chinese/Korean surnames are one character); HL7 degree/suffix codes (MD, JR, …) are ignored. |
| Date of birth                | PID-7, NK1-16                                                                                                                                                                                                    | the normalized `YYYYMMDD` / `YYYYMM` / `YYYY` (DTM precision) must be in the `DOB` allow-list. A DOB is indistinguishable from a real one by shape, so the allow-list is the only sound gate.                                                     |
| SSN                          | PID-19 (ST 9-digit); PID-3/-18 CX with identifier-type `SS`/`SSN`; dashed `\d{3}-\d{2}-\d{4}` anywhere                                                                                                           | a 9-digit SSN-shaped value must be in the `ID` allow-list; a dashed SSN anywhere is always a hit.                                                                                                                                                |
| MRN / account                | PID-3, PID-18 (CX comp1)                                                                                                                                                                                         | a bare 6-9 digit identifier is a real-looking MRN/account (or a misfiled SSN) and must be in the `ID` allow-list. Synthetic fixtures use prefixed shapes (`MRN…`, `ACCT…`, `FAKE…`) or the reserved `900000000` range, which pass once listed.    |
| Address                      | PID-11, NK1-4, GT1-5, IN1-19 (XAD comp1)                                                                                                                                                                         | a `<number> <word>` street line must be in the `ADDR` allow-list.                                                                                                                                                                                |
| Phone                        | PID-13/-14, NK1-5/-6/-7, GT1-6/-7 (XTN)                                                                                                                                                                          | a ≥10-digit number lacking the `555` fake-exchange convention is a hit.                                                                                                                                                                          |
| Email                        | anywhere (post-unwrap)                                                                                                                                                                                           | an email whose domain is not an `EMAILDOMAIN` (reserved/test) domain is a hit.                                                                                                                                                                   |
| Site-defined (`Z…`) segments | every field                                                                                                                                                                                                      | backstop: an adjacent pair of single-token name-shaped components (`Johnson^Maya`) whose tokens are not allow-listed. Runs ONLY on segments outside the known-segment set, so coded triples in `OBX`/`OBR` are not misread as names.             |

## Documented limitations (inherited from the hl7 pilot)

- **Free-text names.** OBX-5 / NTE narrative is scanned for identifier _shapes_
  (dashed SSN, email) but NOT for free-text personal names. A name in prose is
  not reliably separable from clinical vocabulary without NLP. Structured name
  fields (the table above) are the hard gate.
- **MRN heuristic is shape-based.** A synthetic MRN that is a bare 6-9 digit
  number is flagged until allow-listed, intentional (bare numerics are the
  real-MRN shape). A real but _alphanumeric_ MRN (e.g. `H0034521`) is not
  distinguishable from a synthetic prefixed id and is not flagged. The name /
  DOB / SSN gates are the backstop for a real message committed by mistake.
- **Phone `555` accept rule.** A ≥10-digit number containing `555` anywhere is
  treated as the fictional-exchange convention and accepted. A real DID
  containing `555` would pass; the synthetic corpus uses `555` numbers.
- **Name-component positions.** The name detectors read the standard XPN
  (family=comp1) / XCN (family=comp2) component positions across the field map
  above. A name in a non-standard slot, or in a name-bearing field not in the
  map, can be missed.
- **Common-name masking (residual, inherent).** The `NAME` allow-list contains
  common real surnames/givens the synthetic corpus uses (SMITH, JONES, DOE,
  JOHN, JANE, …). A real patient whose name is entirely common allow-listed
  tokens is invisible to the name detector: a structural consequence of a token
  allow-list. The DOB / SSN / MRN / address gates remain the backstop.
- **Un-framed vs framed parity.** The scanner treats a framed `.frame.bin` and a
  bare `.hl7` file identically after `unwrapMllpFrame`, and any `test/` data file
  (whatever its extension, `.ts` excepted) containing a recognizable HL7 segment
  line earns that same structured scan, so a real capture saved as `.txt` /
  `.json` / extensionless is scanned, not silently skipped. Only a `test/` file
  with no HL7 segment line at all (a genuinely non-HL7 blob) is limited to the
  conservative dashed-SSN + email pass.

## Format

Each entry is a markdown subsection:

```
### <path>

- **Date:** <YYYY-MM-DD>
- **Reason:** <one-line justification>
- **Approved by:** <committer name>
- **Expires:** <YYYY-MM-DD or "permanent">
```

## Entries

(none yet)
