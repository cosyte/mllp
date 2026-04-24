/**
 * MLLP Server — createServer(), createStarterServer(), and MllpServer class.
 *
 * Provides the server-side MLLP transport: listen for inbound TCP connections,
 * decode MLLP-framed messages, surface them as Buffer payloads, and support
 * optional auto-ACK, keepalive, graceful shutdown, and AbortSignal cancellation.
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/hl7-mllp';
 *
 * const server = createServer({
 *   onMessage: (payload, meta, conn) => {
 *     console.log('received', payload.length, 'bytes from', meta.connectionId);
 *   },
 * });
 * await server.listen(2575);
 * ```
 *
 * @packageDocumentation
 */

import { createServer as netCreateServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { Connection } from '../connection/index.js';
import { NetTransport } from '../transport/index.js';
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';

/**
 * Metadata attached to each decoded MLLP message (SERVER-03).
 *
 * All fields are `readonly` — the object is `Object.freeze()`'d before emission.
 *
 * @example
 * ```typescript
 * server.on('message', ({ payload, meta }) => {
 *   console.log(meta.connectionId, '@', meta.byteOffset, 'warnings:', meta.warnings.length);
 * });
 * ```
 */
export interface MessageMeta {
  /** Stable UUID identifying the connection that delivered this message. */
  readonly connectionId: string;
  /** Byte offset of the frame start in the connection's data stream. */
  readonly byteOffset: number;
  /** Framing warnings emitted during decoding of this frame. */
  readonly warnings: readonly MllpWarning[];
}

/**
 * Observability snapshot returned by `server.getStats()` (OBS-02).
 *
 * All fields are JSON-serializable. `connections` and `activeConnections` both
 * reflect the current live connection count (ROADMAP SC-5 / OBS-02).
 *
 * @example
 * ```typescript
 * const stats = server.getStats();
 * console.log(JSON.stringify(stats)); // log-pipeline friendly
 * ```
 */
export interface ServerStats {
  /** Whether the server is currently accepting connections. */
  readonly listening: boolean;
  /** Bound port, or `null` before listen(). */
  readonly port: number | null;
  /** Bound host, or `null` before listen(). */
  readonly host: string | null;
  /**
   * Current live connection count (OBS-02, ROADMAP SC-5).
   * Same value as `activeConnections`.
   */
  readonly connections: number;
  /** Current live connection count. Same value as `connections`. */
  readonly activeConnections: number;
  /** Aggregate bytes received across all current connections. */
  readonly totalBytesIn: number;
  /** Aggregate bytes sent across all current connections. */
  readonly totalBytesOut: number;
  /** Total connections accepted since listen() (monotonically increasing). */
  readonly acceptedTotal: number;
  /** Total connections closed since listen() (monotonically increasing). */
  readonly closedTotal: number;
}

/**
 * Options for `createServer()`.
 *
 * @example
 * ```typescript
 * const opts: ServerOptions = {
 *   onMessage: (payload, meta, conn) => {
 *     const ack = buildAck(payload);
 *     conn.send(ack);
 *   },
 *   framing: { maxFrameSizeBytes: 4 * 1024 * 1024 },
 *   keepaliveIntervalMs: 60_000,
 *   deadPeerTimeoutMs: 300_000,
 *   drainTimeoutMs: 30_000,
 * };
 * ```
 */
export interface ServerOptions {
  /**
   * Called for each decoded MLLP message.
   *
   * Return a `Buffer` or `Promise<Buffer>` to send as the ACK payload (auto-framed).
   * Return `void` to handle ACKing manually via `conn.send()`.
   *
   * NOTE: If `autoAck` is also set, do NOT call `conn.send()` here — two ACKs will be sent.
   */
  onMessage?: (
    payload: Buffer,
    meta: MessageMeta,
    conn: Connection,
  ) => void | Buffer | Promise<Buffer>;

  /**
   * FrameReader tolerance options applied to every accepted connection (SERVER-12).
   * Merged with SERVER_DEFAULT_FRAMING — caller-supplied values override defaults.
   * `onFrame` and `onWarning` are managed internally and must not be supplied here.
   */
  framing?: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'>;

  /**
   * Per-connection warning subscriber. Called for every framing warning on every connection.
   */
  onWarning?: (w: MllpWarning) => void;

  /**
   * Auto-ACK mode. When set, the server automatically sends an ACK after each message.
   *
   * - `'AA'`: sends a minimal AA acknowledgement (built from MSH fields without a parser).
   * - `fn`: calls `fn(payload, meta, conn)` and sends the returned Buffer as the ACK.
   *
   * The `'message'` event fires BEFORE the auto-ACK is sent (D-03). Do NOT call
   * `conn.send()` in `onMessage` when auto-ACK is active — this results in two ACKs.
   */
  autoAck?: 'AA' | ((payload: Buffer, meta: MessageMeta, conn: Connection) => Buffer | Promise<Buffer>);

  /**
   * TCP keepalive probe interval in ms (D-10).
   * Calls `socket.setKeepAlive(true, ms)` on each accepted socket.
   * Uses OS TCP stack to detect dead peers (half-open, network partitions).
   * Distinct from `deadPeerTimeoutMs` (application-level idle close).
   */
  keepaliveIntervalMs?: number;

  /**
   * Application-level idle close timeout in ms (D-11, ROADMAP SC-5).
   * If no HL7 messages are received on a connection for this interval, the connection
   * is destroyed via `conn.destroy(new Error('idle timeout'))`.
   * Resets on every `'message'` event. Distinct from `keepaliveIntervalMs` (OS TCP probe).
   */
  deadPeerTimeoutMs?: number;

  /**
   * Graceful drain timeout passed to `conn.close()` during `server.close()` (D-06).
   * Default: 30 000 ms.
   */
  drainTimeoutMs?: number;
}

/**
 * Options for `createStarterServer()` (stub — Plan 04 fills in the implementation).
 */
export interface StarterServerOptions extends ServerOptions {
  /** Port to listen on. */
  port: number;
  /** Host to bind to (default '0.0.0.0'). */
  host?: string;
  /** Register SIGTERM/SIGINT handlers that call `server.close()` (default: false). */
  handleSignals?: boolean;
}

/**
 * Default framing options applied to every server-side FrameReader (D-12).
 *
 * Reflects real-world MLLP device behavior:
 * - `allowFsOnly: true` — accept FS without trailing CR
 * - `allowLfAfterFs: true` — accept FS+LF (common vendor deviation)
 * - `allowLeadingWhitespace: true` — accept leading whitespace before VT
 * - `allowMissingLeadingVt: false` — require VT framing (stricter than FS-only tolerance)
 */
const SERVER_DEFAULT_FRAMING: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'> = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowLeadingWhitespace: true,
  allowMissingLeadingVt: false,
};

