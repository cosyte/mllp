---
id: tls
title: Secure a link with TLS
sidebar_label: Secure a link with TLS
description: "Run MLLP over TLS on the client and the server: verification, mutual TLS, bind safety, the TLS 1.2 floor and cipher suites, and the typed failures."
---

# Secure a link with TLS

`@cosyte/mllp` supports TLS-wrapped MLLP ("MLLPS") on both the client and the server, built on
Node's `node:tls`: no bundled TLS implementation, no extra dependency. This guide covers enabling
TLS, mutual TLS (mTLS), the verification-on-by-default posture, bind safety, the TLS 1.2 floor, and
the typed failure modes.

The samples that open a TLS link need certificate and key material of your own (PEM text in
variables such as `caPem`, `certPem` and `keyPem`), so they are shown and not run; the ones that
need none run in our tests. The reference entries used here are
[`TlsOptions`](./api/src.md#tlsoptions), [`ServerTlsOptions`](./api/src.md#servertlsoptions),
[`MllpConnectionError`](./api/src.md#mllpconnectionerror),
[`MllpTlsConfigurationError`](./api/src.md#mllptlsconfigurationerror) and
[`ATNA_CIPHER_SUITES`](./api/src.md#atna_cipher_suites); every code is listed in
[Warning and error codes](./warning-and-error-codes.md#tls-and-bind-codes).

Spec anchor: IHE ATNA, **ITI-19 Authenticate Node**
(https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2 floor using BCP195 Option"
(ITI TF-2 §3.19.6.2.3), spelled here as the published text spells it. What this package supplies
against that option, and what stays yours, is declared on the
[Conformance statement](./conformance.md).

## Enabling TLS

**Client**: pass `tls: true` for all-defaults (verification **on**), or a `TlsOptions` object to
customize:

```ts no-run needs a TLS server and its certificate authority
import { createClient } from "@cosyte/mllp";

const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem }, // trust this CA; verification is on by default
});
await client.connect();
```

**Server**: `ServerOptions.tls` requires `cert` + `key`, or a PKCS#12 file in `pfx` (below):

```ts no-run needs a certificate and key of your own
import { createServer } from "@cosyte/mllp";

const server = createServer({
  tls: { cert: certPem, key: keyPem },
});
await server.listen(2575, "127.0.0.1");
```

### A PKCS#12 file: `pfx`

A certificate and its key often arrive as one PKCS#12 file (`.pfx` or `.p12`), the form Windows and
many certificate authorities export. Pass its bytes as `pfx`, with `passphrase` to unlock it, in
place of `cert` and `key`: to a server for its own certificate, or to a client for the certificate
it presents under mutual TLS.

```ts no-run needs a PKCS#12 file of your own
import { readFileSync } from "node:fs";
import { createServer } from "@cosyte/mllp";

const server = createServer({
  tls: { pfx: readFileSync("server.pfx"), passphrase: process.env.PFX_PASSPHRASE },
});
await server.listen(2575, "127.0.0.1");
```

The file is loaded before anything is bound. If the TLS library cannot load it, `listen()` rejects
with `MllpTlsConfigurationError` and the code `MLLP_TLS_PFX_REJECTED`; its message names `tls.pfx` and never the file or the passphrase, and the
library's own error is the `cause`. Three things cause it: a wrong passphrase, bytes that are not
PKCS#12, or a **legacy encryption**. A file written by `openssl pkcs12 -export -legacy`, by OpenSSL
1.x, or by an older Windows export protects its certificates with RC2-40, and Node.js runs OpenSSL 3
without the legacy provider that holds RC2, so it refuses the file. Re-export it with AES-256, which
`openssl pkcs12 -export` on OpenSSL 3 uses by default. A server refused this way stays refused:
every `listen()` on it rejects the same way.

On a client the file is loaded before a socket is opened, and a file that cannot be loaded rejects
`connect()` with the same error and code. The refusal is permanent, so a client does not retry it.

```ts no-run needs a PKCS#12 file and a TLS server of your own
import { readFileSync } from "node:fs";
import { createClient } from "@cosyte/mllp";

const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: caPem, pfx: readFileSync("client.pfx"), passphrase: process.env.PFX_PASSPHRASE },
});
await client.connect();
```

A server given neither `cert` and `key` nor `pfx` throws a `TypeError` when it is created.

Pass `cert` and `key`, or `pfx`, never both. Node.js loads a PKCS#12 file after the PEM pair, so
the file's certificate would be presented and the `cert` you passed would go unused. A client or a
server given `pfx` together with `cert` or `key` throws `MllpTlsConfigurationError` with the code
`MLLP_TLS_CREDENTIAL_CONFLICT` when it is created; its message names the options and never their
values. Before this check a mixed configuration was accepted, so code that passed all three must
now drop either `pfx` or the `cert` and `key` pair.

A client or a server copies its `tls` options when it is created, and the check above runs on that
copy. A change you make to your `tls` object afterwards, or a new object you put in your options'
`tls`, has no effect: a client reconnects with the options it was created with. To connect with
different TLS options, create a new client.

When TLS is configured, the server consumes `tls.Server`'s `'secureConnection'` event (post-handshake
sockets) instead of `net.Server`'s `'connection'`, and the client's `onConnect` transport hook maps
to `'secureConnect'` (handshake complete) rather than the raw TCP `'connect'`.

The server sets no handshake time limit of its own; the runtime's applies. On Node.js that is the
`handshakeTimeout` default of `tls.createServer`, 120 seconds: a peer that connects and never
completes the handshake is closed then, and the server emits `'tlsClientError'` with code
`ERR_TLS_HANDSHAKE_TIMEOUT`. Until then that connection holds a `maxConnections` place, and
`deadPeerTimeoutMs` does not cover it, because that timer starts only once a connection is accepted
after its handshake. We have not measured what bounds a handshake on Bun or Deno, which may set
no limit at all.

## Mutual TLS (mTLS)

`ServerTlsOptions.clientAuth` selects the ATNA ITI-19 mutual-authentication mode:

| `clientAuth`       | Client certificate      | Behavior                                                                                                                                                           |
| ------------------ | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `'NONE'` (default) | Not requested           | Standard server-authenticated TLS only.                                                                                                                            |
| `'WANT'`           | Requested, not required | An absent or untrusted client cert does **not** reject the connection; the peer certificate (if any) is surfaced on the `'connection'` event as `peerCertificate`. |
| `'MUST'`           | Requested and required  | ATNA mutual node authentication. A missing or untrusted client certificate rejects the handshake; the server never accepts the connection.                         |

```ts no-run needs a certificate, a key and a client certificate authority of your own
const server = createServer({
  tls: { cert: certPem, key: keyPem, ca: clientCaPem, clientAuth: "MUST" },
});
server.on("connection", ({ peerCertificate }) => {
  // { subjectCN, issuerCN, validTo, authorized } | null, content-free, never the full cert object
  if (peerCertificate !== null) logger.info({ clientCN: peerCertificate.subjectCN });
});
```

```ts no-run needs a TLS server, a client certificate and keys of your own
const client = createClient({
  host: "mllp.example.com",
  port: 2575,
  tls: { ca: serverCaPem, cert: clientCertPem, key: clientKeyPem },
});
```

A client whose certificate and key arrive as one PKCS#12 file passes it as `pfx` instead: see
[A PKCS#12 file](#a-pkcs12-file-pfx).

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

```ts no-run turns certificate verification off; never point it at an untrusted network
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

```ts runnable
import { createServer, MllpConnectionError } from "@cosyte/mllp";

const server = createServer();
let refused = false;
try {
  await server.listen(0, "0.0.0.0");
} catch (err) {
  refused = err instanceof MllpConnectionError;
}
refused; // => true
server.getStats().listening; // => false
```

```ts no-run binds every network interface of the machine it runs on
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

| IANA name (ITI TF-2 §3.19.6.2.3)        | OpenSSL name                  |
| --------------------------------------- | ----------------------------- |
| `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256`   | `DHE-RSA-AES128-GCM-SHA256`   |
| `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256` | `ECDHE-RSA-AES128-GCM-SHA256` |
| `TLS_DHE_RSA_WITH_AES_256_GCM_SHA384`   | `DHE-RSA-AES256-GCM-SHA384`   |
| `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384` | `ECDHE-RSA-AES256-GCM-SHA384` |

### Selecting the option: `atnaTransportSecurity`

**Off by default.** With it off, `@cosyte/mllp` imposes no cipher list at all and the offered list
is the runtime's, which a Node distribution may configure at build time and an operator may replace
wholesale from outside the process (`--tls-cipher-list`, `NODE_OPTIONS`). What a link offers is then
a property of the deployment, not of this package.

Set `atnaTransportSecurity: true` on either side and the offered list becomes those four suites and
nothing else, from this package rather than from the runtime:

```ts no-run needs a certificate and key of your own
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
  and then fail every DHE handshake in it. The group is the one the TLS library selects for the
  certificate in use, unless you name your own with `dhParameters` (next section), which wins.
- **It is mutually exclusive with `ciphers`.** Both declare the offered list, so setting both
  rejects `connect()` / `listen()` with a typed `MllpTlsConfigurationError` rather than silently
  discarding one of them.

`ciphers` (an OpenSSL cipher-list string) remains available on either side for a list of your own
choosing. A list the runtime rejects is a loud, typed failure at connect or listen time; it never
falls back to the runtime default list. See "Typed failure modes" below.

### Supplying your own group: `dhParameters`

Two of the four suites are DHE, and **a server with no ephemeral Diffie-Hellman parameters cannot
offer a DHE suite at all**: it advertises the suite and then fails every handshake in it.
`ServerTlsOptions.dhParameters` is how you hand it a group.

```ts no-run needs a certificate, a key and a parameter file of your own
import { readFileSync } from "node:fs";

const server = createServer({
  tls: {
    cert: certPem,
    key: keyPem,
    ciphers: "DHE-RSA-AES128-GCM-SHA256",
    dhParameters: readFileSync("dhparam.pem", "utf8"), // openssl dhparam -out dhparam.pem 3072
  },
});
```

Two reasons to reach for it:

- **Your site policy names a group.** Turning on `atnaTransportSecurity` gets you a group, but it is
  the one the TLS library selects for the certificate in use, not one you chose.
- **You restricted `ciphers` yourself to a list containing a DHE suite.** Without parameters that
  list is unofferable in its DHE half, and this is the only way to make it work.

What to know:

- **The value is PEM content, never a filesystem path.** Every credential on these types is content
  and this package performs no disk IO for any of it: read the file yourself, as above. A path
  string is not a Diffie-Hellman parameter block and is refused as such.
- **It takes precedence over the group `atnaTransportSecurity` selects.** Setting both is not a
  conflict and is the intended combination for a deployment with its own policy: the option decides
  which suites are offered, and this decides which group answers the DHE half of them. Unlike
  `atnaTransportSecurity` and `ciphers`, which both declare the offered list and therefore refuse
  each other, these two declare different things.
- **There is no client-side counterpart, deliberately.** The side that answers the key exchange
  supplies the parameters, so this exists on `ServerTlsOptions` and not on `TlsOptions`.
- **`"auto"` is not accepted here.** That is the TLS library's own spelling for its automatic
  selection, and `atnaTransportSecurity` is this package's way of asking for it.
- **Parameters that cannot be used reject `listen()`,** with `MLLP_TLS_DH_PARAMETERS_REJECTED` (see
  the table below). Nothing binds, and nothing falls back to a server running without them. That
  check exists because the TLS library's own behavior for parameters it cannot read is to
  **discard them in silence**, which leaves a listener that answers no DHE handshake and says
  nothing about why.
- **The armour has to survive the trip.** The TLS library reads PEM a line at a time and wants each
  `-----BEGIN DH PARAMETERS-----` / `-----END DH PARAMETERS-----` boundary alone on its own line,
  with exactly five dashes on each side. A value that crosses an environment variable, a single-line
  JSON field or any other whitespace-collapsing layer loses its line breaks and stops being a
  parameter block, so it is refused here rather than discarded quietly later. Everything the library
  itself tolerates is tolerated: CRLF endings, a missing final newline, text before or after the
  block, and a body wrapped at any width or not at all.
- **The body has to be the whole parameter structure, and only it.** Behind armour the library
  reads, what it then parses is a prime, a generator, and at most one optional private-value length
  behind them. A block carrying anything else, an extra field of any kind or a private-value length
  wider than the 32 bits the library reads it at, is discarded just as silently as damaged armour
  is, so it is refused here too. A parameter file from a related standard has exactly that extra
  field, and armouring one under this label is the wrong file rather than a typo: take
  `openssl dhparam` output and the case never arises.
- **The two values have to be inside the bounds the library uses.** A perfect structure can still
  carry values the library will not answer a key exchange with, and that failure is invisible from
  outside: it loads the parameters, refuses them when the handshake asks for a key, and the listener
  advertises its DHE suite and answers nothing, exactly as if it had discarded them. So the same
  bounds are applied before anything binds: the prime must be odd, and the generator must be at
  least 2 and no greater than the prime minus 2.
- **What is checked, and what is not.** The block is read before anything binds: it must be PEM,
  must be a `DH PARAMETERS` block, must decode to the parameter structure the library reads and
  nothing besides, must carry values inside the bounds above, and the library itself must accept the
  group (it refuses one below 1024 bits, and one below its configured security level). The one thing
  **not** checked is that the prime is prime, because a primality test costs seconds on a 3072-bit
  group and minutes on a large one, and `listen()` is not the place to spend it. A well-formed block
  whose modulus is composite is therefore accepted here, as it is by the library itself, and the
  link it carries is weaker than its size suggests. Generate parameters with a tool that produces
  valid ones (`openssl dhparam`) rather than relying on this check to find out.

With neither `atnaTransportSecurity` nor `dhParameters` set, the server supplies no Diffie-Hellman
parameters at all, exactly as before either option existed.

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
- **`'connect-timeout'`**: the handshake, or the TCP connect before it, did not complete within
  `connectTimeoutMs`. The clock runs from the moment the socket is created to `'secureConnect'`, so
  a peer that accepts the TCP connection and then never answers the handshake is bounded too; without
  the option that handshake waits indefinitely. The socket is destroyed, nothing was written, and
  the error is classified **transient**: an unanswered handshake is a peer that is down or
  overloaded, not a configuration fault, so an `autoReconnect` client backs off and tries again.
  On a reconnect attempt it reaches your `retryStrategy` as `lastError` with `code: "ETIMEDOUT"`.
  See [Bounding a connect that never
  completes](./reliability.md#bounding-a-connect-that-never-completes).
- **No `connectionCause`**: pure TCP-level failures (`ECONNREFUSED`, `ETIMEDOUT`,
  `EHOSTUNREACH`, a plain `ECONNRESET`, …) even on a TLS-configured connection. These carry the
  same shape as plaintext connect failures and stay **transient**. A network blip during a
  handshake still auto-heals.

```ts no-run needs a TLS server to connect to
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

A cipher-suite list this package cannot honor is refused **before** a socket exists, so nothing is
left connected and nothing is left bound. `connect()` and `listen()` reject with
`MllpTlsConfigurationError`, identified by `instanceof` plus a stable `code`, never by matching on
the message text:

| `code`                                 | Meaning                                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MLLP_TLS_CIPHER_LIST_REJECTED`        | The TLS library refused the list: no suite in it is available in this build. There is **no fallback to the runtime default list**.                                                                                         |
| `MLLP_TLS_CIPHER_OPTION_CONFLICT`      | `atnaTransportSecurity` and `ciphers` both declare the offered list. Set exactly one.                                                                                                                                      |
| `MLLP_TLS_DH_PARAMETERS_REJECTED`      | `ServerTlsOptions.dhParameters` is not usable: not PEM, not a `DH PARAMETERS` block, or a group the TLS library refuses. Nothing is bound and there is **no fallback to a server running without them**. Server side only. |
| `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`   | The runtime does not enforce the list: it would take a `ciphers` list without applying it, or it cannot offer a suite `atnaTransportSecurity` names. See [Under Bun and Deno](#under-bun-and-deno).                        |
| `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE` | The runtime does not enforce server Diffie-Hellman parameters, for `dhParameters` or for a server's `atnaTransportSecurity`. See [Under Bun and Deno](#under-bun-and-deno). Server side only.                              |
| `MLLP_TLS_PFX_REJECTED`                | The TLS library cannot load `pfx` with `passphrase`: a wrong passphrase, not PKCS#12, or a legacy RC2-40 encryption. See [A PKCS#12 file](#a-pkcs12-file-pfx).                                                             |
| `MLLP_TLS_CREDENTIAL_CONFLICT`         | `pfx` is set together with `cert` or `key`. Thrown by the constructor, not by `connect()` or `listen()`. See [A PKCS#12 file](#a-pkcs12-file-pfx).                                                                         |

```ts runnable
import {
  createServer,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
  MllpTlsConfigurationError,
} from "@cosyte/mllp";

// The list is checked before any certificate is read, so placeholders are enough here.
const server = createServer({
  tls: { cert: "certificate PEM", key: "key PEM", ciphers: "NO-SUCH-SUITE" },
});

let code = "";
try {
  await server.listen(0);
} catch (err) {
  // A configuration problem, not a network one. Nothing is listening.
  if (err instanceof MllpTlsConfigurationError) code = err.code;
}
// Node.js and Bun refuse this list; Deno does not enforce lists, so it refuses the option.
[MLLP_TLS_CIPHER_LIST_REJECTED, MLLP_TLS_CIPHER_LIST_UNENFORCEABLE].includes(code); // => true
```

The list is validated on its own, with no certificate, key, or passphrase in scope, so the error
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

```ts no-run needs a TLS client and server to observe
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

## Under Bun and Deno

We build on Node's `node:tls` and `node:net`, and Node.js is the runtime where every option on this
page is enforced. Bun and Deno each provide their own version of those modules, and between them
they leave three of our options unenforced. We measured what each does by running our suite under each (Bun
1.4.4, Deno 2.9.8): Deno takes a cipher list and Diffie-Hellman parameters and applies neither (a
peer restricted to `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256` negotiated
`TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`), and Bun's TLS library has no finite-field Diffie-Hellman
suite and refuses automatic Diffie-Hellman selection.

So we do not hand these options to a runtime that would not enforce them. Before a socket exists,
probes that carry none of your configuration check that the runtime enforces that kind of option at
all: a cipher list that names a suite and then removes it, so selects none, must be refused, each
suite the ATNA option names must be
available, automatic Diffie-Hellman selection must be accepted, and a Diffie-Hellman group far too
small to use must be refused. Where a probe fails, `connect()` or `listen()` rejects with an
`MllpTlsConfigurationError` instead of opening a link that is not what you configured. Each probe
runs once per process: its input is fixed and the runtime does not change under a running process,
so every later connect, reconnect or server reads the result the first one found:

| Runtime | Option                                                  | What happens                                                                                                                                       |
| ------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deno    | `ciphers`, and `atnaTransportSecurity` on a client      | **Refused**, `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`.                                                                                                 |
| Deno    | `dhParameters`, and `atnaTransportSecurity` on a server | **Refused**, `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`.                                                                                               |
| Bun     | `atnaTransportSecurity` on a client                     | **Refused**, `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`: two of the four suites are DHE. Bun's own refusal of the suite is the `cause`.                  |
| Bun     | `dhParameters`, and `atnaTransportSecurity` on a server | **Refused**, `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`, with Bun's own refusal as the `cause`. The server is constructed; `listen()` is what rejects. |
| Bun     | `ciphers`                                               | Enforced, as on Node.js.                                                                                                                           |

`pfx` is tested on Node.js only. Bun and Deno ship their own TLS libraries, which are not OpenSSL 3,
so what they load from a PKCS#12 file, and which files they refuse, may differ; where a link must
run under either, prefer `cert` and `key`.

A refused configuration is permanent: a client does not retry it, because every attempt would meet
the same runtime. Run on Node.js when you rely on these options. `maxConnections` behaves the same on
every runtime, because the server counts its connections itself: see
[Cap the number of connections](./receive-messages.md#cap-the-number-of-connections).

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
- **The cipher and Diffie-Hellman options are enforced on Node.js.** Where Bun or Deno would not
  enforce one, it is refused with a typed error rather than accepted and ignored. See
  [Under Bun and Deno](#under-bun-and-deno).
- **Reconnect-path errors do not yet carry `connectionCause`.** The `tls-verify`/`tls-handshake`/
  `connect-timeout` labels are attached on the initial `connect()` path only; auto-reconnect failures surface as raw
  socket errors (their transient/permanent classification still applies).
