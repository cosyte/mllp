/**
 * Transport interface — the abstraction boundary between Connection and raw I/O.
 *
 * All transports implement this callback-bag contract. Implementations:
 * - `NetTransport` — wraps `net.Socket` (production TCP)
 * - `TlsTransport` — wraps `tls.TLSSocket` (Phase 6)
 * - `InMemoryTransport` — deterministic test double (`@cosyte/hl7-mllp/testing`)
 *
 * @example
 * ```typescript
 * import { NetTransport } from '@cosyte/hl7-mllp';
 * import { createConnection } from 'node:net';
 * const socket = createConnection({ host: 'localhost', port: 2575 });
 * const transport: Transport = new NetTransport(socket);
 * transport.onData((chunk) => reader.push(chunk));
 * transport.onConnect(() => console.log('connected'));
 * ```
 *
 * @packageDocumentation
 */

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
