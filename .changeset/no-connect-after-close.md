---
"@cosyte/mllp": patch
---

`Connection.notifyConnect()` on a connection that was already closed kept it `CLOSED` and emitted
no `stateChange`, yet still emitted `'connect'` and recorded a peer address and connect time, so a
subscriber could count a connection that never opened. It now does nothing unless the connection is
`CONNECTING`: a closed connection emits nothing, and a connect reported twice emits `'connect'`
once.
