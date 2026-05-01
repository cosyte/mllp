# Phase 5: MLLP Client - Pattern Map

**Mapped:** 2026-04-30
**Files analyzed:** 6 (5 new, 1 modified for cause-code addition, 1 modified for barrel exports)
**Analogs found:** 6 / 6

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/client/client.ts` (NEW) | EventEmitter monolith — `MllpClient` class + `createClient` + `createStarterClient` | event-driven (lifecycle) + request-response (send/ack) | `src/server/server.ts` | exact (D-01 explicitly mirrors Phase 4 D-01) |
| `src/client/correlator.ts` (NEW) | data-structure / utility — pure ACK matcher (Map + graveyard, no I/O, no FSM) | transform / pub-sub (insertion-ordered Map walk) | `src/framing/decoder.ts` (closest pure stateful module with timer-free invariants) | role-match (no exact analog — phase introduces this concern) |
| `src/client/error.ts` (NEW) | typed error module — `MllpTimeoutError`, `MllpBackpressureError`, `isTransientConnectionError` | n/a (declarative) | `src/connection/error.ts` (cause-coded typed Error class) + `src/framing/error.ts` (code-tagged typed Error class) | exact |
| `src/client/index.ts` (NEW) | barrel re-export | n/a | `src/connection/index.ts` (multi-file barrel) and `src/server/index.ts` (single-file barrel) | exact |
| `src/index.ts` (MODIFIED) | top-level package barrel | n/a | itself (lines 38-47 — Phase 4 server export block) | exact |
| `src/connection/error.ts` (MODIFIED) | cause-code union extension — adds `'in-flight-orphan'` value to a stable code set | n/a | `src/framing/registry.ts` (`WarningCode` stable-union pattern) | exact |

## Pattern Assignments

### `src/client/client.ts` (EventEmitter monolith)

**Analog:** `src/server/server.ts`

**File-header JSDoc + @example** (lines 1-21):
```typescript
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
```
**Apply:** Open `client.ts` with the same shape — north-star three-line `@example` (`await using c = createStarterClient({ host, port }); const ack = await c.send(buf);` per CONTEXT specifics).

**Imports block** (lines 23-31):
```typescript
import { createServer as netCreateServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Connection } from '../connection/index.js';
import { MllpConnectionError } from '../connection/index.js';
import { NetTransport } from '../transport/index.js';
import { encodeFrame } from '../framing/index.js';
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';
```
**Apply:** Use exactly these path aliases (`../connection/index.js`, `../transport/index.js`, `../framing/index.js`) and `.js` extensions (ESM-compatible). Phase 5 adds `import { createConnection } from 'node:net'` (client side initiates connection) and pulls `Correlator` from `./correlator.js`, errors from `./error.js`.

**Public-API frozen `MessageMeta` interface** (lines 45-52) — cloneable for **`AckMeta`** / **`ClientStats`** shapes:
```typescript
export interface MessageMeta {
  /** Stable UUID identifying the connection that delivered this message. */
  readonly connectionId: string;
  /** Byte offset of the frame start in the connection's data stream. */
  readonly byteOffset: number;
  /** Framing warnings emitted during decoding of this frame. */
  readonly warnings: readonly MllpWarning[];
}
```
**Apply:** All public payload interfaces use `readonly` on every property. The matching object `Object.freeze`'d at emission (D-25). Use this shape for `'ack'` event payload `{ payload: Buffer, controlId: string | null, latencyMs: number }`.

**Stats interface** (lines 66-88) — JSON-serializable, no Buffers/class instances:
```typescript
export interface ServerStats {
  readonly listening: boolean;
  readonly port: number | null;
  readonly host: string | null;
  readonly connections: number;
  readonly activeConnections: number;
  readonly totalBytesIn: number;
  readonly totalBytesOut: number;
  readonly acceptedTotal: number;
  readonly closedTotal: number;
}
```
**Apply:** `ClientStats` (D-26) follows the same shape rules — every field readonly, every value JSON-serializable, no `Date` (use epoch number for `lastConnectedAt: number | null` per CONTEXT D-26).

**Class skeleton + private fields with `_`-prefix + `readonly`** (lines 237-260):
```typescript
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
    this._netServer.on('connection', (socket: Socket) => { this._onSocketAccepted(socket); });
    this._netServer.on('error', (err: Error) => { this.emit('error', err); });
  }
