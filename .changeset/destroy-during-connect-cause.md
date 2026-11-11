---
"@cosyte/mllp": patch
---

The reference now says what `connect()` rejects with when `destroy()` runs while it is still connecting, and how long a TLS server waits for a handshake. Over TCP or TLS, before or during the handshake, `connect()` rejects with an `MllpConnectionError` whose `phase` is `connect`; its `cause` is the reason passed to `destroy(reason)`, or with no reason an `Error` whose message is `closed before connect`, and it carries no `connectionCause`. A TLS server sets no handshake time limit of its own: on Node.js the runtime's 120 second default applies, after which the socket is closed and `'tlsClientError'` fires with code `ERR_TLS_HANDSHAKE_TIMEOUT`. Until then such a connection holds a `maxConnections` place, and `deadPeerTimeoutMs` does not cover it. Nothing changes in behaviour, so a caller changes nothing.
