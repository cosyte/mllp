/**
 * MLLP frame encoder, canonical `VT + payload + FS + CR` wrapping.
 *
 * The encoder is a **strict emitter** (Postel's Law: conservative on write).
 * There is no option to loosen the output format, it always emits canonical framing.
 * Tolerance for delimiter bytes in the payload is available via `allowDelimiterBytesInPayload`,
 * which passes bytes through verbatim and emits an `MllpWarning` for each offending byte.
 *
 * @example
 * ```typescript
 * import { encodeFrame } from '@cosyte/mllp';
 * const frame = encodeFrame(Buffer.from('MSH|^~\\&|...'));
 * // frame[0] === 0x0B (VT), frame[frame.length - 2] === 0x1C (FS), frame[frame.length - 1] === 0x0D (CR)
 * ```
 *
 * @packageDocumentation
 */

import { VT, FS, CR } from "./constants.js";
import { MllpFramingError } from "./error.js";
import { createWarning } from "./registry.js";
import type { MllpWarning } from "./registry.js";

/**
 * Options for {@link encodeFrame}.
 *
 * @example
 * ```typescript
 * const frame = encodeFrame(payload, {
 *   allowDelimiterBytesInPayload: true,
 *   onWarning: (w) => logger.warn(w),
 * });
 * ```
 */
export interface EncoderOptions {
  /**
   * When `true`, VT (0x0B) or FS (0x1C) bytes within the payload are preserved
   * verbatim in the output frame instead of throwing `MllpFramingError`.
   * An `MllpWarning` is emitted per offending byte if `onWarning` is provided.
   *
   * Default: `false` (strict, throws on delimiter bytes).
   */
  allowDelimiterBytesInPayload?: boolean;

  /**
   * Called for each offending delimiter byte when `allowDelimiterBytesInPayload` is `true`.
   * Invocation is wrapped in try/catch, a throwing handler does not interrupt encoding.
   *
   * @example
   * ```typescript
   * const frame = encodeFrame(payload, {
   *   allowDelimiterBytesInPayload: true,
   *   onWarning: (w) => logger.warn({ code: w.code, offset: w.byteOffset }),
   * });
   * ```
   */
  onWarning?: (w: MllpWarning) => void;
}

/**
 * Encode `payload` in canonical MLLP framing: `VT (0x0B) + payload + FS (0x1C) + CR (0x0D)`.
 *
 * Strict by default: throws `MllpFramingError` if the payload contains VT or FS bytes.
 * Set `{ allowDelimiterBytesInPayload: true }` to pass those bytes through verbatim
 * and receive an `MllpWarning` per offending byte via `onWarning` instead.
 *
 * The returned Buffer has length `payload.length + 3`. Bytes at positions 1 through
 * `payload.length` are an exact copy of the payload (independent of the input buffer).
 *
 * @throws {MllpFramingError} with code `MLLP_PAYLOAD_CONTAINS_VT` when payload contains
 *   byte `0x0B` and `allowDelimiterBytesInPayload` is `false` (default).
 * @throws {MllpFramingError} with code `MLLP_PAYLOAD_CONTAINS_FS` when payload contains
 *   byte `0x1C` and `allowDelimiterBytesInPayload` is `false` (default).
 *
 * @example
 * ```typescript
 * import { encodeFrame } from '@cosyte/mllp';
 *
 * // Strict (default), throws on delimiter bytes in payload
 * const frame = encodeFrame(Buffer.from('MSH|^~\\&|SEND|FAC|RECV|FAC|...'));
 * socket.write(frame);
 *
 * // Tolerant, passes delimiter bytes through with a warning
 * const frame2 = encodeFrame(dirtyPayload, {
 *   allowDelimiterBytesInPayload: true,
 *   onWarning: (w) => logger.warn(w),
 * });
 * ```
 */
export function encodeFrame(payload: Buffer, opts?: EncoderOptions): Buffer {
  const allow = opts?.allowDelimiterBytesInPayload === true;
  const onWarning = opts?.onWarning;

  // Scan for delimiter bytes, required to ensure correct framing (FRAME-03). A byte array is
  // searched natively for each delimiter; anything else a JavaScript caller passes is read one
  // element at a time, as every payload always was, so even that misuse behaves as before.
  if (!(payload instanceof Uint8Array)) {
    scanEachByte(payload, allow, onWarning);
  } else if (!allow || onWarning !== undefined) {
    // Each delimiter's next position, visited in payload order: the strict path stops at the
    // first, the tolerant path warns for every one. Tolerant with no handler reads nothing.
    let vt = payload.indexOf(VT);
    let fs = payload.indexOf(FS);
    while (vt !== -1 || fs !== -1) {
      const isVt = fs === -1 || (vt !== -1 && vt < fs);
      const i = isVt ? vt : fs;
      delimiterAt(isVt ? VT : FS, i, allow, onWarning);
      if (isVt) vt = payload.indexOf(VT, i + 1);
      else fs = payload.indexOf(FS, i + 1);
    }
  }

  // Allocate output: VT + payload + FS + CR, canonical, immutable shape (FRAME-03).
  // allocUnsafe is safe here because all bytes are set before the buffer is returned.
  const frame = Buffer.allocUnsafe(payload.length + 3);
  frame[0] = VT;
  payload.copy(frame, 1);
  frame[payload.length + 1] = FS;
  frame[payload.length + 2] = CR;
  return frame;
}

/** The byte-at-a-time scan, for a payload that is not a byte array. */
function scanEachByte(
  payload: ArrayLike<unknown>,
  allow: boolean,
  onWarning: ((w: MllpWarning) => void) | undefined,
): void {
  for (let i = 0; i < payload.length; i++) {
    const byte = payload[i];
    if (byte === VT || byte === FS) delimiterAt(byte, i, allow, onWarning);
  }
}

/**
 * A delimiter byte at payload offset `i`: refused with `MllpFramingError` on the strict path,
 * passed through with a warning on the tolerant one.
 */
function delimiterAt(
  byte: typeof VT | typeof FS,
  i: number,
  allow: boolean,
  onWarning: ((w: MllpWarning) => void) | undefined,
): void {
  const code = byte === VT ? "MLLP_PAYLOAD_CONTAINS_VT" : "MLLP_PAYLOAD_CONTAINS_FS";

  if (!allow) {
    // PHI: the snippet must NOT carry the surrounding payload bytes, that is a
    // field-body slice of clinical content on a public error field (MLLP-9 PHI
    // audit, mirroring the decoder's MLLP_FRAME_TOO_LARGE fix). The offending byte
    // is itself a framing delimiter (VT/FS, a control byte, never PHI); the `code`
    // already names which and the offset is on the error, so the snippet is just
    // that one boundary byte.
    throw new MllpFramingError(code, i, Buffer.from([byte]));
  }

  // Tolerant path: emit warning and continue, bytes pass through verbatim.
  if (onWarning !== undefined) {
    const byteHex = byte === VT ? "0x0B" : "0x1C";
    const warning = createWarning(
      code,
      i,
      `Payload contains ${byte === VT ? "VT" : "FS"} byte (${byteHex}) at offset ${i}; frame will be ambiguous`,
    );
    try {
      onWarning(warning);
    } catch {
      // WARN-06: a throwing handler must not interrupt encoding.
    }
  }
}
