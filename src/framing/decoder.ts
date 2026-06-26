/**
 * MLLP frame decoder — stateful 3-state FSM for chunked byte-stream parsing.
 *
 * Feed raw TCP chunks via `push(chunk)`. Complete MLLP frames fire synchronously
 * via the `onFrame` callback during each `push()` call.
 *
 * The decoder is **strict by default**: any framing deviation throws `MllpFramingError`
 * unless the matching tolerance option is explicitly enabled (Postel's Law — liberal receiver
 * means explicit tolerance, not silent acceptance).
 *
 * @example
 * ```typescript
 * import { FrameReader } from '@cosyte/mllp';
 * const reader = new FrameReader({
 *   onFrame: (payload) => handleMessage(payload),
 *   onWarning: (w) => logger.warn(w),
 *   allowFsOnly: true,
 * });
 * socket.on('data', (chunk) => reader.push(chunk));
 * socket.on('close', () => reader.reset());
 * ```
 *
 * @packageDocumentation
 */

import { VT, FS, CR, LF, DEFAULT_MAX_FRAME_SIZE } from "./constants.js";
import { MllpFramingError } from "./error.js";
import { createWarning } from "./registry.js";
import type { MllpWarning, WarningCode } from "./registry.js";

/** Internal FSM states. */
type ReaderState = "SCANNING_FOR_VT" | "READING_PAYLOAD" | "EXPECTING_CR";

/** Initial accumulator buffer size (4 KiB). Grows by doubling as needed. */
const INITIAL_ACCUMULATOR_SIZE = 4096;

/**
 * Options for `FrameReader`.
 *
 * All tolerance opts default to `false` — every framing deviation throws unless
 * explicitly enabled. Server-level defaults (allowFsOnly, allowLfAfterFs, allowLeadingWhitespace)
 * are applied by Phase 4 when constructing readers per SERVER-12.
 *
 * @example
 * ```typescript
 * const opts: FrameReaderOptions = {
 *   onFrame: (payload, byteOffset, warnings) => process(payload, byteOffset, warnings),
 *   onWarning: (w) => logger.warn(w),
 *   maxFrameSizeBytes: 4 * 1024 * 1024, // 4 MiB limit
 *   allowFsOnly: true,
 *   allowLfAfterFs: true,
 * };
 * ```
 */
export interface FrameReaderOptions {
  /**
   * Called synchronously during `push()` for each complete MLLP payload.
   *
   * @param payload - Raw MLLP payload bytes (framing stripped).
   * @param byteOffset - Stream byte offset of the VT byte that opened this frame.
   *   Monotonic across the connection lifetime; reset to 0 by `reset()`.
   * @param warnings - Framing warnings emitted during decoding of this specific frame.
   *   Empty array when no tolerance deviations were detected.
   */
  onFrame: (payload: Buffer, byteOffset: number, warnings: readonly MllpWarning[]) => void;
  /**
   * Called for each tolerated framing deviation. Wrapped in try/catch per WARN-06.
   * A throwing handler will not corrupt FSM state.
   */
  onWarning?: (w: MllpWarning) => void;
  /**
   * Maximum accumulated payload bytes before `MllpFramingError('MLLP_FRAME_TOO_LARGE')`.
   * Default: 16 MiB (FRAME-11 DoS prevention).
   */
  maxFrameSizeBytes?: number;
  /** FRAME-07: Tolerate FS without trailing CR; emits `MLLP_FS_WITHOUT_CR`. */
  allowFsOnly?: boolean;
  /** FRAME-08: Tolerate FS+LF instead of FS+CR; emits `MLLP_LF_AFTER_FS`. */
  allowLfAfterFs?: boolean;
  /** FRAME-09: Tolerate missing leading VT; emits `MLLP_MISSING_LEADING_VT`. */
  allowMissingLeadingVt?: boolean;
  /** FRAME-10: Tolerate SP/TAB/LF/CR before VT; emits `MLLP_LEADING_WHITESPACE`. */
  allowLeadingWhitespace?: boolean;
  /**
   * When `true`, escalates the following tolerances to thrown `MllpFramingError`
   * even if individual opt-ins (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`,
   * `allowLeadingWhitespace`) are enabled (WARN-08):
   * - `MLLP_MISSING_LEADING_VT`
   * - `MLLP_FS_WITHOUT_CR`
   * - `MLLP_LF_AFTER_FS`
   * - `MLLP_LEADING_WHITESPACE` (leading whitespace escalates as `MLLP_MISSING_LEADING_VT`)
   *
   * `MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` remain warnings even in strict mode.
   *
   * @example
   * ```typescript
   * // Hardened enforcement — no tolerance, all violations throw
   * const reader = new FrameReader({ onFrame: fn, strict: true });
   * ```
   */
  strict?: boolean;
}

