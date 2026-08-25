/**
 * The offered-cipher-suite policy behind `tls.atnaTransportSecurity`.
 *
 * Spec anchor: IHE ATNA, ITI-19 Authenticate Node
 * (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html), the "STX: TLS 1.2
 * Floor using BCP195" option, ITI TF-2 §3.19.6.2.3, which names four TLS 1.2
 * cipher suites an actor claiming that option supports, and allows
 * "additional cipher suites of similar or greater cryptographic strength".
 *
 * With the option off (the default) this module imposes nothing and the
 * offered list is the runtime's, which the runtime's own documentation says
 * a distribution may configure at build time and an operator may replace
 * wholesale from outside the process. With the option on, the offered list is
 * a property of this package instead, and what a link negotiated is
 * observable on the `'tlsNegotiated'` event.
 *
 * @example
 * ```typescript
 * import { ATNA_CIPHER_SUITES } from '@cosyte/mllp';
 * console.log(ATNA_CIPHER_SUITES.length); // => 4
 * ```
 *
 * @packageDocumentation
 */

import { createSecureContext } from "node:tls";
import {
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_CIPHER_OPTION_CONFLICT,
} from "./error.js";

/**
 * The four TLS 1.2 cipher suites ITI TF-2 §3.19.6.2.3 names, in the OpenSSL
 * spelling a cipher-list string is written in. Their IANA spellings, which are
 * what the standard prints and what the `'tlsNegotiated'` event reports, are
 * the same four prefixed `TLS_` and joined with `_WITH_`.
 *
 * @example
 * ```typescript
 * import { ATNA_CIPHER_SUITES } from '@cosyte/mllp';
 * console.log(ATNA_CIPHER_SUITES.includes('ECDHE-RSA-AES128-GCM-SHA256')); // => true
 * ```
 */
export const ATNA_CIPHER_SUITES: readonly string[] = Object.freeze([
  "DHE-RSA-AES128-GCM-SHA256",
  "ECDHE-RSA-AES128-GCM-SHA256",
  "DHE-RSA-AES256-GCM-SHA384",
  "ECDHE-RSA-AES256-GCM-SHA384",
]);

/**
 * The three TLS 1.3 cipher suites the runtime enables by default.
 *
 * They are carried alongside the four above for one reason: a TLS 1.3 suite is
 * enabled only by its full name in the cipher list, so a list holding the four
 * TLS 1.2 suites alone would turn TLS 1.3 **off**. Selecting the option must
 * never remove a protocol version that was reachable without it, so these are
 * restated rather than dropped.
 *
 * @example
 * ```typescript
 * import { TLS13_DEFAULT_CIPHER_SUITES } from '@cosyte/mllp';
 * console.log(TLS13_DEFAULT_CIPHER_SUITES.length); // => 3
 * ```
 */
export const TLS13_DEFAULT_CIPHER_SUITES: readonly string[] = Object.freeze([
  "TLS_AES_256_GCM_SHA384",
  "TLS_CHACHA20_POLY1305_SHA256",
  "TLS_AES_128_GCM_SHA256",
]);

/**
 * The OpenSSL cipher-list string `tls.atnaTransportSecurity: true` offers:
 * the three TLS 1.3 default suites followed by the four ITI TF-2 §3.19.6.2.3
 * suites, and nothing else.
 *
 * @example
 * ```typescript
 * import { ATNA_CIPHER_LIST } from '@cosyte/mllp';
 * console.log(ATNA_CIPHER_LIST.split(':').length); // => 7
 * ```
 */
export const ATNA_CIPHER_LIST: string = [
  ...TLS13_DEFAULT_CIPHER_SUITES,
  ...ATNA_CIPHER_SUITES,
].join(":");

/**
 * The cipher-suite half of a client's or server's TLS options, the two fields
 * that can declare what is offered.
 */
export interface TlsCipherPolicyInput {
  /** See `TlsOptions.atnaTransportSecurity`. */
  readonly atnaTransportSecurity?: boolean;
  /** See `TlsOptions.ciphers`. */
  readonly ciphers?: string;
}

/**
 * The TLS-context fields the resolved policy contributes. Empty when the
 * option is off and no `ciphers` passthrough is set: this package then imposes
 * no cipher list at all, exactly as before the option existed.
 */
export interface ResolvedTlsCipherPolicy {
  /** OpenSSL cipher-list string, or absent to impose none. */
  readonly ciphers?: string;
  /**
   * Ephemeral Diffie-Hellman parameters, server-side only. Two of the four
   * named suites are DHE, and a server with no DH parameters cannot offer a
   * DHE suite at all: without this it would advertise the list and then fail
   * every DHE handshake in it. Never set when the option is off, so the
   * not-selected path is untouched.
   */
  readonly dhparam?: "auto";
}

/**
 * Resolve the offered-cipher-suite policy for one side of a connection, and
 * prove the runtime accepts it before any socket is opened.
 *
 * Refuses, rather than picking a winner, when both `atnaTransportSecurity` and
 * `ciphers` are set: each declares the offered list, and honouring one would
 * silently discard the other on a link whose whole point is being able to say
 * what it offered.
 *
 * The list is validated **alone**, with no certificate, key or passphrase in
 * scope, so a rejection can only ever be about the suite list and the error it
 * raises cannot carry credential material.
 *
 * @param opts - The cipher-suite half of the caller's TLS options.
 * @param side - Which end of the connection is being configured.
 * @returns The TLS-context fields to spread into `tls.connect` / `tls.createServer`.
 * @throws {MllpTlsConfigurationError} On a conflicting declaration, or a list
 * the runtime rejects. Never falls back to the runtime default list.
 *
 * @example
 * ```typescript
 * import { resolveTlsCipherPolicy } from '@cosyte/mllp';
 * const policy = resolveTlsCipherPolicy({ atnaTransportSecurity: true }, 'server');
 * console.log(policy.dhparam); // => 'auto'
 * ```
 */
export function resolveTlsCipherPolicy(
  opts: TlsCipherPolicyInput,
  side: "client" | "server",
): ResolvedTlsCipherPolicy {
  const atna = opts.atnaTransportSecurity === true;
  if (atna && opts.ciphers !== undefined) {
    throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_OPTION_CONFLICT);
  }
  const ciphers = atna ? ATNA_CIPHER_LIST : opts.ciphers;
  if (ciphers === undefined) return {};

  const dhparam = atna && side === "server" ? ("auto" as const) : undefined;
  try {
    createSecureContext(dhparam === undefined ? { ciphers } : { ciphers, dhparam });
  } catch (err) {
    throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_REJECTED, {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }
  return dhparam === undefined ? { ciphers } : { ciphers, dhparam };
}
