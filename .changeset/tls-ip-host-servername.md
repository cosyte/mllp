---
"@cosyte/mllp": patch
---

A TLS client whose host is an IP address now connects on Node 26.

The client passed its host to `tls.connect` as the SNI server name, and Node 26 throws `ERR_INVALID_ARG_VALUE` for an IP address there (RFC 6066 allows only host names). An IP address, whether it is the host or a configured `servername`, is no longer sent as SNI, and the server certificate is still checked against it. A host name is sent as SNI as before.
