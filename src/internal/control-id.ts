/**
 * Byte-level MSH-10 / MSA-2 control-ID scanners — the **single** implementation
 * of "read the control ID off the wire", shared by everything in this package
 * that has to agree on what a control ID *is*.
 *
 * Three call sites depend on these bytes agreeing, and a disagreement between
 * any two of them is a lost clinical message:
 *
 *   * `src/client/correlator.ts` keys its in-flight store by the MSH-10 it
 *     extracts from the **outbound** frame, and looks an inbound ACK up by the
 *     MSA-2 it extracts from the **ACK** frame.
 *   * `src/server/ack.ts` (`buildRawAck`) echoes the inbound MSH-10 into MSA-2.
 *   * `src/ack-from-hl7/build.ts` verifies, against these same scanners, that
 *     the ACK it hands back really does echo MSH-10 verbatim.
 *
 * They live here — not in `client/` — because none of that is client policy.
 * It is the package's byte-level reading of HL7 v2.5.1 §2.5.4 (MSH-1 *defines*
 * the field separator) and §2.9.2.2 (MSA-2 echoes MSH-10 verbatim).
 *
 * **INTERNAL** — not part of the public API.
 *
 * @packageDocumentation
 */

const ASCII_M = 0x4d;
const ASCII_S = 0x53;
const ASCII_H = 0x48;
const ASCII_A = 0x41;
const SEGMENT_SEPARATOR_CR = 0x0d;
const SEGMENT_SEPARATOR_LF = 0x0a;

/**
 * Decode used for MSH-10 / MSA-2 control-ID extraction: `latin1`, NOT `ascii`.
 *
 * Node's `ascii` codec masks the high bit (`byte & 0x7f`), so it is a **lossy**
 * decode of the raw HL7 v2 bytes. Two consequences, both of which land squarely
 * on ACK correlation:
 *
 *   1. **Key collision.** The correlator keys its live store, its graveyard, and
 *      its ACK lookups by the extracted control-ID *string*. Under `ascii`, the
 *      distinct control IDs `A\x8B` and `A\x0B` both decode to `A\x0B`, so two
 *      concurrently in-flight sends collapse onto one key: the second `enqueue()`
 *      overwrites the first in the `Map`, and the first send's promise can never
 *      be settled by its own ACK. `latin1` is a 1:1 byte↔code-unit mapping, so
 *      every distinct byte string stays a distinct key.
 *   2. **Corrupted observability.** The extracted ID is what we hand to
 *      `MLLP_ACK_UNMATCHED_CONTROL_ID` / `MLLP_ACK_AFTER_TIMEOUT` warnings and to
 *      `MllpTimeoutError.messageControlId`. A masked ID is a control ID that never
 *      existed on the wire — it misdirects exactly the operator who is trying to
 *      trace a lost message.
 *
 * Reachable whenever MSH-18 declares a non-ASCII charset (e.g. `8859/1`), where
 * high-bit bytes in a control ID are legal.
 *
 * **`latin1` is the only byte-faithful decode available.** It is not merely the
 * best of several — it is the one that exists. Node's `Buffer` `latin1` codec is
 * true ISO-8859-1: a 1:1 map between the 256 byte values and U+0000–U+00FF, so
 * `Buffer.from(buf.toString("latin1"), "latin1")` is the identity for *every*
 * byte string. Every alternative loses bytes in exactly the range that matters:
 *
 *   * `ascii` masks the high bit (above).
 *   * `utf8` folds every invalid sequence onto `U+FFFD`, so all high-bit bytes in
 *     a non-UTF-8 payload collapse onto one key — the same collision as `ascii`.
 *   * `TextDecoder("iso-8859-1")` — which is what a charset-driven decode such as
 *     `@cosyte/hl7`'s `parseHL7(buffer, { charset })` uses — is **not** ISO-8859-1
 *     at all. The WHATWG Encoding Standard aliases the label `iso-8859-1` to
 *     **windows-1252**, which maps 0x80–0x9F to typography (`0x8B` → `U+2039`,
 *     `0x9C` → `U+0153`) rather than to `U+008B`/`U+009C`. Re-encoding that back
 *     to bytes does not round-trip. That is precisely the byte range a high-bit
 *     control ID lives in, which is why this package decodes control-ID bytes
 *     itself rather than delegating to a charset-aware parser.
 *
 * The key is byte-faithful, not text: under a multi-byte charset (`UNICODE UTF-8`)
 * a control ID reads back as its `latin1` bytes. Correlation stays correct — the
 * map is injective for any charset, which is the property the key needs, and the
 * one a charset-driven decode would lose.
 *
 * @internal
 */
