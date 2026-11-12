---
"@cosyte/mllp": patch
---

**`pfx` together with `cert` or `key` is now refused.** A client or server given a PKCS#12 file in `tls.pfx` and also `tls.cert` or `tls.key` used to be accepted, and Node.js loaded the file last, so the file's certificate was presented and the `cert` passed went unused with nothing to say so. Now `createClient`, `createServer` and both constructors throw `MllpTlsConfigurationError` with the new stable code `MLLP_TLS_CREDENTIAL_CONFLICT`; the message names the options and never their values. A caller passing all three must drop either `pfx` or the `cert` and `key` pair. The `MLLP_TLS_PFX_REJECTED` message now ends with "no socket was opened" rather than "nothing was bound", so it reads right when a client raises it.
