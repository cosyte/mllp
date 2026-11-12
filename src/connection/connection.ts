/**
 * Connection, 6-state FSM over a Transport with lifecycle events, warning streams,
 * and getStats() observability.
 *
 * @example
 * ```typescript
 * import { Connection, NetTransport } from '@cosyte/mllp';
 * import { createConnection } from 'node:net';
 *
 * const socket = createConnection({ host: 'localhost', port: 2575 });
 * const transport = new NetTransport(socket);
 * const conn = new Connection({ transport });
 * conn.on('message', ({ payload }) => conn.send(ackBuffer));
 * conn.on('stateChange', ({ from, to }) => logger.info({ from, to }));
 * socket.on('connect', () => conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null));
 * ```
 *
 * @packageDocumentation
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Transport } from "../transport/index.js";
import { FrameReader, MllpFramingError } from "../framing/index.js";
import type { FrameReaderOptions, MllpWarning } from "../framing/index.js";
import { MllpConnectionError } from "./error.js";
import type { ConnectionErrorPhase } from "./error.js";

/**
 * The 6 connection states.
 *
 * Transitions are validated against the legal-transition edge graph. Illegal transitions
 * are silently ignored to preserve FSM integrity.
 */
export type ConnectionState =
  "CONNECTING" | "CONNECTED" | "DRAINING" | "RECONNECTING" | "DISCONNECTED" | "CLOSED";

/**
 * Payload for the 'stateChange' event. Always `Object.freeze`'d.
 *
 * @example
 * ```typescript
 * conn.on('stateChange', ({ from, to, reason }) => {
 *   logger.info({ from, to, reason });
 * });
 * ```
 */
export interface StateChangeEvent {
  readonly from: ConnectionState;
  readonly to: ConnectionState;
  readonly reason?: string;
}

/**
 * Payload for the 'reconnecting' event. Always `Object.freeze`'d.
 *
 * `attempt` and `delayMs` are populated by `MllpClient` when it schedules a
 * reconnect. A `Connection` emitting on its own supplies `connectionId` only.
 *
 * @example
 * ```typescript
 * conn.on('reconnecting', ({ connectionId }) => {
 *   logger.info(`Reconnecting connection ${connectionId}`);
 * });
 * ```
 */
export interface ReconnectingEvent {
  readonly connectionId: string;
  readonly attempt?: number;
  readonly delayMs?: number;
}

/**
 * Return type of `connection.getStats()`, JSON-serializable.
 *
 * All timestamps are `Date | null` (not epoch milliseconds). `JSON.stringify()`
 * serialises them to ISO 8601 strings by default with no information loss.
 *
 * @example
 * ```typescript
 * const stats = conn.getStats();
 * logger.info(JSON.stringify(stats)); // safe: all values are JSON-serializable
 * ```
 */
export interface ConnectionStats {
  readonly state: ConnectionState;
  readonly connectionId: string;
  readonly remoteAddress: string | null;
  readonly remotePort: number | null;
  readonly warningsByCode: Record<string, number>;
  readonly bytesIn: number;
  readonly bytesOut: number;
  readonly lastByteInAt: Date | null;
  readonly lastByteOutAt: Date | null;
  readonly connectedAt: Date | null;
  readonly warningsTruncated: boolean;
}

/**
 * Options for constructing a {@link Connection}.
 *
 * @example
 * ```typescript
 * const opts: ConnectionOptions = {
 *   transport: new NetTransport(socket),
 *   onMessage: (payload) => handleMessage(payload),
 *   onWarning: (w) => logger.warn(w),
 *   drainTimeoutMs: 10_000,
 * };
 * ```
 */
export interface ConnectionOptions {
  /** The transport this Connection will drive. */
  transport: Transport;
  /** Called for each decoded MLLP frame (raw payload bytes, framing stripped). */
  onMessage?: (payload: Buffer) => void;
  /** Per-connection warning subscriber. Replaces previous subscription. */
  onWarning?: (w: MllpWarning) => void;
  /** Drain timeout used by close() (default: 30_000 ms). */
  drainTimeoutMs?: number;
  /** FrameReader options (tolerance, maxFrameSizeBytes). onFrame/onWarning are managed internally. */
  framing?: Omit<FrameReaderOptions, "onFrame" | "onWarning">;
}

/** Warning ring buffer cap. */
const MAX_WARNINGS = 100;

/**
 * Legal state transitions.
 *
 * CONNECTING → CONNECTED | RECONNECTING | CLOSED
 * CONNECTED  → DRAINING  | RECONNECTING | DISCONNECTED | CLOSED
 * DRAINING   → DISCONNECTED | CLOSED
 * RECONNECTING → CONNECTING | CLOSED
 * DISCONNECTED → CLOSED
 * CLOSED     → (terminal, no outgoing transitions)
 */
