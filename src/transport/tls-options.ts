/**
 * TLS (MLLPS) option types for the client and server.
 *
 * Spec anchor: IHE ATNA, ITI-19 Authenticate Node
 * (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2
 * Floor using BCP195" option, ITI TF-2 §3.19.6.2.3, TLS >= 1.2 required;
 * mutual node authentication; certificate validation via chain-of-trust or
 * direct comparison. ITI TF-2 §3.19.6.2.3 mandates four TLS 1.2 cipher
 * suites: `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256`,
 * `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`, `TLS_DHE_RSA_WITH_AES_256_GCM_SHA384`,
 * `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`. Set `atnaTransportSecurity: true`
 * to offer exactly those four (plus the TLS 1.3 defaults) instead of whatever
 * the runtime's own list happens to be; it is off by default, and what a link
 * negotiated is reported on the `'tlsNegotiated'` event either way. See
 * `docs-content/tls.md`.
 *
 * @example
 * ```typescript
 * import type { TlsOptions } from '@cosyte/mllp';
 * const tls: TlsOptions = { ca: caPem, servername: 'mllp.example.com' };
 * ```
 *
 * @packageDocumentation
 */

/**
 * A PEM-encoded credential (certificate, key, or CA), matching Node's
 * `tls.connect`/`tls.createServer` input shape, a single PEM string/Buffer,
 * or an array of them (chain / multiple trust anchors).
 *
 * @example
 * ```typescript
 * import { readFileSync } from 'node:fs';
 * const ca: PemInput = readFileSync('ca.pem');
 * ```
 */
export type PemInput = string | Buffer | Array<string | Buffer>;

/**
 * Client-side TLS options (`ClientOptions.tls`).
 *
 * Passing `true` for `ClientOptions.tls` is equivalent to `{}`, TLS enabled
 * with all defaults, including certificate verification **on**.
 *
 * @example
 * ```typescript
 * import { createClient } from '@cosyte/mllp';
 * const client = createClient({
 *   host: 'mllp.example.com',
 *   port: 2575,
 *   tls: { ca: caPem, minVersion: 'TLSv1.2' },
 * });
 * ```
 */
