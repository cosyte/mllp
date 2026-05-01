/**
 * MLLP Client typed errors and classifiers.
 *
 * Exports:
 * - `MllpTimeoutError` (PLAN-02) — ACK timeout (ERR-02)
 * - `MllpBackpressureError` (PLAN-05) — high-water mark exceeded (ERR-04)
 * - `isTransientConnectionError` (PLAN-04) — transient/permanent classifier (CLIENT-18)
 *
 * Re-exported from `src/client/index.ts` and `src/index.ts`.
 *
 * @packageDocumentation
 */

// PLAN-02 fills: MllpTimeoutError (ERR-02)
// PLAN-04 fills: isTransientConnectionError (CLIENT-18)
// PLAN-05 fills: MllpBackpressureError (ERR-04)

export {}; // placeholder to make the file a valid ES module
