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
} from './client.js';
export {
  MllpTimeoutError,
  MllpBackpressureError,
  isTransientConnectionError,
} from './error.js';