```
**Apply:** `MllpClient` extends `EventEmitter`, holds `_connection: Connection | null`, `_correlator: Correlator`, `_attempt`, `_lastSuccessAt`, `_keepaliveTimer`, `_deadPeerTimer`, `_opts: ClientOptions`. Same `_`-prefix + `readonly` discipline. Wire connection events in a private `_attachConnection(conn)` method (mirror of `_onSocketAccepted`).

**Frozen-payload emit pattern** (lines 316, 365, 397, 645-646, 660-668) — mandatory for every public event:
```typescript
this.emit('listening', Object.freeze({ port: actualPort, host: actualHost }));
this.emit('close', Object.freeze({}));
const frozenEvent = Object.freeze({ payload, meta });
this.emit('message', frozenEvent);
this.emit(
  'connection',
  Object.freeze({
    connectionId: conn.connectionId,
    remoteAddress: socket.remoteAddress ?? null,
    remotePort: socket.remotePort ?? null,
  }),
);
```
**Apply:** Every `MllpClient.emit(...)` call wraps payload in `Object.freeze({...})`. Events list per D-25: `'connect'`, `'reconnecting'`, `'disconnect'`, `'close'`, `'error'`, `'drain'`, `'stateChange'`, `'warning'`, `'message'`, `'ack'`. The `RetryContext` passed to `retryStrategy` is also frozen (D-15) — same `Object.freeze` call before passing.

**AbortSignal cancellation in promise-returning methods** (lines 278-330):
```typescript
listen(port: number, hostOrOpts?: string | { host?: string; signal?: AbortSignal }): Promise<void> {
  // ...
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'));
  }
  return new Promise<void>((resolve, reject) => {
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      this._netServer.close();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    if (signal !== undefined) {
      signal.addEventListener('abort', abortHandler, { once: true });
    }
    const onListening = () => {
      if (aborted) return;
      signal?.removeEventListener('abort', abortHandler);
      // ...resolve(...)
    };
    // ...
  });
}
```
**Apply:** `MllpClient.connect(opts?: { signal?: AbortSignal })` and `MllpClient.send(buf, opts?: { signal?: AbortSignal })` follow this exact pattern: pre-check `signal?.aborted`, register `abort` listener with `{ once: true }`, always call `removeEventListener` in success/error paths. `DOMException('Aborted', 'AbortError')` is the canonical rejection.

**Symbol.asyncDispose delegation** (lines 442-444):
```typescript
async [Symbol.asyncDispose](): Promise<void> {
  return this.close();
}
```
**Apply:** Identical signature on `MllpClient`. Required for `await using` north-star ergonomics.

**`getStats()` aggregation pattern** (lines 458-478):
```typescript
getStats(): ServerStats {
  let totalBytesIn = 0;
  let totalBytesOut = 0;
  for (const conn of this._connections) {
    const s = conn.getStats();
    totalBytesIn += s.bytesIn;
    totalBytesOut += s.bytesOut;
  }
  return {
    listening: this._listening,
    // ...flat object, no Buffers/class instances
  };
}
```
**Apply:** `client.getStats()` reads `_connection?.getStats()` if non-null, threads `bytesIn/bytesOut` into `totalBytesIn/totalBytesOut`. Pulls `queueDepth`, `queueBytes`, `inFlight` from `_correlator.getStats()` (correlator is a pure data structure — exposes plain getters). All `warningsByCode` flattened to `Record<WarningCode, number>` (mirrors `Connection._warningsByCode` Map → flat object pattern at server.ts:418-420 inside Connection).

**`// Phase 6:` seam comment for TLS** (line 566):
```typescript
// Phase 6: wire TlsTransport here when opts.tls is provided
const transport = new NetTransport(socket);
```
**Apply:** Verbatim mirror in `createClient`/`MllpClient._buildTransport()`. CONTEXT D-02 explicitly requires this seam.

**Auto-`'error'` listener hygiene to prevent ERR_UNHANDLED_ERROR** (lines 583-589):
```typescript
conn.on('error', (errEvent: unknown) => {
  if (this.listenerCount('error') > 0) {
    this.emit('error', errEvent);
  }
});
```
**Apply:** `MllpClient` re-emits `Connection`'s `'error'` events the same way — guarded on listenerCount so unhandled `'error'` doesn't crash the process. Same for `'warning'` re-emission (Connection layer already enriches with `connectionId`).

