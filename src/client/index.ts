/**
 * MLLP Client public surface.
 *
 * @packageDocumentation
 */

export {
  MllpClient,
  createClient,
  createStarterClient,
  type ClientOptions,
  type ClientStats,
  type StarterClientOptions,
  type RetryContext,
  type RetryStrategy,
  type AckCorrelationWarning,
  type AckModeWarning,
} from "./client.js";
export { ackDiagnosticMessage, type AckCorrelationCode } from "./ack-diagnostics.js";
export { ackModeDiagnosticMessage, type AckModeCode } from "../internal/ack-mode-diagnostics.js";
export type { CommitAckReport } from "../internal/ack-mode.js";
export {
  MllpTimeoutError,
  MllpBackpressureError,
  MllpApplicationAckError,
  MllpCommitRejectedError,
  MllpNeverDeliveredError,
  MllpUnknownFateError,
  type ApplicationAckFailure,
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "./error.js";
