# Phase 4: MLLP Server - Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 3 (src/server/server.ts, src/server/index.ts, src/index.ts)
**Analogs found:** 3 / 3

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src/server/server.ts` | service + provider | event-driven, request-response | `src/connection/connection.ts` | exact (EventEmitter class, FSM, frozen events, getStats, beforeClose hook) |
| `src/server/index.ts` | barrel / config | — | `src/connection/index.ts` | exact (barrel re-export pattern) |
| `src/index.ts` | barrel / config | — | `src/index.ts` (current) | exact (append new phase block) |

---

## Pattern Assignments

### `src/server/server.ts` (service, event-driven + request-response)

**Analog:** `src/connection/connection.ts`

**Imports pattern** (connection.ts lines 21-27):
```typescript
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { Transport } from '../transport/index.js';
import { FrameReader } from '../framing/index.js';
import type { FrameReaderOptions, MllpWarning } from '../framing/index.js';
import { MllpConnectionError } from './error.js';
import type { ConnectionErrorPhase } from './error.js';
```

Server adds `net` for the TCP listener:
```typescript
import { createServer as netCreateServer } from 'node:net';
import type { Server as NetServer, Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { Connection } from '../connection/index.js';
import { NetTransport } from '../transport/index.js';
import type { FrameReaderOptions } from '../framing/index.js';
import { MllpConnectionError } from '../connection/index.js';
```

**Class declaration + EventEmitter extension** (connection.ts line 173):
```typescript
export class Connection extends EventEmitter {
  readonly connectionId: string;
  private _state: ConnectionState = 'CONNECTING';
  // ...
```

Server follows the same pattern:
```typescript
export class MllpServer extends EventEmitter {
  private readonly _netServer: NetServer;
  private readonly _connections: Set<Connection> = new Set();
  private _listening = false;
  // ...
```

**Options interface with JSDoc + @example** (connection.ts lines 109-128):
```typescript
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
  transport: Transport;
  onMessage?: (payload: Buffer) => void;
  onWarning?: (w: MllpWarning) => void;
  drainTimeoutMs?: number;
  framing?: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'>;
}
```

`ServerOptions` follows the same JSDoc + `@example` pattern with server-specific fields.

**Frozen event payload emission** (connection.ts lines 281-282, 454-462):
```typescript
// Single-property freeze:
this.emit('connect', Object.freeze({ connectionId: this.connectionId }));

// Multi-property freeze with conditional reason:
const event = Object.freeze<StateChangeEvent>(
  reason !== undefined ? { from, to, reason } : { from, to },
);
this.emit('stateChange', event);

// Semantic lifecycle events always freeze:
if (to === 'DISCONNECTED') {
  this.emit('disconnect', Object.freeze({ connectionId: this.connectionId }));
}
if (to === 'CLOSED') {
  this.emit('close', Object.freeze({ connectionId: this.connectionId }));
}
```

Server uses the same freeze-before-emit pattern for all events:
- `'listening'` → `Object.freeze({ port, host })`
- `'connection'` → `Object.freeze({ connectionId, remoteAddress, remotePort })`
- `'error'` → `Object.freeze({ error })` (or pass raw Error per EventEmitter convention)
- `'close'` → `Object.freeze({})`

**beforeClose hook slot** (connection.ts lines 200-208):
```typescript
/**
 * beforeClose hook — no-op default that resolves immediately.
 *
 * Phase 4 (Server) and Phase 5 (Client) override this instance property to
 * register ACK-drain and send-queue drain logic respectively (D-07/D-08).
 */
beforeClose: (drainTimeoutMs: number) => Promise<void> = () => Promise.resolve();
```

Server sets `conn.beforeClose` on each accepted connection after construction:
```typescript
conn.beforeClose = (_timeoutMs) => Promise.resolve(); // Phase 4: no-op; flush already awaited
```

**Drain-with-timeout pattern** (connection.ts lines 356-379):
```typescript
private async _drainWithTimeout(timeoutMs: number): Promise<void> {
  const drainPromise = this.beforeClose(timeoutMs);
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    const handle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
    handle.unref(); // do not keep process alive
  });

  const result = await Promise.race([drainPromise.then(() => 'done' as const), timeoutPromise]);

  if (result === 'timeout') {
    if (this._state === 'DRAINING') {
      this._transition('CLOSED', 'drain timeout');
      this._transport.destroy();
    }
  } else {
    if (this._state === 'DRAINING') {
      this._transition('DISCONNECTED');
      this._transport.close();
    }
  }
}
```

`server.close()` races all `conn.close()` promises against a shared `drainTimeoutMs` deadline (same `Promise.race` + `handle.unref()` shape), then calls `conn.destroy()` for any stragglers.

**getStats() — JSON-serializable plain object** (connection.ts lines 416-434):
```typescript
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
```

`server.getStats()` returns a similar plain object (no class instances, no Buffers):
```typescript
getStats(): ServerStats {
  // Aggregate totalBytesIn/Out from live connections at call time
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
    activeConnections: this._connections.size,
    totalBytesIn,
    totalBytesOut,
    acceptedTotal: this._acceptedTotal,
    closedTotal: this._closedTotal,
  };
}
```

**Error handling — typed error emission** (connection.ts lines 482-497):
```typescript
private _onTransportError(err: Error): void {
  const phase: ConnectionErrorPhase =
    this._state === 'CONNECTING'    ? 'connect'   :
    this._state === 'RECONNECTING'  ? 'reconnect' :
    this._state === 'DRAINING'      ? 'close'     :
    'receive';

  const connErr = new MllpConnectionError(err.message, { cause: err, phase });
  this.emit('error', Object.freeze({ connectionId: this.connectionId, error: connErr }));
  // ...
}
```

Server does NOT swallow connection errors — it re-emits them on the server's own `'error'` event (or on the connection — D-04 for autoAck errors). Errors from the underlying `net.Server` are emitted on the server's `'error'` event.

**NetTransport construction per accepted socket** (net-transport.ts lines 39-77):
```typescript
export class NetTransport implements Transport {
  private readonly _socket: Socket;

