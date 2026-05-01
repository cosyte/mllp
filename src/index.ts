/**
 * @cosyte/hl7-mllp — Production-grade MLLP client and server for Node.js.
 *
 * Transport-only sibling to `@cosyte/hl7`. Handles framing, ACKs, reconnects,
 * backpressure, and TLS without requiring knowledge of the MLLP spec.
 *
 * @example
 * ```typescript
 * import { createStarterServer } from '@cosyte/hl7-mllp';
 * const server = await createStarterServer({ port: 2575, onMessage: (buf) => buf });
 * ```
 *
 * @packageDocumentation
 */

// Populated in Phase 2+. Stub barrel — do not remove this file.
export const VERSION = '0.1.0';

// Phase 2: framing codec public surface
export type { WarningCode, MllpWarning } from './framing/index.js';
export { MllpFramingError, encodeFrame, FrameReader, createWarning } from './framing/index.js';
export type { FrameReaderOptions, EncoderOptions } from './framing/index.js';

// Phase 3: transport abstraction, connection FSM, and observability
export type { Transport } from './transport/index.js';
export { NetTransport } from './transport/index.js';
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
} from './connection/index.js';

// Phase 4: server
export {
  MllpServer,
  createServer,
  createStarterServer,
  type ServerOptions,
  type StarterServerOptions,
  type ServerStats,
  type MessageMeta,
} from './server/index.js';

// Phase 5: client (PLAN-01 scaffold; later plans add error types, retry, stats, starter)
export {
  MllpClient,
  createClient,
  type ClientOptions,
  MllpTimeoutError,
} from './client/index.js';
