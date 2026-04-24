/**
 * NetTransport — `Transport` implementation wrapping a `net.Socket`.
 *
 * This is the **only** place in the codebase that consumes `net.Socket`'s
 * EventEmitter surface. All higher layers (Connection, Server, Client) work
 * against the `Transport` interface, never against `net.Socket` directly.
 *
 * @example
 * ```typescript
 * import { createConnection } from 'node:net';
 * import { NetTransport } from '@cosyte/hl7-mllp';
 *
 * const socket = createConnection({ host: 'mllp.example.com', port: 2575 });
 * const transport = new NetTransport(socket);
 * transport.onConnect(() => console.log('connected'));
 * transport.onData((chunk) => reader.push(chunk));
 * ```
 *
 * @packageDocumentation
 */

import type { Socket } from 'node:net';
import type { Transport } from './index.js';

/**
 * Wraps a `net.Socket` as a `Transport`, mapping socket EventEmitter events
 * to registered single-handler callbacks.
 *
 * Each `onXxx(fn)` call replaces the prior handler and re-registers on the socket
 * (uses `socket.removeAllListeners(event)` + `socket.on(event, fn)`).
 *
 * @example
 * ```typescript
 * const t = new NetTransport(socket);
 * t.onData((chunk) => process(chunk));
 * t.onError((err) => handleError(err));
 * ```
 */
export class NetTransport implements Transport {
  private readonly _socket: Socket;

  constructor(socket: Socket) {
    this._socket = socket;
  }

  write(buf: Buffer): boolean {
    return this._socket.write(buf);
  }

  close(): void {
    this._socket.end();
  }

  destroy(reason?: Error): void {
    this._socket.destroy(reason);
  }

  onData(fn: (chunk: Buffer) => void): void {
    this._socket.removeAllListeners('data');
    this._socket.on('data', fn);
  }

  onConnect(fn: () => void): void {
    this._socket.removeAllListeners('connect');
    this._socket.on('connect', fn);
  }

  onClose(fn: () => void): void {
    this._socket.removeAllListeners('close');
    this._socket.on('close', fn);
  }

  onError(fn: (err: Error) => void): void {
    this._socket.removeAllListeners('error');
    this._socket.on('error', fn);
  }
}
