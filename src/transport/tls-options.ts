/**
 * TLS (MLLPS) option types for the client and server (Phase 8).
 *
 * Spec anchor: IHE ATNA, ITI-19 Authenticate Node
 * (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2
 * Floor using BCP195" option, ITI TF-2 §3.19.6.2.3, TLS >= 1.2 required;
 * mutual node authentication; certificate validation via chain-of-trust or
 * direct comparison. ITI TF-2 §3.19.6.2.3 mandates four TLS 1.2 cipher
 * suites: `TLS_DHE_RSA_WITH_AES_128_GCM_SHA256`,
 * `TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256`, `TLS_DHE_RSA_WITH_AES_256_GCM_SHA384`,
 * `TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`. Node's default TLS 1.2 cipher list
 * already includes both mandated ECDHE suites, so this package pins to Node
 * defaults rather than bundling a cipher list, see `docs-content/tls.md`.
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
 * Client-side TLS options (Phase 8, `ClientOptions.tls`).
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
  /** Passphrase for an encrypted {@link TlsOptions.key}. */
  readonly passphrase?: string;
  /**
   * SNI hostname and the identity-check target (matched against the server
   * certificate's Subject/SAN). Defaults to `ClientOptions.host` when unset.
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
   * OpenSSL cipher-list string passthrough (`tls.connect`'s `ciphers`).
   * Unset uses Node's compiled-in defaults, which already include both
   * ATNA-mandated ECDHE suites (see the module doc comment). Set this to
   * restrict to a stricter list (e.g. DHE suites) if your deployment requires it.
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
 * Server-side TLS options (Phase 8, `ServerOptions.tls`).
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
  /** Server certificate (PEM). Required. */
  readonly cert: PemInput;
  /** Private key matching {@link ServerTlsOptions.cert}. Required. */
  readonly key: PemInput;
  /** Trust anchor(s) for verifying client certificates under `WANT`/`MUST`. */
  readonly ca?: PemInput;
  /** Passphrase for an encrypted {@link ServerTlsOptions.key}. */
  readonly passphrase?: string;
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
   * OpenSSL cipher-list string passthrough. Unset uses Node's defaults
   * (includes both ATNA-mandated ECDHE suites).
   *
   * @default undefined (Node defaults)
   */
  readonly ciphers?: string;
}

export {
  MLLP_TLS_VERIFY_DISABLED,
  MLLP_BIND_ALL_INTERFACES,
  type SecurityWarning,
  type SecurityWarningCode,
} from "./security-warnings.js";
