/**
 * InMemoryTransport, deterministic, socket-free Transport for tests.
 *
 * Two connected ends are created via `InMemoryTransport.pair()`.
 * Writes to end A fire end B's registered `onData` handler **synchronously**
 * before `write()` returns, no async ceremony, no `await` in tests.
 *
 * @example
 * ```typescript
 * import { InMemoryTransport } from '@cosyte/mllp/testing';
 * const [a, b] = InMemoryTransport.pair();
 * b.onData((chunk) => console.log('received:', chunk));
 * a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
 * // b's onData fired synchronously, log printed before this line
 * ```
 *
 * @packageDocumentation
 */

import type { Transport } from "../transport/index.js";

/**
 * Deterministic in-memory transport for socket-free tests.
 *
 * Create connected pairs with `InMemoryTransport.pair()`. Writes to one end
 * deliver synchronously to the other end's `onData` handler, no async ceremony,
 * no `await` needed in tests.
 *
 * Supports `split(n)` for chunked-read simulation, `pause()`/`resume()` for
 * backpressure simulation, and `destroy(reason)` for abrupt-disconnect simulation.
 *
 * @example
 * ```typescript
 * const [client, server] = InMemoryTransport.pair();
 * server.onData((chunk) => server.write(chunk)); // echo
 * client.onData((echo) => console.log('echo:', echo));
 * client.write(Buffer.from('hello'));
 * ```
 */
export class InMemoryTransport implements Transport {
  private _peer: InMemoryTransport | null = null;

  private _onDataFn: ((chunk: Buffer) => void) | null = null;
  private _onConnectFn: (() => void) | null = null;
  private _onCloseFn: (() => void) | null = null;
  private _onErrorFn: ((err: Error) => void) | null = null;

  private _destroyed = false;
  private _paused = false;
  private _splitBytes = 0;
  private _pendingChunks: Buffer[] = [];
  private _writeDepth = 0;

  private constructor() {}

  /**
   * Create two connected InMemoryTransport ends.
   *
   * Writes to `a` deliver to `b`'s `onData` handler synchronously (and vice versa).
   * Call `a.simulateConnect()` after `pair()` to fire the `onConnect` handler,
   * simulating TCP connect completion.
   *
   * @returns Tuple `[a, b]` of two connected transports.
   *
   * @example
   * ```typescript
   * const [a, b] = InMemoryTransport.pair();
   * b.onData((chunk) => b.write(chunk)); // echo server
   * a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
   * ```
   */
  static pair(): [InMemoryTransport, InMemoryTransport] {
    const a = new InMemoryTransport();
    const b = new InMemoryTransport();
    a._peer = b;
    b._peer = a;
    return [a, b];
  }

  /**
   * Write `buf` to the peer transport.
   *
   * If the peer is paused, the buffer is copied and queued, returns `false`
   * (backpressure signal). Otherwise, the peer's `onData` handler fires
   * synchronously before this method returns.
   *
   * @returns `true` if delivered immediately; `false` if queued or transport is destroyed.
   */
  write(buf: Buffer): boolean {
    if (this._destroyed) return false;
    const peer = this._peer;
    if (peer === null || peer._destroyed) return false;

    if (peer._paused) {
      // Queue a copy, caller may reuse buf after write() returns (T-03-02-02)
      peer._pendingChunks.push(Buffer.from(buf));
      return false;
    }

    peer._deliverChunk(buf);
    return true;
  }

  /**
   * Initiate graceful close, fires `onClose` on this end and on the peer,
   * simulating a TCP FIN exchange.
   */
  close(): void {
    if (this._destroyed) return;
    this._destroyed = true;
    // Fire onClose on this end
    if (this._onCloseFn !== null) {
      try {
        this._onCloseFn();
      } catch {
        /* swallow, test handlers must not break transport logic */
      }
    }
    // Simulate peer receiving FIN, fire peer's onClose
    const peer = this._peer;
    if (peer !== null && !peer._destroyed) {
      peer._destroyed = true;
      if (peer._onCloseFn !== null) {
        try {
          peer._onCloseFn();
        } catch {
          /* swallow */
        }
      }
    }
  }

