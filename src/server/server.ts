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

import { createServer as netCreateServer, isIP, SocketAddress } from "node:net";
import type { Server as NetServer, Socket } from "node:net";
import { createServer as tlsCreateServer } from "node:tls";
import type { TLSSocket } from "node:tls";
import { EventEmitter } from "node:events";
import { Connection } from "../connection/index.js";
import { MllpConnectionError } from "../connection/index.js";
import { NetTransport, TlsTransport } from "../transport/index.js";
import type { ServerTlsOptions } from "../transport/tls-options.js";
import { MLLP_BIND_ALL_INTERFACES, type SecurityWarning } from "../transport/security-warnings.js";
import { encodeFrame } from "../framing/index.js";
import type { FrameReaderOptions, MllpWarning } from "../framing/index.js";
import { buildRawAck, resolveNackCode } from "./ack.js";
import type { AckCode, NegativeAckCode } from "./ack.js";
import { safeEmit, safeEmitError } from "../internal/safe-emit.js";

/**
 * Wildcard (unspecified-address) bind detection for Phase 8 bind safety —
 * hosts that bind ALL interfaces and therefore require
 * `ServerOptions.allowWildcardBind: true`.
 *
 * NORMALIZES rather than string-matching:
 * - `''` (empty string — Node binds all interfaces)
 * - IPv4: every dotted-quad whose octets are all numerically zero (`'0.0.0.0'`)
 * - IPv6: any spelling that canonicalizes (via `net.SocketAddress`) to `'::'`
 *   (`'::0'`, `'0:0:0:0:0:0:0:0'`, …) or to the IPv4-mapped unspecified
 *   address `'::ffff:0.0.0.0'` (also `'::ffff:0:0'`)
 *
 * Non-IP strings return `false` here — but that is NOT the enforcement
 * boundary. getaddrinfo/inet_aton resolves shorthands this predicate cannot
 * see as strings (`'0'`, `'0.0'`, `'0.0.0'`, `'00.0.0.0'`, `'0x0.0.0.0'`,
 * wildcard-resolving hostnames), so `listen()` applies this predicate
 * **twice**: pre-bind on the requested host string (fast path), and
 * post-bind on the **OS-normalized bound address** from `server.address()`
 * (always canonical `'0.0.0.0'`/`'::'`) — the authoritative check. The
 * guarantee is enforced against the address actually bound, not the
 * spelling requested.
 */
function isWildcardHost(host: string): boolean {
  if (host === "") return true;
  const family = isIP(host);
  if (family === 4) {
    return host.split(".").every((octet) => Number(octet) === 0);
  }
  if (family === 6) {
    let canonical: string;
    try {
      canonical = new SocketAddress({ address: host, family: "ipv6" }).address;
    } catch {
      // isIP said valid IPv6 but SocketAddress refused — treat as non-wildcard
      // (the bind itself will fail downstream with the OS error).
      return false;
    }
    return canonical === "::" || canonical === "::ffff:0.0.0.0";
  }
  return false;
}

/**
 * Minimal, content-free peer-certificate summary surfaced on the `'connection'`
 * event when `ServerOptions.tls.clientAuth` is `'WANT'` or `'MUST'` (Phase 8,
 * ATNA ITI-19 mutual authentication). Never the full certificate object —
 * CN strings, the expiry date, and the verification outcome only.
 *
 * @example
 * ```typescript
 * server.on('connection', ({ peerCertificate }) => {
 *   if (peerCertificate !== null && peerCertificate.authorized) {
 *     logger.info({ cn: peerCertificate.subjectCN });
 *   }
 * });
 * ```
 */
