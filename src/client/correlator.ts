/**
 * MLLP Client ACK correlator — pure data structure (CONTEXT D-03/A1).
 *
 * Unified `Map<correlationKey, PendingAck>` with ES2015 insertion-ordered
 * iteration is the single source of truth for in-flight + queued sends.
 *
 * - FIFO mode keys by synthetic monotonic `sendSeq: number`.
 * - controlId mode (PLAN-03) keys by MSH-10 `string`.
 * - `maxInFlight=1` (PLAN-05 `pipeline:false`) is enforced as a guard
 *   on the same store; not a separate class (D-06).
 *
 * **INTERNAL** — not re-exported from the package barrel. The class knows
 * nothing about `Connection`, the event emitter, sockets, or timers. Sweep
 * cadence is driven externally by the periodic sweep tick on `MllpClient`
 * so the Correlator itself stays timer-free (D-03).
 *
 * @packageDocumentation
 */

import type { WarningCode } from "../framing/index.js";

/** Correlation key — number for FIFO (`sendSeq`), string for controlId (MSH-10). */
export type CorrelationKey = number | string;

/**
 * The MSH-10 / MSA-2 byte-level scanners the correlator keys on.
 *
 * They live in `src/internal/control-id.ts`, not here: the client is one of
 * **three** call sites that must agree byte-for-byte on what a control ID is
 * (the others are `buildRawAck` in `src/server/ack.ts` and the verbatim-echo
 * check in `src/ack-from-hl7/build.ts`), and any disagreement between two of
 * them is an ACK the sender cannot match — a timeout, a resend, and a duplicate
 * clinical message. One implementation, one `latin1` decode, one dynamic read
 * of MSH-1. Re-exported here because they were part of this module's `@internal`
 * surface before the move.
 */
export {
  CONTROL_ID_ENCODING,
  extractMshControlId,
  extractMsaControlId,
} from "../internal/control-id.js";

/** A single pending send awaiting its ACK (D-03). */
export interface PendingAck {
  readonly key: CorrelationKey;
  readonly frame: Buffer;
  readonly controlId: string | null;
  readonly byteCount: number;
  /** Epoch ms recorded by `markFlushed()`; `null` until transport flush (CLIENT-04). */
  sentAt: number | null;
  readonly resolve: (ack: Buffer) => void;
  readonly reject: (err: Error) => void;
}

/** Graveyard bookkeeping for late-ACK detection (D-04). */
export interface GraveyardEntry {
  readonly timedOutAt: number;
  readonly controlId: string | null;
}

/** JSON-serializable snapshot used by `client.getStats()` (D-26). */
export interface CorrelatorStats {
  readonly size: number;
  readonly queueBytes: number;
  readonly graveyardSize: number;
  readonly sendSeq: number;
  /**
   * Count of live entries with `sentAt !== null` (PLAN-06 / D-26).
   *
   * Distinct from `size`. `size` includes pre-flush entries (an entry was
   * `enqueue()`'d but `markFlushed()` has not been called yet) AND
   * serialization-queued entries (`pipeline:false`'s deferred sends). A
   * pre-flush entry contributes to `size` but NOT to `inFlight`.
   */
  readonly inFlight: number;
}

