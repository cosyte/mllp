---
"@cosyte/mllp": patch
---

Documentation: remove internal project bookkeeping from every surface a consumer reads, and correct three statements that no longer matched the code.

The JSDoc compiled into the type declarations, which is what an editor renders on hover for all three entry points (`@cosyte/mllp`, `/testing`, `/ack-from-hl7`), no longer carries internal item identifiers or phase and plan language. Two published documentation pages lost internal case identifiers for the same reason.

Three doc comments were also factually wrong and are fixed. The `'reconnecting'` payload was documented as carrying `connectionId` only; `MllpClient` populates `attempt` and `delayMs` when it schedules a reconnect. `MllpServer.getStats()` does aggregate `totalBytesIn` and `totalBytesOut` across live connections; it was documented as returning 0. `createStarterServer` is fully implemented; it was documented as a stub. The `createClient` examples now show the `send()` call they previously described as unavailable. `Connection.beforeClose` no longer says the server and client register drain logic through it, which neither does. The installation page pinned a published version number that was two releases stale; it no longer pins one.
