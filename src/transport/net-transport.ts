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
 * import { NetTransport } from '@cosyte/mllp';
 *
 * const socket = createConnection({ host: 'mllp.example.com', port: 2575 });
 * const transport = new NetTransport(socket);
 * transport.onConnect(() => console.log('connected'));
 * transport.onData((chunk) => reader.push(chunk));
 * ```
 *
 * @packageDocumentation
 */

import type { Socket } from "node:net";
import type { Transport } from "./index.js";

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

  /**
   * Wrap an existing `net.Socket` (or `tls.TLSSocket`) as a `Transport`.
   *
   * @param socket - The connected (or connecting) socket to adapt.
   */
  constructor(socket: Socket) {
    this._socket = socket;
  }

  /** See {@link Transport.write}. */
  write(buf: Buffer): boolean {
    return this._socket.write(buf);
  }

  /** See {@link Transport.close}. */
  close(): void {
    this._socket.end();
  }

  /** See {@link Transport.destroy}. */
  destroy(reason?: Error): void {
    this._socket.destroy(reason);
  }

  /** See {@link Transport.onData}. */
  onData(fn: (chunk: Buffer) => void): void {
    this._socket.removeAllListeners("data");
    this._socket.on("data", fn);
  }

  /** See {@link Transport.onConnect}. */
  onConnect(fn: () => void): void {
    this._socket.removeAllListeners("connect");
    this._socket.on("connect", fn);
  }

  /** See {@link Transport.onClose}. */
  onClose(fn: () => void): void {
    this._socket.removeAllListeners("close");
    this._socket.on("close", fn);
  }

  /** See {@link Transport.onError}. */
  onError(fn: (err: Error) => void): void {
    this._socket.removeAllListeners("error");
    this._socket.on("error", fn);
  }
}
