---
phase: 03-transport-connection-fsm-observability
reviewed: 2026-04-24T18:00:00Z
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
  critical: 0
  warning: 1
  info: 2
  total: 3
status: issues_found
---

# Phase 3: Code Review Report

**Reviewed:** 2026-04-24T18:00:00Z
**Depth:** standard
**Files Reviewed:** 14
**Status:** issues_found

## Summary

This review covers the post-gap-closure state of Phase 3 (after 03-05-PLAN execution). All four bugs from the initial review (CR-01, WR-01, WR-02, WR-03) have been correctly fixed: `ReconnectingEvent` interface now requires `connectionId` with optional `attempt`/`delayMs`; `_onTransportClose()` correctly routes `CONNECTING`/`RECONNECTING` to `CLOSED`; `_onTransportError()` maps `RECONNECTING` to the `'reconnect'` phase and targets `CLOSED`; and `close()` caches `_drainPromise` for idempotent re-entry.

The Transport abstraction (`Transport` interface, `NetTransport`, `InMemoryTransport`) is well-designed: no `Buffer.slice()`, no `console.*` in library code, no `any` types in source files, all public event payloads are `Object.freeze()`'d, and the `LEGAL_TRANSITIONS` map enforces FSM integrity. The `InMemoryTransport` re-entrancy guard, pause/resume queue, and `split()` chunking are all correct.

One warning-level issue was found: `send()` permits writes in `CONNECTING` and `RECONNECTING` states without a guard, incrementing `bytesOut` even when the underlying transport cannot deliver the bytes. Two info-level observations are noted: dead `simulateConnect()` calls in the integration test, and a `'send'` phase value in `ConnectionErrorPhase` that is never set by the Connection layer.

---

## Warnings

### WR-01: `send()` writes to transport and increments `bytesOut` in `CONNECTING` and `RECONNECTING` states

**File:** `src/connection/connection.ts:298-304`

**Issue:** The `send()` guard only checks for `CLOSED` and `DISCONNECTED`:

```typescript
send(data: Buffer): boolean {
  if (this._state === 'CLOSED' || this._state === 'DISCONNECTED') return false;
  const ok = this._transport.write(data);
  this._bytesOut += data.length;   // incremented even when state is CONNECTING or RECONNECTING
  this._lastByteOutAt = new Date();
  return ok;
}
```

When the connection is `RECONNECTING` (Phase 5 scenario), the old transport has been destroyed and a new one is being established. Calling `send()` during `RECONNECTING` invokes `write()` on the destroyed transport (which returns `false`) and still increments `bytesOut` — so `getStats().bytesOut` overstates bytes actually transmitted. When `CONNECTING`, the underlying socket may or may not have connected yet; if the socket is not yet connected and the OS buffers the write, `bytesOut` counts bytes as "out" before the connection is established, which is also misleading.

The `DRAINING` state is intentionally included (server/client ACK drain continues during graceful close), so it should remain writable.

**Fix:**

```typescript
send(data: Buffer): boolean {
  if (
    this._state === 'CLOSED' ||
    this._state === 'DISCONNECTED' ||
    this._state === 'RECONNECTING'
  ) return false;
  const ok = this._transport.write(data);
  this._bytesOut += data.length;
  this._lastByteOutAt = new Date();
  return ok;
}
```

Note: `CONNECTING` may be left writable intentionally (OS TCP buffering pre-connect is valid), but the JSDoc should be updated to document this behavior explicitly. At minimum, `RECONNECTING` should be guarded since the transport is not connected.

---

## Info

### IN-01: `simulateConnect()` calls in integration test are no-ops — `Connection` never registers `onConnect` on the transport

**File:** `test/connection/integration.test.ts:22-24`

**Issue:** Lines 22-24 call `clientTransport.simulateConnect()` and `serverTransport.simulateConnect()`, but `Connection` does not register an `onConnect` handler on the transport during construction. The `Connection` constructor wires `onData`, `onClose`, and `onError` — never `onConnect`. The `notifyConnect()` method is called directly by the Server/Client layer (lines 19-20). Therefore, `simulateConnect()` fires handlers that are `null`, making these two calls dead code in the test.

This is not a correctness bug today, but it creates a false impression that `simulateConnect()` is part of the Connection setup flow. When Phase 4 Server wires `onConnect` to call `notifyConnect`, tests that copy this pattern may miss the wiring entirely.

**Fix:** Remove the dead `simulateConnect()` calls from the integration test, and add a comment explaining that `Connection.notifyConnect()` is called directly by the Server/Client layer rather than via the transport's connect event:

```typescript
// Connection.notifyConnect() is called directly by the Server/Client layer,
// not via transport.onConnect(). The transport's onConnect handler is used by
// higher-level wrappers (Phase 4/5) to trigger notifyConnect automatically.
clientConn.notifyConnect('127.0.0.1', 2575);
serverConn.notifyConnect('127.0.0.1', 2575);
```

### IN-02: `ConnectionErrorPhase` includes `'send'` but `_onTransportError` never assigns it

**File:** `src/connection/error.ts:26-31`, `src/connection/connection.ts:483-487`

**Issue:** `ConnectionErrorPhase` defines five values: `'connect' | 'send' | 'receive' | 'close' | 'reconnect'`. The `_onTransportError` handler maps all non-CONNECTING/RECONNECTING/DRAINING states to `'receive'` — including the `CONNECTED` state where a send-related error could theoretically occur. The `'send'` phase is never emitted by the Connection layer.

This is not a bug: `'send'` is intended for Phase 5 Client to use when an ACK timeout or send failure occurs at the application layer, not at the transport layer. However, there is no documentation or comment on `_onTransportError` explaining why `'send'` is absent, which makes the type look like it has dead values.

**Fix:** Add a comment in `_onTransportError` documenting the intent:

```typescript
private _onTransportError(err: Error): void {
  // Transport-layer errors are classified by connection lifecycle phase.
  // The 'send' phase is used by higher layers (e.g., MllpClient) for
  // application-layer send failures (ACK timeout, etc.) — not here.
  const phase: ConnectionErrorPhase =
    this._state === 'CONNECTING'    ? 'connect'   :
    this._state === 'RECONNECTING'  ? 'reconnect' :
    this._state === 'DRAINING'      ? 'close'     :
    'receive';
  // ...
}
```

---

_Reviewed: 2026-04-24T18:00:00Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
