---
"@cosyte/mllp": patch
---

**`TlsOptions.pfx`**: a client now takes its mutual-TLS certificate and key as one PKCS#12 file's bytes, unlocked with `passphrase`, the same as a server's `ServerTlsOptions.pfx`. A file the TLS library cannot load (a wrong passphrase, not PKCS#12, or a legacy RC2-40 file that Node.js on OpenSSL 3 refuses) rejects `connect()` with `MllpTlsConfigurationError` and the code `MLLP_TLS_PFX_REJECTED` before a socket is opened, and the client does not retry it; the message names `tls.pfx` and never the file or the passphrase. A caller passing `cert` and `key` changes nothing.