const LEGAL_TRANSITIONS: ReadonlyMap<ConnectionState, ReadonlySet<ConnectionState>> = new Map([
  ["CONNECTING", new Set<ConnectionState>(["CONNECTED", "RECONNECTING", "CLOSED"])],
  ["CONNECTED", new Set<ConnectionState>(["DRAINING", "RECONNECTING", "DISCONNECTED", "CLOSED"])],
  ["DRAINING", new Set<ConnectionState>(["DISCONNECTED", "CLOSED"])],
  ["RECONNECTING", new Set<ConnectionState>(["CONNECTING", "CLOSED"])],
  ["DISCONNECTED", new Set<ConnectionState>(["CLOSED"])],
  ["CLOSED", new Set<ConnectionState>()],
]);

/**
 * A single MLLP connection wrapping a {@link Transport} with a 6-state FSM,
 * lifecycle events, per-connection warning streams, and `getStats()` observability.
 *
 * Emits events: `stateChange`, `connect`, `disconnect`, `reconnecting`, `close`,
 * `message`, `warning`, `error`.
 *
 * @example
 * ```typescript
 * import { Connection, NetTransport } from '@cosyte/mllp';
 * import { createConnection } from 'node:net';
 *
 * const socket = createConnection({ host: 'localhost', port: 2575 });
 * const conn = new Connection({ transport: new NetTransport(socket) });
 * conn.on('stateChange', ({ from, to }) => console.log(from, '->', to));
 * conn.on('message', ({ payload }) => console.log('received', payload.length, 'bytes'));
 * socket.on('connect', () =>
 *   conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null)
 * );
 * ```
 */
export class Connection extends EventEmitter {
  /** Stable UUIDv4 identifier for this connection. */
  readonly connectionId: string;

  private _state: ConnectionState = "CONNECTING";
  private readonly _transport: Transport;
  private readonly _reader: FrameReader;
  private readonly _opts: ConnectionOptions;

  private _remoteAddress: string | null = null;
  private _remotePort: number | null = null;
  private _connectedAt: Date | null = null;

  private _bytesIn = 0;
  private _bytesOut = 0;
  private _lastByteInAt: Date | null = null;
  private _lastByteOutAt: Date | null = null;

  /** Ring buffer: last MAX_WARNINGS entries. */
  private _warningBuffer: MllpWarning[] = [];
  /** Accurate total counts per code, unaffected by ring buffer truncation. */
  private readonly _warningsByCode: Map<string, number> = new Map();
  /** Set to true once the ring buffer overflows. */
  private _warningsTruncated = false;

  private _onWarningFn: ((w: MllpWarning) => void) | null = null;
  private _drainPromise: Promise<void> | null = null;
  /** Resolves {@link Connection._leftDraining}; called on the transition out of `DRAINING`. */
  private _leaveDraining!: (value: "left") => void;
  /**
   * Settles when the connection leaves `DRAINING` by any route: the drain finishing, the drain
   * timeout, a `destroy()`, or the peer closing. A connection enters `DRAINING` at most once, so
   * one promise per connection is enough. The drain races it, so a `close()` never outlives the
   * drain it waits on.
   */
  private readonly _leftDraining = new Promise<"left">((resolve) => {
    this._leaveDraining = resolve;
  });

  /**
   * Work answering a frame this connection delivered, still running, with what it owes the peer.
   * See {@link Connection.holdOpenFor}.
   */
  private readonly _answering = new Map<PromiseLike<unknown>, "ack" | "manual" | "observer">();
  /**
   * Set once a fatal framing error has been met, or {@link Connection.stopReading} called: from
   * then on no byte the peer sends is read.
   */
  private _refusing = false;
  /** When the `close()` drain began (`Date.now()`), or `undefined` when no `close()` is draining. */
  private _closeBegan: number | undefined;
  /** Ends the wait after a fatal framing error: destroys the transport once the bound passes. */
  private _refusalBound: ReturnType<typeof setTimeout> | undefined;

  /**
   * beforeClose hook, no-op default that resolves immediately.
   *
   * An owner may replace this instance property to run work before the socket
   * closes. Connection calls it during `close()`, racing against `drainTimeoutMs`.
   */
  beforeClose: (drainTimeoutMs: number) => Promise<void> = () => Promise.resolve();

