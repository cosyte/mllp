/**
 * MLLP Client ACK correlator, pure data structure.
 *
 * Unified `Map<correlationKey, PendingAck>` with ES2015 insertion-ordered
 * iteration is the single source of truth for in-flight + queued sends.
 *
 * - FIFO mode keys by synthetic monotonic `sendSeq: number`.
 * - controlId mode keys by MSH-10 `string`.
 * - `maxInFlight=1` (`pipeline:false`) is enforced as a guard
 *   on the same store; not a separate class.
 *
 * **INTERNAL**, not re-exported from the package barrel. The class knows
 * nothing about `Connection`, the event emitter, sockets, or timers. Sweep
 * cadence is driven externally by the periodic sweep tick on `MllpClient`
 * so the Correlator itself stays timer-free.
 *
 * @packageDocumentation
 */

import type { AckCorrelationCode } from "./ack-diagnostics.js";
import { classifyMsa1, type CommitAckReport, type Table0008Code } from "../internal/ack-mode.js";
import type { AckModeCode } from "../internal/ack-mode-diagnostics.js";

/** Correlation key, number for FIFO (`sendSeq`), string for controlId (MSH-10). */
export type CorrelationKey = number | string;

/**
 * The MSH-10 / MSA-2 byte-level scanners the correlator keys on.
 *
 * They live in `src/internal/control-id.ts`, not here: the client is one of
 * **three** call sites that must agree byte-for-byte on what a control ID is
 * (the others are `buildRawAck` in `src/server/ack.ts` and the verbatim-echo
 * check in `src/ack-from-hl7/build.ts`), and any disagreement between two of
 * them is an ACK the sender cannot match, a timeout, a resend, and a duplicate
 * clinical message. One implementation, one `latin1` decode, one dynamic read
 * of MSH-1. Re-exported here because they were part of this module's `@internal`
 * surface before the move.
 */
export {
  CONTROL_ID_ENCODING,
  extractMshControlId,
  extractMsaControlId,
} from "../internal/control-id.js";

/**
 * Two-phase state carried by an **enhanced-mode** send that is being correlated by control
 * ID. `null` on every other send, and a `null` here is exactly what makes a send behave the
 * way this package has always behaved: the first acknowledgement matched to it settles it,
 * whatever its MSA-1 carries.
 */
export interface TwoPhaseState {
  /**
   * Whether an application acknowledgement may follow the accept acknowledgement (MSH-16
   * is `AL`, `ER` or `SU`). When it is `false` the accept acknowledgement is the last word
   * and a `CA` settles the send by itself, which is what a peer answering
   * MSH-15 `AL` with MSH-16 `NE` has correctly done.
   */
  readonly awaitsApplicationAck: boolean;
  /**
   * Bound on the second wait, measured from the moment the accept acknowledgement was
   * received. Finite by construction: an unbounded wait is a defect.
   */
  readonly applicationAckTimeoutMs: number;
  /**
   * The caller's own per-send hook for the commit report, or `null` when that send asked
   * for none. Scoped to one send by construction: it is the callback the caller passed to
   * the `send()` this entry belongs to.
   */
  readonly onCommitReport: ((report: CommitAckReport) => void) | null;
  /** The accept-mode code already reported for this send, `null` until one arrives. */
  commitCode: "CA" | null;
  /** Epoch ms at which the accept acknowledgement was received, `null` until then. */
  commitReceivedAt: number | null;
}

/** A single pending send awaiting its ACK. */
export interface PendingAck {
  readonly key: CorrelationKey;
  readonly frame: Buffer;
  readonly controlId: string | null;
  readonly byteCount: number;
  /** Epoch ms recorded by `markFlushed()`; `null` until transport flush. */
  sentAt: number | null;
  readonly resolve: (ack: Buffer) => void;
  readonly reject: (err: Error) => void;
  /**
   * Two-phase acknowledgement state, or `null` for a send correlated the way every send
   * was before enhanced mode existed. See {@link TwoPhaseState}.
   */
  readonly twoPhase: TwoPhaseState | null;
}