export interface TlsOptions {
  /** Trust anchor(s) for verifying the server's certificate chain. */
  readonly ca?: PemInput;
  /** Client certificate presented for mutual TLS (ATNA ITI-19). */
  readonly cert?: PemInput;
  /** Private key matching {@link TlsOptions.cert}. */
  readonly key?: PemInput;
  /**
   * Passphrase for an encrypted {@link TlsOptions.key}, or for the PKCS#12 file in
   * {@link TlsOptions.pfx}.
   */
  readonly passphrase?: string;
  /**
   * The client certificate and its private key as one PKCS#12 file (`.pfx` / `.p12`), in place of
   * {@link TlsOptions.cert} and {@link TlsOptions.key}, unlocked with {@link TlsOptions.passphrase}.
   * The file's bytes, as `readFileSync` returns them; this package reads no file itself.
   *
   * The file is loaded before any socket is opened. One the TLS library cannot load rejects
   * `connect()` with a typed `MllpTlsConfigurationError` carrying `MLLP_TLS_PFX_REJECTED`, whose
   * message names this option and never its value: a wrong passphrase, bytes that are not
   * PKCS#12, or a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy`, OpenSSL 1.x and
   * older Windows exports write it) that Node.js, on OpenSSL 3, does not load. Re-export such a
   * file with AES-256. A reconnect attempt that meets it gives up, as for any configuration error.
   *
   * @default undefined (no PKCS#12 file)
   */
  readonly pfx?: Buffer;
  /**
   * SNI hostname and the identity-check target (matched against the server
   * certificate's Subject/SAN). Defaults to `ClientOptions.host` when unset.
   * An IP address, set here or as the host, is checked against the
   * certificate but never sent as SNI, which RFC 6066 reserves for host names.
   */
  readonly servername?: string;
  /**
   * Minimum negotiated TLS protocol version.
   *
   * Default `'TLSv1.2'`, the IHE ATNA ITI-19 "TLS 1.2 Floor" (BCP195) floor
   * (ITI TF-2 §3.19.6.2.3). `'TLSv1.0'`/`'TLSv1.1'` are intentionally **not**
   * expressible by this type, the floor cannot be lowered through this API.
   *
   * @default 'TLSv1.2'
   */
  readonly minVersion?: "TLSv1.2" | "TLSv1.3";
  /** Maximum negotiated TLS protocol version. */
  readonly maxVersion?: "TLSv1.2" | "TLSv1.3";
  /**
   * Offer exactly the cipher suites the IHE ATNA ITI-19 transport-security
   * option names (ITI TF-2 §3.19.6.2.3), rather than inheriting the runtime's
   * own list. Off by default; turning it on only ever **narrows** what is
   * offered.
   *
   * This is the **cipher-suite half** of that option, and it does not make the
   * declaration on your behalf. Mutual node authentication is
   * `ServerTlsOptions.clientAuth` plus a client `cert`/`key`, and the TLS 1.2
   * floor is {@link TlsOptions.minVersion}, which already defaults to it.
   *
   * The four TLS 1.2 suites are offered together with the three TLS 1.3 suites
   * the runtime enables by default, so selecting this never removes a protocol
   * version that was reachable without it. A peer that supports none of them
   * fails the handshake rather than falling back, which is the point.
   *
   * Mutually exclusive with {@link TlsOptions.ciphers}: both declare the
   * offered list, so setting both rejects `connect()` with a typed
   * `MllpTlsConfigurationError`.
   *
   * **On a runtime that cannot offer the list it rejects `connect()`** with a
   * typed `MllpTlsConfigurationError` carrying
   * `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before any socket exists: under Deno,
   * whose `node:tls` takes a cipher list without applying it, and under Bun,
   * whose TLS library has none of the DHE suites the option names. Node.js
   * offers it.
   *
   * @default false
   */
  readonly atnaTransportSecurity?: boolean;
  /**
   * OpenSSL cipher-list string passthrough (`tls.connect`'s `ciphers`).
   * Unset uses Node's compiled-in defaults, which already include both
   * ATNA-mandated ECDHE suites (see the module doc comment). Set this to
   * restrict to a stricter list of your own choosing; for the ATNA option's
   * own four suites prefer {@link TlsOptions.atnaTransportSecurity}, which is
   * the same declaration made once and reported on `'tlsNegotiated'`.
   *
   * A list the runtime rejects rejects `connect()` with a typed
   * `MllpTlsConfigurationError`; it never silently falls back to the default
   * list. **So does any list on a runtime that does not enforce cipher lists**
   * (Deno, whose `node:tls` takes a list without applying it), with
   * `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before any socket exists. Node.js and
   * Bun enforce a list.
   *
   * @default undefined (Node defaults)
   */
  readonly ciphers?: string;
  /**
   * Loud, explicit dev opt-out from certificate verification (maps to
   * `tls.connect`'s `rejectUnauthorized: false`). There is deliberately no
   * raw `rejectUnauthorized` surface on this type, this is the only door,
   * and it is loud: every successful connection (initial + every reconnect)
   * emits a `'securityWarning'` (`MLLP_TLS_VERIFY_DISABLED`) event and calls
   * `process.emitWarning`.
   *
   * Never set this in production against an untrusted network.
   *
   * @default false
   */
  readonly allowUnverified?: boolean;
}

