/**
 * Peer-address resolution for the differential harness.
 *
 * Two states are deliberately told apart, and conflating them is the defect this module
 * exists to prevent:
 *
 *   * **No peer configured.** The address is absent or empty. There is nothing to point
 *     the harness at, so the run skips cleanly and the default verification stays green.
 *   * **A peer configured that cannot be read.** The address is present and is not a host
 *     and a port. That is a mistake in someone's configuration, and it is refused by name.
 *
 * A single "return undefined for both" rule silently skips the live run while the operator
 * believes it ran, which is the one outcome a pre-go-live check must never produce.
 *
 * @packageDocumentation
 */

import { MLLP_DIFF_PEER_UNPARSEABLE, MllpDifferentialConfigurationError } from "./error.js";

/** The highest port number a TCP endpoint can be bound to. */
const MAX_PORT = 65535;

/**
 * A resolved peer endpoint: where the harness opens its connections.
 *
 * @example
 * ```typescript
 * const peer: DifferentialPeer = { host: '127.0.0.1', port: 2575 };
 * ```
 */
export interface DifferentialPeer {
  /** Host name or address literal, with any IPv6 brackets already removed. */
  readonly host: string;
  /** TCP port, an integer in 1..65535. */
  readonly port: number;
}

/**
 * Resolve a configured peer address into a host and a port.
 *
 * The address is split on its **last** colon, so an IPv6 literal resolves as well as a
 * host name: `[::1]:2575` and `::1:2575` both give host `::1`. A naive split on the first
 * colon mangles the host and produces a NaN port, which is precisely how a live run gets
 * skipped while the operator believes it happened.
 *
 * @param raw - The configured address, or `undefined`/`null`/empty for no peer at all.
 * @returns The resolved peer, or `undefined` when no peer is configured.
 * @throws MllpDifferentialConfigurationError when an address is present and unusable.
 *
 * @example
 * ```typescript
 * import { resolveDifferentialPeer } from '@cosyte/mllp';
 * const peer = resolveDifferentialPeer('127.0.0.1:2575');
 * // peer?.host === '127.0.0.1'; peer?.port === 2575
 * // resolveDifferentialPeer(undefined) === undefined
 * ```
 */
export function resolveDifferentialPeer(
  raw: string | undefined | null,
): DifferentialPeer | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  const refuse: () => never = () => {
    throw new MllpDifferentialConfigurationError(MLLP_DIFF_PEER_UNPARSEABLE, raw);
  };

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === trimmed.length - 1) refuse();

  const host = trimmed.slice(0, lastColon).replace(/^\[|\]$/g, "");
  if (host === "") refuse();

  const portText = trimmed.slice(lastColon + 1);
  // `Number` accepts leading signs, whitespace, hex and exponent forms, every one of which
  // would make a nonsense address look resolvable. Only plain digits are a port.
  if (!/^\d+$/.test(portText)) refuse();
  const port = Number(portText);
  if (!Number.isInteger(port) || port <= 0 || port > MAX_PORT) refuse();

  return Object.freeze<DifferentialPeer>({ host, port });
}
