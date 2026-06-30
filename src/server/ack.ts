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

/**
 * Build a minimal original-mode HL7 v2 acknowledgement from raw inbound payload bytes,
 * **without a parser** (parser-driven ACKs are the `@cosyte/mllp/ack-from-hl7` subpath).
 *
 * Splits the payload on `CR` to locate the `MSH` segment, then on `|` to read fields.
 * The ACK swaps sender/receiver per HL7 ACK rules, echoes the inbound MSH-10 into MSA-2
 * (§2.9.2.2), sets MSA-1 to `code`, and — for negative codes — adds a **static, PHI-free**
 * MSA-3 reason. A fresh control ID fills the ACK's own MSH-10.
 *
 * **Never throws** and **never copies payload content** beyond the routing/control
 * metadata above. On a missing/malformed `MSH` it returns a minimal well-formed ACK
 * carrying `code` so the caller can still respond.
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
  const msaTail = code === "AE" || code === "AR" ? `|${NACK_TEXT[code]}` : "";

  const str = payload.toString("ascii");
  const segments = str.split("\r");
  const mshSegment = segments.find((seg) => seg.startsWith("MSH"));

  const newControlId = randomUUID().replace(/-/g, "").substring(0, 20);
  const now = timestamp14();

  if (mshSegment === undefined) {
    // No MSH to echo: emit a well-formed ACK carrying the requested code, no payload content.
    return Buffer.from(
      `MSH|^~\\&|||||${now}||ACK|${newControlId}|P|2.3\rMSA|${code}|${msaTail}\r`,
      "ascii",
    );
  }

  const fields = mshSegment.split("|");
  // MSH field indices after splitting on '|':
  //   [2]=sendingApp [3]=sendingFacility [4]=receivingApp [5]=receivingFacility
  //   [9]=MSH-10 control ID  [10]=processingId  [11]=version
  const sendingApp = fields[2] ?? "";
  const sendingFacility = fields[3] ?? "";
  const receivingApp = fields[4] ?? "";
  const receivingFacility = fields[5] ?? "";
  const inboundControlId = fields[9] ?? "";
  const processingId = fields[10] ?? "P";
  const version = fields[11] ?? "2.3";

  const ackStr =
    `MSH|^~\\&|${receivingApp}|${receivingFacility}|${sendingApp}|${sendingFacility}|${now}||ACK|${newControlId}|${processingId}|${version}\r` +
    `MSA|${code}|${inboundControlId}${msaTail}\r`;

  return Buffer.from(ackStr, "ascii");
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
