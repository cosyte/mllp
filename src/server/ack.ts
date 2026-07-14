/**
 * Server-side MLLP acknowledgement construction and the **fail-safe commit contract**.
 *
 * This module owns the byte-level ACK builder used by {@link MllpServer}'s auto-ACK
 * path, the HL7 Table 0008 acknowledgement-code union, and the error type a message
 * handler throws to request a specific negative acknowledgement.
 *
 * ## Why this is safety-critical
 *
 * A positive acknowledgement (`AA`) tells the sender "you may forget this message — I
 * have it." If a server emits `AA` *before* the message is durably handled and then the
 * process crashes, the message is **silently lost** with no record on either side. For
 * clinical messages (an admit, an order, a result) that is a patient-safety failure.
 *
 * The contract this module enforces: a positive ACK (`AA`) is only built once the
 * application handler has resolved success. A handler that throws or rejects yields a
 * **negative** ACK (`AE` by default, `AR` when the handler asks for it) — never `AA`.
 *
 * Spec: HL7 v2.5.1 ch. 2 §2.9.2 (original acknowledgement mode), §2.9.3 (enhanced
 * accept/application acknowledgement), Table 0008 (Acknowledgment Code), §2.9.2.2
 * (MSA-2 echoes the inbound MSH-10 message control ID).
 *
 * @packageDocumentation
 */

import { randomUUID } from "node:crypto";

import { readMshSegment } from "../internal/control-id.js";

/**
 * HL7 Table 0008 — Acknowledgment Code. A **stable public API**.
 *
 * Two families, by mode (HL7 v2.5.1 §2.9):
 *
 * - **Original mode (§2.9.2):** `AA` accept, `AE` application error, `AR` application
 *   reject. The single ACK reports application-level outcome.
 * - **Enhanced mode (§2.9.3):** `CA` commit accept, `CE` commit error, `CR` commit
 *   reject — the *accept* acknowledgement, distinct from a later application ACK.
 *
 * `AE` vs `AR`: `AE` is a processing **error** (the sender may resend later, e.g. a
 * transient downstream outage); `AR` is a **reject** (the sender should not resend the
 * message unchanged, e.g. it is structurally unacceptable). `@cosyte/mllp` builds
 * original-mode ACKs; the `C*` codes are surfaced in the type for completeness and for
 * callers that build their own enhanced-mode ACKs via `autoAck: fn`.
 *
 * @example
 * ```typescript
 * import type { AckCode } from '@cosyte/mllp';
 * const code: AckCode = 'AE';
 * ```
 */
export type AckCode = "AA" | "AE" | "AR" | "CA" | "CE" | "CR";

/**
 * The negative original-mode acknowledgement codes a failed handler can produce.
 *
 * @example
 * ```typescript
 * import type { NegativeAckCode } from '@cosyte/mllp';
 * const code: NegativeAckCode = 'AR';
 * ```
 */
export type NegativeAckCode = "AE" | "AR";

/**
 * Error a message handler throws to control the negative acknowledgement the server
 * returns. Throwing **any** error from a commit-gated handler yields `AE` by default;
 * throw an `MllpAckError` to choose `AR` (application reject) instead.
 *
 * The `message` is **never** copied into the ACK bytes or any emitted event — it may
 * carry PHI. Only the static, non-PHI `ackCode` influences the wire response.
 *
 * @example
 * ```typescript
 * import { createServer, MllpAckError } from '@cosyte/mllp';
 *
 * createServer({
 *   autoAck: 'AA',
 *   onMessage: async (payload) => {
 *     if (!isAcceptable(payload)) {
 *       // sender should NOT resend unchanged -> AR
 *       throw new MllpAckError('unsupported message type', { ackCode: 'AR' });
 *     }
 *     await db.commit(payload); // throw here -> AE (resend may succeed)
 *   },
 * });
 * ```
 */
export class MllpAckError extends Error {
  /** The negative acknowledgement code to return (`AE` or `AR`). */
  readonly ackCode: NegativeAckCode;

  /**
   * @param message - Diagnostic text for the thrower. Never placed on the wire (may carry PHI).
   * @param opts.ackCode - Negative code to return. Default `'AE'`.
   * @param opts.cause - Underlying error, preserved on `.cause`.
   */
  constructor(message: string, opts?: { ackCode?: NegativeAckCode; cause?: unknown }) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "MllpAckError";
    this.ackCode = opts?.ackCode ?? "AE";
  }
}

