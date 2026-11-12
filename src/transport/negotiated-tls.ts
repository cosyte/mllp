/**
 * The `'tlsNegotiated'` event payload: what a completed TLS handshake actually
 * agreed on.
 *
 * A deployment that has declared the IHE ATNA ITI-19 transport-security option
 * on a link needs to be able to show, from its own logs, which protocol
 * version and which cipher suite that link negotiated. This is that record,
 * emitted once per completed handshake on both the client and the server.
 *
 * It is a **log line**, so it carries no field content: every value is read
 * from the TLS session and is a name out of a closed registry, never anything
 * derived from the payload, the certificate, or the key.
 *
 * @example
 * ```typescript
 * import type { NegotiatedTlsParameters } from '@cosyte/mllp';
 * client.on('tlsNegotiated', (p: NegotiatedTlsParameters) => {
 *   logger.info({ tls: p.protocolVersion, suite: p.cipherSuite, group: p.keyExchangeGroup });
 * });
 * ```
 *
 * @packageDocumentation
 */

import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";

/**
 * Frozen payload of the `'tlsNegotiated'` event, emitted by both
 * {@link MllpClient} and {@link MllpServer} once per completed TLS handshake,
 * including every reconnect. Never emitted on a plaintext connection.
 *
 * Carries no HL7 payload content and no certificate or key material: only the
 * negotiated names and the same routing metadata a `SecurityWarning`
 * carries. It is emitted at handshake-completion time, before any HL7 byte has
 * crossed the link.
 *
 * @example
 * ```typescript
 * server.on('tlsNegotiated', (p: NegotiatedTlsParameters) => {
 *   if (p.protocolVersion !== 'TLSv1.3') metrics.increment('mllp.tls12_link');
 * });
 * ```
 */
export interface NegotiatedTlsParameters {
  /**
   * Negotiated protocol version as the TLS library reports it, e.g.
   * `'TLSv1.2'` or `'TLSv1.3'`.
   */
  readonly protocolVersion: string;
  /**
   * Negotiated cipher suite in its **IANA** spelling, e.g.
   * `'TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256'`. That is the spelling the IHE
   * and IETF documents print, so it can be compared with a conformance claim
   * directly. The OpenSSL spelling, which is what a `ciphers` list is written
   * in, is a different rendering of the same suite.
   */
  readonly cipherSuite: string;
  /**
   * The key-exchange group the handshake used, as the TLS library names it,
   * e.g. `'X25519'`, `'prime256v1'`, or a post-quantum hybrid such as
   * `'X25519MLKEM768'`. Standardized group names are the ones the IANA TLS
   * Supported Groups registry lists.
   *
   * Present only where the runtime reports the group, and **absent** (the key
   * is not on the object) everywhere else:
   *
   * - only on a **client** record: Node.js reports the group on a client socket
   *   alone, so a server record never carries it;
   * - a classic elliptic-curve group (`'X25519'`, `'prime256v1'` and the like)
   *   is reported on every supported Node.js line;
   * - a group with no classic key, such as a post-quantum hybrid, is reported
   *   from Node.js 24.19.0 and 26.5.0; on Node.js 22 it is absent;
   * - a TLS 1.2 finite-field Diffie-Hellman exchange (a `DHE` suite) has no
   *   group name to report, so it is absent there too.
   */
  readonly keyExchangeGroup?: string;
  /** Host associated with the link (the target host for clients; the bind host for servers). */
  readonly host: string;
  /** Port associated with the link. */
  readonly port: number;
  /** Wall-clock time at point of emission. */
  readonly timestamp: Date;
}

/**
 * Read the negotiated parameters off a socket whose handshake has completed.
 *
 * Returns `null` for a socket that is not a TLS socket at all, and for a TLS
 * socket with no session to report. That is what keeps a plaintext connection
 * from producing an event: it is a structural property of the read, not a
 * caller-side condition anyone has to remember.
 *
 * @param socket - The socket whose handshake completed; plaintext is allowed and yields `null`.
 * @param host - Routing metadata for the payload's `host`.
 * @param port - Routing metadata for the payload's `port`.
 * @returns A frozen payload, or `null` when there is nothing negotiated to report.
 *
 * @example
 * ```typescript
 * const params = readNegotiatedTlsParameters(tlsSocket, 'mllp.example.com', 2575);
 * if (params !== null) logger.info({ suite: params.cipherSuite });
 * ```
 */
export function readNegotiatedTlsParameters(
  socket: Socket | TLSSocket,
  host: string,
  port: number,
): NegotiatedTlsParameters | null {
  if (!("getProtocol" in socket)) return null;
  const protocolVersion = socket.getProtocol();
  if (protocolVersion === null) return null;
  const cipher = socket.getCipher();
  // `standardName` is the IANA spelling; `name` is OpenSSL's. Both come from
  // the library's own suite registry, so neither can carry caller data.
  const cipherSuite = cipher.standardName === "" ? cipher.name : cipher.standardName;
  if (cipherSuite === "") return null;
  const keyExchangeGroup = readKeyExchangeGroup(socket);
  return Object.freeze({
    protocolVersion,
    cipherSuite,
    ...(keyExchangeGroup === undefined ? {} : { keyExchangeGroup }),
    host,
    port,
    timestamp: new Date(),
  });
}

/**
 * Read the name of the key-exchange group a completed handshake used, where
 * the runtime reports one.
 *
 * Node.js answers `getEphemeralKeyInfo()` with `null` on a server socket, with
 * `{}` when it has nothing to describe, with a `type` of `'DH'` and no name for
 * a finite-field exchange, and with a `name` for an elliptic-curve exchange
 * (`type: 'ECDH'`) and, from Node.js 24.19.0 and 26.5.0, for a group with no
 * classic key such as a post-quantum hybrid (`type: 'TLSGroup'`). Only a
 * non-empty string `name` is reported; every other answer, and a runtime with
 * no such method, reads as no group.
 *
 * @param socket - A TLS socket whose handshake completed.
 * @returns The group's name, or `undefined` when there is none to report.
 *
 * @example
 * ```typescript
 * readKeyExchangeGroup(tlsSocket); // => 'X25519' on a client, undefined on a server
 * ```
 */
function readKeyExchangeGroup(socket: TLSSocket): string | undefined {
  if (typeof socket.getEphemeralKeyInfo !== "function") return undefined;
  const info: unknown = socket.getEphemeralKeyInfo();
  if (typeof info !== "object" || info === null || !("name" in info)) return undefined;
  // The name comes from the TLS library's own group registry, so it cannot carry caller data.
  const { name } = info;
  return typeof name === "string" && name !== "" ? name : undefined;
}
