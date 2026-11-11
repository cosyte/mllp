---
"@cosyte/mllp": patch
---

A server can now bound how many connections it holds at once. New option `ServerOptions.maxConnections` (a positive integer; unset means no cap, the behaviour so far): a connection that arrives while the server already holds that many is closed at accept, before any byte is read and before any TLS handshake, and never reaches `onMessage` or the `'connection'` event. Each one is reported on the new `'connectionRejected'` event, a frozen `ConnectionRejectedEvent` carrying the new stable code `MLLP_CONNECTION_LIMIT_REACHED`, the cap and the peer's address and port. The count is of open sockets, so it bounds file descriptors. New exports: `MLLP_CONNECTION_LIMIT_REACHED` and the type `ConnectionRejectedEvent`. Nothing changes for a caller who does not set the option; a `maxConnections` that is not a positive integer throws a `RangeError` when the server is created.
