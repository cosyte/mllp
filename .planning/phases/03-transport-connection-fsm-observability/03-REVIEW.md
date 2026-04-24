---
phase: 03-transport-connection-fsm-observability
reviewed: 2026-04-24T17:02:13Z
depth: standard
files_reviewed: 14
files_reviewed_list:
  - src/connection/connection.ts
  - src/connection/error.ts
  - src/connection/index.ts
  - src/index.ts
  - src/testing/index.ts
  - src/testing/in-memory-transport.ts
  - src/transport/index.ts
  - src/transport/net-transport.ts
  - test/connection/close-destroy.test.ts
  - test/connection/connection.test.ts
  - test/connection/error.test.ts
  - test/connection/integration.test.ts
  - test/testing/in-memory-transport.test.ts
  - test/transport/net-transport.test.ts
findings:
  critical: 1
  warning: 3
  info: 2
  total: 6
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-04-24T17:02:13Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

Phase 3 delivers a solid foundation: the Transport interface, NetTransport, InMemoryTransport, and the 6-state Connection FSM are well-structured. The LEGAL_TRANSITIONS map, ring-buffer warning system, and `getStats()` observability all look correct. No `Buffer.slice()` calls, no `console.*` in library code, no `any` types, and all public event payloads are `Object.freeze()`'d.

Two bugs share a root cause: the `_onTransportClose` and `_onTransportError` handlers both attempt illegal FSM transitions for the `CONNECTING` and `RECONNECTING` states. Because `_transition()` silently ignores illegal edges (by design for FSM integrity), the result is a stuck FSM rather than a crash — difficult to diagnose. There is also a public API type contract violation: the exported `ReconnectingEvent` interface does not match what the `'reconnecting'` event actually emits at runtime.

---

## Critical Issues

### CR-01: `ReconnectingEvent` interface does not match the emitted payload

**File:** `src/connection/connection.ts:450` (interface defined at line 68)

**Issue:** The exported `ReconnectingEvent` interface declares `{ attempt: number; delayMs: number }`, but the `'reconnecting'` event is emitted with `{ connectionId: string }` only. Any Phase 5 subscriber destructuring `{ attempt, delayMs }` from the event will receive `undefined` for both fields — a silent runtime type mismatch. This is a breaking public API contract violation that cannot be caught by TypeScript because `EventEmitter.emit()` is untyped.

**Fix:**

Option A — align the emitted payload with the interface (preferred; Phase 5 should supply `attempt`/`delayMs` from the reconnect backoff loop, which is where the values will be known):

```typescript
// In _transition(), the 'reconnecting' emission belongs in Phase 5's reconnect
// controller, not here. Remove the emission from _transition() and have Phase 5
// emit it with the correct payload when it schedules the reconnect attempt.
// For Phase 3, simply do not emit 'reconnecting' from _transition() since
// RECONNECTING is never actually entered in Phase 3 code paths.
```

Option B — fix the interface to match what is currently emitted (minimal change, then extend in Phase 5):

```typescript
// connection.ts line 68 — align interface with actual payload for now
export interface ReconnectingEvent {
  readonly connectionId: string;
  readonly attempt?: number;   // Phase 5 will populate
  readonly delayMs?: number;   // Phase 5 will populate
}
```

The JSDoc `@example` at line 63 (which destructures `{ attempt, delayMs }`) also needs updating under either option.

---

## Warnings

### WR-01: `_onTransportClose` leaves FSM stuck when transport closes during `CONNECTING`

**File:** `src/connection/connection.ts:463-469`

**Issue:** `_onTransportClose` attempts `CONNECTING → DISCONNECTED` and `RECONNECTING → DISCONNECTED`, but both are illegal per `LEGAL_TRANSITIONS`. `_transition()` silently ignores them. The FSM stays in `CONNECTING` (or `RECONNECTING`) indefinitely — the connection is not cleaned up, the `'disconnect'` event never fires, and resources are leaked. A comment in `connection.test.ts:102` acknowledges the `CONNECTING` case but the connection test suite works around it rather than asserting the correct behavior.

The legal target for both states on unexpected peer close is `CLOSED` (neither state has a path to `DISCONNECTED`).

**Fix:**

```typescript
// src/connection/connection.ts — _onTransportClose()
private _onTransportClose(): void {
  if (this._state === 'DRAINING') {
    this._transition('DISCONNECTED');
    return;
  }
  if (this._state === 'CONNECTED') {
    this._transition('DISCONNECTED', 'peer closed');
    return;
  }
  if (this._state === 'CONNECTING' || this._state === 'RECONNECTING') {
    // Neither CONNECTING nor RECONNECTING has a path to DISCONNECTED.
    // Use CLOSED (terminal) for unexpected peer close here.
    this._transition('CLOSED', 'peer closed');
  }
}
```

