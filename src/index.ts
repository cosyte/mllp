/**
 * `@cosyte/mllp` — Production-grade MLLP client and server for Node.js.
 *
 * Transport-only sibling to `@cosyte/hl7`. Handles framing, ACKs, reconnects,
 * backpressure, and TLS without requiring knowledge of the MLLP spec.
 *
 * @example
 * ```typescript
 * import { createStarterServer } from '@cosyte/mllp';
 * const server = await createStarterServer({ port: 2575, onMessage: (buf) => buf });
 * ```
 *
 * @packageDocumentation
 */

/**
 * Package version marker exported from the `@cosyte/mllp` root.
 *
 * Kept in lockstep with `package.json` by `scripts/sync-version.mjs`, which the `version` script
 * runs immediately after `changeset version`. The `: string` annotation is deliberate — without it
 * TypeScript infers the *literal* type (`declare const VERSION = "0.0.0"`), which leaks the current
 * release into consumers' types and makes an equality check against any other version a compile
 * error.
 *
 * @example
 * ```typescript
 * import { VERSION } from '@cosyte/mllp';
 * console.log(VERSION);
 * ```
 */
export const VERSION: string = "0.0.0";

// Phase 2: framing codec public surface
export type { WarningCode, MllpWarning } from "./framing/index.js";
export { MllpFramingError, encodeFrame, FrameReader, createWarning } from "./framing/index.js";
export type { FrameReaderOptions, EncoderOptions } from "./framing/index.js";

// Phase 3: transport abstraction, connection FSM, and observability
export type { Transport } from "./transport/index.js";
export { NetTransport } from "./transport/index.js";

// Phase 8: TLS / MLLPS hardening
export { TlsTransport } from "./transport/index.js";
export type { TlsOptions, ServerTlsOptions, ClientAuth, PemInput } from "./transport/index.js";
export {
  MLLP_TLS_VERIFY_DISABLED,
  MLLP_BIND_ALL_INTERFACES,
  type SecurityWarning,
  type SecurityWarningCode,
} from "./transport/index.js";

export {
  Connection,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionStats,
  type StateChangeEvent,
  type ReconnectingEvent,
  MllpConnectionError,
  type ConnectionErrorPhase,
  type ConnectionErrorCause,
} from "./connection/index.js";

// Phase 4: server
export {
  MllpServer,
  createServer,
  createStarterServer,
  type ServerOptions,
  type StarterServerOptions,
  type ServerStats,
  type MessageMeta,
  type NackEvent,
  type NackReason,
} from "./server/index.js";

// Phase 6: fail-safe ACK semantics & the commit contract
export {
  buildRawAck,
  rawAckUncorrelatable,
  resolveNackCode,
  MllpAckError,
  type AckCode,
  type NegativeAckCode,
} from "./server/index.js";

// Phase 5: client
export {
  MllpClient,
  createClient,
  createStarterClient,
  type ClientOptions,
  type ClientStats,
  type StarterClientOptions,
  type RetryContext,
  type RetryStrategy,
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
  isTlsVerificationErrorCode,
  isTlsProtocolError,
} from "./client/index.js";
