/**
 * The frozen diagnostic registry for ACK correlation.
 *
 * Every message an ACK-correlation diagnostic can carry lives here as a
 * literal, and the lookup takes **only a code**. There is no value parameter
 * anywhere in this module, which is the whole point: a factory that cannot be
 * handed a value cannot interpolate one, regardless of what arrives on the
 * wire.
 *
 * ## What this replaces, and why the shape matters more than the wording
 *
 * The `correlateByControlId` path used to build its diagnostics by
 * interpolation, and both ends of it were consumer-controlled and unbounded.
 * The unmatched-ACK error read the **peer's** MSA-2 straight out of an inbound
 * frame and put it on an `Error.message`; measured against a peer sending a
 * one-megabyte MSA-2, that produced a 1,000,026-byte `message` and an
 * equally large field on the frozen error payload. The late-ACK warning did
 * the same with the control id of the send being reported on. Both go to a
 * log, and in this domain a log is a place a patient identifier must not
 * reach. That is not a hypothetical about control ids either: this package has
 * already shipped one scanner that ran past a segment terminator and returned
 * PID-3, a patient's medical record number, as the "control ID" of a truncated
 * MSH. Withholding the bytes is the defence that survives the next such bug.
 *
 * ## What a correlation diagnostic says instead
 *
 * That a control id did not match, plus **numbers**: a byte length, a stream
 * offset, an elapsed time. A number is a shape, not content. A truncated id is
 * not an acceptable middle ground, and neither is a hex or base64 rendering:
 * both still grow the diagnostic with the input and both still disclose the
 * bytes. Nothing is lost by withholding them, because the caller already holds
 * them: the outbound payload is the caller's own argument to `send()`, and the
 * inbound frame is on the `'message'` event.
 *
 * Mirrors the same answer this package already reached for the ACK adapter's
 * verbatim-echo warning, which reports byte lengths and withholds MSH-10 and
 * MSA-2 themselves.
 *
 * @packageDocumentation
 */

/**
 * The two warning codes emitted by ACK correlation rather than by framing.
 *
 * A subset of the framing `WarningCode` union; named separately so the
 * registry below is exhaustive over exactly the codes it owns and a new
 * correlation code cannot be added without a message for it.
 */
export type AckCorrelationCode = "MLLP_ACK_UNMATCHED_CONTROL_ID" | "MLLP_ACK_AFTER_TIMEOUT";

/**
 * Frozen diagnostic text, one literal per code, no interpolation.
 *
 * Do **not** add a value parameter to anything that reads this table. The
 * distinguishing property of every diagnostic surface that has leaked across
 * this ecosystem is that its factory took a value at all.
 */
const ACK_DIAGNOSTIC_MESSAGES: Readonly<Record<AckCorrelationCode, string>> = Object.freeze({
  MLLP_ACK_UNMATCHED_CONTROL_ID:
    "Inbound ACK control ID matched no in-flight send and no timed-out send; the ACK was dropped. " +
    "Field values are withheld: MSA-2 is inbound payload content and this diagnostic goes to a log. " +
    "The inbound bytes are on the 'message' event; controlIdBytes gives the length.",
  MLLP_ACK_AFTER_TIMEOUT:
    "ACK arrived after its send had already timed out; the ACK was dropped. " +
    "Field values are withheld: a control ID is payload content and this diagnostic goes to a log. " +
    "The outbound bytes are the payload you passed to send(); controlIdBytes gives the length.",
});

/**
 * Look up the frozen diagnostic text for an ACK-correlation code.
 *
 * A pure table read. It takes no value, so no caller can widen it into an
 * interpolation site.
 *
 * @param code - The correlation code being reported.
 * @returns The registered message for that code, byte-for-byte.
 * @example
 * ```typescript
 * const message = ackDiagnosticMessage('MLLP_ACK_AFTER_TIMEOUT');
 * ```
 */
export function ackDiagnosticMessage(code: AckCorrelationCode): string {
  return ACK_DIAGNOSTIC_MESSAGES[code];
}
