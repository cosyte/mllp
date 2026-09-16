/**
 * Typed TLS **configuration** errors and their stable codes.
 *
 * A configuration error is raised before any socket exists: what this package
 * was asked to offer cannot be honoured, so the connection is refused rather
 * than opened on some other configuration. Two things can be asked for, and
 * they carry separate codes: the offered cipher-suite list, and the server's
 * ephemeral Diffie-Hellman parameters. It rejects the `connect()` / `listen()`
 * call that asked for it, never a live connection.
 *
 * These codes are a **public API**. They appear in caller `catch` blocks, log
 * pipelines, and monitoring dashboards. Renaming or removing a code is a
 * breaking change (the same guardrail the security-warning codes carry).
 *
 * @example
 * ```typescript
 * import { MllpTlsConfigurationError, MLLP_TLS_CIPHER_LIST_REJECTED } from '@cosyte/mllp';
 * try {
 *   await client.connect();
 * } catch (err) {
 *   if (err instanceof MllpTlsConfigurationError && err.code === MLLP_TLS_CIPHER_LIST_REJECTED) {
 *     logger.error({ code: err.code });
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * The runtime refused the cipher-suite list it was handed: no suite in it is
 * available in this Node build's TLS library. Nothing falls back to the
 * runtime default list, the connection or the bind is refused instead.
 *
 * @example
 * ```typescript
 * import { MLLP_TLS_CIPHER_LIST_REJECTED } from '@cosyte/mllp';
 * if (err.code === MLLP_TLS_CIPHER_LIST_REJECTED) process.exit(78); // EX_CONFIG
 * ```
 */
export const MLLP_TLS_CIPHER_LIST_REJECTED = "MLLP_TLS_CIPHER_LIST_REJECTED";

/**
 * Two different offered-suite declarations were made at once:
 * `atnaTransportSecurity: true` fixes the list, and `ciphers` replaces it.
 * Honouring either one silently discards the other, so both are refused.
 *
 * @example
 * ```typescript
 * import { MLLP_TLS_CIPHER_OPTION_CONFLICT } from '@cosyte/mllp';
 * if (err.code === MLLP_TLS_CIPHER_OPTION_CONFLICT) logger.error('pick one of the two');
 * ```
 */
export const MLLP_TLS_CIPHER_OPTION_CONFLICT = "MLLP_TLS_CIPHER_OPTION_CONFLICT";

/**
 * The ephemeral Diffie-Hellman parameters a server supplied are not usable: not
 * PEM content, not a Diffie-Hellman parameter block, or a group the TLS library
 * refuses. Distinct from {@link MLLP_TLS_CIPHER_LIST_REJECTED} because the
 * remedy is different: one is the offered suite list, the other is the key
 * exchange behind it.
 *
 * Nothing is bound and nothing falls back to a server running with no
 * Diffie-Hellman parameters, which would advertise its DHE suites and then fail
 * every handshake in them.
 *
 * @example
 * ```typescript
 * import { MLLP_TLS_DH_PARAMETERS_REJECTED } from '@cosyte/mllp';
 * if (err.code === MLLP_TLS_DH_PARAMETERS_REJECTED) process.exit(78); // EX_CONFIG
 * ```
 */
export const MLLP_TLS_DH_PARAMETERS_REJECTED = "MLLP_TLS_DH_PARAMETERS_REJECTED";

/**
 * Union of the stable TLS-configuration error codes.
 *
 * @example
 * ```typescript
 * const code: TlsConfigurationErrorCode = 'MLLP_TLS_CIPHER_LIST_REJECTED';
 * ```
 */
export type TlsConfigurationErrorCode =
  | typeof MLLP_TLS_CIPHER_LIST_REJECTED
  | typeof MLLP_TLS_CIPHER_OPTION_CONFLICT
  | typeof MLLP_TLS_DH_PARAMETERS_REJECTED;

/**
 * Frozen message registry for {@link TlsConfigurationErrorCode}.
 *
 * Deliberately a **lookup, never an interpolation**. The factory below takes
 * only a code and no value parameter at all, which is what keeps caller-supplied
 * material (a key, a passphrase, a cipher string) out of an error message that
 * lands in a log.
 */
const TLS_CONFIGURATION_MESSAGES: Readonly<Record<TlsConfigurationErrorCode, string>> =
  Object.freeze({
    [MLLP_TLS_CIPHER_LIST_REJECTED]:
      "the TLS library rejected the configured cipher-suite list; no connection was opened and " +
      "no fallback to the runtime default list was made",
    [MLLP_TLS_CIPHER_OPTION_CONFLICT]:
      "tls.atnaTransportSecurity and tls.ciphers both declare the offered cipher-suite list; " +
      "set exactly one of them",
    [MLLP_TLS_DH_PARAMETERS_REJECTED]:
      "the configured ephemeral Diffie-Hellman parameters are not usable; nothing was bound and " +
      "no fallback to a server without Diffie-Hellman parameters was made",
  });

/**
 * Fixed, human-readable description for a TLS-configuration code.
 *
 * Byte-for-byte identical for a given code, whatever the configuration was.
 *
 * @param code - The stable configuration-error code.
 * @returns The frozen registry text for `code`.
 *
 * @example
 * ```typescript
 * import { tlsConfigurationMessage, MLLP_TLS_CIPHER_OPTION_CONFLICT } from '@cosyte/mllp';
 * logger.error(tlsConfigurationMessage(MLLP_TLS_CIPHER_OPTION_CONFLICT));
 * ```
 */
export function tlsConfigurationMessage(code: TlsConfigurationErrorCode): string {
  return TLS_CONFIGURATION_MESSAGES[code];
}

/**
 * Thrown for a TLS configuration this package will not open a connection on.
 * Rejects the originating `MllpClient.connect()` or `MllpServer.listen()`; no
 * socket is opened and no listener is left bound.
 *
 * Identify it by `instanceof` **and** by the stable {@link MllpTlsConfigurationError.code},
 * never by matching on the message text. `message` is a frozen registry entry
 * and carries no key material and no passphrase; `cause`, when present, is the
 * TLS library's own error for one input on its own (the suite list and the
 * Diffie-Hellman parameters are each validated with no credential in scope).
 *
 * @example
 * ```typescript
 * import { MllpTlsConfigurationError } from '@cosyte/mllp';
 * try {
 *   await server.listen(2575);
 * } catch (err) {
 *   if (err instanceof MllpTlsConfigurationError) logger.error({ code: err.code });
 * }
 * ```
 */
export class MllpTlsConfigurationError extends Error {
  override readonly name = "MllpTlsConfigurationError" as const;

  /**
   * The stable configuration-error code. Public API; branch on this rather
   * than on the message.
   */
  readonly code: TlsConfigurationErrorCode;

  /**
   * The TLS library's own error, when the runtime is what refused the list.
   * `undefined` when this package refused the configuration itself.
   */
  override readonly cause: Error | undefined;

  /**
   * Construct a TLS configuration error.
   *
   * @param code - The stable configuration-error code; also selects the message.
   * @param opts - Optional underlying `cause` from the TLS library.
   */
  constructor(code: TlsConfigurationErrorCode, opts?: { cause?: Error }) {
    super(tlsConfigurationMessage(code));
    this.code = code;
    this.cause = opts?.cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpTlsConfigurationError);
    }
  }
}
