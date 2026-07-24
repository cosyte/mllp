/**
 * Connection module, 6-state FSM over a Transport with lifecycle events,
 * per-connection warning streams, and `getStats()` observability.
 *
 * @packageDocumentation
 */

export {
  Connection,
  type ConnectionOptions,
  type ConnectionState,
  type ConnectionStats,
  type StateChangeEvent,
  type ReconnectingEvent,
} from "./connection.js";
export {
  MllpConnectionError,
  type ConnectionErrorPhase,
  type ConnectionErrorCause,
} from "./error.js";
