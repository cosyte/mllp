/**
 * In-memory transport utilities for deterministic, socket-free tests.
 *
 * Import from `@cosyte/mllp/testing`:
 *
 * @example
 * ```typescript
 * import { InMemoryTransport } from '@cosyte/mllp/testing';
 *
 * const [a, b] = InMemoryTransport.pair();
 * b.onData((chunk) => b.write(chunk)); // echo
 * a.write(Buffer.from([0x0b, 0x41, 0x1c, 0x0d]));
 * ```
 *
 * @packageDocumentation
 */

export { InMemoryTransport } from "./in-memory-transport.js";
