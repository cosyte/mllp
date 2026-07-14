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
 * making the ACK unframeable (strict `encodeFrame` throws `MLLP_PAYLOAD_CONTAINS_VT`/`_FS`).
 *
 * **How a payload with such a byte reaches us.** The plainest route is that `buildRawAck` is
 * a **public export**, so a caller can hand any `Buffer` straight to it, decoder or no
 * decoder; these scanners also run on **outbound** payloads the caller supplies. But it can
 * come off the wire too: a `VT` mid-payload makes `FrameReader` discard what it accumulated
 * and start over (`MLLP_TRAILING_BYTES`), so a *delivered* payload never contains a `VT` — but
 * a delivered payload CAN contain an `FS`. Under the `allowMissingLeadingVt` tolerance a non-VT,
 * non-whitespace first byte is taken as payload byte 0, and `FS` (0x1C) is neither, so
 * `FS "MSH…" FS CR` delivers a payload whose byte 0 is `0x1C`. Either way the guard is
 * warranted, and neither route depends on the false premise that the decoder screens these out.
 * @internal
 */
const UNSAFE_FIELD_SEPARATORS: ReadonlySet<number> = new Set([
  SEGMENT_SEPARATOR_CR,
  SEGMENT_SEPARATOR_LF,
  0x0b, // VT — MLLP start block
  0x1c, // FS — MLLP end block
]);

/** True iff the `CR`/`LF`-delimited segment starting at `i` is an `MSH`. @internal */
function isMshSegmentAt(buf: Buffer, i: number): boolean {
  return (
    i + 3 < buf.length &&
    buf[i] === ASCII_M &&
    buf[i + 1] === ASCII_S &&
    buf[i + 2] === ASCII_H &&
    !UNSAFE_FIELD_SEPARATORS.has(buf[i + 3] as number)
  );
}

/** Index of the byte after the `CR`/`LF`-delimited segment starting at `i`. @internal */
function segmentEnd(buf: Buffer, i: number): number {
  let end = i;
  while (
    end < buf.length &&
    buf[end] !== SEGMENT_SEPARATOR_CR &&
    buf[end] !== SEGMENT_SEPARATOR_LF
  ) {
    end++;
  }
  return end;
}

/**
 * Locate the message's `MSH` segment: the **first** `CR`/`LF`-delimited segment whose
 * first three bytes are `MSH` and whose 4th byte is a usable field separator. Returns
 * its `[start, end)` bounds, or `null` if the payload has no such segment.
 *
 * ## Why we search rather than demand `MSH` at byte 0
 *
 * §2.5.1 does make `MSH` the first segment of a *message*, and it is tempting to read
 * that as "byte 0 or it is not HL7" — that is what an earlier version of this module
 * did, to force its three consumers into agreement. It was a **tolerance regression**,
 * and it caused the exact harm this module exists to prevent. Two shapes reach us with
 * a perfectly good MSH-10 that is not at byte 0:
 *
 *   * **A leading `CR`.** The MLLP decoder passes it straight through into the payload
 *     (it special-cases only `VT`/`FS`), and real senders emit it.
 *   * **A batch header.** `FHS`/`BHS` precede the `MSH` (§2.10.3).
 *
 * Under the byte-0 rule both read as "no MSH", so `buildRawAck` emitted a **positive
 * `AA` with an empty MSA-2 and no warning**: the sender — which keyed on the MSH-10 it
 * sent — cannot correlate it, times out, resends, and the receiver commits a
 * **duplicate clinical message**. Silently discarding a field that is *present* is the
 * worst thing a lenient reader can do, and this package's decoder is emphatically
 * lenient (Postel's Law; see CLAUDE.md).
 *
 * The consumers still agree — they simply agree at the **tolerant** fixed point rather
 * than the lossy one. Agreement was never the hard part; agreeing on the *right* answer
 * is.
 * @internal
 */