/**
 * MLLP TCP server — wraps `net.Server` without extending it (D-02).
 *
 * Each accepted socket is wrapped in a `NetTransport`, connected to a `Connection`
 * with server-level framing options, and added to `_connections`. Messages are
 * surfaced via the `'message'` event and the `onMessage` callback.
 *
 * Public events: `'listening'`, `'connection'`, `'error'`, `'close'`.
 * All event payloads are `Object.freeze()`'d before emission (SERVER-10).
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/hl7-mllp';
 *
 * const server = createServer({
 *   onMessage: (payload, meta, conn) => {
 *     console.log('received from', meta.connectionId);
 *   },
 * });
 * await server.listen(2575);
 * // await using server = createServer({ ... }); // Symbol.asyncDispose
 * ```
 */
export class MllpServer extends EventEmitter {
  private readonly _netServer: NetServer;
  private readonly _connections: Set<Connection> = new Set();
  private readonly _opts: ServerOptions;

  private _listening = false;
  private _port: number | null = null;
  private _host: string | null = null;
  private _acceptedTotal = 0;
  private _closedTotal = 0;

  constructor(opts: ServerOptions) {
    super();
    this._opts = opts;
    this._netServer = netCreateServer();

    // Wire net.Server events
    this._netServer.on('connection', (socket: Socket) => {
      this._onSocketAccepted(socket);
    });
    this._netServer.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  /**
   * Start listening on the given port.
   *
   * Resolves once the TCP socket is bound and emits `'listening'` with
   * `Object.freeze({ port: actualPort, host: actualHost })`.
   *
   * @param port - TCP port to bind. Use `0` to let the OS assign an ephemeral port.
   * @param hostOrOpts - Host string or object with `host` and optional `signal`.
   *
   * @example
   * ```typescript
   * await server.listen(2575);
   * await server.listen(0, '127.0.0.1');
   * await server.listen(0, { host: '127.0.0.1', signal: ac.signal });
   * ```
   */
  listen(port: number, hostOrOpts?: string | { host?: string; signal?: AbortSignal }): Promise<void> {
    const host = typeof hostOrOpts === 'string'
      ? hostOrOpts
      : hostOrOpts?.host ?? '0.0.0.0';
    const signal = typeof hostOrOpts === 'object' && hostOrOpts !== null
      ? hostOrOpts.signal
      : undefined;

    return new Promise<void>((resolve, reject) => {
      let aborted = false;

      const abortHandler = () => {
        aborted = true;
        this._netServer.close();
        reject(new Error('listen() aborted'));
      };

      if (signal !== undefined) {
        if (signal.aborted) {
          reject(new Error('listen() aborted'));
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const onListening = () => {
        if (aborted) return;
        signal?.removeEventListener('abort', abortHandler);

        const addr = this._netServer.address();
        const actualPort = typeof addr === 'object' && addr !== null ? addr.port : port;
        const actualHost = typeof addr === 'object' && addr !== null ? addr.address : host;

        this._listening = true;
        this._port = actualPort;
        this._host = actualHost;

        this.emit('listening', Object.freeze({ port: actualPort, host: actualHost }));
        resolve();
      };

      const onError = (err: Error) => {
        if (aborted) return;
        signal?.removeEventListener('abort', abortHandler);
        reject(err);
      };

      this._netServer.once('listening', onListening);
      this._netServer.once('error', onError);
      this._netServer.listen(port, host);
    });
  }

  /**
   * Stop accepting new connections and gracefully close all active connections.
   *
   * At Plan 01 scope this is a skeleton: stops the net.Server and resolves immediately.
   * Plan 03 adds the full drain-with-timeout coordination.
   *
   * @param opts.drainTimeoutMs - Override drain timeout (default: `opts.drainTimeoutMs ?? 30_000`).
   * @param opts.signal - AbortSignal to cancel the close operation.
   *
   * @example
   * ```typescript
   * await server.close({ drainTimeoutMs: 5_000 });
   * ```
   */
  // Plan 03 fills in drain coordination; opts param used then
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async close(opts?: { drainTimeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    // Plan 03 will add: drain all active connections with timeout
    // For now: stop accepting and mark not listening
    await new Promise<void>((resolve) => {
      if (!this._listening) {
        resolve();
        return;
      }
      this._netServer.close(() => resolve());
    });
    this._listening = false;
    return Promise.resolve();
  }

  /**
   * Async disposal — delegates to `close()` for `await using` support.
   *
   * @example
   * ```typescript
   * await using server = createServer({ onMessage: handler });
   * await server.listen(2575);
   * // server.close() is called automatically at end of block
   * ```
   */
  async [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }

  /**
   * Return a JSON-serializable observability snapshot (OBS-02).
   *
   * `totalBytesIn` and `totalBytesOut` aggregate from live connections at call time.
   * Plan 04 adds full aggregation; at Plan 01 scope they return 0.
   *
   * @example
   * ```typescript
   * const stats = server.getStats();
   * logger.info(JSON.stringify(stats));
   * ```
   */
  getStats(): ServerStats {
    // Plan 04 will aggregate bytesIn/Out from connections — stub at 0 for now
    return {
      listening: this._listening,
      port: this._port,
      host: this._host,
      connections: this._connections.size,
      activeConnections: this._connections.size,
      totalBytesIn: 0,
      totalBytesOut: 0,
      acceptedTotal: this._acceptedTotal,
      closedTotal: this._closedTotal,
    };
  }

  // ---------------------------------------------------------------------------
  // Private: per-socket setup
  // ---------------------------------------------------------------------------

  private _onSocketAccepted(socket: Socket): void {
    // TCP keepalive — must be set on the raw socket BEFORE passing to NetTransport (D-10)
    if (this._opts.keepaliveIntervalMs !== undefined) {
      socket.setKeepAlive(true, this._opts.keepaliveIntervalMs);
    }

    // Phase 6: wire TlsTransport here when opts.tls is provided
    const transport = new NetTransport(socket);
    const mergedFraming: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'> = {
      ...SERVER_DEFAULT_FRAMING,
      ...(this._opts.framing ?? {}),
    };

    const connOpts = this._opts.onWarning !== undefined
      ? { transport, framing: mergedFraming, onWarning: this._opts.onWarning }
      : { transport, framing: mergedFraming };
    const conn = new Connection(connOpts);

    // Set beforeClose no-op hook (Plan 04 will wire autoAck drain here if needed)
    conn.beforeClose = () => Promise.resolve();

    this._acceptedTotal++;
    this._connections.add(conn);

    // Remove from tracking when connection closes (CLOSED) or disconnects (DISCONNECTED).
    // Connection transitions to DISCONNECTED when peer closes gracefully (CONNECTED → DISCONNECTED).
    // It reaches CLOSED on destroy() / drain timeout / CONNECTING or RECONNECTING close.
    // We remove on either terminal-ish state to avoid leaking connections in _connections.
    const _onConnEnded = () => {
      this._connections.delete(conn);
      this._closedTotal++;
    };
    conn.once('close', _onConnEnded);
    conn.once('disconnect', _onConnEnded);

    // Wire dead-peer idle timeout (D-11) — reset on every message
    if (this._opts.deadPeerTimeoutMs !== undefined) {
      const timeoutMs = this._opts.deadPeerTimeoutMs;
      let deadPeerTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        conn.destroy(new Error('idle timeout'));
      }, timeoutMs);
      deadPeerTimer.unref();

      conn.on('message', () => {
        clearTimeout(deadPeerTimer);
        deadPeerTimer = setTimeout(() => {
          conn.destroy(new Error('idle timeout'));
        }, timeoutMs);
        deadPeerTimer.unref();
      });

      conn.once('close', () => {
        clearTimeout(deadPeerTimer);
      });
    }

    // Notify the connection that the socket is connected (server-side — already connected)
    conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);

    // Wire message handler: emit 'message' event, then invoke onMessage callback, then autoAck
    // Explicitly type the event argument to avoid unsafe-assignment from EventEmitter any
    conn.on('message', (event: { payload: Buffer; connectionId: string }) => {
      const { payload, connectionId } = event;
      const meta: MessageMeta = Object.freeze({
        connectionId,
        byteOffset: 0, // Plan 04 will thread actual byte offsets from FrameReader
        warnings: [] as readonly MllpWarning[],
      });

      const frozenEvent = Object.freeze({ payload, meta });
      this.emit('message', frozenEvent);

      // Invoke optional onMessage callback (D-03: fires before auto-ACK)
      const callbackResult = this._opts.onMessage?.(payload, meta, conn);

      // Handle auto-ACK (D-03/D-04)
      if (this._opts.autoAck !== undefined) {
        void this._sendAutoAck(payload, meta, conn, callbackResult);
      } else if (callbackResult instanceof Promise || callbackResult instanceof Buffer) {
        // If onMessage returned a Buffer/Promise<Buffer>, send it as the ACK
        void this._sendCallbackAck(callbackResult, conn);
      }
    });

    // Emit server-level 'connection' event with frozen payload
    this.emit(
      'connection',
      Object.freeze({
        connectionId: conn.connectionId,
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
      }),
    );
  }

