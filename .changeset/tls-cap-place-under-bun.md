---
"@cosyte/mllp": patch
---

Under Bun, a TLS server with `maxConnections` now gives a connection's place back when that connection closes. Bun hands the server's accept and secure-connection events the same socket object, and the transport that took the socket over removed the listener that counted its close, so every TLS connection that completed a handshake held its place for good: once `maxConnections` had been reached, the server closed every new connection at accept. Node.js and Deno were not affected, and plaintext servers were not affected on any runtime. Nothing changes for a caller.
