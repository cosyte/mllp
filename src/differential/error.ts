/**
 * Typed **configuration** error for the differential harness, and its stable code.
 *
 * A configuration error is raised before any socket exists: the peer address the caller
 * supplied cannot be resolved into a host and a port, so the run is refused rather than
 * quietly skipped. Skipping it would be the worse answer by far, because a skip is what
 * "no peer configured" means, and a developer who mistyped an address would read the skip
 * as proof the harness ran.
 *
 * This code is a **public API**. It appears in caller `catch` blocks, log pipelines and
 * monitoring dashboards. Renaming or removing it is a breaking change, the same guardrail
 * the framing warning codes and the security-warning codes carry.
 *
 * @example
 * ```typescript
 * import { MllpDifferentialConfigurationError, runDifferential } from '@cosyte/mllp';
 * try {
 *   await runDifferential({ peer: process.env['MLLP_DIFF_PEER'] });
 * } catch (err) {
 *   if (err instanceof MllpDifferentialConfigurationError) {
 *     logger.error({ code: err.code, value: err.value });
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * A peer address was configured and could not be resolved into a host and a port.
 *
 * Distinct from no peer at all, which is not an error and skips the run.
 *
 * @example
 * ```typescript
 * import { MLLP_DIFF_PEER_UNPARSEABLE } from '@cosyte/mllp';
 * if (err.code === MLLP_DIFF_PEER_UNPARSEABLE) process.exit(78); // EX_CONFIG
 * ```
 */
export const MLLP_DIFF_PEER_UNPARSEABLE = "MLLP_DIFF_PEER_UNPARSEABLE";

/**
 * Union of the stable differential-configuration error codes.
 *
 * @example
 * ```typescript
 * const code: DifferentialConfigurationErrorCode = 'MLLP_DIFF_PEER_UNPARSEABLE';
 * ```
 */
export type DifferentialConfigurationErrorCode = typeof MLLP_DIFF_PEER_UNPARSEABLE;

/**
 * Frozen message registry for {@link DifferentialConfigurationErrorCode}.
 *
 * A lookup, never an interpolation of anything off the wire. The offending value the
 * factory appends is the address the CALLER configured, which is deployment configuration
 * in the same class as a hostname in a connection error, and the run is refused before a
 * byte of anyone's traffic exists.
 */
const DIFFERENTIAL_CONFIGURATION_MESSAGES: Readonly<
  Record<DifferentialConfigurationErrorCode, string>
> = Object.freeze({
  [MLLP_DIFF_PEER_UNPARSEABLE]:
    "the configured differential peer address could not be resolved into a host and a port, " +
    "so the run was refused rather than skipped; expected the form host:port",
});

/**
 * Fixed, human-readable description for a differential-configuration code.
 *
 * Byte-for-byte identical for a given code, whatever was configured.
 *
 * @param code - The stable configuration-error code.
 * @returns The frozen registry text for `code`.
 *
 * @example
 * ```typescript
 * import { differentialConfigurationMessage, MLLP_DIFF_PEER_UNPARSEABLE } from '@cosyte/mllp';
 * logger.error(differentialConfigurationMessage(MLLP_DIFF_PEER_UNPARSEABLE));
 * ```
 */
export function differentialConfigurationMessage(code: DifferentialConfigurationErrorCode): string {
  return DIFFERENTIAL_CONFIGURATION_MESSAGES[code];
}

/**
 * Thrown when the differential harness is configured with a peer address it cannot use.
 *
 * Rejects the originating `runDifferential()` call. No socket is opened, no canonical
 * message is sent, and no report is produced: there is nothing to report about.
 *
 * Identify it by `instanceof` **and** by the stable
 * {@link MllpDifferentialConfigurationError.code}, never by matching on the message text.
 *
 * @example
 * ```typescript
 * import { MllpDifferentialConfigurationError } from '@cosyte/mllp';
 * try {
 *   await runDifferential({ peer: 'not-an-address' });
 * } catch (err) {
 *   if (err instanceof MllpDifferentialConfigurationError) logger.error({ value: err.value });
 * }
 * ```
 */
export class MllpDifferentialConfigurationError extends Error {
  override readonly name = "MllpDifferentialConfigurationError" as const;

  /**
   * The stable configuration-error code. Public API; branch on this rather than on the
   * message.
   */
  readonly code: DifferentialConfigurationErrorCode;

  /**
   * The offending value exactly as it was configured, so the operator can see which of
   * their settings is wrong without guessing. It is caller configuration, never anything
   * read off a peer.
   */
  readonly value: string;

  /**
   * Construct a differential configuration error.
   *
   * @param code - The stable configuration-error code; also selects the message.
   * @param value - The offending configured value, reported verbatim.
   */
  constructor(code: DifferentialConfigurationErrorCode, value: string) {
    super(`${differentialConfigurationMessage(code)}; got: ${JSON.stringify(value)}`);
    this.code = code;
    this.value = value;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpDifferentialConfigurationError);
    }
  }
}
