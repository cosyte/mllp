/**
 * MLLP Client, `createClient()` factory and `MllpClient` class.
 *
 * Provides the client-side MLLP transport: connect to an MLLP server over TCP,
 * encode and send framed messages, decode inbound ACKs, and surface lifecycle
 * events with frozen payloads. Supports `AbortSignal` cancellation on every
 * awaitable and `Symbol.asyncDispose` for `await using` ergonomics.
 *
 * The `correlateByControlId` option (MSH-10 → MSA-2 ACK matching) enables
 * out-of-order ACK handling.
 *
 * @example
 * ```typescript
 * import { createClient } from '@cosyte/mllp';
 *
 * const client = createClient({ host: 'localhost', port: 2575 });
 * await client.connect();
 * const ack = await client.send(payloadBuffer);
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
import { safeEmit, safeEmitError } from "../internal/safe-emit.js";
import { NetTransport, TlsTransport } from "../transport/index.js";
import type { Transport } from "../transport/index.js";
import type { TlsOptions } from "../transport/tls-options.js";
import { MLLP_TLS_VERIFY_DISABLED, type SecurityWarning } from "../transport/security-warnings.js";
import { resolveTlsCipherPolicy } from "../transport/tls-cipher-policy.js";
import { readNegotiatedTlsParameters } from "../transport/negotiated-tls.js";
import { encodeFrame } from "../framing/index.js";
import { MllpFramingError } from "../framing/index.js";
import type { FrameReaderOptions, MllpWarning, WarningCode } from "../framing/index.js";
import { Correlator, extractMsaControlId } from "./correlator.js";
import type { AckModeWarningContext, PendingAck, TwoPhaseState } from "./correlator.js";
import { ackDiagnosticMessage } from "./ack-diagnostics.js";
import type { AckCorrelationCode } from "./ack-diagnostics.js";
import { controlIdFromMsh, readMshSegment } from "../internal/control-id.js";
import {
  classifyOutboundAckMode,
  type CommitAckReport,
  type OutboundAckMode,
} from "../internal/ack-mode.js";
import { ackModeDiagnosticMessage, type AckModeCode } from "../internal/ack-mode-diagnostics.js";
import {
  MllpTimeoutError,
  MllpBackpressureError,
  MllpApplicationAckError,
  MllpCommitRejectedError,
  MllpNeverDeliveredError,
  MllpUnknownFateError,
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "./error.js";

/**
 * A send parked INSIDE the client with no bytes on the wire: one waiting for the queue to fall
 * below the high-water mark, or for the single in-flight slot `pipeline: false` allows.
 *
 * Such a send is not in the correlator, so nothing else on the shutdown path can see it, and
 * before this register existed its promise was simply left pending forever when the client
 * closed. It is the clearest case of a message that never reached the transport.
 */
interface ParkedSend {
  /** Stop waiting and fail the send. Assigned once the waiting is wired. */
  cancel: () => void;
}

/**
 * Module-level "never aborts" sentinel for `RetryContext.signal`.
 *
 * When `connect()` is called WITHOUT a signal, `RetryContext.signal` must
 * still be a real `AbortSignal` (the type is non-optional). This sentinel
 * is constructed once and reused across all signal-less reconnect cycles
 * no new AbortController is allocated per cycle.
 *
 * The originating `AbortController` is held in module-private scope and
 * never exposed; hostile callers cannot abort the sentinel.
 */
const NEVER_ABORTING_SIGNAL: AbortSignal = new AbortController().signal;

/**
 * Warning context for a diagnostic raised on an **outbound** send, where there is no
 * inbound frame to take an offset from and nothing to count.
 *
 * Every field is a fixed zero or `null` on purpose: the caller already holds the payload it
 * passed to `send()`, so a diagnostic about it has nothing to add beyond the code.
 */
const OUTBOUND_WARNING_CONTEXT: AckModeWarningContext = Object.freeze({
  msa1Bytes: null,
  ackCode: null,
  controlIdBytes: null,
  byteOffset: 0,
  elapsedSinceSendMs: 0,
});

/**
 * The `'warning'` payload the client emits for an ACK-correlation deviation
 * (`MLLP_ACK_UNMATCHED_CONTROL_ID`, `MLLP_ACK_AFTER_TIMEOUT`).
 *
 * A `MllpWarning` with two extra numeric fields. `message` is a **frozen
 * registry entry**, byte-for-byte identical for a given code no matter what
 * arrived on the wire, and everything input-derived is a number: the control
 * ID's byte length and the elapsed time. A warning is a log line, so it carries
 * no field content.
 *
 * @example
 * ```typescript
 * client.on('warning', (w: AckCorrelationWarning) => {
 *   logger.warn({ code: w.code, idBytes: w.controlIdBytes, elapsedMs: w.elapsedSinceSendMs });
 * });
 * ```
 */
export interface AckCorrelationWarning extends MllpWarning {
  /** The correlation code this warning reports. */
  readonly code: AckCorrelationCode;
  /**
   * Byte length of the control ID involved, or `null` when there was none to
   * read. Control IDs are decoded `latin1`, so a code-unit count is a byte count.
   */
  readonly controlIdBytes: number | null;
  /**
   * Milliseconds between the send's write-flush (or its timeout, for a late
   * ACK) and this warning.
   */
  readonly elapsedSinceSendMs: number;
}

/**
 * The `'warning'` payload the client emits for an **acknowledgement-mode** deviation: an
 * enhanced-mode send on a client that cannot correlate two acknowledgements, a Table 0155
 * value it did not recognise, an acknowledgement it could not classify into a mode, and a
 * further acknowledgement for a send that is already settled or failed.
 *
 * It arrives on the same `'warning'` event as a framing warning and an
 * {@link AckCorrelationWarning}, so narrow on `code` before reading its fields. It is
 * **not** an `MllpWarning`: its `code` is an {@link AckModeCode}, deliberately a family of
 * its own rather than an addition to the decoder's registry, and it is not counted in
 * `getStats().warningsByCode`, whose keys are the decoder's codes.
 *
 * Everything input-derived on it is a number or a member of the closed six-code Table 0008
 * set. `message` is a **frozen registry entry**, byte-for-byte identical for a given code
 * no matter what arrived on the wire. A warning is a log line, so it carries no field
 * content: an MSA-1 nobody could classify is reported by its byte length alone.
 *
 * @example
 * ```typescript
 * client.on('warning', (w: AckModeWarning) => {
 *   if (w.code === 'MLLP_ACK_MSA1_UNCLASSIFIABLE') {
 *     logger.warn({ code: w.code, msa1Bytes: w.msa1Bytes, at: w.byteOffset });
 *   }
 * });
 * ```
 */
export interface AckModeWarning {
  /** The acknowledgement-mode code this warning reports. */
  readonly code: AckModeCode;
  /** Frozen registry text for `code`. Never interpolated. */
  readonly message: string;
  /** Inbound frame's stream byte offset; `0` for a warning raised on an outbound send. */
  readonly byteOffset: number;
  /** Byte length of the MSA-1 field involved, or `null` when the code reports none. */
  readonly msa1Bytes: number | null;
  /** Table 0008 code involved, or `null` when the code reports none. */
  readonly ackCode: "AA" | "AE" | "AR" | "CA" | "CE" | "CR" | null;
  /** Byte length of the control ID involved, or `null` when there was none to read. */
  readonly controlIdBytes: number | null;
  /** Milliseconds since the send's write-flush, or since its disposal for a late ACK. */
  readonly elapsedSinceSendMs: number;
  /** Connection identifier, `undefined` before a connection is attached. */
  readonly connectionId: string | undefined;
  /** Wall-clock time at point of emission. */
  readonly timestamp: Date;
}

/**
 * Context passed to a custom `retryStrategy` hook on each reconnect attempt.
 *
 * Frozen via `Object.freeze` before invocation, handlers cannot mutate.
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
  /** How the failure that triggered this reconnect attempt was classified. */
  readonly classifiedAs: "transient" | "permanent";
  /**
   * The same `AbortSignal` passed into `connect()`. If no signal was
   * supplied, the module-level `NEVER_ABORTING_SIGNAL` sentinel is provided
   * so handlers always have a real `AbortSignal` to inspect.
   */
  readonly signal: AbortSignal;
}

/**
 * Custom reconnect-backoff hook. Return `null` to halt
 * reconnection, the FSM transitions to `CLOSED`.
 */
export type RetryStrategy = (ctx: RetryContext) => number | null;

