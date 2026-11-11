/**
 * Prove a configured PKCS#12 file loads before any socket depends on it.
 *
 * @packageDocumentation
 */

import { createSecureContext } from "node:tls";

import { MLLP_TLS_PFX_REJECTED, MllpTlsConfigurationError } from "./error.js";

/**
 * Load `pfx` with `passphrase` into a throwaway secure context, and turn a refusal into
 * {@link MllpTlsConfigurationError} with {@link MLLP_TLS_PFX_REJECTED}.
 *
 * Without this a file the TLS library cannot load (a wrong passphrase, or a legacy RC2-40
 * encryption OpenSSL 3 does not load) would fail later and less clearly: inside `listen()`'s
 * server construction, or on every connect attempt as a socket error. The library's error becomes
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
