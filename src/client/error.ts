/**
 * MLLP Client typed errors and classifiers.
 *
 * Exports:
 * - `MllpTimeoutError` (PLAN-02) — ACK timeout (ERR-02)
 * - `MllpBackpressureError` (PLAN-05) — high-water mark exceeded (ERR-04)
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
 *     console.log('timed out after', err.elapsedMs, 'ms; controlId:', err.messageControlId);
 *   }
 * }
 * ```
 */
export class MllpTimeoutError extends Error {
  override readonly name = 'MllpTimeoutError' as const;

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

// PLAN-04 fills: isTransientConnectionError (CLIENT-18)
// PLAN-05 fills: MllpBackpressureError (ERR-04)
