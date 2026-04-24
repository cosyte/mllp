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