  /**
   * Send the auto-ACK response (D-03/D-04).
   * Auto-ACK errors are emitted on the connection, never crash the server.
   */
  private async _sendAutoAck(
    payload: Buffer,
    meta: MessageMeta,
    conn: Connection,
    callbackResult: void | Buffer | Promise<Buffer> | undefined,
  ): Promise<void> {
    try {
      let ackPayload: Buffer;

      if (this._opts.autoAck === 'AA') {
        // If onMessage returned a Buffer, use it; otherwise build minimal AA
        if (callbackResult instanceof Buffer) {
          ackPayload = callbackResult;
        } else if (callbackResult instanceof Promise) {
          ackPayload = await callbackResult;
        } else {
          ackPayload = _buildMinimalAA(payload);
        }
      } else {
        // autoAck is a function
        ackPayload = await (this._opts.autoAck as (p: Buffer, m: MessageMeta, c: Connection) => Buffer | Promise<Buffer>)(payload, meta, conn);
      }

      conn.send(ackPayload);
    } catch (err: unknown) {
      // D-04: auto-ACK errors are emitted as 'error' on connection — server continues
      conn.emit(
        'error',
        Object.freeze({
          connectionId: conn.connectionId,
          error: err instanceof Error ? err : new Error(String(err)),
        }),
      );
    }
  }