  /**
   * Construct a connection over the given transport. Starts in `CONNECTING`; call
   * {@link Connection.notifyConnect} once the transport handshake completes.
   *
   * @param opts - Connection options (the transport, message/warning handlers, drain timeout, framing).
   */
  constructor(opts: ConnectionOptions) {
    super();
    this.connectionId = randomUUID();
    this._opts = opts;
    this._transport = opts.transport;

    if (opts.onWarning !== undefined) {
      this._onWarningFn = opts.onWarning;
    }

    this._reader = new FrameReader({
      ...(opts.framing ?? {}),
      onFrame: (payload, byteOffset, warnings) => {
        this._onFrameDecoded(payload, byteOffset, warnings);
      },
      onWarning: (w) => {
        this._onFramingWarning(w);
      },
    });

    // Wire transport callbacks
    this._transport.onData((chunk) => {
      // After a fatal framing error the reader's place in the stream is lost, so nothing more is
      // read while the frames already delivered are answered.
      if (this._refusing) return;
      this._bytesIn += chunk.length;
      this._lastByteInAt = new Date();
      try {
        this._reader.push(chunk);
      } catch (err) {
        // Nothing may escape the transport's data callback. On a real socket this callback IS
        // the `'data'` listener, so a throw here becomes an uncaught exception that kills the
        // entire process, taking every OTHER connection and every in-flight durable commit
        // with it. One junk byte from one misbehaving peer must not be able to do that.
        //
        // Reachable on a DEFAULT server: `SERVER_DEFAULT_FRAMING` leaves `allowMissingLeadingVt`
        // off, so any non-whitespace byte where a VT was expected throws MLLP_MISSING_LEADING_VT.
        // `MLLP_FRAME_TOO_LARGE` reaches here too.
        //
        // The two classes are kept DISTINCT on purpose. A framing error is the peer's fault; a
        // subscriber bug is ours. Reporting the second as the first would tell an operator the
        // peer sent bad bytes when in fact our own handler threw.
        if (err instanceof MllpFramingError) {
          this._onFatalFramingError(err);
        } else {
          this._onInternalReceiveError(err instanceof Error ? err : new Error(String(err)));
        }
      }
    });
    this._transport.onClose(() => {
      this._onTransportClose();
    });
    this._transport.onError((err) => {
      this._onTransportError(err);
    });
  }

  /**
   * Current FSM state. One of the 6 `ConnectionState` values.
   *
   * Subscribe to `'stateChange'` events for reactive state monitoring.
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Register or replace the per-connection warning subscriber.
   *
   * Subsequent calls replace the previous handler (set-once semantics prevent leaks).
   * The handler is called synchronously and any exception it throws is swallowed.
   *
   * @example
   * ```typescript
   * conn.onWarning((w) => logger.warn({ code: w.code, connectionId: w.connectionId }));
   * ```
   */
  onWarning(fn: (w: MllpWarning) => void): void {
    this._onWarningFn = fn;
  }

  /**
   * Notify the connection that the transport handshake has completed.
   *
   * Transitions `CONNECTING → CONNECTED` and emits the `'connect'` event.
   * Called externally by Server/Client after the socket connects. In any other state it does
   * nothing: a connection closed before its socket connected stays `CLOSED` and emits no
   * `'connect'`, and a second call on a `CONNECTED` connection emits no second one.
   *
   * @param remoteAddress - Remote peer IP address, or `null` if unavailable.
   * @param remotePort - Remote peer port, or `null` if unavailable.
   *
   * @example
   * ```typescript
   * socket.on('connect', () =>
   *   conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null)
   * );
   * ```
   */
  notifyConnect(remoteAddress: string | null, remotePort: number | null): void {
    // `CONNECTING` is the only state with a path to `CONNECTED`. Anywhere else (a connection
    // closed before its socket connected, or a connect reported twice) there is no transition,
    // so there is no 'connect' to announce and no peer address or connect time to record.
    if (this._state !== "CONNECTING") return;
    this._remoteAddress = remoteAddress;
    this._remotePort = remotePort;
    this._connectedAt = new Date();
    this._transition("CONNECTED");
    // Contained like every other emit in this class, `notifyConnect` is called from the
    // transport's connect callback, so a throwing subscriber would unwind into it.
    this._dispatchContained(() => {
      this.emit("connect", Object.freeze({ connectionId: this.connectionId }));
    });
  }

  /**
   * Write raw bytes to the transport (no framing applied).
   *
   * The server and the client wrap this with `encodeFrame()` to add MLLP framing.
   * Returns `false` if the connection is CLOSED or DISCONNECTED (no bytes written).
   *
   * @returns `true` if bytes flushed immediately; `false` if buffered (backpressure) or not writable.
   *
   * @example
   * ```typescript
   * const flushed = conn.send(encodeFrame(payload));
   * if (!flushed) logger.warn('backpressure detected');
   * ```
   */
  send(data: Buffer): boolean {
    if (this._state === "CLOSED" || this._state === "DISCONNECTED") return false;
    const ok = this._transport.write(data);
    this._bytesOut += data.length;
    this._lastByteOutAt = new Date();
    return ok;
  }

