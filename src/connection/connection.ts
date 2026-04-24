/**
 * Connection — 6-state FSM over a Transport with lifecycle events, warning streams,
 * and getStats() observability.
 *
 * @example
 * ```typescript
 * import { Connection, NetTransport } from '@cosyte/hl7-mllp';
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

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Transport } from '../transport/index.js';
import { FrameReader } from '../framing/index.js';
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';
import { MllpConnectionError } from './error.js';
import type { ConnectionErrorPhase } from './error.js';

/**
 * The 6 connection states from LIFE-01.
 *
 * Transitions are validated against the LIFE-02 edge graph. Illegal transitions
 * are silently ignored to preserve FSM integrity.
 */
export type ConnectionState =
  | 'CONNECTING'
  | 'CONNECTED'
  | 'DRAINING'
  | 'RECONNECTING'
  | 'DISCONNECTED'
  | 'CLOSED';

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
 * Phase 5 will populate `attempt` and `delayMs` once the reconnect backoff loop
 * is implemented. For now only `connectionId` is present at the point of emission.
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
  readonly attempt?: number;   // Phase 5 will populate
  readonly delayMs?: number;   // Phase 5 will populate
}

/**
 * Return type of `connection.getStats()` — JSON-serializable per OBS-04.
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
  /** Per-connection warning subscriber (WARN-10). Replaces previous subscription. */
  onWarning?: (w: MllpWarning) => void;
  /** Drain timeout used by close() in Phase 4/5 (default: 30_000 ms). */
  drainTimeoutMs?: number;
  /** FrameReader options (tolerance, maxFrameSizeBytes). onFrame/onWarning are managed internally. */
  framing?: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'>;
}

/** Warning ring buffer cap (OBS-05). */
const MAX_WARNINGS = 100;

/**
 * Legal state transitions per LIFE-02.
 *
 * CONNECTING → CONNECTED | RECONNECTING | CLOSED
 * CONNECTED  → DRAINING  | RECONNECTING | DISCONNECTED | CLOSED
 * DRAINING   → DISCONNECTED | CLOSED
 * RECONNECTING → CONNECTING | CLOSED
 * DISCONNECTED → CLOSED
 * CLOSED     → (terminal — no outgoing transitions)
 */
