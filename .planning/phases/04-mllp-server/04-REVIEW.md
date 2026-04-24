---
phase: 04-mllp-server
reviewed: 2026-04-24T19:20:52Z
depth: standard
files_reviewed: 7
files_reviewed_list:
  - src/server/server.ts
  - src/server/index.ts
  - src/index.ts
  - test/server/server.test.ts
  - test/server/auto-ack.test.ts
  - test/server/graceful-shutdown.test.ts
  - test/server/starter-server.test.ts
findings:
  critical: 2
  warning: 3
  info: 2
  total: 7
status: issues_found
---

# Phase 4: Code Review Report

**Reviewed:** 2026-04-24T19:20:52Z
**Depth:** standard
**Files Reviewed:** 7
**Status:** issues_found

## Summary

The MLLP server implementation is well-structured overall: the 6-state FSM integration is correct, event payloads are consistently frozen, AbortSignal handling is implemented on both `listen()` and `close()`, dead-peer timers call `.unref()` and are cleared on connection close, and zero runtime dependencies are maintained. The `_buildAutoAck` parser is correctly written without `.slice()`.

Two critical issues were found: (1) `onMessage` return values are silently discarded despite the JSDoc documenting that returning a Buffer sends an ACK, and (2) `_closedTotal` double-counts when a gracefully-disconnected connection is later transitioned to `CLOSED` (e.g. by the drain-timeout `destroy()` in `_drainAll`). Three warnings cover an unjustified `as` cast, a no-op `removeEventListener` call, and missing dead-peer timer cleanup on `disconnect`.

---

## Critical Issues

### CR-01: `onMessage` return value silently discarded — documented ACK behavior broken

**File:** `src/server/server.ts:651`
**Issue:** The `ServerOptions.onMessage` callback is documented as `"Return a Buffer or Promise<Buffer> to send as the ACK payload (auto-framed)"` (lines 111–120), but the implementation discards the return value with `void this._opts.onMessage?.(payload, meta, conn)`. A developer who writes `onMessage: (payload) => buildAck(payload)` trusting the JSDoc will silently get no ACK sent. This is a silent behavioral contract violation — no error is thrown, no warning is emitted, the return value just disappears.

**Fix:** Either (a) implement the return-value path as documented — check for a returned Buffer and send it via `encodeFrame` + `conn.send()`, or (b) remove the `Buffer | Promise<Buffer>` return type from the interface and update the JSDoc to say the return value is always ignored (use `conn.send()` explicitly). Option (a) matches the documented north-star:

```typescript
// In _onSocketAccepted, replace the void dispatch with:
const onMessageResult = this._opts.onMessage?.(payload, meta, conn);
if (onMessageResult !== undefined) {
  void Promise.resolve(onMessageResult).then((ackPayload) => {
    if (ackPayload instanceof Buffer) {
      const sent = conn.send(encodeFrame(ackPayload));
      if (!sent) {
        conn.emit('error', Object.freeze({
          connectionId: conn.connectionId,
          error: new MllpConnectionError('onMessage ACK dropped: socket backpressure', {
            cause: new Error('backpressure'),
            phase: 'send',
          }),
        }));
      }
    }
  }).catch((err: unknown) => {
    const connErr = err instanceof Error ? err : new Error(String(err));
    conn.emit('error', Object.freeze({ connectionId: conn.connectionId, error: connErr }));
  });
}
```

---

### CR-02: `_closedTotal` double-increments when a DISCONNECTED connection later reaches CLOSED

