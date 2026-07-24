/**
 * Containment for every event emission that can be reached from a **callback we do not own**,
 * a socket's `'data'`/`'error'`/`'connect'`/`'secureConnect'` listener, a `net.Server`'s
 * `'connection'` listener, a `tls.Server`'s `'tlsClientError'` listener, or the `catch` block of a
 * `void`-ed async task.
 *
 * ## Why this module exists
 *
 * Node's `EventEmitter.emit()` calls its listeners **synchronously**. So a throwing subscriber does
 * not merely fail itself, it unwinds the whole call stack it was invoked from. When that stack
 * bottoms out in a socket callback, the throw becomes an **uncaught exception and kills the
 * process**, taking every other connection and every in-flight durable commit with it. When it
 * bottoms out in a `void`-ed async method, it becomes an **unhandled rejection**, same outcome,
 * and it also skips whatever the method had left to do, which on the ACK path means the
 * acknowledgement is never sent.
 *
 * A metrics tap, an audit logger, a `console.log` with a typo: any of them, in a consumer's code,
 * could take down an MLLP interface. That is not an acceptable failure mode for a transport
 * carrying clinical messages.
 *
 * ## The rule
 *
 * **No `emit()` reachable from a transport, accept, or handshake callback, in *any* class, may go
 * uncontained.** Scoping this rule to one class is exactly the mistake that let it regress: the
 * hazard belongs to the *call stack*, not to `Connection`. `MllpServer` and `MllpClient` emit from
 * those callbacks too.
 *
 * @packageDocumentation
 */

import type { EventEmitter } from "node:events";

/**
 * Emit an event, containing any throw from a subscriber.
 *
 * The subscriber's throw is reported through `onSubscriberThrow` (normally an `'error'` emission)
 * rather than being allowed to unwind into the callback that invoked us. Emission continues to be
 * synchronous and in-order for well-behaved subscribers, this only changes what happens when one
 * of them is broken.
 *
 * @param emitter - The emitter to emit on.
 * @param event - Event name.
 * @param payload - The (already frozen) event payload.
 * @param onSubscriberThrow - Reporter for a throwing subscriber. Must not itself throw.
 *
 * @example
 * ```typescript
 * safeEmit(this, "connection", frozenEvent, (err) => this._reportSubscriberThrow(err));
 * ```
 */
export function safeEmit(
  emitter: EventEmitter,
  event: string,
  payload: unknown,
  onSubscriberThrow?: (err: Error) => void,
): void {
  try {
    emitter.emit(event, payload);
  } catch (err) {
    onSubscriberThrow?.(err instanceof Error ? err : new Error(String(err)));
  }
}

/**
 * Emit `'error'`, but only when someone is listening, and never letting the emission escape.
 *
 * Two hazards, both fatal, both closed here:
 *
 * 1. **No listener.** Node raises `ERR_UNHANDLED_ERROR` when `'error'` is emitted on an
 *    `EventEmitter` with no `'error'` listener. Since error reporting is reached from inside socket
 *    callbacks and `catch` blocks, that throw would escape by the very route the containment exists
 *    to close.
 * 2. **A throwing `'error'` listener.** Swallowed, deliberately, and this is the one place a throw
 *    is dropped on the floor. Reporting is what just failed, so there is nowhere left to report it
 *    to; the alternative is killing the process to complain that we could not complain.
 *
 * @example
 * ```typescript
 * safeEmitError(this, Object.freeze({ connectionId, error }));
 * ```
 */
export function safeEmitError(emitter: EventEmitter, payload: unknown): void {
  if (emitter.listenerCount("error") === 0) return;
  try {
    emitter.emit("error", payload);
  } catch {
    // Deliberately swallowed, see the JSDoc above.
  }
}
