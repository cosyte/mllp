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

import { createSecureContext, type SecureContextOptions } from "node:tls";
import {
  MllpTlsConfigurationError,
  MLLP_TLS_CIPHER_LIST_REJECTED,
  MLLP_TLS_CIPHER_LIST_UNENFORCEABLE,
  MLLP_TLS_CIPHER_OPTION_CONFLICT,
  MLLP_TLS_DH_PARAMETERS_REJECTED,
  MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE,
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
 * Build a TLS context from `options` alone and report what the runtime threw, if anything.
 *
 * @param options - A probe: no certificate, key or passphrase is ever passed here.
 * @returns The runtime's refusal as an `Error`, or `null` when it built the context.
 */
function refusalOf(options: SecureContextOptions): Error | null {
  try {
    createSecureContext(options);
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
  return null;
}

/** One enforcement probe: a single fixed option, never caller input. */
type Probe = { readonly ciphers: string } | { readonly dhparam: string };

/**
 * What each probe found, by probe, for the life of the process.
 *
 * A probe's input is a fixed value written in this file and the runtime's TLS library does not
 * change under a running process, so a probe's result cannot change either. Without this a client
 * with `atnaTransportSecurity` built five throwaway TLS contexts on every connect and every
 * reconnect.
 */
const probeResults = new Map<string, Error | null>();

/**
 * Run a probe once per process and answer every later ask from what it found.
 *
 * @param probe - The fixed option the probe builds a context from.
 * @returns The runtime's refusal as an `Error`, or `null` when it built the context.
 */
function probeRefusal(probe: Probe): Error | null {
  const key = "ciphers" in probe ? `ciphers=${probe.ciphers}` : `dhparam=${probe.dhparam}`;
  const found = probeResults.get(key);
  if (found !== undefined) return found;
  const refusal = refusalOf(probe);
  probeResults.set(key, refusal);
  return refusal;
}

/**
 * Forget every probe result, so the next probe builds its context again. For tests that stand a
 * different TLS library behind `createSecureContext` between cases; not part of the package's API.
 *
 * @internal
 */
export function clearTlsEnforcementProbes(): void {
  probeResults.clear();
}

/**
 * Prove this runtime enforces a cipher-suite list before one is handed to it, or refuse.
 *
 * A runtime can accept a list and offer its own instead, with no error and no warning (measured:
 * Deno 2.9.8, where a peer restricted to a DHE suite negotiated an ECDHE one). Passing a list to
 * such a runtime would leave a caller believing in a restriction that is not in force, so the list
 * is refused here instead, before any socket exists. Two probes, each with no caller input in
 * scope:
 *
 * - a list that selects no suite must be refused, which shows the runtime works out what a list
 *   selects rather than only how it is spelled;
 * - with `atnaTransportSecurity`, each of the four suites it names must be accepted on its own,
 *   which shows the runtime can offer every one of them. A TLS library with no finite-field
 *   Diffie-Hellman suite (measured: Bun 1.4.4) cannot offer two of the four, and would otherwise
 *   offer the other two under the option's name.
 *
 * @param atna - Whether the list is the ATNA option's own.
 * @throws {MllpTlsConfigurationError} `MLLP_TLS_CIPHER_LIST_UNENFORCEABLE`, with the runtime's
 * own refusal as `cause` when a named suite is what it refused.
 */
function assertCipherListEnforced(atna: boolean): void {
  // A list that describes no suite at all: it names one real suite and then removes it for good
  // with `!`. A TLS library that enforces a list works out what the list selects, finds nothing,
  // and refuses it (Node.js and Bun: `no cipher match`). One that only checks how a list is spelled
  // and then offers its own accepts it, and would take the caller's list the same way (measured:
  // Deno 2.9.8, which refuses a list of lower-case words but accepts this one, and accepts
  // `!ALL`). The suite is a real one so that a check of the names alone passes it.
  if (
    probeRefusal({ ciphers: "ECDHE-RSA-AES128-GCM-SHA256:!ECDHE-RSA-AES128-GCM-SHA256" }) === null
  ) {
    throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE);
  }
  if (!atna) return;
  for (const suite of ATNA_CIPHER_SUITES) {
    const refusal = probeRefusal({ ciphers: suite });
    if (refusal !== null) {
      throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_UNENFORCEABLE, { cause: refusal });
    }
  }
}