**Dead-peer + keepalive timer wiring** (lines 561-564, 609-628) — direct CONTEXT D-11 mirror:
```typescript
// TCP keepalive — must be set on the raw socket BEFORE passing to NetTransport (D-10)
if (this._opts.keepaliveIntervalMs !== undefined) {
  socket.setKeepAlive(true, this._opts.keepaliveIntervalMs);
}
// ...
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
  conn.once('close', () => { clearTimeout(deadPeerTimer); });
}
```
**Apply:** Phase 5 D-11/D-13/D-14 require:
- Keepalive set on the raw `net.Socket` BEFORE `new NetTransport(socket)` (server precedent).
- Dead-peer timer reset on `'message'` AND `'ack'` AND `'warning'` events (D-11 says "last bytes/ACK received"). Server resets only on `'message'`.
- Both timers `.unref()`'d so process can exit cleanly.
- Both cleared on FSM transitions out of `CONNECTED` (D-14) — subscribe to `connection.on('stateChange', ...)`.
- Phase 5 routes timeout via FSM (`autoReconnect` rule) — server unconditionally `destroy`s. Use `conn.destroy(new Error('dead peer timeout'))` to surface `MllpConnectionError({ phase: 'receive' })` per Phase 3 `_onTransportError`.

**Starter factory pattern** (lines 769-800):
```typescript
export async function createStarterServer(opts: StarterServerOptions): Promise<MllpServer> {
  const server = createServer({
    ...opts,
    autoAck: opts.autoAck ?? 'AA',
    drainTimeoutMs: opts.drainTimeoutMs ?? 30_000,
  });
  if (opts.handleSignals === true) {
    const sigHandler = (): void => {
      void server.close().then(() => process.exit(0)).catch(() => process.exit(1));
    };
    process.once('SIGTERM', sigHandler);
    process.once('SIGINT', sigHandler);
    server.once('close', () => {
      process.removeListener('SIGTERM', sigHandler);
      process.removeListener('SIGINT', sigHandler);
    });
  }
  await server.listen(opts.port, opts.host ?? '0.0.0.0');
  return server;
}
```
**Apply:** `createStarterClient` mirrors exactly per CONTEXT D-22: defaults `autoReconnect: true`, `ackTimeoutMs: 30_000`, `correlateByControlId: false`, `pipeline: true`, `highWaterMark: 64`, `onBackpressure: 'reject'`, `handleSignals: false`. Calls `await client.connect()` before returning. JSDoc `@example` MUST contain the three-line north-star (`await using c = createStarterClient({ host: 'localhost', port: 2575 }); const ack = await c.send(payloadBuffer);`) per CONTEXT specifics.

**Backpressure / boolean-return error propagation** (lines 700-715):
```typescript
const sent = conn.send(encodeFrame(ackPayload));
if (!sent) {
  conn.emit(
    'error',
    Object.freeze({
      connectionId: conn.connectionId,
      error: new MllpConnectionError('auto-ACK dropped: socket backpressure', {
        cause: new Error('backpressure'),
        phase: 'send',
      }),
    }),
  );
}
```
**Apply:** Phase 5 distinguishes from this server pattern — client uses `MllpBackpressureError` (NOT `MllpConnectionError({phase:'send'})`) when the high-water mark is hit. The boolean return from `connection.send()` is still checked, but client backpressure is enforced at the correlator-queue level (count + bytes) BEFORE the write, not at socket-buffer level.

---

### `src/client/correlator.ts` (pure data structure)

**Analog:** No exact match. Closest mental model: `src/framing/decoder.ts` `FrameReader` class (pure stateful, timer-free, no I/O, no FSM, deterministic, unit-testable in isolation).

