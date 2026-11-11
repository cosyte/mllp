---
"@cosyte/mllp": patch
---

Two additions an engine in front of this package needs to pass through.

- **`ServerTlsOptions.pfx`** takes a PKCS#12 file's bytes in place of `cert` and `key`, unlocked with `passphrase`. A file the TLS library cannot load (a wrong passphrase, not PKCS#12, or a legacy RC2-40 file that Node.js on OpenSSL 3 refuses) rejects `listen()` with `MllpTlsConfigurationError` and the new code `MLLP_TLS_PFX_REJECTED`, before anything is bound; the message names `tls.pfx` and never the file or the passphrase. `ServerTlsOptions.cert` and `key` are now optional in the type, since `pfx` can stand in for them; a server given neither pair nor file now throws a `TypeError` when it is created, where before it was refused by the type and failed every handshake if the type was bypassed. A caller passing `cert` and `key` changes nothing.
- **`selectAckCode({ msh15, msh16, outcome })`** returns the acknowledgement code to send, by the same table the server's auto-ACK uses: the accept-mode `CA`/`CE`/`CR` where MSH-15 asks for an accept acknowledgement on that outcome, the outcome itself otherwise. It also reports the mode, whether MSH-16 asks for an application acknowledgement, and whether either field held a value outside Table 0155. New types `AckCodeSelection` and `AckCodeSelectionInput`.