/**
 * ATNA ITI-19 mutual-authentication modes for {@link ServerTlsOptions.clientAuth}.
 *
 * Mirrors the IHE ATNA "Authenticate Node" mutual-auth requirement
 * (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html):
 *
 * - `'NONE'`, no client certificate requested (default).
 * - `'WANT'`, client certificate requested but NOT required; an untrusted or
 *   absent client certificate does not reject the connection. The peer
 *   certificate (if any) is surfaced on the `'connection'` event.
 * - `'MUST'`, client certificate required AND verified against
 *   {@link ServerTlsOptions.ca}; the ATNA mutual-authentication mode. A
 *   missing or untrusted client certificate rejects the handshake.
 *
 * @example
 * ```typescript
 * import type { ClientAuth } from '@cosyte/mllp';
 * const mode: ClientAuth = 'MUST'; // ATNA ITI-19 mutual node authentication
 * ```
 */
export type ClientAuth = "NONE" | "WANT" | "MUST";

/**
 * Server-side TLS options (`ServerOptions.tls`).
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/mllp';
 * const server = createServer({
 *   tls: { cert: certPem, key: keyPem, clientAuth: 'MUST', ca: clientCaPem },
 * });
 * ```
 */
export interface ServerTlsOptions {
  /**
   * Server certificate (PEM). Required with {@link ServerTlsOptions.key} unless
   * {@link ServerTlsOptions.pfx} is set: a server given neither pair nor file throws a
   * `TypeError` at construction.
   */
  readonly cert?: PemInput;
  /** Private key matching {@link ServerTlsOptions.cert}. Required with it unless `pfx` is set. */
  readonly key?: PemInput;
  /** Trust anchor(s) for verifying client certificates under `WANT`/`MUST`. */
  readonly ca?: PemInput;
  /**
   * Passphrase for an encrypted {@link ServerTlsOptions.key}, or for the PKCS#12 file in
   * {@link ServerTlsOptions.pfx}.
   */
  readonly passphrase?: string;
  /**
   * The server certificate and its private key as one PKCS#12 file (`.pfx` / `.p12`), in place of
   * {@link ServerTlsOptions.cert} and {@link ServerTlsOptions.key}, unlocked with
   * {@link ServerTlsOptions.passphrase}. The file's bytes, as `readFileSync` returns them; this
   * package reads no file itself.
   *
   * The file is loaded before anything is bound. One the TLS library cannot load rejects
   * `listen()` with a typed `MllpTlsConfigurationError` carrying `MLLP_TLS_PFX_REJECTED`, whose
   * message names this option and never its value: a wrong passphrase, bytes that are not
   * PKCS#12, or a legacy encryption (RC2-40, as `openssl pkcs12 -export -legacy`, OpenSSL 1.x and
   * older Windows exports write it) that Node.js, on OpenSSL 3, does not load. Re-export such a
   * file with AES-256. Construction never throws for it.
   *
   * @default undefined (no PKCS#12 file)
   */
  readonly pfx?: Buffer;
  /**
   * ATNA ITI-19 mutual-authentication mode. `'WANT'` requests a client
   * certificate without rejecting unauthorized/absent ones (surfaced, not
   * enforced); `'MUST'` requests AND enforces verification (ATNA mutual
   * auth). See {@link ClientAuth}.
   *
   * @default 'NONE'
   */
  readonly clientAuth?: ClientAuth;
  /**
   * Minimum negotiated TLS protocol version, the IHE ATNA ITI-19 "TLS 1.2
   * Floor" (BCP195) floor (ITI TF-2 §3.19.6.2.3).
   *
   * @default 'TLSv1.2'
   */
  readonly minVersion?: "TLSv1.2" | "TLSv1.3";
  /** Maximum negotiated TLS protocol version. */
  readonly maxVersion?: "TLSv1.2" | "TLSv1.3";
  /**
   * Offer exactly the cipher suites the IHE ATNA ITI-19 transport-security
   * option names (ITI TF-2 §3.19.6.2.3), rather than inheriting the runtime's
   * own list. Off by default; turning it on only ever **narrows** what is
   * offered.
   *
   * The server side additionally provides ephemeral Diffie-Hellman parameters,
   * because two of the four named suites are DHE and a server without them
   * cannot actually offer a DHE suite. The group is the one the runtime selects
   * for the certificate in use unless {@link ServerTlsOptions.dhParameters}
   * names another, which takes precedence. See
   * {@link TlsOptions.atnaTransportSecurity} for the rest, including what this
   * setting does **not** claim on your behalf.
   *
   * Mutually exclusive with {@link ServerTlsOptions.ciphers}: setting both
   * rejects `listen()` with a typed `MllpTlsConfigurationError`.
   *
   * **On a runtime that cannot honour it, `listen()` rejects** with a typed
   * `MllpTlsConfigurationError` carrying `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`,
   * before anything is bound: under Bun, whose TLS library refuses the automatic
   * Diffie-Hellman selection (its own error is the `cause`), and under Deno,
   * whose `node:tls` takes parameters and a cipher list without applying them.
   * Construction never throws for it. Node.js honours it.
   *
   * @default false
   */
  readonly atnaTransportSecurity?: boolean;
  /**
   * OpenSSL cipher-list string passthrough. Unset uses Node's defaults
   * (includes both ATNA-mandated ECDHE suites). For the ATNA option's own four
   * suites prefer {@link ServerTlsOptions.atnaTransportSecurity}.
   *
   * A list the runtime rejects rejects `listen()` with a typed
   * `MllpTlsConfigurationError`; it never silently falls back to the default
   * list. **So does any list on a runtime that does not enforce cipher lists**
   * (Deno), with `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, before anything is bound.
   * Node.js and Bun enforce a list.
   *
   * @default undefined (Node defaults)
   */
  readonly ciphers?: string;
  /**
   * Ephemeral Diffie-Hellman parameters this server answers a DHE key exchange
   * with, as **PEM content**. There is deliberately no filesystem-path input:
   * every credential on this type is content, and this package performs no disk
   * IO for any of it. Generate a group with `openssl dhparam` and read it in
   * yourself.
   *
   * A DHE cipher suite is unofferable by a server with no parameters, so this
   * is what makes one reachable through {@link ServerTlsOptions.ciphers}: a
   * list restricted to a DHE suite without this advertises that suite and then
   * fails every handshake in it.
   *
   * **It takes precedence over the group
   * {@link ServerTlsOptions.atnaTransportSecurity} selects automatically**, and
   * setting both is not a conflict: the option picks a group when nothing else
   * says which, and this says which. That is how a deployment whose own policy
   * names a group puts it in force while still offering exactly the ITI TF-2
   * §3.19.6.2.3 suites.
   *
   * Parameters this package or the TLS library cannot use reject `listen()`
   * with a typed `MllpTlsConfigurationError` carrying
   * `MLLP_TLS_DH_PARAMETERS_REJECTED`, before anything is bound. Nothing falls
   * back to a server running without them, which matters because the TLS
   * library's own behaviour for unreadable parameters is to discard them in
   * silence. `'auto'` is not accepted here; that selection is what
   * `atnaTransportSecurity` already makes.
   *
   * **On a runtime that does not enforce Diffie-Hellman parameters, `listen()`
   * rejects** with `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`, before anything is
   * bound, rather than serving without them: under Deno, whose `node:tls` takes
   * parameters without using them, and under Bun, whose TLS library has no
   * finite-field Diffie-Hellman (its own refusal is the `cause`). Node.js
   * enforces them.
   *
   * There is no counterpart on {@link TlsOptions}: the side that answers the
   * key exchange supplies the parameters.
   *
   * @default undefined (no Diffie-Hellman parameters unless `atnaTransportSecurity` selects them)
   */
  readonly dhParameters?: string | Buffer;
}

export {
  MLLP_TLS_VERIFY_DISABLED,
  MLLP_BIND_ALL_INTERFACES,
  type SecurityWarning,
  type SecurityWarningCode,
} from "./security-warnings.js";
