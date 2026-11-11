---
"@cosyte/mllp": patch
---

The client and the server now turn Nagle's algorithm off (TCP_NODELAY) on every socket they open or accept, plain and TLS, reconnects included. With it on, an ACK or a message written while an earlier one was still unacknowledged at the TCP level waited for the peer's delayed TCP acknowledgment, 40 ms on Linux, so on a link with irregular traffic some acknowledgments took up to about 40 ms longer than they needed to. A new `noDelay` option on `ClientOptions`, `StarterClientOptions` and `ServerOptions`, default `true`, sets it; pass `noDelay: false` to keep the operating system's default. Nothing else changes for a caller.
