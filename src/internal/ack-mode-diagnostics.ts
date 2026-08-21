/**
 * The frozen diagnostic registry for acknowledgement-mode reporting.
 *
 * Every message an acknowledgement-mode diagnostic can carry lives here as a literal, and
 * the lookup takes **only a code**. There is no value parameter anywhere in this module,
 * which is the whole point: a factory that cannot be handed a value cannot interpolate one,
 * regardless of what arrives on the wire. It is the same shape, and for the same reason, as
 * the correlation registry beside it.
 *
 * ## What these diagnostics may carry
 *
 * Stable codes, byte counts, byte offsets, elapsed times, and an acknowledgement code drawn
 * from the closed six-code Table 0008 set. Nothing else. A control ID is payload content, a
 * field value is payload content, and these go to a log. An MSA-1 that could not be
 * classified is reported by its **byte length** only, never by its bytes: the whole reason a
 * value is unclassifiable is that nobody knows what it is, so echoing it into a log is
 * echoing unknown wire content into a log.
 *
 * @packageDocumentation
 */

/**
 * The stable codes acknowledgement-mode reporting emits.
 *
 * A **public API**: consumers narrow on them in warning handlers, log pipelines and
 * monitoring. Renaming or removing one is a breaking change. They are deliberately a
 * family of their own rather than additions to the framing warning-code union, because
 * that union is the decoder's registry and these are not decoder events.
 *
 * @example
 * ```typescript
 * import type { AckModeCode } from '@cosyte/mllp';
 * const code: AckModeCode = 'MLLP_ACK_TWO_PHASE_UNAVAILABLE';
 * ```
 */
export type AckModeCode =
  | "MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED"
  | "MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED"
  | "MLLP_ACK_TWO_PHASE_UNAVAILABLE"
  | "MLLP_ACK_COMMIT_ALREADY_REPORTED"
  | "MLLP_ACK_MSA1_ABSENT"
  | "MLLP_ACK_MSA1_UNCLASSIFIABLE"
  | "MLLP_ACK_SEND_ALREADY_DISPOSED";

/**
 * Frozen diagnostic text, one literal per code, no interpolation.
 *
 * Do **not** add a value parameter to anything that reads this table.
 */
const ACK_MODE_MESSAGES: Readonly<Record<AckModeCode, string>> = Object.freeze({
  MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED:
    "MSH-15 (accept acknowledgment type) carried a value outside HL7 Table 0155; it was read " +
    "as the table's default and the message was transmitted or answered unchanged. " +
    "Field values are withheld: a field value is payload content and this diagnostic goes to a log.",
  MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED:
    "MSH-16 (application acknowledgment type) carried a value outside HL7 Table 0155; it was " +
    "read as the table's default and the message was transmitted unchanged. " +
    "Field values are withheld: a field value is payload content and this diagnostic goes to a log.",
  MLLP_ACK_TWO_PHASE_UNAVAILABLE:
    "An enhanced-mode send was made on a client that correlates acknowledgements in order " +
    "rather than by control ID, so two-phase correlation was not applied and the first " +
    "acknowledgement matched to this send settles it. Set correlateByControlId to enable it.",
  MLLP_ACK_COMMIT_ALREADY_REPORTED:
    "A further commit-accept acknowledgement arrived for a send whose commit disposition had " +
    "already been reported; it was surfaced and neither re-reported nor allowed to restart " +
    "the application-acknowledgement wait. The send is still pending.",
  MLLP_ACK_MSA1_ABSENT:
    "An acknowledgement matched to an enhanced-mode send carried no MSA-1 acknowledgement " +
    "code, so it was not classified into a mode and the send was left pending. " +
    "Field values are withheld; msa1Bytes gives the field's length.",
  MLLP_ACK_MSA1_UNCLASSIFIABLE:
    "An acknowledgement matched to an enhanced-mode send carried an MSA-1 value outside HL7 " +
    "Table 0008, so it was not classified into a mode and the send was left pending. " +
    "Field values are withheld; msa1Bytes gives the field's length.",
  MLLP_ACK_SEND_ALREADY_DISPOSED:
    "An acknowledgement arrived for a send that had already been settled or failed; it was " +
    "dropped and that outcome was left unchanged. " +
    "Field values are withheld: a control ID is payload content and this diagnostic goes to a log.",
});

/**
 * Look up the frozen diagnostic text for an acknowledgement-mode code.
 *
 * A pure table read. It takes no value, so no caller can widen it into an interpolation
 * site.
 *
 * @param code - The acknowledgement-mode code being reported.
 * @returns The registered message for that code, byte-for-byte.
 * @example
 * ```typescript
 * const message = ackModeDiagnosticMessage('MLLP_ACK_MSA1_UNCLASSIFIABLE');
 * ```
 */
export function ackModeDiagnosticMessage(code: AckModeCode): string {
  return ACK_MODE_MESSAGES[code];
}
