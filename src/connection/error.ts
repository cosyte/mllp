/**
 * Typed error for socket-layer connection problems.
 *
 * @example
 * ```typescript
 * import { MllpConnectionError } from '@cosyte/hl7-mllp';
 * try {
 *   await client.connect();
 * } catch (err) {
 *   if (err instanceof MllpConnectionError) {
 *     console.log(err.phase, err.cause);
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

/**
 * Connection lifecycle phase where the error occurred.
 *
 * All 5 phases are defined in Phase 3 even though `'reconnect'` is only
 * exercised in Phase 5 (CLIENT-17). Locking the full union now prevents a
 * breaking type change later (ERR-03).
 */
export type ConnectionErrorPhase =
  | 'connect'
  | 'send'
  | 'receive'
  | 'close'
  | 'reconnect';

/**
 * Thrown (or emitted via `onError`) for socket-layer problems such as
 * connection refused, ECONNRESET, ETIMEDOUT, or DNS failure.
 *
 * - `cause` — the original OS or TLS error
 * - `phase` — which connection lifecycle phase the failure occurred in
 *
 * @example
 * ```typescript
 * throw new MllpConnectionError('Connection refused', {
 *   cause: osError,
 *   phase: 'connect',
 * });
 * ```
 */
export class MllpConnectionError extends Error {
  override readonly name = 'MllpConnectionError' as const;

  /** The original OS or TLS error that caused this connection failure. */
  override readonly cause: Error;

  /** Which connection lifecycle phase the failure occurred in. */
  readonly phase: ConnectionErrorPhase;

  constructor(
    message: string,
    opts: { cause: Error; phase: ConnectionErrorPhase },
  ) {
    super(message);
    this.cause = opts.cause;
    this.phase = opts.phase;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpConnectionError);
    }
  }
}