**File:** `src/server/server.ts:602-607`
**Issue:** Two `once` listeners are registered for `_onConnEnded` — one on `'disconnect'` and one on `'close'`. These are independent listeners, each backed by its own `once` registration. When a connection gracefully drains (`CONNECTED → DRAINING → DISCONNECTED`), `'disconnect'` fires and `_onConnEnded` runs (delete from set, `_closedTotal++`). Later, if `destroy()` is called on that DISCONNECTED connection (e.g. from `_drainAll`'s straggler timeout, or from server `close()` abort path), `Connection.destroy()` calls `_transition('CLOSED')` (line 397 of connection.ts — there is no `DISCONNECTED` guard), which emits `'close'`. The second `once('close', _onConnEnded)` listener fires, incrementing `_closedTotal` a second time. `_connections.delete` is idempotent so the set is fine, but `_closedTotal` is over-counted.

**Fix:** Use a single guard flag or remove one listener when the other fires:

```typescript
let ended = false;
const _onConnEnded = () => {
  if (ended) return;
  ended = true;
  this._connections.delete(conn);
  this._closedTotal++;
};
conn.once('close', _onConnEnded);
conn.once('disconnect', _onConnEnded);
```

---

## Warnings

### WR-01: Unjustified `as` cast on `autoAck` function type

**File:** `src/server/server.ts:695`
**Issue:** The cast `(this._opts.autoAck as (p: Buffer, m: MessageMeta, c: Connection) => Buffer | Promise<Buffer>)` is used inside the `else` branch after the `=== 'AA'` check. TypeScript cannot narrow a union member of `'AA' | fn | undefined` to the function type automatically after the `=== 'AA'` check (it only knows it is not `'AA'`), but the `autoAck !== undefined` guard in the caller already rules out `undefined`. The real fix is to model the narrowing correctly rather than suppress it with a cast. The `as` cast here violates the "no unjustified `as` casts" guardrail.

**Fix:** Extract the function call with a type-narrowed local variable:

```typescript
// Replace the cast with:
const autoAckFn = this._opts.autoAck;
// autoAckFn cannot be 'AA' (checked above) or undefined (checked in caller)
// so it must be the function type
if (typeof autoAckFn !== 'function') {
  throw new Error('unreachable: autoAck is neither "AA" nor function');
}
ackPayload = await Promise.resolve(autoAckFn(payload, meta, conn));
```

---

### WR-02: No-op `removeEventListener` call in early-return path of `close()`

**File:** `src/server/server.ts:368`
**Issue:** `signal?.removeEventListener('abort', () => {/* no handler registered yet */})` creates a new anonymous function and tries to remove it, but `removeEventListener` matches by reference — this call removes nothing. The comment acknowledges "no handler registered yet," making this dead code. It is harmless at runtime but is misleading and should be removed.

**Fix:** Delete the call entirely:

```typescript
// If no active connections, we're done — emit 'close' and resolve
if (this._connections.size === 0) {
  // No abort handler was registered — nothing to remove
  this.emit('close', Object.freeze({}));
  return Promise.resolve();
}
```

---

### WR-03: Dead-peer timer not cleared on `'disconnect'` event

**File:** `src/server/server.ts:625`
**Issue:** The dead-peer idle timer cleanup listener is registered only for `conn.once('close', ...)` (line 625). However, a connection can reach the `DISCONNECTED` state (emitting `'disconnect'`) without ever emitting `'close'` — for example, a gracefully-closed peer transitions `CONNECTED → DRAINING → DISCONNECTED` and stays there unless something subsequently calls `destroy()`. If the idle timer fires after the connection is DISCONNECTED, `conn.destroy()` will be called on an already-disconnected connection. `destroy()` in connection.ts does guard for `CLOSED` (line 396) but not for `DISCONNECTED`, so this will trigger a spurious `DISCONNECTED → CLOSED` transition and the associated `close` event — contributing to the CR-02 double-count as well.

**Fix:** Also clear the timer on `disconnect`:

```typescript
conn.once('close', () => {
  clearTimeout(deadPeerTimer);
});
conn.once('disconnect', () => {
  clearTimeout(deadPeerTimer);
});
```

---

## Info

### IN-01: `console.*` calls in JSDoc `@example` blocks in library source

**File:** `src/server/server.ts:14, 41, 63, 234, 744`
**Issue:** The project guardrail is "No `console.*` in library code." The `console.log` calls appear only inside JSDoc `@example` code snippets, not in runtime paths. The rule likely targets runtime code, so this is a documentation concern rather than a functional bug, but it could mislead developers reading the examples and set a bad pattern. The examples in `createServer`, `MllpServer`, and `getStats` all contain `console.log`.

**Fix:** Replace `console.log` in all `@example` blocks with comments or logger calls, e.g.:
```typescript
// @example
// conn.on('message', ({ payload, meta }) => {
//   logger.info({ connectionId: meta.connectionId, byteOffset: meta.byteOffset });
// });
```

---

### IN-02: `warnings: [] as readonly MllpWarning[]` cast in message handler

**File:** `src/server/server.ts:641`
**Issue:** `warnings: [] as readonly MllpWarning[]` uses a type assertion to widen a mutable empty array to a readonly array. This is technically benign (empty array is always assignable) but the comment says "Plan 04 will thread actual byte offsets from FrameReader" — the same applies to warnings. The cast also bypasses `noUncheckedIndexedAccess` implications. A typed constant is cleaner.

**Fix:**
```typescript
const EMPTY_WARNINGS: readonly MllpWarning[] = Object.freeze([]);

// Then in the meta construction:
const meta: MessageMeta = Object.freeze({
  connectionId,
  byteOffset: 0,
  warnings: EMPTY_WARNINGS,
});
```

---

_Reviewed: 2026-04-24T19:20:52Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
