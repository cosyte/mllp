---
"@cosyte/mllp": patch
---

The published source maps carry the source as Prettier 3.9 formats it: four union types in `src/connection/connection.ts`, `src/connection/error.ts`, `src/differential/report.ts` and `src/server/server.ts` now sit on one line. The JavaScript and the type declarations are byte-identical to 0.1.4, so nothing a consumer calls or imports changes.
