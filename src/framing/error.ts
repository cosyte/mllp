/**
 * Typed framing error class for unrecoverable MLLP wire-format violations.
 *
 * @example
 * ```typescript
 * import { MllpFramingError } from '@cosyte/hl7-mllp';
 * try {
 *   encodeFrame(payloadWithVt);
 * } catch (err) {
 *   if (err instanceof MllpFramingError) {
 *     logger.error({ code: err.code, offset: err.byteOffset });
 *   }
 * }
 * ```
 *
 * @packageDocumentation
 */

import type { WarningCode } from './registry.js';

/** Maximum number of bytes captured in the `snippet` field. */
const MAX_SNIPPET_BYTES = 64;

/**
 * Thrown for unrecoverable MLLP wire-format violations.
 *
 * - `code` — stable `WarningCode` identifying the violation
 * - `byteOffset` — absolute stream position where the violation was detected
 * - `snippet` — up to 64 bytes copied from around the anomaly (isolated from source buffer reuse)
 *
 * @example
 * ```typescript
 * throw new MllpFramingError('MLLP_FRAME_TOO_LARGE', byteOffset, chunk.subarray(0, 64));
 * ```
 */
export class MllpFramingError extends Error {
  override readonly name = 'MllpFramingError' as const;

  /** Stable warning code identifying the violation type. */
  readonly code: WarningCode;

  /** Absolute byte offset in the stream where the error was detected. */
  readonly byteOffset: number;

  /**
   * Up to 64 bytes copied from around the anomaly.
   *
   * This is a **copied** Buffer — isolated from the source buffer so it remains
   * valid after the underlying buffer is reused or overwritten.
   */
  readonly snippet: Buffer;

  constructor(
    code: WarningCode,
    byteOffset: number,
    /** Raw bytes around the anomaly. Capped to MAX_SNIPPET_BYTES (64). */
    snippet: Buffer,
    message?: string,
  ) {
    super(message ?? `MLLP framing error: ${code} at byte offset ${byteOffset}`);
    this.code = code;
    this.byteOffset = byteOffset;
    // Copy and cap — error must outlive source buffer; never store a view.
    this.snippet = Buffer.from(snippet.subarray(0, MAX_SNIPPET_BYTES));
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpFramingError);
    }
  }
}