/**
 * Combined count + byte-based queue cap. Stricter-of-two wins.
 *
 * - `number`, count cap only (default 64).
 * - `{ bytes }`, byte cap only.
 * - `{ count, bytes }`, both caps; whichever trips first wins.
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
  /**
   * Bound on the acknowledgement wait {@link MllpClient.close} performs (default: `30_000`
   * ms). Sends already written to the transport are awaited until it elapses; the wait ends
   * early the moment the last of them is answered.
   */
  readonly drainTimeoutMs?: number;
  /**
   * Per-message ACK timeout in milliseconds. The clock starts at
   * the underlying `write()` flush callback, NOT at the `send()` call,
   * pre-flush queue time is not charged to the peer. Default: `30_000`.
   */
  readonly ackTimeoutMs?: number;
  /**
   * Bound, in milliseconds, on the **second** wait an enhanced-mode send can enter: the
   * one that starts when an accept acknowledgement (`CA`) reports that the peer has
   * committed the message, and ends when the application acknowledgement arrives.
   *
   * Measured from the moment that accept acknowledgement was received, not from the send,
   * so a peer that commits at 9 s and applies at 12 s settles the send successfully at
   * 12 s. Defaults to whatever `ackTimeoutMs` is in force for the send, and can be
   * overridden per send. It only ever applies to a send whose MSH-16 asks for an
   * application acknowledgement, so it changes nothing for an original-mode interface.
   *
   * @default the send's own `ackTimeoutMs`
   */
  readonly applicationAckTimeoutMs?: number;
  /**
   * If `true`, ACKs are matched against outgoing sends by MSH-10 → MSA-2.
   * Default `false` (FIFO mode).
   *
   * Out-of-order ACKs from the peer are supported in this mode. MSH-10 is
   * extracted from the outbound payload before send; MSA-2 is extracted from
   * the inbound ACK payload. An ACK whose MSA-2 matches no pending send
   * (and is not in the late-ACK graveyard) emits a frozen
   * `MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID')` to the `'error'` event.
   * A late ACK whose MSA-2 matches a graveyard entry emits a
   * `MLLP_ACK_AFTER_TIMEOUT` warning and is dropped.
   *
   * @default false
   */
  readonly correlateByControlId?: boolean;
  /**
   * Auto-reconnect on transient disconnect. Default `false`.
   *
   * When `true`, dropped connections caused by transient errors (per
   * {@link isTransientConnectionError}) trigger the FSM cycle
   * `CONNECTED → DISCONNECTED → RECONNECTING → CONNECTING → CONNECTED`
   * with exponential backoff unless overridden by
   * {@link ClientOptions.retryStrategy}. Permanent errors halt and
   * transition directly to `CLOSED`.
   */
  readonly autoReconnect?: boolean;
  /**
   * Custom reconnect-backoff hook. Return `null` to halt
   * reconnection. Receives a frozen {@link RetryContext}. Defaults
   * to the exponential strategy.
   */
  readonly retryStrategy?: RetryStrategy;
  /** First delay (ms) on auto-reconnect; default 100. */
  readonly initialDelayMs?: number;
  /** Maximum backoff cap (ms); default 30_000. */
  readonly maxDelayMs?: number;
  /** Backoff multiplier; default 2. */
  readonly multiplier?: number;
  /** Jitter fraction, e.g. 0.2 = ±20%; default 0.2. */
  readonly jitter?: number;
  /**
   * Application-level high-water mark on the in-flight + queued send set.
   * `number` configures a count cap (default 64);
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
   * Behavior when the high-water mark is exceeded.
   *
   * - `'reject'` (default), `send()` rejects with `MllpBackpressureError`.
   * - `'wait'`, `send()` awaits the `'drain'` event OR the per-message
   *   `ackTimeoutMs` OR `signal` abort, whichever fires first.
   *
   * @default 'reject'
   */
  readonly onBackpressure?: "reject" | "wait";
  /**
   * Strict serialization send → await-ACK → send.
   *
   * - `true` (default), concurrent in-flight sends up to
   *   {@link ClientOptions.highWaterMark}.
   * - `false`, collapses the in-flight set to ≤1 (the unified Correlator's
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
   * of {@link ClientOptions.deadPeerTimeoutMs}.
   *
   * @default undefined (off)
   */
  readonly keepaliveIntervalMs?: number;
  /**
   * Application-idle timeout (ms) keyed on last inbound bytes / ACK / warning.
   * On trip, calls `connection.destroy(new Error('dead
   * peer timeout'))` which surfaces as `MllpConnectionError({ phase: 'receive' })`.
   * Trip honors {@link ClientOptions.autoReconnect}. Independent of
   * {@link ClientOptions.keepaliveIntervalMs}.
   *
   * @default undefined (off)
   */
  readonly deadPeerTimeoutMs?: number;
  /**
   * Enable TLS (MLLPS) for this connection. `true` enables TLS with
   * all defaults, including certificate verification **on**. Pass a
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
 * Observability snapshot returned by {@link MllpClient.getStats}.
 *
 * All fields are JSON-serializable, no Buffers, no class instances,
 * no Maps, no circular references. `lastConnectedAt` and `lastAckAt` are
 * **epoch milliseconds** (numbers), NOT `Date` instances, log-pipeline
 * friendly.
 *
 * `warningsByCode` keys are constrained to the public {@link WarningCode}
 * union, adding/removing a code is a breaking change (CLAUDE.md
 * stable-codes guardrail enforced at the type boundary).
 *
 * @example
 * ```typescript
 * const stats = client.getStats();
 * logger.info(JSON.stringify(stats));
 * // {"state":"CONNECTED","connectionId":"…","queueDepth":0, … }
 * ```
 */
export interface ClientStats {
  /** Current FSM state, mirrors `client.state`. */
  readonly state: ConnectionState;
  /** Live Connection's id, or `null` before the first connect (or post-CLOSED). */
  readonly connectionId: string | null;
  /** Total live correlator entries (in-flight + pre-flush + serialization-queued). */
  readonly queueDepth: number;
  /** Sum of `frame.length` across live correlator entries. */
  readonly queueBytes: number;
  /** Entries with `sentAt !== null`, actually written to the wire / awaiting ACK. */
  readonly inFlight: number;
  /**
   * Aggregated warning counts. Keys are constrained to the public
   * {@link WarningCode} union. Connection-level warnings + Correlator
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
  /** Total reconnect attempts since construction. */
  readonly reconnectAttempts: number;
  /** Epoch ms of the last `CONNECTED` transition. `null` until first connect. */
  readonly lastConnectedAt: number | null;
  /** Epoch ms of the most recent successful ACK. `null` until first ACK. */
  readonly lastAckAt: number | null;
  /** Whether this client is configured for TLS. Mirrors `ClientOptions.tls` being set. */
  readonly tls: boolean;
}

