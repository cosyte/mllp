# Phase 3: Transport Abstraction, Connection FSM & Observability - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 03-transport-connection-fsm-observability
**Areas discussed:** Transport event model, InMemoryTransport delivery timing, onMessage vs onAck routing, close() drain contract

---

## Transport Event Model

| Option | Description | Selected |
|--------|-------------|----------|
| Pure callback bag (Recommended) | Transport is a plain TS interface: `{write, close, onData, onConnect, onClose, onError}`. Consistent with FrameReader pattern. InMemoryTransport needs no EventEmitter import. | ✓ |
| Hybrid (callback bag interface + EventEmitter internals) | Interface stays callback-bag; NetTransport wraps socket events into callbacks internally. | |

**User's choice:** Pure callback bag
**Notes:** Went with the recommendation. Consistent with FrameReader's established callback-bag pattern. Connection is the sole consumer of Transport; single-handler-per-event constraint is not a limitation.

---

## InMemoryTransport Delivery Timing

| Option | Description | Selected |
|--------|-------------|----------|
| Synchronous inline (Recommended) | B's handler fires inside A's write() call before write() returns. Zero async ceremony in tests. Guard re-entrancy with `_writeDepth` counter. | ✓ |
| queueMicrotask() | B's handler queues at microtask boundary. One `await Promise.resolve()` flushes. Safer against re-entrant chains. | |

**User's choice:** Synchronous inline
**Notes:** Went with the recommendation. Consistent with FrameReader.push() synchronous delivery model. Re-entrancy guard via `_writeDepth` counter.

---

## onMessage vs onAck Routing

| Option | Description | Selected |
|--------|-------------|----------|
| Connection fires message for all frames (Recommended) | Connection emits 'message' for every decoded MLLP frame. MllpClient (Phase 5) intercepts 'message' and converts to 'ack' via AckCorrelator. onAck is a Client-level event. | ✓ |
| role: 'server' \| 'client' on Connection | Connection takes a role option and routes frames. Satisfies LIFE-03 literally but requires HL7 heuristic. | |

**User's choice:** Connection fires message for all frames
**Notes:** Went with the recommendation. Connection has no HL7 parser; ACK detection belongs at MllpClient layer. LIFE-03's onAck is scoped to MllpClient, not bare Connection.

---

## close() Drain Contract

| Option | Description | Selected |
|--------|-------------|----------|
| Hook-based (Recommended) | Connection exposes `beforeClose(drainTimeoutMs): Promise<void>` hook (no-op default). Phase 4/5 register domain-specific drain logic. Connection owns FSM + timeout enforcement. | ✓ |
| Flush-only | DRAINING = wait for socket drain event, then DISCONNECTED. Server/Client add their own coordination above Connection. | |

**User's choice:** Hook-based
**Notes:** Went with the recommendation. Commits the hook signature in Phase 3 so Phase 4/5 have a stable integration point. No-op default means Phase 3 behavior is flush-only, but the extension point is defined.

---

## Claude's Discretion

- Internal file structure within `src/transport/`, `src/connection/`, `src/testing/`
- `getStats()` snapshot timing details
- Warning buffer ring-buffer implementation
- `destroy()` reason parameter type (`Error` vs `string`)
- Whether `onData/onConnect/onClose/onError` registration is set-once (replace) or throw-on-double

## Deferred Ideas

None — discussion stayed within Phase 3 scope.
