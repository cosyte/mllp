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
 * out-of-order ACK handling. Subsequent plans add auto-reconnect (Plan 04),
 * backpressure (Plan 05), and `createStarterClient` + `getStats()` (PLAN-06).
 *
 * @example
 * ```typescript
 * import { createClient } from '@cosyte/mllp';
 *
 * const client = createClient({ host: 'localhost', port: 2575 });
 * await client.connect();
 * // PLAN-02 will add: const ack = await client.send(payloadBuffer);
 * await client.close();
 * ```
 *
 * @packageDocumentation
 */

import { createConnection } from "node:net";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { TLSSocket } from "node:tls";
import { EventEmitter } from "node:events";
import { Connection } from "../connection/index.js";
import type { ConnectionState, StateChangeEvent } from "../connection/index.js";
import { MllpConnectionError } from "../connection/index.js";
import { NetTransport, TlsTransport } from "../transport/index.js";
import type { Transport } from "../transport/index.js";
import type { TlsOptions } from "../transport/tls-options.js";
import { MLLP_TLS_VERIFY_DISABLED, type SecurityWarning } from "../transport/security-warnings.js";
import { encodeFrame } from "../framing/index.js";
import { MllpFramingError } from "../framing/index.js";
import type { FrameReaderOptions, MllpWarning, WarningCode } from "../framing/index.js";
import { Correlator, extractMshControlId, extractMsaControlId } from "./correlator.js";
import type { PendingAck } from "./correlator.js";
import {
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "./error.js";

/**
 * Module-level "never aborts" sentinel for `RetryContext.signal` (D-18, W-07).
 *
 * When `connect()` is called WITHOUT a signal, `RetryContext.signal` must
 * still be a real `AbortSignal` (the type is non-optional). This sentinel
 * is constructed once and reused across all signal-less reconnect cycles
 * — no new AbortController is allocated per cycle.
 *
 * The originating `AbortController` is held in module-private scope and
 * never exposed; hostile callers cannot abort the sentinel (T-05-04-09).
 */
const NEVER_ABORTING_SIGNAL: AbortSignal = new AbortController().signal;

/**
 * Context passed to a custom `retryStrategy` hook on each reconnect attempt
 * (CLIENT-12, D-15).
 *
 * Frozen via `Object.freeze` before invocation — handlers cannot mutate
 * (T-05-04-04 mitigation).
 *
 * @example
 * ```typescript
 * const retryStrategy: RetryStrategy = (ctx) => {
 *   if (ctx.attempt >= 5) return null;
 *   if (ctx.classifiedAs === 'permanent') return null;
 *   return Math.min(30_000, 1000 * (ctx.attempt + 1));
 * };
 * ```
 */
export interface RetryContext {
  /** 0-indexed attempt counter for the current reconnect cycle. */
  readonly attempt: number;
  /** The error that triggered the disconnect. */
  readonly lastError: Error;
  /** Delay used for the previous attempt (ms). 0 on the first attempt. */
  readonly lastDelayMs: number;
  /** Total wall-clock ms elapsed since the disconnect that started this cycle. */
  readonly totalElapsedMs: number;
  /** Ms since the last successful ACK. `Infinity` if no success seen. */
  readonly sinceLastSuccessMs: number;
  /** CLIENT-18 classification (Composition A — D-16). */
  readonly classifiedAs: "transient" | "permanent";
  /**
   * The same `AbortSignal` passed into `connect()`. If no signal was
   * supplied, the module-level `NEVER_ABORTING_SIGNAL` sentinel is provided
   * so handlers always have a real `AbortSignal` to inspect. (D-18, W-07)
   */
  readonly signal: AbortSignal;
}

/**
 * Custom reconnect-backoff hook (CLIENT-12). Return `null` to halt
 * reconnection (D-17) — the FSM transitions to `CLOSED`.
 */
export type RetryStrategy = (ctx: RetryContext) => number | null;

/**
 * Combined count + byte-based queue cap. Stricter-of-two wins (D-23).
 *
 * - `number` — count cap only (default 64).
 * - `{ bytes }` — byte cap only.
 * - `{ count, bytes }` — both caps; whichever trips first wins.
 *
 * @example
 * ```typescript
 * const opts: ClientOptions = {
 *   host: 'localhost', port: 2575,
 *   highWaterMark: { count: 100, bytes: 1_000_000 },
 * };
 * ```
 */
export type HighWaterMark = number | { readonly count?: number; readonly bytes?: number };

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
  readonly framing?: Omit<FrameReaderOptions, "onFrame" | "onWarning">;
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
  /**
   * Auto-reconnect on transient disconnect (CLIENT-05). Default `false`.
   *
   * When `true`, dropped connections caused by transient errors (per
   * {@link isTransientConnectionError}) trigger the FSM cycle
   * `CONNECTED → DISCONNECTED → RECONNECTING → CONNECTING → CONNECTED`
   * with exponential backoff per D-19 unless overridden by
   * {@link ClientOptions.retryStrategy}. Permanent errors halt and
   * transition directly to `CLOSED` (Composition A — D-16).
   */
  readonly autoReconnect?: boolean;
  /**
   * Custom reconnect-backoff hook (CLIENT-12, D-15). Return `null` to halt
   * reconnection (D-17). Receives a frozen {@link RetryContext}. Defaults
   * to the exponential strategy described in D-19.
   */
  readonly retryStrategy?: RetryStrategy;
  /** First delay (ms) on auto-reconnect; default 100. (CLIENT-05, D-19) */
  readonly initialDelayMs?: number;
  /** Maximum backoff cap (ms); default 30_000. (CLIENT-05, D-19) */
  readonly maxDelayMs?: number;
  /** Backoff multiplier; default 2. (CLIENT-05, D-19) */
  readonly multiplier?: number;
  /** Jitter fraction, e.g. 0.2 = ±20%; default 0.2. (CLIENT-05, D-19) */
  readonly jitter?: number;
  /**
   * Application-level high-water mark on the in-flight + queued send set
   * (CLIENT-07, D-23). `number` configures a count cap (default 64);
   * `{ bytes }` configures a byte cap; `{ count, bytes }` configures
   * both, with the stricter-of-two trigger winning.
   *
   * When the cap is exceeded, behavior is governed by
   * {@link ClientOptions.onBackpressure}.
   *
   * @default 64
   */
  readonly highWaterMark?: HighWaterMark;
  /**
   * Behavior when the high-water mark is exceeded (CLIENT-07).
   *
   * - `'reject'` (default) — `send()` rejects with `MllpBackpressureError`.
   * - `'wait'` — `send()` awaits the `'drain'` event OR the per-message
   *   `ackTimeoutMs` OR `signal` abort, whichever fires first (CLIENT-11).
   *
   * @default 'reject'
   */
  readonly onBackpressure?: "reject" | "wait";
  /**
   * Strict serialization send → await-ACK → send (CLIENT-19, D-06).
   *
   * - `true` (default) — concurrent in-flight sends up to
   *   {@link ClientOptions.highWaterMark}.
   * - `false` — collapses the in-flight set to ≤1 (the unified Correlator's
   *   `maxInFlight=1`); the next `send()` waits for the prior ACK before
   *   reaching the wire.
   *
   * @default true
   */
  readonly pipeline?: boolean;
  /**
   * TCP keepalive interval (ms). Sets `socket.setKeepAlive(true, ms)` on
   * the underlying `net.Socket` BEFORE wrapping in `NetTransport`. OS-level
   * half-open detection (network partitions, NAT-table eviction). Independent
   * of {@link ClientOptions.deadPeerTimeoutMs} (CLIENT-08, D-11/A3).
   *
   * @default undefined (off)
   */
  readonly keepaliveIntervalMs?: number;
  /**
   * Application-idle timeout (ms) keyed on last inbound bytes / ACK / warning
   * (CLIENT-08, D-11). On trip, calls `connection.destroy(new Error('dead
   * peer timeout'))` which surfaces as `MllpConnectionError({ phase: 'receive' })`.
   * Trip honors {@link ClientOptions.autoReconnect} (D-13). Independent of
   * {@link ClientOptions.keepaliveIntervalMs} (D-11/A3).
   *
   * @default undefined (off)
   */
  readonly deadPeerTimeoutMs?: number;
  /**
   * Enable TLS (MLLPS) for this connection (Phase 8). `true` enables TLS with
   * all defaults — including certificate verification **on**. Pass a
   * {@link TlsOptions} object to customize (`ca`/`cert`/`key`, minimum
   * version, ciphers, `allowUnverified`, …).
   *
   * Spec anchor: IHE ATNA ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).
   *
   * @default undefined (plaintext TCP)
   */
  readonly tls?: TlsOptions | true;
}

