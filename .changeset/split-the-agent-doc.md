---
"@cosyte/mllp": patch
---

Split `CLAUDE.md` so it fits the agent-doc byte budget, without deleting a line. The PHI scanner rules, the three long engineering-guardrail sections and the standing disciplines moved whole into `documentation/phi-scan-rules.md`, `documentation/engineering-guardrails.md` and `documentation/standing-disciplines.md`, each unchanged and under the heading it already had; `CLAUDE.md` keeps every one of those headings above a pointer at the file that now carries the text. Contributor-facing only: no API, no behaviour, no dependency and no published file changes.