/**
 * Stateful MLLP frame decoder. Feed raw TCP byte chunks via `push(chunk)`.
 * Complete frames fire synchronously via `onFrame` callback during `push()`.
 *
 * The decoder operates as a 3-state FSM:
 * - `SCANNING_FOR_VT` — waiting for the 0x0B frame-start byte
 * - `READING_PAYLOAD` — accumulating payload bytes until FS (0x1C)
 * - `EXPECTING_CR` — received FS, waiting for CR (0x0D) to complete the frame
 *
 * @example
 * ```typescript
 * const reader = new FrameReader({
 *   onFrame: (payload, byteOffset, warnings) => process(payload, byteOffset, warnings),
 *   onWarning: (w) => logger.warn(w),
 * });
 * socket.on('data', (chunk) => reader.push(chunk));
 * ```
 */
export class FrameReader {
  private readonly _opts: FrameReaderOptions;
  private readonly _maxFrameSize: number;

  private _state: ReaderState = "SCANNING_FOR_VT";
  /** Reusable accumulator buffer — grown by doubling as needed. */
  private _accumulator: Buffer = Buffer.allocUnsafe(INITIAL_ACCUMULATOR_SIZE);
  /** Number of payload bytes written to accumulator in current frame. */
  private _writePos = 0;
  /** Monotonic absolute stream byte offset across the entire connection lifetime. */
  private _byteOffset = 0;
  /** Byte offset where current leading-whitespace run started (FRAME-10). */
  private _wsStart = 0;
  /** Count of leading whitespace bytes accumulated in current run (FRAME-10). */
  private _wsCount = 0;
  /** Byte offset of the VT byte that started the current frame. */
  private _frameStartOffset = 0;
  /** Per-frame warning accumulator — cleared after each _deliverFrame(). */
  private _frameWarnings: MllpWarning[] = [];

  /**
   * Construct a chunked MLLP frame reader.
   *
   * @param opts - Reader options (`onFrame`/`onWarning` callbacks, tolerance, `maxFrameSizeBytes`).
   */
  constructor(opts: FrameReaderOptions) {
    this._opts = opts;
    this._maxFrameSize =
      opts.maxFrameSizeBytes !== undefined ? opts.maxFrameSizeBytes : DEFAULT_MAX_FRAME_SIZE;
  }

