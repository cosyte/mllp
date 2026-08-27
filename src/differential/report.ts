/**
 * The report shape the differential harness returns.
 *
 * Everything here is a plain, JSON-serializable value: strings, numbers, booleans and
 * arrays of them. No `Buffer`, no `Date`, no class instance, so a consumer can
 * `JSON.stringify` a run straight into a log pipeline or a review artifact and read it
 * programmatically without scraping human-readable text.
 *
 * ## What this report is, and what it is not
 *
 * It records what was **observed** on the wire. It is not a conformance verdict and never
 * becomes one: no field says a peer is conformant, no field says a run passed, and nothing
 * here decides whether an interface is fit to carry clinical traffic. That judgement
 * belongs to the people standing the interface up, with this evidence in front of them.
 *
 * ## Why no payload content appears anywhere
 *
 * A peer answering this harness may be a live engine holding real patients, and a report
 * is a diagnostic surface that gets written to a file, pasted into a ticket and mailed to
 * a vendor. So a deviation is described by its stable code, a byte offset and structural
 * counts only. Not a run of the peer's bytes, not the acknowledged control ID, not a
 * truncation of either.
 *
 * @packageDocumentation
 */

import type { WarningCode } from "../framing/registry.js";

/**
 * What became of one canonical exchange.
 *
 * - `answered`, the peer returned a decodable frame, so parity and correlation are
 *   reported for it.
 * - `unanswered`, the connection held and no complete frame arrived before the deadline.
 * - `undecodable-response`, bytes arrived and the decoder could not complete a frame from
 *   them even with every tolerance enabled. The deviation is still named by its code.
 * - `connection-refused`, the peer refused the connection outright.
 * - `connection-failed`, the connection could not be established for some other reason.
 * - `connection-dropped`, the connection was established and then went away mid-exchange.
 *
 * @example
 * ```typescript
 * const outcome: DifferentialExchangeOutcome = 'answered';
 * ```
 */
export type DifferentialExchangeOutcome =
  | "answered"
  | "unanswered"
  | "undecodable-response"
  | "connection-refused"
  | "connection-failed"
  | "connection-dropped";

/**
 * Whether the peer's response frame was byte-identical to the canonical Release 1 block.
 *
 * `not-observed` is the honest answer when no frame arrived: an exchange that was never
 * answered has no parity, and reporting one as a failure would confuse a silent peer with
 * a mis-framing one.
 *
 * @example
 * ```typescript
 * const parity: DifferentialParityOutcome = 'match';
 * ```
 */
export type DifferentialParityOutcome = "match" | "deviation" | "not-observed";

/**
 * Whether the peer's acknowledgement echoed the control ID of the message it answered.
 *
 * `absent` means the response carried no readable acknowledged control ID at all, which
 * is a different failure from echoing the wrong one and is worth telling apart.
 *
 * @example
 * ```typescript
 * const correlation: DifferentialCorrelationOutcome = 'match';
 * ```
 */
export type DifferentialCorrelationOutcome = "match" | "mismatch" | "absent" | "not-observed";

/**
 * One named deviation, located by offset.
 *
 * @example
 * ```typescript
 * const deviation: DifferentialDeviation = { code: 'MLLP_MISSING_LEADING_VT', byteOffset: 0 };
 * ```
 */
export interface DifferentialDeviation {
  /** The package's stable warning code for this deviation. */
  readonly code: WarningCode;
  /** Byte offset within the peer's response stream where it was detected. */
  readonly byteOffset: number;
}

/**
 * What one canonical exchange produced.
 *
 * @example
 * ```typescript
 * for (const exchange of report.exchanges) {
 *   console.log(exchange.exchangeId, exchange.outcome, exchange.byteParity);
 * }
 * ```
 */
export interface DifferentialExchangeReport {
  /** The corpus identifier of the message that was sent. Names a message, never a patient. */
  readonly exchangeId: string;
  /** What became of the exchange. */
  readonly outcome: DifferentialExchangeOutcome;
  /** Whether the response frame matched the canonical Release 1 block byte for byte. */
  readonly byteParity: DifferentialParityOutcome;
  /** Whether the response echoed the control ID of the message that was sent. */
  readonly correlation: DifferentialCorrelationOutcome;
  /** Every stable warning code observed on this exchange, in the order they were seen. */
  readonly warningCodes: readonly WarningCode[];
  /** The same deviations with the byte offset each was detected at. */
  readonly deviations: readonly DifferentialDeviation[];
  /** How many bytes were sent to the peer, framing included. A count, never content. */
  readonly requestByteCount: number;
  /** How many bytes were read back before the exchange concluded. A count, never content. */
  readonly responseByteCount: number;
  /** The response deadline this exchange waited, in milliseconds. */
  readonly deadlineMs: number;
  /** How long the exchange actually took, in milliseconds. */
  readonly elapsedMs: number;
}

/**
 * The overall shape of a run, in three values plus the skip.
 *
 * - `parity-observed`, every attempted exchange was answered with a byte-identical
 *   canonical block and a correlating acknowledgement.
 * - `deviations-observed`, at least one exchange was answered and at least one exchange
 *   deviated, went unanswered or failed.
 * - `no-observation`, nothing was answered, so the run observed nothing about the peer.
 * - `skipped`, no peer was configured and nothing was sent.
 *
 * **None of these is a pass**, and `parity-observed` in particular is not one: it says
 * what this corpus saw on this run, not that a peer is conformant.
 *
 * @example
 * ```typescript
 * const result: DifferentialRunResult = 'no-observation';
 * ```
 */
export type DifferentialRunResult =
  | "parity-observed"
  | "deviations-observed"
  | "no-observation"
  | "skipped";

/**
 * Why a run was skipped, when it was.
 *
 * @example
 * ```typescript
 * const reason: DifferentialSkipReason = 'no-peer-configured';
 * ```
 */
export type DifferentialSkipReason = "no-peer-configured";

/**
 * The report a run returns. Frozen, and JSON-serializable throughout.
 *
 * @example
 * ```typescript
 * const report = await runDifferential({ peer: '127.0.0.1:2575' });
 * console.log(JSON.stringify(report, null, 2));
 * ```
 */
export interface DifferentialReport {
  /** The peer that was contacted, or `undefined` when the run was skipped. */
  readonly peer: DifferentialReportPeer | undefined;
  /** What the run as a whole observed. Never a conformance verdict. */
  readonly result: DifferentialRunResult;
  /** Why the run was skipped, or `undefined` when it ran. */
  readonly skipReason: DifferentialSkipReason | undefined;
  /** One entry per canonical exchange attempted, in the order they ran. */
  readonly exchanges: readonly DifferentialExchangeReport[];
  /** How many exchanges were attempted. */
  readonly exchangesAttempted: number;
  /** How many of them the peer answered with a decodable frame. */
  readonly exchangesAnswered: number;
  /** The per-exchange response deadline the run used, in milliseconds. */
  readonly deadlineMs: number;
  /** When the run started, as an ISO 8601 string. */
  readonly startedAt: string;
  /** When the run finished, as an ISO 8601 string. */
  readonly finishedAt: string;
}

/**
 * The peer a report describes. Host and port as configured, nothing resolved or probed.
 *
 * @example
 * ```typescript
 * const peer: DifferentialReportPeer = { host: '127.0.0.1', port: 2575 };
 * ```
 */
export interface DifferentialReportPeer {
  /** Host name or address literal the run connected to. */
  readonly host: string;
  /** TCP port the run connected to. */
  readonly port: number;
}
