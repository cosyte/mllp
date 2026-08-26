---
id: tls
title: MLLPS / TLS
sidebar_position: 5
---

# MLLPS / TLS

`@cosyte/mllp` supports TLS-wrapped MLLP ("MLLPS") on both the client and the server, built on
Node's `node:tls`: no bundled TLS implementation, no extra dependency. This page covers enabling
TLS, mutual TLS (mTLS), the verification-on-by-default posture, bind safety, the TLS 1.2 floor, and
the typed failure modes.

Spec anchor: IHE ATNA, **ITI-19 Authenticate Node**
(https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2 floor using BCP195 Option"
(ITI TF-2 §3.19.6.2.3), spelled here as the published text spells it. What this package supplies
against that option, and what stays yours, is declared on the
[Conformance statement](./conformance.md).

## Enabling TLS

**Client**: pass `tls: true` for all-defaults (verification **on**), or a `TlsOptions` object to
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

**Server**: `ServerOptions.tls` requires `cert` + `key`:

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
  // { subjectCN, issuerCN, validTo, authorized } | null, content-free, never the full cert object
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

The `'connection'` event's `peerCertificate` includes an `authorized` flag: whether the chain was
**verified** against `ServerTlsOptions.ca`. ⚠️ Under `'WANT'`, a peer certificate can be present yet
**unverified** (the connection is accepted regardless): never make authorization decisions on
`subjectCN` unless `authorized` is `true`. Under `'MUST'` an unverified certificate never reaches
the `'connection'` event, so `authorized` is always `true` there.

**A note on TLS 1.3 and client-certificate rejection (RFC 8446 §4.4.2).** Under TLS 1.3, a client's
own handshake (and therefore `connect()` resolving) can complete before a `clientAuth: 'MUST'`
server finishes validating the client's certificate. **`connect()` resolving does not guarantee the
server accepted your client certificate.** There is no synchronous signal at `'secureConnect'` time
that reveals this, and the server's rejection alert arrives one network round-trip later. No fixed
wait can close that gap on a real network. `@cosyte/mllp` handles it by **classification, not
timing**: the rejection surfaces moments later as a typed post-connect error (an `'error'` event
whose `MllpConnectionError.cause` carries the `ERR_SSL_*`/alert detail), and TLS-protocol-shaped
errors are classified **permanent** (see `isTlsProtocolError`). An `autoReconnect` client will not
loop against a server that will always reject it. **ACK correlation remains the delivery
guarantee:** `send()` never resolves without its ACK, so a rejected session can never silently
"deliver" a message.

## Verification is on by default

Certificate verification defaults to **on** for every client connection. `tls: true` does not
relax it. The only opt-out is the explicit, loud `allowUnverified` flag:

```ts
const client = createClient({
  host: "127.0.0.1",
  port: 2575,
  tls: { allowUnverified: true }, // NEVER do this against an untrusted network
});
```

There is no raw `rejectUnauthorized` surface on `TlsOptions`. `allowUnverified` is the only door,
and it is loud by design. Every successful `secureConnect` on a connection configured this way
(the initial connect **and every reconnect**) both:

- emits a frozen `'securityWarning'` event: `{ code: 'MLLP_TLS_VERIFY_DISABLED', message, host, port, timestamp }`
- calls `process.emitWarning(message, { code: 'MLLP_TLS_VERIFY_DISABLED' })`

so an insecure connection cannot go unnoticed in logs, monitoring, or `--trace-warnings` output.

## Bind safety

Two independent hardening changes apply to **every** `MllpServer`, TLS or plaintext:

- **The default bind host is `'127.0.0.1'`**, not `'0.0.0.0'`. `listen(port)` with no host binds
  loopback only.
- **Binding a wildcard host requires an explicit opt-in, enforced against the OS-normalized
  bound address.** Literal wildcard spellings (`'0.0.0.0'`, `'::'`, `''`, `'::0'`,
  `'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`) are rejected **before** binding. Spellings only the
  resolver can see (`'0'`, `'0.0'`, `'0x0.0.0.0'`, a hostname resolving to the unspecified
  address, …) are caught by a **post-bind check** on the address the OS actually bound
  (`server.address()`, always canonical): the just-bound server is closed immediately and
  `listen()` rejects with the same typed `MllpConnectionError`. No listening state is left
  behind, and no `'listening'` event is emitted. Whatever the spelling, a wildcard bind never
  survives without `ServerOptions.allowWildcardBind: true`:

```ts
await server.listen(2575, "0.0.0.0");
// rejects: MllpConnectionError, "refusing to bind wildcard host '0.0.0.0'.
// Set ServerOptions.allowWildcardBind: true to bind all interfaces"
```

```ts
const server = createServer({ allowWildcardBind: true });
await server.listen(2575, "0.0.0.0"); // binds; also emits a securityWarning
```

When a wildcard host is actually bound, the server emits the same loud pair as the TLS
verification opt-out: a frozen `'securityWarning'` (`code: 'MLLP_BIND_ALL_INTERFACES'`) and
`process.emitWarning`, once, at `listen()` time.

`listen()` is also **single-flight**: a call while the server is already listening (or while
another `listen()` is still in flight) rejects with a typed `MllpConnectionError` rather than
racing the first call's post-bind safety checks. Call `close()` before re-listening; sequential
`listen()` → `close()` → `listen()` works. This is what makes the no-state/no-event invariant
above unconditional: no concurrent bind can ever record listening state for a socket the safety
check just closed.

## TLS 1.2 floor and cipher suites

`minVersion` defaults to `'TLSv1.2'` on both the client and the server: the IHE ATNA ITI-19 "STX:
TLS 1.2 floor using BCP195 Option" (ITI TF-2 §3.19.6.2.3). `TlsOptions`/`ServerTlsOptions` only
accept `'TLSv1.2' | 'TLSv1.3'` for `minVersion`/`maxVersion`. TLS 1.0/1.1 are not expressible
through this API; the floor cannot be lowered by configuration.

ITI TF-2 §3.19.6.2.3 names four TLS 1.2 cipher suites an actor claiming the transport-security
option supports. They are listed here in both spellings that matter: the IANA spelling the standard
prints (and the one the `'tlsNegotiated'` event below reports), and the OpenSSL spelling a
cipher-list string is written in.

| IANA name (ITI TF-2 §3.19.6.2.3) | OpenSSL name |
|---|---|
| `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256` | `DHE-RSA-AES128-GCM-SHA256` |
| `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256` | `ECDHE-RSA-AES128-GCM-SHA256` |
| `TLS_DHE_RSA_WITH_AES_256_GCM_SHA384` | `DHE-RSA-AES256-GCM-SHA384` |
| `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` | `ECDHE-RSA-AES256-GCM-SHA384` |

### Selecting the option: `atnaTransportSecurity`

**Off by default.** With it off, `@cosyte/mllp` imposes no cipher list at all and the offered list
is the runtime's, which a Node distribution may configure at build time and an operator may replace
wholesale from outside the process (`--tls-cipher-list`, `NODE_OPTIONS`). What a link offers is then
a property of the deployment, not of this package.

Set `atnaTransportSecurity: true` on either side and the offered list becomes those four suites and
nothing else, from this package rather than from the runtime:

```ts
const server = createServer({
  tls: { cert: certPem, key: keyPem, atnaTransportSecurity: true },
});

const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem, atnaTransportSecurity: true },
});
```

```ts runnable
import { ATNA_CIPHER_SUITES, TLS13_DEFAULT_CIPHER_SUITES } from "@cosyte/mllp";

ATNA_CIPHER_SUITES.length; // => 4
TLS13_DEFAULT_CIPHER_SUITES.length; // => 3
```

Four things to know before you turn it on:

- **It only ever narrows what is offered, never widens it.** A peer that supports none of the four
  fails the handshake instead of negotiating something else. That is the point, and it is why the
  option is off by default: switching it on can stop a previously working link.
- **TLS 1.3 is unaffected.** A TLS 1.3 suite is enabled only by its full name in the cipher list, so
  a list holding the four TLS 1.2 suites alone would silently turn TLS 1.3 **off**. The three TLS
  1.3 suites the runtime enables by default (`TLS_AES_256_GCM_SHA384`,
  `TLS_CHACHA20_POLY1305_SHA256`, `TLS_AES_128_GCM_SHA256`) are therefore offered alongside the
  four. Two peers that reach TLS 1.3 without the option still reach TLS 1.3 with it.
- **The server also provides ephemeral Diffie-Hellman parameters.** Two of the four suites are DHE,
  and a server with no DH parameters cannot actually offer a DHE suite: it would advertise the list
  and then fail every DHE handshake in it.
- **It is mutually exclusive with `ciphers`.** Both declare the offered list, so setting both
  rejects `connect()` / `listen()` with a typed `MllpTlsConfigurationError` rather than silently
  discarding one of them.

`ciphers` (an OpenSSL cipher-list string) remains available on either side for a list of your own
choosing. A list the runtime rejects is a loud, typed failure at connect or listen time; it never
falls back to the runtime default list. See "Typed failure modes" below.

**What this does not do.** It is the **cipher-suite half** of the transport-security option. Mutual
node authentication is `clientAuth` plus a client `cert`/`key`, and the TLS 1.2 floor is
`minVersion`, which already defaults to it. Claiming an IHE option is your declaration to make about
your actor: this package can support it and evidence it, and cannot make it on anyone's behalf.

## Typed failure modes

On the **initial `connect()` path**, TLS failures reject with `MllpConnectionError` carrying an
additive `connectionCause`. (Failures on the auto-reconnect path surface as raw socket errors:
the permanence classification below still applies to them, but they do not carry a
`connectionCause`; see Known limitations.)

- **`'tls-verify'`**: a certificate-verification failure: untrusted chain, expired/not-yet-valid
  certificate, hostname/SAN mismatch, revocation, and related codes (see
  `isTlsVerificationErrorCode`, also exported for callers who want the same classification).
  **Classified permanent** by `isTransientConnectionError`. An `autoReconnect` client will
  **not** loop into a misconfigured or MITM'd endpoint; the state machine goes straight to
  `CLOSED`.
- **`'tls-handshake'`**: a **TLS-protocol-shaped** handshake failure observed before
  `'secureConnect'`: `ERR_SSL_*` codes, `EPROTO`, or an OpenSSL alert-bearing error (protocol
  version mismatch, no shared cipher, a required mutual-TLS client certificate rejected by the
  server, …). The exact boundary is `isTlsProtocolError`, exported for callers who want the same
  classification. Like `'tls-verify'`, TLS-protocol-shaped errors are classified **permanent** for
  the reconnect classifier.
- **No `connectionCause`**: pure TCP-level failures (`ECONNREFUSED`, `ETIMEDOUT`,
  `EHOSTUNREACH`, a plain `ECONNRESET`, …) even on a TLS-configured connection. These carry the
  same shape as plaintext connect failures and stay **transient**. A network blip during a
  handshake still auto-heals.

```ts
try {
  await client.connect();
} catch (err) {
  if (err instanceof MllpConnectionError && err.connectionCause === "tls-verify") {
    // Do not retry blindly. This is a configuration or MITM problem, not a network blip.
  }
}
```

Server-side, a failed handshake (including a rejected client certificate under `clientAuth:
'MUST'`) never crashes the server and never stops it from serving other connections. It emits a
frozen `'tlsClientError'` event: `{ remoteAddress, remotePort, message, code, timestamp }`. Only
the error's message and code are surfaced, never payload bytes, never a certificate dump.

### Cipher-suite configuration errors

A cipher-suite list this package cannot honour is refused **before** a socket exists, so nothing is
left connected and nothing is left bound. `connect()` and `listen()` reject with
`MllpTlsConfigurationError`, identified by `instanceof` plus a stable `code`, never by matching on
the message text:

| `code` | Meaning |
|---|---|
| `MLLP_TLS_CIPHER_LIST_REJECTED` | The TLS library refused the list: no suite in it is available in this build. There is **no fallback to the runtime default list**. |
| `MLLP_TLS_CIPHER_OPTION_CONFLICT` | `atnaTransportSecurity` and `ciphers` both declare the offered list. Set exactly one. |

```ts
try {
  await server.listen(2575);
} catch (err) {
  if (err instanceof MllpTlsConfigurationError && err.code === MLLP_TLS_CIPHER_LIST_REJECTED) {
    // A configuration problem, not a network one. Nothing is listening.
  }
}
```

The list is validated on its own, with no certificate, key or passphrase in scope, so the error
cannot carry credential material. Its `message` is a fixed registry entry per code. A server
constructed with a refused configuration stays refused: every `listen()` on it rejects the same way,
and it never serves on some other list.

## Observability

`client.getStats().tls` and `server.getStats().tls` report whether TLS is configured.
`server.getStats().tlsClientErrorsTotal` counts `'tlsClientError'` events since `listen()`.

### What each link actually negotiated

Both the client and the server emit a frozen `'tlsNegotiated'` event once per completed TLS
handshake, carrying the protocol version and cipher suite that link agreed on. That is what turns a
conformance claim into something a deployment can evidence from its own logs rather than assert.

```ts
client.on("tlsNegotiated", ({ protocolVersion, cipherSuite, host, port }) => {
  logger.info({ tls: protocolVersion, suite: cipherSuite, host, port });
  // e.g. { tls: 'TLSv1.2', suite: 'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256', ... }
});

server.on("tlsNegotiated", ({ protocolVersion, cipherSuite }) => {
  metrics.increment(`mllp.tls.${protocolVersion}.${cipherSuite}`);
});
```

- `protocolVersion`, as the TLS library reports it: `'TLSv1.2'` or `'TLSv1.3'`.
- `cipherSuite`, in its **IANA** spelling, the one ITI TF-2 §3.19.6.2.3 prints, so it compares
  against a conformance claim directly. The OpenSSL spelling is a different rendering of the same
  suite; see the table above.
- `host` / `port`, the same routing metadata a `'securityWarning'` carries: the target address for a
  client, the bound address for a server.
- `timestamp`, wall-clock time at emission.

It fires **once per connection**, on the initial connect and on every reconnect, so a log records
every session rather than only the first. It is **never** emitted for a plaintext connection: there
is nothing negotiated to report. It carries no HL7 payload content and no certificate or key
material, and it is emitted at handshake-completion time, before any HL7 byte has crossed the link.

## Known limitations

- **No PKI or CA management.** `@cosyte/mllp` consumes PEM material you provide; it does not
  issue, rotate, or manage certificates.
- **No certificate rotation/reload.** Certificates are read once at `tls.connect`/
  `tls.createServer` construction time. Restart the process to rotate.
- **No CRL/OCSP beyond Node's defaults.** Revocation checking is whatever `node:tls` does by
  default; there is no additional revocation-checking layer.
- **Claiming an IHE option stays your declaration to make.** `atnaTransportSecurity` fixes what a
  link offers and `'tlsNegotiated'` evidences what it agreed on, but the option is claimed by an
  actor, not by a transport library, and this package cannot make that claim on anyone's behalf.
- **With the option off, the cipher list is the runtime's**, and the runtime's is configurable at
  build time by a Node distribution and replaceable from outside the process. See
  "TLS 1.2 floor and cipher suites" above.
- **Reconnect-path errors do not yet carry `connectionCause`.** The `tls-verify`/`tls-handshake`
  labels are attached on the initial `connect()` path only; auto-reconnect failures surface as raw
  socket errors (their transient/permanent classification still applies).
