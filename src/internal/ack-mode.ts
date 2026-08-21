/**
 * Parser-free reads of the three acknowledgement-mode fields: MSH-15 and MSH-16 on the way
 * out, MSA-1 on the way in.
 *
 * HL7 v2.5.1 §2.9 splits acknowledgement into two protocols. In the **original** protocol
 * one message draws one acknowledgement. In the **enhanced** protocol it draws two: an
 * *accept* acknowledgement carrying `CA`/`CE`/`CR` ("I have committed these bytes to safe
 * storage; you may stop resending"), and a later *application* acknowledgement carrying
 * `AA`/`AE`/`AR` ("here is what my application did with it"). A message asks for the
 * enhanced protocol through MSH-15 and MSH-16, and §2.9 states the equivalence that makes
 * the two one contract rather than two: the original protocol is the enhanced protocol
 * with MSH-15 = `NE` and MSH-16 = `AL`.
 *
 * This module reads those fields the way the rest of this package reads MSH-10: byte-level,
 * off the shared MSH scan, never through a parser. **Reading a field is not validating
 * one.** Nothing here refuses, delays or alters a message because of the value of a field;
 * an unrecognised value reads as its default and is reported, which is the only behaviour
 * compatible with a transport that does not own HL7 content.
 *
 * Two code systems are involved and neither is interpreted beyond membership:
 *
 *   * **Table 0008** (MSA-1, acknowledgment code), six codes in two halves:
 *     accept-mode `CA`/`CE`/`CR`, application-mode `AA`/`AE`/`AR`.
 *   * **Table 0155** (MSH-15, MSH-16, accept/application acknowledgment conditions), four
 *     codes: `AL` always, `NE` never, `ER` error or reject conditions only, `SU`
 *     successful completion only.
 *
 * **INTERNAL**, not part of the public API.
 *
 * @packageDocumentation
 */

import { readMshSegment, readMsaSegment, type MshSegment } from "./control-id.js";

/**
 * HL7 Table 0155, accept/application acknowledgment conditions. The value space of MSH-15
 * and MSH-16.
 *
 * @internal
 */
export type AckConditionCode = "AL" | "NE" | "ER" | "SU";

/**
 * HL7 Table 0008, acknowledgment code. The value space of MSA-1, in two halves: the
 * accept-mode `CA`/`CE`/`CR` and the application-mode `AA`/`AE`/`AR`.
 *
 * Structurally identical to the package's public `AckCode`, and declared here so this
 * module can be read by the client without reaching into the server's surface.
 *
 * @internal
 */
export type Table0008Code = "AA" | "AE" | "AR" | "CA" | "CE" | "CR";

/** The four Table 0155 codes, in table order. @internal */
const TABLE_0155: readonly AckConditionCode[] = Object.freeze(["AL", "NE", "ER", "SU"]);

/** The six Table 0008 codes, in table order. @internal */
const TABLE_0008: readonly Table0008Code[] = Object.freeze(["AA", "AE", "AR", "CA", "CE", "CR"]);

/**
 * Position of MSH-15 in the field array {@link readMshSegment} returns, **and the one
 * place this off-by-one is written down**.
 *
 * The array is the MSH segment split on its own field separator, so `[0]` is the literal
 * `"MSH"` and `[1]` is MSH-2. From there the index is the field number minus one, because
 * MSH-1 **is** the field separator (§2.5.4) and therefore occupies no token of its own:
 * MSH-15 is the *fourteenth* separator-delimited token after `MSH`, not the fifteenth.
 *
 * The convention does not carry over from any other segment. In an `MSA` the segment name
 * is followed by MSA-1, so there `[1]` is field 1. Transposing the ordinary convention
 * onto the MSH reads MSH-16 out of MSH-17: on a header declaring a country code and no
 * acknowledgement request at all, that turns an original-mode message into an
 * enhanced-mode one and makes it wait for an acknowledgement no peer will send.
 *
 * @internal
 */
const MSH_15_INDEX = 14;

/** Position of MSH-16 in the same field array. See {@link MSH_15_INDEX}. @internal */
const MSH_16_INDEX = 15;