function findMshSegment(buf: Buffer): { start: number; end: number } | null {
  let segStart = 0;
  while (segStart < buf.length) {
    const end = segmentEnd(buf, segStart);
    if (isMshSegmentAt(buf, segStart)) return { start: segStart, end };
    // Advance past this segment's terminator bytes (handles `CRLF` as one break).
    let next = end;
    while (
      next < buf.length &&
      (buf[next] === SEGMENT_SEPARATOR_CR || buf[next] === SEGMENT_SEPARATOR_LF)
    ) {
      next++;
    }
    if (next === segStart) return null; // no progress — malformed
    segStart = next;
  }
  return null;
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
 *   * **locates** the MSH — the first `CR`/`LF`-delimited segment that starts with
 *     `MSH` — rather than demanding it at byte 0, so a leading `CR` or an `FHS`/`BHS`
 *     batch header cannot hide a control ID that is plainly there ({@link findMshSegment});
 *   * takes the field separator from MSH-1 rather than assuming `|` (§2.5.4);
 *   * **bounds the field scan at that segment's terminator**;
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
 * The two rules are independent, and both are needed. Bounding the scan is what kills
 * the PID-3 read. **Locating** the MSH (rather than demanding it at byte 0) is what
 * stops the bound from turning into a tolerance regression that silently drops a
 * control ID which is present — see {@link findMshSegment}.
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
  const at = findMshSegment(buf);
  if (at === null) return null;

  // The separator is MSH-1 — the 4th byte OF THE MSH SEGMENT, wherever that segment
  // begins. `findMshSegment` has already rejected an unusable one.
  const fieldSep = String.fromCharCode(buf[at.start + 3] as number);
  // `at.end` is the segment's terminator: the field split cannot reach past it.
  const fields = buf.subarray(at.start, at.end).toString(CONTROL_ID_ENCODING).split(fieldSep);
  return { fieldSep, fields };
}

/**
 * Strip **leading segment terminators only** — `CR`/`LF` bytes before the first segment.
 *
 * This is the whole of what the parser-backed ACK builder needs re-based, and it is
 * deliberately the *minimum*. `@cosyte/hl7`'s `parseHL7` requires `MSH` to be the first
 * segment and throws `NO_MSH_SEGMENT` otherwise, so a leading `CR` — which the MLLP
 * decoder passes straight through into the payload — would otherwise send `buildMllpAck`
 * down its unparseable fallback for a message whose MSH-10 is plainly readable. A leading
 * `CR`/`LF` is pure segment-terminator noise: it carries **no data**, so dropping it
 * cannot hide anything.
 *
 * ## What this deliberately does NOT do: skip an `FHS`/`BHS` batch header
 *
 * An earlier version of this function re-based on the *located `MSH`*, which also skipped
 * a batch envelope. That was a serious mistake. A batch (§2.10.3) is
 * `[FHS] { [BHS] { MSH … } [BTS] } [FTS]` — a **sequence of messages**. Re-basing on the
 * first `MSH` handed `parseHL7` message 1 and silently discarded every later `MSH`, the
 * `BTS` count, and the `FTS`. `buildMllpAck` then returned a confident positive **`AA`
 * correlated to message 1, with zero warnings**, for a batch whose messages 2..N it had
 * never looked at. The sender reads that as "the batch is accepted" — so those messages
 * are lost outright, or time out and resend as **duplicate clinical messages**.
 *
 * Batch ACK is a real feature and is tracked separately. It is not something to arrive at
 * by accident, via a byte-offset helper, on the way to fixing something else. Until it is
 * built deliberately, an `FHS`/`BHS` envelope must fall through to `parseHL7`'s
 * `NO_MSH_SEGMENT` and out into the **warned, non-positive `AE` fallback** — a loud
 * refusal to ACK what we did not read. That is the fail-safe answer and it is what the
 * package did before this item touched it.
 *
 * @internal
 */
export function stripLeadingSegmentTerminators(buf: Buffer): Buffer {
  let i = 0;
  while (i < buf.length && (buf[i] === SEGMENT_SEPARATOR_CR || buf[i] === SEGMENT_SEPARATOR_LF)) {
    i++;
  }
  return i === 0 ? buf : buf.subarray(i);
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
 * Pure byte-level scan — never throws, returns `null` for malformed input. The field
 * separator comes from the ACK's own MSH-1, read through {@link readMshSegment} — the
 * same tolerant locate every other read in this module uses, so an ACK whose `MSH` is
 * not at byte 0 is still read rather than silently discarded. The `MSA` segment is
 * then located by scanning segment boundaries (`\r` / `\n`).
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
  // MSH-1 establishes the separator for the whole message, including its MSA.
  const msh = readMshSegment(buf);
  if (msh === null) return null;
  const fieldSep = msh.fieldSep.charCodeAt(0);
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