/**
 * Resolve the negative acknowledgement code for a handler failure.
 *
 * An {@link MllpAckError} carries an explicit `ackCode`; any other thrown value maps to
 * `AE` (application error — the default, since most handler failures are transient and
 * a resend may succeed).
 *
 * @example
 * ```typescript
 * import { resolveNackCode, MllpAckError } from '@cosyte/mllp';
 * resolveNackCode(new Error('boom'));                          // 'AE'
 * resolveNackCode(new MllpAckError('nope', { ackCode: 'AR' })); // 'AR'
 * ```
 */
export function resolveNackCode(err: unknown): NegativeAckCode {
  if (err instanceof MllpAckError) return err.ackCode;
  if (typeof err === "object" && err !== null && "ackCode" in err && err.ackCode === "AR") {
    return "AR";
  }
  return "AE";
}

/** Static, PHI-free MSA-3 text for negative acknowledgements. Never derived from payload. */
const NACK_TEXT: Readonly<Record<NegativeAckCode, string>> = Object.freeze({
  AE: "message could not be processed",
  AR: "message rejected",
});

/** HL7 default encoding characters (MSH-2), used when the inbound declares none. */
const DEFAULT_ENCODING_CHARACTERS = "^~\\&";

/** HL7 default field separator (MSH-1), used when the inbound declares none usable. */
const DEFAULT_FIELD_SEPARATOR = "|";

/**
 * Encoding characters (MSH-2) we refuse to echo into the ACK we build.
 *
 * The inbound's MSH-1/MSH-2 are echoed so the ACK's *structure* matches the
 * message it answers — but a delimiter is a byte we then write ourselves, all
 * over the ACK. `VT` (0x0B) and `FS` (0x1C) are the MLLP framing bytes, and `CR`
 * / `LF` are segment terminators: any of them adopted as an encoding character
 * would make the ACK unframeable (`encodeFrame` is strict) or unparseable. A
 * payload can legitimately carry those bytes — the decoder tolerates them behind
 * `MLLP_PAYLOAD_CONTAINS_VT`/`_FS` — so this is reachable from peer-controlled
 * input. Fall back to the HL7 defaults: an ACK that frames and parses beats an
 * ACK that cannot be sent at all.
 *
 * The equivalent rule for MSH-1 lives in `src/internal/control-id.ts`, where it
 * belongs: an unusable field separator makes the message unreadable for *every*
 * consumer, not just for this builder, and `readMshSegment` returning `null` is
 * what keeps them all agreeing on that.
 */
const UNSAFE_DELIMITER = /[\r\n\v\x1c]/;

/**
 * Build a minimal original-mode HL7 v2 acknowledgement from raw inbound payload bytes,
 * **without a parser** (parser-driven ACKs are the `@cosyte/mllp/ack-from-hl7` subpath).
 *
 * Splits the payload on `CR`/`LF` to locate the `MSH` segment, reads the field separator
 * from **MSH-1** and the encoding characters from **MSH-2**, then splits the segment on
 * that separator to read fields. The ACK swaps sender/receiver per HL7 ACK rules, echoes
 * the inbound MSH-10 into MSA-2 (§2.9.2.2), sets MSA-1 to `code`, and — for negative
 * codes — adds a **static, PHI-free** MSA-3 reason. A fresh control ID fills the ACK's
 * own MSH-10.
 *
 * ## Why the delimiters are read, not assumed
 *
 * MSH-1 **is** the field separator (HL7 v2.5.1 §2.5.4): the byte at offset 3 of the MSH
 * segment *defines* it for the whole message. `|` is overwhelmingly common but it is a
 * convention, not the spec. Assuming it was wrong in two compounding ways:
 *
 *   1. **Reading.** Splitting a `!`-delimited message on `|` yields ONE field, so every
 *      echoed field — including MSH-10 — came back empty. The ACK went out as
 *      `MSA|AA|` with **no correlation id at all**: the sender cannot match it, times
 *      out, and resends → a duplicate clinical message. That is the exact failure this
 *      package's correlator exists to prevent, manufactured by the ACK builder itself.
 *   2. **Writing.** The echoed MSH-3..6 and MSH-10 field *content* is copied verbatim
 *      from the inbound, still escaped against the **inbound's** encoding characters. Re-
 *      emitting that content under a different delimiter set silently reinterprets it:
 *      an inbound whose component separator is `#` and whose MSH-10 is `ID#X` would be
 *      re-emitted under `^~\&` as the literal `ID#X`, which the sender then reads as a
 *      single component rather than two. Echoing MSH-1 and MSH-2 keeps the content and
 *      the delimiters that define it together.
 *
 * ## It reads the MSH through the SHARED scanner
 *
 * The MSH read is `readMshSegment` from `src/internal/control-id.ts` — the same call the
 * client's correlator makes to derive the key it will later match this ACK against. That
 * is deliberate and it is the whole point: this builder used to re-derive the read itself
 * (`payload.toString("latin1").split(...)`, hunting for an `MSH` anywhere in the payload),
 * and the two disagreed on real inputs. On `MSH|^~\&|EPIC|HOSP|MIRTH|LAB\rPID|...` the
 * correlator keyed on one string while this builder echoed a different one; on a payload
 * with a leading `LF` the correlator gave up while this builder happily ACKed. Every such
 * disagreement is an ACK the sender cannot match → timeout → resend → **duplicate clinical
 * message**. One scan, one answer, or the guarantee is worthless.
 *
 * **Never throws** and **never copies payload content** beyond the routing/control
 * metadata above — `readMshSegment` stops at the MSH's segment terminator, so no field of
 * any later segment (PID and friends) can be reached, let alone echoed. On a missing or
 * unreadable `MSH` it returns a minimal well-formed ACK carrying `code` so the caller can
 * still respond.
 *
 * @param payload - Raw decoded HL7 v2 payload bytes (MLLP framing already stripped).
 * @param code - MSA-1 acknowledgement code to emit.
 * @returns ACK payload bytes (no framing — the caller wraps with `encodeFrame`).
 *
 * @example
 * ```typescript
 * import { buildRawAck } from '@cosyte/mllp';
 * const ack = buildRawAck(inboundPayload, 'AE'); // MSA|AE|<inbound MSH-10>|message could not be processed
 * ```
 */
