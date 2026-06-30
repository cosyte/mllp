/**
 * MLLP Server — createServer(), createStarterServer(), and MllpServer class.
 *
 * Provides the server-side MLLP transport: listen for inbound TCP connections,
 * decode MLLP-framed messages, surface them as Buffer payloads, and support
 * optional auto-ACK, keepalive, graceful shutdown, and AbortSignal cancellation.
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/mllp';
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

import { createServer as netCreateServer } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { EventEmitter } from "node:events";
import { Connection } from "../connection/index.js";
import { MllpConnectionError } from "../connection/index.js";
import { NetTransport } from "../transport/index.js";
import { encodeFrame } from "../framing/index.js";
import type { FrameReaderOptions, MllpWarning } from "../framing/index.js";
import { buildRawAck, resolveNackCode } from "./ack.js";
import type { AckCode, NegativeAckCode } from "./ack.js";

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
 * Payload of the server `'nack'` event — emitted when a commit-gated `autoAck: 'AA'`
 * handler throws/rejects and the server responds with a **negative** acknowledgement
 * instead of `AA` (the fail-safe commit contract).
 *
 * **PHI-safe by construction:** carries only the connection ID and the resolved
 * acknowledgement code — never the payload, the inbound control ID, or the thrown
 * error's message (which may carry PHI). The object is `Object.freeze()`'d before emission.
 *
 * @example
 * ```typescript
 * server.on('nack', ({ connectionId, ackCode }) => {
 *   metrics.increment('mllp.nack', { code: ackCode }); // ackCode is 'AE' | 'AR'
 * });
 * ```
 */
export interface NackEvent {
  /** Connection that produced the negative acknowledgement. */
  readonly connectionId: string;
  /** The negative acknowledgement code sent to the peer (`AE` or `AR`). */
  readonly ackCode: NegativeAckCode;
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
   * Its role depends on `autoAck` — this is the **commit contract** (HL7 v2.5.1 §2.9.2):
   *
   * - **`autoAck: 'AA'` + this handler ⇒ commit-gated (the safe default).** The handler
   *   is the durable-commit step. The server **awaits** it and only then sends the ACK:
   *   resolve ⇒ `AA`; **throw/reject ⇒ `AE`** (or `AR` via {@link MllpAckError}) — a
   *   positive ACK can never precede a successful commit. Do **not** call `conn.send()`
   *   here in this mode.
   * - **`autoAck` unset ⇒ manual mode.** The handler owns the response; build and send the
   *   ACK yourself via `conn.send(encodeFrame(ackPayload))`. Its return value is ignored.
   * - **`autoAck: fn` ⇒ observation only.** `fn` builds the ACK; this handler runs first as
   *   a side effect and its return value is ignored. Do not call `conn.send()` here.
   *
   * May be sync or async; an async handler is awaited in commit-gated mode.
   */
  onMessage?: (payload: Buffer, meta: MessageMeta, conn: Connection) => void | Promise<void>;

  /**
   * FrameReader tolerance options applied to every accepted connection (SERVER-12).
   * Merged with SERVER_DEFAULT_FRAMING — caller-supplied values override defaults.
   * `onFrame` and `onWarning` are managed internally and must not be supplied here.
   */
  framing?: Omit<FrameReaderOptions, "onFrame" | "onWarning">;

  /**
   * Per-connection warning subscriber. Called for every framing warning on every connection.
   */
  onWarning?: (w: MllpWarning) => void;