/**
 * MLLP client, composes a single {@link Connection} over a {@link NetTransport}
 * (production) or any other `Transport` (testing via {@link InMemoryTransport}).
 *
 * Public events, every payload `Object.freeze`'d before emission:
 * - `'stateChange'`, `{ from, to, reason? }` from the underlying Connection FSM
 * - `'connect'`, `{ connectionId }` once the FSM enters `CONNECTED`
 * - `'disconnect'`, `{ connectionId }` once the FSM enters `DISCONNECTED`
 * - `'reconnecting'`, `{ connectionId, attempt?, delayMs? }`
 * - `'close'`, `{ connectionId }` once the FSM enters terminal `CLOSED`
 * - `'message'`, `{ payload, connectionId, byteOffset, warnings }` for every inbound frame
 * - `'warning'`, `MllpWarning | AckCorrelationWarning`. A framing deviation arrives as a
 *   `MllpWarning` enriched with `connectionId` from the Connection layer; the two
 *   ACK-correlation codes arrive as {@link AckCorrelationWarning}, which adds
 *   `controlIdBytes` and `elapsedSinceSendMs`. Narrow on `code` before reading either.
 * - `'securityWarning'`, `SecurityWarning`. Emitted on every successful
 *   `secureConnect` (initial + every reconnect) when `tls.allowUnverified` is `true`
 *   with code `MLLP_TLS_VERIFY_DISABLED`. Also mirrored to `process.emitWarning`.
 * - `'tlsNegotiated'`, {@link NegotiatedTlsParameters}. Emitted once per completed TLS
 *   handshake (initial + every reconnect) with the negotiated protocol version and
 *   cipher suite. Never emitted on a plaintext connection.
 * - `'error'`, re-emitted from Connection. Guarded by `listenerCount('error') > 0` so
 *   absence of a listener does NOT crash the process (server precedent).
 *
 * @example
 * ```typescript
 * const client = createClient({ host: 'localhost', port: 2575 });
 * client.on('stateChange', ({ from, to }) => logger.info({ from, to }));
 * client.on('message', ({ payload }) => logger.info({ bytes: payload.length }));
 * await client.connect();
 * const ack = await client.send(payloadBuffer);
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

  /** Per-message ACK timeout in ms. Resolved at construction. */
  private readonly _ackTimeoutMs: number;
  /**
   * Default bound on the second (application-acknowledgement) wait, in ms.
   * `undefined` means "whatever ACK timeout is in force for that send".
   */
  private readonly _applicationAckTimeoutMs: number | undefined;
  /** controlId-mode flag. `false` → FIFO. */
  private readonly _correlateByControlId: boolean;
  /** Unified ACK correlator. Built during `_attachConnection`. */
  private _correlator: Correlator | null = null;
  /**
   * Periodic ACK-timeout sweep timer. Drives `_correlator.expireDue()` because
   * the Correlator is timer-free. Cleared on close/destroy.
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
   * Total reconnect attempts since construction, surfaced as
   * `getStats().reconnectAttempts`. Incremented at the entry of every
   * `_handleDisconnect` invocation that proceeds to schedule a backoff.
   */
  private _reconnectAttempts = 0;
  /** Epoch ms of the last successful ACK. Drives backoff-reset. */
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
  /** Dead-peer idle timer. `null` when not armed. */
  private _deadPeerTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the self-'ack' listener that resets the dead-peer timer
   * has been attached. Guards against duplicate listeners on reconnect. */
  private _ackResetWired = false;
  /** Most recently bound `connect()` signal. Reread on every RetryContext build. */
  private _connectSignal: AbortSignal | undefined;
  /** Set when close()/destroy()/abort fires; reconnect handler short-circuits. */
  private _userClosed = false;
  /**
   * Sends parked inside the client with nothing written for them. See {@link ParkedSend}.
   * Every entry removes itself the moment its own wait ends, however it ends.
   */
  private readonly _parkedSends: Set<ParkedSend> = new Set();
  /**
   * Re-checks whether the shutdown drain is over, `null` when no `close()` is waiting.
   * Called from every point at which a pending send is settled.
   */
  private _drainWaiter: (() => void) | null = null;
  /**
   * Ends the shutdown drain wait now, whatever is still outstanding. `null` when no `close()`
   * is waiting. `destroy()` calls it, which is what makes a destroy during a drain prompt.
   */
  private _endDrainWait: (() => void) | null = null;
  /**
   * The `beforeClose` hook this client installed on its Connection, so a second `close()` call
   * composes nothing twice. Compared by identity, never by shape.
   */
  private _drainHook: ((drainTimeoutMs: number) => Promise<void>) | null = null;
  /** Captured Connection error feeding `RetryContext.lastError`. */
  private _lastError: Error | null = null;
  /** Listener-removal handle for the abort listener bound in connect(). */
  private _abortListener: { signal: AbortSignal; handler: () => void } | null = null;
  /**
   * Test-only seam, when set, `_beginReconnectAttempt` builds the new
   * Connection through this factory instead of opening a real net.Socket.
   *
   * @internal
   */
  private _reconnectFactory: (() => { conn: Connection; arm: () => void }) | null = null;

  // ── PLAN-06, observability counters for getStats (OBS-01, D-26) ─────────
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
   * at observation time and merged into the snapshot.
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
    this._applicationAckTimeoutMs = opts.applicationAckTimeoutMs;
    this._correlateByControlId = opts.correlateByControlId === true;
    this._autoReconnect = opts.autoReconnect === true;
    this._initialDelayMs = opts.initialDelayMs ?? 100;
    this._maxDelayMs = opts.maxDelayMs ?? 30_000;
    this._multiplier = opts.multiplier ?? 2;
    this._jitter = opts.jitter ?? 0.2;
    this._retryStrategy = opts.retryStrategy;

    // Plan 05, backpressure + pipeline (D-23, D-06).
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
   * Open a TCP (or TLS) connection to the configured `host:port`
   * and attach a {@link Connection} to it. Resolves once the FSM
   * enters `CONNECTED`, for TLS, on `'secureConnect'` (handshake complete,
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
   * - `MllpTlsConfigurationError` if the configured cipher-suite list cannot be
   *   honoured (the runtime rejects it, or `atnaTransportSecurity` and `ciphers`
   *   both declare one). Raised **before** a socket is opened, so nothing is left
   *   connected; identify it by `instanceof` plus its stable `code`.
   *
   * **Dual failure signal on initial connect:** the Connection's transport
   * error handler is attached before this promise's own error listener, so a
   * pre-connect socket error produces BOTH the promise rejection AND a
   * client `'error'` event (when an `'error'` listener is attached). Handle
   * whichever fits your flow; they describe the same underlying failure.
   *
   * **TLS 1.3 + mutual TLS caveat (RFC 8446 §4.4.2):** `connect()` resolving
   * does NOT guarantee that a `clientAuth: 'MUST'` server accepted your
   * client certificate. Under TLS 1.3 the client's handshake, and its
   * `'secureConnect'`, can complete before the server finishes validating
   * the certificate; a rejection then surfaces moments later as a typed
   * post-connect error (`'error'` event with an `ERR_SSL_*`/alert cause,
   * classified **permanent**, no auto-reconnect loop). ACK correlation via
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
      // Plan 05, TCP keepalive set on the raw socket BEFORE NetTransport
      // wrap (CLIENT-08, D-11/A3, mirrors Phase 4 server). OS-level
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
        // Tear down the in-flight attempt, also clears the correlator so
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
        // resolves. Deferring notifyConnect for TLS was tried and removed,
        // any delay leaves the Connection in CONNECTING while post-handshake
        // frames arrive, and Connection discards frames outside
        // CONNECTED/DRAINING (a silent inbound-frame drop). See the
        // TLS 1.3 note in the method JSDoc for what this means for mTLS.
        cleanup();
        conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);
        this._emitInsecureWarningIfNeeded();
        this._emitNegotiatedTlsParameters(socket);
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
   * `NetTransport`. TLS: a `tls.TLSSocket` wrapped in
   * `TlsTransport`, verification defaults **on**
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
    // Resolved and PROVEN acceptable to the runtime BEFORE any socket exists,
    // so a suite list that cannot be honoured rejects connect() with a typed
    // MllpTlsConfigurationError and leaves nothing connected behind. The throw
    // lands in connect()'s promise executor (a rejection) and in
    // _beginReconnectAttempt's catch (a permanent classification, MLLP_* code).
    const cipherPolicy = resolveTlsCipherPolicy(tlsOpts, "client");
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
      ...cipherPolicy,
      rejectUnauthorized: tlsOpts.allowUnverified !== true,
    });
    return { socket, transport: new TlsTransport(socket) };
  }

  /**
   * Wrap a connect-phase socket error as `MllpConnectionError`, classifying
   * TLS failures into the additive `connectionCause`:
   *
   * - `'tls-verify'`, certificate-verification failures
   *   ({@link isTlsVerificationErrorCode}).
   * - `'tls-handshake'`, TLS-**protocol**-shaped failures only
   *   ({@link isTlsProtocolError}): `ERR_SSL_*`, `EPROTO`, OpenSSL
   *   alert-bearing errors.
   * - **No `connectionCause`**, pure TCP-level failures (`ECONNREFUSED`,
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
    // Pure TCP-level failure on a TLS-configured connection, same shape as
    // a plaintext connect failure; no TLS-specific connectionCause.
    return new MllpConnectionError(err.message, { cause: err, phase });
  }

  /**
   * Emit a client event, containing a throwing subscriber.
   *
   * Every event this client emits is reached from a callback we do not own, a socket's
   * `'connect'`/`'secureConnect'`/`'data'`/`'error'` listener, or a backoff timer. A throwing
   * subscriber would unwind into it and kill the process, and on several paths it would also skip
   * the work queued after the emit (the `resolve()` of `connect()`, the backoff scheduling).
   *
   * See `src/internal/safe-emit.ts`. The throw is re-surfaced on `'error'`.
   */
  private _emitContained(event: string, payload: unknown): void {
    safeEmit(this, event, payload, (err) => {
      safeEmitError(this, Object.freeze({ error: err }));
    });
  }

  /**
   * Emit a frozen {@link AckModeWarning} on the `'warning'` event.
   *
   * The message is a **registry lookup**, not an interpolation, and everything
   * input-derived on the payload is a number or a closed-set code. This holds in every
   * mode: an original-mode send emits nothing new, but when it does reach one of these
   * codes the same discipline applies.
   */
  private _emitAckModeWarning(
    code: AckModeCode,
    ctx: AckModeWarningContext,
    conn?: Connection,
  ): void {
    const warning: AckModeWarning = Object.freeze({
      code,
      message: ackModeDiagnosticMessage(code),
      byteOffset: ctx.byteOffset,
      msa1Bytes: ctx.msa1Bytes,
      ackCode: ctx.ackCode,
      controlIdBytes: ctx.controlIdBytes,
      elapsedSinceSendMs: ctx.elapsedSinceSendMs,
      connectionId: this._connection?.connectionId ?? conn?.connectionId,
      timestamp: new Date(),
    });
    this._emitContained("warning", warning);
  }

  /**
   * Build the typed error for a send that was left waiting on its application
   * acknowledgement: the peer committed the message and then either fell silent past the
   * second window or lost the link.
   */
  private _applicationAckError(
    entry: PendingAck,
    reason: "timeout" | "connection-lost",
    elapsedMs: number,
    detail: string,
  ): MllpApplicationAckError {
    const commitReceivedAt = entry.twoPhase?.commitReceivedAt ?? 0;
    return new MllpApplicationAckError(
      `commit accepted (CA); no application acknowledgement ${detail}`,
      {
        reason,
        commitCode: "CA",
        messageControlIdBytes: entry.controlId?.length,
        elapsedMs,
        commitReceivedAt,
      },
    );
  }

  /**
   * Fail every pending send that is waiting on its application acknowledgement, with an
   * error naming the commit disposition already received. Used on the paths where the link
   * goes away: such a send must not be held for a resend (the peer already has the
   * message), nor left pending, nor reported as successful.
   *
   * Returns the entries it removed. Sends without a reported commit are untouched.
   */
  private _failCommitPendingSends(cause: string): PendingAck[] {
    const corr = this._correlator;
    if (corr === null) return [];
    const stranded: PendingAck[] = [];
    for (const entry of corr.liveEntries()) {
      if ((entry.twoPhase?.commitReceivedAt ?? null) !== null) stranded.push(entry);
    }
    const now = Date.now();
    for (const entry of stranded) {
      corr.dispose(entry.key);
      const commitReceivedAt = entry.twoPhase?.commitReceivedAt ?? now;
      entry.reject(
        this._applicationAckError(entry, "connection-lost", now - commitReceivedAt, cause),
      );
    }
    return stranded;
  }

  /**
   * Emit the per-connection insecure-TLS warning when
   * `tls.allowUnverified === true`, fires on EVERY successful
   * `secureConnect`, initial connect and every reconnect. Emits both a frozen
   * `'securityWarning'` event and `process.emitWarning`. No-op for plaintext
   * connections or when verification is on.
   */
  private _emitInsecureWarningIfNeeded(): void {
    const tlsOpt = this._opts.tls;
    if (tlsOpt === undefined || tlsOpt === true) return;
    if (tlsOpt.allowUnverified !== true) return;
    const message =
      "MLLP TLS certificate verification is DISABLED (allowUnverified: true), " +
      "this connection does not authenticate the peer.";
    const warning: SecurityWarning = Object.freeze({
      code: MLLP_TLS_VERIFY_DISABLED,
      message,
      host: this._opts.host,
      port: this._opts.port,
      timestamp: new Date(),
    });
    // Contained: this is reached from the socket's 'secureConnect' listener. A throwing
    // subscriber (a security-audit hook, exactly the kind of thing that subscribes here) would
    // both kill the process AND skip the resolve() that follows in onSocketConnect, hanging
    // connect() forever.
    this._emitContained("securityWarning", warning);
    process.emitWarning(message, { code: MLLP_TLS_VERIFY_DISABLED });
  }

  /**
   * Emit the frozen negotiated-parameters record for a completed TLS
   * handshake, once per connection, initial connect and every reconnect
   * alike. No-op for a plaintext connection: there is nothing negotiated to
   * report, so no event is emitted at all.
   *
   * The payload is read off the TLS session, so it is a pair of registry names
   * plus this client's own host and port. It never sees a payload byte: it is
   * built at handshake-completion time, before any HL7 byte crosses the link.
   */
  private _emitNegotiatedTlsParameters(socket: Socket | TLSSocket): void {
    if (this._opts.tls === undefined) return;
    const params = readNegotiatedTlsParameters(socket, this._opts.host, this._opts.port);
    if (params === null) return;
    // Contained: reached from the socket's 'secureConnect' listener, exactly like the insecure
    // warning above. A throwing subscriber (a conformance auditor, the natural consumer of this
    // event) must not kill the process nor skip the resolve() that follows in onSocketConnect.
    this._emitContained("tlsNegotiated", params);
  }

  /**
   * Wire a Connection's events through to this MllpClient. Every re-emitted
   * payload is `Object.freeze`'d before emission, even though the
   * Connection layer already freezes, defense-in-depth, harmless on
   * already-frozen objects.
   *
   * Builds the unified `Correlator` bound to this Connection and
   * arms the periodic ACK-timeout sweep. The Correlator is teardown-aware:
   * `close()` / `destroy()` clear the sweep timer and reject pending sends.
   *
   * @param conn - Connection to subscribe to.
   */
  private _attachConnection(conn: Connection): void {
    // Plan 04, preserve correlator state across reconnect cycles. In
    // controlId mode, in-flight sends are re-transmitted on the new
    // connection (D-08 / CLIENT-17), so the correlator must survive the
    // transition. The closures below dereference `this._connection`
    // lazily so they always see the CURRENT connection (not the dead
    // one captured at attach-time).
    if (this._correlator === null) {
      this._correlator = new Correlator({
        mode: this._correlateByControlId ? "controlId" : "fifo",
        ackTimeoutMs: this._ackTimeoutMs,
        // Plan 05, pipeline:false collapses the in-flight set to ≤1 (D-06).
        maxInFlight: this._pipeline ? Number.POSITIVE_INFINITY : 1,
        onWarning: (code, ctx) => {
          // PLAN-06 (OBS-01, D-26), aggregate Correlator-emitted warning counts.
          this._aggregatedWarningsByCode[code] = (this._aggregatedWarningsByCode[code] ?? 0) + 1;
          // The message is a REGISTRY LOOKUP, not an interpolation. Everything
          // input-derived is a number on its own field. See ack-diagnostics.ts.
          const warning: AckCorrelationWarning = Object.freeze({
            code,
            byteOffset: ctx.byteOffset,
            message: ackDiagnosticMessage(code),
            controlIdBytes: ctx.controlIdBytes,
            elapsedSinceSendMs: ctx.elapsedSinceSendMs,
            connectionId: this._connection?.connectionId ?? conn.connectionId,
            timestamp: new Date(),
          });
          this._emitContained("warning", warning);
        },
        onUnmatchedAck: (controlIdBytes) => {
          // CLIENT-15: unmatched ACK in controlId mode. Emit a frozen
          // MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID') to the 'error'
          // event. listenerCount-guarded so absent listeners don't crash the
          // process (T-05-03-02 mitigation).
          if (this.listenerCount("error") === 0) return;
          const err = new MllpFramingError(
            "MLLP_ACK_UNMATCHED_CONTROL_ID",
            0,
            Buffer.alloc(0),
            ackDiagnosticMessage("MLLP_ACK_UNMATCHED_CONTROL_ID"),
          );
          safeEmitError(
            this,
            Object.freeze({
              connectionId: this._connection?.connectionId ?? conn.connectionId,
              error: err,
              // The peer's MSA-2 byte LENGTH. The bytes themselves used to be
              // here and on the message above; a peer sending a one-megabyte
              // MSA-2 produced a one-megabyte Error.message, straight into a log.
              controlIdBytes,
            }),
          );
        },
        onTimeout: (entry, elapsedMs) => {
          // PLAN-06 (OBS-01, D-26), observability counter.
          this._timedOutTotal += 1;
          entry.reject(
            new MllpTimeoutError(`ACK timeout after ${elapsedMs}ms`, {
              messageControlIdBytes: entry.controlId?.length,
              elapsedMs,
              sentAt: entry.sentAt ?? 0,
            }),
          );
          // Plan 05, a timeout removes the entry from the live store too,
          // so emit 'drain' if the queue now sits below both caps. This is
          // critical for pipeline:false (D-06): an expired send must free
          // the in-flight slot so the next send can flush.
          this._maybeEmitDrain();
        },
        onApplicationAckTimeout: (entry, elapsedMs) => {
          this._timedOutTotal += 1;
          entry.reject(
            this._applicationAckError(entry, "timeout", elapsedMs, `after ${elapsedMs}ms`),
          );
          this._maybeEmitDrain();
        },
        onCommitRejected: (entry, code) => {
          entry.reject(
            new MllpCommitRejectedError(`peer answered a negative commit (${code})`, {
              commitCode: code,
              messageControlIdBytes: entry.controlId?.length,
              elapsedMs: entry.sentAt === null ? 0 : Date.now() - entry.sentAt,
            }),
          );
          this._maybeEmitDrain();
        },
        onCommitReported: (entry, ack, latencyMs) => {
          const report = entry.twoPhase?.onCommitReport ?? null;
          if (report === null) return;
          // Contained: this is the caller's own per-send hook, reached from the socket's
          // 'data' listener. A throwing hook must not unwind into the transport nor stop
          // the send from settling later on its application acknowledgement.
          try {
            report(Object.freeze({ code: "CA", payload: ack, latencyMs }));
          } catch (err) {
            safeEmitError(
              this,
              Object.freeze({
                connectionId: this._connection?.connectionId ?? conn.connectionId,
                error: err instanceof Error ? err : new Error(String(err)),
              }),
            );
          }
        },
        onAckModeWarning: (code, ctx) => {
          this._emitAckModeWarning(code, ctx, conn);
        },
      });
    }

    // Periodic sweep: smaller of (ackTimeoutMs / 4) and 1000 ms; floor 50 ms.
    // A shorter application-acknowledgement window tightens the same cadence, so the
    // second wait is swept at the resolution it was configured with rather than the first
    // wait's. .unref() so this timer never keeps the process alive.
    if (this._ackSweepTimer === null) {
      const shortestWindowMs = Math.min(
        this._ackTimeoutMs,
        this._applicationAckTimeoutMs ?? this._ackTimeoutMs,
      );
      const sweepIntervalMs = Math.max(50, Math.min(1000, Math.floor(shortestWindowMs / 4)));
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
        // Contained: a throwing 'message' subscriber used to abort this handler BEFORE
        // _onAckPayload ran, so the ACK never reached the correlator and send() hung forever.
        // An observer must never be able to break ACK correlation.
        this._emitContained("message", Object.freeze({ ...e }));
        // Plan 05, last-bytes-received signal resets dead-peer timer
        // (D-11 "last bytes/ACK received").
        this._armDeadPeerTimer();
        this._onAckPayload(e.payload, e.byteOffset);
      },
    );
    // PLAN-01 lifecycle re-emitters preserved unchanged.
    conn.on("connect", (e: unknown) => {
      this._emitContained("connect", Object.freeze({ ...(e as object) }));
    });
    conn.on("disconnect", (e: unknown) => {
      this._emitContained("disconnect", Object.freeze({ ...(e as object) }));
    });
    conn.on("reconnecting", (e: unknown) => {
      this._emitContained("reconnecting", Object.freeze({ ...(e as object) }));
    });
    conn.on("close", (e: unknown) => {
      this._emitContained("close", Object.freeze({ ...(e as object) }));
    });
    conn.on("warning", (w: MllpWarning) => {
      this._emitContained("warning", w);
      // Plan 05, Connection 'warning' is also a "bytes received" signal.
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
      // Guards the unlistened case (ERR_UNHANDLED_ERROR would crash the process, T-05-01-03)
      // AND contains a throwing 'error' subscriber. See src/internal/safe-emit.ts.
      safeEmitError(this, e);
    });
    this._connection = conn;

    // Plan 05, dead-peer timer self-listener on 'ack'. Connection emits
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
   * Arm (or re-arm) the dead-peer idle timer.
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
   * Clear the dead-peer idle timer on every transition out of CONNECTED.
   */
  private _clearDeadPeerTimer(): void {
    if (this._deadPeerTimer !== null) {
      clearTimeout(this._deadPeerTimer);
      this._deadPeerTimer = null;
    }
  }

  /**
   * Disconnect handler, reconnect FSM core.
   *
   * Implements:
   * - Hybrid in-flight handling: controlId mode preserves
   *   pending sends for resend; FIFO mode rejects in-flight with
   *   `connectionCause: 'in-flight-orphan'` and queued with `'fifo-unsafe'`.
   * - Classifier-first: permanent errors
   *   transition straight to CLOSED without invoking `retryStrategy`.
   * - Backoff-reset on recent success: first disconnect after a
   *   successful ACK on the prior session resets `_attempt` to 0.
   * - `_reconnectAttempts` counter increment.
   * - Frozen RetryContext; a `null` return from the strategy halts reconnection.
   * - Default exponential strategy.
   *
   * Invoked from the SINGLE `_onStateChange` hook, no parallel listener.
   * Idempotent across same-cycle re-entry: cycle-start flag
   * coordinates first-disconnect vs subsequent-within-cycle behavior.
   */
  private _handleDisconnect(err: Error): void {
    if (this._userClosed) return;

    // CLIENT-17 hybrid: handle queued + in-flight sends per mode.
    if (this._correlator !== null) {
      if (this._correlateByControlId) {
        // Hold sends for resend after reconnect, DO NOT clear or reject.
        // The correlator's live store survives the FSM transition; the
        // entries are re-transmitted in `_beginReconnectAttempt` once the
        // new Connection enters CONNECTED.
        //
        // With ONE exception, and it is the whole point of the accept acknowledgement: a
        // send whose commit disposition has already been reported must not be re-sent. The
        // peer has said in writing that it holds the message, so putting it back on the
        // wire is how one clinical message becomes two. Such a send is failed here, with an
        // error naming the commit it did receive.
        this._failCommitPendingSends("before the link dropped");
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

    // CLIENT-18 classification first (Composition A, D-16). Permanent
    // errors transition directly to CLOSED without invoking retryStrategy.
    // Phase 8: on a TLS-configured connection, TLS-protocol-shaped errors
    // (ERR_SSL_*, EPROTO, OpenSSL alert-bearing, see isTlsProtocolError)
    // are ALSO permanent: a clientAuth 'MUST' server that rejects this
    // client's certificate will reject every retry, never reconnect-loop
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
    // do NOT re-reset, the cycle-start flag persists.
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

    // Invoke strategy (T-05-04-05: defensive try/catch, caller-supplied hook).
    let delay: number | null;
    try {
      const strategy = this._retryStrategy ?? this._defaultRetryStrategy;
      delay = strategy(ctx);
    } catch (hookErr) {
      // Strategy threw, bail to CLOSED, surface error.
      this._lastError = hookErr instanceof Error ? hookErr : new Error(String(hookErr));
      {
        safeEmitError(
          this,
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
    //
    // Contained: a throwing subscriber here used to skip the backoff scheduling immediately below,
    // so auto-reconnect silently never fired again, the connection just stopped retrying, with no
    // error that named the cause.
    this._emitContained(
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
   * Default retry strategy: `min(maxDelay, initialDelay * multiplier^attempt)`
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
        // Plan 05, TCP keepalive on every reconnect attempt too
        // (CLIENT-08, D-11/A3, mirror connect() site).
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
          this._emitNegotiatedTlsParameters(socket);
        };
        const connectEventName = this._opts.tls !== undefined ? "secureConnect" : "connect";
        socket.once("error", (sErr: Error) => {
          // Phase 8, the raw OS/TLS error (with its original `.code`) is
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
          // TLS and plaintext arm identically and immediately, see the
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
   * Test seam, install a factory that produces the next reconnect Connection.
   *
   * @internal
   */
  _setReconnectFactory(factory: () => { conn: Connection; arm: () => void }): void {
    this._reconnectFactory = factory;
  }

  /**
   * Test seam, capture or rebind the connect-signal mid-flight.
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
   * - controlId mode: extracts MSA-2 and passes it to `matchAck` for keyed
   *   lookup.
   *
   * Called from the SINGLE `'message'` listener registered in `_attachConnection`.
   * No parallel listener is registered.
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
   * Emits the frozen 'ack' event and resolves the pending send. Updates
   * `_lastSuccessAt`, `_ackedTotal` and `_lastAckAt`.
   *
   * Called from _onAckPayload when matchAck() returns a non-null PendingAck.
   */
  private _onAckMatched(matched: PendingAck, ackPayload: Buffer): void {
    const latencyMs = matched.sentAt !== null ? Date.now() - matched.sentAt : 0;
    this._emitContained(
      "ack",
      Object.freeze({
        payload: ackPayload,
        controlId: matched.controlId,
        latencyMs,
      }),
    );
    // HOOK_EXTENSION_POINT: ack-matched
    // Plan 04, backoff-reset signal (W-01): record the most recent successful
    // ACK so the next disconnect resets attempt counter to 0 if it's the
    // first disconnect AFTER a successful exchange on the prior session.
    this._lastSuccessAt = Date.now();
    // PLAN-06 (OBS-01, D-26), observability counters.
    this._ackedTotal += 1;
    this._lastAckAt = Date.now();
    matched.resolve(ackPayload);
    // Plan 05, emit 'drain' when queue depth crosses below high-water mark
    // (D-24). Fires once per ACK that brings the queue under both caps.
    this._maybeEmitDrain();
  }

  /**
   * Emit a frozen `'drain'` event when the queue depth and bytes fall below
   * both configured caps. Called from `_onAckMatched`
   * (every successful ACK) and from the Correlator's `onTimeout` callback
   * (every expired send), both code paths free a live-store slot.
   */
  private _maybeEmitDrain(): void {
    // Every path that settles a pending send comes through here, which makes this the one
    // place a shutdown drain has to be re-checked: it ends as soon as the last acknowledgement
    // it was waiting for lands, rather than sitting out the rest of the timeout.
    this._drainWaiter?.();
    const corr = this._correlator;
    if (corr === null) return;
    const belowCount = corr.size < this._hwmCount;
    const belowBytes = corr.queueBytes < this._hwmBytes;
    if (belowCount && belowBytes) {
      this._emitContained(
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
   * Re-emits a frozen 'stateChange' event, detects
   * CONNECTED → DISCONNECTED|RECONNECTING to trigger `_handleDisconnect`, and
   * clears or arms the dead-peer timer on transitions out of / into CONNECTED.
   *
   * Called from the SINGLE 'stateChange' listener registered in _attachConnection.
   */
  private _onStateChange(e: StateChangeEvent): void {
    // Contained: everything below (dead-peer timer, the _handleDisconnect reconnect trigger) must
    // run even if a subscriber throws. A throwing 'stateChange' tap used to silently disable
    // auto-reconnect.
    this._emitContained("stateChange", Object.freeze({ ...e }));
    // HOOK_EXTENSION_POINT: state-change
    // A shutdown drain waiting on acknowledgements ends the moment the connection leaves
    // DRAINING: the link failed, the peer went away, or the client was destroyed. Nothing
    // further can be acknowledged over a link that is gone, so close() returns and reports
    // what is left rather than hanging until the drain timeout.
    if (e.to !== "DRAINING") this._endDrainWait?.();
    // Plan 05, dead-peer timer arm/clear (D-14). Cleared on every
    // transition OUT of CONNECTED; re-armed on entry TO CONNECTED.
    if (e.to === "CONNECTED") {
      this._armDeadPeerTimer();
      // PLAN-06 (OBS-01, D-26), record CONNECTED epoch for getStats.
      this._lastConnectedAt = Date.now();
    }
    if (e.from === "CONNECTED" && e.to !== "CONNECTED") {
      this._clearDeadPeerTimer();
    }
    // Plan 04, disconnect detection (CLIENT-05/06/17). Trigger
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
        // Reject pending sends, same teardown path as close() but with a
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
   * Send an MLLP-framed payload and await the inbound ACK.
   *
   * Resolves with the ACK Buffer (framing stripped). Rejects with:
   * - `DOMException('Aborted', 'AbortError')` if `signal` aborts before the ACK.
   * - `MllpTimeoutError` if no ACK arrives within `ackTimeoutMs`.
   *   The clock starts at the underlying `write()` flush callback, NOT at
   *   the `send()` call.
   * - `MllpConnectionError({ phase: 'send' })` if the client is not connected.
   *
   * Emits a frozen `'ack'` event on every successful match.
   *
   * ## Enhanced acknowledgement mode
   *
   * A message whose MSH-15 or MSH-16 is not null asks for the two-part protocol of HL7
   * v2.5.1 §2.9, and on a client correlating by control ID this method delivers it: the
   * accept acknowledgement (`CA`) is reported through `onCommitAck` **without** settling
   * the send, and the later application acknowledgement (`AA`/`AE`/`AR`) is what resolves
   * it. All three application-mode codes resolve, because which of them the receiving
   * application chose is its clinical verdict and not this transport's to judge; read MSA-1
   * off the acknowledgement you are handed. A negative commit (`CE`/`CR`) rejects with
   * {@link MllpCommitRejectedError} at once, since no application acknowledgement follows a
   * refusal to take custody.
   *
   * A message with both fields empty is an original-mode send and behaves exactly as it
   * always has, one acknowledgement, settled by the first match.
   *
   * @example
   * ```typescript
   * const ack = await client.send(payloadBuffer);
   * logger.info({ ack: ack.toString('utf8') });
   * ```
   *
   * @param payload Raw bytes; MLLP framing is added internally via `encodeFrame`.
   * @param opts.signal AbortSignal, aborting cancels the ACK wait.
   * @param opts.ackTimeoutMs Per-send override of the backpressure wait budget.
   * @param opts.applicationAckTimeoutMs Per-send override of the second wait's bound.
   * @param opts.onCommitAck Called with the commit disposition when the peer commits the
   *   message ahead of its application acknowledgement. See {@link CommitAckReport}.
   */
  send(
    payload: Buffer,
    opts?: {
      signal?: AbortSignal;
      ackTimeoutMs?: number;
      applicationAckTimeoutMs?: number;
      onCommitAck?: (report: CommitAckReport) => void;
    },
  ): Promise<Buffer> {
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
    // One header scan feeds both reads: the correlation key the peer will echo back as
    // MSA-2, and what this message asks its peer for. Both are derived BEFORE the message
    // reaches the transport, so nothing about a send is decided after it is on the wire.
    const msh = readMshSegment(payload);
    // controlId mode: extract MSH-10 BEFORE enqueue so the live-store key
    // is the same string the peer will echo back as MSA-2.
    const controlId: string | null = this._correlateByControlId ? controlIdFromMsh(msh) : null;
    const ackMode = classifyOutboundAckMode(msh);
    const twoPhase = this._twoPhaseStateFor(ackMode, opts);
    const correlator = this._correlator;
    const conn = this._connection;
    // Frame once at enqueue time, same bytes go to the wire AND get held
    // for Plan 04 reconnect-resend (D-08 / CLIENT-17 controlId branch).
    const frame = encodeFrame(payload);

    // Plan 05, backpressure gate (CLIENT-07, D-23). Runs BEFORE enqueue
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
      return this._waitThenSend(
        payload,
        { byteCount: frame.length, messageControlIdBytes: controlId?.length },
        opts,
      );
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
      const key = correlator.enqueue(frame, controlId, wrappedResolve, wrappedReject, twoPhase);
      if (key === null) {
        // pipeline:false (Plan 05, D-06). Correlator's maxInFlight=1 is
        // saturated. Wait for the next 'drain' event (the prior ACK
        // releases the slot) and then re-enter `send()`, the high-water
        // mark gate above has already approved this send.
        //
        // Nothing is on the wire for this send while it waits here, so it is registered as a
        // parked send: a shutdown must fail it with the never-delivered report rather than
        // leave its promise pending forever, which is what an unregistered park did.
        const parked: ParkedSend = { cancel: (): void => undefined };
        const neverDelivered = (): MllpNeverDeliveredError =>
          new MllpNeverDeliveredError({
            byteCount: frame.length,
            messageControlIdBytes: controlId?.length,
          });
        const onDrain = (): void => {
          this._parkedSends.delete(parked);
          this.off("drain", onDrain);
          // The settlement that ENDS a shutdown drain emits 'drain' on its way out, so this
          // listener can run while the client is already going down. Re-entering send() then
          // would trade the truthful report for the generic not-connected one, for a message
          // whose bytes were never written. See `_shutdownBegun`.
          if (this._shutdownBegun()) {
            wrappedReject(neverDelivered());
            return;
          }
          this.send(payload, opts).then(wrappedResolve, wrappedReject);
        };
        parked.cancel = (): void => {
          this.off("drain", onDrain);
          wrappedReject(neverDelivered());
        };
        this._parkedSends.add(parked);
        this.on("drain", onDrain);
        if (signal !== undefined) {
          abortListener = (): void => {
            this._parkedSends.delete(parked);
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
          // An abort takes an entry out of the live store without going through the settlement
          // path, so a shutdown drain waiting on that entry is re-checked here rather than
          // left to wait out a timeout for an acknowledgement nobody wants any more.
          this._drainWaiter?.();
          wrappedReject(new DOMException("Aborted", "AbortError"));
        };
        signal.addEventListener("abort", abortListener, { once: true });
      }
      // Connection.send returns boolean; `false` indicates socket-level
      // backpressure (the OS still buffers the bytes). The application-level
      // high-water mark is what the gate above enforces.
      conn.send(frame);
      correlator.markFlushed(key, Date.now());
      // PLAN-06 (OBS-01, D-26), count flushed sends. Synchronous post-send
      // increment per T-05-06-05 (counter race is bounded; observability is
      // "good enough" per D-26).
      this._sentTotal += 1;
    });
  }

  /**
   * Decide what a send's own MSH-15 and MSH-16 buy it, and report anything worth reporting
   * about them. Runs before the message reaches the transport.
   *
   * Three answers:
   *
   *   * an **original-mode** message (both fields null, or a header this package cannot
   *     scan) gets `null`, which is the state every send had before enhanced mode existed;
   *   * an **enhanced-mode** message on a client that correlates in order rather than by
   *     control ID also gets `null`, plus a warning saying so. MSA-2 is the only thing that
   *     can attribute a second acknowledgement to a send, so without control-ID correlation
   *     a two-acknowledgement conversation cannot be delivered. The alternative, leaving
   *     such a send pending on an acknowledgement this client would otherwise have settled
   *     it with, would break a working interface to signal a configuration gap;
   *   * an **enhanced-mode** message on a control-ID client gets its two-phase state.
   *
   * An unrecognised Table 0155 value is warned and defaulted, never fatal: this is a
   * transport, and refusing to transmit a clinical message over a vendor value in MSH-15
   * would be HL7 content validation with the worst failure mode available. The message goes
   * out unaltered either way.
   */
  private _twoPhaseStateFor(
    ackMode: OutboundAckMode,
    opts?: {
      ackTimeoutMs?: number;
      applicationAckTimeoutMs?: number;
      onCommitAck?: (report: CommitAckReport) => void;
    },
  ): TwoPhaseState | null {
    if (!ackMode.enhanced) return null;
    if (ackMode.acceptFieldUnrecognised) {
      this._emitAckModeWarning("MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED", OUTBOUND_WARNING_CONTEXT);
    }
    if (ackMode.applicationFieldUnrecognised) {
      this._emitAckModeWarning("MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED", OUTBOUND_WARNING_CONTEXT);
    }
    if (!this._correlateByControlId) {
      this._emitAckModeWarning("MLLP_ACK_TWO_PHASE_UNAVAILABLE", OUTBOUND_WARNING_CONTEXT);
      return null;
    }
    return {
      awaitsApplicationAck: ackMode.awaitsApplicationAck,
      applicationAckTimeoutMs:
        opts?.applicationAckTimeoutMs ??
        this._applicationAckTimeoutMs ??
        opts?.ackTimeoutMs ??
        this._ackTimeoutMs,
      onCommitReport: opts?.onCommitAck ?? null,
      commitCode: null,
      commitReceivedAt: null,
    };
  }

  /**
   * 'wait'-mode backpressure handler.
   *
   * Awaits one of four terminating signals, in order:
   * - `'drain'` event → re-enter `send()` (the gate will now pass).
   * - `ackTimeoutMs` elapses → reject with `MllpTimeoutError`.
   * - Caller's `signal` aborts → reject with `AbortError`. Cleanup
   *   removes the drain listener AND the abort listener AND clears the
   *   timer to prevent leaks.
   * - the client shuts down → reject with `MllpNeverDeliveredError`, because a send waiting
   *   here has written nothing and the peer cannot have seen it. Registering the wait as a
   *   {@link ParkedSend} is what makes that reachable at all.
   *
   * @param held - What this send would have written, for the never-delivered report. Counts
   *   only: the caller still holds the payload it passed to `send()`.
   */
  private _waitThenSend(
    payload: Buffer,
    held: { byteCount: number; messageControlIdBytes: number | undefined },
    opts?: {
      signal?: AbortSignal;
      ackTimeoutMs?: number;
      applicationAckTimeoutMs?: number;
      onCommitAck?: (report: CommitAckReport) => void;
    },
  ): Promise<Buffer> {
    const signal = opts?.signal;
    return new Promise<Buffer>((resolve, reject) => {
      const ackTimeoutMs = opts?.ackTimeoutMs ?? this._ackTimeoutMs;
      let abortListener: (() => void) | null = null;
      const parked: ParkedSend = { cancel: (): void => undefined };
      const cleanup = (): void => {
        this._parkedSends.delete(parked);
        this.off("drain", onDrain);
        clearTimeout(timer);
        if (signal !== undefined && abortListener !== null) {
          signal.removeEventListener("abort", abortListener);
        }
      };
      const onDrain = (): void => {
        cleanup();
        // The settlement that ENDS a shutdown drain emits 'drain' on its way out, so this
        // listener can run while the client is already going down, and nothing was ever
        // written for this send. Same rule as the in-flight-slot park; see `_shutdownBegun`.
        if (this._shutdownBegun()) {
          reject(new MllpNeverDeliveredError(held));
          return;
        }
        // Re-enter send(): the gate will now pass because the queue
        // shrank. Forward both branches to our promise.
        this.send(payload, opts).then(resolve, reject);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new MllpTimeoutError(`waiting for drain timed out after ${ackTimeoutMs}ms`, {
            messageControlIdBytes: undefined,
            elapsedMs: ackTimeoutMs,
            sentAt: Date.now(),
          }),
        );
      }, ackTimeoutMs);
      timer.unref();
      parked.cancel = (): void => {
        cleanup();
        reject(new MllpNeverDeliveredError(held));
      };
      this._parkedSends.add(parked);
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
   *
   * A send that is waiting on its application acknowledgement is failed with an error
   * naming the commit disposition it did receive, rather than with the generic
   * connection error every other pending send gets. The two are genuinely different
   * outcomes: one send may never have reached the peer, the other is known to be in its
   * custody with only its application disposition unknown. That branch runs FIRST and is not
   * overridable by the caller, because the peer's custody of those bytes is a known fact and
   * no shutdown report may downgrade it to an unknown one.
   *
   * @param reason - Error for every entry the caller offers no better answer for.
   * @param unresolvedFor - Per-entry error for an entry whose commit disposition has NOT
   *   arrived. This is where the shutdown path splits the two populations; omitted, every such
   *   entry gets `reason`.
   */
  private _teardownCorrelator(reason: Error, unresolvedFor?: (entry: PendingAck) => Error): void {
    if (this._ackSweepTimer !== null) {
      clearInterval(this._ackSweepTimer);
      this._ackSweepTimer = null;
    }
    if (this._correlator !== null) {
      this._correlator.clear(reason, (entry, fallback) => {
        const commitReceivedAt = entry.twoPhase?.commitReceivedAt ?? null;
        if (commitReceivedAt !== null) {
          return this._applicationAckError(
            entry,
            "connection-lost",
            Date.now() - commitReceivedAt,
            "before the connection closed",
          );
        }
        return unresolvedFor === undefined ? fallback : unresolvedFor(entry);
      });
      // Drop the reference so subsequent send() calls reject via the
      // _connection / _correlator null check.
      this._correlator = null;
    }
    // Plan 05, dead-peer timer cleanup. Belt-and-suspenders for the
    // destroy() path that may bypass an explicit FSM transition.
    this._clearDeadPeerTimer();
  }

  /**
   * Number of pending sends whose bytes ARE on the transport and whose acknowledgement has not
   * arrived. This is what a shutdown drain waits for, and nothing else: a send still held
   * inside the client cannot be acknowledged, so holding the drain open for one would spend a
   * clinical shutdown's timeout waiting for an answer that cannot come.
   */
  private _outstandingAckCount(): number {
    return this._correlator?.getStats().inFlight ?? 0;
  }

  /**
   * The report a still-pending send gets when the client has finished shutting down, for the
   * one population `_teardownCorrelator` leaves to this method: entries whose commit
   * disposition never arrived.
   *
   * The split is the whole point of the shutdown contract. `sentAt` is stamped at the
   * transport write and is `null` until then, so it says exactly which side of the wire a
   * message was on when the client stopped:
   *
   *   * written, unanswered: {@link MllpUnknownFateError}, ambiguous, and reported as
   *     ambiguous, carrying the flush timestamp a replay decision reasons about;
   *   * never written: {@link MllpNeverDeliveredError}, and a resend of one of those cannot
   *     duplicate anything.
   *
   * **The unflushed branch is a structural guard, and today no caller can reach it.** `send()`
   * writes and stamps in the same synchronous run, so an entry that is in the live store is an
   * entry that went out, and the never-written population arrives instead as a
   * {@link ParkedSend}, which never enters the store at all. The branch stays because the
   * store MODELS the state, `sentAt` being nullable is its own claim about it, and the
   * reconnect path already splits the same two ways on the same field. Deleting it would make
   * this report say the opposite of the truth the day anything does produce one, which on this
   * surface means telling a consumer to treat an unwritten message as possibly committed.
   */
  private _shutdownErrorFor(entry: PendingAck): Error {
    const flushedAt = entry.sentAt;
    /* c8 ignore next 6 -- structural guard, unreachable today; see the note above */
    if (flushedAt === null) {
      return new MllpNeverDeliveredError({
        byteCount: entry.byteCount,
        messageControlIdBytes: entry.controlId?.length,
      });
    }
    return new MllpUnknownFateError({
      flushedAt,
      elapsedMs: Date.now() - flushedAt,
      byteCount: entry.byteCount,
      messageControlIdBytes: entry.controlId?.length,
    });
  }

  /**
   * Has this client begun shutting down? A send parked inside it must not be resumed once it
   * has: nothing was ever written for such a send, so its report is that delivery did not
   * occur, and re-entering `send()` would trade that report for the generic not-connected one.
   *
   * True from the moment `close()` or `destroy()` is called, true on every halt that has
   * already given up on the connection (a permanent connect failure, an exhausted retry
   * policy, an aborted connect), and true while the underlying connection is draining, which
   * is how a connection closed from outside this client is caught. Each of those is a state a
   * fresh `send()` cannot succeed from.
   *
   * Read on the `'drain'` listener of every {@link ParkedSend}, because a shutdown drain ends
   * when the last outstanding acknowledgement (or timeout, or abort) settles, and that same
   * settlement emits `'drain'`. A park woken by it unregisters itself, so the settle pass that
   * runs after the drain no longer sees it: the choice has to be made here or not at all.
   */
  private _shutdownBegun(): boolean {
    return this._userClosed || this._connection?.state === "DRAINING";
  }

  /**
   * Fail every send parked inside the client. See {@link ParkedSend}.
   *
   * Iterates a copy and clears the register first, because each `cancel()` removes its own
   * entry as it unwinds.
   */
  private _cancelParkedSends(): void {
    if (this._parkedSends.size === 0) return;
    const parked = [...this._parkedSends];
    this._parkedSends.clear();
    for (const send of parked) send.cancel();
  }

  /**
   * Settle everything still unresolved once the shutdown drain is over, under the
   * two-population rule. Runs on every exit from `close()`, including the aborted one, so no
   * send's promise is left pending by a shutdown.
   */
  private _settleUnresolvedSends(): void {
    this._endDrainWait?.();
    this._cancelParkedSends();
    this._teardownCorrelator(
      new MllpConnectionError("client closed", {
        cause: new Error("closed"),
        phase: "close",
      }),
      (entry) => this._shutdownErrorFor(entry),
    );
  }

  /**
   * Install this client's acknowledgement drain on a Connection's `beforeClose` seam, which is
   * what gives `drainTimeoutMs` a meaning on the client at all.
   *
   * Whatever hook is already there is **composed with**, not replaced: the seam is a public
   * instance property an owner may legitimately have assigned, and a shutdown that silently
   * dropped that work would be a worse defect than the one this fixes. Installing is
   * idempotent by hook identity, so a second `close()` composes nothing twice.
   */
  private _installDrainHook(conn: Connection): void {
    if (conn.beforeClose === this._drainHook) return;
    const inherited = conn.beforeClose;
    const hook = (drainTimeoutMs: number): Promise<void> =>
      Promise.all([inherited.call(conn, drainTimeoutMs), this._awaitOutstandingAcks()]).then(
        () => undefined,
      );
    this._drainHook = hook;
    conn.beforeClose = hook;
  }

  /**
   * Resolve once there is nothing left to wait for. Three ways that happens:
   *
   *   * the last outstanding acknowledgement lands (or its send is otherwise settled), which
   *     is what lets `close()` return in a fraction of the drain timeout;
   *   * the connection leaves `DRAINING`, i.e. the link failed, the peer went away or the
   *     client was destroyed. Nothing further can be acknowledged over a link that is gone, so
   *     waiting out the rest of the timeout would buy nothing and hang the shutdown. That one
   *     arrives through `_onStateChange`, the single delegating listener, rather than through a
   *     second `'stateChange'` registration of its own;
   *   * never, in which case `Connection.close` times the whole thing out at `drainTimeoutMs`
   *     and the still-unanswered sends are reported with their fate unknown. The bound lives
   *     there, in the drain race, rather than being duplicated here.
   */
  private _awaitOutstandingAcks(): Promise<void> {
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this._drainWaiter = null;
        this._endDrainWait = null;
        resolve();
      };
      const recheck = (): void => {
        if (this._outstandingAckCount() === 0) finish();
      };
      this._drainWaiter = recheck;
      this._endDrainWait = finish;
      // Nothing outstanding is the common case: a caller that awaited its sends gets a close
      // that returns without touching the timeout at all.
      recheck();
    });
  }

  /**
   * **Test seam**, attach an externally-built {@link Connection} directly,
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
   * Gracefully close the client, awaiting the acknowledgements of sends already written to
   * the transport.
   *
   * Delegates to {@link Connection.close}, which transitions `CONNECTED → DRAINING
   * → DISCONNECTED` (or `CLOSED` on drain timeout). No-op if no Connection is
   * attached, or if the close has already completed.
   *
   * The drain ends as soon as the last outstanding acknowledgement arrives, so a caller whose
   * peer answers promptly does not wait out `drainTimeoutMs`. Whatever is still unresolved
   * when it does end is reported to its own `send()` caller under one rule, and the whole
   * point of this method is that the two halves of that rule are told apart:
   *
   *   * a send already written to the transport rejects with {@link MllpUnknownFateError},
   *     carrying the timestamp at which its bytes went out. It may have been committed;
   *     resending it may duplicate a clinical message. Nothing is retried here.
   *   * a send still held inside the client rejects with {@link MllpNeverDeliveredError}.
   *     The peer never saw those bytes, so resending them is safe.
   *   * a send whose commit disposition the peer had already reported keeps its
   *     {@link MllpApplicationAckError}, which names that disposition. The peer's custody of
   *     those bytes is known, and a shutdown never downgrades a known fact to an unknown one.
   *
   * Rejects with `DOMException('Aborted', 'AbortError')` if `signal` aborts mid-drain;
   * on abort, the underlying Connection is force-destroyed and every still-pending send is
   * settled under the same rule rather than left pending.
   *
   * A drain cannot make delivery certain, and nothing here claims otherwise: an
   * acknowledgement lost in flight is indistinguishable from a message never received. That is
   * what the unknown-fate report says, and it is why the application still owns idempotency,
   * keyed on MSH-10 plus MSH-7.
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
      // No connection attached; still settle anything the client is holding
      // (defensive, this branch is unreachable in normal flow).
      this._settleUnresolvedSends();
      return;
    }

    // Pending sends are settled AFTER the drain, in the `finally` below, because the whole
    // question this method answers, which messages definitely never reached the wire, cannot
    // be answered before the wait it needs. A Connection already in a terminal state drains
    // nothing and returns at once, so an already-closed client is still prompt.
    this._installDrainHook(conn);
    const closeOpts =
      opts?.drainTimeoutMs !== undefined ? { drainTimeoutMs: opts.drainTimeoutMs } : undefined;

    if (signal === undefined) {
      try {
        await conn.close(closeOpts);
      } finally {
        this._settleUnresolvedSends();
      }
      return;
    }

    // Wire AbortSignal, abort during drain force-destroys the Connection
    let abortHandler: (() => void) | undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      abortHandler = (): void => {
        conn.destroy(new Error("aborted"));
        reject(new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", abortHandler, { once: true });
    });

    try {
      await Promise.race([conn.close(closeOpts), abortPromise]);
    } finally {
      if (abortHandler !== undefined) {
        signal.removeEventListener("abort", abortHandler);
      }
      this._settleUnresolvedSends();
    }
  }

  /**
   * Abruptly destroy the client, force-transitions the underlying Connection
   * to `CLOSED` immediately. No-op if no Connection is attached. Idempotent.
   *
   * Every pending send is settled at once: no acknowledgement is awaited and no drain timeout
   * is honoured, which is exactly what separates this from {@link MllpClient.close}. A
   * `close()` already waiting on acknowledgements stops waiting here and returns. A send still
   * held inside the client is failed with {@link MllpNeverDeliveredError}, because nothing was
   * ever written for it; that is a statement about the bytes, not about how the client was
   * shut down, so it holds on this path too.
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
    // A drain in progress is abandoned rather than awaited, so a close() racing this destroy
    // returns instead of sitting out the rest of its timeout.
    this._endDrainWait?.();
    this._cancelParkedSends();
    this._teardownCorrelator(teardownReason);
    const conn = this._connection;
    if (conn === null) return;
    conn.destroy(reason);
  }

  /**
   * Returns a JSON-serializable observability snapshot.
   *
   * All fields are plain values, no Buffers, no class instances, no Maps,
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
   * Async disposal, delegates to {@link MllpClient.close} for `await using` support.
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
 * const ack = await client.send(payloadBuffer);
 * await client.close();
 * ```
 */
export function createClient(opts: ClientOptions): MllpClient {
  return new MllpClient(opts);
}

/**
 * Options for {@link createStarterClient}.
 *
 * The starter applies opinionated defaults on top of `ClientOptions`,
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
  /** Custom reconnect-backoff hook. */
  readonly retryStrategy?: RetryStrategy;
  /** Drain timeout for `close()` (default `30_000`). */
  readonly drainTimeoutMs?: number;
  /** FrameReader options (passthrough). */
  readonly framing?: ClientOptions["framing"];
  /** TCP keepalive interval ms. */
  readonly keepaliveIntervalMs?: number;
  /** Application-idle dead-peer timeout ms. */
  readonly deadPeerTimeoutMs?: number;
  /** Enable TLS (MLLPS) for this connection. Passthrough to `ClientOptions.tls`. */
  readonly tls?: TlsOptions | true;
  /**
   * Register process SIGTERM/SIGINT handlers that close the client. Default
   * `false`. When `true`, SIGTERM/SIGINT both call `client.close()`
   * and exit the process. Handlers self-deregister on `'close'`.
   */
  readonly handleSignals?: boolean;
}

/**
 * Three-line MLLP client with batteries-included defaults. The returned
 * client is already CONNECTED, `connect()` has been awaited.
 *
 * Defaults:
 * - `autoReconnect: true`
 * - `ackTimeoutMs: 30_000`
 * - `correlateByControlId: false` (FIFO mode, simplest mental model)
 * - `pipeline: true`
 * - `highWaterMark: 64`
 * - `onBackpressure: 'reject'`
 * - `handleSignals: false` (opt-in)
 *
 * The factory is **async**, so the literal three-line north-star snippet
 * has an explicit `await` BEFORE `createStarterClient(...)`, without it,
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
