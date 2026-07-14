---
id: tls
title: MLLPS / TLS
sidebar_position: 5
---

# MLLPS / TLS

`@cosyte/mllp` supports TLS-wrapped MLLP ("MLLPS") on both the client and the server, built on
Node's `node:tls` — no bundled TLS implementation, no extra dependency. This page covers enabling
TLS, mutual TLS (mTLS), the verification-on-by-default posture, bind safety, the TLS 1.2 floor, and
the typed failure modes.

Spec anchor: IHE ATNA, **ITI-19 Authenticate Node**
(https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2 Floor using BCP195"
option, ITI TF-2 §3.19.6.2.3.

## Enabling TLS

**Client** — pass `tls: true` for all-defaults (verification **on**), or a `TlsOptions` object to
customize:

```ts
import { createClient } from "@cosyte/mllp";

const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem }, // trust this CA; verification is on by default
});
await client.connect();
```

**Server** — `ServerOptions.tls` requires `cert` + `key`:

```ts
import { createServer } from "@cosyte/mllp";

const server = createServer({
  tls: { cert: certPem, key: keyPem },
});
await server.listen(2575, "127.0.0.1");
```

When TLS is configured, the server consumes `tls.Server`'s `'secureConnection'` event (post-handshake
sockets) instead of `net.Server`'s `'connection'`, and the client's `onConnect` transport hook maps
to `'secureConnect'` (handshake complete) rather than the raw TCP `'connect'`.

## Mutual TLS (mTLS)

`ServerTlsOptions.clientAuth` selects the ATNA ITI-19 mutual-authentication mode:

| `clientAuth` | Client certificate | Behavior |
|---|---|---|
| `'NONE'` (default) | Not requested | Standard server-authenticated TLS only. |
| `'WANT'` | Requested, not required | An absent or untrusted client cert does **not** reject the connection; the peer certificate (if any) is surfaced on the `'connection'` event as `peerCertificate`. |
| `'MUST'` | Requested and required | ATNA mutual node authentication. A missing or untrusted client certificate rejects the handshake; the server never accepts the connection. |

```ts
const server = createServer({
  tls: { cert: certPem, key: keyPem, ca: clientCaPem, clientAuth: "MUST" },
});
server.on("connection", ({ peerCertificate }) => {
  // { subjectCN, issuerCN, validTo, authorized } | null — content-free, never the full cert object
  if (peerCertificate !== null) logger.info({ clientCN: peerCertificate.subjectCN });
});
```

```ts
const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: serverCaPem, cert: clientCertPem, key: clientKeyPem },
});
```

The `'connection'` event's `peerCertificate` includes an `authorized` flag — whether the chain was
**verified** against `ServerTlsOptions.ca`. ⚠️ Under `'WANT'`, a peer certificate can be present yet
**unverified** (the connection is accepted regardless): never make authorization decisions on
`subjectCN` unless `authorized` is `true`. Under `'MUST'` an unverified certificate never reaches
the `'connection'` event, so `authorized` is always `true` there.

**A note on TLS 1.3 and client-certificate rejection (RFC 8446 §4.4.2).** Under TLS 1.3, a client's
own handshake — and therefore `connect()` resolving — can complete before a `clientAuth: 'MUST'`
server finishes validating the client's certificate. **`connect()` resolving does not guarantee the
server accepted your client certificate.** There is no synchronous signal at `'secureConnect'` time
that reveals this, and the server's rejection alert arrives one network round-trip later — no fixed
wait can close that gap on a real network. `@cosyte/mllp` handles it by **classification, not
timing**: the rejection surfaces moments later as a typed post-connect error (an `'error'` event
whose `MllpConnectionError.cause` carries the `ERR_SSL_*`/alert detail), and TLS-protocol-shaped
errors are classified **permanent** (see `isTlsProtocolError`) — an `autoReconnect` client will not
loop against a server that will always reject it. **ACK correlation remains the delivery
guarantee:** `send()` never resolves without its ACK, so a rejected session can never silently
"deliver" a message.

## Verification is on by default

Certificate verification defaults to **on** for every client connection — `tls: true` does not
relax it. The only opt-out is the explicit, loud `allowUnverified` flag:

```ts
const client = createClient({
  host: "127.0.0.1",
  port: 2575,
  tls: { allowUnverified: true }, // NEVER do this against an untrusted network
});
```

There is no raw `rejectUnauthorized` surface on `TlsOptions` — `allowUnverified` is the only door,
and it is loud by design. Every successful `secureConnect` on a connection configured this way
(the initial connect **and every reconnect**) both:

- emits a frozen `'securityWarning'` event: `{ code: 'MLLP_TLS_VERIFY_DISABLED', message, host, port, timestamp }`
- calls `process.emitWarning(message, { code: 'MLLP_TLS_VERIFY_DISABLED' })`

so an insecure connection cannot go unnoticed in logs, monitoring, or `--trace-warnings` output.

## Bind safety

Two independent hardening changes apply to **every** `MllpServer`, TLS or plaintext:

- **The default bind host is `'127.0.0.1'`**, not `'0.0.0.0'`. `listen(port)` with no host binds
  loopback only.
- **Binding a wildcard host requires an explicit opt-in — enforced against the OS-normalized
  bound address.** Literal wildcard spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`,
  `'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`) are rejected **before** binding. Spellings only the
  resolver can see (`'0'`, `'0.0'`, `'0x0.0.0.0'`, a hostname resolving to the unspecified
  address, …) are caught by a **post-bind check** on the address the OS actually bound
  (`server.address()`, always canonical): the just-bound server is closed immediately and
  `listen()` rejects with the same typed `MllpConnectionError` — no listening state is left
  behind, and no `'listening'` event is emitted. Whatever the spelling, a wildcard bind never
  survives without `ServerOptions.allowWildcardBind: true`:

