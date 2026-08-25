/**
 * The `'tlsNegotiated'` event payload: what a completed TLS handshake actually
 * agreed on.
 *
 * A deployment that has declared the IHE ATNA ITI-19 transport-security option
 * on a link needs to be able to show, from its own logs, which protocol
 * version and which cipher suite that link negotiated. This is that record,
 * emitted once per completed handshake on both the client and the server.
 *
 * It is a **log line**, so it carries no field content: both values are read
 * from the TLS session and are names out of a closed registry, never anything
 * derived from the payload, the certificate, or the key.
 *
 * @example
 * ```typescript
 * import type { NegotiatedTlsParameters } from '@cosyte/mllp';
 * client.on('tlsNegotiated', (p: NegotiatedTlsParameters) => {
 *   logger.info({ tls: p.protocolVersion, suite: p.cipherSuite });
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
 * two negotiated names and the same routing metadata a `SecurityWarning`
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
  return Object.freeze({
    protocolVersion,
    cipherSuite,
    host,
    port,
    timestamp: new Date(),
  });
}