const LEGAL_TRANSITIONS: ReadonlyMap<ConnectionState, ReadonlySet<ConnectionState>> = new Map([
  ['CONNECTING', new Set<ConnectionState>(['CONNECTED', 'RECONNECTING', 'CLOSED'])],
  ['CONNECTED', new Set<ConnectionState>(['DRAINING', 'RECONNECTING', 'DISCONNECTED', 'CLOSED'])],
  ['DRAINING', new Set<ConnectionState>(['DISCONNECTED', 'CLOSED'])],
  ['RECONNECTING', new Set<ConnectionState>(['CONNECTING', 'CLOSED'])],
  ['DISCONNECTED', new Set<ConnectionState>(['CLOSED'])],
  ['CLOSED', new Set<ConnectionState>()],
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
 * import { Connection, NetTransport } from '@cosyte/hl7-mllp';
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
  /** Stable UUIDv4 identifier for this connection (D-11). */
  readonly connectionId: string;

  private _state: ConnectionState = 'CONNECTING';
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

  /** Ring buffer: last MAX_WARNINGS entries (OBS-05). */
  private _warningBuffer: MllpWarning[] = [];
  /** Accurate total counts per code — unaffected by ring buffer truncation (OBS-05). */
  private readonly _warningsByCode: Map<string, number> = new Map();
  /** Set to true once the ring buffer overflows (OBS-05). */
  private _warningsTruncated = false;

  private _onWarningFn: ((w: MllpWarning) => void) | null = null;
  private _drainPromise: Promise<void> | null = null;

  /**
   * beforeClose hook — no-op default that resolves immediately.
   *
   * Phase 4 (Server) and Phase 5 (Client) override this instance property to
   * register ACK-drain and send-queue drain logic respectively (D-07/D-08).
   * Connection calls this during `close()`, racing against `drainTimeoutMs`.
   */
  beforeClose: (drainTimeoutMs: number) => Promise<void> = () => Promise.resolve();

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
      onFrame: (payload) => { this._onFrameDecoded(payload); },
      onWarning: (w) => { this._onFramingWarning(w); },
    });

    // Wire transport callbacks
    this._transport.onData((chunk) => {
      this._bytesIn += chunk.length;
      this._lastByteInAt = new Date();
      this._reader.push(chunk);
    });
    this._transport.onClose(() => { this._onTransportClose(); });
    this._transport.onError((err) => { this._onTransportError(err); });
  }

  /**
   * Current FSM state. One of the 6 `ConnectionState` values (LIFE-01).
   *
   * Subscribe to `'stateChange'` events for reactive state monitoring.
   */
  get state(): ConnectionState {
    return this._state;
  }

  /**
   * Register or replace the per-connection warning subscriber (WARN-10).
   *
   * Subsequent calls replace the previous handler (set-once semantics prevent leaks).
   * The handler is called synchronously and any exception it throws is swallowed (WARN-06).
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
   * Called externally by Server/Client after the socket connects.
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
    this._remoteAddress = remoteAddress;
    this._remotePort = remotePort;
    this._connectedAt = new Date();
    this._transition('CONNECTED');
    this.emit('connect', Object.freeze({ connectionId: this.connectionId }));
  }

  /**
   * Write raw bytes to the transport (no framing applied).
   *
   * Phase 4 (Server) and Phase 5 (Client) wrap this with `encodeFrame()` to add MLLP framing.
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
    if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return false;
    const ok = this._transport.write(data);
    this._bytesOut += data.length;
    this._lastByteOutAt = new Date();
    return ok;
  }

  /**
   * Initiate graceful close of the connection.
   *
   * - If `CONNECTING` or `RECONNECTING`: cancels the pending attempt, transitions
   *   directly to `CLOSED`, and calls `transport.destroy()` (LIFE-05).
   * - If `CONNECTED`: transitions to `DRAINING`, calls `beforeClose(drainTimeoutMs)`,
   *   then `DRAINING → DISCONNECTED` once the hook resolves, or `DRAINING → CLOSED`
   *   if the drain timeout elapses first.
   * - If `DRAINING`: waits for the existing drain to complete (idempotent).
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

    // Terminal states — nothing to do
    if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return;

    // CONNECTING or RECONNECTING — cancel the pending attempt (LIFE-05)
    if (this._state === 'CONNECTING' || this._state === 'RECONNECTING') {
      this._transition('CLOSED', 'close() during ' + this._state);
      this._transport.destroy();
      return;
    }

    // DRAINING already — join the in-progress drain rather than starting a second beforeClose call
    if (this._state === 'DRAINING') {
      return this._drainPromise ?? Promise.resolve();
    }

    // CONNECTED → DRAINING
    this._transition('DRAINING');
    this._drainPromise = this._drainWithTimeout(timeout).finally(() => {
      this._drainPromise = null;
    });
    return this._drainPromise;
  }

  /**
   * Race `beforeClose()` against the drain timeout.
   *
   * On normal completion: `DRAINING → DISCONNECTED` + `transport.close()`.
   * On timeout: `DRAINING → CLOSED` + `transport.destroy()` (T-03-04-01).
   */
  private async _drainWithTimeout(timeoutMs: number): Promise<void> {
    const drainPromise = this.beforeClose(timeoutMs);
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      const handle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
      // Unref so this timer does not keep the process alive (T-03-04-01)
      handle.unref();
    });

    const result = await Promise.race([drainPromise.then(() => 'done' as const), timeoutPromise]);

    if (result === 'timeout') {
      // Drain timed out — force to CLOSED (DRAINING → CLOSED per LIFE-02)
      if (this._state === 'DRAINING') {
        this._transition('CLOSED', 'drain timeout');
        this._transport.destroy();
      }
    } else {
      // Drain completed — DRAINING → DISCONNECTED (LIFE-02)
      if (this._state === 'DRAINING') {
        this._transition('DISCONNECTED');
        this._transport.close();
      }
    }
  }

  /**
   * Abruptly destroy the connection, discarding any pending writes.
   *
   * Transitions from any non-terminal state directly to `CLOSED` and calls
   * `transport.destroy(reason)`. Emits `'close'` event. Idempotent — safe to
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
    if (this._state === 'CLOSED') return;
    this._transition('CLOSED', reason?.message ?? 'destroy()');
    this._transport.destroy(reason);
  }

  /**
   * Return a JSON-serializable observability snapshot (OBS-03/04/05).
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

  private _transition(to: ConnectionState, reason?: string): void {
    const from = this._state;
    const legal = LEGAL_TRANSITIONS.get(from);
    if (legal === undefined || !legal.has(to)) {
      // Illegal transition — silently ignore to preserve FSM integrity (T-03-03-04)
      return;
    }
    this._state = to;
    const event = Object.freeze<StateChangeEvent>(
      reason !== undefined ? { from, to, reason } : { from, to },
    );
    this.emit('stateChange', event);

    // Fire semantic lifecycle events
    if (to === 'DISCONNECTED') {
      this.emit('disconnect', Object.freeze({ connectionId: this.connectionId }));
    }
    if (to === 'RECONNECTING') {
      this.emit('reconnecting', Object.freeze({ connectionId: this.connectionId }));
    }
    if (to === 'CLOSED') {
      this.emit('close', Object.freeze({ connectionId: this.connectionId }));
    }
  }

  private _onTransportClose(): void {
    if (this._state === 'DRAINING') {
      // Transport closed naturally during graceful drain — complete the close
      this._transition('DISCONNECTED');
      return;
    }
    if (this._state === 'CONNECTED') {
      this._transition('DISCONNECTED', 'peer closed');
      return;
    }
    if (this._state === 'CONNECTING' || this._state === 'RECONNECTING') {
      // Neither CONNECTING nor RECONNECTING has a path to DISCONNECTED.
      // Use CLOSED (terminal) for unexpected peer close here.
      this._transition('CLOSED', 'peer closed');
    }
  }

  private _onTransportError(err: Error): void {
    const phase: ConnectionErrorPhase =
      this._state === 'CONNECTING'    ? 'connect'   :
      this._state === 'RECONNECTING'  ? 'reconnect' :
      this._state === 'DRAINING'      ? 'close'     :
      'receive';

    const connErr = new MllpConnectionError(err.message, { cause: err, phase });
    this.emit('error', Object.freeze({ connectionId: this.connectionId, error: connErr }));
    if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return;

    // CONNECTING and RECONNECTING have no path to DISCONNECTED — use CLOSED
    const target: ConnectionState =
      (this._state === 'CONNECTING' || this._state === 'RECONNECTING') ? 'CLOSED' : 'DISCONNECTED';
    this._transition(target, `error: ${err.message}`);
  }

  private _onFrameDecoded(payload: Buffer): void {
    // Only deliver messages when in an active state (CONNECTED or DRAINING)
    if (this._state !== 'CONNECTED' && this._state !== 'DRAINING') return;
    const event = Object.freeze({ payload, connectionId: this.connectionId });
    this.emit('message', event);
    this._opts.onMessage?.(payload);
  }

  private _onFramingWarning(w: MllpWarning): void {
    // Enrich with connectionId (D-09) and re-freeze
    const enriched = Object.freeze<MllpWarning>({ ...w, connectionId: this.connectionId });

    // Always update the count map — accurate regardless of ring buffer truncation (OBS-05)
    this._warningsByCode.set(enriched.code, (this._warningsByCode.get(enriched.code) ?? 0) + 1);

    // Ring buffer: keep last MAX_WARNINGS entries (OBS-05)
    if (this._warningBuffer.length >= MAX_WARNINGS) {
      this._warningBuffer.shift(); // remove oldest
      this._warningsTruncated = true;
    }
    this._warningBuffer.push(enriched);

    // Per-connection subscriber — swallow exceptions (WARN-06)
    if (this._onWarningFn !== null) {
      try {
        this._onWarningFn(enriched);
      } catch {
        // WARN-06: throwing handler must not disrupt frame processing
      }
    }

    // EventEmitter broadcast (aggregate warning stream)
    this.emit('warning', enriched);
  }
}