/** ASCII space, the only byte {@link readTableField} trims. @internal */
const SPACE = " ";

/**
 * The component and repetition separators a message declares in MSH-2.
 *
 * Either may be `null`, meaning the message declared none: MSH-2 is required by §2.16 but
 * this package reads what arrives rather than what should have. A `null` separator is not
 * substituted with the HL7 default, it is simply not applied, so a field is read whole
 * rather than split on a delimiter its own message never declared.
 *
 * @internal
 */
export interface FieldDelimiters {
  /** First byte of MSH-2, or `null` when MSH-2 is empty or absent. */
  readonly componentSep: string | null;
  /** Second byte of MSH-2, or `null` when MSH-2 is shorter than two bytes. */
  readonly repetitionSep: string | null;
}

/**
 * Derive {@link FieldDelimiters} from a message's MSH-2 (the encoding characters).
 *
 * @internal
 */
export function delimitersFrom(encodingCharacters: string | undefined): FieldDelimiters {
  const chars = encodingCharacters ?? "";
  return {
    componentSep: chars.length >= 1 ? chars.charAt(0) : null,
    repetitionSep: chars.length >= 2 ? chars.charAt(1) : null,
  };
}

/**
 * The outcome of reading one table-valued field. Exactly one of three, for any input bytes.
 *
 * `byteLength` is the raw field's length before any trimming, and it is deliberately the
 * **only** thing a diagnostic may report about an unrecognised value: a field value is
 * payload content, and a diagnostic goes to a log.
 *
 * @internal
 */
export type TableRead<C extends string> =
  | { readonly kind: "null"; readonly byteLength: number }
  | { readonly kind: "code"; readonly code: C; readonly byteLength: number }
  | { readonly kind: "unrecognised"; readonly byteLength: number };

/** Drop leading and trailing ASCII spaces (`0x20`) only. @internal */
function trimSpaces(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value.charAt(start) === SPACE) start++;
  while (end > start && value.charAt(end - 1) === SPACE) end--;
  return value.substring(start, end);
}

/**
 * Read one table-valued field, the single reading rule this module has.
 *
 * Take the field's bytes as delimited by the field separator (the caller has already split
 * on it); take the bytes before the first repetition separator, then before the first
 * component separator, both as the message itself declared them; drop leading and trailing
 * spaces; compare what remains **byte-exact and case-sensitively** against the table.
 *
 * So `AL` reads as `AL`, and so do `" AL "`, `AL^HL70155` (a coded element whose first
 * component is the code) and `AL~NE` (a repetition whose first repeat is the code). An
 * empty field, an absent field and the two-byte HL7 explicit null `""` all read as NULL.
 * `al` and `ALW` are unrecognised: the comparison is not softened, because a lenient
 * *locate* and a lenient *equality* are different things and only the first is Postel's Law.
 *
 * @internal
 */
function readTableField<C extends string>(
  raw: string | undefined,
  delimiters: FieldDelimiters,
  table: readonly C[],
): TableRead<C> {
  if (raw === undefined) return { kind: "null", byteLength: 0 };
  // `latin1` decoding is 1:1 with bytes, so a code-unit count is a byte count.
  const byteLength = raw.length;
  let value = raw;
  if (delimiters.repetitionSep !== null) {
    const at = value.indexOf(delimiters.repetitionSep);
    if (at !== -1) value = value.substring(0, at);
  }
  if (delimiters.componentSep !== null) {
    const at = value.indexOf(delimiters.componentSep);
    if (at !== -1) value = value.substring(0, at);
  }
  value = trimSpaces(value);
  if (value === "" || value === '""') return { kind: "null", byteLength };
  for (const code of table) {
    if (code === value) return { kind: "code", code, byteLength };
  }
  return { kind: "unrecognised", byteLength };
}

/**
 * What an outbound message asks its peer for, derived from MSH-15 and MSH-16.
 *
 * @internal
 */