/** Constructor options. INTERNAL callback-bag pattern (mirrors `FrameReaderOptions`). */
export interface CorrelatorOptions {
  /** `'fifo'` (default) or `'controlId'` (PLAN-03 wires controlId). */
  readonly mode?: "fifo" | "controlId";
  /** Default `30_000` (CLIENT-04). */
  readonly ackTimeoutMs?: number;
  /** Default `Infinity`. PLAN-05 sets `1` for `pipeline:false`. */
  readonly maxInFlight?: number;
  /**
   * Emits `MLLP_ACK_AFTER_TIMEOUT` (D-04) and `MLLP_ACK_UNMATCHED_CONTROL_ID`
   * (D-05 — PLAN-03). `byteOffset` is forwarded from the inbound ACK frame
   * for observability (W-05).
   */
  readonly onWarning: (
    code: WarningCode,
    ctx: {
      controlId: string | null;
      elapsedSinceSendMs: number;
      byteOffset: number;
    },
  ) => void;
  /** Called by `matchAck()` in controlId mode (PLAN-03) on unmatched-ACK. */
  readonly onUnmatchedAck?: (controlId: string) => void;
  /** Fired by `expireDue()`; `MllpClient` turns into `MllpTimeoutError`. */
  readonly onTimeout: (entry: PendingAck, elapsedMs: number) => void;
  /** Injected clock; default `Date.now`. Tests inject deterministic clock. */
  readonly now?: () => number;
}

/**
 * Pure data structure backing `MllpClient.send()` ACK correlation.
 *
 * @example
 * ```typescript
 * const correlator = new Correlator({
 *   mode: 'fifo',
 *   ackTimeoutMs: 30_000,
 *   onTimeout: (entry, elapsed) => entry.reject(new MllpTimeoutError('timeout', { ... })),
 *   onWarning: (code, ctx) => emitter.emit('warning', { code, ...ctx }),
 * });
 * const key = correlator.enqueue(frame, null, resolve, reject);
 * correlator.markFlushed(key);
 * const matched = correlator.matchAck(ackPayload);
 * if (matched !== null) matched.resolve(ackPayload);
 * ```
 */
export class Correlator {
  private readonly _opts: {
    readonly mode: "fifo" | "controlId";
    readonly ackTimeoutMs: number;
    readonly maxInFlight: number;
    readonly onWarning: CorrelatorOptions["onWarning"];
    readonly onTimeout: CorrelatorOptions["onTimeout"];
    readonly onUnmatchedAck: CorrelatorOptions["onUnmatchedAck"];
    readonly now: () => number;
  };
  private readonly _pending: Map<CorrelationKey, PendingAck> = new Map();
  private readonly _graveyard: Map<CorrelationKey, GraveyardEntry> = new Map();
  private _sendSeq = 0;
  private _queueBytes = 0;
  /**
   * PLAN-06 — count of pending entries with `sentAt !== null` (D-26 / B-01).
   * Maintained at every site that mutates `entry.sentAt` or removes a
   * flushed entry: `markFlushed`, `remove`, `matchAck`, `expireDue`, `clear`.
   */
  private _inFlight = 0;

  /**
   * Construct a send/ACK correlator.
   *
   * @param opts - Correlation options (FIFO vs control-id mode, ACK timeout, max in-flight).
   */
  constructor(opts: CorrelatorOptions) {
    this._opts = {
      mode: opts.mode ?? "fifo",
      ackTimeoutMs: opts.ackTimeoutMs ?? 30_000,
      maxInFlight: opts.maxInFlight ?? Number.POSITIVE_INFINITY,
      onWarning: opts.onWarning,
      onTimeout: opts.onTimeout,
      onUnmatchedAck: opts.onUnmatchedAck,
      now: opts.now ?? Date.now,
    };
  }

  /** Number of live pending entries. */
  get size(): number {
    return this._pending.size;
  }
  /** Sum of `frame.length` across live entries. */
  get queueBytes(): number {
    return this._queueBytes;
  }
  /** Number of graveyard entries awaiting lazy eviction. */
  get graveyardSize(): number {
    return this._graveyard.size;
  }