  /**
   * Send the ACK payload returned by the onMessage callback (non-autoAck path).
   */
  private async _sendCallbackAck(
    result: Buffer | Promise<Buffer>,
    conn: Connection,
  ): Promise<void> {
    try {
      const ackPayload = result instanceof Buffer ? result : await result;
      conn.send(ackPayload);
    } catch {
      // Swallow errors in non-autoAck callback ACK path — caller handles via conn events
    }
  }
}

/**
 * Build a minimal AA acknowledgement from raw HL7 payload bytes without a parser.
 *
 * Extracts MSH-10 (message control ID) by splitting on `|` and using index 9.
 * The result is a best-effort AA — callers that need a standards-compliant ACK
 * should use `@cosyte/hl7-mllp/ack-from-hl7` (Phase 6) or supply their own builder.
 */
function _buildMinimalAA(payload: Buffer): Buffer {
  const str = payload.toString('ascii');
  const fields = str.split('|');
  const sendingApp = fields[2] ?? '';
  const sendingFacility = fields[3] ?? '';
  const receivingApp = fields[4] ?? '';
  const receivingFacility = fields[5] ?? '';
  const msgControlId = fields[9] ?? '';
  // Build a 14-char timestamp (YYYYMMDDHHmmss) without .slice() (SETUP-07)
  const d = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  const now =
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds());

  const ack =
    `MSH|^~\\&|${receivingApp}|${receivingFacility}|${sendingApp}|${sendingFacility}|${now}||ACK|${now}|P|2.5\rMSA|AA|${msgControlId}\r`;
  return Buffer.from(ack, 'ascii');
}

