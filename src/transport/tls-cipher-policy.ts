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
 * Two of the four suites are DHE, so the server half of the policy also settles
 * which ephemeral Diffie-Hellman group is in force: the caller's own, when
 * `ServerTlsOptions.dhParameters` names one, and otherwise the selection the
 * runtime makes for the certificate in use.
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
  MLLP_TLS_DH_PARAMETERS_REJECTED,
} from "./error.js";
import { isDhParametersPem } from "./dh-parameters.js";

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
  /**
   * See `ServerTlsOptions.dhParameters`. Read only when `side` is `'server'`,
   * because Diffie-Hellman parameters are supplied by the end that answers the
   * key exchange; there is deliberately no such field on the client option
   * type at all.
   */
  readonly dhParameters?: string | Buffer;
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
   * every DHE handshake in it.
   *
   * Exactly two things reach this field. The literal `'auto'` is the TLS
   * library's own spelling for the selection it makes from the certificate in
   * use, which is what `atnaTransportSecurity: true` alone yields. Anything
   * else is PEM content: the caller's own group, taken verbatim from
   * `ServerTlsOptions.dhParameters` and preferred over the automatic selection.
   * Absent when neither was asked for, so the not-selected path is untouched.
   *
   * Typed `string | Buffer` rather than `'auto' | string | Buffer` because the
   * literal is absorbed by `string` in a union and says nothing to a reader
   * there; it is stated here instead.
   */
  readonly dhparam?: string | Buffer;
}

/**
 * Prove the runtime will use the caller's own Diffie-Hellman parameters, or
 * refuse the configuration.
 *
 * TWO NETS, BECAUSE ONE OF THEM CANNOT SEE ITS OWN CASE. The TLS library
 * silently discards parameters it cannot read, so content that is not a
 * `DH PARAMETERS` block reaches `createSecureContext` without an error and
 * leaves a server that advertises DHE and answers no DHE handshake:
 * {@link isDhParametersPem} is the net for that. A block that IS one and whose
 * group the library refuses (too small, or below its security level) throws,
 * and the second net is that throw. Neither net covers the other's case.
 *
 * Validated with the parameters **alone**, no certificate, key or passphrase in
 * scope, so the error cannot carry credential material. The parameter bytes
 * themselves never reach the error either: the structural refusal carries no
 * `cause` at all, and the library's own refusals name a property of the group
 * rather than echoing it.
 *
 * @param dhParameters - PEM content the caller supplied.
 * @throws {MllpTlsConfigurationError} `MLLP_TLS_DH_PARAMETERS_REJECTED`.
 */
function assertUsableDhParameters(dhParameters: string | Buffer): void {
  if (!isDhParametersPem(dhParameters)) {
    throw new MllpTlsConfigurationError(MLLP_TLS_DH_PARAMETERS_REJECTED);
  }
  try {
    createSecureContext({ dhparam: dhParameters });
  } catch (err) {
    throw new MllpTlsConfigurationError(MLLP_TLS_DH_PARAMETERS_REJECTED, {
      cause: err instanceof Error ? err : new Error(String(err)),
    });
  }
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
 * **Diffie-Hellman parameters are the one place a winner IS picked, and the
 * caller wins.** `atnaTransportSecurity: true` selects a group automatically
 * because two of its four suites are DHE; a caller that also names its own
 * group is stating site policy, and site policy is more specific than a default
 * this package chose. So the two are not in conflict and the configuration is
 * accepted with the caller's group in force.
 *
 * Each input is validated **alone**, with no certificate, key or passphrase in
 * scope, so a rejection can only ever be about that input and the error it
 * raises cannot carry credential material.
 *
 * @param opts - The cipher-suite half of the caller's TLS options.
 * @param side - Which end of the connection is being configured.
 * @returns The TLS-context fields to spread into `tls.connect` / `tls.createServer`.
 * @throws {MllpTlsConfigurationError} On a conflicting declaration, a list the
 * runtime rejects, or Diffie-Hellman parameters it cannot use. Never falls back
 * to the runtime default list, and never to a server with no Diffie-Hellman
 * parameters.
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

  // Server side only. The client option type carries no such field, so this is
  // reachable only through a direct call to this function.
  const supplied = side === "server" ? opts.dhParameters : undefined;
  if (supplied !== undefined) assertUsableDhParameters(supplied);
  const dhparam: string | Buffer | undefined =
    supplied ?? (atna && side === "server" ? "auto" : undefined);

  if (ciphers !== undefined) {
    try {
      createSecureContext({ ciphers });
    } catch (err) {
      throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_REJECTED, {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
  }

  if (ciphers === undefined) return dhparam === undefined ? {} : { dhparam };
  return dhparam === undefined ? { ciphers } : { ciphers, dhparam };
}