export interface OutboundAckMode {
  /**
   * `true` when MSH-15 or MSH-16 is non-NULL, which is the standard's own entry test for
   * the enhanced protocol (§2.9). Every other message, **including one whose header cannot
   * be scanned at all**, is an original-mode message and gets this package's unchanged
   * one-acknowledgement behaviour.
   */
  readonly enhanced: boolean;
  /** MSH-15 read against Table 0155; a NULL or unrecognised value reads as `NE`. */
  readonly acceptCondition: AckConditionCode;
  /**
   * MSH-16 read against Table 0155; a NULL or unrecognised value reads as `AL`, which is
   * the equivalence §2.9 states between the original protocol and the enhanced one.
   */
  readonly applicationCondition: AckConditionCode;
  /**
   * `true` when an application acknowledgement may follow the accept acknowledgement, i.e.
   * the application condition is `AL`, `ER` or `SU`. On `NE` the accept acknowledgement is
   * the last word and settles the send by itself.
   */
  readonly awaitsApplicationAck: boolean;
  /** MSH-15 carried a non-NULL value that is not one of the four Table 0155 codes. */
  readonly acceptFieldUnrecognised: boolean;
  /** MSH-16 carried a non-NULL value that is not one of the four Table 0155 codes. */
  readonly applicationFieldUnrecognised: boolean;
}

/**
 * The reading every original-mode message gets, including one whose header is unreadable.
 *
 * @internal
 */
export const ORIGINAL_MODE: OutboundAckMode = Object.freeze({
  enhanced: false,
  acceptCondition: "NE",
  applicationCondition: "AL",
  awaitsApplicationAck: false,
  acceptFieldUnrecognised: false,
  applicationFieldUnrecognised: false,
});

/**
 * Classify an outbound message from an already-scanned MSH, and derive what it expects.
 *
 * Takes the scanned segment rather than the payload so a caller that also needs MSH-10 (the
 * correlation key) reads the header once. A `null` segment, a header this package cannot
 * scan, is an original-mode message and is never failed for that reason.
 *
 * @internal
 */
export function classifyOutboundAckMode(msh: MshSegment | null): OutboundAckMode {
  if (msh === null) return ORIGINAL_MODE;
  const delimiters = delimitersFrom(msh.fields[1]);
  const accept = readTableField(msh.fields[MSH_15_INDEX], delimiters, TABLE_0155);
  const application = readTableField(msh.fields[MSH_16_INDEX], delimiters, TABLE_0155);
  if (accept.kind === "null" && application.kind === "null") return ORIGINAL_MODE;
  const applicationCondition: AckConditionCode =
    application.kind === "code" ? application.code : "AL";
  return Object.freeze({
    enhanced: true,
    acceptCondition: accept.kind === "code" ? accept.code : "NE",
    applicationCondition,
    awaitsApplicationAck: applicationCondition !== "NE",
    acceptFieldUnrecognised: accept.kind === "unrecognised",
    applicationFieldUnrecognised: application.kind === "unrecognised",
  });
}

/**
 * Read an inbound message's MSH-15 against Table 0155, keeping the NULL / code /
 * unrecognised distinction the caller needs to decide whether to warn.
 *
 * @internal
 */
export function readAcceptCondition(msh: MshSegment | null): TableRead<AckConditionCode> {
  if (msh === null) return { kind: "null", byteLength: 0 };
  return readTableField(msh.fields[MSH_15_INDEX], delimitersFrom(msh.fields[1]), TABLE_0155);
}

/**
 * The classification of an inbound acknowledgement's MSA-1: **total** over every byte
 * sequence a payload can carry, and mutually exclusive between its three outcomes.
 *
 * `byteLength` is the MSA-1 field's raw byte length, the only thing a diagnostic reports
 * about a value that could not be classified.
 *
 * @internal
 */
export type Msa1Classification =
  | { readonly kind: "null"; readonly byteLength: number }
  | { readonly kind: "code"; readonly code: Table0008Code; readonly byteLength: number }
  | { readonly kind: "unclassifiable"; readonly byteLength: number };