/**
 * Observability snapshot returned by {@link MllpClient.getStats} (OBS-01, D-26).
 *
 * All fields are JSON-serializable (OBS-04) — no Buffers, no class instances,
 * no Maps, no circular references. `lastConnectedAt` and `lastAckAt` are
 * **epoch milliseconds** (numbers), NOT `Date` instances — log-pipeline
 * friendly per D-26.
 *
 * `warningsByCode` keys are constrained to the public {@link WarningCode}
 * union — adding/removing a code is a breaking change (CLAUDE.md
 * stable-codes guardrail enforced at the type boundary, B-05).
 *
 * @example
 * ```typescript
 * const stats = client.getStats();
 * logger.info(JSON.stringify(stats));
 * // {"state":"CONNECTED","connectionId":"…","queueDepth":0, … }
 * ```
 */
export interface ClientStats {
  /** Current FSM state — mirrors `client.state`. */
  readonly state: ConnectionState;
  /** Live Connection's id, or `null` before the first connect (or post-CLOSED). */
  readonly connectionId: string | null;
  /** Total live correlator entries (in-flight + pre-flush + serialization-queued). */
  readonly queueDepth: number;
  /** Sum of `frame.length` across live correlator entries. */
  readonly queueBytes: number;
  /** Entries with `sentAt !== null` — actually written to the wire / awaiting ACK. */
  readonly inFlight: number;
  /**
   * Aggregated warning counts. Keys are constrained to the public
   * {@link WarningCode} union (B-05). Connection-level warnings + Correlator
   * `MLLP_ACK_*` warnings are merged.
   */
  readonly warningsByCode: Partial<Record<WarningCode, number>>;
  /** Bytes received from the peer (current Connection). */
  readonly totalBytesIn: number;
  /** Bytes written to the peer (current Connection). */
  readonly totalBytesOut: number;
  /** Total successful `connection.send()` calls since construction. */
  readonly sentTotal: number;
  /** Total ACKs matched + resolved since construction. */
  readonly ackedTotal: number;
  /** Total ACK timeouts since construction. */
  readonly timedOutTotal: number;
  /** Total reconnect attempts since construction (W-02). */
  readonly reconnectAttempts: number;
  /** Epoch ms of the last `CONNECTED` transition. `null` until first connect. */
  readonly lastConnectedAt: number | null;
  /** Epoch ms of the most recent successful ACK. `null` until first ACK. */
  readonly lastAckAt: number | null;
  /** Whether this client is configured for TLS (Phase 8). Mirrors `ClientOptions.tls` being set. */
  readonly tls: boolean;
}

