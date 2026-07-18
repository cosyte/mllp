---
"@cosyte/mllp": patch
---

Add a repo-side PHI commit-scanner (`scripts/phi-scan.ts`), matching the `@cosyte/hl7`
pilot.

mllp is a transport that carries HL7 v2 payloads (MLLP wraps HL7 in `VT … FS CR`), so its
data fixtures (`test/**` `.frame.bin` frames) contain the SAME PHI shapes hl7's do. The
scanner is a direct port of hl7's HL7 v2 segment/field-position-aware detector — patient /
provider names (XPN/XCN), date of birth (PID-7/NK1-16), SSN (PID-19 + CX `SS`-typed + dashed
anywhere), MRN / account (bare-numeric CX), address (XAD), phone (non-`555`), email, and a
site-defined `Z…`-segment name backstop — with ONE transport-layer addition: it **unwraps the
MLLP frame** (strips the `VT` start-block and trailing `FS CR` end-block) before the HL7-aware
scan, so the framing bytes cannot defeat delimiter/segment detection. A framed fixture's HL7
payload gets exactly the scan an un-framed `.hl7` file would; malformed frames (missing
end-block, double-framing) cannot bypass it because the unwrap only ever removes framing bytes,
never gates the scan on their presence.

Anything not covered by the synthetic allow-list (`scripts/phi-allow-list.txt`) is a hit.
Non-HL7 binary byte/buffer fixtures fall through to a conservative dashed-SSN + email shape
pass — no crash, no false positive. Wired exactly like hl7: `pnpm phi-scan`, a
`simple-git-hooks` `pre-commit` running `phi-scan --staged`, and `run-phi-scan: true` on the CI
caller. `scripts/verify.sh` runs it as part of the standard gate. Adds `phi-scan-overrides.md`
(the audited `--allow-fixture` bypass log) and `test/scripts/phi-scan.test.ts` (proves it
catches real-looking PHI inside a framed payload and passes the synthetic corpus).

Tooling / safety only — no runtime or public-API change.