  /**
   * Enqueue a new send awaiting its ACK. Returns the assigned
   * `correlationKey`, or `null` if `maxInFlight` is reached (caller awaits
   * drain — PLAN-05's `pipeline:false`).
   */
  enqueue(
    frame: Buffer,
    controlIdOrNull: string | null,
    resolve: (ack: Buffer) => void,
    reject: (err: Error) => void,
  ): CorrelationKey | null {
    if (this._pending.size >= this._opts.maxInFlight) return null;
    // controlId mode keys by MSH-10 (string). When MSH-10 is absent, we fall
    // back to a synthetic `__seq-N` key — the send is best-effort matchable
    // by the FIFO live-store walk, but the peer realistically cannot ACK it
    // by control ID. Acceptable corner case (D-03/A1).
    const key: CorrelationKey =
      this._opts.mode === "controlId"
        ? (controlIdOrNull ?? `__seq-${++this._sendSeq}`)
        : ++this._sendSeq;
    const entry: PendingAck = {
      key,
      frame,
      controlId: controlIdOrNull,
      byteCount: frame.length,
      sentAt: null,
      resolve,
      reject,
    };
    this._pending.set(key, entry);
    this._queueBytes += frame.length;
    return key;
  }

  /**
   * Record write-flush timestamp (CLIENT-04 — clock starts at flush, NOT
   * at `send()` call). No-op if key is unknown (e.g. removed by abort).
   */
  markFlushed(key: CorrelationKey, now?: number): void {
    const entry = this._pending.get(key);
    if (entry === undefined) return;
    // PLAN-06: only the first flush bumps _inFlight. Subsequent re-flush
    // (e.g. PLAN-04's controlId reflushAll on reconnect) is idempotent.
    if (entry.sentAt === null) this._inFlight += 1;
    entry.sentAt = now ?? this._opts.now();
  }

  /**
   * Match an inbound ACK against the live store.
   *
   * - FIFO: returns first pending entry by insertion order; entry is
   *   removed from live store. Caller calls `entry.resolve(ackPayload)`.
   * - controlId: keyed lookup by `controlIdFromAck`. Live-store hit returns
   *   the entry; graveyard hit fires `MLLP_ACK_AFTER_TIMEOUT` warning
   *   (CLIENT-16, D-04) and returns `null`; otherwise fires
   *   `onUnmatchedAck(controlIdFromAck)` (CLIENT-15, D-05) and returns `null`.
   *
   * Triggers lazy graveyard eviction (D-04).
   *
   * @param _payload Inbound ACK bytes (framing stripped). MSA-2 extraction
   *   happens at MllpClient's `_onAckPayload` hook; this method takes the
   *   already-extracted control ID as a parameter.
   * @param controlIdFromAck MSA-2 extracted from ACK (controlId mode only).
   * @param byteOffsetFromAck Stream offset; forwarded to `onWarning` (W-05).
   */
  matchAck(
    _payload: Buffer,
    controlIdFromAck: string | null = null,
    byteOffsetFromAck = 0,
  ): PendingAck | null {
    this._evictGraveyardDue(this._opts.now());
    if (this._opts.mode === "fifo") {
      const iter = this._pending.values().next();
      if (iter.done === true) return null;
      const entry = iter.value;
      this._pending.delete(entry.key);
      this._queueBytes -= entry.byteCount;
      // PLAN-06 (D-26): only flushed entries count toward _inFlight.
      if (entry.sentAt !== null) this._inFlight -= 1;
      return entry;
    }
    // controlId mode (PLAN-03)
    if (controlIdFromAck === null) {
      // Caller failed to extract MSA-2; treat as unmatched. (MllpClient is
      // responsible for extraction; this is a defensive fallback.)
      if (this._opts.onUnmatchedAck !== undefined) {
        this._opts.onUnmatchedAck("");
      }
      return null;
    }
    const live = this._pending.get(controlIdFromAck);
    if (live !== undefined) {
      this._pending.delete(controlIdFromAck);
      this._queueBytes -= live.byteCount;
      // PLAN-06 (D-26): only flushed entries count toward _inFlight.
      if (live.sentAt !== null) this._inFlight -= 1;
      return live;
    }
    const grave = this._graveyard.get(controlIdFromAck);
    if (grave !== undefined) {
      // CLIENT-16: late ACK after timeout. Forward the inbound ACK frame's
      // byte offset (W-05) so observers see where in the stream it landed.
      const elapsedSinceSendMs = this._opts.now() - grave.timedOutAt;
      this._opts.onWarning("MLLP_ACK_AFTER_TIMEOUT", {
        controlId: grave.controlId,
        elapsedSinceSendMs,
        byteOffset: byteOffsetFromAck,
      });
      // One-shot: drop the graveyard entry now that we've seen the late ACK.
      this._graveyard.delete(controlIdFromAck);
      return null;
    }
    // CLIENT-15: unmatched controlId (live store empty + not in graveyard).
    if (this._opts.onUnmatchedAck !== undefined) {
      this._opts.onUnmatchedAck(controlIdFromAck);
    }
    return null;
  }

