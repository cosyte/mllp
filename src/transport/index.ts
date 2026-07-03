/**
 * Transport interface — the abstraction boundary between Connection and raw I/O.
 *
 * All transports implement this callback-bag contract. Implementations:
 * - `NetTransport` — wraps `net.Socket` (production TCP)
 * - `TlsTransport` — wraps `tls.TLSSocket` (Phase 8 — MLLPS / TLS hardening)
 * - `InMemoryTransport` — deterministic test double (`@cosyte/mllp/testing`)
 *
 * @example
 * ```typescript
 * import { NetTransport } from '@cosyte/mllp';
 * import { createConnection } from 'node:net';
 * const socket = createConnection({ host: 'localhost', port: 2575 });
 * const transport: Transport = new NetTransport(socket);
 * transport.onData((chunk) => reader.push(chunk));
 * transport.onConnect(() => console.log('connected'));
 * ```
 *
 * @packageDocumentation
 */

export { NetTransport } from "./net-transport.js";
export { TlsTransport } from "./tls-transport.js";
export type { TlsOptions, ServerTlsOptions, ClientAuth, PemInput } from "./tls-options.js";
export {
  MLLP_TLS_VERIFY_DISABLED,
  MLLP_BIND_ALL_INTERFACES,
  type SecurityWarning,
  type SecurityWarningCode,
} from "./security-warnings.js";

/**
 * Pure callback-bag transport abstraction.
 *
 * Each `onXxx` registration is **set-once**: calling `onData(fn)` a second time
 * replaces the first handler. This prevents listener leaks across reconnect cycles
 * where Connection re-registers handlers on a fresh Transport.
 *
 * @example
 * ```typescript
 * function writeAll(t: Transport, chunks: Buffer[]): void {
 *   for (const chunk of chunks) t.write(chunk);
 * }
 * ```
 */
export interface Transport {
  /**
   * Write `buf` to the underlying transport.
   *
   * @returns `true` if the bytes were flushed to the kernel immediately;
   * `false` if the write was buffered (backpressure — caller should pause sending
   * until the `onDrain` event fires at the Connection layer).
   */
  write(buf: Buffer): boolean;

  /**
   * Initiate graceful close of the underlying transport.
   * The registered `onClose` handler fires once the socket is fully closed.
   */
  close(): void;

  /**
   * Abruptly destroy the transport, discarding any pending writes.
   * Fires `onError(reason)` (if provided) then `onClose`.
   *
   * @param reason - Optional error describing why the transport was destroyed.
   */
  destroy(reason?: Error): void;

  /**
   * Register the data handler. Called synchronously for each received chunk.
   * Replaces any previously registered handler (set-once semantics).
   *
   * @param fn - Called with each raw chunk as it arrives from the OS.
   */
  onData(fn: (chunk: Buffer) => void): void;

  /**
   * Register the connect handler. Called once after TCP (or TLS) handshake completes.
   * Replaces any previously registered handler (set-once semantics).
   */
  onConnect(fn: () => void): void;

  /**
   * Register the close handler. Called once when the underlying socket is fully closed.
   * Replaces any previously registered handler (set-once semantics).
   */
  onClose(fn: () => void): void;

  /**
   * Register the error handler. Called for socket-level errors (ECONNRESET, ETIMEDOUT, etc.).
   * Replaces any previously registered handler (set-once semantics).
   *
   * @param fn - Receives the underlying OS or TLS error.
   */
  onError(fn: (err: Error) => void): void;
}