  /**
   * Auto-ACK mode. When set, the server builds and sends the ACK for each message.
   *
   * - **`'AA'`** — auto-acknowledge with the fail-safe **commit contract**:
   *   - **With an `onMessage` handler ⇒ commit-gated (recommended).** The server awaits
   *     `onMessage` (the durable-commit step), then sends `AA` on success or a **negative**
   *     ACK on failure (`AE` by default; `AR` via {@link MllpAckError}). The positive ACK
   *     **cannot precede a successful commit** — a handler throw can never yield `AA`.
   *   - **Without an `onMessage` handler ⇒ transport-accept.** `AA` is sent on frame
   *     receipt. This `AA` means only **"bytes received and framed"** — *not*
   *     "application-processed". ⚠️ For clinical messages this is unsafe on its own:
   *     pair `'AA'` with an `onMessage` handler that durably commits, so the ACK reflects
   *     real processing.
   * - **`fn`** — `fn(payload, meta, conn)` builds the ACK bytes the server sends; the
   *   caller fully owns MSA-1 (e.g. to emit enhanced-mode `CA`/`CE`/`CR`).
   *
   * The `'message'` event always fires BEFORE the ACK is sent (D-03). Do NOT call
   * `conn.send()` in `onMessage` when `autoAck` is set — this results in two ACKs.
   */
  autoAck?:
    | "AA"
    | ((payload: Buffer, meta: MessageMeta, conn: Connection) => Buffer | Promise<Buffer>);

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
 * Options for `createStarterServer()` — the "three lines of code" factory (SERVER-08).
 *
 * Extends `ServerOptions` with `port`, `host`, and `handleSignals`. Defaults:
 * `autoAck: 'AA'`, `drainTimeoutMs: 30_000`, `Symbol.asyncDispose` wired.
 *
 * @example
 * ```typescript
 * import { createStarterServer } from '@cosyte/mllp';
 *
 * const server = await createStarterServer({
 *   port: 2575,
 *   onMessage: (buf) => buildAckBuffer(buf),
 * });
 * // server is listening, auto-ACK enabled, Symbol.asyncDispose wired
 * await using _ = server; // closes on scope exit
 * ```
 */
export interface StarterServerOptions extends ServerOptions {
  /** Port to listen on. */
  port: number;
  /** Host to bind to (default '0.0.0.0'). */
  host?: string;
  /**
   * Register `process.once('SIGTERM')` and `process.once('SIGINT')` handlers that
   * call `server.close()` then `process.exit(0)` (D-09). Default: `false`.
   *
   * Handlers are automatically removed when `server.close()` is called, so
   * `process.listenerCount('SIGTERM') === 0` after close() completes — preventing
   * handler accumulation across test instances or multiple server restarts.
   */
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
const SERVER_DEFAULT_FRAMING: Omit<FrameReaderOptions, "onFrame" | "onWarning"> = {
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
 * Public events: `'listening'`, `'connection'`, `'message'`, `'nack'`, `'error'`, `'close'`.
 * The `'nack'` event ({@link NackEvent}) fires when a commit-gated `autoAck: 'AA'` handler
 * fails and the server returns a negative ACK instead of `AA`.
 * All event payloads are `Object.freeze()`'d before emission (SERVER-10).
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/mllp';
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

  /**
   * Construct an MLLP server. Created idle; call `listen()` (or use
   * {@link createServer}/{@link createStarterServer}) to begin accepting connections.
   *
   * @param opts - Server options (bind host/port, auto-ACK policy, message handler, framing, …).
   */
  constructor(opts: ServerOptions) {
    super();
    this._opts = opts;
    this._netServer = netCreateServer();

    // Wire net.Server events
    this._netServer.on("connection", (socket: Socket) => {
      this._onSocketAccepted(socket);
    });
    this._netServer.on("error", (err: Error) => {
      this.emit("error", err);
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
  listen(
    port: number,
    hostOrOpts?: string | { host?: string; signal?: AbortSignal },
  ): Promise<void> {
    const host = typeof hostOrOpts === "string" ? hostOrOpts : (hostOrOpts?.host ?? "0.0.0.0");
    const signal =
      typeof hostOrOpts === "object" && hostOrOpts !== null ? hostOrOpts.signal : undefined;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    return new Promise<void>((resolve, reject) => {
      let aborted = false;

      const abortHandler = () => {
        aborted = true;
        this._netServer.close();
        reject(new DOMException("Aborted", "AbortError"));
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      const onListening = () => {
        if (aborted) return;
        signal?.removeEventListener("abort", abortHandler);

        const addr = this._netServer.address();
        const actualPort = typeof addr === "object" && addr !== null ? addr.port : port;
        const actualHost = typeof addr === "object" && addr !== null ? addr.address : host;

        this._listening = true;
        this._port = actualPort;
        this._host = actualHost;

        this.emit("listening", Object.freeze({ port: actualPort, host: actualHost }));
        resolve();
      };

      const onError = (err: Error) => {
        if (aborted) return;
        signal?.removeEventListener("abort", abortHandler);
        reject(err);
      };

      this._netServer.once("listening", onListening);
      this._netServer.once("error", onError);
      this._netServer.listen(port, host);
    });
  }

  /**
   * Stop accepting new connections and gracefully close all active connections.
   *
   * Sequence (D-06):
   * 1. `net.Server.close()` — stops accepting new connections immediately
   * 2. If `_connections` is empty: resolves immediately (no drain needed)
   * 3. Calls `_drainAll(drainTimeoutMs)` — Promise.all + side-effect setTimeout
   *    that force-destroys stragglers after the drain window
   *
   * @param opts.drainTimeoutMs - Override drain timeout (default: `opts.drainTimeoutMs ?? 30_000`).
   * @param opts.signal - AbortSignal to cancel the close operation. On abort, all
   *   active connections are destroyed and the promise rejects with AbortError.
   *
   * @example
   * ```typescript
   * await server.close({ drainTimeoutMs: 5_000 });
   * ```
   */
  async close(opts?: { drainTimeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    // Stop accepting new connections
    this._netServer.close();
    this._listening = false;

    // If no active connections, we're done — emit 'close' and resolve
    // No abort handler registered on this path — nothing to remove.
    if (this._connections.size === 0) {
      this.emit("close", Object.freeze({}));
      return Promise.resolve();
    }

    // Wire AbortSignal — abort during drain force-destroys all connections
    let abortHandler: (() => void) | undefined;
    const abortPromise =
      signal !== undefined
        ? new Promise<"aborted">((_resolve, reject) => {
            abortHandler = () => {
              // Force-destroy all active connections on abort
              for (const conn of this._connections) {
                conn.destroy();
              }
              reject(new DOMException("Aborted", "AbortError"));
            };
            signal.addEventListener("abort", abortHandler, { once: true });
          })
        : null;

    try {
      const drainTimeoutMs = opts?.drainTimeoutMs ?? this._opts.drainTimeoutMs ?? 30_000;
      if (abortPromise !== null) {
        await Promise.race([this._drainAll(drainTimeoutMs), abortPromise]);
      } else {
        await this._drainAll(drainTimeoutMs);
      }
    } finally {
      if (abortHandler !== undefined && signal !== undefined) {
        signal.removeEventListener("abort", abortHandler);
      }
    }
    // Emit 'close' after all connections have drained (SERVER-10: frozen payload)
    this.emit("close", Object.freeze({}));
  }

  /**
   * Drain all active connections with a shared timeout.
   *
   * Uses Promise.all (not Promise.race) for coordination — the timeout is a
   * side effect that calls `conn.destroy()` on stragglers after `drainTimeoutMs`.
   * Promise.all resolves when all `conn.close()` promises settle (which happens
   * because `conn.destroy()` transitions connections to CLOSED).
   *
   * @param drainTimeoutMs - Maximum time to wait for connections to drain.
   */
  private async _drainAll(drainTimeoutMs: number): Promise<void> {
    // Snapshot connections for the close() call map (fixed at call time)
    const snapshot = [...this._connections];
    const closePromises = snapshot.map((conn) => conn.close({ drainTimeoutMs }));

    // Side-effect timeout: iterate LIVE this._connections (not snapshot) to only
    // destroy() connections that haven't already closed during the drain window
    const timeoutHandle = setTimeout(() => {
      for (const conn of this._connections) {
        conn.destroy();
      }
    }, drainTimeoutMs);
    // Do not keep the process alive just for this drain timer
    timeoutHandle.unref();

    try {
      await Promise.all(closePromises);
    } finally {
      clearTimeout(timeoutHandle);
    }
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
    // Aggregate totalBytesIn/Out from live connections at call time (OBS-02, D-13)
    let totalBytesIn = 0;
    let totalBytesOut = 0;
    for (const conn of this._connections) {
      const s = conn.getStats();
      totalBytesIn += s.bytesIn;
      totalBytesOut += s.bytesOut;
    }
    return {
      listening: this._listening,
      port: this._port,
      host: this._host,
      connections: this._connections.size,
      activeConnections: this._connections.size,
      totalBytesIn,
      totalBytesOut,
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
    const mergedFraming: Omit<FrameReaderOptions, "onFrame" | "onWarning"> = {
      ...SERVER_DEFAULT_FRAMING,
      ...(this._opts.framing ?? {}),
    };

    const connOpts =
      this._opts.onWarning !== undefined
        ? { transport, framing: mergedFraming, onWarning: this._opts.onWarning }
        : { transport, framing: mergedFraming };
    const conn = new Connection(connOpts);

    // Set beforeClose no-op hook (Plan 04 will wire autoAck drain here if needed)
    conn.beforeClose = () => Promise.resolve();

    // Default 'error' handler on connection — prevents ERR_UNHANDLED_ERROR when
    // auto-ACK or transport errors are emitted on a connection with no user-attached
    // error listener. Forwards to server's 'error' event only when listeners exist;
    // otherwise silently swallows (D-04: server never crashes on connection errors).
    conn.on("error", (errEvent: unknown) => {
      if (this.listenerCount("error") > 0) {
        this.emit("error", errEvent);
      }
    });

    this._acceptedTotal++;
    this._connections.add(conn);

    // Remove from tracking when connection closes (CLOSED) or disconnects (DISCONNECTED).
    // Connection transitions to DISCONNECTED when peer closes gracefully (CONNECTED → DISCONNECTED).
    // It reaches CLOSED on destroy() / drain timeout / CONNECTING or RECONNECTING close.
    // We remove on either terminal-ish state to avoid leaking connections in _connections.
    // Single-fire guard prevents double-counting when both 'disconnect' and 'close' fire.
    let ended = false;
    const _onConnEnded = () => {
      if (ended) return;
      ended = true;
      this._connections.delete(conn);
      this._closedTotal++;
    };
    conn.once("close", _onConnEnded);
    conn.once("disconnect", _onConnEnded);

    // Wire dead-peer idle timeout (D-11) — reset on every message
    if (this._opts.deadPeerTimeoutMs !== undefined) {
      const timeoutMs = this._opts.deadPeerTimeoutMs;
      let deadPeerTimer: ReturnType<typeof setTimeout> = setTimeout(() => {
        conn.destroy(new Error("idle timeout"));
      }, timeoutMs);
      deadPeerTimer.unref();

      conn.on("message", () => {
        clearTimeout(deadPeerTimer);
        deadPeerTimer = setTimeout(() => {
          conn.destroy(new Error("idle timeout"));
        }, timeoutMs);
        deadPeerTimer.unref();
      });

      conn.once("close", () => {
        clearTimeout(deadPeerTimer);
      });
    }

    // Notify the connection that the socket is connected (server-side — already connected)
    conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);

    // Wire message handler: always emit 'message' (received+framed) first, then route the
    // ACK by mode (the commit contract — see ServerOptions.autoAck). D-04: a handler error
    // never crashes the server. Async dispatch is wrapped in void; rejections are handled
    // inside the dispatch methods.
    conn.on(
      "message",
      (event: {
        payload: Buffer;
        connectionId: string;
        byteOffset: number;
        warnings: readonly MllpWarning[];
      }) => {
        const { payload, connectionId, byteOffset, warnings } = event;
        const meta: MessageMeta = Object.freeze({
          connectionId,
          byteOffset,
          warnings,
        });

        // D-03: emit 'message' BEFORE any ACK dispatch.
        this.emit("message", Object.freeze({ payload, meta }));

        const autoAck = this._opts.autoAck;
        if (autoAck === "AA") {
          // Commit-gated: onMessage is the durable-commit step; AA only on success,
          // AE/AR on failure — a positive ACK can never precede commit.
          void this._sendCommitAck(payload, meta, conn);
        } else if (autoAck !== undefined) {
          // Custom-ACK mode: onMessage is observation only; the fn owns the ACK bytes.
          this._observeMessage(payload, meta, conn);
          void this._sendCustomAck(autoAck, payload, meta, conn);
        } else {
          // Manual mode: onMessage owns the response via conn.send().
          this._observeMessage(payload, meta, conn);
        }
      },
    );

    // Emit server-level 'connection' event with frozen payload
    this.emit(
      "connection",
      Object.freeze({
        connectionId: conn.connectionId,
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
      }),
    );
  }

  /**
   * The fail-safe commit path for `autoAck: 'AA'` (HL7 v2.5.1 §2.9.2).
   *
   * With an `onMessage` handler this **awaits** it (the durable-commit step) and only
   * then dispatches: resolve ⇒ `AA`; throw/reject ⇒ a negative ACK (`AE` by default,
   * `AR` via {@link MllpAckError}). A positive ACK can never precede a successful commit.
   *
   * Without an `onMessage` handler, `'AA'` degrades to a **transport-accept** — `AA`
   * meaning "bytes received and framed", not "application-processed".
   *
   * A handler failure is **expected flow**, not a server error: it produces a negative
   * ACK and a `'nack'` event. The thrown error's message is never placed on the wire or
   * in the event (it may carry PHI) — only the static `ackCode` and the inbound control
   * metadata reach the peer.
   */
  private async _sendCommitAck(
    payload: Buffer,
    meta: MessageMeta,
    conn: Connection,
  ): Promise<void> {
    const handler = this._opts.onMessage;

    // No commit handler: 'AA' is a transport-accept (received+framed only).
    if (handler === undefined) {
      this._dispatchAck(conn, buildRawAck(payload, "AA"));
      return;
    }

    let code: AckCode;
    try {
      await handler(payload, meta, conn); // durable-commit step
      code = "AA";
    } catch (err: unknown) {
      const nack: NegativeAckCode = resolveNackCode(err);
      code = nack;
      // PHI-safe observability: control ID + outcome only, never the payload or error text.
      this.emit("nack", Object.freeze({ connectionId: conn.connectionId, ackCode: nack }));
    }

    this._dispatchAck(conn, buildRawAck(payload, code));
  }

  /**
   * Run `onMessage` for its side effects only (custom-ACK and manual modes), guarding
   * against a synchronous throw or a rejected promise. In these modes the handler does
   * **not** gate the ACK, so a failure is re-emitted as a PHI-safe `'error'` on the
   * connection (D-04: a handler error never crashes the server) rather than escaping as
   * an unhandled rejection. The error text is never placed on the wire.
   */
  private _observeMessage(payload: Buffer, meta: MessageMeta, conn: Connection): void {
    const handler = this._opts.onMessage;
    if (handler === undefined) return;
    void Promise.resolve()
      .then(() => handler(payload, meta, conn))
      .catch((err: unknown) => {
        const connErr = err instanceof Error ? err : new Error(String(err));
        conn.emit("error", Object.freeze({ connectionId: conn.connectionId, error: connErr }));
      });
  }

  /**
   * The custom-builder path for `autoAck: fn`. Awaits the builder and dispatches its
   * Buffer as the ACK; the caller owns MSA-1. A builder error is re-emitted as `'error'`
   * on the connection — the server never crashes (D-04).
   */
  private async _sendCustomAck(
    fn: (payload: Buffer, meta: MessageMeta, conn: Connection) => Buffer | Promise<Buffer>,
    payload: Buffer,
    meta: MessageMeta,
    conn: Connection,
  ): Promise<void> {
    try {
      const ackPayload = await Promise.resolve(fn(payload, meta, conn));
      this._dispatchAck(conn, ackPayload);
    } catch (err: unknown) {
      const connErr = err instanceof Error ? err : new Error(String(err));
      conn.emit("error", Object.freeze({ connectionId: conn.connectionId, error: connErr }));
    }
  }

  /**
   * Frame an ACK payload and write it to the connection. `Connection.send()` returns
   * `false` under backpressure (socket write buffer full); that drops the ACK and emits
   * a `MllpConnectionError({ phase: 'send' })` on the connection (D-04) — the peer will
   * time out waiting and may retry. The server never crashes.
   */
  private _dispatchAck(conn: Connection, ackPayload: Buffer): void {
    // Connection.send() writes raw bytes — encodeFrame adds VT + payload + FS + CR.
    const sent = conn.send(encodeFrame(ackPayload));
    if (!sent) {
      conn.emit(
        "error",
        Object.freeze({
          connectionId: conn.connectionId,
          error: new MllpConnectionError("ACK dropped: socket backpressure", {
            cause: new Error("backpressure"),
            phase: "send",
          }),
        }),
      );
    }
  }
}

/**
 * Factory function — creates a new `MllpServer` with the supplied options.
 *
 * Prefer `createServer()` over `new MllpServer()` for forward-compatible construction.
 *
 * @example
 * ```typescript
 * import { createServer } from '@cosyte/mllp';
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
 * import { createStarterServer } from '@cosyte/mllp';
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
    autoAck: opts.autoAck ?? "AA",
    drainTimeoutMs: opts.drainTimeoutMs ?? 30_000,
  });

  if (opts.handleSignals === true) {
    // D-09: register process.once('SIGTERM'/'SIGINT') so signal fires close() + exit(0).
    // Use once() (not on()) so handlers self-remove after first fire, preventing accumulation
    // across multiple server instances.
    const sigHandler = (): void => {
      void server
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.once("SIGTERM", sigHandler);
    process.once("SIGINT", sigHandler);

    // Clean up handlers on server close so tests do not accumulate listeners.
    // process.once handlers self-remove on first fire; this removes them early when
    // close() is called before any signal fires (the common test path).
    server.once("close", () => {
      process.removeListener("SIGTERM", sigHandler);
      process.removeListener("SIGINT", sigHandler);
    });
  }

  await server.listen(opts.port, opts.host ?? "0.0.0.0");
  return server;
}
