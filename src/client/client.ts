/**
 * MLLP Client — `createClient()` factory and `MllpClient` class.
 *
 * Provides the client-side MLLP transport: connect to an MLLP server over TCP,
 * encode and send framed messages, decode inbound ACKs, and surface lifecycle
 * events with frozen payloads. Supports `AbortSignal` cancellation on every
 * awaitable and `Symbol.asyncDispose` for `await using` ergonomics.
 *
 * Phase 5 PLAN-01 shipped the lifecycle scaffolding — `connect()`, `close()`,
 * `destroy()`, event re-emission. PLAN-02 added `send()` + `MllpTimeoutError`.
 * The `correlateByControlId` option (MSH-10 → MSA-2 ACK matching) lights up
 * out-of-order ACK handling. Subsequent plans add auto-reconnect (PLAN-04),
 * backpressure (PLAN-05), and `createStarterClient` + `getStats()` (PLAN-06).
 *
 * @example
 * ```typescript
 * import { createClient } from '@cosyte/hl7-mllp';
 *
 * const client = createClient({ host: 'localhost', port: 2575 });
 * await client.connect();
 * // PLAN-02 will add: const ack = await client.send(payloadBuffer);
 * await client.close();
 * ```
 *
 * @packageDocumentation
 */

import { createConnection } from 'node:net';
import type { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { Connection } from '../connection/index.js';
import type {
  ConnectionState,
  StateChangeEvent,
} from '../connection/index.js';
import { MllpConnectionError } from '../connection/index.js';
import { NetTransport } from '../transport/index.js';
import { encodeFrame } from '../framing/index.js';
import { MllpFramingError } from '../framing/index.js';
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';
import {
  Correlator,
  extractMshControlId,
  extractMsaControlId,
} from './correlator.js';
import type { PendingAck } from './correlator.js';
import { MllpTimeoutError } from './error.js';

/**
 * Options for {@link createClient} and the {@link MllpClient} constructor.
 *
 * Phase 5 plans extend this incrementally — new fields are additive and optional.
 *
 * @example
 * ```typescript
 * const opts: ClientOptions = { host: 'localhost', port: 2575, drainTimeoutMs: 10_000 };
 * ```
 */
export interface ClientOptions {
  /** Host to connect to (e.g. `'localhost'` or `'mllp.example.com'`). */
  readonly host: string;
  /** TCP port. */
  readonly port: number;
  /** FrameReader tolerance / size options. `onFrame` and `onWarning` are managed internally. */
  readonly framing?: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'>;
  /** Drain timeout for {@link MllpClient.close} (default: `30_000` ms). */
  readonly drainTimeoutMs?: number;
  /**
   * Per-message ACK timeout in milliseconds (CLIENT-04). The clock starts at
   * the underlying `write()` flush callback, NOT at the `send()` call —
   * pre-flush queue time is not charged to the peer. Default: `30_000`.
   */
  readonly ackTimeoutMs?: number;
  /**
   * If `true`, ACKs are matched against outgoing sends by MSH-10 → MSA-2
   * (CLIENT-03 controlId branch). Default `false` (FIFO mode).
   *
   * Out-of-order ACKs from the peer are supported in this mode. MSH-10 is
   * extracted from the outbound payload before send; MSA-2 is extracted from
   * the inbound ACK payload. An ACK whose MSA-2 matches no pending send
   * (and is not in the late-ACK graveyard) emits a frozen
   * `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to the `'error'` event
   * (CLIENT-15). A late ACK whose MSA-2 matches a graveyard entry emits a
   * `MLLP_ACK_AFTER_TIMEOUT` warning (CLIENT-16) and is dropped.
   *
   * @default false
   */
  readonly correlateByControlId?: boolean;
  // PLAN-04 adds: autoReconnect?: boolean, retryStrategy?: RetryStrategy, initialDelayMs?: number, maxDelayMs?: number, multiplier?: number, jitter?: number
  // PLAN-05 adds: highWaterMark, onBackpressure, pipeline, keepaliveIntervalMs, deadPeerTimeoutMs
}

/**
 * MLLP client — composes a single Phase 3 {@link Connection} over a {@link NetTransport}
 * (production) or any other `Transport` (testing via {@link InMemoryTransport}).
 *
 * Public events — every payload `Object.freeze`'d before emission (D-25):
 * - `'stateChange'` — `{ from, to, reason? }` from the underlying Connection FSM
 * - `'connect'` — `{ connectionId }` once the FSM enters `CONNECTED`
 * - `'disconnect'` — `{ connectionId }` once the FSM enters `DISCONNECTED`
 * - `'reconnecting'` — `{ connectionId, attempt?, delayMs? }` (PLAN-04 populates)
 * - `'close'` — `{ connectionId }` once the FSM enters terminal `CLOSED`
 * - `'message'` — `{ payload, connectionId, byteOffset, warnings }` for every inbound frame
 * - `'warning'` — `MllpWarning` enriched with `connectionId` from the Connection layer
 * - `'error'` — re-emitted from Connection. Guarded by `listenerCount('error') > 0` so
 *   absence of a listener does NOT crash the process (server precedent).
 *
 * @example
 * ```typescript
 * const client = createClient({ host: 'localhost', port: 2575 });
 * client.on('stateChange', ({ from, to }) => logger.info({ from, to }));
 * client.on('message', ({ payload }) => logger.info({ bytes: payload.length }));
 * await client.connect();
 * // PLAN-02 will add: const ack = await client.send(payloadBuffer);
 * await client.close();
 * ```
 */
export class MllpClient extends EventEmitter {
  private readonly _opts: ClientOptions;
  private _connection: Connection | null = null;
  private _socket: Socket | null = null;
  /**
   * Initial state for `get state()` before `_connection` exists. Once a Connection
   * is attached, `state` mirrors `_connection.state`.
   */
  private _state: ConnectionState = 'DISCONNECTED';

  /** Per-message ACK timeout in ms (CLIENT-04). Resolved at construction. */
  private readonly _ackTimeoutMs: number;
  /** controlId-mode flag (CLIENT-03 branch). `false` → FIFO. */
  private readonly _correlateByControlId: boolean;
  /** Unified ACK correlator (D-03/A1). Built during `_attachConnection`. */
  private _correlator: Correlator | null = null;
  /**
   * Periodic ACK-timeout sweep timer. Drives `_correlator.expireDue()` because
   * the Correlator is timer-free per D-03. Cleared on close/destroy.
   */
  private _ackSweepTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: ClientOptions) {
    super();
    this._opts = opts;
    this._ackTimeoutMs = opts.ackTimeoutMs ?? 30_000;
    this._correlateByControlId = opts.correlateByControlId === true;
  }

  /**
   * Current FSM state. Mirrors the underlying Connection's state once attached;
   * before `connect()` (or after a `CLOSED` Connection is dropped) reports
   * the client-level baseline (`'DISCONNECTED'`).
   */
  get state(): ConnectionState {
    return this._connection?.state ?? this._state;
  }

  /**
   * Open a TCP connection to the configured `host:port` and attach a Phase 3
   * {@link Connection} to it. Resolves once the FSM enters `CONNECTED`.
   *
   * Rejects with:
   * - `DOMException('Aborted', 'AbortError')` if `signal` is provided and aborts
   *   before the connect resolves.
   * - `MllpConnectionError({ phase: 'connect' })` if the underlying socket emits
   *   `error` before connecting, OR if the client is already connecting/connected.
   *
   * @example
   * ```typescript
   * const ac = new AbortController();
   * setTimeout(() => ac.abort(), 5_000);
   * await client.connect({ signal: ac.signal });
   * ```
   */
  connect(opts?: { signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    // Reject if we already hold a live Connection. Once a Connection has reached
    // CLOSED or DISCONNECTED we drop the reference and allow a fresh connect().
    if (
      this._connection !== null &&
      this._connection.state !== 'CLOSED' &&
      this._connection.state !== 'DISCONNECTED'
    ) {
      return Promise.reject(
        new MllpConnectionError('already connected or connecting', {
          cause: new Error('already connected'),
          phase: 'connect',
        }),
      );
    }

    return new Promise<void>((resolve, reject) => {
      let aborted = false;

      // Phase 6: wire TlsTransport here when opts.tls is provided
      const socket = createConnection({
        host: this._opts.host,
        port: this._opts.port,
      });
      this._socket = socket;

      const transport = new NetTransport(socket);
      const connOpts = this._opts.framing !== undefined
        ? { transport, framing: this._opts.framing }
        : { transport };
      if (this._opts.drainTimeoutMs !== undefined) {
        (connOpts as { drainTimeoutMs?: number }).drainTimeoutMs =
          this._opts.drainTimeoutMs;
      }
      const conn = new Connection(connOpts);
      this._attachConnection(conn);

      const cleanup = (): void => {
        if (signal !== undefined) {
          signal.removeEventListener('abort', abortHandler);
        }
        socket.removeListener('connect', onSocketConnect);
        socket.removeListener('error', onSocketError);
      };

      const abortHandler = (): void => {
        aborted = true;
        cleanup();
        // Tear down the in-flight attempt — also clears the correlator so
        // any sweep timer armed by _attachConnection is released.
        this._teardownCorrelator(
          new MllpConnectionError('connect aborted', {
            cause: new Error('aborted'),
            phase: 'connect',
          }),
        );
        conn.destroy(new Error('aborted'));
        reject(new DOMException('Aborted', 'AbortError'));
      };

      const onSocketConnect = (): void => {
        if (aborted) return;
        cleanup();
        conn.notifyConnect(
          socket.remoteAddress ?? null,
          socket.remotePort ?? null,
        );
        resolve();
      };

      const onSocketError = (err: Error): void => {
        if (aborted) return;
        cleanup();
        // Surface the OS error wrapped in MllpConnectionError (Connection's
        // _onTransportError handles the same wrap once attached, but the
        // socket's 'error' may arrive before NetTransport hands it off).
        reject(
          new MllpConnectionError(err.message, { cause: err, phase: 'connect' }),
        );
      };

      if (signal !== undefined) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
      socket.once('connect', onSocketConnect);
      socket.once('error', onSocketError);
    });
  }

  /**
   * Wire a Connection's events through to this MllpClient. Every re-emitted
   * payload is `Object.freeze`'d before emission (D-25), even though the
   * Connection layer already freezes — defense-in-depth, harmless on
   * already-frozen objects.
   *
   * Builds the unified `Correlator` (D-03/A1) bound to this Connection and
   * arms the periodic ACK-timeout sweep. The Correlator is teardown-aware:
   * `close()` / `destroy()` clear the sweep timer and reject pending sends.
   *
   * @param conn - Connection to subscribe to.
   */
  private _attachConnection(conn: Connection): void {
    // Build the correlator before wiring listeners so the inbound 'message'
    // hand-off has a live store to consult.
    this._correlator = new Correlator({
      mode: this._correlateByControlId ? 'controlId' : 'fifo',
      ackTimeoutMs: this._ackTimeoutMs,
      onWarning: (code, ctx) => {
        this.emit(
          'warning',
          Object.freeze({
            code,
            byteOffset: ctx.byteOffset,
            message: `${code}: controlId=${ctx.controlId} elapsed=${ctx.elapsedSinceSendMs}ms`,
            connectionId: conn.connectionId,
            timestamp: new Date(),
          }),
        );
      },
      onUnmatchedAck: (controlId) => {
        // CLIENT-15: unmatched ACK in controlId mode. Emit a frozen
        // MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID') to the 'error'
        // event. listenerCount-guarded so absent listeners don't crash the
        // process (T-05-03-02 mitigation).
        if (this.listenerCount('error') === 0) return;
        const err = new MllpFramingError(
          'MLLP_ACK_UNMATCHED_CONTROL_ID',
          0,
          Buffer.alloc(0),
          `Unmatched ACK control ID${controlId === '' ? '' : `: ${controlId}`}`,
        );
        this.emit(
          'error',
          Object.freeze({
            connectionId: conn.connectionId,
            error: err,
            controlId,
          }),
        );
      },
      onTimeout: (entry, elapsedMs) => {
        entry.reject(
          new MllpTimeoutError(`ACK timeout after ${elapsedMs}ms`, {
            messageControlId: entry.controlId ?? undefined,
            elapsedMs,
            sentAt: entry.sentAt ?? 0,
          }),
        );
      },
    });

    // Periodic sweep: smaller of (ackTimeoutMs / 4) and 1000 ms; floor 50 ms.
    // .unref() so this timer never keeps the process alive.
    const sweepIntervalMs = Math.max(
      50,
      Math.min(1000, Math.floor(this._ackTimeoutMs / 4)),
    );
    this._ackSweepTimer = setInterval(() => {
      this._correlator?.expireDue();
    }, sweepIntervalMs);
    this._ackSweepTimer.unref();

    // Single 'stateChange' listener delegates to _onStateChange (B-04 anchor).
    conn.on('stateChange', (e: StateChangeEvent) => {
      this._onStateChange(e);
    });
    // Single 'message' listener: re-emit + delegate to _onAckPayload (B-04 anchor).
    conn.on(
      'message',
      (e: {
        payload: Buffer;
        connectionId: string;
        byteOffset: number;
        warnings: readonly MllpWarning[];
      }) => {
        this.emit('message', Object.freeze({ ...e }));
        this._onAckPayload(e.payload, e.byteOffset);
      },
    );
    // PLAN-01 lifecycle re-emitters preserved unchanged.
    conn.on('connect', (e: unknown) => {
      this.emit('connect', Object.freeze({ ...(e as object) }));
    });
    conn.on('disconnect', (e: unknown) => {
      this.emit('disconnect', Object.freeze({ ...(e as object) }));
    });
    conn.on('reconnecting', (e: unknown) => {
      this.emit('reconnecting', Object.freeze({ ...(e as object) }));
    });
    conn.on('close', (e: unknown) => {
      this.emit('close', Object.freeze({ ...(e as object) }));
    });
    conn.on('warning', (w: MllpWarning) => {
      this.emit('warning', w);
    });
    conn.on('error', (e: unknown) => {
      // Server precedent: only re-emit if a listener is attached, to avoid
      // ERR_UNHANDLED_ERROR crashing the process (T-05-01-03 mitigation).
      if (this.listenerCount('error') > 0) {
        this.emit('error', e);
      }
    });
    this._connection = conn;
  }

  /**
   * Single source-of-truth for inbound ACK payload handling.
   *
   * - FIFO mode: passes `null` controlId so `matchAck` returns the head of
   *   the live store.
   * - controlId mode: extracts MSA-2 at the `HOOK_EXTENSION_POINT: ack-payload`
   *   anchor and passes it to `matchAck` for keyed lookup.
   *
   * Called from the SINGLE `'message'` listener registered in `_attachConnection`.
   * No parallel listener is registered — downstream plans extend at the named
   * anchor (B-04).
   */
  private _onAckPayload(ackPayload: Buffer, byteOffset: number): void {
    if (this._correlator === null) return;
    // HOOK_EXTENSION_POINT: ack-payload
    const ackControlId: string | null = this._correlateByControlId
      ? extractMsaControlId(ackPayload)
      : null;
    const matched = this._correlator.matchAck(
      ackPayload,
      ackControlId,
      byteOffset,
    );
    if (matched !== null) {
      this._onAckMatched(matched, ackPayload);
    }
  }

  /**
   * Single source-of-truth for a successfully matched ACK (live-store hit).
   *
   * PLAN-02: emit frozen 'ack' event, call matched.resolve().
   * PLAN-04 extends at HOOK_EXTENSION_POINT: ack-matched to update _lastSuccessAt.
   * PLAN-06 extends at HOOK_EXTENSION_POINT: ack-matched to bump _ackedTotal and
   *   set _lastAckAt.
   *
   * Called from _onAckPayload when matchAck() returns a non-null PendingAck.
   */
  private _onAckMatched(matched: PendingAck, ackPayload: Buffer): void {
    const latencyMs =
      matched.sentAt !== null ? Date.now() - matched.sentAt : 0;
    this.emit(
      'ack',
      Object.freeze({
        payload: ackPayload,
        controlId: matched.controlId,
        latencyMs,
      }),
    );
    // HOOK_EXTENSION_POINT: ack-matched
    // PLAN-04 inserts: this._lastSuccessAt = Date.now();
    // PLAN-06 inserts: this._ackedTotal += 1; this._lastAckAt = Date.now();
    matched.resolve(ackPayload);
    // PLAN-05 extends after this point at the same anchor to emit 'drain' when
    //   queue depth crosses below highWaterMark.
  }

  /**
   * Single source-of-truth for Connection FSM transitions.
   *
   * PLAN-02: re-emit frozen 'stateChange' (was inline in PLAN-01; centralized
   * here so PLAN-04 / PLAN-05 can extend at named anchors).
   * PLAN-04 extends at HOOK_EXTENSION_POINT: state-change to detect
   *   CONNECTED → DISCONNECTED|RECONNECTING and trigger _handleDisconnect.
   * PLAN-05 extends at HOOK_EXTENSION_POINT: state-change to clear/arm
   *   dead-peer timer on transitions out of / into CONNECTED.
   *
   * Called from the SINGLE 'stateChange' listener registered in _attachConnection.
   */
  private _onStateChange(e: StateChangeEvent): void {
    this.emit('stateChange', Object.freeze({ ...e }));
    // HOOK_EXTENSION_POINT: state-change
    // PLAN-04 inserts disconnect-detection branch.
    // PLAN-05 inserts dead-peer timer arm/clear branch.
  }

  /**
   * Send an MLLP-framed payload and await the inbound ACK (CLIENT-02).
   *
   * Resolves with the ACK Buffer (framing stripped). Rejects with:
   * - `DOMException('Aborted', 'AbortError')` if `signal` aborts before ACK
   *   (CLIENT-11 send branch).
   * - `MllpTimeoutError` if no ACK arrives within `ackTimeoutMs` (ERR-02).
   *   The clock starts at the underlying `write()` flush callback, NOT at
   *   the `send()` call (CLIENT-04, D-19).
   * - `MllpConnectionError({ phase: 'send' })` if the client is not connected.
   *
   * Emits a frozen `'ack'` event on every successful match (D-25 + Specifics).
   *
   * @example
   * ```typescript
   * const ack = await client.send(payloadBuffer);
   * logger.info({ ack: ack.toString('utf8') });
   * ```
   *
   * @param payload Raw bytes; MLLP framing is added internally via `encodeFrame`.
   * @param opts.signal AbortSignal — aborting cancels the ACK wait (CLIENT-11).
   */
  send(payload: Buffer, opts?: { signal?: AbortSignal }): Promise<Buffer> {
    const signal = opts?.signal;
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }
    if (
      this._connection === null ||
      this._correlator === null ||
      this._connection.state !== 'CONNECTED'
    ) {
      return Promise.reject(
        new MllpConnectionError('send before connect', {
          cause: new Error(`client state is ${this.state}`),
          phase: 'send',
        }),
      );
    }
    // controlId mode: extract MSH-10 BEFORE enqueue so the live-store key
    // is the same string the peer will echo back as MSA-2.
    const controlId: string | null = this._correlateByControlId
      ? extractMshControlId(payload)
      : null;
    const correlator = this._correlator;
    const conn = this._connection;
    return new Promise<Buffer>((resolve, reject) => {
      let abortListener: (() => void) | null = null;
      const wrappedResolve = (ack: Buffer): void => {
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener('abort', abortListener);
        }
        resolve(ack);
      };
      const wrappedReject = (err: Error): void => {
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener('abort', abortListener);
        }
        reject(err);
      };
      // The Connection sends RAW bytes — frame the payload here (matches the
      // Phase 4 server pattern `conn.send(encodeFrame(ack))`). The frame is
      // what we hand to `enqueue()` so PLAN-04's reconnect-resend path can
      // re-emit identical bytes.
      const frame = encodeFrame(payload);
      const key = correlator.enqueue(
        frame,
        controlId,
        wrappedResolve,
        wrappedReject,
      );
      if (key === null) {
        // PLAN-05 implements maxInFlight=1 wait-for-drain; in PLAN-02
        // maxInFlight is Infinity so this is unreachable.
        wrappedReject(
          new MllpConnectionError('queue full', {
            cause: new Error('maxInFlight exceeded'),
            phase: 'send',
          }),
        );
        return;
      }
      if (signal !== undefined) {
        abortListener = (): void => {
          correlator.remove(key);
          wrappedReject(new DOMException('Aborted', 'AbortError'));
        };
        signal.addEventListener('abort', abortListener, { once: true });
      }
      // Connection.send returns boolean; `false` indicates socket-level
      // backpressure (the OS still buffers the bytes). PLAN-02 has no
      // app-level high-water mark so we just record the flush time.
      // PLAN-05 enforces high-water mark BEFORE enqueue.
      conn.send(frame);
      correlator.markFlushed(key, Date.now());
    });
  }

  /**
   * Tear down per-connection state (sweep timer + correlator) when the
   * client is closing or destroying. Safe to call multiple times.
   */
  private _teardownCorrelator(reason: Error): void {
    if (this._ackSweepTimer !== null) {
      clearInterval(this._ackSweepTimer);
      this._ackSweepTimer = null;
    }
    if (this._correlator !== null) {
      this._correlator.clear(reason);
      // Drop the reference so subsequent send() calls reject via the
      // _connection / _correlator null check.
      this._correlator = null;
    }
  }

  /**
   * **Test seam** — attach an externally-built {@link Connection} directly,
   * bypassing the `net.createConnection` + `NetTransport` path. Used by
   * lifecycle tests driving `InMemoryTransport.pair()` for determinism.
   *
   * @internal
   */
  _attachExistingConnection(conn: Connection): void {
    if (this._connection !== null) {
      throw new MllpConnectionError('connection already attached', {
        cause: new Error('attach twice'),
        phase: 'connect',
      });
    }
    this._attachConnection(conn);
  }

  /**
   * Gracefully close the client.
   *
   * Delegates to {@link Connection.close}, which transitions `CONNECTED → DRAINING
   * → DISCONNECTED` (or `CLOSED` on drain timeout). No-op if no Connection is
   * attached.
   *
   * Rejects with `DOMException('Aborted', 'AbortError')` if `signal` aborts mid-drain;
   * on abort, the underlying Connection is force-destroyed.
   *
   * @example
   * ```typescript
   * await client.close({ drainTimeoutMs: 5_000 });
   * ```
   */
  async close(opts?: {
    drainTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<void> {
    const signal = opts?.signal;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'));
    }

    const conn = this._connection;
    if (conn === null) {
      // No connection attached; still tear down any stray correlator state
      // (defensive — this branch is unreachable in normal flow).
      this._teardownCorrelator(
        new MllpConnectionError('client closed', {
          cause: new Error('closed'),
          phase: 'close',
        }),
      );
      return;
    }

    // Reject pending sends BEFORE delegating to Connection.close so callers
    // observe the rejection promptly rather than waiting for the drain.
    this._teardownCorrelator(
      new MllpConnectionError('client closed', {
        cause: new Error('closed'),
        phase: 'close',
      }),
    );

    if (signal === undefined) {
      const closeOpts =
        opts?.drainTimeoutMs !== undefined
          ? { drainTimeoutMs: opts.drainTimeoutMs }
          : undefined;
      await conn.close(closeOpts);
      return;
    }

    // Wire AbortSignal — abort during drain force-destroys the Connection
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = (): void => {
        conn.destroy(new Error('aborted'));
        reject(new DOMException('Aborted', 'AbortError'));
      };
      signal.addEventListener('abort', abortHandler, { once: true });
    });

    try {
      const closeOpts =
        opts?.drainTimeoutMs !== undefined
          ? { drainTimeoutMs: opts.drainTimeoutMs }
          : undefined;
      await Promise.race([conn.close(closeOpts), abortPromise]);
    } finally {
      if (abortHandler !== undefined) {
        signal.removeEventListener('abort', abortHandler);
      }
    }
  }

  /**
   * Abruptly destroy the client — force-transitions the underlying Connection
   * to `CLOSED` immediately. No-op if no Connection is attached. Idempotent.
   *
   * @example
   * ```typescript
   * client.destroy(new Error('shutting down'));
   * ```
   */
  destroy(reason?: Error): void {
    const teardownReason =
      reason ??
      new MllpConnectionError('client destroyed', {
        cause: new Error('destroyed'),
        phase: 'close',
      });
    this._teardownCorrelator(teardownReason);
    const conn = this._connection;
    if (conn === null) return;
    conn.destroy(reason);
  }

  /**
   * Async disposal — delegates to {@link MllpClient.close} for `await using` support.
   *
   * @example
   * ```typescript
   * await using client = createClient({ host: 'localhost', port: 2575 });
   * await client.connect();
   * // client.close() is called automatically at end of block
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/**
 * Create an {@link MllpClient}. Equivalent to `new MllpClient(opts)`.
 *
 * @example
 * ```typescript
 * import { createClient } from '@cosyte/hl7-mllp';
 *
 * const client = createClient({ host: 'localhost', port: 2575 });
 * await client.connect();
 * // PLAN-02 will add: const ack = await client.send(payloadBuffer);
 * await client.close();
 * ```
 */
export function createClient(opts: ClientOptions): MllpClient {
  return new MllpClient(opts);
}
