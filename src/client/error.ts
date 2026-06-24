/**
 * MLLP Client typed errors and classifiers.
 *
 * Exports:
 * - `MllpTimeoutError` (PLAN-02) — ACK timeout (ERR-02)
 * - `MllpBackpressureError` — high-water mark exceeded (ERR-04, plan 05)
 * - `isTransientConnectionError` (PLAN-04) — transient/permanent classifier (CLIENT-18)
 *
 * Re-exported from `src/client/index.ts` and `src/index.ts`.
 *
 * @packageDocumentation
 */

/**
 * Thrown (or rejects the `send()` promise) when an ACK does not arrive within
 * the configured `ackTimeoutMs` (ERR-02).
 *
 * The timeout clock starts at the underlying `write()` flush callback, NOT
 * at the `send()` call — pre-flush queue time is not charged to the peer
 * (CLIENT-04).
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpTimeoutError) {
 *     logger.warn({ elapsedMs: err.elapsedMs, controlId: err.messageControlId });
 *   }
 * }
 * ```
 */
export class MllpTimeoutError extends Error {
  override readonly name = "MllpTimeoutError" as const;

  /** MSH-10 control ID of the timed-out send (FIFO mode: `undefined`). */
  readonly messageControlId: string | undefined;

  /** Milliseconds elapsed between write-flush and timeout fire. */
  readonly elapsedMs: number;

  /** Epoch ms timestamp recorded at write-flush callback. */
  readonly sentAt: number;

  constructor(
    message: string,
    opts: {
      messageControlId: string | undefined;
      elapsedMs: number;
      sentAt: number;
    },
  ) {
    super(message);
    this.messageControlId = opts.messageControlId;
    this.elapsedMs = opts.elapsedMs;
    this.sentAt = opts.sentAt;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpTimeoutError);
    }
  }
}

/**
 * Classifies a connection error as transient (eligible for auto-reconnect)
 * or permanent (halts auto-reconnect, transitions to CLOSED).
 *
 * Used internally by `MllpClient` BEFORE invoking `retryStrategy` (Composition A
 * — see `RetryContext.classifiedAs`). Re-exported so callers can implement
 * their own retry policies.
 *
 * Classification table (CLIENT-18, D-16):
 * - `ENOTFOUND`, `EACCES` → **permanent** (`false`)
 * - `ECONNREFUSED`, `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`,
 *   `ENETUNREACH`, `EPIPE` → **transient** (`true`)
 * - `CERT_*` and `UNABLE_TO_VERIFY_LEAF_SIGNATURE` /
 *   `DEPTH_ZERO_SELF_SIGNED_CERT` / `SELF_SIGNED_CERT_IN_CHAIN`
 *   → **permanent** (`false`)
 * - non-Error / unknown / no-code → **transient** (`true`) — Postel's Law
 *   default. Reconnect attempts are bounded by `retryStrategy` and the
 *   30s backoff cap, so the default is safe.
 *
 * @example
 * ```typescript
 * import { isTransientConnectionError } from '@cosyte/hl7-mllp';
 * client.on('error', (err) => {
 *   if (isTransientConnectionError(err)) {
 *     metrics.increment('mllp.transient_error');
 *   } else {
 *     metrics.increment('mllp.permanent_error');
 *   }
 * });
 * ```
 */
export function isTransientConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return true;
  const code = (err as { code?: unknown }).code;
  if (typeof code !== "string") return true;
  switch (code) {
    case "ENOTFOUND":
    case "EACCES":
      return false;
    case "ECONNREFUSED":
    case "ECONNRESET":
    case "ETIMEDOUT":
    case "EHOSTUNREACH":
    case "ENETUNREACH":
    case "EPIPE":
      return true;
    default:
      // TLS cert error codes (CERT_*) and *_VERIFY_* names → permanent.
      if (code.startsWith("CERT_")) return false;
      if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE") return false;
      if (code === "DEPTH_ZERO_SELF_SIGNED_CERT") return false;
      if (code === "SELF_SIGNED_CERT_IN_CHAIN") return false;
      // Default: transient (Postel's Law — be permissive about peer behavior).
      return true;
  }
}

/**
 * Thrown (or rejects the `send()` promise) when the in-flight queue exceeds
 * the configured high-water mark and `onBackpressure: 'reject'` is set
 * (CLIENT-07, ERR-04).
 *
 * `highWaterMark` accepts a count cap, a byte cap, or both — when both are
 * present, the stricter-of-two trigger wins (D-23).
 *
 * @example
 * ```typescript
 * try {
 *   await client.send(payload);
 * } catch (err) {
 *   if (err instanceof MllpBackpressureError) {
 *     logger.warn({
 *       queueDepth: err.queueDepth,
 *       queueBytes: err.queueBytes,
 *       cap: err.highWaterMark,
 *     });
 *   }
 * }
 * ```
 */
export class MllpBackpressureError extends Error {
  override readonly name = "MllpBackpressureError" as const;

  /** Number of in-flight + queued sends at the moment of rejection. */
  readonly queueDepth: number;

  /** Total bytes of in-flight + queued frames at the moment of rejection. */
  readonly queueBytes: number;

  /** The high-water-mark configuration that was triggered (D-23). */
  readonly highWaterMark: { readonly count?: number; readonly bytes?: number };

  constructor(
    message: string,
    opts: {
      queueDepth: number;
      queueBytes: number;
      highWaterMark: { count?: number; bytes?: number };
    },
  ) {
    super(message);
    this.queueDepth = opts.queueDepth;
    this.queueBytes = opts.queueBytes;
    this.highWaterMark = opts.highWaterMark;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpBackpressureError);
    }
  }
}
