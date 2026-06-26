/**
 * ACK helpers that accept a parsed `@cosyte/hl7` `Hl7Message`.
 * Requires `@cosyte/hl7` as an installed peer dependency.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * ```
 *
 * @packageDocumentation
 */

/**
 * Placeholder export for the `@cosyte/mllp/ack-from-hl7` subpath until the ACK helpers land.
 *
 * The helpers (which accept a parsed `@cosyte/hl7` `Hl7Message` and build an MLLP ACK) are not
 * implemented yet; this constant keeps the subpath a non-empty, importable module so the build,
 * `exports` map, and `attw` publish gate stay green. Do not depend on it — it will be removed when
 * the real helpers replace it.
 *
 * @example
 * ```typescript
 * import { ACK_FROM_HL7_STUB } from '@cosyte/mllp/ack-from-hl7';
 * // ACK_FROM_HL7_STUB === true (placeholder; real helpers pending)
 * ```
 */
export const ACK_FROM_HL7_STUB = true;