```ts
await server.listen(2575, "0.0.0.0");
// rejects: MllpConnectionError — "refusing to bind wildcard host '0.0.0.0' —
// set ServerOptions.allowWildcardBind: true to bind all interfaces"
```

```ts
const server = createServer({ allowWildcardBind: true });
await server.listen(2575, "0.0.0.0"); // binds; also emits a securityWarning
```

When a wildcard host is actually bound, the server emits the same loud pair as the TLS
verification opt-out — a frozen `'securityWarning'` (`code: 'MLLP_BIND_ALL_INTERFACES'`) and
`process.emitWarning` — once, at `listen()` time.

`listen()` is also **single-flight**: a call while the server is already listening — or while
another `listen()` is still in flight — rejects with a typed `MllpConnectionError` rather than
racing the first call's post-bind safety checks. Call `close()` before re-listening; sequential
`listen()` → `close()` → `listen()` works. This is what makes the no-state/no-event invariant
above unconditional: no concurrent bind can ever record listening state for a socket the safety
check just closed.

## TLS 1.2 floor and cipher suites

`minVersion` defaults to `'TLSv1.2'` on both the client and the server — the IHE ATNA ITI-19 "STX:
TLS 1.2 Floor using BCP195" option (ITI TF-2 §3.19.6.2.3). `TlsOptions`/`ServerTlsOptions` only
accept `'TLSv1.2' | 'TLSv1.3'` for `minVersion`/`maxVersion` — TLS 1.0/1.1 are not expressible
through this API; the floor cannot be lowered by configuration.

ITI TF-2 §3.19.6.2.3 mandates four TLS 1.2 cipher suites:

- `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256`
- `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`
- `TLS_DHE_RSA_WITH_AES_256_GCM_SHA384`
- `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`

`@cosyte/mllp` does not bundle a cipher list — `ciphers` is unset by default, which means **Node's
compiled-in defaults**. Node's default TLS 1.2 cipher list already includes both mandated ECDHE
suites above. If your deployment requires the DHE suites specifically, or a stricter list, pass
`ciphers` (an OpenSSL cipher-list string) on either side.

## Typed failure modes

On the **initial `connect()` path**, TLS failures reject with `MllpConnectionError` carrying an
additive `connectionCause`. (Failures on the auto-reconnect path surface as raw socket errors —
the permanence classification below still applies to them, but they do not carry a
`connectionCause`; see Known limitations.)

- **`'tls-verify'`** — a certificate-verification failure: untrusted chain, expired/not-yet-valid
  certificate, hostname/SAN mismatch, revocation, and related codes (see
  `isTlsVerificationErrorCode`, also exported for callers who want the same classification).
  **Classified permanent** by `isTransientConnectionError` — an `autoReconnect` client will
  **not** loop into a misconfigured or MITM'd endpoint; the state machine goes straight to
  `CLOSED`.
- **`'tls-handshake'`** — a **TLS-protocol-shaped** handshake failure observed before
  `'secureConnect'`: `ERR_SSL_*` codes, `EPROTO`, or an OpenSSL alert-bearing error (protocol
  version mismatch, no shared cipher, a required mutual-TLS client certificate rejected by the
  server, …). The exact boundary is `isTlsProtocolError`, exported for callers who want the same
  classification. Like `'tls-verify'`, TLS-protocol-shaped errors are classified **permanent** for
  the reconnect classifier.
- **No `connectionCause`** — pure TCP-level failures (`ECONNREFUSED`, `ETIMEDOUT`,
  `EHOSTUNREACH`, a plain `ECONNRESET`, …) even on a TLS-configured connection. These carry the
  same shape as plaintext connect failures and stay **transient** — a network blip during a
  handshake still auto-heals.

```ts
try {
  await client.connect();
} catch (err) {
  if (err instanceof MllpConnectionError && err.connectionCause === "tls-verify") {
    // Do not retry blindly — this is a configuration or MITM problem, not a network blip.
  }
}
```

Server-side, a failed handshake (including a rejected client certificate under `clientAuth:
'MUST'`) never crashes the server and never stops it from serving other connections — it emits a
frozen `'tlsClientError'` event: `{ remoteAddress, remotePort, message, code, timestamp }`. Only
the error's message and code are surfaced — never payload bytes, never a certificate dump.

## Observability

`client.getStats().tls` and `server.getStats().tls` report whether TLS is configured.
`server.getStats().tlsClientErrorsTotal` counts `'tlsClientError'` events since `listen()`.

## Known limitations

- **No PKI or CA management.** `@cosyte/mllp` consumes PEM material you provide; it does not
  issue, rotate, or manage certificates.
- **No certificate rotation/reload.** Certificates are read once at `tls.connect`/
  `tls.createServer` construction time — restart the process to rotate.
- **No CRL/OCSP beyond Node's defaults.** Revocation checking is whatever `node:tls` does by
  default; there is no additional revocation-checking layer.
- **Cipher list is Node's compiled-in default** unless you pass `ciphers` explicitly — see
  "TLS 1.2 floor and cipher suites" above.
- **Reconnect-path errors do not yet carry `connectionCause`.** The `tls-verify`/`tls-handshake`
  labels are attached on the initial `connect()` path only; auto-reconnect failures surface as raw
  socket errors (their transient/permanent classification still applies).
