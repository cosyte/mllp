/**
 * Prove a configured PKCS#12 file loads before any socket depends on it.
 *
 * @packageDocumentation
 */

import { createSecureContext } from "node:tls";

import {
  MLLP_TLS_CREDENTIAL_CONFLICT,
  MLLP_TLS_PFX_REJECTED,
  MllpTlsConfigurationError,
} from "./error.js";

/**
 * Refuse a TLS configuration that sets `pfx` together with `cert` or `key`, with
 * {@link MllpTlsConfigurationError} and {@link MLLP_TLS_CREDENTIAL_CONFLICT}.
 *
 * Node.js loads the PKCS#12 file after the PEM pair, so the file's certificate would win and the
 * `cert` the caller passed would go unused, with nothing to say so. Called by both constructors.
 * The error carries the code only: no option's value reaches it.
 *
 * @param tls - The configured TLS options, `true` for a client's defaults, or `undefined`.
 * @throws {MllpTlsConfigurationError} when `pfx` is set with `cert` or `key`.
 * @internal
 */
export function checkCredentialMix(
  tls:
    { readonly cert?: unknown; readonly key?: unknown; readonly pfx?: Buffer } | true | undefined,
): void {
  if (typeof tls !== "object" || tls.pfx === undefined) return;
  if (tls.cert !== undefined || tls.key !== undefined) {
    throw new MllpTlsConfigurationError(MLLP_TLS_CREDENTIAL_CONFLICT);
  }
}

/**
 * Load `pfx` with `passphrase` into a throwaway secure context, and turn a refusal into
 * {@link MllpTlsConfigurationError} with {@link MLLP_TLS_PFX_REJECTED}.
 *
 * Without this a file the TLS library cannot load (a wrong passphrase, or a legacy RC2-40
 * encryption OpenSSL 3 does not load) would throw out of the server's constructor, where the
 * caller awaits `listen()`. The library's error becomes
 * the `cause`; the message is the fixed registry text, which names the option and never its value.
 *
 * @param pfx - The PKCS#12 bytes, or `undefined` when none is configured (nothing to check).
 * @param passphrase - The configured passphrase, if any.
 * @throws {MllpTlsConfigurationError} when the TLS library refuses the file.
 * @internal
 */
export function checkPfx(pfx: Buffer | undefined, passphrase: string | undefined): void {
  // Stryker disable next-line ConditionalExpression: equivalent. Without the guard a context is built with no pfx at all, which loads; only the time it takes differs.
  if (pfx === undefined) return;
  try {
    createSecureContext({ pfx, passphrase });
  } catch (err) {
    // The TLS library throws an Error for a file it cannot load.
    throw new MllpTlsConfigurationError(MLLP_TLS_PFX_REJECTED, { cause: err as Error });
  }
}