export const CONTROL_ID_ENCODING = "latin1" as const;

/**
 * MSH-1 values we refuse to read a message with.
 *
 * MSH-1 *is* the field separator (§2.5.4), but a segment terminator (`CR`/`LF`) or
 * an MLLP framing byte (`VT`/`FS`) cannot be one: the first would end the segment it
 * is supposed to delimit, and the second cannot be written back into an ACK without
 * making the ACK unframeable. A payload can carry those bytes — the decoder tolerates
 * them behind `MLLP_PAYLOAD_CONTAINS_VT`/`_FS` — so this is reachable from
 * peer-controlled input. Every consumer treats such a message as unreadable, which is
 * what keeps them in agreement.
 * @internal
 */
const UNSAFE_FIELD_SEPARATORS: ReadonlySet<number> = new Set([
  SEGMENT_SEPARATOR_CR,
  SEGMENT_SEPARATOR_LF,
  0x0b, // VT — MLLP start block
  0x1c, // FS — MLLP end block
]);

/**
 * The field separator this message declares in MSH-1, or `null` if it declares none
 * we can use.
 *
 * `MSH` must **lead** the payload: HL7 v2.5.1 §2.5.1 makes MSH the first segment of
 * every message, and a payload that does not begin with it is not one we can read.
 * (This is also the only rule under which all three consumers can agree — see the
 * module docblock. `buildRawAck` used to hunt for an `MSH` anywhere in the payload
 * and would happily ACK a message the correlator had already given up on.)
 * @internal
 */
function readFieldSeparator(buf: Buffer): number | null {
  if (buf.length < 4) return null;
  if (buf[0] !== ASCII_M || buf[1] !== ASCII_S || buf[2] !== ASCII_H) return null;
  const fieldSep = buf[3] as number;
  return UNSAFE_FIELD_SEPARATORS.has(fieldSep) ? null : fieldSep;
}

/** The MSH segment, decoded and split into its fields. @internal */
export interface MshSegment {
  /** MSH-1 — the field separator this message declares (§2.5.4). One `latin1` char. */
  readonly fieldSep: string;
  /**
   * The MSH segment split on {@link fieldSep}. `[0]` is the literal `"MSH"`, `[1]` is
   * MSH-2 (the encoding characters), and thereafter the index **is** the field number:
   * `[9]` is MSH-10, `[10]` is MSH-11, `[11]` is MSH-12.
   */
  readonly fields: readonly string[];
}

/**
 * Read the MSH segment of an HL7 v2 payload — **the** scan, which every consumer in
 * this package goes through.
 *
 * Pure byte-level, never throws, returns `null` for anything it cannot read (Postel's
 * Law decoder side; CLAUDE.md guardrail). It:
 *
 *   * requires the payload to lead with `MSH` ({@link readFieldSeparator});
 *   * takes the field separator from MSH-1 rather than assuming `|` (§2.5.4);
 *   * **stops at the first `CR`/`LF`** — the segment terminator bounds the segment;
 *   * decodes only that segment, as `latin1` (see {@link CONTROL_ID_ENCODING}), so a
 *     high-bit byte survives and a 16 MB payload is not decoded to read its header.
 *
 * ## The segment terminator is load-bearing, not a detail
 *
 * An earlier version of this scan counted field separators without ever stopping at
 * the segment terminator. On a **truncated MSH** — `MSH|^~\&|EPIC|HOSP|MIRTH|LAB\r`,
 * which has only 6 fields — the count therefore ran *past the `CR`* and kept counting
 * separators inside the next segment. The "MSH-10" it returned was `PID-3`: the
 * patient's **MRN**. That value became the client's correlation key, and was carried
 * into `MllpTimeoutError.messageControlId` and the `MLLP_ACK_UNMATCHED_CONTROL_ID` /
 * `MLLP_ACK_AFTER_TIMEOUT` warnings — a patient identifier in a log line, and a
 * mis-read one at that. A field that does not exist must read as absent, never as the
 * next segment's contents.
 *
 * @example
 * ```typescript
 * const msh = readMshSegment(payloadBuffer);
 * // msh?.fields[9] === 'MSG00001'; msh?.fieldSep === '|'
 * ```
 *
 * @internal
 */
