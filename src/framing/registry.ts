/**
 * MLLP warning code registry and `MllpWarning` factory.
 *
 * `WarningCode` is a **stable public API**. Renaming or removing a code is a breaking change.
 * New codes may only be added in minor versions.
 *
 * @example
 * ```typescript
 * import { createWarning, type MllpWarning, type WarningCode } from '@cosyte/hl7-mllp';
 * const w: MllpWarning = createWarning('MLLP_EMPTY_PAYLOAD', 128, 'Empty payload between VT and FS');
 * ```
 *
 * @packageDocumentation
 */

/**
 * Union of all stable MLLP warning codes.
 *
 * These codes are a **public API** — they appear in `onWarning` handlers, log pipelines,
 * monitoring dashboards, and error messages. Renaming is a breaking change.
 *
 * @example
 * ```typescript
 * const code: WarningCode = 'MLLP_FS_WITHOUT_CR';
 * ```
 */
export type WarningCode =
  | "MLLP_MISSING_LEADING_VT"
  | "MLLP_FS_WITHOUT_CR"
  | "MLLP_LF_AFTER_FS"
  | "MLLP_LEADING_WHITESPACE"
  | "MLLP_TRAILING_BYTES"
  | "MLLP_PAYLOAD_CONTAINS_VT"
  | "MLLP_PAYLOAD_CONTAINS_FS"
  | "MLLP_EMPTY_PAYLOAD"
  | "MLLP_FRAME_TOO_LARGE"
  | "MLLP_ACK_UNMATCHED_CONTROL_ID"
  | "MLLP_ACK_AFTER_TIMEOUT";

/**
 * A frozen warning object emitted when the decoder tolerates a framing deviation.
 *
 * `connectionId` is `undefined` when emitted by a standalone `FrameReader` (Phase 2).
 * Phase 3 `Connection` enriches it to the real UUIDv4 before forwarding upstream.
 *
 * @example
 * ```typescript
 * const reader = new FrameReader({
 *   onFrame: (p) => process(p),
 *   onWarning: (w: MllpWarning) => logger.warn(w),
 *   allowFsOnly: true,
 * });
 * ```
 */
export interface MllpWarning {
  readonly code: WarningCode;
  /** Stable human-readable description. Never contains payload bytes or secrets. */
  readonly message: string;
  /** Absolute stream byte offset where the anomaly was detected. */
  readonly byteOffset: number;
  /**
   * Connection identifier. `undefined` at the framing layer;
   * enriched by Phase 3 `Connection` before emitting upstream.
   */
  readonly connectionId: string | undefined;
  /** Wall-clock time at point of emission. */
  readonly timestamp: Date;
}

/**
 * Callback type for receiving MLLP framing warnings.
 *
 * @example
 * ```typescript
 * const onWarning: OnWarning = (w) => logger.warn({ code: w.code, offset: w.byteOffset });
 * ```
 */
export type OnWarning = (warning: MllpWarning) => void;

/**
 * Create a frozen `MllpWarning` object. The returned object is `Object.freeze()`'d
 * so subscribers cannot mutate shared warning state.
 *
 * `connectionId` is always `undefined` here — Phase 3 enriches via
 * `{ ...w, connectionId: this.connectionId }` then re-freezes (D-08).
 *
 * @example
 * ```typescript
 * const w = createWarning('MLLP_EMPTY_PAYLOAD', 64, 'Empty payload between VT and FS');
 * // w.connectionId === undefined
 * ```
 */
export function createWarning(code: WarningCode, byteOffset: number, message: string): MllpWarning {
  return Object.freeze<MllpWarning>({
    code,
    message,
    byteOffset,
    connectionId: undefined,
    timestamp: new Date(),
  });
}
