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
} from "./client.js";
export { ackDiagnosticMessage, type AckCorrelationCode } from "./ack-diagnostics.js";
export {
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "./error.js";
