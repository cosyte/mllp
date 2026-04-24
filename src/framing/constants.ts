/**
 * MLLP framing byte constants.
 *
 * All byte values match the MLLP v1 wire protocol as specified in HL7 appendix C.
 *
 * @example
 * ```typescript
 * import { VT, FS, CR } from '@cosyte/hl7-mllp';
 * // VT = 0x0B, FS = 0x1C, CR = 0x0D
 * ```
 *
 * @packageDocumentation
 */

/** Vertical Tab (0x0B) — marks the start of an MLLP frame. */
export const VT = 0x0b;

/** File Separator (0x1C) — marks the end of MLLP payload bytes. */
export const FS = 0x1c;

/** Carriage Return (0x0D) — terminates the FS byte; together FS+CR ends the frame. */
export const CR = 0x0d;

/** Line Feed (0x0A) — used by the MLLP_LF_AFTER_FS tolerance (FRAME-08). */
export const LF = 0x0a;

/**
 * Default maximum accumulated payload size in bytes (16 MiB).
 *
 * Exceeding this limit throws `MllpFramingError('MLLP_FRAME_TOO_LARGE')`.
 * Satisfies FRAME-11 DoS prevention requirement.
 */
export const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024;
