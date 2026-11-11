---
"@cosyte/mllp": patch
---

`send(payload, { ackTimeoutMs })` now bounds that send's wait for its acknowledgment, as its name says. It used to bound only the wait for queue room under `onBackpressure: "wait"`, and the acknowledgment wait always ran on the client's `ackTimeoutMs`, so a send asking for 5 s waited the client's 30 s. A caller who passes a per-send `ackTimeoutMs` gets that bound now, shorter or longer than the client's; one who wanted the old behavior, the client-wide bound on the acknowledgment, drops the per-send option or passes the client's value. Under `onBackpressure: "wait"` it still bounds the wait for room too, and the acknowledgment wait starts afresh once the send is written. A send without the option behaves exactly as before.