**File-header JSDoc** (decoder.ts lines 1-23):
```typescript
/**
 * MLLP frame decoder — stateful 3-state FSM for chunked byte-stream parsing.
 *
 * @example
 * ```typescript
 * import { FrameReader } from '@cosyte/hl7-mllp';
 * const reader = new FrameReader({
 *   onFrame: (payload) => handleMessage(payload),
 *   onWarning: (w) => logger.warn(w),
 *   allowFsOnly: true,
 * });
 * socket.on('data', (chunk) => reader.push(chunk));
 * ```
 *
 * @packageDocumentation
 */
```
**Apply:** `correlator.ts` opens with similar pure-stateful framing. Document that it knows nothing about `Connection`, `EventEmitter`, sockets, or timers — it's a Map + helper methods + a graveyard Map. `enqueue(frame, controlId)`, `matchAck(payload)`, `expireDue(now)`, `evictGraveyardDue(now)`, `getStats()`. **Internal API** — not re-exported from `src/index.ts`.

**Options interface (callback-bag style for INTERNAL injection points)** (decoder.ts lines 55-102):
```typescript
export interface FrameReaderOptions {
  onFrame: (payload: Buffer, byteOffset: number, warnings: readonly MllpWarning[]) => void;
  onWarning?: (w: MllpWarning) => void;
  maxFrameSizeBytes?: number;
  // ... tolerance flags
}
```
**Apply:** `CorrelatorOptions` exposes `ackTimeoutMs`, `mode: 'fifo' | 'controlId'`, `maxInFlight: number` (1 for `pipeline:false`), `highWaterMarkCount`, `highWaterMarkBytes`, `onTimeout: (key, controlId) => void` (callback-bag, internal — fires when sweep tick finds a stale entry), `now: () => number` (injected so tests can drive deterministic time). Per CONTEXT D-03 this is ~200-250 LOC, ONE file.

**Private fields, `readonly` discipline** (decoder.ts lines 122-148):
```typescript
export class FrameReader {
  private readonly _opts: FrameReaderOptions;
  private readonly _maxFrameSize: number;
  private _state: ReaderState = 'SCANNING_FOR_VT';
  private _accumulator: Buffer = Buffer.allocUnsafe(INITIAL_ACCUMULATOR_SIZE);
  private _writePos = 0;
  private _byteOffset = 0;
  // ...
}
```
**Apply:** `Correlator` has `_pending: Map<correlationKey, PendingAck>` (insertion-ordered iteration is the contract per D-03), `_graveyard: Map<correlationKey, GraveyardEntry>`, `_queueBytes`, `_sendSeq`, `_opts`. All `_`-prefixed; immutable references `readonly`.

**`PendingAck` row shape** — apply CONTEXT D-03 (`{ frame: Buffer, controlId: string | null, sentAt: number, resolve, reject, byteCount }`). Each row holds the `resolve` / `reject` of the `send()` promise. `Buffer` field uses `.subarray()` not `.slice()` if any extraction needed (SETUP-07 — `src/client/` is in scope).

**Stable warning-code emission via callback** (decoder.ts lines 207-216):
```typescript
if (this._wsCount > 0) {
  this._emitWarning(
    'MLLP_LEADING_WHITESPACE',
    this._wsStart,
    `${this._wsCount} leading whitespace byte(s) before VT at offset ${this._wsStart}`,
  );
}
```
**Apply:** `Correlator` uses the same code-tagged warning surface for `MLLP_ACK_AFTER_TIMEOUT` (CLIENT-16, D-04 graveyard hit) and `MLLP_ACK_UNMATCHED_CONTROL_ID` (CLIENT-15, D-05 unmatched live + graveyard). Codes already in `WarningCode` union (registry.ts lines 27-38). Emission goes via the `onWarning` injected callback; `MllpClient` re-emits to its `'warning'` EventEmitter event with a `Object.freeze`'d enriched payload (mirrors `Connection._onFramingWarning` at connection.ts:507-532).

---

### `src/client/error.ts` (typed errors + classifier)

**Analog:** `src/connection/error.ts` (cause + phase pattern) AND `src/framing/error.ts` (code-tagged pattern).

**`MllpConnectionError` shape** (connection/error.ts lines 48-68):
```typescript
export class MllpConnectionError extends Error {
  override readonly name = 'MllpConnectionError' as const;
  override readonly cause: Error;
  readonly phase: ConnectionErrorPhase;

  constructor(
    message: string,
    opts: { cause: Error; phase: ConnectionErrorPhase },
  ) {
    super(message);
    this.cause = opts.cause;
    this.phase = opts.phase;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, MllpConnectionError);
    }
  }
}
```
**Apply (`MllpTimeoutError`):** Same shape. Constructor `(message, opts: { controlId: string | null; ackTimeoutMs: number; sentAt: number })`. Public readonly fields: `controlId`, `ackTimeoutMs`, `sentAt`, `cause?: Error`. `name = 'MllpTimeoutError' as const`. `Error.captureStackTrace`.