  /**
   * Feed a chunk of raw TCP bytes into the FSM. Frames fire synchronously via `onFrame`
   * during this call. May throw `MllpFramingError` for unrecoverable framing violations
   * when the matching tolerance is not enabled.
   *
   * @example
   * ```typescript
   * socket.on('data', (chunk) => reader.push(chunk));
   * ```
   */
  push(chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i++, this._byteOffset++) {
      const byte = chunk[i];
      if (byte === undefined) break; // noUncheckedIndexedAccess guard

      this._processByte(byte);
    }
  }

  /**
   * Clear internal accumulator state and reset byte offset to 0.
   *
   * Call on reconnect / connection reuse to start fresh without allocating a new reader (D-03).
   * Pending partial frame state is discarded silently.
   *
   * @example
   * ```typescript
   * socket.on('close', () => reader.reset());
   * ```
   */
  reset(): void {
    this._state = "SCANNING_FOR_VT";
    this._writePos = 0;
    this._byteOffset = 0;
    this._wsStart = 0;
    this._wsCount = 0;
    this._frameStartOffset = 0;
    this._frameWarnings = [];
  }

  private _processByte(byte: number): void {
    switch (this._state) {
      case "SCANNING_FOR_VT":
        this._scanForVt(byte);
        break;
      case "READING_PAYLOAD":
        this._readPayload(byte);
        break;
      case "EXPECTING_CR":
        this._expectCr(byte);
        break;
    }
  }

  private _scanForVt(byte: number): void {
    if (byte === VT) {
      // Emit leading-whitespace warning now that we know whitespace preceded this VT
      if (this._wsCount > 0) {
        this._emitWarning(
          "MLLP_LEADING_WHITESPACE",
          this._wsStart,
          `${this._wsCount} leading whitespace byte(s) before VT at offset ${this._wsStart}`,
        );
        this._wsStart = 0;
        this._wsCount = 0;
      }
      this._frameStartOffset = this._byteOffset;
      this._state = "READING_PAYLOAD";
      return;
    }

    // Check for whitespace bytes: SP (0x20), TAB (0x09), LF (0x0A), CR (0x0D)
    const isWhitespace = byte === 0x20 || byte === 0x09 || byte === LF || byte === CR;

    if (isWhitespace) {
      if (this._opts.allowLeadingWhitespace === true) {
        // Strict mode escalates leading whitespace to an error (WARN-08)
        if (this._opts.strict === true) {
          const snippet = Buffer.from([byte]);
          throw new MllpFramingError(
            "MLLP_MISSING_LEADING_VT",
            this._byteOffset,
            snippet,
            `Strict mode: leading whitespace before VT at offset ${this._byteOffset}`,
          );
        }
        if (this._wsCount === 0) {
          this._wsStart = this._byteOffset;
        }
        this._wsCount++;
        return;
      }
      // Whitespace before VT without tolerance → framing error
      const snippet = Buffer.from([byte]);
      throw new MllpFramingError(
        "MLLP_MISSING_LEADING_VT",
        this._byteOffset,
        snippet,
        `Expected VT (0x0B) to start MLLP frame, got whitespace 0x${byte.toString(16).padStart(2, "0")} at offset ${this._byteOffset}`,
      );
    }

    // Non-VT, non-whitespace byte in SCANNING_FOR_VT.
    // If whitespace was accumulated under allowLeadingWhitespace, emit that warning first.
    if (this._wsCount > 0) {
      this._emitWarning(
        "MLLP_LEADING_WHITESPACE",
        this._wsStart,
        `${this._wsCount} leading whitespace byte(s) before VT at offset ${this._wsStart}`,
      );
      this._wsStart = 0;
      this._wsCount = 0;
    }

    if (this._opts.allowMissingLeadingVt === true) {
      // Strict mode escalates missing leading VT to an error (WARN-08)
      if (this._opts.strict === true) {
        const snippet = Buffer.from([byte]);
        throw new MllpFramingError(
          "MLLP_MISSING_LEADING_VT",
          this._byteOffset,
          snippet,
          `Strict mode: missing leading VT at offset ${this._byteOffset}`,
        );
      }
      // Treat this non-VT byte as the first payload byte
      this._emitWarning(
        "MLLP_MISSING_LEADING_VT",
        this._byteOffset,
        `Missing leading VT (0x0B) — treating byte 0x${byte.toString(16).padStart(2, "0")} at offset ${this._byteOffset} as payload start`,
      );
      this._frameStartOffset = this._byteOffset;
      this._state = "READING_PAYLOAD";
      this._appendByte(byte);
      return;
    }

    // Default: strict framing error
    const snippet = Buffer.from([byte]);
    throw new MllpFramingError(
      "MLLP_MISSING_LEADING_VT",
      this._byteOffset,
      snippet,
      `Expected VT (0x0B) to start MLLP frame, got 0x${byte.toString(16).padStart(2, "0")} at offset ${this._byteOffset}`,
    );
  }

  private _readPayload(byte: number): void {
    if (byte === FS) {
      // End-of-payload marker found
      if (this._writePos === 0) {
        // Empty payload is always a warning (WARN-05), never a throw
        this._emitWarning(
          "MLLP_EMPTY_PAYLOAD",
          this._byteOffset,
          `Empty payload between VT and FS at offset ${this._byteOffset}`,
        );
      }
      this._state = "EXPECTING_CR";
      return;
    }

    if (byte === VT) {
      // VT mid-payload: the current partial payload is abandoned.
      // Emit MLLP_TRAILING_BYTES (always a warning, never a throw) and start fresh.
      this._emitWarning(
        "MLLP_TRAILING_BYTES",
        this._byteOffset,
        `Unexpected VT (0x0B) mid-payload at offset ${this._byteOffset}; discarding ${this._writePos} accumulated bytes`,
      );
      this._writePos = 0;
      // Remain in READING_PAYLOAD — the VT starts a new frame payload accumulation
      this._state = "READING_PAYLOAD";
      return;
    }

    // Regular payload byte — enforce size cap BEFORE appending
    if (this._writePos >= this._maxFrameSize) {
      const snippetStart = Math.max(0, this._writePos - 32);
      const snippet = Buffer.from(this._accumulator.subarray(snippetStart, this._writePos));
      throw new MllpFramingError(
        "MLLP_FRAME_TOO_LARGE",
        this._byteOffset,
        snippet,
        `Frame payload exceeded maxFrameSizeBytes (${this._maxFrameSize}) at offset ${this._byteOffset}`,
      );
    }

    this._appendByte(byte);
  }

  private _expectCr(byte: number): void {
    if (byte === CR) {
      // Normal frame completion
      this._deliverFrame();
      this._state = "SCANNING_FOR_VT";
      return;
    }

    if (byte === LF) {
      if (this._opts.allowLfAfterFs === true) {
        // Strict mode escalates LF after FS to an error (WARN-08)
        if (this._opts.strict === true) {
          const snippet = Buffer.from([byte]);
          throw new MllpFramingError(
            "MLLP_LF_AFTER_FS",
            this._byteOffset,
            snippet,
            `Strict mode: LF after FS at offset ${this._byteOffset}`,
          );
        }
        this._emitWarning(
          "MLLP_LF_AFTER_FS",
          this._byteOffset,
          `LF (0x0A) after FS instead of CR (0x0D) at offset ${this._byteOffset}`,
        );
        this._deliverFrame();
        this._state = "SCANNING_FOR_VT";
        return;
      }
      const snippet = Buffer.from([byte]);
      throw new MllpFramingError(
        "MLLP_LF_AFTER_FS",
        this._byteOffset,
        snippet,
        `Expected CR (0x0D) after FS, got LF (0x0A) at offset ${this._byteOffset}. Enable allowLfAfterFs to tolerate.`,
      );
    }

    if (byte === VT) {
      // Next frame starts immediately after FS — no CR between frames
      if (this._opts.allowFsOnly === true) {
        // Strict mode escalates FS without CR to an error (WARN-08)
        if (this._opts.strict === true) {
          const snippet = Buffer.from([byte]);
          throw new MllpFramingError(
            "MLLP_FS_WITHOUT_CR",
            this._byteOffset,
            snippet,
            `Strict mode: FS without CR at offset ${this._byteOffset}`,
          );
        }
        this._emitWarning(
          "MLLP_FS_WITHOUT_CR",
          this._byteOffset,
          `FS not followed by CR at offset ${this._byteOffset}; next frame VT found immediately`,
        );
        this._deliverFrame();
        // The VT byte is consumed here — transition directly to READING_PAYLOAD
        this._state = "READING_PAYLOAD";
        return;
      }
      const snippet = Buffer.from([byte]);
      throw new MllpFramingError(
        "MLLP_FS_WITHOUT_CR",
        this._byteOffset,
        snippet,
        `Expected CR (0x0D) after FS, got VT (0x0B) at offset ${this._byteOffset}. Enable allowFsOnly to tolerate.`,
      );
    }

    // Any other non-CR byte after FS (not LF, not VT)
    if (this._opts.allowFsOnly === true) {
      // Strict mode escalates FS without CR to an error (WARN-08)
      if (this._opts.strict === true) {
        const snippet = Buffer.from([byte]);
        throw new MllpFramingError(
          "MLLP_FS_WITHOUT_CR",
          this._byteOffset,
          snippet,
          `Strict mode: FS without CR at offset ${this._byteOffset}`,
        );
      }
      // Deliver the frame, emit FS_WITHOUT_CR, then treat the stray byte as trailing
      this._emitWarning(
        "MLLP_FS_WITHOUT_CR",
        this._byteOffset,
        `FS not followed by CR at offset ${this._byteOffset}; got 0x${byte.toString(16).padStart(2, "0")}`,
      );
      this._deliverFrame();
      this._state = "SCANNING_FOR_VT";
      // Emit trailing bytes warning for the stray byte
      this._emitWarning(
        "MLLP_TRAILING_BYTES",
        this._byteOffset,
        `Unexpected byte 0x${byte.toString(16).padStart(2, "0")} after frame terminator at offset ${this._byteOffset}`,
      );
      return;
    }

    const snippet = Buffer.from([byte]);
    throw new MllpFramingError(
      "MLLP_FS_WITHOUT_CR",
      this._byteOffset,
      snippet,
      `Expected CR (0x0D) after FS, got 0x${byte.toString(16).padStart(2, "0")} at offset ${this._byteOffset}`,
    );
  }

  /** Grow the internal accumulator by doubling and write one byte. */
  private _appendByte(byte: number): void {
    if (this._writePos >= this._accumulator.length) {
      const newSize = this._accumulator.length * 2;
      const grown = Buffer.allocUnsafe(newSize);
      this._accumulator.subarray(0, this._writePos).copy(grown);
      this._accumulator = grown;
    }
    this._accumulator[this._writePos++] = byte;
  }

  /**
   * Copy accumulated payload bytes into a new Buffer and deliver via `onFrame`.
   * The copy isolates callers from internal accumulator reuse (T-02-03-03).
   */
  private _deliverFrame(): void {
    const payload = Buffer.from(this._accumulator.subarray(0, this._writePos));
    this._writePos = 0;
    const frameStart = this._frameStartOffset;
    const frameWarnings: readonly MllpWarning[] = this._frameWarnings;
    this._frameWarnings = []; // reset for next frame
    this._opts.onFrame(payload, frameStart, frameWarnings);
  }

  /** Emit a warning via the `onWarning` callback, swallowing any handler exceptions (WARN-06). */
  private _emitWarning(code: WarningCode, byteOffset: number, message: string): void {
    const warning = createWarning(code, byteOffset, message);
    // Accumulate per-frame warnings unconditionally (independent of onWarning handler presence)
    this._frameWarnings.push(warning);
    if (this._opts.onWarning !== undefined) {
      try {
        this._opts.onWarning(warning);
      } catch {
        // WARN-06: throwing handler must not corrupt FSM state
      }
    }
  }
}
