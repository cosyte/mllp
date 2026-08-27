/**
 * Differential verification against a peer you name.
 *
 * Point the harness at an interface engine, and it sends the canonical exchange corpus at
 * it and reports, per exchange, whether the frame that came back was byte-identical to the
 * canonical Release 1 block and whether its acknowledgement echoed the control ID of the
 * message it answered. Deviations are named by this package's stable warning codes.
 *
 * It reports what it observed. It does not decide whether an engine is conformant, and it
 * does not decide whether an interface is fit for clinical traffic.
 *
 * **A run sends synthetic patient messages into whatever engine it is aimed at.** Aim it
 * at a test or staging endpoint, never at a production interface.
 *
 * @example
 * ```typescript
 * import { runDifferential } from '@cosyte/mllp';
 * const report = await runDifferential({ peer: process.env['MLLP_DIFF_PEER'] });
 * console.log(JSON.stringify(report, null, 2));
 * ```
 *
 * @packageDocumentation
 */

export { canonicalAcknowledgement, canonicalExchanges, type CanonicalExchange } from "./corpus.js";
export {
  MLLP_DIFF_PEER_UNPARSEABLE,
  MllpDifferentialConfigurationError,
  differentialConfigurationMessage,
  type DifferentialConfigurationErrorCode,
} from "./error.js";
export { resolveDifferentialPeer, type DifferentialPeer } from "./peer.js";
export type {
  DifferentialCorrelationOutcome,
  DifferentialDeviation,
  DifferentialExchangeOutcome,
  DifferentialExchangeReport,
  DifferentialParityOutcome,
  DifferentialReport,
  DifferentialReportPeer,
  DifferentialRunResult,
  DifferentialSkipReason,
} from "./report.js";
export { runDifferential, type DifferentialConnect, type DifferentialRunOptions } from "./run.js";
