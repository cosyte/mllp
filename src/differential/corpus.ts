/**
 * The canonical exchange corpus the differential harness sends, and the canonical
 * acknowledgement it compares a peer's answer against.
 *
 * Every message here is **synthetic**: the identifiers, names and dates are fabricated
 * and declared as such in this repository's PHI allow-list. Nothing in this file is, or
 * may become, a real patient. The corpus ships inside the published package so a consumer
 * who installed `@cosyte/mllp` and has no checkout of this repository can still run the
 * harness against their own interface engine.
 *
 * Each message is written as segment string literals joined by the HL7 segment separator
 * (`CR`) rather than as a byte blob, deliberately: the identifiers stay readable to a human
 * reviewer and to this repository's structured PHI scan, which is what keeps a planted
 * identifier from slipping through as opaque bytes.
 *
 * @example
 * ```typescript
 * import { canonicalExchanges } from '@cosyte/mllp';
 * for (const exchange of canonicalExchanges()) {
 *   console.log(exchange.id, exchange.payload.length);
 * }
 * ```
 *
 * @packageDocumentation
 */

import { CONTROL_ID_ENCODING } from "../internal/control-id.js";

/**
 * One send-and-await-response pair the harness runs against a peer.
 *
 * `payload` is the HL7 v2 message body with **no** MLLP framing on it. The harness frames
 * it canonically (`VT` + payload + `FS` + `CR`) with the package's own strict encoder
 * before it goes on the wire, so what a peer receives is the Release 1 block this package
 * emits for every message.
 *
 * @example
 * ```typescript
 * const [first] = canonicalExchanges();
 * // first?.id === 'adt-a01'; first?.controlId === 'MSG00001'
 * ```
 */
export interface CanonicalExchange {
  /**
   * Stable identifier for this exchange, and the identifier the report uses. It names the
   * message, never a patient, so it is safe to log.
   */
  readonly id: string;
  /** One-line description of what the message is, for a human reading the report. */
  readonly description: string;
  /**
   * The `MSH-10` message control ID this message carries. A conformant peer echoes it in
   * the `MSA-2` of its acknowledgement, which is the correlation the harness checks.
   */
  readonly controlId: string;
  /** The unframed HL7 v2 message bytes. A fresh copy per call; mutating it is harmless. */
  readonly payload: Buffer;
}

/** The HL7 v2 segment separator. Segments are joined with it to form a message body. */
const SEGMENT_SEPARATOR = "\r";

/**
 * An admit message. Patient identity is fabricated: the `900000000` block is a reserved
 * synthetic range that is never a real medical record number.
 */
const ADT_A01_SEGMENTS: readonly string[] = [
  "MSH|^~\\&|SENDING_APP|SENDING_FAC|RECV_APP|RECV_FAC|20260709120000||ADT^A01|MSG00001|P|2.5",
  "EVN|A01|20260709120000",
  "PID|1||900000001^^^FAC^MR||DOE^JANE^Q||19700101|F",
  "PV1|1|I|WARD^101^1^FAC",
];

/** An observation result message. Same reserved synthetic identifier range. */
const ORU_R01_SEGMENTS: readonly string[] = [
  "MSH|^~\\&|LAB|LFAC|EHR|EFAC|20260709130000||ORU^R01|MSG00002|P|2.5",
  "PID|1||900000002^^^FAC^MR||ROE^RICHARD",
  "OBR|1||ORD123|CBC^COMPLETE BLOOD COUNT",
  "OBX|1|NM|WBC^WHITE BLOOD COUNT||7.2|10*9/L|4.0-11.0|N",
];

/**
 * The canonical positive acknowledgement for the admit message above: its `MSA-2` echoes
 * that message's `MSH-10`. It is the reference answer, not a message the harness sends.
 */
const ACK_AA_SEGMENTS: readonly string[] = [
  "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
  "MSA|AA|MSG00001",
];

/**
 * Bytes of a message written as segments. `latin1` is the byte-faithful decode this
 * package uses everywhere a control ID crosses the boundary, so a corpus message means the
 * same bytes here as it does to the correlation scanners.
 */
function messageBytes(segments: readonly string[]): Buffer {
  return Buffer.from(segments.join(SEGMENT_SEPARATOR), CONTROL_ID_ENCODING);
}

/**
 * The canonical exchange corpus, freshly built on every call so a caller cannot mutate the
 * corpus another caller will send.
 *
 * Two messages, both drawn from the framing goldens this package already pins itself
 * against, so what a consumer sends at their own engine is byte-identical to what this
 * package's own framing tests assert. The positive acknowledgement golden is deliberately
 * NOT one of them: it is the reference ANSWER (see {@link canonicalAcknowledgement}), and
 * an engine that correctly declines to acknowledge an unsolicited acknowledgement would
 * otherwise be reported as having failed to answer.
 *
 * @returns One entry per exchange, in the order the harness runs them.
 *
 * @example
 * ```typescript
 * const exchanges = canonicalExchanges();
 * // exchanges.map((e) => e.id) is ['adt-a01', 'oru-r01']
 * ```
 */
export function canonicalExchanges(): readonly CanonicalExchange[] {
  return Object.freeze([
    Object.freeze<CanonicalExchange>({
      id: "adt-a01",
      description: "Patient admit, four segments, synthetic identity",
      controlId: "MSG00001",
      payload: messageBytes(ADT_A01_SEGMENTS),
    }),
    Object.freeze<CanonicalExchange>({
      id: "oru-r01",
      description: "Observation result, four segments, synthetic identity",
      controlId: "MSG00002",
      payload: messageBytes(ORU_R01_SEGMENTS),
    }),
  ]);
}

/**
 * The canonical positive acknowledgement, unframed, freshly built on every call.
 *
 * This is what a conformant Release 1 peer's answer to the first canonical exchange looks
 * like on the wire once the framing is stripped. The harness never sends it; it is here so
 * a test double, or a consumer building one, can answer with the shape the package itself
 * emits.
 *
 * @returns The unframed acknowledgement bytes.
 *
 * @example
 * ```typescript
 * import { canonicalAcknowledgement, encodeFrame } from '@cosyte/mllp';
 * const wire = encodeFrame(canonicalAcknowledgement());
 * // wire[0] === 0x0b
 * ```
 */
export function canonicalAcknowledgement(): Buffer {
  return messageBytes(ACK_AA_SEGMENTS);
}
