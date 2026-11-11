---
"@cosyte/mllp": patch
---

The TLS enforcement probes now run once per process instead of on every connect. A client with `atnaTransportSecurity` built five throwaway TLS contexts on each connect and each reconnect, and one with `ciphers` built one; now only the first connect in a process builds them, and every later connect, reconnect and server reads the result it found. A probe's input is a fixed value and the runtime does not change under a running process, so what is refused and what is accepted is unchanged. Nothing changes for a caller.