/**
 * Prove this runtime enforces server Diffie-Hellman parameters before any are handed to it, or
 * refuse.
 *
 * Two probes, each with no caller input in scope. The automatic selection must be accepted: a
 * runtime that refuses it (measured: Bun 1.4.4, `Automatic DH parameter selection is not
 * supported`) has its refusal wrapped here, as the `cause`, rather than thrown as a plain error
 * from deep inside the server. And a group far too small to use must be refused: a runtime that
 * accepts it (measured: Deno 2.9.8) takes parameters without using them, and a server built there
 * would advertise its DHE suites on parameters it never applied.
 *
 * @throws {MllpTlsConfigurationError} `MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE`.
 */
function assertDhParametersEnforced(): void {
  const autoRefusal = probeRefusal({ dhparam: "auto" });
  if (autoRefusal !== null) {
    throw new MllpTlsConfigurationError(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE, {
      cause: autoRefusal,
    });
  }
  // PKCS#3 parameters for the group p = 23, g = 5: a five-bit prime, far below the 1024 bits under
  // which Node.js refuses parameters out loud (`DH parameter is less than 1024 bits`). A library
  // that reads `dhparam` refuses it; one that takes parameters and runs without them accepts it.
  // Never handed to a context that serves anything.
  const undersized = "-----BEGIN DH PARAMETERS-----\nMAYCARcCAQU=\n-----END DH PARAMETERS-----\n";
  if (probeRefusal({ dhparam: undersized }) === null) {
    throw new MllpTlsConfigurationError(MLLP_TLS_DH_PARAMETERS_UNENFORCEABLE);
  }
}

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
   * See `ServerTlsOptions.dhParameters`. Diffie-Hellman parameters are supplied
   * by the end that answers the key exchange, so this is read when `side` is
   * `'server'` and **ignored, without an error, when `side` is `'client'`**.
   *
   * That asymmetry is stated rather than enforced because the field is
   * unreachable from the client option type in the first place: `TlsOptions`
   * carries no Diffie-Hellman parameter field at all, so a client value can
   * only arrive through a direct call to
   * {@link resolveTlsCipherPolicy}.
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
 * {@link isDhParametersPem} is the net for that, and for the values that parse
 * and then fail the library's own parameter check just as quietly at handshake
 * time. A block the library reads and whose group it refuses OUT LOUD (too
 * small, or below its configured security level) throws instead, and the second
 * net is that throw. Neither net covers the other's case.
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
      cause:
        err instanceof Error
          ? err
          : /* v8 ignore next -- createSecureContext throws only Error */ new Error(String(err)),
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
 * **A runtime that would not enforce what was asked for is refused too.** Before
 * a list or parameters are handed over, probes with no caller input in scope
 * prove that this runtime's TLS library enforces that kind of input at all; one
 * that would accept it and then run without it (a `node:tls` that takes a list
 * and offers its own) gets an `_UNENFORCEABLE` code instead of a link that is
 * not what it says. Node.js passes every probe.
 *
 * @throws {MllpTlsConfigurationError} On a conflicting declaration, a list the
 * runtime rejects, Diffie-Hellman parameters it cannot use, or a list or
 * parameters this runtime does not enforce. Never falls back to the runtime
 * default list, and never to a server with no Diffie-Hellman parameters.
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
  if (dhparam !== undefined) assertDhParametersEnforced();

  if (ciphers !== undefined) {
    assertCipherListEnforced(atna);
    try {
      createSecureContext({ ciphers });
    } catch (err) {
      throw new MllpTlsConfigurationError(MLLP_TLS_CIPHER_LIST_REJECTED, {
        cause:
          err instanceof Error
            ? err
            : /* v8 ignore next -- createSecureContext throws only Error */ new Error(String(err)),
      });
    }
  }

  if (ciphers === undefined) return dhparam === undefined ? {} : { dhparam };
  return dhparam === undefined ? { ciphers } : { ciphers, dhparam };
}