/** Graveyard bookkeeping for late-ACK detection. */
export interface GraveyardEntry {
  readonly timedOutAt: number;
  readonly controlId: string | null;
}

/** JSON-serializable snapshot used by `client.getStats()`. */
export interface CorrelatorStats {
  readonly size: number;
  readonly queueBytes: number;
  readonly graveyardSize: number;
  readonly sendSeq: number;
  /**
   * Count of live entries with `sentAt !== null`.
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
  /** `'fifo'` (default) or `'controlId'`. */
  readonly mode?: "fifo" | "controlId";
  /** Default `30_000`. */
  readonly ackTimeoutMs?: number;
  /** Default `Infinity`; set to `1` for `pipeline:false`. */
  readonly maxInFlight?: number;
  /**
   * Emits `MLLP_ACK_AFTER_TIMEOUT` and `MLLP_ACK_UNMATCHED_CONTROL_ID`.
   * `byteOffset` is forwarded from the inbound ACK frame
   * for observability.
   *
   * **The context carries numbers, never the control ID itself.**
   * `controlIdBytes` is its byte length (`null` when there is no id), because
   * this context is handed to a warning that goes to a log, and a control ID is
   * payload content. The correlator withholds the string at the source so no
   * consumer downstream of it can interpolate one.
   */
  readonly onWarning: (
    code: AckCorrelationCode,
    ctx: {
      controlIdBytes: number | null;
      elapsedSinceSendMs: number;
      byteOffset: number;
    },
  ) => void;
  /**
   * Called by `matchAck()` in controlId mode on unmatched-ACK.
   *
   * Receives the **byte length** of the inbound MSA-2, or `null` when no MSA-2
   * could be extracted at all. The bytes themselves are deliberately not passed:
   * see {@link CorrelatorOptions.onWarning}.
   */
  readonly onUnmatchedAck?: (controlIdBytes: number | null) => void;
  /** Fired by `expireDue()`; `MllpClient` turns into `MllpTimeoutError`. */
  readonly onTimeout: (entry: PendingAck, elapsedMs: number) => void;
  /**
   * Emits the acknowledgement-mode codes: an acknowledgement that could not be classified
   * into a mode, a repeat commit accept, and one for a send already disposed of.
   *
   * **The context carries numbers and a closed-set code, never field bytes**, for the same
   * reason {@link CorrelatorOptions.onWarning} does.
   */
  readonly onAckModeWarning?: (code: AckModeCode, ctx: AckModeWarningContext) => void;
  /**
   * Fired when a commit accept (`CA`) is matched to a send that awaits an application
   * acknowledgement. The send stays pending; this is the report, not the settlement.
   */
  readonly onCommitReported?: (entry: PendingAck, ack: Buffer, latencyMs: number) => void;
  /**
   * Fired when a commit error or reject (`CE`/`CR`) is matched to a two-phase send. The
   * peer did not take custody of the bytes, so no application acknowledgement is coming and
   * the entry has already been removed: the handler fails the send.
   */
  readonly onCommitRejected?: (entry: PendingAck, code: "CE" | "CR") => void;
  /**
   * Fired by `expireDue()` when the wait that started at the accept acknowledgement
   * expires. Falls back to {@link CorrelatorOptions.onTimeout} when not supplied, so the
   * second wait is bounded whatever the caller wires.
   */
  readonly onApplicationAckTimeout?: (entry: PendingAck, elapsedSinceCommitMs: number) => void;
  /** Injected clock; default `Date.now`. Tests inject deterministic clock. */
  readonly now?: () => number;
}

/**
 * Context handed to {@link CorrelatorOptions.onAckModeWarning}.
 *
 * Everything here is a number or a member of the closed six-code Table 0008 set. An MSA-1
 * the reader could not classify is reported by its **byte length** alone.
 */