/**
 * Factory function — creates a new `MllpServer` with the supplied options.
 *
 * Prefer `createServer()` over `new MllpServer()` for forward-compatible construction.
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/hl7-mllp';
 *
 * const server = createServer({
 *   onMessage: (payload, meta, conn) => {
 *     console.log('received', payload.length, 'bytes');
 *   },
 * });
 * await server.listen(2575);
 * ```
 */
export function createServer(opts: ServerOptions = {}): MllpServer {
  return new MllpServer(opts);
}

/**
 * Starter factory — creates, configures, and starts an `MllpServer` in one call.
 *
 * Provides the "three lines of code" north-star experience with sensible defaults:
 * `autoAck: 'AA'`, `drainTimeoutMs: 30_000`, `Symbol.asyncDispose` wired.
 *
 * NOTE: Stub at Plan 01 scope — Plan 04 fills in the full implementation.
 *
 * @example
 * ```typescript
 * import { createStarterServer } from '@cosyte/hl7-mllp';
 *
 * const server = await createStarterServer({
 *   port: 2575,
 *   onMessage: (payload) => buildAck(payload),
 * });
 * ```
 */
export async function createStarterServer(opts: StarterServerOptions): Promise<MllpServer> {
  const server = createServer({
    ...opts,
    autoAck: opts.autoAck ?? 'AA',
    drainTimeoutMs: opts.drainTimeoutMs ?? 30_000,
  });
  await server.listen(opts.port, opts.host);
  return server;
}
