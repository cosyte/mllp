/**
 * ACK helpers that build a framed MLLP ACK from an inbound HL7 v2 message —
 * a THIN transport adapter over `@cosyte/hl7`'s `buildAck`.
 *
 * `@cosyte/hl7` owns ACK **content** (MSH/MSA/ERR construction, control
 * vocabulary, the no-correlation fail-safe); this subpath owns **transport
 * policy** — accepting raw bytes or a parsed message, never fabricating a
 * positive disposition when the inbound is unparseable, and framing the
 * result via `encodeFrame`.
 *
 * Requires `@cosyte/hl7` as an installed peer dependency; it is loaded lazily
 * on first call, so the rest of `@cosyte/mllp` stays fully dependency-free.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const ack = buildAckAA(inboundBuffer);
 * socket.write(ack.frame);
 * ```
 *
 * @packageDocumentation
 */

export {
  buildMllpAck,
  buildAckAA,
  buildAckAE,
  buildAckAR,
  buildAckCA,
  buildAckCE,
  buildAckCR,
  detectMode,
  MLLP_ACK_INBOUND_UNPARSEABLE,
  MLLP_ACK_CONTROL_ID_NOT_VERBATIM,
  MLLP_ACK_CONTROL_ID_UNVERIFIABLE,
} from "./build.js";
export type { BuildMllpAckOptions, MllpAck, MllpAckWarning } from "./build.js";

export { loadHl7Peer, MllpPeerMissingError } from "./peer.js";
export type { Hl7Peer } from "./peer.js";

// Re-exported for convenience so consumers of this subpath don't need a
// direct `@cosyte/hl7` dependency just to name these types.
export type { AckCode, AckMode, AckErrorDetail } from "@cosyte/hl7";
