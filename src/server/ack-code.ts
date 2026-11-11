/**
 * The acknowledgement-condition table as a public function: from MSH-15, MSH-16 and an outcome to
 * the HL7 Table 0008 code to send.
 *
 * The server's auto-ACK path selects its code by the same rules, read from the same internal
 * functions, so a caller that builds its own acknowledgement (an `autoAck` function, manual mode,
 * or another engine) answers exactly as the server would.
 *
 * @packageDocumentation
 */

import type { AckCode } from "./ack.js";
import {
  acceptAckRequested,
  acceptModeCounterpart,
  delimitersFrom,
  readConditionField,
} from "../internal/ack-mode.js";

/**
 * Input to {@link selectAckCode}.
 *
 * @example
 * ```typescript
 * import type { AckCodeSelectionInput } from '@cosyte/mllp';
 * const input: AckCodeSelectionInput = { msh15: 'AL', msh16: 'NE', outcome: 'AA' };
 * ```
 */
export interface AckCodeSelectionInput {
  /**
   * MSH-15, accept acknowledgment type (HL7 Table 0155), as the field's text: `AL`, `NE`, `ER`,
   * `SU`, or anything else the sender put there. Read the way the server reads it: the text before
   * the first repetition separator, then before the first component separator, with leading and
   * trailing spaces dropped, compared case-sensitively. Unset, empty, or the HL7 explicit null
   * `""` is a NULL field.
   */
  readonly msh15?: string | undefined;
  /** MSH-16, application acknowledgment type (HL7 Table 0155), read the same way as `msh15`. */
  readonly msh16?: string | undefined;
  /**
   * The message's MSH-2 encoding characters, which name its component (first byte) and repetition
   * (second byte) separators. Unset means the standard `^~\&`.
   *
   * @default '^~\\&'
   */
  readonly encodingCharacters?: string | undefined;
  /**
   * What the receiving application did with the message, as an application-mode code: `AA` it was
   * accepted, `AE` it failed, `AR` it was rejected. Any other value throws a `RangeError`.
   */
  readonly outcome: "AA" | "AE" | "AR";
}

/**
 * What {@link selectAckCode} decided. A frozen object; it carries no field text.
 *
 * @example
 * ```typescript
 * import { selectAckCode, type AckCodeSelection } from '@cosyte/mllp';
 * const selection: AckCodeSelection = selectAckCode({ msh15: 'AL', outcome: 'AA' });
 * selection.code; // 'CA'
 * ```
 */
export interface AckCodeSelection {
  /**
   * The one code to send now. The accept-mode counterpart of `outcome` (`CA`, `CE` or `CR`) when
   * MSH-15 asks for an accept acknowledgement on that outcome, and `outcome` itself otherwise. This
   * is the code the server's auto-ACK sends for the same fields and outcome.
   */
  readonly code: AckCode;
  /**
   * `'enhanced'` when MSH-15 or MSH-16 is non-NULL (the standard's own test for the enhanced
   * protocol), `'original'` when both are NULL.
   */
  readonly mode: "original" | "enhanced";
  /**
   * Whether MSH-16 asks for an application acknowledgement carrying this outcome: `AL` always, `NE`
   * never, `ER` on `AE` or `AR` only, `SU` on `AA` only. A NULL or unrecognised MSH-16 reads as
   * `AL`, which is the original protocol. Where `code` is an accept-mode code and this is `true`,
   * the application acknowledgement is a second message, and sending it is the caller's; where
   * `code` is an application-mode code, `code` is that acknowledgement.
   */
  readonly applicationAckRequested: boolean;
  /**
   * MSH-15 held a value outside Table 0155. It was read as NULL: `code` is `outcome`, unchanged,
   * as the server answers (and reports with `MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED`).
   */
  readonly acceptTypeUnrecognised: boolean;
  /** MSH-16 held a value outside Table 0155. It was read as NULL, so as `AL`. */
  readonly applicationTypeUnrecognised: boolean;
}

/** The standard MSH-2, for a caller that does not pass one. */
const STANDARD_ENCODING_CHARACTERS = "^~\\&";

/**
 * Select the acknowledgement code for a message from its MSH-15, MSH-16 and what the application
 * did with it, by the table the server's auto-ACK uses.
 *
 * Rows are MSH-15, columns the outcome:
 *
 * | MSH-15             | `AA`  | `AE`  | `AR`  |
 * | ------------------ | ----- | ----- | ----- |
 * | NULL               | `AA`  | `AE`  | `AR`  |
 * | `NE`               | `AA`  | `AE`  | `AR`  |
 * | `AL`               | `CA`  | `CE`  | `CR`  |
 * | `ER`               | `AA`  | `CE`  | `CR`  |
 * | `SU`               | `CA`  | `AE`  | `AR`  |
 * | outside Table 0155 | `AA`  | `AE`  | `AR`  |
 *
 * MSH-16 never changes the code; it decides {@link AckCodeSelection.applicationAckRequested}.
 *
 * Two things the server does are not in this function, because they are about the whole message
 * rather than its fields: a batch or concatenated frame keeps its warned non-positive answer, and
 * a message with no usable MSH-10 is never answered positively. A caller building its own
 * acknowledgement for such a message applies those rules itself.
 *
 * @param input - MSH-15, MSH-16, the message's MSH-2 and the outcome.
 * @returns The code to send, the mode, whether an application acknowledgement is asked for, and
 *   whether either field held a value outside Table 0155.
 * @throws {RangeError} when `outcome` is not `AA`, `AE` or `AR`. The message does not repeat the
 *   value.
 *
 * @example
 * ```typescript
 * import { selectAckCode } from '@cosyte/mllp';
 * selectAckCode({ msh15: 'AL', msh16: 'AL', outcome: 'AA' }).code; // 'CA'
 * selectAckCode({ msh15: 'ER', outcome: 'AA' }).code;               // 'AA'
 * selectAckCode({ msh15: 'ER', outcome: 'AE' }).code;               // 'CE'
 * selectAckCode({ outcome: 'AR' }).code;                            // 'AR'
 * ```
 */
export function selectAckCode(input: AckCodeSelectionInput): AckCodeSelection {
  const { outcome } = input;
  if (outcome !== "AA" && outcome !== "AE" && outcome !== "AR") {
    throw new RangeError("selectAckCode: outcome must be one of AA, AE or AR");
  }
  const delimiters = delimitersFrom(input.encodingCharacters ?? STANDARD_ENCODING_CHARACTERS);
  const accept = readConditionField(input.msh15, delimiters);
  const application = readConditionField(input.msh16, delimiters);
  return Object.freeze({
    code: acceptAckRequested(accept, outcome) ? acceptModeCounterpart(outcome) : outcome,
    mode: accept.kind === "null" && application.kind === "null" ? "original" : "enhanced",
    applicationAckRequested:
      application.kind !== "code" || acceptAckRequested(application, outcome),
    acceptTypeUnrecognised: accept.kind === "unrecognised",
    applicationTypeUnrecognised: application.kind === "unrecognised",
  });
}
