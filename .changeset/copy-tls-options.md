---
"@cosyte/mllp": patch
---

**The `tls` options are copied when a client or server is created.** Both kept the caller's `tls` object, and a client read it again on every connect and reconnect, so a `pfx` added to that object after construction reached the socket without the `MLLP_TLS_CREDENTIAL_CONFLICT` check and its certificate was presented in place of `cert`. Now `createClient`, `createServer` and both constructors take a copy (an array such as a `ca` list is copied too), check it, and use only it. A caller who changed their `tls` object, or put a new one in the options, to have a running client pick up new TLS settings must create a new client instead. The opening of the TLS section in the warning and error codes page now says that `MLLP_TLS_CREDENTIAL_CONFLICT` is thrown at creation rather than rejecting `connect()` or `listen()`.
