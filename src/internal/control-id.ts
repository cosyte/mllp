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
 * Extract MSH-10 (Message Control ID) from an HL7 v2 payload.
 *
 * Pure byte-level scan — never throws, returns `null` for malformed input
 * (Postel's Law decoder side; CLAUDE.md guardrail). The field separator is
 * detected dynamically from `buf[3]` (the byte immediately after `MSH`), because
 * MSH-1 *is* the field separator (HL7 v2.5.1 §2.5.4) — it is never assumed to
 * be `|`.
 *
 * The field bytes are decoded as `latin1` (see {@link CONTROL_ID_ENCODING}) — a
 * lossless 1:1 byte↔code-unit mapping, so a high-bit control-ID byte survives
 * into the correlation key rather than being masked into a different ID.
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
  if (buf.length < 4) return null;
  if (buf[0] !== ASCII_M || buf[1] !== ASCII_S || buf[2] !== ASCII_H) {
    return null;
  }
  const fieldSep = buf[3] as number;
  // MSH layout when split by `fieldSep`:
  //   [0]'MSH'  [1]encChars  [2]MSH-3 ... [9]MSH-10 ...
  // Iteration: count separators starting at byte 3 (the first separator).
  // Increment fieldIndex on each separator. Capture range when fieldIndex
  // transitions 9→10 (i.e. just consumed MSH-10's closing separator).
  let fieldIndex = 0;
  let fieldStart = 0;
  const end = buf.length;
  // Iterate up to AND INCLUDING `end` so a buffer ending at MSH-10 (no
  // trailing separator) still closes the field cleanly via the synthetic
  // terminator (treated as a fieldSep at i === end).
  for (let i = 3; i <= end; i++) {
    const isSynthetic = i === end;
    const b = isSynthetic ? fieldSep : (buf[i] as number);
    const isFieldSep = b === fieldSep;
    const isSegEnd = b === SEGMENT_SEPARATOR_CR || b === SEGMENT_SEPARATOR_LF;
    if (isFieldSep || isSegEnd) {
      fieldIndex++;
      if (fieldIndex === 9) {
        if (isSegEnd) return null; // segment ended before MSH-10
        fieldStart = i + 1;
      } else if (fieldIndex === 10) {
        if (fieldStart >= i) return null; // empty MSH-10
        return buf.subarray(fieldStart, i).toString(CONTROL_ID_ENCODING);
      }
    }
  }
  return null;
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
  if (buf.length < 4) return null;
  if (buf[0] !== ASCII_M || buf[1] !== ASCII_S || buf[2] !== ASCII_H) {
    return null;
  }
  const fieldSep = buf[3] as number;
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
