/**
 * MLLP Client — `createClient()` factory and `MllpClient` class.
 *
 * Provides the client-side MLLP transport: connect to an MLLP server over TCP,
 * encode and send framed messages, decode inbound ACKs, and surface lifecycle
 * events with frozen payloads. Supports `AbortSignal` cancellation on every
 * awaitable and `Symbol.asyncDispose` for `await using` ergonomics.
 *
 * Phase 5 PLAN-01 ships only the lifecycle scaffolding — `connect()`, `close()`,
 * `destroy()`, event re-emission. Subsequent plans add `send()` (PLAN-02), control-id
 * correlation (PLAN-03), auto-reconnect (PLAN-04), backpressure (PLAN-05), and
 * `createStarterClient` + `getStats()` (PLAN-06).
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
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';

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
  // PLAN-02 adds: ackTimeoutMs?: number
  // PLAN-03 adds: correlateByControlId?: boolean
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
 * client.on('stateChange', ({ from, to }) => console.log(from, '->', to));
 * client.on('message', ({ payload }) => console.log('received', payload.length, 'bytes'));
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

  constructor(opts: ClientOptions) {
    super();
    this._opts = opts;
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
        // Tear down the in-flight attempt
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
   * @param conn - Connection to subscribe to.
   */
  private _attachConnection(conn: Connection): void {
    conn.on('stateChange', (e: StateChangeEvent) => {
      this.emit('stateChange', Object.freeze({ ...e }));
    });
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
    conn.on('message', (e: unknown) => {
      this.emit('message', Object.freeze({ ...(e as object) }));
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
    if (conn === null) return;

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
