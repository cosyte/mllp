/**
 * MLLP Client public surface.
 *
 * @packageDocumentation
 */

export { MllpClient, createClient, type ClientOptions } from './client.js';
export { MllpTimeoutError } from './error.js';
// PLAN-02 adds: type AckEvent
// PLAN-04 adds: type RetryContext, RetryStrategy
// PLAN-05 adds: type ClientStats, MllpBackpressureError, isTransientConnectionError
// PLAN-06 adds: createStarterClient, type StarterClientOptions, finalize ClientStats