/**
 * Classify an inbound acknowledgement's MSA-1 into one of the six Table 0008 codes, NULL,
 * or unclassifiable.
 *
 * The read goes through the **same** scans that correlate the acknowledgement to a send
 * ({@link readMshSegment} for the delimiters, {@link readMsaSegment} for the segment), so a
 * payload whose MSA-2 was found can never have its MSA-1 missed for a segment-splitting
 * reason. Then the ordinary field read applies, against Table 0008.
 *
 * Every input lands somewhere, which is what makes the caller's own rules decidable:
 *
 *   * no readable `MSH` at all: **unclassifiable**, nothing about this payload can be read
 *     with confidence, so nothing about it is guessed;
 *   * a readable `MSH` but no `MSA` segment: **NULL** (such a payload carries no MSA-2
 *     either, so it never correlates to a send in the first place);
 *   * an `MSA` whose first field is empty, absent, or the explicit null `""`: **NULL**;
 *   * a value that is not one of the six codes: **unclassifiable**.
 *
 * @internal
 */
export function classifyMsa1(ackPayload: Buffer): Msa1Classification {
  const msh = readMshSegment(ackPayload);
  if (msh === null) return { kind: "unclassifiable", byteLength: 0 };
  const msa = readMsaSegment(ackPayload);
  if (msa === null) return { kind: "null", byteLength: 0 };
  const read = readTableField(msa.fields[1], delimitersFrom(msh.fields[1]), TABLE_0008);
  if (read.kind === "code") return { kind: "code", code: read.code, byteLength: read.byteLength };
  if (read.kind === "null") return { kind: "null", byteLength: read.byteLength };
  return { kind: "unclassifiable", byteLength: read.byteLength };
}

/**
 * Per-send report that the peer has **committed** a message but has not yet said what its
 * application did with it, handed to the `onCommitAck` callback of the `send()` that drew
 * it.
 *
 * It is scoped to one caller's own send, and it arrives at a point where that send has not
 * settled: `send()` is still pending and will resolve on the application acknowledgement,
 * or reject if none arrives. That scoping is the point. The commit disposition belongs to
 * one send, and a caller learns which send it belongs to by being the one that made it,
 * never by anything being logged.
 *
 * @example
 * ```typescript
 * const ack = await client.send(payload, {
 *   onCommitAck: ({ code }) => logger.info({ commit: code }), // 'CA': the peer has custody
 * });
 * ```
 */
export interface CommitAckReport {
  /** The accept-mode Table 0008 code received. Always the positive `CA`. */
  readonly code: "CA";
  /** The accept acknowledgement's own payload bytes, framing stripped. */
  readonly payload: Buffer;
  /** Milliseconds between the send's write-flush and this acknowledgement. */
  readonly latencyMs: number;
}

/**
 * Whether MSH-15 asks for an **accept-mode** acknowledgement given the disposition the
 * responder has already reached for that message.
 *
 * Table 0155 makes the request conditional, so the answer needs both halves: `AL` asks
 * always; `NE` never; `ER` only where the disposition is an error or a reject; `SU` only
 * where it is positive. A NULL or unrecognised MSH-15 asks for nothing, which leaves the
 * responder's own application-mode answer in place.
 *
 * @internal
 */
export function acceptAckRequested(
  accept: TableRead<AckConditionCode>,
  disposition: Table0008Code,
): boolean {
  if (accept.kind !== "code") return false;
  switch (accept.code) {
    case "AL":
      return true;
    case "NE":
      return false;
    case "ER":
      return disposition === "AE" || disposition === "AR";
    case "SU":
      return disposition === "AA";
  }
}

/**
 * The accept-mode counterpart of an application-mode Table 0008 code: `AA` to `CA`, `AE`
 * to `CE`, `AR` to `CR`. An accept-mode code is already its own counterpart.
 *
 * `CR` for a rejected message is what the acknowledgement profile of this transport
 * requires for an unrecognised message type or trigger event.
 *
 * @internal
 */
export function acceptModeCounterpart(code: Table0008Code): Table0008Code {
  switch (code) {
    case "AA":
      return "CA";
    case "AE":
      return "CE";
    case "AR":
      return "CR";
    case "CA":
    case "CE":
    case "CR":
      return code;
  }
}