export function buildRawAck(payload: Buffer, code: AckCode): Buffer {
  // THE shared read (see the docblock). `latin1`, MSH-1 taken from the message, scan bounded
  // at the segment terminator. `null` means "this package cannot read this message" — and it
  // means that for the correlator too, which is exactly the agreement we need.
  const msh = readMshSegment(payload);

  const newControlId = randomUUID().replace(/-/g, "").substring(0, 20);
  const now = timestamp14();

  if (msh === null) {
    // No usable MSH to echo: emit a well-formed ACK carrying the requested code, no payload
    // content. HL7 defaults, since the inbound declared no delimiters we can trust.
    const s = DEFAULT_FIELD_SEPARATOR;
    const e = DEFAULT_ENCODING_CHARACTERS;
    const tail = code === "AE" || code === "AR" ? `${s}${NACK_TEXT[code]}` : "";
    return Buffer.from(
      `MSH${s}${e}${s}${s}${s}${s}${s}${now}${s}${s}ACK${s}${newControlId}${s}P${s}2.3\r` +
        `MSA${s}${code}${s}${tail}\r`,
      "latin1",
    );
  }

  const { fieldSep, fields } = msh;
  // MSH field indices after splitting on the field separator:
  //   [1]=MSH-2 encoding chars
  //   [2]=sendingApp [3]=sendingFacility [4]=receivingApp [5]=receivingFacility
  //   [9]=MSH-10 control ID  [10]=processingId  [11]=version
  const declaredEnc = fields[1] ?? "";
  const encodingChars =
    declaredEnc !== "" && !UNSAFE_DELIMITER.test(declaredEnc)
      ? declaredEnc
      : DEFAULT_ENCODING_CHARACTERS;
  const sendingApp = fields[2] ?? "";
  const sendingFacility = fields[3] ?? "";
  const receivingApp = fields[4] ?? "";
  const receivingFacility = fields[5] ?? "";
  const inboundControlId = fields[9] ?? "";
  const processingId = fields[10] ?? "P";
  const version = fields[11] ?? "2.3";

  const s = fieldSep;
  const msaTail = code === "AE" || code === "AR" ? `${s}${NACK_TEXT[code]}` : "";
  const ackStr =
    `MSH${s}${encodingChars}${s}${receivingApp}${s}${receivingFacility}${s}${sendingApp}${s}${sendingFacility}${s}${now}${s}${s}ACK${s}${newControlId}${s}${processingId}${s}${version}\r` +
    `MSA${s}${code}${s}${inboundControlId}${msaTail}\r`;

  // `latin1` on the way back out too, so a high-bit byte echoed from the inbound MSH-10 is
  // preserved rather than re-masked. Paired with the `latin1` decode above, the inbound control ID
  // round-trips byte-exact into MSA-2 — and because the ACK carries the inbound's own MSH-1, the
  // sender's MSA-2 scanner reads back the very bytes it keyed its in-flight store on.
  return Buffer.from(ackStr, "latin1");
}

/** 14-char HL7 timestamp `YYYYMMDDHHmmss` in UTC. */
function timestamp14(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    String(d.getUTCFullYear()) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}
