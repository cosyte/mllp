/**
 * MLLP Client public surface.
 *
 * @packageDocumentation
 */

export {
  MllpClient,
  createClient,
  type ClientOptions,
  type RetryContext,
  type RetryStrategy,
} from './client.js';
export {
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
} from './error.js';
// PLAN-02 adds: type AckEvent
// PLAN-06 adds: createStarterClient, type StarterClientOptions, type ClientStats