export function readMshSegment(buf: Buffer): MshSegment | null {
  const sep = readFieldSeparator(buf);
  if (sep === null) return null;

  // Bound the segment at its terminator BEFORE reading any field out of it.
  let segEnd = 3;
  while (
    segEnd < buf.length &&
    buf[segEnd] !== SEGMENT_SEPARATOR_CR &&
    buf[segEnd] !== SEGMENT_SEPARATOR_LF
  ) {
    segEnd++;
  }

  const fieldSep = String.fromCharCode(sep);
  const fields = buf.subarray(0, segEnd).toString(CONTROL_ID_ENCODING).split(fieldSep);
  return { fieldSep, fields };
}

/**
 * Extract MSH-10 (Message Control ID) from an HL7 v2 payload — the correlation key.
 *
 * A thin read off {@link readMshSegment}: `null` when the payload has no readable MSH,
 * when the MSH segment is too short to reach MSH-10, or when MSH-10 is present but
 * empty. It is **never** a value taken from another segment.
 *
 * @example
 * ```typescript
 * const id = extractMshControlId(payloadBuffer);
 * // id === 'MSG00001' | null
 * ```
 *
 * @internal
 */
export function extractMshControlId(buf: Buffer): string | null {
  const msh = readMshSegment(buf);
  if (msh === null) return null;
  const id = msh.fields[9];
  return id === undefined || id === "" ? null : id;
}

/**
 * Extract MSA-2 (acknowledged Message Control ID) from an HL7 v2 ACK payload.
 *
 * Pure byte-level scan — never throws, returns `null` for malformed input.
 * The field separator is taken from `buf[3]` (MSH establishes it for the whole
 * message). The MSA segment is located by scanning segment boundaries
 * (`\r` / `\n`).
 *
 * Decoded as `latin1` (see {@link CONTROL_ID_ENCODING}), matching both
 * {@link extractMshControlId} and `buildRawAck`'s verbatim MSH-10 → MSA-2 echo —
 * so an ACK for a high-bit control ID looks up the key the send actually
 * enqueued.
 *
 * @example
 * ```typescript
 * const acked = extractMsaControlId(ackPayloadBuffer);
 * // acked === 'MSG00001' | null
 * ```
 *
 * @internal
 */
export function extractMsaControlId(buf: Buffer): string | null {
  // Same MSH-1 rule as every other read in this module (MSH must lead; a framing or
  // segment byte is not a usable separator) — so the ACK is read under exactly the
  // separator the message declares, and an ACK this package refuses to read is one
  // no consumer here will claim to have read.
  const sep = readFieldSeparator(buf);
  if (sep === null) return null;
  const fieldSep = sep;
  const end = buf.length;
  let segStart = 0;
  while (segStart < end) {
    let segEnd = segStart;
    while (
      segEnd < end &&
      buf[segEnd] !== SEGMENT_SEPARATOR_CR &&
      buf[segEnd] !== SEGMENT_SEPARATOR_LF
    ) {
      segEnd++;
    }
    if (
      segEnd - segStart >= 4 &&
      buf[segStart] === ASCII_M &&
      buf[segStart + 1] === ASCII_S &&
      buf[segStart + 2] === ASCII_A &&
      buf[segStart + 3] === fieldSep
    ) {
      // MSA fields: [0]'MSA' [1]MSA-1 [2]MSA-2 ...
      // Iterate from the first separator (segStart+3) up to and including
      // segEnd. Treat `segEnd` as a synthetic separator so the final field
      // closes cleanly even without a trailing CR.
      let fieldIndex = 0;
      let fieldStart = 0;
      for (let i = segStart + 3; i <= segEnd; i++) {
        const b = i < segEnd ? (buf[i] as number) : fieldSep;
        if (b === fieldSep || b === SEGMENT_SEPARATOR_CR || b === SEGMENT_SEPARATOR_LF) {
          fieldIndex++;
          if (fieldIndex === 2) {
            fieldStart = i + 1;
          } else if (fieldIndex === 3) {
            if (fieldStart >= i) return null; // empty MSA-2
            return buf.subarray(fieldStart, i).toString(CONTROL_ID_ENCODING);
          }
        }
      }
      return null;
    }
    // Skip segment terminator bytes to advance to the next segment.
    while (
      segEnd < end &&
      (buf[segEnd] === SEGMENT_SEPARATOR_CR || buf[segEnd] === SEGMENT_SEPARATOR_LF)
    ) {
      segEnd++;
    }
    if (segEnd === segStart) return null; // no progress — malformed
    segStart = segEnd;
  }
  return null;
}
