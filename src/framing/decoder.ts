/**
 * MLLP frame decoder, stateful 3-state FSM for chunked byte-stream parsing.
 *
 * Feed raw TCP chunks via `push(chunk)`. Complete MLLP frames fire synchronously
 * via the `onFrame` callback during each `push()` call.
 *
 * The decoder is **strict by default**: any framing deviation throws `MllpFramingError`
 * unless the matching tolerance option is explicitly enabled (Postel's Law, liberal receiver
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

/**
 * The accumulator's size (4 KiB). It never grows: a frame longer than one block is kept as a list
 * of parts and joined once, on delivery.
 */
const BLOCK_SIZE = 4096;

/**
 * Shared empty snippet for framing errors whose anomaly is not a specific byte (e.g.
 * `MLLP_FRAME_TOO_LARGE`, where the fault is the accumulated size, not any content byte).
 * Emitting a run of accumulated payload bytes here would leak a field-body slice of clinical
 * content onto a public error field.
 */
const EMPTY_SNIPPET = Buffer.alloc(0);

/**
 * Options for `FrameReader`.
 *
 * All tolerance opts default to `false`, every framing deviation throws unless
 * explicitly enabled. Server-level defaults (allowFsOnly, allowLfAfterFs, allowLeadingWhitespace)
 * are applied by the server when constructing readers.
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
   * Called for each tolerated framing deviation. Wrapped in try/catch.
   * A throwing handler will not corrupt FSM state.
   */
  onWarning?: (w: MllpWarning) => void;
  /**
   * Maximum accumulated payload bytes before `MllpFramingError('MLLP_FRAME_TOO_LARGE')`.
   * Default: 16 MiB (DoS prevention).
   */
  maxFrameSizeBytes?: number;
  /** Tolerate FS without trailing CR; emits `MLLP_FS_WITHOUT_CR`. */
  allowFsOnly?: boolean;
  /** Tolerate FS+LF instead of FS+CR; emits `MLLP_LF_AFTER_FS`. */
  allowLfAfterFs?: boolean;
  /** Tolerate missing leading VT; emits `MLLP_MISSING_LEADING_VT`. */
  allowMissingLeadingVt?: boolean;
  /** Tolerate SP/TAB/LF/CR before VT; emits `MLLP_LEADING_WHITESPACE`. */
  allowLeadingWhitespace?: boolean;
  /**
   * When `true`, escalates the following tolerances to thrown `MllpFramingError`
   * even if individual opt-ins (`allowFsOnly`, `allowLfAfterFs`, `allowMissingLeadingVt`,
   * `allowLeadingWhitespace`) are enabled:
   * - `MLLP_MISSING_LEADING_VT`
   * - `MLLP_FS_WITHOUT_CR`
   * - `MLLP_LF_AFTER_FS`
   * - `MLLP_LEADING_WHITESPACE` (leading whitespace escalates as `MLLP_MISSING_LEADING_VT`)
   *
   * `MLLP_EMPTY_PAYLOAD` and `MLLP_TRAILING_BYTES` remain warnings even in strict mode.
   *
   * @example
   * ```typescript
   * // Hardened enforcement, no tolerance, all violations throw
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
 * - `SCANNING_FOR_VT`, waiting for the 0x0B frame-start byte
 * - `READING_PAYLOAD`, accumulating payload bytes until FS (0x1C)
 * - `EXPECTING_CR`, received FS, waiting for CR (0x0D) to complete the frame
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
  /** Reusable 4 KiB block the current frame's latest bytes are gathered in. */
  private _accumulator: Buffer = Buffer.allocUnsafe(BLOCK_SIZE);
  /** Number of the current frame's bytes in `_accumulator`. */
  private _blockUsed = 0;
  /**
   * The current frame's earlier bytes, in order, once it outgrew one block: full blocks, and
   * exact copies of runs longer than a block. Dropped with the frame, so a reader holds no more
   * than the frame it is part way through.
   */
  private _parts: Buffer[] = [];
  /** Number of payload bytes in the current frame, `_parts` and `_accumulator` together. */
  private _writePos = 0;
  /** Monotonic absolute stream byte offset across the entire connection lifetime. */
  private _byteOffset = 0;
  /** Byte offset where current leading-whitespace run started. */
  private _wsStart = 0;
  /** Count of leading whitespace bytes accumulated in current run. */
  private _wsCount = 0;
  /** Byte offset of the VT byte that started the current frame. */
  private _frameStartOffset = 0;
  /** Per-frame warning accumulator, cleared after each _deliverFrame(). */
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
    // Anything but a byte array (TypeScript says Buffer; JavaScript lets a caller pass anything)
    // is read one element at a time, as every chunk always was, so even that behaves as before.
    if (!(chunk instanceof Uint8Array)) {
      this._pushEachByte(chunk);
      return;
    }
    const end = chunk.length;
    // The next FS and VT at or after `i`, found by a native search and kept until `i` passes
    // them, so no byte of the chunk is searched twice for the same delimiter. `-1`: none left.
    let nextFs = -2;
    let nextVt = -2;
    let i = 0;
    while (i < end) {
      if (this._state === "READING_PAYLOAD") {
        if (nextFs !== -1 && nextFs < i) nextFs = chunk.indexOf(FS, i);
        if (nextVt !== -1 && nextVt < i) nextVt = chunk.indexOf(VT, i);
        // The run of ordinary payload bytes from `i`: up to the next FS or VT, or the chunk end.
        let stop = nextFs === -1 ? end : nextFs;
        if (nextVt !== -1 && nextVt < stop) stop = nextVt;
        if (stop > i) {
          if (
            this._writePos === 0 &&
            stop === nextFs &&
            stop + 1 < end &&
            chunk[stop + 1] === CR &&
            stop - i <= this._room()
          ) {
            // A whole payload and its `FS CR` in this chunk: deliver a copy straight from the
            // chunk, the accumulator untouched. At the callback the state and the offset are what
            // the byte-at-a-time reading had there: past the FS, at the CR, `EXPECTING_CR`.
            const payload = Buffer.from(chunk.subarray(i, stop));
            this._byteOffset += stop - i + 1;
            this._state = "EXPECTING_CR";
            this._deliver(payload);
            this._state = "SCANNING_FOR_VT";
            this._byteOffset++;
            i = stop + 2;
            continue;
          }
          this._appendRun(chunk, i, stop);
          i = stop;
          continue;
        }
      }
      // A delimiter, or a byte outside a payload: one byte, read exactly as always.
      this._processByte(chunk[i] as number);
      i++;
      this._byteOffset++;
    }
  }

  /** The byte-at-a-time reading, for a chunk that is not a byte array. */
  private _pushEachByte(chunk: ArrayLike<number>): void {
    for (let i = 0; i < chunk.length; i++, this._byteOffset++) {
      const byte = chunk[i];
      /* v8 ignore next -- i < chunk.length, so the index is always in range */
      if (byte === undefined) break; // noUncheckedIndexedAccess guard

      this._processByte(byte);
    }
  }

  /**
   * How many more payload bytes the size cap admits. A byte is admitted while
   * `writePos < maxFrameSizeBytes`, so a fractional cap admits up to its ceiling, a cap already
   * reached admits none, and a `NaN` cap, which that comparison never refuses, admits any number.
   */
  private _room(): number {
    const room = this._maxFrameSize - this._writePos;
    if (Number.isNaN(room)) return Infinity;
    return room > 0 ? Math.ceil(room) : 0;
  }

  /**
   * Append the ordinary payload bytes `chunk[start, stop)`, none of them FS or VT, in one copy.
   * The size cap holds as it did byte by byte: every byte it admits is appended, and the first it
   * refuses throws at that byte's offset.
   */
  private _appendRun(chunk: Uint8Array, start: number, stop: number): void {
    const length = stop - start;
    const take = Math.min(length, this._room());
    if (take > 0) {
      this._gather(chunk, start, start + take);
      this._byteOffset += take;
    }
    if (take < length) this._throwTooLarge();
  }

  /** Refuse the payload byte at the current offset: the frame has reached its size cap. */
  private _throwTooLarge(): never {
    // PHI: the snippet must NOT carry a run of accumulated payload bytes, that is a
    // field-body slice of clinical content (the too-large frame is a full HL7 message).
    // The anomaly here is the size, not any specific byte, so the snippet is empty; the
    // structural facts (cap, byte offset) live in the message. (MLLP-9 PHI audit.)
    throw new MllpFramingError(
      "MLLP_FRAME_TOO_LARGE",
      this._byteOffset,
      EMPTY_SNIPPET,
      `Frame payload exceeded maxFrameSizeBytes (${this._maxFrameSize}) at offset ${this._byteOffset}`,
    );
  }

  /**
   * Add `src[start, end)` to the current frame: into the block while it has room; then the full
   * block becomes a part, a run of a block or more is copied as one part of its own, and what is
   * left starts a fresh block.
   */
  private _gather(src: Uint8Array, start: number, end: number): void {
    let at = start;
    const fill = Math.min(end - at, BLOCK_SIZE - this._blockUsed);
    if (fill > 0) {
      this._accumulator.set(src.subarray(at, at + fill), this._blockUsed);
      this._blockUsed += fill;
      at += fill;
    }
    if (at < end) {
      this._parts.push(this._accumulator);
      this._accumulator = Buffer.allocUnsafe(BLOCK_SIZE);
      const rest = end - at;
      if (rest >= BLOCK_SIZE) {
        this._parts.push(Buffer.from(src.subarray(at, end)));
        this._blockUsed = 0;
      } else {
        this._accumulator.set(src.subarray(at, end), 0);
        this._blockUsed = rest;
      }
    }
    this._writePos += end - start;
  }

  /** Forget the current frame's bytes: the block is kept for the next frame, the parts dropped. */
  private _discard(): void {
    this._writePos = 0;
    this._blockUsed = 0;
    if (this._parts.length > 0) this._parts = [];
  }

  /**
   * Clear internal accumulator state and reset byte offset to 0.
   *
   * Call on reconnect / connection reuse to start fresh without allocating a new reader.
   * Pending partial frame state is discarded silently.
   *
   * @example
   * ```typescript
   * socket.on('close', () => reader.reset());
   * ```
   */
  reset(): void {
    this._state = "SCANNING_FOR_VT";
    this._discard();
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
        `Missing leading VT (0x0B), treating byte 0x${byte.toString(16).padStart(2, "0")} at offset ${this._byteOffset} as payload start`,
      );
      this._frameStartOffset = this._byteOffset;
      this._state = "READING_PAYLOAD";
      // Read this byte as a frame's first byte, as if the missing VT had come before it. An FS
      // here ends an empty frame, and the size cap holds. Appending it unread delivered a stray
      // FS (a sender repeating its `FS CR` trailer) as the first byte of the next payload, a
      // framing byte the encoder refuses to write.
      this._readPayload(byte);
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
      // VT mid-payload: the current partial payload is abandoned and accumulation restarts after
      // this VT, so the frame that eventually delivers is only the REMNANT after the discard.
      // Emit MLLP_TRAILING_BYTES (always a warning, never a throw), this is the code's **reserved**
      // meaning: "bytes were discarded; the delivered payload is a fragment." It is emitted while
      // accumulating the remnant frame, so it attaches to that frame (never bled onto another), and
      // `MllpServer`'s auto-ACK path keys on it to refuse a positive `AA` for a destroyed message.
      this._emitWarning(
        "MLLP_TRAILING_BYTES",
        this._byteOffset,
        `Unexpected VT (0x0B) mid-payload at offset ${this._byteOffset}; discarding ${this._writePos} accumulated bytes`,
      );
      this._discard();
      // Remain in READING_PAYLOAD, the VT starts a new frame payload accumulation
      this._state = "READING_PAYLOAD";
      return;
    }

    // Regular payload byte, enforce size cap BEFORE appending
    if (this._writePos >= this._maxFrameSize) this._throwTooLarge();

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
      // Next frame starts immediately after FS, no CR between frames
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
        // The VT byte is consumed here, transition directly to READING_PAYLOAD
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
      // Deliver the completed frame and flag the missing CR; the stray byte is then dropped and
      // we return to scanning. The single FS_WITHOUT_CR warning names the stray byte and is
      // attached to the frame it followed.
      //
      // We deliberately do NOT also emit MLLP_TRAILING_BYTES here. That code is **reserved for a
      // VT appearing mid-payload** (see `_readPayload`), where it means "this delivered payload is
      // only the remnant after accumulated bytes were discarded", a signal `MllpServer`'s
      // auto-ACK path keys on to refuse a positive `AA` for a message whose bytes were destroyed.
      // Emitting it for an inter-frame stray byte overloaded that meaning AND mis-attributed it:
      // it was emitted *after* `_deliverFrame()`, so it landed in the NEXT frame's warning
      // accumulator and made a subsequent, perfectly good message look discarded. FS_WITHOUT_CR
      // already, correctly, reports this deviation.
      this._emitWarning(
        "MLLP_FS_WITHOUT_CR",
        this._byteOffset,
        `FS not followed by CR at offset ${this._byteOffset}; got 0x${byte.toString(16).padStart(2, "0")} (dropped)`,
      );
      this._deliverFrame();
      this._state = "SCANNING_FOR_VT";
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

  /** Add one byte to the current frame, starting a fresh block when this one is full. */
  private _appendByte(byte: number): void {
    if (this._blockUsed === BLOCK_SIZE) {
      this._parts.push(this._accumulator);
      this._accumulator = Buffer.allocUnsafe(BLOCK_SIZE);
      this._blockUsed = 0;
    }
    this._accumulator[this._blockUsed++] = byte;
    this._writePos++;
  }

  /**
   * Copy accumulated payload bytes into a new Buffer and deliver via `onFrame`.
   * The copy isolates callers from internal accumulator reuse.
   */
  private _deliverFrame(): void {
    const block = this._accumulator.subarray(0, this._blockUsed);
    if (this._parts.length === 0) {
      this._deliver(Buffer.from(block));
      return;
    }
    this._parts.push(block);
    this._deliver(Buffer.concat(this._parts, this._writePos));
  }

  /**
   * Deliver `payload` via `onFrame` with this frame's start offset and warnings, the frame's
   * bytes forgotten first.
   */
  private _deliver(payload: Buffer): void {
    this._discard();
    const frameStart = this._frameStartOffset;
    const frameWarnings: readonly MllpWarning[] = this._frameWarnings;
    this._frameWarnings = []; // reset for next frame
    this._opts.onFrame(payload, frameStart, frameWarnings);
  }

  /** Emit a warning via the `onWarning` callback, swallowing any handler exceptions. */
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