  /**
   * Initiate graceful close of the connection.
   *
   * - If `CONNECTING` or `RECONNECTING`: cancels the pending attempt, transitions
   *   directly to `CLOSED`, and calls `transport.destroy()`.
   * - If `CONNECTED`: transitions to `DRAINING`, calls `beforeClose(drainTimeoutMs)` and
   *   waits for it and for every piece of work passed to {@link Connection.holdOpenFor} that is
   *   still running, then `DRAINING → DISCONNECTED` and ends the transport gracefully, so what
   *   that work wrote reaches the peer. If the drain timeout elapses first: `DRAINING → CLOSED`
   *   and the transport is destroyed. Work still running when the drain ends that way (the
   *   timeout or a `destroy()`) is abandoned, and an `MllpConnectionError` with `phase: 'close'`
   *   on `'error'` says how many were left and that what they would write is not sent.
   * - If `DRAINING`: waits for the existing drain to complete (idempotent). When that is the
   *   wait after a fatal framing error, the work it abandons, if it ends by its bound, a
   *   `destroy()` or the peer closing before that work settles, is reported the same way.
   *
   * Every pending `close()` resolves as soon as the connection leaves `DRAINING`, by whatever
   * route: the hook resolving, the drain timeout, a `destroy()`, or the peer closing. A
   * `destroy()` during a long drain therefore ends the wait at once, not at the drain timeout.
   * - If `CLOSED` or `DISCONNECTED`: no-op.
   *
   * @param opts.drainTimeoutMs - Override drain timeout (default: `opts.drainTimeoutMs ?? 30_000`).
   *
   * @example
   * ```typescript
   * await conn.close({ drainTimeoutMs: 5_000 });
   * ```
   */
  async close(opts?: { drainTimeoutMs?: number }): Promise<void> {
    const timeout = opts?.drainTimeoutMs ?? this._opts.drainTimeoutMs ?? 30_000;

    // Terminal states, nothing to do
    if (this._state === "CLOSED" || this._state === "DISCONNECTED") return;

    // CONNECTING or RECONNECTING: cancel the pending attempt, there is nothing to drain
    if (this._state === "CONNECTING" || this._state === "RECONNECTING") {
      this._transition("CLOSED", "close() during " + this._state);
      this._transport.destroy();
      return;
    }

    // DRAINING already, join the in-progress drain rather than starting a second beforeClose call.
    // A connection waiting after a fatal framing error has no close() drain yet: from now on it
    // has one, so the work it abandons when that wait ends unsettled is reported like any other.
    if (this._state === "DRAINING") {
      this._closeBegan ??= Date.now();
      return this._drainPromise ?? Promise.resolve();
    }

    // CONNECTED → DRAINING
    this._closeBegan = Date.now();
    this._transition("DRAINING");
    this._drainPromise = this._drainWithTimeout(timeout).finally(() => {
      this._drainPromise = null;
    });
    return this._drainPromise;
  }

