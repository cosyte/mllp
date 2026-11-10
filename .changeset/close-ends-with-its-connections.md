---
"@cosyte/mllp": patch
---

`close()` now resolves as soon as its connections are gone. A second `MllpServer.close()` with a
shorter `drainTimeoutMs` already destroyed a straggling connection at its own deadline, but its
promise, and the first call's, stayed pending until the first call's longer drain timed out. The
same held for `Connection.close()`: a `destroy()` or a peer close during a slow drain ended the
connection at once, yet `close()` waited out the drain timeout anyway. Every pending `close()` now
resolves the moment its connection leaves `DRAINING`, by whatever route, so a shutdown with a short
budget ends within that budget.