**Apply (`MllpBackpressureError`):** Same shape. Public readonly fields: `queueDepth: number`, `queueBytes: number`, `highWaterMark: { count?: number; bytes?: number }`. `name = 'MllpBackpressureError' as const`.

**Stable code/phase union pattern** (connection/error.ts lines 26-31, framing/registry.ts lines 27-38):
```typescript
export type ConnectionErrorPhase =
  | 'connect'
  | 'send'
  | 'receive'
  | 'close'
  | 'reconnect';
```
**Apply (CONTEXT D-09):** A new exported `ConnectionErrorCause` union (or extension of an existing one) goes in `src/connection/error.ts` (modified file):
```typescript
export type ConnectionErrorCause =
  | 'fifo-unsafe'
  | 'in-flight-orphan';   // D-09 — new stable code, public API
```
JSDoc on the union must explicitly state "stable public API; renaming or removing a member is a breaking change" (mirrors `WarningCode` registry comment at registry.ts:21-22). Plumb the new optional `cause: ConnectionErrorCause` field into `MllpConnectionError`'s constructor opts (additive, non-breaking — see "Cross-File Plumbing" below).

**`isTransientConnectionError(err)` classifier** — exported function, no analog in codebase. Implementation per CONTEXT specifics:
```typescript
export function isTransientConnectionError(err: unknown): boolean {
  if (!(err instanceof Error)) return true;
  const code = (err as { code?: string }).code;
  switch (code) {
    case 'ENOTFOUND':
    case 'EACCES':
      return false;
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'EPIPE':
      return true;
    default:
      // TLS cert errors → permanent. Default → transient.
      if (typeof code === 'string' && code.startsWith('CERT_')) return false;
      return true;
  }
}
```
JSDoc + `@example` per project guardrail. Used internally by `MllpClient` reconnect FSM (Composition A, D-16) and re-exported via barrel.

---

### `src/client/index.ts` (barrel)

**Analog:** `src/connection/index.ts` (multi-file barrel — closest match since Phase 5 has 3 source files like Phase 3).

**Connection barrel** (full file, 16 lines):
```typescript
/**
 * Connection module — 6-state FSM over a Transport with lifecycle events,
 * per-connection warning streams, and `getStats()` observability.
 *
 * @packageDocumentation
 */

export {
  Connection,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionStats,
  type StateChangeEvent,
  type ReconnectingEvent,
} from './connection.js';
export { MllpConnectionError, type ConnectionErrorPhase } from './error.js';
```
**Apply:** `src/client/index.ts` opens with a 4-line `@packageDocumentation` JSDoc, then re-exports:
```typescript
export {
  MllpClient,
  createClient,
  createStarterClient,
  type ClientOptions,
  type StarterClientOptions,
  type ClientStats,
  type RetryContext,
  type RetryStrategy,
} from './client.js';
export {
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
} from './error.js';
```
**Do NOT** export `Correlator` — it is internal (CONTEXT code_context: "Callback-bag pattern for INTERNAL interfaces").

---

### `src/index.ts` (top-level barrel — MODIFIED)

**Analog:** itself. Phase 4 server export block (lines 38-47) is the template:
```typescript
// Phase 4: server
export {
  MllpServer,
  createServer,
  createStarterServer,
  type ServerOptions,
  type StarterServerOptions,
  type ServerStats,
  type MessageMeta,
} from './server/index.js';
```
**Apply:** Append a `// Phase 5: client` block matching this exactly. Per CONTEXT D-21:
```typescript
// Phase 5: client
export {
  MllpClient,
  createClient,
  createStarterClient,
  type ClientOptions,
  type StarterClientOptions,
  type ClientStats,
  type RetryContext,
  type RetryStrategy,
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
} from './client/index.js';
```
Also: if `ConnectionErrorCause` is added (D-09 plumbing), export it from the existing Phase 3 export block:
```typescript
export {
  Connection,
  // ...existing...
  MllpConnectionError,
  type ConnectionErrorPhase,
  type ConnectionErrorCause,   // NEW (D-09)
} from './connection/index.js';
```