### WR-02: `_onTransportError` leaves FSM stuck when an error fires during `RECONNECTING`

**File:** `src/connection/connection.ts:488`

**Issue:** The ternary `this._state === 'CONNECTING' ? 'CLOSED' : 'DISCONNECTED'` maps `RECONNECTING` (and `DRAINING`, `CONNECTED`) to target `'DISCONNECTED'`. For `RECONNECTING`, `RECONNECTING → DISCONNECTED` is illegal and silently dropped, leaving the connection stuck in `RECONNECTING`. Phase 5 code that encounters an error during a reconnect attempt will find the FSM unresponsive.

Additionally, the `phase` ternary at lines 475-477 assigns `'receive'` for `RECONNECTING` state errors, but `'reconnect'` is the semantically correct phase.

**Fix:**

```typescript
private _onTransportError(err: Error): void {
  const phase: ConnectionErrorPhase =
    this._state === 'CONNECTING'    ? 'connect'   :
    this._state === 'RECONNECTING'  ? 'reconnect' :
    this._state === 'DRAINING'      ? 'close'     :
    'receive';

  const connErr = new MllpConnectionError(err.message, { cause: err, phase });
  this.emit('error', Object.freeze({ connectionId: this.connectionId, error: connErr }));
  if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return;

  // CONNECTING and RECONNECTING have no path to DISCONNECTED — use CLOSED
  const target: ConnectionState =
    (this._state === 'CONNECTING' || this._state === 'RECONNECTING') ? 'CLOSED' : 'DISCONNECTED';
  this._transition(target, `error: ${err.message}`);
}
```

### WR-03: `close()` during `DRAINING` calls `beforeClose()` a second time concurrently

**File:** `src/connection/connection.ts:331-334`

**Issue:** The comment at line 331 says "idempotent re-entry guard" but it is not idempotent. When `close()` is called while already in `DRAINING`, it falls through to `_drainWithTimeout(timeout)`, which calls `this.beforeClose(timeoutMs)` again. If the first `close()` call's `beforeClose` is still pending, a second concurrent invocation is started. Phase 4 (Server ACK drain) and Phase 5 (send-queue drain) hooks will not be written to tolerate concurrent invocations.

**Fix:**

```typescript
// Add a promise cache so the second caller joins the first drain rather than
// starting a new one.
private _drainPromise: Promise<void> | null = null;

async close(opts?: { drainTimeoutMs?: number }): Promise<void> {
  const timeout = opts?.drainTimeoutMs ?? this._opts.drainTimeoutMs ?? 30_000;
  if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return;
  if (this._state === 'CONNECTING' || this._state === 'RECONNECTING') {
    this._transition('CLOSED', 'close() during ' + this._state);
    this._transport.destroy();
    return;
  }
  if (this._state === 'DRAINING') {
    // Join the in-progress drain rather than starting a second beforeClose call
    return this._drainPromise ?? Promise.resolve();
  }
  this._transition('DRAINING');
  this._drainPromise = this._drainWithTimeout(timeout).finally(() => {
    this._drainPromise = null;
  });
  return this._drainPromise;
}
```

---

## Info

### IN-01: No tests exercise `RECONNECTING` state transitions or the `'reconnecting'` event

**File:** `test/connection/connection.test.ts`, `test/connection/close-destroy.test.ts`

**Issue:** The `RECONNECTING` FSM state and `'reconnecting'` event have zero test coverage. The `close()` behavior for `RECONNECTING → CLOSED` is in production paths but untested. Phase 5 will add reconnect logic, but the Phase 3 handling (WR-01 and WR-02 above) also goes uncaught because no tests reach those code paths.

**Fix:** Add tests that directly call `_transition('RECONNECTING')` via a mock or by stubbing the FSM, then verify `close()`, transport close, and transport error behavior from `RECONNECTING`.

### IN-02: `connection.test.ts:102` comment acknowledges a known stuck-FSM scenario without asserting correct behavior

**File:** `test/connection/connection.test.ts:102`

**Issue:** The comment `// CONNECTING -> DISCONNECTED is illegal (via _onTransportClose); let's check via destroy` documents the bug (WR-01) but the test works around it rather than asserting the expected post-condition. This masks the regression surface — a future fix to `_onTransportClose` would not be caught by this test.

**Fix:** Add an assertion that after `mock.emit.close()` from `CONNECTING` state, `conn.state` equals `'CLOSED'` (the correct target per the fix in WR-01), and that the `'close'` event fired. Remove or reword the comment once WR-01 is resolved.

---

_Reviewed: 2026-04-24T17:02:13Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