  /**
   * Abruptly destroy this transport end.
   *
   * Fires `onError(reason)` then `onClose` on this end only. Does NOT affect
   * the peer (simulates one-sided abrupt disconnect, e.g., ECONNRESET on
   * just one socket).
   *
   * @param reason - Optional error; defaults to `new Error('InMemoryTransport destroyed')`.
   */
  destroy(reason?: Error): void {
    if (this._destroyed) return;
    this._destroyed = true;
    const err = reason ?? new Error("InMemoryTransport destroyed");
    if (this._onErrorFn !== null) {
      try {
        this._onErrorFn(err);
      } catch {
        /* swallow */
      }
    }
    if (this._onCloseFn !== null) {
      try {
        this._onCloseFn();
      } catch {
        /* swallow */
      }
    }
  }

  /**
   * Register the data handler. Replaces any previously registered handler.
   *
   * @param fn - Called with each chunk delivered by the peer.
   */
  onData(fn: (chunk: Buffer) => void): void {
    this._onDataFn = fn;
  }

  /**
   * Register the connect handler. Replaces any previously registered handler.
   * Use `simulateConnect()` to trigger this in tests.
   *
   * @param fn - Called when `simulateConnect()` is invoked on this end.
   */
  onConnect(fn: () => void): void {
    this._onConnectFn = fn;
  }

  /**
   * Register the close handler. Replaces any previously registered handler.
   *
   * @param fn - Called when `close()` or `destroy()` is invoked on this end,
   *   or when the peer calls `close()`.
   */
  onClose(fn: () => void): void {
    this._onCloseFn = fn;
  }

  /**
   * Register the error handler. Replaces any previously registered handler.
   *
   * @param fn - Called when `destroy(reason)` is invoked on this end.
   */
  onError(fn: (err: Error) => void): void {
    this._onErrorFn = fn;
  }

  /**
   * Simulate chunked TCP reads.
   *
   * After calling `split(n)`, any `write()` directed at this transport will be
   * delivered to the `onData` handler in chunks of `n` bytes rather than
   * all at once. Useful for verifying that a `FrameReader` reassembles frames
   * correctly across chunk boundaries.
   *
   * @param bytesPerChunk - Chunk size in bytes. Pass `0` to disable chunking.
   *
   * @example
   * ```typescript
   * const [a, b] = InMemoryTransport.pair();
   * b.split(1); // b receives one byte at a time
   * a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d])); // fires b.onData 4 times
   * ```
   */
  split(bytesPerChunk: number): void {
    this._splitBytes = bytesPerChunk;
  }

  /**
   * Pause delivery.
   *
   * While paused, writes directed at this transport are queued internally and
   * the `onData` handler is NOT called. The queued chunks are flushed on `resume()`.
   *
   * @example
   * ```typescript
   * b.pause();
   * a.write(buf); // queued, b.onData not called
   * b.resume();   // flushes queue synchronously
   * ```
   */
  pause(): void {
    this._paused = true;
  }

  /**
   * Resume delivery, flushes all queued chunks to the `onData` handler,
   * synchronously, in the order they were written.
   */
  resume(): void {
    this._paused = false;
    const pending = this._pendingChunks.splice(0);
    for (const chunk of pending) {
      this._deliverChunk(chunk);
    }
  }

  /**
   * Fire the `onConnect` handler on this end.
   *
   * Call after `pair()` to simulate TCP connect completion. In production code,
   * `NetTransport` fires the handler automatically when the socket emits `'connect'`.
   *
   * @example
   * ```typescript
   * const [a] = InMemoryTransport.pair();
   * a.onConnect(() => console.log('connected'));
   * a.simulateConnect(); // fires immediately
   * ```
   */
  simulateConnect(): void {
    if (this._onConnectFn !== null) {
      try {
        this._onConnectFn();
      } catch {
        /* swallow */
      }
    }
  }

  private _deliverChunk(buf: Buffer): void {
    if (this._onDataFn === null) return;

    // Re-entrancy guard (D-03): writing from inside an onData handler would cause
    // infinite recursion or corrupt frame ordering. Detect and throw.
    if (this._writeDepth > 0) {
      throw new Error("InMemoryTransport: re-entrant write detected");
    }

    if (this._splitBytes > 0) {
      let offset = 0;
      while (offset < buf.length) {
        const end = Math.min(offset + this._splitBytes, buf.length);
        const chunk = buf.subarray(offset, end);
        this._writeDepth++;
        try {
          this._onDataFn(chunk);
        } finally {
          this._writeDepth--;
        }
        offset = end;
      }
    } else {
      this._writeDepth++;
      try {
        this._onDataFn(buf);
      } finally {
        this._writeDepth--;
      }
    }
  }
}