/**
 * MLLP client — composes a single Phase 3 {@link Connection} over a {@link NetTransport}
 * (production) or any other `Transport` (testing via {@link InMemoryTransport}).
 *
 * Public events — every payload `Object.freeze`'d before emission (D-25):
 * - `'stateChange'` — `{ from, to, reason? }` from the underlying Connection FSM
 * - `'connect'` — `{ connectionId }` once the FSM enters `CONNECTED`
 * - `'disconnect'` — `{ connectionId }` once the FSM enters `DISCONNECTED`
 * - `'reconnecting'` — `{ connectionId, attempt?, delayMs? }` (Plan 04 populates)
 * - `'close'` — `{ connectionId }` once the FSM enters terminal `CLOSED`
 * - `'message'` — `{ payload, connectionId, byteOffset, warnings }` for every inbound frame
 * - `'warning'` — `MllpWarning` enriched with `connectionId` from the Connection layer
 * - `'securityWarning'` — `SecurityWarning` (Phase 8). Emitted on every successful
 *   `secureConnect` (initial + every reconnect) when `tls.allowUnverified` is `true`
 *   — code `MLLP_TLS_VERIFY_DISABLED`. Also mirrored to `process.emitWarning`.
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
  private _state: ConnectionState = "DISCONNECTED";

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

  // ── Reconnect state (Plan 04, CLIENT-05/06/12/17/18) ─────────────────────
  private readonly _autoReconnect: boolean;
  private readonly _initialDelayMs: number;
  private readonly _maxDelayMs: number;
  private readonly _multiplier: number;
  private readonly _jitter: number;
  private readonly _retryStrategy: RetryStrategy | undefined;

  /** 0-indexed attempt counter for the current reconnect cycle. */
  private _attempt = 0;
  /**
   * W-02 — total reconnect attempts since construction. Read by PLAN-06 for
   * `getStats().reconnectAttempts`. Incremented at the entry of every
   * `_handleDisconnect` invocation that proceeds to schedule a backoff.
   */
  private _reconnectAttempts = 0;
  /** Epoch ms of the last successful ACK. Drives W-01 backoff-reset. */
  private _lastSuccessAt: number | null = null;
  /** Epoch ms when the current reconnect cycle began. `null` outside a cycle. */
  private _reconnectCycleStartedAt: number | null = null;
  /** Active backoff `setTimeout` handle. `null` when no backoff is armed. */
  private _backoffTimer: ReturnType<typeof setTimeout> | null = null;
  /** Last delay (ms) used by the strategy. Surfaced via RetryContext.lastDelayMs. */
  private _lastDelayMs = 0;

  // ── Backpressure + pipeline state (Plan 05, CLIENT-07/CLIENT-19, D-23) ───
  /** Count cap; `Number.POSITIVE_INFINITY` when only bytes configured. */
  private readonly _hwmCount: number;
  /** Byte cap; `Number.POSITIVE_INFINITY` when only count configured. */
  private readonly _hwmBytes: number;
  /** Backpressure policy; default `'reject'`. */
  private readonly _onBackpressure: "reject" | "wait";
  /** Pipeline flag; default `true` (parallel up to highWaterMark). */
  private readonly _pipeline: boolean;
  /** Dead-peer idle timer (Plan 05 — D-11). `null` when not armed. */
  private _deadPeerTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the self-'ack' listener that resets the dead-peer timer
   * has been attached. Guards against duplicate listeners on reconnect. */
  private _ackResetWired = false;
  /** Most recently bound `connect()` signal. Reread on every RetryContext build (W-07). */
  private _connectSignal: AbortSignal | undefined;
  /** Set when close()/destroy()/abort fires; reconnect handler short-circuits. */
  private _userClosed = false;
  /** Captured Connection error feeding `RetryContext.lastError`. */
  private _lastError: Error | null = null;
  /** Listener-removal handle for the abort listener bound in connect(). */
  private _abortListener: { signal: AbortSignal; handler: () => void } | null = null;
  /**
   * Test-only seam — when set, `_beginReconnectAttempt` builds the new
   * Connection through this factory instead of opening a real net.Socket.
   *
   * @internal
   */
  private _reconnectFactory: (() => { conn: Connection; arm: () => void }) | null = null;

  // ── PLAN-06 — observability counters for getStats (OBS-01, D-26) ─────────
  /** Total successful `conn.send()` flushes since construction. */
  private _sentTotal = 0;
  /** Total ACKs resolved since construction. */
  private _ackedTotal = 0;
  /** Total ACK timeouts since construction. */
  private _timedOutTotal = 0;
  /** Epoch ms of the most recent CONNECTED transition (null until first). */
  private _lastConnectedAt: number | null = null;
  /** Epoch ms of the most recent successful ACK (null until first). */
  private _lastAckAt: number | null = null;
  /**
   * Aggregated Correlator-emitted warning counts (MLLP_ACK_*). Connection-level
   * warnings are read directly from `_connection.getStats().warningsByCode`
   * at observation time and merged into the snapshot (D-26).
   */
  private _aggregatedWarningsByCode: Partial<Record<WarningCode, number>> = {};

  /**
   * Construct an MLLP client. Created idle; call `connect()` (or use
   * {@link createClient}/{@link createStarterClient}) to open the connection.
   *
   * @param opts - Client options (host/port, ACK timeout, reconnect/backpressure policy, …).
   */
  constructor(opts: ClientOptions) {
    super();
    this._opts = opts;
    this._ackTimeoutMs = opts.ackTimeoutMs ?? 30_000;
    this._correlateByControlId = opts.correlateByControlId === true;
    this._autoReconnect = opts.autoReconnect === true;
    this._initialDelayMs = opts.initialDelayMs ?? 100;
    this._maxDelayMs = opts.maxDelayMs ?? 30_000;
    this._multiplier = opts.multiplier ?? 2;
    this._jitter = opts.jitter ?? 0.2;
    this._retryStrategy = opts.retryStrategy;

    // Plan 05 — backpressure + pipeline (D-23, D-06).
    const hwm: HighWaterMark = opts.highWaterMark ?? 64;
    if (typeof hwm === "number") {
      this._hwmCount = hwm;
      this._hwmBytes = Number.POSITIVE_INFINITY;
    } else {
      this._hwmCount = hwm.count ?? Number.POSITIVE_INFINITY;
      this._hwmBytes = hwm.bytes ?? Number.POSITIVE_INFINITY;
    }
    this._onBackpressure = opts.onBackpressure ?? "reject";
    this._pipeline = opts.pipeline !== false;
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
   * Open a TCP (or TLS — Phase 8) connection to the configured `host:port`
   * and attach a Phase 3 {@link Connection} to it. Resolves once the FSM
   * enters `CONNECTED` — for TLS, on `'secureConnect'` (handshake complete,
   * including certificate verification when it is on).
   *
   * Rejects with:
   * - `DOMException('Aborted', 'AbortError')` if `signal` is provided and aborts
   *   before the connect resolves.
   * - `MllpConnectionError({ phase: 'connect' })` if the underlying socket emits
   *   `error` before connecting, OR if the client is already connecting/connected.
   *   TLS failures carry a `connectionCause`: `'tls-verify'` for certificate
   *   verification failures, `'tls-handshake'` for TLS-protocol-shaped failures
   *   ({@link isTlsProtocolError}); pure TCP failures carry none.
   *
   * **Dual failure signal on initial connect:** the Connection's transport
   * error handler is attached before this promise's own error listener, so a
   * pre-connect socket error produces BOTH the promise rejection AND a
   * client `'error'` event (when an `'error'` listener is attached). Handle
   * whichever fits your flow; they describe the same underlying failure.
   *
   * **TLS 1.3 + mutual TLS caveat (RFC 8446 §4.4.2):** `connect()` resolving
   * does NOT guarantee that a `clientAuth: 'MUST'` server accepted your
   * client certificate. Under TLS 1.3 the client's handshake — and its
   * `'secureConnect'` — can complete before the server finishes validating
   * the certificate; a rejection then surfaces moments later as a typed
   * post-connect error (`'error'` event with an `ERR_SSL_*`/alert cause,
   * classified **permanent** — no auto-reconnect loop). ACK correlation via
   * {@link MllpClient.send} remains the delivery guarantee: no send resolves
   * without its ACK, so a rejected session can never silently "deliver".
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
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    // Reject if we already hold a live Connection. Once a Connection has reached
    // CLOSED or DISCONNECTED we drop the reference and allow a fresh connect().
    if (
      this._connection !== null &&
      this._connection.state !== "CLOSED" &&
      this._connection.state !== "DISCONNECTED"
    ) {
      return Promise.reject(
        new MllpConnectionError("already connected or connecting", {
          cause: new Error("already connected"),
          phase: "connect",
        }),
      );
    }

    // Capture the connect signal for the reconnect cycle (W-07). Each call
    // overwrites the prior binding; `RetryContext.signal` reads `_connectSignal`
    // at the moment a RetryContext is built.
    if (signal !== undefined) {
      this._captureConnectSignal(signal);
    }

    return new Promise<void>((resolve, reject) => {
      let aborted = false;

      const { socket, transport } = this._createSocketAndTransport();
      // Plan 05 — TCP keepalive set on the raw socket BEFORE NetTransport
      // wrap (CLIENT-08, D-11/A3 — mirrors Phase 4 server). OS-level
      // half-open detection. No JS-side timer (W-03).
      if (this._opts.keepaliveIntervalMs !== undefined) {
        socket.setKeepAlive(true, this._opts.keepaliveIntervalMs);
      }
      this._socket = socket;

      const connOpts =
        this._opts.framing !== undefined
          ? { transport, framing: this._opts.framing }
          : { transport };
      if (this._opts.drainTimeoutMs !== undefined) {
        (connOpts as { drainTimeoutMs?: number }).drainTimeoutMs = this._opts.drainTimeoutMs;
      }
      const conn = new Connection(connOpts);
      this._attachConnection(conn);

      const connectEventName = this._opts.tls !== undefined ? "secureConnect" : "connect";

      const cleanup = (): void => {
        if (signal !== undefined) {
          signal.removeEventListener("abort", abortHandler);
        }
        socket.removeListener(connectEventName, onSocketConnect);
        socket.removeListener("error", onSocketError);
      };

      const abortHandler = (): void => {
        aborted = true;
        cleanup();
        // Tear down the in-flight attempt — also clears the correlator so
        // any sweep timer armed by _attachConnection is released.
        this._teardownCorrelator(
          new MllpConnectionError("connect aborted", {
            cause: new Error("aborted"),
            phase: "connect",
          }),
        );
        conn.destroy(new Error("aborted"));
        reject(new DOMException("Aborted", "AbortError"));
      };

      const onSocketConnect = (): void => {
        if (aborted) return;
        // TLS and plaintext behave identically here: 'secureConnect' (TLS)
        // or 'connect' (plaintext) immediately arms the Connection and
        // resolves. Deferring notifyConnect for TLS was tried and removed —
        // any delay leaves the Connection in CONNECTING while post-handshake
        // frames arrive, and Connection discards frames outside
        // CONNECTED/DRAINING (a silent inbound-frame drop). See the
        // TLS 1.3 note in the method JSDoc for what this means for mTLS.
        cleanup();
        conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);
        this._emitInsecureWarningIfNeeded();
        resolve();
      };

      const onSocketError = (err: Error): void => {
        if (aborted) return;
        cleanup();
        // Surface the OS error wrapped in MllpConnectionError (Connection's
        // _onTransportError handles the same wrap once attached, but the
        // socket's 'error' may arrive before NetTransport hands it off).
        reject(this._wrapConnectError(err, "connect"));
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
      socket.once(connectEventName, onSocketConnect);
      socket.once("error", onSocketError);
    });
  }

  /**
   * Build the raw socket + `Transport` pair for a connect / reconnect attempt.
   *
   * Plaintext (`ClientOptions.tls` unset): a `net.Socket` wrapped in
   * `NetTransport`. TLS (Phase 8): a `tls.TLSSocket` wrapped in
   * `TlsTransport` — verification defaults **on**
   * (`rejectUnauthorized: !allowUnverified`), floor `minVersion: 'TLSv1.2'`
   * (the IHE ATNA ITI-19 BCP195 floor), `servername` defaulting to
   * `ClientOptions.host`.
   */
  private _createSocketAndTransport(): {
    socket: Socket | TLSSocket;
    transport: Transport;
  } {
    const tlsOpt = this._opts.tls;
    if (tlsOpt === undefined) {
      const socket = createConnection({ host: this._opts.host, port: this._opts.port });
      return { socket, transport: new NetTransport(socket) };
    }
    const tlsOpts: TlsOptions = tlsOpt === true ? {} : tlsOpt;
    const socket = tlsConnect({
      host: this._opts.host,
      port: this._opts.port,
      servername: tlsOpts.servername ?? this._opts.host,
      ...(tlsOpts.ca !== undefined ? { ca: tlsOpts.ca } : {}),
      ...(tlsOpts.cert !== undefined ? { cert: tlsOpts.cert } : {}),
      ...(tlsOpts.key !== undefined ? { key: tlsOpts.key } : {}),
      ...(tlsOpts.passphrase !== undefined ? { passphrase: tlsOpts.passphrase } : {}),
      minVersion: tlsOpts.minVersion ?? "TLSv1.2",
      ...(tlsOpts.maxVersion !== undefined ? { maxVersion: tlsOpts.maxVersion } : {}),
      ...(tlsOpts.ciphers !== undefined ? { ciphers: tlsOpts.ciphers } : {}),
      rejectUnauthorized: tlsOpts.allowUnverified !== true,
    });
    return { socket, transport: new TlsTransport(socket) };
  }

  /**
   * Wrap a connect-phase socket error as `MllpConnectionError`, classifying
   * TLS failures (Phase 8) into the additive `connectionCause`:
   *
   * - `'tls-verify'` — certificate-verification failures
   *   ({@link isTlsVerificationErrorCode}).
   * - `'tls-handshake'` — TLS-**protocol**-shaped failures only
   *   ({@link isTlsProtocolError}): `ERR_SSL_*`, `EPROTO`, OpenSSL
   *   alert-bearing errors.
   * - **No `connectionCause`** — pure TCP-level failures (`ECONNREFUSED`,
   *   `ETIMEDOUT`, …) even on a TLS-configured connection; these carry the
   *   same shape as plaintext connect failures.
   */
  private _wrapConnectError(err: Error, phase: "connect" | "reconnect"): MllpConnectionError {
    if (this._opts.tls === undefined) {
      return new MllpConnectionError(err.message, { cause: err, phase });
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && isTlsVerificationErrorCode(code)) {
      return new MllpConnectionError(err.message, {
        cause: err,
        phase,
        connectionCause: "tls-verify",
      });
    }
    if (isTlsProtocolError(err)) {
      return new MllpConnectionError(err.message, {
        cause: err,
        phase,
        connectionCause: "tls-handshake",
      });
    }
    // Pure TCP-level failure on a TLS-configured connection — same shape as
    // a plaintext connect failure; no TLS-specific connectionCause.
    return new MllpConnectionError(err.message, { cause: err, phase });
  }

  /**
   * Emit the per-connection insecure-TLS warning (Phase 8) when
   * `tls.allowUnverified === true` — fires on EVERY successful
   * `secureConnect`, initial connect and every reconnect. Emits both a frozen
   * `'securityWarning'` event and `process.emitWarning`. No-op for plaintext
   * connections or when verification is on.
   */
  private _emitInsecureWarningIfNeeded(): void {
    const tlsOpt = this._opts.tls;
    if (tlsOpt === undefined || tlsOpt === true) return;
    if (tlsOpt.allowUnverified !== true) return;
    const message =
      "MLLP TLS certificate verification is DISABLED (allowUnverified: true) — " +
      "this connection does not authenticate the peer.";
    const warning: SecurityWarning = Object.freeze({
      code: MLLP_TLS_VERIFY_DISABLED,
      message,
      host: this._opts.host,
      port: this._opts.port,
      timestamp: new Date(),
    });
    this.emit("securityWarning", warning);
    process.emitWarning(message, { code: MLLP_TLS_VERIFY_DISABLED });
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
    // Plan 04 — preserve correlator state across reconnect cycles. In
    // controlId mode, in-flight sends are re-transmitted on the new
    // connection (D-08 / CLIENT-17), so the correlator must survive the
    // transition. The closures below dereference `this._connection`
    // lazily so they always see the CURRENT connection (not the dead
    // one captured at attach-time).
    if (this._correlator === null) {
      this._correlator = new Correlator({
        mode: this._correlateByControlId ? "controlId" : "fifo",
        ackTimeoutMs: this._ackTimeoutMs,
        // Plan 05 — pipeline:false collapses the in-flight set to ≤1 (D-06).
        maxInFlight: this._pipeline ? Number.POSITIVE_INFINITY : 1,
        onWarning: (code, ctx) => {
          // PLAN-06 (OBS-01, D-26) — aggregate Correlator-emitted warning counts.
          this._aggregatedWarningsByCode[code] = (this._aggregatedWarningsByCode[code] ?? 0) + 1;
          this.emit(
            "warning",
            Object.freeze({
              code,
              byteOffset: ctx.byteOffset,
              message: `${code}: controlId=${ctx.controlId} elapsed=${ctx.elapsedSinceSendMs}ms`,
              connectionId: this._connection?.connectionId ?? conn.connectionId,
              timestamp: new Date(),
            }),
          );
        },
        onUnmatchedAck: (controlId) => {
          // CLIENT-15: unmatched ACK in controlId mode. Emit a frozen
          // MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID') to the 'error'
          // event. listenerCount-guarded so absent listeners don't crash the
          // process (T-05-03-02 mitigation).
          if (this.listenerCount("error") === 0) return;
          const err = new MllpFramingError(
            "MLLP_ACK_UNMATCHED_CONTROL_ID",
            0,
            Buffer.alloc(0),
            `Unmatched ACK control ID${controlId === "" ? "" : `: ${controlId}`}`,
          );
          this.emit(
            "error",
            Object.freeze({
              connectionId: this._connection?.connectionId ?? conn.connectionId,
              error: err,
              controlId,
            }),
          );
        },
        onTimeout: (entry, elapsedMs) => {
          // PLAN-06 (OBS-01, D-26) — observability counter.
          this._timedOutTotal += 1;
          entry.reject(
            new MllpTimeoutError(`ACK timeout after ${elapsedMs}ms`, {
              messageControlId: entry.controlId ?? undefined,
              elapsedMs,
              sentAt: entry.sentAt ?? 0,
            }),
          );
          // Plan 05 — a timeout removes the entry from the live store too,
          // so emit 'drain' if the queue now sits below both caps. This is
          // critical for pipeline:false (D-06): an expired send must free
          // the in-flight slot so the next send can flush.
          this._maybeEmitDrain();
        },
      });
    }

    // Periodic sweep: smaller of (ackTimeoutMs / 4) and 1000 ms; floor 50 ms.
    // .unref() so this timer never keeps the process alive.
    if (this._ackSweepTimer === null) {
      const sweepIntervalMs = Math.max(50, Math.min(1000, Math.floor(this._ackTimeoutMs / 4)));
      this._ackSweepTimer = setInterval(() => {
        this._correlator?.expireDue();
      }, sweepIntervalMs);
      this._ackSweepTimer.unref();
    }

    // Single 'stateChange' listener delegates to _onStateChange (B-04 anchor).
    conn.on("stateChange", (e: StateChangeEvent) => {
      this._onStateChange(e);
    });
    // Single 'message' listener: re-emit + delegate to _onAckPayload (B-04 anchor).
    conn.on(
      "message",
      (e: {
        payload: Buffer;
        connectionId: string;
        byteOffset: number;
        warnings: readonly MllpWarning[];
      }) => {
        this.emit("message", Object.freeze({ ...e }));
        // Plan 05 — last-bytes-received signal resets dead-peer timer
        // (D-11 "last bytes/ACK received").
        this._armDeadPeerTimer();
        this._onAckPayload(e.payload, e.byteOffset);
      },
    );
    // PLAN-01 lifecycle re-emitters preserved unchanged.
    conn.on("connect", (e: unknown) => {
      this.emit("connect", Object.freeze({ ...(e as object) }));
    });
    conn.on("disconnect", (e: unknown) => {
      this.emit("disconnect", Object.freeze({ ...(e as object) }));
    });
    conn.on("reconnecting", (e: unknown) => {
      this.emit("reconnecting", Object.freeze({ ...(e as object) }));
    });
    conn.on("close", (e: unknown) => {
      this.emit("close", Object.freeze({ ...(e as object) }));
    });
    conn.on("warning", (w: MllpWarning) => {
      this.emit("warning", w);
      // Plan 05 — Connection 'warning' is also a "bytes received" signal.
      this._armDeadPeerTimer();
    });
    conn.on("error", (e: unknown) => {
      // Plan 04: capture the underlying Error for `RetryContext.lastError`.
      // The Connection emits frozen `{ connectionId, error: MllpConnectionError }`
      // payloads. We unwrap to the original transport error so the CLIENT-18
      // classifier (which inspects `err.code`) receives the OS-level code.
      const wrapper = e instanceof Error ? e : (e as { error?: unknown })?.error;
      if (wrapper instanceof Error) {
        // If the wrapper has a `.cause` Error (MllpConnectionError pattern),
        // prefer the inner cause for classification.
        const inner = (wrapper as { cause?: unknown }).cause;
        this._lastError = inner instanceof Error ? inner : wrapper;
      }
      // Server precedent: only re-emit if a listener is attached, to avoid
      // ERR_UNHANDLED_ERROR crashing the process (T-05-01-03 mitigation).
      if (this.listenerCount("error") > 0) {
        this.emit("error", e);
      }
    });
    this._connection = conn;

    // Plan 05 — dead-peer timer self-listener on 'ack'. Connection emits
    // 'message' (already wired above); the MllpClient itself emits 'ack'
    // after matchAck succeeds. Both are "last bytes/ACK received" signals
    // (D-11). The 'ack' reset is effectively a no-op when 'message' just
    // armed it, but keeps the contract literal-true.
    if (!this._ackResetWired) {
      this._ackResetWired = true;
      this.on("ack", () => {
        this._armDeadPeerTimer();
      });
    }

    // Arm the dead-peer timer if the connection is ALREADY in CONNECTED
    // (test seam path: _attachExistingConnection called after notifyConnect).
    // The state-change branch arms it for the normal path
    // (CONNECTING → CONNECTED transition).
    if (conn.state === "CONNECTED") {
      this._armDeadPeerTimer();
    }
  }

  /**
   * Arm (or re-arm) the dead-peer idle timer (Plan 05 — CLIENT-08, D-11).
   * No-op when `deadPeerTimeoutMs` is unset.
   */
  private _armDeadPeerTimer(): void {
    if (this._opts.deadPeerTimeoutMs === undefined) return;
    if (this._deadPeerTimer !== null) {
      clearTimeout(this._deadPeerTimer);
    }
    this._deadPeerTimer = setTimeout(() => {
      this._connection?.destroy(new Error("dead peer timeout"));
    }, this._opts.deadPeerTimeoutMs);
    this._deadPeerTimer.unref();
  }

  /**
   * Clear the dead-peer idle timer (Plan 05 — D-14 timer cleanup on
   * every transition out of CONNECTED).
   */
  private _clearDeadPeerTimer(): void {
    if (this._deadPeerTimer !== null) {
      clearTimeout(this._deadPeerTimer);
      this._deadPeerTimer = null;
    }
  }

  /**
   * Disconnect handler — Plan 04 reconnect FSM core.
   *
   * Implements:
   * - CLIENT-17 hybrid in-flight handling (D-08): controlId mode preserves
   *   pending sends for resend; FIFO mode rejects in-flight with
   *   `connectionCause: 'in-flight-orphan'` and queued with `'fifo-unsafe'`.
   * - CLIENT-18 classifier-first (Composition A — D-16): permanent errors
   *   transition straight to CLOSED without invoking `retryStrategy`.
   * - W-01 backoff-reset on recent success: first disconnect after a
   *   successful ACK on the prior session resets `_attempt` to 0.
   * - W-02 `_reconnectAttempts` counter increment.
   * - D-15 frozen RetryContext + D-17 null-return halts.
   * - D-19 default exponential strategy.
   *
   * Invoked from the SINGLE `_onStateChange` hook — no parallel listener
   * (B-04). Idempotent across same-cycle re-entry: cycle-start flag
   * coordinates first-disconnect vs subsequent-within-cycle behavior.
   */
  private _handleDisconnect(err: Error): void {
    if (this._userClosed) return;

    // CLIENT-17 hybrid: handle queued + in-flight sends per mode.
    if (this._correlator !== null) {
      if (this._correlateByControlId) {
        // Hold sends for resend after reconnect — DO NOT clear or reject.
        // The correlator's live store survives the FSM transition; the
        // entries are re-transmitted in `_beginReconnectAttempt` once the
        // new Connection enters CONNECTED.
      } else {
        // FIFO: split between in-flight (sentAt set) and queued (sentAt null).
        // In-flight sends → 'in-flight-orphan'; queued sends → 'fifo-unsafe'.
        const orphans: PendingAck[] = [];
        const queued: PendingAck[] = [];
        for (const entry of this._correlator.liveEntries()) {
          if (entry.sentAt !== null) orphans.push(entry);
          else queued.push(entry);
        }
        for (const o of orphans) {
          o.reject(
            new MllpConnectionError("in-flight send orphaned by reconnect", {
              cause: err,
              phase: "reconnect",
              connectionCause: "in-flight-orphan",
            }),
          );
        }
        for (const q of queued) {
          q.reject(
            new MllpConnectionError("queued send rejected by FIFO reconnect", {
              cause: err,
              phase: "reconnect",
              connectionCause: "fifo-unsafe",
            }),
          );
        }
        for (const entry of [...orphans, ...queued]) {
          this._correlator.remove(entry.key);
        }
      }
    }

    // CLIENT-18 classification first (Composition A — D-16). Permanent
    // errors transition directly to CLOSED without invoking retryStrategy.
    // Phase 8: on a TLS-configured connection, TLS-protocol-shaped errors
    // (ERR_SSL_*, EPROTO, OpenSSL alert-bearing — see isTlsProtocolError)
    // are ALSO permanent: a clientAuth 'MUST' server that rejects this
    // client's certificate will reject every retry — never reconnect-loop
    // into it. Pure TCP-level errors (ECONNREFUSED, ETIMEDOUT, plain
    // ECONNRESET) stay transient so a network blip still auto-heals.
    const tlsProtocolShaped = this._opts.tls !== undefined && isTlsProtocolError(err);
    const classifiedAs: "transient" | "permanent" =
      !tlsProtocolShaped && isTransientConnectionError(err) ? "transient" : "permanent";
    if (classifiedAs === "permanent") {
      // Halt: force the dead Connection to CLOSED (terminal); future
      // connect() must be called explicitly.
      this._userClosed = true;
      this._connection?.destroy(err);
      return;
    }

    // W-02: bump the global reconnect-attempts counter once per disconnect
    // entering a cycle. PLAN-06 reads this for getStats().reconnectAttempts.
    this._reconnectAttempts += 1;

    // W-01: backoff reset on recent success.
    // First disconnect AFTER any successful ACK on the prior session
    // (`_reconnectCycleStartedAt === null` AND `_lastSuccessAt !== null`)
    // resets attempt to 0. Subsequent disconnects within the same cycle
    // do NOT re-reset — the cycle-start flag persists.
    if (this._reconnectCycleStartedAt === null && this._lastSuccessAt !== null) {
      this._attempt = 0;
    }
    if (this._reconnectCycleStartedAt === null) {
      this._reconnectCycleStartedAt = Date.now();
    }

    // Build RetryContext (W-07: NEVER_ABORTING_SIGNAL when no caller signal).
    const ctx: RetryContext = Object.freeze({
      attempt: this._attempt,
      lastError: err,
      lastDelayMs: this._lastDelayMs,
      totalElapsedMs: Date.now() - this._reconnectCycleStartedAt,
      sinceLastSuccessMs:
        this._lastSuccessAt !== null ? Date.now() - this._lastSuccessAt : Number.POSITIVE_INFINITY,
      classifiedAs,
      signal: this._connectSignal ?? NEVER_ABORTING_SIGNAL,
    });

    // Invoke strategy (T-05-04-05: defensive try/catch — caller-supplied hook).
    let delay: number | null;
    try {
      const strategy = this._retryStrategy ?? this._defaultRetryStrategy;
      delay = strategy(ctx);
    } catch (hookErr) {
      // Strategy threw — bail to CLOSED, surface error.
      this._lastError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
      if (this.listenerCount("error") > 0) {
        this.emit(
          "error",
          Object.freeze({
            connectionId: this._connection?.connectionId ?? "<none>",
            error: this._lastError,
          }),
        );
      }
      this._userClosed = true;
      this._connection?.destroy(this._lastError);
      return;
    }

    if (delay === null) {
      // D-17 null-return halt → CLOSED.
      this._userClosed = true;
      this._connection?.destroy(err);
      return;
    }

    // Emit 'reconnecting' with populated fields (Phase 3 D-CR-01 promise).
    this.emit(
      "reconnecting",
      Object.freeze({
        connectionId: this._connection?.connectionId ?? "<none>",
        attempt: this._attempt,
        delayMs: delay,
      }),
    );

    // Schedule next CONNECTING attempt. .unref() so the timer never keeps
    // the process alive (test-suite ergonomics).
    this._lastDelayMs = delay;
    this._backoffTimer = setTimeout(() => {
      this._backoffTimer = null;
      this._attempt += 1;
      this._beginReconnectAttempt();
    }, delay);
    this._backoffTimer.unref();
  }

  /**
   * Default retry strategy (D-19): `min(maxDelay, initialDelay * multiplier^attempt)`
   * with ±jitter applied.
   */
  private _defaultRetryStrategy = (ctx: RetryContext): number => {
    const base = Math.min(
      this._maxDelayMs,
      this._initialDelayMs * Math.pow(this._multiplier, ctx.attempt),
    );
    const jitterFactor = 1 + (Math.random() * 2 - 1) * this._jitter;
    return Math.max(0, Math.floor(base * jitterFactor));
  };

  /**
   * Open a fresh Connection for the next reconnect attempt.
   *
   * In production, builds a new `net.Socket` + `NetTransport` + `Connection`.
   * In tests, the `_reconnectFactory` seam returns a pre-built Connection
   * over `InMemoryTransport.pair()`.
   *
   * On successful CONNECTED transition:
   * - controlId mode: re-transmits every live correlator entry via the
   *   already-encoded `PendingAck.frame`, then `markFlushed`'s each one
   *   so ACK timeouts restart from the new flush time.
   * - All modes: clears the cycle-start flag so the next disconnect
   *   can re-enter `_handleDisconnect` cleanly.
   */
  private _beginReconnectAttempt(): void {
    if (this._userClosed) return;
    try {
      let conn: Connection;
      let arm: () => void;
      if (this._reconnectFactory !== null) {
        ({ conn, arm } = this._reconnectFactory());
      } else {
        const { socket, transport } = this._createSocketAndTransport();
        // Plan 05 — TCP keepalive on every reconnect attempt too
        // (CLIENT-08, D-11/A3 — mirror connect() site).
        if (this._opts.keepaliveIntervalMs !== undefined) {
          socket.setKeepAlive(true, this._opts.keepaliveIntervalMs);
        }
        this._socket = socket;
        const connOpts =
          this._opts.framing !== undefined
            ? { transport, framing: this._opts.framing }
            : { transport };
        if (this._opts.drainTimeoutMs !== undefined) {
          (connOpts as { drainTimeoutMs?: number }).drainTimeoutMs = this._opts.drainTimeoutMs;
        }
        conn = new Connection(connOpts);
        arm = (): void => {
          conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);
          this._emitInsecureWarningIfNeeded();
        };
        const connectEventName = this._opts.tls !== undefined ? "secureConnect" : "connect";
        socket.once("error", (sErr: Error) => {
          // Phase 8 — the raw OS/TLS error (with its original `.code`) is
          // what the reconnect classifier inspects in _handleDisconnect;
          // keep it unwrapped here so TLS cert-verification codes (CERT_*,
          // UNABLE_TO_VERIFY_LEAF_SIGNATURE, …) and TLS-protocol-shaped
          // codes (ERR_SSL_*, EPROTO with an SSL alert) are still visible
          // to the classifier and correctly permanent (never reconnect-loop
          // into a misconfigured or MITM'd endpoint).
          if (this._lastError === null || this._lastError.message !== sErr.message) {
            this._lastError = sErr;
          }
        });
        socket.once(connectEventName, () => {
          // TLS and plaintext arm identically and immediately — see the
          // matching note in connect()'s onSocketConnect.
          arm();
          this._afterReconnectArmed();
        });
        // Replace prior Connection. Drop the dead reference; new Connection
        // is wired below.
        this._connection = null;
        this._attachConnection(conn);
        return;
      }
      // Test-seam path
      this._connection = null;
      this._attachConnection(conn);
      arm();
      this._afterReconnectArmed();
    } catch (err) {
      this._lastError = err instanceof Error ? err : new Error(String(err));
      this._handleDisconnect(this._lastError);
    }
  }

  /**
   * Post-CONNECTED steps for a reconnect attempt:
   * - controlId mode: resend every live correlator entry's frame, then
   *   re-stamp `markFlushed` so ACK timers reset from the new flush.
   * - Clear the cycle-start flag so the next disconnect re-enters cleanly.
   */
  private _afterReconnectArmed(): void {
    if (this._correlateByControlId && this._correlator !== null && this._connection !== null) {
      const conn = this._connection;
      const corr = this._correlator;
      const entries = [...corr.liveEntries()];
      for (const entry of entries) conn.send(entry.frame);
      const now = Date.now();
      for (const entry of entries) corr.markFlushed(entry.key, now);
    }
    this._reconnectCycleStartedAt = null;
  }

  /**
   * Test seam — install a factory that produces the next reconnect Connection.
   *
   * @internal
   */
  _setReconnectFactory(factory: () => { conn: Connection; arm: () => void }): void {
    this._reconnectFactory = factory;
  }

  /**
   * Test seam — capture or rebind the connect-signal mid-flight (W-07).
   *
   * @internal
   */
  _captureConnectSignal(signal: AbortSignal): void {
    this._connectSignal = signal;
    if (this._abortListener !== null) {
      this._abortListener.signal.removeEventListener("abort", this._abortListener.handler);
      this._abortListener = null;
    }
    const handler = (): void => {
      this._userClosed = true;
      if (this._backoffTimer !== null) {
        clearTimeout(this._backoffTimer);
        this._backoffTimer = null;
      }
      this._connection?.destroy(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", handler, { once: true });
    this._abortListener = { signal, handler };
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
    const matched = this._correlator.matchAck(ackPayload, ackControlId, byteOffset);
    if (matched !== null) {
      this._onAckMatched(matched, ackPayload);
    }
  }

  /**
   * Single source-of-truth for a successfully matched ACK (live-store hit).
   *
   * PLAN-02: emit frozen 'ack' event, call matched.resolve().
   * Plan 04 extends at HOOK_EXTENSION_POINT: ack-matched to update _lastSuccessAt.
   * PLAN-06 extends at HOOK_EXTENSION_POINT: ack-matched to bump _ackedTotal and
   *   set _lastAckAt.
   *
   * Called from _onAckPayload when matchAck() returns a non-null PendingAck.
   */
  private _onAckMatched(matched: PendingAck, ackPayload: Buffer): void {
    const latencyMs = matched.sentAt !== null ? Date.now() - matched.sentAt : 0;
    this.emit(
      "ack",
      Object.freeze({
        payload: ackPayload,
        controlId: matched.controlId,
        latencyMs,
      }),
    );
    // HOOK_EXTENSION_POINT: ack-matched
    // Plan 04 — backoff-reset signal (W-01): record the most recent successful
    // ACK so the next disconnect resets attempt counter to 0 if it's the
    // first disconnect AFTER a successful exchange on the prior session.
    this._lastSuccessAt = Date.now();
    // PLAN-06 (OBS-01, D-26) — observability counters.
    this._ackedTotal += 1;
    this._lastAckAt = Date.now();
    matched.resolve(ackPayload);
    // Plan 05 — emit 'drain' when queue depth crosses below high-water mark
    // (D-24). Fires once per ACK that brings the queue under both caps.
    this._maybeEmitDrain();
  }

  /**
   * Emit a frozen `'drain'` event when the queue depth and bytes fall below
   * both configured caps (Plan 05 — D-24). Called from `_onAckMatched`
   * (every successful ACK) and from the Correlator's `onTimeout` callback
   * (every expired send) — both code paths free a live-store slot.
   */
  private _maybeEmitDrain(): void {
    const corr = this._correlator;
    if (corr === null) return;
    const belowCount = corr.size < this._hwmCount;
    const belowBytes = corr.queueBytes < this._hwmBytes;
    if (belowCount && belowBytes) {
      this.emit(
        "drain",
        Object.freeze({
          queueDepth: corr.size,
          queueBytes: corr.queueBytes,
        }),
      );
    }
  }

  /**
   * Single source-of-truth for Connection FSM transitions.
   *
   * PLAN-02: re-emit frozen 'stateChange' (was inline in PLAN-01; centralized
   * here so Plan 04 / Plan 05 can extend at named anchors).
   * Plan 04 extends at HOOK_EXTENSION_POINT: state-change to detect
   *   CONNECTED → DISCONNECTED|RECONNECTING and trigger _handleDisconnect.
   * Plan 05 extends at HOOK_EXTENSION_POINT: state-change to clear/arm
   *   dead-peer timer on transitions out of / into CONNECTED.
   *
   * Called from the SINGLE 'stateChange' listener registered in _attachConnection.
   */
  private _onStateChange(e: StateChangeEvent): void {
    this.emit("stateChange", Object.freeze({ ...e }));
    // HOOK_EXTENSION_POINT: state-change
    // Plan 05 — dead-peer timer arm/clear (D-14). Cleared on every
    // transition OUT of CONNECTED; re-armed on entry TO CONNECTED.
    if (e.to === "CONNECTED") {
      this._armDeadPeerTimer();
      // PLAN-06 (OBS-01, D-26) — record CONNECTED epoch for getStats.
      this._lastConnectedAt = Date.now();
    }
    if (e.from === "CONNECTED" && e.to !== "CONNECTED") {
      this._clearDeadPeerTimer();
    }
    // Plan 04 — disconnect detection (CLIENT-05/06/17). Trigger
    // `_handleDisconnect` on transitions out of CONNECTED into a
    // disconnect-leaning state, OR on a CONNECTING/RECONNECTING attempt
    // failing into CLOSED while we are inside a reconnect cycle (so the
    // cycle continues incrementing `_attempt`). The cycle-start flag plus
    // `_userClosed` guard against re-entry.
    const isPostConnectedDrop =
      e.from === "CONNECTED" &&
      (e.to === "DISCONNECTED" || e.to === "RECONNECTING" || e.to === "CLOSED");
    const isReconnectAttemptFailure =
      this._reconnectCycleStartedAt !== null &&
      (e.from === "CONNECTING" || e.from === "RECONNECTING") &&
      (e.to === "CLOSED" || e.to === "DISCONNECTED");
    if (isPostConnectedDrop || isReconnectAttemptFailure) {
      const cause = this._lastError ?? new Error(e.reason ?? "disconnect");
      if (this._userClosed) return;
      if (!this._autoReconnect) {
        // Reject pending sends — same teardown path as close() but with a
        // disconnect-flavored MllpConnectionError so callers see the cause.
        this._teardownCorrelator(
          new MllpConnectionError("disconnected; autoReconnect disabled", {
            cause,
            phase: "send",
          }),
        );
        return;
      }
      this._handleDisconnect(cause);
    }
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
  send(payload: Buffer, opts?: { signal?: AbortSignal; ackTimeoutMs?: number }): Promise<Buffer> {
    const signal = opts?.signal;
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }
    if (
      this._connection === null ||
      this._correlator === null ||
      this._connection.state !== "CONNECTED"
    ) {
      return Promise.reject(
        new MllpConnectionError("send before connect", {
          cause: new Error(`client state is ${this.state}`),
          phase: "send",
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
    // Frame once at enqueue time — same bytes go to the wire AND get held
    // for Plan 04 reconnect-resend (D-08 / CLIENT-17 controlId branch).
    const frame = encodeFrame(payload);

    // Plan 05 — backpressure gate (CLIENT-07, D-23). Runs BEFORE enqueue
    // so a rejected send never touches the live store. The gate measures
    // the current `correlator.size` + `queueBytes` against the configured
    // high-water mark and applies the configured policy.
    const newQueueDepth = correlator.size + 1;
    const newQueueBytes = correlator.queueBytes + frame.length;
    const overCount = newQueueDepth > this._hwmCount;
    const overBytes = newQueueBytes > this._hwmBytes;
    if (overCount || overBytes) {
      const hwmDesc: { count?: number; bytes?: number } = {};
      if (this._hwmCount !== Number.POSITIVE_INFINITY) {
        hwmDesc.count = this._hwmCount;
      }
      if (this._hwmBytes !== Number.POSITIVE_INFINITY) {
        hwmDesc.bytes = this._hwmBytes;
      }
      if (this._onBackpressure === "reject") {
        return Promise.reject(
          new MllpBackpressureError(
            `queue at high-water mark (depth=${correlator.size}, bytes=${correlator.queueBytes})`,
            {
              queueDepth: correlator.size,
              queueBytes: correlator.queueBytes,
              highWaterMark: hwmDesc,
            },
          ),
        );
      }
      // 'wait' mode (CLIENT-07/CLIENT-11): defer until 'drain' fires OR
      // ackTimeoutMs elapses OR the caller's signal aborts (B-06).
      return this._waitThenSend(payload, opts);
    }

    return new Promise<Buffer>((resolve, reject) => {
      let abortListener: (() => void) | null = null;
      const wrappedResolve = (ack: Buffer): void => {
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener("abort", abortListener);
        }
        resolve(ack);
      };
      const wrappedReject = (err: Error): void => {
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener("abort", abortListener);
        }
        reject(err);
      };
      const key = correlator.enqueue(frame, controlId, wrappedResolve, wrappedReject);
      if (key === null) {
        // pipeline:false (Plan 05 — D-06). Correlator's maxInFlight=1 is
        // saturated. Wait for the next 'drain' event (the prior ACK
        // releases the slot) and then re-enter `send()` — the high-water
        // mark gate above has already approved this send.
        const onDrain = (): void => {
          this.off("drain", onDrain);
          this.send(payload, opts).then(wrappedResolve, wrappedReject);
        };
        this.on("drain", onDrain);
        if (signal !== undefined) {
          abortListener = (): void => {
            this.off("drain", onDrain);
            wrappedReject(new DOMException("Aborted", "AbortError"));
          };
          signal.addEventListener("abort", abortListener, { once: true });
        }
        return;
      }
      if (signal !== undefined) {
        abortListener = (): void => {
          correlator.remove(key);
          wrappedReject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      // Connection.send returns boolean; `false` indicates socket-level
      // backpressure (the OS still buffers the bytes). The application-level
      // high-water mark is what the gate above enforces.
      conn.send(frame);
      correlator.markFlushed(key, Date.now());
      // PLAN-06 (OBS-01, D-26) — count flushed sends. Synchronous post-send
      // increment per T-05-06-05 (counter race is bounded; observability is
      // "good enough" per D-26).
      this._sentTotal += 1;
    });
  }

  /**
   * 'wait'-mode backpressure handler (Plan 05 — CLIENT-07/CLIENT-11).
   *
   * Awaits one of three terminating signals, in order:
   * - `'drain'` event → re-enter `send()` (the gate will now pass).
   * - `ackTimeoutMs` elapses → reject with `MllpTimeoutError`.
   * - Caller's `signal` aborts → reject with `AbortError` (B-06). Cleanup
   *   removes the drain listener AND the abort listener AND clears the
   *   timer to prevent leaks.
   */
  private _waitThenSend(
    payload: Buffer,
    opts?: { signal?: AbortSignal; ackTimeoutMs?: number },
  ): Promise<Buffer> {
    const signal = opts?.signal;
    return new Promise<Buffer>((resolve, reject) => {
      const ackTimeoutMs = opts?.ackTimeoutMs ?? this._ackTimeoutMs;
      let abortListener: (() => void) | null = null;
      const cleanup = (): void => {
        this.off("drain", onDrain);
        clearTimeout(timer);
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener("abort", abortListener);
        }
      };
      const onDrain = (): void => {
        cleanup();
        // Re-enter send(): the gate will now pass because the queue
        // shrank. Forward both branches to our promise.
        this.send(payload, opts).then(resolve, reject);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new MllpTimeoutError(`waiting for drain timed out after ${ackTimeoutMs}ms`, {
            messageControlId: undefined,
            elapsedMs: ackTimeoutMs,
            sentAt: Date.now(),
          }),
        );
      }, ackTimeoutMs);
      timer.unref();
      this.on("drain", onDrain);
      if (signal !== undefined) {
        // B-06: 'wait' mode MUST honor signal abort mid-wait. Cleanup
        // removes the drain listener so listenerCount('drain') returns to
        // its pre-send baseline, the timer is cleared, and the abort
        // listener removes itself.
        abortListener = (): void => {
          cleanup();
          reject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
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
    // Plan 05 — dead-peer timer cleanup. Belt-and-suspenders for the
    // destroy() path that may bypass an explicit FSM transition.
    this._clearDeadPeerTimer();
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
      throw new MllpConnectionError("connection already attached", {
        cause: new Error("attach twice"),
        phase: "connect",
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
  async close(opts?: { drainTimeoutMs?: number; signal?: AbortSignal }): Promise<void> {
    const signal = opts?.signal;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    // Plan 04: suppress reconnect for the rest of this client's lifetime.
    this._userClosed = true;
    if (this._backoffTimer !== null) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }

    const conn = this._connection;
    if (conn === null) {
      // No connection attached; still tear down any stray correlator state
      // (defensive — this branch is unreachable in normal flow).
      this._teardownCorrelator(
        new MllpConnectionError("client closed", {
          cause: new Error("closed"),
          phase: "close",
        }),
      );
      return;
    }

    // Reject pending sends BEFORE delegating to Connection.close so callers
    // observe the rejection promptly rather than waiting for the drain.
    this._teardownCorrelator(
      new MllpConnectionError("client closed", {
        cause: new Error("closed"),
        phase: "close",
      }),
    );

    if (signal === undefined) {
      const closeOpts =
        opts?.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : undefined;
      await conn.close(closeOpts);
      return;
    }

    // Wire AbortSignal — abort during drain force-destroys the Connection
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = (): void => {
        conn.destroy(new Error("aborted"));
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });

    try {
      const closeOpts =
        opts?.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : undefined;
      await Promise.race([conn.close(closeOpts), abortPromise]);
    } finally {
      if (abortHandler !== undefined) {
        signal.removeEventListener("abort", abortHandler);
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
    // Plan 04: suppress reconnect for the rest of this client's lifetime.
    this._userClosed = true;
    if (this._backoffTimer !== null) {
      clearTimeout(this._backoffTimer);
      this._backoffTimer = null;
    }
    const teardownReason =
      reason ??
      new MllpConnectionError("client destroyed", {
        cause: new Error("destroyed"),
        phase: "close",
      });
    this._teardownCorrelator(teardownReason);
    const conn = this._connection;
    if (conn === null) return;
    conn.destroy(reason);
  }

  /**
   * Returns a JSON-serializable observability snapshot (OBS-01, D-26).
   *
   * All fields are plain values — no Buffers, no class instances, no Maps,
   * no circular refs. Safe to `JSON.stringify` directly.
   *
   * `inFlight` is the count of correlator entries with `sentAt !== null`
   * (entries actually written to the wire and awaiting ACK), distinct from
   * `queueDepth` which counts ALL live correlator entries (including
   * pre-flush and serialization-queued sends).
   *
   * @example
   * ```typescript
   * setInterval(() => logger.info(JSON.stringify(client.getStats())), 60_000);
   * ```
   */
  getStats(): ClientStats {
    const connStats = this._connection?.getStats();
    const corrStats = this._correlator?.getStats();
    // Merge warningsByCode: Connection-level + Client-aggregated (Correlator-emitted).
    const merged: Partial<Record<WarningCode, number>> = {
      ...this._aggregatedWarningsByCode,
    };
    if (connStats !== undefined) {
      for (const [k, v] of Object.entries(connStats.warningsByCode)) {
        const code = k as WarningCode;
        merged[code] = (merged[code] ?? 0) + v;
      }
    }
    return {
      state: this.state,
      connectionId: connStats?.connectionId ?? null,
      queueDepth: corrStats?.size ?? 0,
      queueBytes: corrStats?.queueBytes ?? 0,
      inFlight: corrStats?.inFlight ?? 0,
      warningsByCode: merged,
      totalBytesIn: connStats?.bytesIn ?? 0,
      totalBytesOut: connStats?.bytesOut ?? 0,
      sentTotal: this._sentTotal,
      ackedTotal: this._ackedTotal,
      timedOutTotal: this._timedOutTotal,
      reconnectAttempts: this._reconnectAttempts,
      lastConnectedAt: this._lastConnectedAt,
      lastAckAt: this._lastAckAt,
      tls: this._opts.tls !== undefined,
    };
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
 * import { createClient } from '@cosyte/mllp';
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

/**
 * Options for {@link createStarterClient} (PLAN-06, CLIENT-10).
 *
 * The starter applies opinionated D-22 defaults on top of `ClientOptions`,
 * so every override here is optional except `host` + `port`. The
 * starter-specific addition is `handleSignals` (mirrors `createStarterServer`).
 *
 * @example
 * ```typescript
 * const opts: StarterClientOptions = {
 *   host: 'localhost',
 *   port: 2575,
 *   onMessage: (payload) => logger.info({ bytes: payload.length }),
 *   handleSignals: true,
 * };
 * ```
 */
export interface StarterClientOptions {
  /** Host to connect to. */
  readonly host: string;
  /** TCP port. */
  readonly port: number;
  /**
   * Inbound-message callback (any framed payload from the peer, including
   * non-ACK messages on bidirectional channels). Mirrors the server-side
   * `onMessage` ergonomics.
   */
  readonly onMessage?: (payload: Buffer) => void;
  /** Override default `30_000`. */
  readonly ackTimeoutMs?: number;
  /** Override default `false` (FIFO mode). */
  readonly correlateByControlId?: boolean;
  /** Override default `true` (parallel up to highWaterMark). */
  readonly pipeline?: boolean;
  /** Override default `64`. */
  readonly highWaterMark?: HighWaterMark;
  /** Override default `'reject'`. */
  readonly onBackpressure?: "reject" | "wait";
  /** Override default `true` (auto-reconnect on transient errors). */
  readonly autoReconnect?: boolean;
  /** Custom reconnect-backoff hook (CLIENT-12). */
  readonly retryStrategy?: RetryStrategy;
  /** Drain timeout for `close()` (default `30_000`). */
  readonly drainTimeoutMs?: number;
  /** FrameReader options (passthrough). */
  readonly framing?: ClientOptions["framing"];
  /** TCP keepalive interval ms (CLIENT-08). */
  readonly keepaliveIntervalMs?: number;
  /** Application-idle dead-peer timeout ms (CLIENT-08). */
  readonly deadPeerTimeoutMs?: number;
  /** Enable TLS (MLLPS) for this connection (Phase 8). Passthrough to `ClientOptions.tls`. */
  readonly tls?: TlsOptions | true;
  /**
   * Register process SIGTERM/SIGINT handlers that close the client. Default
   * `false` (D-22). When `true`, SIGTERM/SIGINT both call `client.close()`
   * and exit the process. Handlers self-deregister on `'close'` (T-05-06-01).
   */
  readonly handleSignals?: boolean;
}

/**
 * Three-line MLLP client with batteries-included defaults (PLAN-06,
 * CLIENT-10, D-22). The returned client is already CONNECTED — `connect()`
 * has been awaited.
 *
 * D-22 defaults:
 * - `autoReconnect: true`
 * - `ackTimeoutMs: 30_000`
 * - `correlateByControlId: false` (FIFO mode — simplest mental model)
 * - `pipeline: true`
 * - `highWaterMark: 64`
 * - `onBackpressure: 'reject'`
 * - `handleSignals: false` (opt-in)
 *
 * The factory is **async**, so the literal three-line north-star snippet
 * has an explicit `await` BEFORE `createStarterClient(...)` — without it,
 * the `using` declaration would receive a `Promise`, not an `MllpClient`,
 * and `Symbol.asyncDispose` would not run at scope exit.
 *
 * @example
 * ```typescript
 * import { createStarterClient } from '@cosyte/mllp';
 * await using c = await createStarterClient({ host: 'localhost', port: 2575 });
 * const ack = await c.send(payloadBuffer);
 * ```
 */
export async function createStarterClient(opts: StarterClientOptions): Promise<MllpClient> {
  // Build ClientOptions, applying D-22 defaults only for unset fields.
  const clientOpts: ClientOptions = {
    host: opts.host,
    port: opts.port,
    autoReconnect: opts.autoReconnect ?? true,
    ackTimeoutMs: opts.ackTimeoutMs ?? 30_000,
    correlateByControlId: opts.correlateByControlId ?? false,
    pipeline: opts.pipeline ?? true,
    highWaterMark: opts.highWaterMark ?? 64,
    onBackpressure: opts.onBackpressure ?? "reject",
    ...(opts.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : {}),
    ...(opts.framing !== undefined ? { framing: opts.framing } : {}),
    ...(opts.retryStrategy !== undefined ? { retryStrategy: opts.retryStrategy } : {}),
    ...(opts.keepaliveIntervalMs !== undefined
      ? { keepaliveIntervalMs: opts.keepaliveIntervalMs }
      : {}),
    ...(opts.deadPeerTimeoutMs !== undefined ? { deadPeerTimeoutMs: opts.deadPeerTimeoutMs } : {}),
    ...(opts.tls !== undefined ? { tls: opts.tls } : {}),
  };
  const client = createClient(clientOpts);

  if (opts.onMessage !== undefined) {
    const handler = opts.onMessage;
    client.on("message", (e: { payload: Buffer }) => {
      handler(e.payload);
    });
  }

  if (opts.handleSignals === true) {
    // T-05-06-01: handler self-deregisters on 'close' to avoid per-process
    // listener accumulation (mirror createStarterServer pattern).
    const sigHandler = (): void => {
      void client
        .close()
        .then(() => process.exit(0))
        .catch(() => process.exit(1));
    };
    process.once("SIGTERM", sigHandler);
    process.once("SIGINT", sigHandler);
    client.once("close", () => {
      process.removeListener("SIGTERM", sigHandler);
      process.removeListener("SIGINT", sigHandler);
    });
  }

  await client.connect();
  return client;
}