---

### `src/connection/error.ts` (MODIFIED — D-09 cause-code addition)

**Analog:** itself, plus `src/framing/registry.ts` for the stable-union pattern.

**Reference pattern: `WarningCode` union** (framing/registry.ts lines 16-38):
```typescript
/**
 * Union of all stable MLLP warning codes.
 *
 * These codes are a **public API** — they appear in `onWarning` handlers, log pipelines,
 * monitoring dashboards, and error messages. Renaming is a breaking change.
 */
export type WarningCode =
  | 'MLLP_MISSING_LEADING_VT'
  | 'MLLP_FS_WITHOUT_CR'
  // ...
  | 'MLLP_ACK_AFTER_TIMEOUT';
```
**Apply (D-09):**
1. Add a new exported `ConnectionErrorCause` union to `src/connection/error.ts` with the same "stable public API" JSDoc warning. Initial members: `'fifo-unsafe'`, `'in-flight-orphan'`. (Existing FIFO-unsafe is already passed as `cause: new Error('fifo-unsafe')` per current Phase 3 code — Plan should choose: either keep the loose `Error` cause + add a separate `ConnectionErrorCause` field, OR refactor `cause` into `Error` while adding a new typed `connectionCause: ConnectionErrorCause` field. CONTEXT D-09 implies the latter. Coordinate with planner.)
2. Re-export `ConnectionErrorCause` from `src/connection/index.ts` (mirror existing `ConnectionErrorPhase` re-export at line 16) and from `src/index.ts`.
3. Update `MllpConnectionError` constructor to accept `connectionCause?: ConnectionErrorCause` (additive, non-breaking).

---

## Shared Patterns

### Frozen Event Payloads (mandatory for every `emit`)
**Source:** `src/server/server.ts` (lines 316, 365, 397, 645-646, 661-668), `src/connection/connection.ts` (lines 281, 448-462, 502, 509)
**Apply to:** Every `MllpClient.emit(...)` call site. NEVER emit a non-frozen object. Subscribers cannot mutate shared state (CLAUDE.md guardrail).
```typescript
this.emit('connect', Object.freeze({ connectionId: this.connectionId }));
this.emit('stateChange', Object.freeze({ from, to, reason }));
```

### Buffer.subarray() (NEVER `.slice()`)
**Source:** ESLint config `eslint.config.js` (SETUP-07 rule, errors on `Buffer.prototype.slice` calls in `src/framing|server|client`)
**Apply to:** Every Buffer extraction in `src/client/`. Frame slicing, payload copying, snippet capture — all `.subarray()`.
```typescript
// connection.ts:489 — error snippet pattern
new MllpConnectionError(err.message, { cause: err, phase });
// framing/error.ts:64 — copy out of zero-copy view
this.snippet = Buffer.from(snippet.subarray(0, MAX_SNIPPET_BYTES));
```

### No `console.*` in library code
**Source:** CLAUDE.md guardrail; verified absent across `src/server/server.ts`, `src/connection/connection.ts`, `src/framing/decoder.ts`
**Apply to:** All client files. Surface problems via:
- Throw a typed error (`MllpTimeoutError`, `MllpBackpressureError`, `MllpConnectionError`).
- Emit `'error'` event with frozen `{ connectionId, error }` payload (server precedent at server.ts:585-589).
- Emit `'warning'` event with stable `WarningCode` (decoder precedent at decoder.ts:207-216).

### JSDoc + `@example` on every public export
**Source:** Every public export in `src/server/server.ts`, `src/connection/connection.ts`, `src/framing/decoder.ts` carries a JSDoc block with at least one `@example`.
**Apply to:** All `MllpClient` public methods (`connect`, `send`, `close`, `getStats`, `[Symbol.asyncDispose]`), all factory functions (`createClient`, `createStarterClient`), all interfaces (`ClientOptions`, `StarterClientOptions`, `ClientStats`, `RetryContext`), all error classes. CONTEXT specifics requires the three-line north-star example on `createStarterClient`.

### `unknown`/narrow casts; no `any`
**Source:** `src/server/server.ts` line 585 (`(errEvent: unknown)`) and line 716 (`} catch (err: unknown)`), connection.ts line 482-487 narrowing pattern.
**Apply to:** All `catch` blocks use `unknown`; narrow with `instanceof Error` or `(err as { code?: string }).code` (one-line `as` for known property shape — justified). No `any` anywhere (CLAUDE.md guardrail).