  constructor(socket: Socket) {
    this._socket = socket;
  }

  write(buf: Buffer): boolean { return this._socket.write(buf); }
  close(): void { this._socket.end(); }
  destroy(reason?: Error): void { this._socket.destroy(reason); }
  onData(fn: (chunk: Buffer) => void): void {
    this._socket.removeAllListeners('data');
    this._socket.on('data', fn);
  }
  // ...
}
```

Server creates one `NetTransport` per socket emitted by `net.Server`'s `'connection'` event:
```typescript
netServer.on('connection', (socket: Socket) => {
  const transport = new NetTransport(socket);
  const conn = new Connection({ transport, framing: this._framingOpts });
  // wire keepalive, idleTimeout, autoAck, beforeClose...
  this._connections.add(conn);
  conn.notifyConnect(socket.remoteAddress ?? null, socket.remotePort ?? null);
  // ...
});
```

**FrameReader options passthrough** (connection.ts lines 220-224):
```typescript
this._reader = new FrameReader({
  ...(opts.framing ?? {}),
  onFrame: (payload) => { this._onFrameDecoded(payload); },
  onWarning: (w) => { this._onFramingWarning(w); },
});
```

Server passes `framing` opts through to `ConnectionOptions.framing` — `Connection` already composes `FrameReader` internally. The server-level default framing is:
```typescript
const SERVER_DEFAULT_FRAMING: Omit<FrameReaderOptions, 'onFrame' | 'onWarning'> = {
  allowFsOnly: true,
  allowLfAfterFs: true,
  allowLeadingWhitespace: true,
  allowMissingLeadingVt: false,
};
```

**AbortSignal wiring** (CONTEXT.md specifics):
```typescript
// Pattern from CONTEXT.md — use addEventListener + removeEventListener pair:
signal.addEventListener('abort', handler, { once: true });
// cleanup:
signal.removeEventListener('abort', handler);
```

**Symbol.asyncDispose** (from CLAUDE.md):
```typescript
async [Symbol.asyncDispose](): Promise<void> {
  await this.close();
}
```

**TCP keepalive + idleTimeout** (D-10, D-11):
```typescript
// After accepting socket:
if (opts.keepaliveIntervalMs !== undefined) {
  socket.setKeepAlive(true, opts.keepaliveIntervalMs);
}
// idleTimeout resets on 'message':
if (opts.idleTimeoutMs !== undefined) {
  let idleTimer = setTimeout(() => conn.destroy(new Error('idle timeout')), opts.idleTimeoutMs);
  idleTimer.unref();
  conn.on('message', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => conn.destroy(new Error('idle timeout')), opts.idleTimeoutMs!);
    idleTimer.unref();
  });
  conn.once('close', () => clearTimeout(idleTimer));
}
```

**Phase 6 TLS branch comment** (CONTEXT.md code_context):
```typescript
// Phase 6: wire TlsTransport here when opts.tls is provided
const transport = new NetTransport(socket);
```

---

### `src/server/index.ts` (barrel)

**Analog:** `src/connection/index.ts` (lines 1-17)

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

Server barrel follows the same pattern — module-level JSDoc comment, then named exports with `type` keyword on pure types:
```typescript
/**
 * MLLP Server module — MllpServer, createServer(), and createStarterServer() factories.
 *
 * @packageDocumentation
 */

