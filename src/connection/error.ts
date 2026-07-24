/**
 * Typed error for socket-layer connection problems.
 *
 * @example
 * ```typescript
 * import { MllpConnectionError } from '@cosyte/mllp';
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
export type ConnectionErrorPhase = "connect" | "send" | "receive" | "close" | "reconnect";

/**
 * Stable cause codes for `MllpConnectionError`.
 *
 * These codes are a **public API**, they appear in error inspection
 * by callers, log pipelines, and monitoring dashboards. Renaming or
 * removing a member is a breaking change.
 *
 * - `'fifo-unsafe'`, A queued send was rejected during reconnect because
 *   FIFO ordering cannot be safely resumed across sessions (CLIENT-17).
 * - `'in-flight-orphan'`, An in-flight send (already write-flushed,
 *   ACK timer started) was rejected during reconnect in FIFO mode because
 *   the at-most-once delivery contract cannot be preserved across a
 *   socket drop (D-08, healthcare medication/orders semantics).
 * - `'tls-verify'` (Phase 8), The TLS handshake failed certificate
 *   verification (untrusted chain, expired/not-yet-valid cert, hostname
 *   mismatch, revocation, …). See {@link isTlsVerificationErrorCode} for the
 *   exact underlying error codes. Classified **permanent** by
 *   `isTransientConnectionError`, never auto-reconnect-looped into a
 *   misconfigured or MITM'd endpoint.
 * - `'tls-handshake'` (Phase 8), A TLS-**protocol**-shaped handshake
 *   failure observed before `'secureConnect'`: `ERR_SSL_*` codes, `EPROTO`,
 *   or an OpenSSL alert-bearing error (protocol version mismatch, no shared
 *   cipher, a required mutual-TLS client certificate rejected by the
 *   server, …). See `isTlsProtocolError` for the boundary. Pure TCP-level
 *   failures (`ECONNREFUSED`, `ETIMEDOUT`, …) on a TLS-configured
 *   connection carry **no** `connectionCause`, the same shape as plaintext.
 *
 * Scope note: the `'tls-verify'`/`'tls-handshake'` values are attached on
 * the client's **initial `connect()` path**. Failures on the auto-reconnect
 * path surface as raw socket errors, their transient/permanent
 * classification still applies, but they do not (yet) carry a
 * `connectionCause`.
 *
 * @example
 * ```typescript
 * if (err instanceof MllpConnectionError && err.connectionCause === 'in-flight-orphan') {
 *   // Treat as at-most-once: do NOT auto-retry; bubble up to caller for
 *   // application-level dedupe / replay decisions.
 * }
 * ```
 */
export type ConnectionErrorCause =
  | "fifo-unsafe"
  | "in-flight-orphan"
  | "tls-verify"
  | "tls-handshake"
  | "framing-fatal";

/**
 * Thrown (or emitted via `onError`) for socket-layer problems such as
 * connection refused, ECONNRESET, ETIMEDOUT, or DNS failure.
 *
 * - `cause`, the original OS or TLS error
 * - `phase`, which connection lifecycle phase the failure occurred in
 * - `connectionCause`, optional stable cause-code (e.g. for FIFO reconnect rejections)
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
  override readonly name = "MllpConnectionError" as const;

  /** The original OS or TLS error that caused this connection failure. */
  override readonly cause: Error;

  /** Which connection lifecycle phase the failure occurred in. */
  readonly phase: ConnectionErrorPhase;

  /**
   * Optional stable cause code. Present on FIFO reconnect rejections
   * (`'fifo-unsafe'` for queued sends, `'in-flight-orphan'` for in-flight sends).
   *
   * The set of values is a **public API**; see {@link ConnectionErrorCause}.
   */
  readonly connectionCause?: ConnectionErrorCause;

  /**
   * Construct an MLLP connection error.
   *
   * @param message - Human-readable error message.
   * @param opts - Error context (underlying `cause`, the lifecycle `phase`, optional stable cause code).
   */
  constructor(
    message: string,
    opts: {
      cause: Error;
      phase: ConnectionErrorPhase;
      connectionCause?: ConnectionErrorCause;
    },
  ) {
    super(message);
    this.cause = opts.cause;
    this.phase = opts.phase;
    if (opts.connectionCause !== undefined) {
      this.connectionCause = opts.connectionCause;
    }
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpConnectionError);
    }
  }
}