### Stable warning + cause codes are public API
**Source:** `src/framing/registry.ts` lines 16-38 — `WarningCode` union JSDoc explicitly says renaming is breaking. `src/connection/error.ts` lines 26-31 — `ConnectionErrorPhase` union with same stability contract.
**Apply to:** `'in-flight-orphan'` (D-09) added to a new `ConnectionErrorCause` union with identical JSDoc stability warning. Phase 5 introduces NO new warning codes — `MLLP_ACK_UNMATCHED_CONTROL_ID` and `MLLP_ACK_AFTER_TIMEOUT` already exist in the union.

### `Symbol.asyncDispose` on every closeable
**Source:** `src/server/server.ts` lines 442-444; CLAUDE.md "every closeable" guardrail.
**Apply to:** `MllpClient` exposes `async [Symbol.asyncDispose](): Promise<void> { return this.close(); }`. Required for the three-line north-star (`await using c = createStarterClient(...)`).

### `AbortSignal` on every awaitable
**Source:** `src/server/server.ts` lines 278-330 (listen), 350-398 (close).
**Apply to:** `client.connect({ signal? })`, `client.send(buf, { signal? })`, `client.close({ signal?, drainTimeoutMs? })`. Same DOMException AbortError pattern.

### Buffer-first API (never string)
**Source:** Every public boundary in this codebase passes `Buffer` not `string`.
**Apply to:** `client.send(payload: Buffer): Promise<Buffer>` (per CONTEXT Claude's Discretion last bullet — return type aligns with ROADMAP SC-1). The `'message'` and `'ack'` event payloads expose `payload: Buffer`. Stripped framing — caller manages charset decoding.

### Set-once timer cleanup on FSM exit
**Source:** `src/server/server.ts` lines 624-628 (clearTimeout on conn close).
**Apply to:** D-14 — every timer (keepalive socket-level + dead-peer + ACK sweep) MUST be cleared on every transition out of `CONNECTED`. Re-armed on entry to `CONNECTED`. Use `connection.on('stateChange', ({ from, to }) => { if (from === 'CONNECTED' && to !== 'CONNECTED') clearAllTimers(); })`.

### `getStats()` returns plain JSON-serializable objects
**Source:** `src/server/server.ts` lines 458-478, `src/connection/connection.ts` lines 416-434.
**Apply to:** D-26 `ClientStats` shape. No Buffers, no class instances, no Maps. Convert internal `Map<string, number>` to `Record<WarningCode, number>` exactly like `Connection.getStats()` at connection.ts:417-420.

---

## Cross-File Plumbing for D-09 (`'in-flight-orphan'`)

The new cause code is a coordinated edit across multiple files. Planner should sequence these in dependency order:

1. `src/connection/error.ts` — add `ConnectionErrorCause` union; extend `MllpConnectionError` constructor with optional `connectionCause` field; JSDoc the stability contract.
2. `src/connection/index.ts` — add `type ConnectionErrorCause` to the `error.js` re-export line.
3. `src/index.ts` — add `type ConnectionErrorCause` to the Phase 3 export block.
4. `src/client/client.ts` — at the FIFO reconnect-rejection site (CLIENT-17 + D-08 in-flight branch), call `pending.reject(new MllpConnectionError(msg, { cause: <Error>, phase: 'reconnect', connectionCause: 'in-flight-orphan' }))`. Existing FIFO queued-side keeps `connectionCause: 'fifo-unsafe'`.

## No Analog Found

No files in this phase lack a pattern source. Every new file maps to an existing analog in this codebase or to a directly applicable shared pattern.

## Metadata

**Analog search scope:** `src/server/`, `src/connection/`, `src/framing/`, `src/transport/`, `src/index.ts`, `eslint.config.js`
**Files scanned:** 11 (server.ts, connection.ts, connection/error.ts, framing/decoder.ts, framing/error.ts, framing/registry.ts, framing/index.ts, transport/net-transport.ts, transport/index.ts, src/index.ts, server/index.ts, connection/index.ts)
**Files in `src/client/`:** 0 (directory empty — confirmed)
**Pattern extraction date:** 2026-04-30
