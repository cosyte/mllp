/**
 * TlsTransport — `Transport` implementation wrapping a `tls.TLSSocket` (Phase 8).
 *
 * Identical wiring to `NetTransport` with one deliberate difference: `onConnect`
 * maps to the socket's `'secureConnect'` event (fires once the TLS handshake
 * completes) rather than `'connect'` (fires once the raw TCP handshake
 * completes). Consumers of `Transport` (Connection, Client, Server) never see
 * the difference — they only ever observe "the transport is ready."
 *
 * @example
 * ```typescript
 * import { connect } from 'node:tls';
 * import { TlsTransport } from '@cosyte/mllp';
 *
 * const socket = connect({ host: 'mllp.example.com', port: 2575, ca: caPem });
 * const transport = new TlsTransport(socket);
 * transport.onConnect(() => console.log('TLS handshake complete'));
 * transport.onData((chunk) => reader.push(chunk));
 * ```
 *
 * @packageDocumentation
 */

import type { TLSSocket } from "node:tls";
import type { Transport } from "./index.js";

/**
 * Wraps a `tls.TLSSocket` as a `Transport`. `onConnect(fn)` is armed on the
 * `'secureConnect'` event (handshake complete, including certificate
 * verification when `rejectUnauthorized` is on) rather than the raw TCP
 * `'connect'` event that `NetTransport` uses.
 *
 * Each `onXxx(fn)` call replaces the prior handler and re-registers on the
 * socket (`socket.removeAllListeners(event)` + `socket.on(event, fn)`) —
 * the same set-once semantics as `NetTransport`.
 *
 * @example
 * ```typescript
 * const t = new TlsTransport(tlsSocket);
 * t.onConnect(() => logger.info('secure'));
 * t.onError((err) => handleTlsError(err));
 * ```
 */
export class TlsTransport implements Transport {
  private readonly _socket: TLSSocket;

  /**
   * Wrap an existing `tls.TLSSocket` (connecting or already secure) as a `Transport`.
   *
   * @param socket - The TLS socket to adapt.
   */
  constructor(socket: TLSSocket) {
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

  /**
   * See {@link Transport.onConnect}. Armed on `'secureConnect'` — the TLS
   * handshake-complete event — not the raw TCP `'connect'` event.
   */
  onConnect(fn: () => void): void {
    this._socket.removeAllListeners("secureConnect");
    this._socket.on("secureConnect", fn);
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