export interface PeerCertificateSummary {
  /** Subject Common Name, or `null` if absent/unavailable. */
  readonly subjectCN: string | null;
  /** Issuer Common Name, or `null` if absent/unavailable. */
  readonly issuerCN: string | null;
  /** Certificate expiry (`notAfter`), or `null` if absent/unavailable. */
  readonly validTo: string | null;
  /**
   * Whether the peer certificate chain was **verified** against
   * {@link ServerTlsOptions.ca} (`socket.authorized === true`).
   *
   * ⚠️ Under `clientAuth: 'WANT'` a peer certificate may be present yet
   * **unverified** — the connection is accepted regardless. Never make
   * authorization decisions on `subjectCN` (or any other field of this
   * summary) unless `authorized` is `true`. Under `clientAuth: 'MUST'` an
   * unverified certificate never reaches this point (the handshake is
   * rejected), so `authorized` is always `true` there.
   */
  readonly authorized: boolean;
}

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
  /** Whether this server is configured for TLS (Phase 8). Mirrors `ServerOptions.tls` being set. */
  readonly tls: boolean;
  /** Total `'tlsClientError'` events (failed TLS handshakes, incl. rejected client certs) since listen() (Phase 8). */
  readonly tlsClientErrorsTotal: number;
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

  /**
   * Enable TLS (MLLPS) for this server (Phase 8). When set, the server binds a
   * `tls.Server` instead of a plain `net.Server`, consumes `'secureConnection'`
   * (post-handshake sockets) instead of `'connection'`, and surfaces failed
   * handshakes via the `'tlsClientError'` event rather than crashing.
   *
   * Spec anchor: IHE ATNA ITI-19 (https://profiles.ihe.net/ITI/TF/Volume2/ITI-19.html).
   *
   * @default undefined (plaintext TCP)
   */
  tls?: ServerTlsOptions;

  /**
   * Opt-in required to bind a wildcard host — a bind-safety guardrail
   * (Phase 8). Without this flag, `listen()` rejects a wildcard host in
   * two tiers: **literal spellings** (`'0.0.0.0'`, `'::'`, `''`, `'::0'`,
   * `'0:0:0:0:0:0:0:0'`, `'::ffff:0.0.0.0'`, …) reject **pre-bind** (fast
   * path, nothing is ever bound); **resolver-only shorthands** (`'0'`,
   * `'0.0'`, `'0x0.0.0.0'`, hostnames resolving to the unspecified
   * address, …) are caught **post-bind** against the OS-normalized bound
   * address — the just-bound server closes before any connection can be
   * accepted and `listen()` rejects, with no listening state and no
   * `'listening'` event either way. When `true`, binding a wildcard host
   * emits a one-time `'securityWarning'` (`MLLP_BIND_ALL_INTERFACES`) at
   * listen time.
   *
   * @default false
   */
  allowWildcardBind?: boolean;
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
  /**
   * Host to bind to. Default `'127.0.0.1'` (Phase 8 bind-safety hardening —
   * was `'0.0.0.0'`; binding all interfaces now requires
   * `ServerOptions.allowWildcardBind: true`).
   */
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
 *
 * **`'error'` contract:** underlying `net.Server`/`tls.Server` errors are forwarded to the
 * `'error'` event whenever a listener is attached. With **no** listener, the outcome depends on
 * server state: during a `listen()` (the bind window) the error **rejects the `listen()` promise**
 * — the primary error surface — and the process never crashes on a bind error; with no `listen()`
 * in flight and the server not serving (e.g. a stale async error after `close()`) the error is
 * dropped; but **while serving**, an unlistened runtime error (e.g. accept-loop `EMFILE`) keeps
 * Node's fail-loud crash-on-unlistened-`'error'` convention — a silent accept outage is
 * impossible. Caveat for `'error'` listeners: the forwarder runs **before** the internal
 * `listen()` rejection handler, so an `'error'` listener that synchronously calls `close()`
 * during the bind window changes the `listen()` rejection from the bind error to the typed
 * close-during-listen `MllpConnectionError` — match on the `'error'` event payload, not the
 * rejection, if you do that.
 * Phase 8 (TLS/MLLPS) adds two more: `'tlsClientError'` (a failed TLS handshake — the
 * server logs it and keeps serving other connections) and `'securityWarning'` (loud,
 * one-time notice when a wildcard host is bound via `allowWildcardBind: true`).
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
  /** `true` when `ServerOptions.tls` is set — `_netServer` is actually a `tls.Server`. */
  private readonly _isTls: boolean;

  private _listening = false;
  /** Phase 8 — single-flight guard: `true` while a `listen()` call is settling. */
  private _listenInFlight = false;
  /**
   * Phase 8 — settle hook for an in-flight `listen()`. Non-null only while a
   * `listen()` is in flight; invoked by `close()` so a close racing startup
   * rejects the pending `listen()` (typed) instead of leaving it hung with
   * the single-flight guard stuck. Cleared on every settle path.
   */
  private _pendingListenSettle: (() => void) | null = null;
  private _port: number | null = null;
  private _host: string | null = null;
  private _acceptedTotal = 0;
  private _closedTotal = 0;
  /** Phase 8 — count of `'tlsClientError'` events since listen(). */
  private _tlsClientErrorsTotal = 0;

  /**
   * Construct an MLLP server. Created idle; call `listen()` (or use
   * {@link createServer}/{@link createStarterServer}) to begin accepting connections.
   *
   * @param opts - Server options (bind host/port, auto-ACK policy, message handler, framing, …).
   */
  constructor(opts: ServerOptions) {
    super();
    this._opts = opts;
    this._isTls = opts.tls !== undefined;

    if (opts.tls !== undefined) {
      const tlsOpts: ServerTlsOptions = opts.tls;
      const clientAuth = tlsOpts.clientAuth ?? "NONE";
      const tlsServer = tlsCreateServer({
        cert: tlsOpts.cert,
        key: tlsOpts.key,
        ...(tlsOpts.ca !== undefined ? { ca: tlsOpts.ca } : {}),
        ...(tlsOpts.passphrase !== undefined ? { passphrase: tlsOpts.passphrase } : {}),
        minVersion: tlsOpts.minVersion ?? "TLSv1.2",
        ...(tlsOpts.maxVersion !== undefined ? { maxVersion: tlsOpts.maxVersion } : {}),
        ...(tlsOpts.ciphers !== undefined ? { ciphers: tlsOpts.ciphers } : {}),
        requestCert: clientAuth !== "NONE",
        rejectUnauthorized: clientAuth === "MUST",
      });
      this._netServer = tlsServer;
      tlsServer.on("secureConnection", (socket: TLSSocket) => {
        this._onSocketAccepted(socket);
      });
      // 'tlsClientError' fires for failed handshakes (incl. rejected client
      // certs under mTLS 'MUST'). The server MUST NOT crash and MUST keep
      // accepting other connections — only the error's message/code and the
      // remote address are surfaced; never payload bytes or a cert dump.
      tlsServer.on("tlsClientError", (err: Error, socket: TLSSocket) => {
        this._tlsClientErrorsTotal += 1;
        const nodeErr = err as NodeJS.ErrnoException;
        const event: {
          remoteAddress: string | null;
          remotePort: number | null;
          message: string;
          code: string | null;
          timestamp: Date;
        } = Object.freeze({
          remoteAddress: socket.remoteAddress ?? null,
          remotePort: socket.remotePort ?? null,
          message: err.message,
          code: typeof nodeErr.code === "string" ? nodeErr.code : null,
          timestamp: new Date(),
        });
        // Contained: this runs inside tls.Server's own 'tlsClientError' listener, so a throwing
        // subscriber would kill the process on a failed handshake — flatly contradicting this
        // handler's whole purpose ("MUST NOT crash and MUST keep accepting other connections").
        this._emitContained("tlsClientError", event);
      });
    } else {
      this._netServer = netCreateServer();
      this._netServer.on("connection", (socket: Socket) => {
        this._onSocketAccepted(socket);
      });
    }

    // Forward net.Server errors to the public 'error' event, guarded by
    // server state — an unlistened EventEmitter 'error' emission THROWS,
    // and this constructor-time listener runs BEFORE listen()'s own
    // once('error') rejection handler (registration order), so an unguarded
    // re-emit crashed the process on a plain bind error (EADDRINUSE,
    // EACCES, …) instead of letting listen() reject. Contract (also in the
    // class JSDoc):
    //   • 'error' listener attached ⇒ always forwarded.
    //   • no listener + a listen() in flight (bind window) ⇒ dropped here;
    //     the listen() promise rejects with this error (primary surface).
    //   • no listener + not listening (e.g. stale async error after
    //     close()) ⇒ dropped; there is no consumer to surface it to.
    //   • no listener + SERVING (this._listening) ⇒ re-emit unguarded,
    //     which throws — Node's fail-loud convention is deliberately kept
    //     for runtime accept-loop errors (EMFILE/ENFILE): a silent accept
    //     outage on a healthcare listener must be impossible.
    // MLLP-10 refinement: the deliberate fail-loud branch below is PRESERVED exactly (unlistened +
    // serving ⇒ unguarded re-emit ⇒ throw), but a *throwing subscriber* is a different thing from
    // an unobservable accept outage, and it must not crash the server. When a listener exists, the
    // emit is contained.
    this._netServer.on("error", (err: Error) => {
      if (this.listenerCount("error") > 0) {
        safeEmitError(this, err); // contained — a throwing 'error' subscriber is not fail-loud
      } else if (this._listening) {
        this.emit("error", err); // DELIBERATE: unlistened + serving ⇒ Node's fail-loud convention
      }
    });
  }

  /**
   * Start listening on the given port.
   *
   * Resolves once the TCP socket is bound and emits `'listening'` with
   * `Object.freeze({ port: actualPort, host: actualHost })`.
   *
   * **Single-flight:** one `listen()` per server lifecycle at a time. A call
   * while the server is already listening — or while another `listen()` is
   * still in flight — rejects with a typed `MllpConnectionError` (concurrent
   * binds raced each other's post-bind safety checks). Call `close()` before
   * re-listening; sequential `listen()` → `close()` → `listen()` is fine.
   *
   * **`close()` during an in-flight `listen()`** rejects that `listen()` with
   * a typed `MllpConnectionError` (never a hang) and clears the single-flight
   * guard — a subsequent `listen()` on the same server works. This makes
   * `Symbol.asyncDispose` (which delegates to `close()`) safe even before a
   * `listen()` has settled. (Exception: `close({ signal })` with an
   * already-aborted signal is a no-op AbortError rejection — the in-flight
   * `listen()` is left to settle on its own bind outcome; see `close()`.)
   *
   * @param port - TCP port to bind. Use `0` to let the OS assign an ephemeral port.
   * @param hostOrOpts - Host string or object with `host` and optional `signal`.
   *   Default host: `'127.0.0.1'` (Phase 8 bind-safety hardening). Wildcard hosts
   *   are rejected unless `ServerOptions.allowWildcardBind: true` — literal
   *   spellings pre-bind, resolver-only shorthands post-bind via the
   *   OS-normalized bound address.
   *
   * @example
   * ```typescript
   * await server.listen(2575); // binds 127.0.0.1
   * await server.listen(0, '127.0.0.1');
   * await server.listen(0, { host: '127.0.0.1', signal: ac.signal });
   * ```
   */
  listen(
    port: number,
    hostOrOpts?: string | { host?: string; signal?: AbortSignal },
  ): Promise<void> {
    const host = typeof hostOrOpts === "string" ? hostOrOpts : (hostOrOpts?.host ?? "127.0.0.1");
    const signal =
      typeof hostOrOpts === "object" && hostOrOpts !== null ? hostOrOpts.signal : undefined;

    // AbortSignal: reject immediately if already aborted
    if (signal?.aborted) {
      return Promise.reject(new DOMException("Aborted", "AbortError"));
    }

    // Phase 8 bind safety — SINGLE-FLIGHT guard. Two concurrent listen()
    // calls on one server race each other's post-bind checks: the losing
    // call's 'listening' handler can observe the winner's (or a just-closed)
    // socket and record listening state for a bind that no longer exists —
    // a green health check with nothing bound. One listen per lifecycle;
    // close() before re-listening.
    if (this._listening || this._listenInFlight) {
      return Promise.reject(
        new MllpConnectionError(
          this._listening
            ? "listen() rejected: server is already listening — call close() before re-listening"
            : "listen() rejected: another listen() is already in flight on this server",
          {
            cause: new Error("listen already listening or in flight"),
            phase: "connect",
          },
        ),
      );
    }

    // Phase 8 bind safety, pre-bind FAST PATH: reject a literal wildcard
    // host BEFORE binding unless the operator explicitly opted in via
    // allowWildcardBind. isWildcardHost normalizes IP literals ('::0',
    // '0:0:0:0:0:0:0:0', '::ffff:0.0.0.0' …); getaddrinfo shorthands it
    // cannot see as strings ('0', '0x0.0.0.0', …) are caught by the
    // authoritative POST-BIND check in onListening below.
    if (isWildcardHost(host) && this._opts.allowWildcardBind !== true) {
      return Promise.reject(
        new MllpConnectionError(
          `refusing to bind wildcard host '${host}' — set ServerOptions.allowWildcardBind: true to bind all interfaces`,
          {
            cause: new Error("wildcard bind requires allowWildcardBind"),
            phase: "connect",
          },
        ),
      );
    }

    this._listenInFlight = true;

    return new Promise<void>((resolve, reject) => {
      // ONE idempotent settle point for every outcome of this listen()
      // (success, abort, close-during-listen, bind error, addr-null reject,
      // post-bind wildcard reject). First caller wins; every path gets the
      // same cleanup — abort listener, netServer listeners, the close()
      // settle hook, and the single-flight guard — so no path can leak a
      // listener, strand the guard, or re-settle a settled promise.
      let settled = false;
      const settle = (
        outcome: { ok: true } | { ok: false; error: Error },
        opts?: { closeServer?: boolean },
      ): void => {
        if (settled) return;
        settled = true;
        this._pendingListenSettle = null;
        signal?.removeEventListener("abort", abortHandler);
        this._netServer.removeListener("listening", onListening);
        this._netServer.removeListener("error", onError);
        if (opts?.closeServer === true) {
          this._netServer.close();
        }
        this._listenInFlight = false;
        if (outcome.ok) {
          resolve();
        } else {
          // Pass the rejection reason through untouched — AbortError
          // (DOMException), MllpConnectionError, and raw bind errors keep
          // their identity for callers matching on name/instanceof.
          reject(outcome.error);
        }
      };

      const abortHandler = () => {
        settle(
          { ok: false, error: new DOMException("Aborted", "AbortError") },
          {
            closeServer: true,
          },
        );
      };

      if (signal !== undefined) {
        signal.addEventListener("abort", abortHandler, { once: true });
      }

      // close() (or Symbol.asyncDispose) racing an in-flight listen():
      // net.Server.close() nulls the handle, and the pending 'listening'
      // emission is guarded on the handle — so NEITHER 'listening' NOR
      // 'error' ever fires for the in-flight bind. Without a settle path the
      // promise hangs forever and every later listen() rejects "in flight".
      // close() settles the pending listen PROACTIVELY through this hook.
      // (Deliberately NOT a netServer once('close') listener: the 'close'
      // event from a PREVIOUS lifecycle's close() is delivered
      // asynchronously and can land after a NEW listen() has registered its
      // listeners, spuriously rejecting the fresh attempt. The netServer is
      // private, so our own close() — and the settle paths below, which
      // settle themselves — are the only close initiators. close() itself
      // closes the netServer right after invoking this hook, so the hook
      // does not.)
      this._pendingListenSettle = () => {
        settle({
          ok: false,
          error: new MllpConnectionError(
            "listen() failed: server was closed while listen() was in flight",
            {
              cause: new Error("close() during in-flight listen()"),
              phase: "connect",
            },
          ),
        });
      };

      const onListening = () => {
        if (settled) return;
        // The bind outcome is now known and this handler settles the promise
        // synchronously below — drop the close()-settle hook AND the abort
        // listener FIRST. The hook: a close() called from inside the
        // 'listening' event handler must not reject a bind that succeeded.
        // The abort listener: the success path below emits 'listening' /
        // 'securityWarning' BEFORE settling, and an abort fired from inside
        // one of those handlers would otherwise close the just-bound server
        // AFTER listening state is recorded — stranding `listening: true`
        // with nothing bound (the exact hazard the post-bind checks exist to
        // prevent). Once the bind has succeeded, an abort of the listen
        // signal is too late and is deliberately ignored; use close().
        this._pendingListenSettle = null;
        signal?.removeEventListener("abort", abortHandler);

        const addr = this._netServer.address();
        // address() is always an AddressInfo object for a bound TCP server;
        // null (or a string — pipe/IPC servers, which this class never
        // creates) means the server was closed out from under this bind.
        // NEVER fall back to the requested port/host strings — that records
        // listening state for a bind that does not exist. The single-flight
        // guard above should make this branch unreachable; it stays as
        // defense-in-depth.
        if (addr === null || typeof addr === "string") {
          settle(
            {
              ok: false,
              error: new MllpConnectionError(
                "listen() failed: server was closed before the bind completed",
                {
                  cause: new Error("server.address() returned no TCP address"),
                  phase: "connect",
                },
              ),
            },
            { closeServer: true },
          );
          return;
        }
        const actualPort = addr.port;
        const actualHost = addr.address;

        // Phase 8 bind safety — POST-BIND enforcement against the
        // OS-NORMALIZED bound address. getaddrinfo/inet_aton resolves
        // shorthands the pre-bind string check cannot see ('0', '0.0',
        // '0.0.0', '00.0.0.0', '0x0.0.0.0', hostnames that resolve to the
        // unspecified address, …); the kernel-reported address is canonical
        // ('0.0.0.0' / '::'), so this check is authoritative. On violation:
        // close the just-bound server immediately and reject — no listening
        // state is recorded and no 'listening' event is emitted.
        // The sub-tick bind window is ACCEPT-SAFE — this handler runs
        // synchronously on 'listening', before the event loop can deliver
        // any 'connection'/'secureConnection' for the just-bound socket, so
        // no connection is ever accepted on a rejected wildcard bind. Do
        // not reorder or defer this branch.
        if (isWildcardHost(actualHost) && this._opts.allowWildcardBind !== true) {
          settle(
            {
              ok: false,
              error: new MllpConnectionError(
                `refusing to bind wildcard host '${host}' (bound address '${actualHost}') — ` +
                  "set ServerOptions.allowWildcardBind: true to bind all interfaces",
                {
                  cause: new Error("wildcard bind requires allowWildcardBind"),
                  phase: "connect",
                },
              ),
            },
            { closeServer: true },
          );
          return;
        }

        this._listening = true;
        this._port = actualPort;
        this._host = actualHost;

        // The bind has succeeded — nothing a 'listening'/'securityWarning'
        // subscriber does may undo that. A THROWING subscriber must not
        // strand the settle (the promise would hang and the single-flight
        // guard would wedge every later listen()) and must not suppress a
        // LATER emission: each emit is contained SEPARATELY (a throw in
        // 'listening' cannot swallow the securityWarning), surfaced via the
        // guarded 'error' tap (D-04 — a handler error never crashes the
        // server) with the tap itself contained too (a throwing 'error'
        // listener on top of a throwing subscriber drops rather than
        // strands), so listen() always resolves.
        const emitSubscriberSafe = (event: "listening" | "securityWarning", payload: unknown) => {
          try {
            this.emit(event, payload);
          } catch (subscriberErr: unknown) {
            try {
              this._emitErrorIfListened(
                subscriberErr instanceof Error ? subscriberErr : new Error(String(subscriberErr)),
              );
            } catch {
              // Double user bug ('listening'/'securityWarning' subscriber
              // threw AND the 'error' listener threw): dropping beats
              // stranding the settle or crashing a successfully-bound server.
            }
          }
        };

        // Phase 8 — loud, one-time notice when a wildcard host is actually
        // bound (keyed off the OS-normalized actualHost so shorthand
        // spellings warn too; single emission site). The operator channel
        // (process.emitWarning) fires FIRST — it has no subscribers, so no
        // throwing event listener can ever suppress the mandated
        // MLLP_BIND_ALL_INTERFACES notice on a live wildcard bind.
        const wildcardBound = isWildcardHost(actualHost);
        const wildcardMessage =
          `MLLP server is bound to ALL network interfaces (host='${actualHost}') — ` +
          "set a specific bind address unless this is intentional.";
        if (wildcardBound) {
          process.emitWarning(wildcardMessage, { code: MLLP_BIND_ALL_INTERFACES });
        }

        emitSubscriberSafe("listening", Object.freeze({ port: actualPort, host: actualHost }));

        if (wildcardBound) {
          const warning: SecurityWarning = Object.freeze({
            code: MLLP_BIND_ALL_INTERFACES,
            message: wildcardMessage,
            host: actualHost,
            port: actualPort,
            timestamp: new Date(),
          });
          emitSubscriberSafe("securityWarning", warning);
        }

        settle({ ok: true });
      };

      const onError = (err: Error) => {
        settle({ ok: false, error: err });
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
   * Calling `close()` while a `listen()` is still in flight proactively
   * settles that `listen()` with a typed `MllpConnectionError` rejection
   * and clears the single-flight guard — the server is immediately
   * re-listenable. `Symbol.asyncDispose` (which delegates here) is
   * therefore safe before `listen()` settles. **Qualification:** a
   * `close({ signal })` whose signal is **already aborted** rejects
   * immediately with `AbortError` and performs no work — it does NOT close
   * the server and does NOT settle the in-flight `listen()`, which simply
   * continues and settles on its own bind outcome.
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

    // Phase 8 — settle an in-flight listen() FIRST (typed rejection). A
    // close racing startup (SIGTERM handler, test teardown, an `await using`
    // scope exiting before listen() was awaited) would otherwise leave the
    // listen() promise hung forever: net.Server.close() nulls the handle and
    // the pending 'listening' emission is handle-guarded, so neither
    // 'listening' nor 'error' ever fires for the in-flight bind — and the
    // stuck single-flight guard would reject every later listen().
    this._pendingListenSettle?.();

    // Stop accepting new connections
    this._netServer.close();
    this._listening = false;

    // If no active connections, we're done — emit 'close' and resolve
    // No abort handler registered on this path — nothing to remove.
    if (this._connections.size === 0) {
      // Contained: a throwing 'close' subscriber must not reject close() nor skip its cleanup.
      this._emitContained("close", Object.freeze({}));
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
    // Emit 'close' after all connections have drained (SERVER-10: frozen payload). Contained.
    this._emitContained("close", Object.freeze({}));
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
      tls: this._isTls,
      tlsClientErrorsTotal: this._tlsClientErrorsTotal,
    };
  }

  /**
   * Emit on `'error'` only when a listener is attached — an unlistened
   * `EventEmitter` `'error'` emission throws (see the class JSDoc error
   * contract). The single guard shared by the optional-tap forwarding sites
   * in this class; the constructor's net.Server forwarder deliberately does
   * NOT use it (its while-serving branch re-emits unguarded to keep Node's
   * fail-loud convention).
   */
  /**
   * Emit a server event, containing a throwing subscriber.
   *
   * Every event this server emits is reachable from a callback we do not own — the `net.Server`
   * `'connection'` listener, the `tls.Server` `'tlsClientError'` listener, a socket's `'data'`
   * listener (via `Connection`), or the `catch` block of a `void`-ed async ACK task. A throwing
   * subscriber would therefore unwind into that callback and kill the process (or reject a void-ed
   * promise, which does the same and additionally skips the rest of the method).
   *
   * See `src/internal/safe-emit.ts` for the full rationale. The throw is re-surfaced on `'error'`.
   */
  private _emitContained(event: string, payload: unknown): void {
    safeEmit(this, event, payload, (err) => {
      this._emitErrorIfListened(err);
    });
  }

  private _emitErrorIfListened(errEvent: unknown): void {
    // Guards the unlistened case AND contains a throwing 'error' subscriber — see safe-emit.ts.
    safeEmitError(this, errEvent);
  }

  // ---------------------------------------------------------------------------
  // Private: per-socket setup
  // ---------------------------------------------------------------------------

  private _onSocketAccepted(socket: Socket | TLSSocket): void {
    // TCP keepalive — must be set on the raw socket BEFORE passing to NetTransport (D-10)
    if (this._opts.keepaliveIntervalMs !== undefined) {
      socket.setKeepAlive(true, this._opts.keepaliveIntervalMs);
    }

    const transport = this._isTls
      ? new TlsTransport(socket as TLSSocket)
      : new NetTransport(socket);
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
      this._emitErrorIfListened(errEvent);
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
        //
        // Contained: a `'message'` subscriber is an OBSERVER (a metrics tap, a logger). The ACK
        // decision belongs to the commit contract below — `ServerOptions.onMessage` is the
        // durable-commit step, not this event. An observer that throws must therefore not be able
        // to suppress the ACK: before containment, one broken logger silently turned every message
        // into a no-ACK, so every sender resent forever with nothing to diagnose it by. The throw
        // is surfaced on `'error'` instead, and the commit contract proceeds untouched.
        try {
          this.emit("message", Object.freeze({ payload, meta }));
        } catch (err) {
          this._emitErrorIfListened(
            Object.freeze({
              connectionId,
              error: err instanceof Error ? err : new Error(String(err)),
            }),
          );
        }

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

    // Phase 8 — surface a minimal, content-free peer-certificate summary
    // (WANT/MUST only) on the 'connection' event. Never the full cert object.
    const peerCertificate: PeerCertificateSummary | null =
      this._isTls && (this._opts.tls?.clientAuth ?? "NONE") !== "NONE"
        ? this._extractPeerCertificateSummary(socket as TLSSocket)
        : null;

    // Emit server-level 'connection' event with frozen payload.
    //
    // Contained: `_onSocketAccepted` runs inside the net.Server/tls.Server 'connection' listener,
    // so a throwing subscriber (an audit logger, an allow-list check) would kill the whole server
    // on the next accept.
    this._emitContained(
      "connection",
      Object.freeze({
        connectionId: conn.connectionId,
        remoteAddress: socket.remoteAddress ?? null,
        remotePort: socket.remotePort ?? null,
        peerCertificate,
      }),
    );
  }

  /**
   * Extract a minimal, content-free peer-certificate summary (Phase 8, ATNA
   * ITI-19 mutual authentication) — CN strings, expiry, and the verification
   * outcome (`authorized`) only; never the full certificate object. Returns
   * `null` when no peer certificate was presented (e.g. `clientAuth: 'WANT'`
   * with no client cert).
   */
  private _extractPeerCertificateSummary(socket: TLSSocket): PeerCertificateSummary | null {
    const cert = socket.getPeerCertificate();
    if (cert === undefined || cert === null || Object.keys(cert).length === 0) {
      return null;
    }
    const asCn = (value: string | string[] | undefined): string | null => {
      if (value === undefined) return null;
      return Array.isArray(value) ? (value[0] ?? null) : value;
    };
    return Object.freeze({
      subjectCN: asCn(cert.subject?.CN),
      issuerCN: asCn(cert.issuer?.CN),
      validTo: cert.valid_to ?? null,
      // Verification outcome — under 'WANT' a certificate can be present yet
      // UNVERIFIED (see PeerCertificateSummary.authorized JSDoc).
      authorized: socket.authorized === true,
    });
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
      //
      // CONTAINED, and this one is load-bearing. This emit sits inside a `catch` block of an
      // `async` method that the caller `void`s — so a throwing `'nack'` subscriber (a metrics tap,
      // an alerting hook) would (a) reject the void-ed promise → unhandled rejection → process
      // death, and (b) skip the `_dispatchAck` below, so **the negative ACK would never be sent**.
      // The sender would be left waiting on an acknowledgement for a message the server had already
      // failed to commit. A broken metrics tap must never be able to suppress the fail-safe ACK.
      this._emitContained(
        "nack",
        Object.freeze({ connectionId: conn.connectionId, ackCode: nack }),
      );
    }

    // Unconditional: reached whether the handler committed or threw, and no subscriber can skip it.
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
        // safeEmitError, not conn.emit: a raw emit bypasses Connection's containment, so an
        // unlistened or throwing 'error' subscriber would unwind into this void-ed async task
        // (unhandled rejection → process death).
        safeEmitError(conn, Object.freeze({ connectionId: conn.connectionId, error: connErr }));
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
      // See above — never a raw conn.emit from inside a callback/async catch.
      safeEmitError(conn, Object.freeze({ connectionId: conn.connectionId, error: connErr }));
    }
  }

  /**
   * Frame an ACK payload and write it to the connection. `Connection.send()` returns
   * `false` under backpressure (socket write buffer full); that drops the ACK and emits
   * a `MllpConnectionError({ phase: 'send' })` on the connection (D-04) — the peer will
   * time out waiting and may retry. The server never crashes.
   */
  private _dispatchAck(conn: Connection, ackPayload: Buffer): void {
    // TOTAL by contract: this is reached from `void`-ed async tasks (`_sendCommitAck`, the
    // transport-accept branch), so a throw here becomes an **unhandled rejection that kills the
    // process** — and it would do so on peer-controlled input. `encodeFrame` is strict and throws
    // `MLLP_PAYLOAD_CONTAINS_VT`/`_FS` if the ACK payload contains a framing byte.
    //
    // On the auto-ACK path this is **hard to provoke, but not impossible, and the containment is
    // what makes that safe.** `buildRawAck` decodes and encodes as `latin1`, a 1:1 byte↔code-unit
    // map, so it cannot *synthesize* a framing byte the way `ascii` masking once did
    // (`0x8B & 0x7F` = VT — the Phase 10 bug): it only ever echoes bytes that were already in the
    // inbound. A delivered payload never contains a VT (`FrameReader` discards its accumulator on a
    // mid-payload VT — `MLLP_TRAILING_BYTES`), so an echoed VT is not a concern here. It CAN,
    // however, contain an FS: under the `allowMissingLeadingVt` tolerance a non-VT, non-whitespace
    // first byte becomes payload byte 0, and FS (0x1C) qualifies — so an FS echoed out of MSH-10
    // into MSA-2 reaches this `encodeFrame`, which throws `MLLP_PAYLOAD_CONTAINS_FS`. (Those codes
    // are thrown by `encodeFrame`, on the way out; the decoder never emits them.) And a caller's
    // `autoAck: fn` can of course return arbitrary bytes.
    //
    // Whichever route, defending the process must not depend on the caller's — or the peer's —
    // discipline. A build/frame failure is surfaced as a connection `'error'` and the message goes
    // un-ACKed (fail-safe: better an un-ACKed message the sender will resend than a dead server),
    // never as a process kill.
    let framed: Buffer;
    try {
      framed = encodeFrame(ackPayload);
    } catch (err: unknown) {
      const cause = err instanceof Error ? err : new Error(String(err));
      safeEmitError(
        conn,
        Object.freeze({
          connectionId: conn.connectionId,
          error: new MllpConnectionError("ACK could not be framed", { cause, phase: "send" }),
        }),
      );
      return;
    }

    const sent = conn.send(framed);
    if (!sent) {
      safeEmitError(
        conn,
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

  await server.listen(opts.port, opts.host ?? "127.0.0.1");
  return server;
}