  /**
   * Sweep live entries; expire those past `sentAt + ackTimeoutMs`.
   * Fires `onTimeout(entry, elapsedMs)`; entries move to graveyard (D-04).
   * Driven externally by `MllpClient`'s periodic sweep tick — Correlator
   * itself owns no timers (D-03).
   */
  expireDue(now?: number): void {
    const t = now ?? this._opts.now();
    const ackTimeoutMs = this._opts.ackTimeoutMs;
    for (const [key, entry] of this._pending) {
      if (entry.sentAt !== null && entry.sentAt + ackTimeoutMs <= t) {
        const elapsed = t - entry.sentAt;
        this._pending.delete(key);
        this._queueBytes -= entry.byteCount;
        // PLAN-06: expired entry was flushed by the guard above.
        this._inFlight -= 1;
        this._graveyard.set(key, {
          timedOutAt: t,
          controlId: entry.controlId,
        });
        this._opts.onTimeout(entry, elapsed);
      }
    }
  }

  /**
   * Reject every live entry with `reason` (insertion order) and clear
   * the live store. Graveyard is left intact (ages out via lazy eviction).
   * Used by FIFO reconnect-reject (D-07 — PLAN-04 wraps in MllpConnectionError)
   * and `MllpClient.close()` to cancel pending sends.
   */
  clear(reason: Error): void {
    for (const entry of this._pending.values()) entry.reject(reason);
    this._pending.clear();
    this._queueBytes = 0;
    // PLAN-06: reset _inFlight unconditionally — clear() drops every entry,
    // flushed or not. Avoids any over-decrement edge case.
    this._inFlight = 0;
  }

  /** Iterate live entries in insertion order (PLAN-04 reconnect-resend, D-07). */
  *liveEntries(): IterableIterator<PendingAck> {
    for (const entry of this._pending.values()) yield entry;
  }

  /**
   * Remove a live entry by key WITHOUT resolving/rejecting. Returns the
   * removed entry, or `null` if no entry with that key exists.
   * Used by `MllpClient.send()` for AbortSignal cleanup and PLAN-04's
   * reconnect-reject FSM walk.
   */
  remove(key: CorrelationKey): PendingAck | null {
    const entry = this._pending.get(key);
    if (entry === undefined) return null;
    this._pending.delete(key);
    this._queueBytes -= entry.byteCount;
    // PLAN-06: only flushed entries count toward _inFlight.
    if (entry.sentAt !== null) this._inFlight -= 1;
    return entry;
  }

  /** JSON-serializable stats snapshot (no Buffers, no class instances). */
  getStats(): CorrelatorStats {
    return {
      size: this._pending.size,
      queueBytes: this._queueBytes,
      graveyardSize: this._graveyard.size,
      sendSeq: this._sendSeq,
      inFlight: this._inFlight,
    };
  }

  /** Lazy graveyard eviction (D-04): drop entries past `timedOutAt + 2 * ackTimeoutMs`. */
  private _evictGraveyardDue(now: number): void {
    const threshold = 2 * this._opts.ackTimeoutMs;
    for (const [key, entry] of this._graveyard) {
      if (entry.timedOutAt + threshold <= now) this._graveyard.delete(key);
    }
  }
}
