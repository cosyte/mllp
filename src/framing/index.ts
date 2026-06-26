/**
 * MLLP framing codec — canonical MLLP v1 frame encoder and chunked decoder.
 *
 * Implements the VT/FS/CR framing protocol defined in HL7 Appendix C.
 * The encoder is strict (Postel's Law: conservative on write).
 * The decoder is strict by default; tolerance opt-ins are explicit.
 *
 * @example
 * ```typescript
 * import { encodeFrame, FrameReader } from '@cosyte/mllp';
 * const reader = new FrameReader({ onFrame: (payload) => handleMessage(payload) });
 * socket.on('data', (chunk) => reader.push(chunk));
 * ```
 *
 * @packageDocumentation
 */

export type { WarningCode, MllpWarning } from "./registry.js";
export { createWarning } from "./registry.js";
export { MllpFramingError } from "./error.js";
export { encodeFrame } from "./encoder.js";
export type { EncoderOptions } from "./encoder.js";
export { FrameReader } from "./decoder.js";
export type { FrameReaderOptions } from "./decoder.js";