  /**
   * Race `beforeClose()` and the held work against the drain timeout.
   *
   * On normal completion: `DRAINING → DISCONNECTED` + `transport.close()`.
   * On timeout: `DRAINING → CLOSED` + `transport.destroy()`.
   */
  private async _drainWithTimeout(timeoutMs: number): Promise<void> {
    const drainPromise = Promise.all([this.beforeClose(timeoutMs), this._heldWorkSettled()]);
    let handle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      handle = setTimeout(() => {
        resolve("timeout");
      }, timeoutMs);
      // Unref so this timer does not keep the process alive
      handle.unref();
    });

    try {
      // The third racer ends the wait the moment something else ends the drain (a destroy, the
      // peer closing). Without it, a close() whose connection was already destroyed by a second,
      // shorter close() still waited out this close's own timeout.
      const result = await Promise.race([
        drainPromise.then(() => "done" as const),
        timeoutPromise,
        this._leftDraining,
      ]);

      // Already out of DRAINING: whatever ended the drain has settled the state and the transport.
      if (this._state !== "DRAINING") return;

      if (result === "timeout") {
        // Drain timed out: force DRAINING → CLOSED, abandoning whatever is still running
        this._reportAbandonedAfter("drain timeout");
        this._transition("CLOSED", "drain timeout");
        this._transport.destroy();
      } else {
        // Drain completed: DRAINING → DISCONNECTED, ending the transport gracefully
        this._transition("DISCONNECTED");
        this._transport.close();
      }
    } finally {
      clearTimeout(handle);
    }
  }

  /**
   * Abruptly destroy the connection, discarding any pending writes.
   *
   * Transitions from any non-terminal state directly to `CLOSED` and calls
   * `transport.destroy(reason)`. Emits `'close'` event. Idempotent, safe to
   * call multiple times.
   *
   * @param reason - Optional error to propagate to the transport.
   *
   * @example
   * ```typescript
   * conn.destroy(new Error('Timeout exceeded'));
   * ```
   */
  destroy(reason?: Error): void {
    if (this._state === "CLOSED") return;
    if (this._state === "DRAINING") {
      this._reportAbandonedAfter(reason?.message ?? "destroy()");
    }
    this._transition("CLOSED", reason?.message ?? "destroy()");
    this._transport.destroy(reason);
  }

  /**
   * Hold the connection open, on `close()` or a fatal framing error, until `work` settles.
   *
   * Pass the work that answers a frame this connection delivered: the handler and the write of
   * its acknowledgement. A `close()` waits for every piece of work passed here to settle before
   * it ends the transport, so an acknowledgement written by that work still goes out. When a
   * later frame on the same connection has a fatal framing error, the connection reads nothing
   * more, waits the same way, and only then closes, so the acknowledgement of a frame delivered
   * before the refused one still goes out. Either wait is bounded by `drainTimeoutMs` (default 30
   * seconds): work that has not settled by then is abandoned and the connection is destroyed.
   * `MllpServer` passes every message's work here itself; a caller driving a bare `Connection`
   * may do the same.
   *
   * `options.kind` says what the work owes the peer, which decides whether `close()` waits for it
   * and how an abandoned piece is reported:
   *
   * - `'ack'` (the default): the work writes the frame's acknowledgement as its last step, so
   *   while it runs the acknowledgement has not been sent. `close()` waits for it; abandoned, it is
   *   counted as a message delivered whose acknowledgement was not sent.
   * - `'manual'`: the work writes the acknowledgement itself at a point of its own choosing (a
   *   manual-mode handler). `close()` waits for it until it settles; abandoned, it is counted as a
   *   handler whose acknowledgement may not have been sent.
   * - `'observer'`: the work writes no acknowledgement (an `onMessage` observer in custom-ACK
   *   mode). `close()` does not wait for it; still running when a `close()` is abandoned, it is
   *   named separately as an observer still running. A fatal framing error still waits for it.
   *
   * A rejection of `work` is not reported here; it only ends the wait for it.
   *
   * @param work - The work answering one delivered frame.
   * @param options - `kind`: what the work owes the peer (default `'ack'`).
   *
   * @example
   * ```typescript
   * conn.on('message', ({ payload }) => {
   *   conn.holdOpenFor(commit(payload).then(() => conn.send(encodeFrame(ackFor(payload)))));
   * });
   * ```
   */
  holdOpenFor(
    work: PromiseLike<unknown>,
    options?: { readonly kind?: "ack" | "manual" | "observer" },
  ): void {
    const done = (): void => {
      this._answering.delete(work);
    };
    this._answering.set(work, options?.kind ?? "ack");
    work.then(done, done);
  }

  /**
   * Read nothing more from the peer: every byte that arrives from now on is dropped unread, and
   * no further frame is delivered. It cannot be undone.
   *
   * `MllpServer.close()` calls this on each connection before closing it, so no new message
   * reaches a handler while the ones already running finish and their acknowledgements are
   * written. A client must not call it before a `close()` that waits for acknowledgements, since
   * it would then never read them.
   *
   * @example
   * ```typescript
   * conn.stopReading();
   * await conn.close();
   * ```
   */
  stopReading(): void {
    this._refusing = true;
  }

  /**
   * Return a JSON-serializable observability snapshot.
   *
   * All timestamp fields are `Date | null` (not epoch milliseconds). `JSON.stringify()`
   * serialises them to ISO 8601 strings with no information loss.
   *
   * `warningsByCode` reflects every warning ever received regardless of ring buffer truncation.
   * `warningsTruncated` is `true` if the 100-entry ring buffer has overflowed.
   *
   * @example
   * ```typescript
   * const stats = conn.getStats();
   * console.log(JSON.stringify(stats)); // log-pipeline friendly
   * ```
   */
  getStats(): ConnectionStats {
    const warningsByCode: Record<string, number> = {};
    for (const [code, count] of this._warningsByCode) {
      warningsByCode[code] = count;
    }
    return {
      state: this._state,
      connectionId: this.connectionId,
      remoteAddress: this._remoteAddress,
      remotePort: this._remotePort,
      warningsByCode,
      bytesIn: this._bytesIn,
      bytesOut: this._bytesOut,
      lastByteInAt: this._lastByteInAt,
      lastByteOutAt: this._lastByteOutAt,
      connectedAt: this._connectedAt,
      warningsTruncated: this._warningsTruncated,
    };
  }

  // ---------------------------------------------------------------------------
  // Private FSM helpers
  // ---------------------------------------------------------------------------

  /**
   * Settle once no work passed to {@link Connection.holdOpenFor} that owes an acknowledgement is
   * running; an `'observer'` is not waited for. Work registered while waiting (a frame decoded
   * from bytes already read) is waited for too.
   */
  private async _heldWorkSettled(): Promise<void> {
    for (;;) {
      const owing = [...this._answering].filter(([, kind]) => kind !== "observer");
      if (owing.length === 0) return;
      await Promise.allSettled(owing.map(([work]) => work));
    }
  }

  /**
   * Report, on `'error'`, the held work a `close()` drain abandons because the drain ended before
   * that work settled. It counts per delivered message: work that would have written an
   * acknowledgement (not sent), a manual-mode handler (its acknowledgement may not have been
   * sent), and, separately, observers that owe none. Nothing is reported when no `close()` is
   * draining or nothing is still running.
   *
   * @param how - How the drain ended, as it reads after "close() ended ".
   * @param reason - What ended it, the message of the report's `cause`.
   */
  private _reportAbandonedWork(how: string, reason: string): void {
    if (this._closeBegan === undefined) return;
    const count = { ack: 0, manual: 0, observer: 0 };
    for (const kind of this._answering.values()) count[kind] += 1;
    const parts: string[] = [];
    if (count.ack > 0) {
      parts.push(
        count.ack === 1
          ? "1 message was delivered and its acknowledgement was not sent"
          : `${String(count.ack)} messages were delivered and their acknowledgements were not sent`,
      );
    }
    if (count.manual > 0) {
      parts.push(
        count.manual === 1
          ? "1 manual-mode handler was still running, so its acknowledgement may not have been sent"
          : `${String(count.manual)} manual-mode handlers were still running, so their acknowledgements may not have been sent`,
      );
    }
    if (count.observer > 0) {
      parts.push(
        count.observer === 1
          ? "1 observer that owes no acknowledgement was still running"
          : `${String(count.observer)} observers that owe no acknowledgement were still running`,
      );
    }
    // Only work that owed an acknowledgement makes this worth reporting; observers ride along.
    if (count.ack + count.manual === 0) return;
    this._emitErrorIfListened(
      new MllpConnectionError(`close() ended ${how}: ${parts.join("; ")}`, {
        cause: new Error(reason),
        phase: "close",
      }),
    );
  }

  /** Report the work a `close()` drain abandons at the bound or on a `destroy()`. */
  private _reportAbandonedAfter(reason: string): void {
    const elapsedMs = Date.now() - (this._closeBegan ?? Date.now());
    this._reportAbandonedWork(`after ${String(elapsedMs)} ms (${reason})`, reason);
  }

  private _transition(to: ConnectionState, reason?: string): void {
    const from = this._state;
    const legal = LEGAL_TRANSITIONS.get(from);
    if (legal === undefined || !legal.has(to)) {
      // Illegal transition, silently ignore to preserve FSM integrity
      return;
    }
    // The state is committed BEFORE any subscriber runs, so a throwing subscriber can never leave
    // the FSM half-transitioned.
    this._state = to;
    const event = Object.freeze<StateChangeEvent>(
      reason !== undefined ? { from, to, reason } : { from, to },
    );

    // Every lifecycle emit is contained. `_transition` is reached from `destroy()`, which is
    // called from inside the `catch` block on the receive path, and a throw raised inside a catch
    // block is NOT caught by that block. A throwing 'stateChange'/'close' subscriber would
    // therefore unwind straight out of the socket's 'data' listener and kill the process, which is
    // the same defect as the decoder throw, just four frames up. Contain at the source: no emit in
    // this class is allowed to reach a transport callback.
    this._dispatchContained(() => {
      this.emit("stateChange", event);
    });

    // Release every close() waiting on this drain, whatever ended it.
    if (from === "DRAINING") this._leaveDraining("left");

    // Fire semantic lifecycle events
    if (to === "DISCONNECTED") {
      this._dispatchContained(() => {
        this.emit("disconnect", Object.freeze({ connectionId: this.connectionId }));
      });
    }
    if (to === "RECONNECTING") {
      this._dispatchContained(() => {
        this.emit("reconnecting", Object.freeze({ connectionId: this.connectionId }));
      });
    }
    if (to === "CLOSED") {
      this._dispatchContained(() => {
        this.emit("close", Object.freeze({ connectionId: this.connectionId }));
      });
    }
  }

  private _onTransportClose(): void {
    clearTimeout(this._refusalBound);
    if (this._state === "DRAINING") {
      // Transport closed during the drain: by our own end once the work settled, or by the peer
      // (a half-close is ended on our side too, the socket not being half-open) while work owing
      // an acknowledgement still ran, which can then no longer be sent.
      this._reportAbandonedWork("when the sender closed the connection", "peer closed");
      this._transition("DISCONNECTED");
      return;
    }
    if (this._state === "CONNECTED") {
      this._transition("DISCONNECTED", "peer closed");
      return;
    }
    if (this._state === "CONNECTING" || this._state === "RECONNECTING") {
      // Neither CONNECTING nor RECONNECTING has a path to DISCONNECTED.
      // Use CLOSED (terminal) for unexpected peer close here.
      this._transition("CLOSED", "peer closed");
    }
  }

  /**
   * Emit on `'error'` only when a listener is attached.
   *
   * Node throws `ERR_UNHANDLED_ERROR` when `'error'` is emitted on an `EventEmitter` with no
   * listener. Every `'error'` emission in this class is reached from inside a transport callback
   * (the socket's `'data'`/`'error'` listener), so an unguarded emit would become an **uncaught
   * exception that kills the process**, the exact failure the containment above exists to
   * prevent, merely relocated one frame up the stack.
   *
   * `Connection` is a public export and can legitimately be driven with no `'error'` listener
   * (`MllpServer` and `MllpClient` each attach one; a bare `Connection` need not). The connection
   * is still torn down and `'stateChange'`/`'close'` still fire, so a caller is never blind,
   * they simply do not get the typed error object they never asked for. Mirrors
   * `MllpServer._emitErrorIfListened`.
   */
  private _emitErrorIfListened(error: MllpConnectionError): void {
    if (this.listenerCount("error") === 0) return;
    try {
      this.emit("error", Object.freeze({ connectionId: this.connectionId, error }));
    } catch {
      // A throwing `'error'` subscriber must not escape either. This method is called from inside
      // socket callbacks AND from inside catch blocks, so a throw here would unwind straight out of
      // the socket handler, the same process kill, reached by a third route. This is the one place
      // a throw is deliberately swallowed: reporting is what just failed, so there is nowhere left
      // to report it to.
    }
  }

  /**
   * Handle a fatal framing error thrown out of `FrameReader.push`.
   *
   * Contract: surface it as a connection `'error'` (frozen payload, `phase: 'receive'`,
   * `connectionCause: 'framing-fatal'`, the original `MllpFramingError` preserved as `cause` so
   * consumers keep the stable `code` and `byteOffset`), then **destroy this connection only**.
   *
   * Why destroy rather than resynchronize: once `push` has thrown, the reader's position within
   * the byte stream is no longer trustworthy, the next bytes could be the middle of a message.
   * Guessing where the next frame starts is how a clinical message gets silently mis-split, so
   * the connection is dropped instead. A server drops that one peer and keeps serving everyone
   * else.
   *
   * `'framing-fatal'` is classified **permanent** by `isTransientConnectionError`, so a client
   * does **not** auto-reconnect into it. That matters: a peer speaking something that is not MLLP
   * (an HTTP probe, a health check, a wrong-port misconfiguration) would otherwise be retried
   * forever, and the backoff would become an unbounded reconnect storm against an interface
   * engine that is already unwell. A compatibility failure is not a network blip.
   *
   * Frames delivered before the refused one are still answered. Their handlers may still be
   * running (an acknowledgement is written after its handler settles, so even a synchronous
   * handler's is not out yet), and closing at once dropped every one of those acknowledgements:
   * the sender resent a message already committed, and it was processed twice. So when work
   * passed to {@link Connection.holdOpenFor} is still running, the connection reads nothing
   * more, moves to `DRAINING`, waits for that work to settle, then closes gracefully (`CLOSED`,
   * the transport ended so the acknowledgements written are flushed). The wait is bounded by
   * `drainTimeoutMs`: past it the connection is destroyed, settled or not, so a handler that never
   * settles cannot hold the socket open. With nothing running it is destroyed at once.
   *
   * If a peer's quirk is *expected*, the decoder's tolerance opt-ins are the supported answer:
   * `allowLeadingWhitespace` (padding or keepalive bytes before a frame), `allowMissingLeadingVt`,
   * `allowFsOnly` (a bare FS that the next frame's VT follows) and `allowLfAfterFs` turn their
   * throw into a warning. No opt-in accepts other bytes between frames, or a stray FS or VT inside
   * one: those are always refused.
   */
  private _onFatalFramingError(err: MllpFramingError): void {
    if (this._state === "CLOSED") return;
    this._emitErrorIfListened(
      new MllpConnectionError(err.message, {
        cause: err,
        phase: "receive",
        connectionCause: "framing-fatal",
      }),
    );
    // Only a `CONNECTED` connection waits. One already `DRAINING` is in a `close()` that ends it
    // soon by its own route, and nothing is answered in any other state.
    if (this._answering.size === 0 || this._state !== "CONNECTED") {
      this.destroy(err);
      return;
    }

    this._refusing = true;
    const boundMs = this._opts.drainTimeoutMs ?? 30_000;
    this._transition("DRAINING", err.message);
    // A close() called meanwhile waits for the same end.
    this._drainPromise = this._leftDraining.then(() => undefined);
    this._refusalBound = setTimeout(() => {
      // Past the bound: whatever is still running is abandoned, and reported when a close() is
      // waiting on it. Already `CLOSED` once the work settled, nothing is left to report, the
      // transition is refused and only the transport, still open, is destroyed.
      this._reportAbandonedAfter("drain timeout");
      this._transition("CLOSED", err.message);
      this._transport.destroy(err);
    }, boundMs);
    this._refusalBound.unref();

    // The work snapshot is the whole of it: nothing new can be delivered once refusing.
    void Promise.allSettled([...this._answering.keys()]).then(() => {
      // Ended some other way meanwhile: the peer closed, a destroy(), or the bound passed.
      if (this._state !== "DRAINING") return;
      this._transition("CLOSED", err.message);
      // Ended, not destroyed, so the acknowledgements just written reach the peer. The bound
      // timer still destroys the transport if the peer never closes its side.
      this._transport.close();
    });
  }

  /**
   * Backstop for a NON-framing throw escaping `FrameReader.push`, i.e. our own bug, or a
   * subscriber's, rather than the peer's bytes.
   *
   * `_onFrameDecoded` already contains subscriber throws at the dispatch site, so this should be
   * unreachable. It exists because "unreachable" and "cannot kill the process from inside a
   * socket `'data'` handler" are different claims, and only the second one is safe to bet a
   * clinical interface on. Reported honestly as an internal receive error, never dressed up as
   * a peer framing fault.
   */
  private _onInternalReceiveError(err: Error): void {
    if (this._state === "CLOSED") return;
    this._emitErrorIfListened(
      new MllpConnectionError(err.message, { cause: err, phase: "receive" }),
    );
    this.destroy(err);
  }

  private _onTransportError(err: Error): void {
    const phase: ConnectionErrorPhase =
      this._state === "CONNECTING"
        ? "connect"
        : this._state === "RECONNECTING"
          ? "reconnect"
          : this._state === "DRAINING"
            ? "close"
            : "receive";

    // Terminal states first. `destroy(err)` forwards the reason to `transport.destroy(err)`, which
    // makes the socket re-surface the same error here, so emitting before this guard reported a
    // single fatal framing error TWICE: once with `connectionCause: 'framing-fatal'`, then again
    // bare. That double-counts on an alerting dashboard and the echo carries no cause.
    if (this._state === "CLOSED" || this._state === "DISCONNECTED") return;

    // Guarded: this runs inside the transport's error callback, so an unlistened emit would throw
    // ERR_UNHANDLED_ERROR straight out of the socket's 'error' listener and kill the process. A
    // bare Connection (no 'error' listener) previously died on an ordinary ECONNRESET.
    this._emitErrorIfListened(new MllpConnectionError(err.message, { cause: err, phase }));
    // Reports only during a close() drain: no other state still standing here has begun one.
    this._reportAbandonedWork(`when the connection failed (${err.message})`, err.message);

    // CONNECTING and RECONNECTING have no path to DISCONNECTED, use CLOSED
    const target: ConnectionState =
      this._state === "CONNECTING" || this._state === "RECONNECTING" ? "CLOSED" : "DISCONNECTED";
    this._transition(target, `error: ${err.message}`);
  }

  private _onFrameDecoded(
    payload: Buffer,
    byteOffset: number,
    warnings: readonly MllpWarning[],
  ): void {
    // Only deliver messages when in an active state (CONNECTED or DRAINING)
    if (this._state !== "CONNECTED" && this._state !== "DRAINING") return;
    const event = Object.freeze({ payload, connectionId: this.connectionId, byteOffset, warnings });

    // `onFrame` is dispatched SYNCHRONOUSLY from inside `FrameReader.push()`, which is itself
    // called from the transport's data callback. A throwing subscriber, a metrics tap, a logger,
    // an ordinary consumer bug, would therefore unwind through `push()` and out of the socket's
    // `'data'` listener, killing the process, and on the way it would suppress the ACK for a
    // message the application may already have handled.
    //
    // Contain each subscriber independently (as warnings already are, below): one
    // bad subscriber cannot silence the other, cannot suppress the ACK, and cannot be mistaken
    // for a peer framing fault.
    this._dispatchContained(() => {
      this.emit("message", event);
    });
    this._dispatchContained(() => {
      this._opts.onMessage?.(payload);
    });
  }

  /**
   * Run a subscriber callback, containing any throw as a connection `'error'` rather than letting
   * it unwind into the socket callback that (transitively) invoked us.
   */
  private _dispatchContained(fn: () => void): void {
    try {
      fn();
    } catch (err) {
      const cause = err instanceof Error ? err : new Error(String(err));
      this._emitErrorIfListened(
        new MllpConnectionError(cause.message, { cause, phase: "receive" }),
      );
    }
  }

  private _onFramingWarning(w: MllpWarning): void {
    // Enrich with the connectionId and re-freeze
    const enriched = Object.freeze<MllpWarning>({ ...w, connectionId: this.connectionId });

    // Always update the count map, accurate regardless of ring buffer truncation
    this._warningsByCode.set(enriched.code, (this._warningsByCode.get(enriched.code) ?? 0) + 1);

    // Ring buffer: keep the last MAX_WARNINGS entries
    if (this._warningBuffer.length >= MAX_WARNINGS) {
      this._warningBuffer.shift(); // remove oldest
      this._warningsTruncated = true;
    }
    this._warningBuffer.push(enriched);

    // Per-connection subscriber: a throw is swallowed
    if (this._onWarningFn !== null) {
      try {
        this._onWarningFn(enriched);
      } catch {
        // A throwing handler must not disrupt frame processing
      }
    }

    // EventEmitter broadcast (aggregate warning stream).
    //
    // Contained for the same reason as the per-connection subscriber above: this runs synchronously
    // inside `FrameReader.push()`, itself inside the socket's 'data' callback, so a throwing
    // 'warning' listener would unwind out of the data handler and kill the process. A throwing
    // warning handler "must not disrupt frame processing", and that once held only for the
    // `onWarning` option, not for the event broadcast.
    this._dispatchContained(() => {
      this.emit("warning", enriched);
    });
  }
}