export interface AckModeWarningContext {
  /** Byte length of the MSA-1 field involved, or `null` when the code reports none. */
  readonly msa1Bytes: number | null;
  /** Table 0008 code involved, or `null` when the code reports none. */
  readonly ackCode: Table0008Code | null;
  /** Byte length of the control ID involved, or `null` when there was none to read. */
  readonly controlIdBytes: number | null;
  /** Inbound frame's stream byte offset. */
  readonly byteOffset: number;
  /** Milliseconds since the send's write-flush, or since its disposal for a late ACK. */
  readonly elapsedSinceSendMs: number;
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
    readonly onAckModeWarning: CorrelatorOptions["onAckModeWarning"];
    readonly onCommitReported: CorrelatorOptions["onCommitReported"];
    readonly onCommitRejected: CorrelatorOptions["onCommitRejected"];
    readonly onApplicationAckTimeout: CorrelatorOptions["onApplicationAckTimeout"];
    readonly now: () => number;
  };
  private readonly _pending: Map<CorrelationKey, PendingAck> = new Map();
  private readonly _graveyard: Map<CorrelationKey, GraveyardEntry> = new Map();
  /**
   * Control IDs of two-phase sends already disposed of (settled or failed), with the epoch
   * ms at which that happened.
   *
   * Separate from the graveyard, and separate on purpose. The graveyard is a memory of
   * **timed-out** sends and is evicted one-shot, on the first late acknowledgement that
   * hits it. This one is a memory of **every** disposal and is evicted by elapsed time
   * alone, so a peer that repeats an acknowledgement twice inside the window is told
   * "already disposed" both times rather than "already disposed" and then "no such send".
   * The two windows are the same length; only the eviction rules differ.
   */
  private readonly _disposed: Map<CorrelationKey, number> = new Map();
  private _sendSeq = 0;
  private _queueBytes = 0;
  /**
   * Count of pending entries with `sentAt !== null`.
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
      onAckModeWarning: opts.onAckModeWarning,
      onCommitReported: opts.onCommitReported,
      onCommitRejected: opts.onCommitRejected,
      onApplicationAckTimeout: opts.onApplicationAckTimeout,
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
  /** Number of disposed two-phase sends still inside their remembered window. */
  get disposedSize(): number {
    return this._disposed.size;
  }

  /**
   * Enqueue a new send awaiting its ACK. Returns the assigned
   * `correlationKey`, or `null` if `maxInFlight` is reached (caller awaits
   * drain, `pipeline:false`).
   *
   * `twoPhase` is the enhanced-mode state for a send being correlated by control ID.
   * Omitting it (or passing `null`) is what every other send does, and such an entry is
   * settled by the first acknowledgement matched to it, exactly as before.
   */
  enqueue(
    frame: Buffer,
    controlIdOrNull: string | null,
    resolve: (ack: Buffer) => void,
    reject: (err: Error) => void,
    twoPhase: TwoPhaseState | null = null,
  ): CorrelationKey | null {
    if (this._pending.size >= this._opts.maxInFlight) return null;
    // controlId mode keys by MSH-10 (string). When MSH-10 is absent, we fall
    // back to a synthetic `__seq-N` key, the send is best-effort matchable
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
      twoPhase,
    };
    this._pending.set(key, entry);
    this._queueBytes += frame.length;
    return key;
  }

  /**
   * Record write-flush timestamp (the clock starts at flush, NOT
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
   *   and returns `null`; otherwise fires `onUnmatchedAck` with the id's
   *   **byte length** and returns `null`.
   *
   * A live-store hit on a **two-phase** entry is decided by the acknowledgement's MSA-1
   * instead, see {@link Correlator.matchTwoPhase}.
   *
   * Triggers lazy graveyard eviction.
   *
   * @param payload Inbound ACK bytes (framing stripped). MSA-2 extraction
   *   happens at MllpClient's `_onAckPayload` hook; this method takes the
   *   already-extracted control ID as a parameter. The bytes themselves are read
   *   only for a two-phase entry's MSA-1.
   * @param controlIdFromAck MSA-2 extracted from ACK (controlId mode only).
   * @param byteOffsetFromAck Stream offset; forwarded to `onWarning`.
   */
  matchAck(
    payload: Buffer,
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
        this._opts.onUnmatchedAck(null);
      }
      return null;
    }
    const live = this._pending.get(controlIdFromAck);
    if (live !== undefined) {
      if (live.twoPhase !== null) {
        return this.matchTwoPhase(live, payload, byteOffsetFromAck);
      }
      this._pending.delete(controlIdFromAck);
      this._queueBytes -= live.byteCount;
      // PLAN-06 (D-26): only flushed entries count toward _inFlight.
      if (live.sentAt !== null) this._inFlight -= 1;
      return live;
    }
    const disposedAt = this._disposed.get(controlIdFromAck);
    if (disposedAt !== undefined) {
      // A further ACK for a send already settled or failed. It changes nothing, and it is
      // NOT evicted here: every ACK inside the window draws this same answer, however many
      // arrive, so a peer repeating itself is never told "no such send" for a send that is
      // still remembered.
      this._ackModeWarn("MLLP_ACK_SEND_ALREADY_DISPOSED", {
        msa1Bytes: null,
        ackCode: null,
        controlIdBytes: controlIdFromAck.length,
        byteOffset: byteOffsetFromAck,
        elapsedSinceSendMs: this._opts.now() - disposedAt,
      });
      return null;
    }
    const grave = this._graveyard.get(controlIdFromAck);
    if (grave !== undefined) {
      // CLIENT-16: late ACK after timeout. Forward the inbound ACK frame's
      // byte offset (W-05) so observers see where in the stream it landed.
      const elapsedSinceSendMs = this._opts.now() - grave.timedOutAt;
      this._opts.onWarning("MLLP_ACK_AFTER_TIMEOUT", {
        // The LENGTH, never the id. Control IDs are decoded `latin1`, a 1:1
        // byte to code-unit map, so `.length` is a byte count.
        controlIdBytes: grave.controlId === null ? null : grave.controlId.length,
        elapsedSinceSendMs,
        byteOffset: byteOffsetFromAck,
      });
      // One-shot: drop the graveyard entry now that we've seen the late ACK.
      this._graveyard.delete(controlIdFromAck);
      return null;
    }
    // CLIENT-15: unmatched controlId (live store empty + not in graveyard).
    // The LENGTH crosses this boundary, never the peer's bytes.
    if (this._opts.onUnmatchedAck !== undefined) {
      this._opts.onUnmatchedAck(controlIdFromAck.length);
    }
    return null;
  }

  /**
   * Decide what an acknowledgement matched to a **two-phase** send does to it, from its
   * MSA-1 and from nothing else. No other property of the acknowledgement, its length, its
   * MSH-9 or its other segments, takes part.
   *
   * Six outcomes, one per classification:
   *
   *   * `AA`, `AE` or `AR`: the application acknowledgement. It **settles** the send,
   *     whether or not an accept-mode acknowledgement was seen first, and all three settle
   *     it the same way, successfully, with the acknowledgement handed to the caller. `AE`
   *     and `AR` are the receiving application's clinical verdict on a message it did take
   *     custody of, and judging that verdict is not this package's job. The caller reads
   *     MSA-1 off the acknowledgement it is given.
   *   * `CA` on a send awaiting no application acknowledgement: it **settles** the send.
   *     MSH-15 `AL` with MSH-16 `NE` is a legal pair and a peer answering it with one `CA`
   *     has done exactly what was asked.
   *   * `CA` on a send awaiting one: **reported, not settled.** The send stays pending and
   *     its second wait starts here.
   *   * a second `CA` on a send already reported: surfaced, and neither re-reported nor
   *     allowed to restart the second wait.
   *   * `CE` or `CR`: the peer refused custody of the bytes, so no application
   *     acknowledgement is coming. The send **fails now**, whatever its application
   *     condition and whether or not a `CA` was already reported. Waiting out the second
   *     window would report the same failure later and less precisely.
   *   * NULL or unclassifiable: surfaced with a code that distinguishes the two, and the
   *     send is left pending until its outstanding wait expires. An acknowledgement that
   *     cannot be classified into a mode is not guessed.
   *
   * Returns the entry when it is to be settled (the caller resolves it), `null` otherwise.
   */
  private matchTwoPhase(
    entry: PendingAck,
    payload: Buffer,
    byteOffsetFromAck: number,
  ): PendingAck | null {
    const twoPhase = entry.twoPhase;
    /* c8 ignore next */
    if (twoPhase === null) return entry;
    const now = this._opts.now();
    const classification = classifyMsa1(payload);
    const elapsedSinceSendMs = entry.sentAt === null ? 0 : now - entry.sentAt;
    const controlIdBytes = entry.controlId === null ? null : entry.controlId.length;

    if (classification.kind === "code") {
      const code = classification.code;
      if (code === "AA" || code === "AE" || code === "AR") {
        this._disposeTwoPhase(entry, now);
        return entry;
      }
      if (code === "CE" || code === "CR") {
        this._disposeTwoPhase(entry, now);
        this._opts.onCommitRejected?.(entry, code);
        return null;
      }
      // `CA`.
      if (!twoPhase.awaitsApplicationAck) {
        this._disposeTwoPhase(entry, now);
        return entry;
      }
      if (twoPhase.commitCode !== null) {
        this._ackModeWarn("MLLP_ACK_COMMIT_ALREADY_REPORTED", {
          msa1Bytes: classification.byteLength,
          ackCode: code,
          controlIdBytes,
          byteOffset: byteOffsetFromAck,
          elapsedSinceSendMs,
        });
        return null;
      }
      twoPhase.commitCode = code;
      twoPhase.commitReceivedAt = now;
      this._opts.onCommitReported?.(entry, payload, elapsedSinceSendMs);
      return null;
    }

    this._ackModeWarn(
      classification.kind === "null" ? "MLLP_ACK_MSA1_ABSENT" : "MLLP_ACK_MSA1_UNCLASSIFIABLE",
      {
        msa1Bytes: classification.byteLength,
        ackCode: null,
        controlIdBytes,
        byteOffset: byteOffsetFromAck,
        elapsedSinceSendMs,
      },
    );
    return null;
  }

  /**
   * Sweep live entries; expire those past `sentAt + ackTimeoutMs`.
   * Fires `onTimeout(entry, elapsedMs)`; entries move to graveyard.
   * Driven externally by `MllpClient`'s periodic sweep tick, Correlator
   * itself owns no timers.
   *
   * A two-phase entry whose accept acknowledgement has arrived is bounded by the **second**
   * window instead, measured from that acknowledgement: the first-acknowledgement timeout
   * is stopped, so it can no longer expire against a send the peer has already answered.
   * Both windows are finite, so no send waits forever either way.
   */
  expireDue(now?: number): void {
    const t = now ?? this._opts.now();
    const ackTimeoutMs = this._opts.ackTimeoutMs;
    for (const [key, entry] of this._pending) {
      if (entry.sentAt === null) continue;
      const twoPhase = entry.twoPhase;
      const commitReceivedAt = twoPhase?.commitReceivedAt ?? null;
      if (twoPhase !== null && commitReceivedAt !== null) {
        if (commitReceivedAt + twoPhase.applicationAckTimeoutMs <= t) {
          this._removeExpired(key, entry);
          this._disposed.set(key, t);
          const elapsed = t - commitReceivedAt;
          if (this._opts.onApplicationAckTimeout !== undefined) {
            this._opts.onApplicationAckTimeout(entry, elapsed);
          } else {
            this._opts.onTimeout(entry, elapsed);
          }
        }
        continue;
      }
      if (entry.sentAt + ackTimeoutMs <= t) {
        const elapsed = t - entry.sentAt;
        this._removeExpired(key, entry);
        if (twoPhase !== null) {
          // A two-phase send is remembered by elapsed time alone, so a peer that repeats an
          // acknowledgement is answered the same way every time inside the window.
          this._disposed.set(key, t);
        } else {
          this._graveyard.set(key, {
            timedOutAt: t,
            controlId: entry.controlId,
          });
        }
        this._opts.onTimeout(entry, elapsed);
      }
    }
  }

  /**
   * Reject every live entry with `reason` (insertion order) and clear
   * the live store. Graveyard is left intact (ages out via lazy eviction).
   * Used by `MllpClient`'s correlator teardown to cancel pending sends.
   *
   * `reasonFor` lets the caller substitute a different error per entry, which is how a send
   * whose commit disposition has already been reported is failed with an error that carries
   * that disposition rather than with the generic one.
   */
  clear(reason: Error, reasonFor?: (entry: PendingAck, reason: Error) => Error): void {
    const now = this._opts.now();
    for (const entry of this._pending.values()) {
      if (entry.twoPhase !== null) this._disposed.set(entry.key, now);
      entry.reject(reasonFor === undefined ? reason : reasonFor(entry, reason));
    }
    this._pending.clear();
    this._queueBytes = 0;
    // PLAN-06: reset _inFlight unconditionally, clear() drops every entry,
    // flushed or not. Avoids any over-decrement edge case.
    this._inFlight = 0;
  }

  /** Iterate live entries in insertion order (reconnect-resend). */
  *liveEntries(): IterableIterator<PendingAck> {
    for (const entry of this._pending.values()) yield entry;
  }

  /**
   * Remove a live entry by key WITHOUT resolving/rejecting. Returns the
   * removed entry, or `null` if no entry with that key exists.
   * Used by `MllpClient.send()` for AbortSignal cleanup and by the
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

  /**
   * Remove a live entry by key WITHOUT resolving/rejecting it, and remember that it was
   * disposed of, so a later acknowledgement for it is answered "already disposed" rather
   * than "no such send" for as long as the window lasts.
   *
   * The caller settles or fails the returned entry itself. Used where the client fails a
   * send that had already drawn a commit disposition.
   */
  dispose(key: CorrelationKey): PendingAck | null {
    const entry = this.remove(key);
    if (entry === null) return null;
    if (entry.twoPhase !== null) this._disposed.set(key, this._opts.now());
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

  /**
   * Lazy eviction of both bounded memories: graveyard entries past
   * `timedOutAt + 2 * ackTimeoutMs`, and disposed two-phase sends past
   * `disposedAt + 2 * ackTimeoutMs`. Same window, so "already disposed" and "arrived after
   * its timeout" are remembered for the same length of time, and past it both correctly
   * read as "no such send". The memory is bounded, not perpetual.
   */
  private _evictGraveyardDue(now: number): void {
    const threshold = 2 * this._opts.ackTimeoutMs;
    for (const [key, entry] of this._graveyard) {
      if (entry.timedOutAt + threshold <= now) this._graveyard.delete(key);
    }
    for (const [key, disposedAt] of this._disposed) {
      if (disposedAt + threshold <= now) this._disposed.delete(key);
    }
  }

  /** Remove a live entry that has just expired, keeping the counters straight. */
  private _removeExpired(key: CorrelationKey, entry: PendingAck): void {
    this._pending.delete(key);
    this._queueBytes -= entry.byteCount;
    // PLAN-06: the caller has already established that this entry was flushed.
    this._inFlight -= 1;
  }

  /** Drop a two-phase entry from the live store and remember that it was disposed of. */
  private _disposeTwoPhase(entry: PendingAck, now: number): void {
    this._pending.delete(entry.key);
    this._queueBytes -= entry.byteCount;
    // PLAN-06 (D-26): only flushed entries count toward _inFlight.
    if (entry.sentAt !== null) this._inFlight -= 1;
    this._disposed.set(entry.key, now);
  }

  /** Emit an acknowledgement-mode diagnostic, when the caller wired a sink for them. */
  private _ackModeWarn(code: AckModeCode, ctx: AckModeWarningContext): void {
    this._opts.onAckModeWarning?.(code, ctx);
  }
}