export {
  MllpServer,
  createServer,
  createStarterServer,
  type ServerOptions,
  type StarterServerOptions,
  type ServerStats,
  type MessageMeta,
} from './server.js';
```

---

### `src/index.ts` (barrel append)

**Analog:** `src/index.ts` (lines 1-37 — current full file)

The main barrel uses phase-delimited comment blocks. Each phase adds a new block at the bottom. The Phase 3 block is:
```typescript
// Phase 3: transport abstraction, connection FSM, and observability
export type { Transport } from './transport/index.js';
export { NetTransport } from './transport/index.js';
export {
  Connection,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionStats,
  type StateChangeEvent,
  type ReconnectingEvent,
  MllpConnectionError,
  type ConnectionErrorPhase,
} from './connection/index.js';
```

Phase 4 appends a new block in the same style:
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

Note: `type` keyword is used for all interface/type-alias exports; class and function exports have no `type` prefix. This matches the existing pattern throughout the file.

---

## Shared Patterns

### EventEmitter Extension
**Source:** `src/connection/connection.ts` line 173
**Apply to:** `src/server/server.ts`
```typescript
export class MllpServer extends EventEmitter {
  // Public events: 'listening', 'connection', 'error', 'close'
  // All event payloads are Object.freeze()'d before emission
```

### Frozen Event Payloads
**Source:** `src/connection/connection.ts` lines 281, 448-462, 490
**Apply to:** All `this.emit(...)` calls in `src/server/server.ts`
```typescript
// Every emitted payload must be frozen before emission:
this.emit('listening', Object.freeze({ port: actualPort, host: actualHost }));
this.emit('connection', Object.freeze({ connectionId, remoteAddress, remotePort }));
this.emit('close', Object.freeze({}));
// Connection objects themselves are references — only the wrapper object is frozen
```

### JSDoc + @example on Every Public Export
**Source:** `src/connection/connection.ts` lines 1-19 (file-level), 43-57, 106-128, 154-172
**Apply to:** Every `export class`, `export function`, `export interface` in `src/server/server.ts`
```typescript
/**
 * One-line summary.
 *
 * @example
 * ```typescript
 * // Minimal usage example
 * ```
 */
```

### .subarray() Never .slice()
**Source:** `src/framing/decoder.ts` lines 313, 449; `src/framing/encoder.ts` lines 106
**Apply to:** Any Buffer manipulation in `src/server/server.ts`
```typescript
// Correct:
Buffer.from(this._accumulator.subarray(0, this._writePos));
// Forbidden — SETUP-07 ESLint rule:
// buffer.slice(...)
```

### Promise.race + handle.unref() for Timeouts
**Source:** `src/connection/connection.ts` lines 358-365
**Apply to:** `server.close()` drain coordination in `src/server/server.ts`
```typescript
const timeoutPromise = new Promise<'timeout'>((resolve) => {
  const handle = setTimeout(() => { resolve('timeout'); }, timeoutMs);
  handle.unref(); // must not keep process alive
});
const result = await Promise.race([workPromise.then(() => 'done' as const), timeoutPromise]);
```

### Warning Handler Swallow Pattern
**Source:** `src/connection/connection.ts` lines 521-526; `src/framing/decoder.ts` lines 463-465
**Apply to:** autoAck callback invocation in `src/server/server.ts`
```typescript
try {
  this._onWarningFn(enriched);
} catch {
  // WARN-06: throwing handler must not disrupt frame processing
}
```

AutoAck errors (D-04) follow a similar swallow-and-emit pattern:
```typescript
try {
  const ackPayload = await resolveAck(payload, meta);
  conn.send(ackPayload);
} catch (err) {
  conn.emit('error', Object.freeze({ connectionId: conn.connectionId, error: err }));
  // server continues — peer will timeout and may retry
}
```

### Barrel: type keyword on Interface Exports
**Source:** `src/index.ts` lines 20-36; `src/connection/index.ts` lines 8-16
**Apply to:** `src/server/index.ts` and the Phase 4 block in `src/index.ts`
```typescript
export {
  SomeClass,           // class — no 'type' prefix
  someFunction,        // function — no 'type' prefix
  type SomeInterface,  // interface/type-alias — 'type' prefix required
} from './module.js';
```

---

## No Analog Found

All three Phase 4 files have close analogs. The following **new behavioral concepts** within `src/server/server.ts` have no existing codebase analog and must be implemented from the CONTEXT.md specification directly:

| Concept | Source | Notes |
|---------|--------|-------|
| Auto-ACK (`autoAck: 'AA' \| fn`) | CONTEXT.md D-03/D-04 | No existing autoAck logic anywhere; implement from D-03/D-04 spec |
| MSH-10 extraction without parser | CONTEXT.md specifics | `payload.toString().split('\|')[9]` pattern; no HL7 parser available |
| `handleSignals` in `createStarterServer` | CONTEXT.md D-09 | `process.once('SIGTERM'/'SIGINT')` — no analog; implement from spec |
| `net.Server` wrapping (not extending) | CONTEXT.md D-02 | `Connection` wraps Transport; Server wraps `net.Server` the same way |

---

## Metadata

**Analog search scope:** `src/connection/`, `src/transport/`, `src/framing/`, `src/index.ts`
**Files scanned:** 8 (connection.ts, error.ts, connection/index.ts, net-transport.ts, transport/index.ts, decoder.ts, encoder.ts, framing/index.ts, src/index.ts)
**Pattern extraction date:** 2026-04-24
