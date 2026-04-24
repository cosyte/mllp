---
phase: "04-mllp-server"
plan: "02"
subsystem: server
tags: [server, mllp, auto-ack, backpressure, hl7-v2, msh-parsing]
dependency_graph:
  requires:
    - "04-01"  # MllpServer skeleton — _onSocketAccepted, Connection pipeline
    - "03-transport-connection-fsm-observability"  # Connection.send(), MllpConnectionError, encodeFrame
  provides:
    - "src/server/server.ts:_buildAutoAck"  # private MSH extraction without parser
    - "src/server/server.ts:_sendAutoAck"   # async auto-ACK dispatch with encodeFrame + backpressure handling
  affects:
    - "04-03"  # graceful shutdown — close() drain coordination
    - "04-04"  # createStarterServer + getStats aggregation

tech_stack:
  added: []
  patterns:
    - "_buildAutoAck: split on CR to find MSH segment, then split on | for fields"
    - "conn.send(encodeFrame(ackPayload)) — Connection.send() writes raw bytes; encodeFrame adds VT+FS+CR"
    - "conn.send() boolean return → false triggers MllpConnectionError({ phase: 'send' }) on conn (D-04)"
    - "Default 'error' listener on accepted connections forwards to server 'error' only when listeners exist"
    - "void onMessage?.(payload, meta, conn) — return value ignored in auto-ACK mode"

key_files:
  created:
    - test/server/auto-ack.test.ts
  modified:
    - src/server/server.ts

key_decisions:
  - "conn.send() writes raw bytes; _sendAutoAck must call conn.send(encodeFrame(ackPayload)) — framing was missing in Plan 01"
  - "Added default 'error' handler on each accepted Connection to prevent ERR_UNHANDLED_ERROR from auto-ACK errors; forwards to server 'error' only when server has listeners"
  - "_buildAutoAck splits on CR first (segment separator) then finds MSH, then splits on | for field extraction — handles multi-segment payloads"
  - "randomUUID().replace(/-/g, '').substring(0, 20) for new ACK control ID — fits MSH-10 field width"
  - "void onMessage return value in message handler — auto-ACK mode uses _sendAutoAck; return value from onMessage is not used as ACK payload"

requirements-completed:
  - SERVER-04
  - SERVER-05

duration: "9min"
completed: "2026-04-24"
---

# Phase 4 Plan 02: Auto-ACK Synthesis Summary

`_buildAutoAck` private method on MllpServer with plain-object MSH extraction (no peer dep), encodeFrame-wrapped send, backpressure error emission, and D-04 error swallow on connection.

## Performance

- **Duration:** ~9 min
- **Started:** 2026-04-24T18:53:00Z
- **Completed:** 2026-04-24T19:02:35Z
- **Tasks:** 1 (TDD: RED + GREEN)
- **Files modified:** 2

## Accomplishments

- `_buildAutoAck(payload: Buffer): Buffer` private method on `MllpServer` — splits on `\r` to find MSH segment, extracts all relevant fields, swaps sendingApp↔receivingApp per HL7 ACK rules, uses `randomUUID` for new control ID, returns fallback buffer on malformed/missing MSH (never throws)
- `_sendAutoAck` correctly calls `conn.send(encodeFrame(ackPayload))` — `Connection.send()` writes raw bytes, framing must be applied by the caller
- Backpressure handling: `conn.send()` returns `false` → `MllpConnectionError({ phase: 'send' })` emitted on connection (D-04)
- Default connection error handler prevents `ERR_UNHANDLED_ERROR` when auto-ACK errors have no listener
- 14 new TDD tests added (all passing), 259 total tests pass

## Task Commits

TDD RED/GREEN cycle:

1. **RED: failing tests for _buildAutoAck, auto-ACK dispatch, backpressure** - `4fdd6e6` (test)
2. **GREEN: _buildAutoAck private method, fix framing, handle backpressure** - `1d61594` (feat)

**Plan metadata:** (created with this SUMMARY commit)

## Files Created/Modified

- `src/server/server.ts` — Added `_buildAutoAck` private method; rewrote `_sendAutoAck` to use `encodeFrame`+backpressure; added default conn error handler; added `randomUUID`/`MllpConnectionError`/`encodeFrame` imports
- `test/server/auto-ack.test.ts` — 14 TDD tests: `_buildAutoAck` unit tests via reflection, auto-ACK AA mode (MSA round-trip, field swap, malformed fallback), fn mode (sync/async), manual mode, D-03 ordering, D-04 error swallow, backpressure `MllpConnectionError`

## Decisions Made

- **`conn.send()` writes raw bytes** — Plan 01 called `conn.send(ackPayload)` without framing; this was a silent bug (client would receive unframed bytes). Plan 02 fixes it by always calling `conn.send(encodeFrame(ackPayload))`.
- **Default `'error'` handler on conn** — Without one, `conn.emit('error', ...)` from `_sendAutoAck`'s catch block would throw `ERR_UNHANDLED_ERROR` if no user listener was attached. Added a forwarding handler that only propagates to server `'error'` when the server has listeners (D-04 guarantee).
- **`void onMessage?.(payload, meta, conn)`** — The `onMessage` callback can return `Buffer | Promise<Buffer>`. In auto-ACK mode, this return value is ignored; auto-ACK uses `_buildAutoAck`. The `void` suppresses the ESLint `no-floating-promises` warning.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Missing `encodeFrame` wrapping in `_sendAutoAck`**
- **Found during:** Task 1 GREEN (tests timing out — client never received valid MLLP frame)
- **Issue:** Plan 01's `_sendAutoAck` called `conn.send(ackPayload)` without `encodeFrame()`. `Connection.send()` writes raw bytes (per connection.ts JSDoc: "Write raw bytes to the transport (no framing applied)"). Client was receiving unframed bytes and never completing its MLLP frame parser.
- **Fix:** Changed to `conn.send(encodeFrame(ackPayload))` in `_sendAutoAck`
- **Files modified:** src/server/server.ts
- **Commit:** 1d61594

**2. [Rule 2 - Missing] Default `'error'` handler on accepted connections**
- **Found during:** Task 1 GREEN (1 error: `ERR_UNHANDLED_ERROR` from D-04 error emission test)
- **Issue:** `_sendAutoAck`'s catch block calls `conn.emit('error', ...)`. EventEmitter throws `ERR_UNHANDLED_ERROR` if no `'error'` listener is registered. The test's server had no error listener, causing the test runner to see an unhandled exception.
- **Fix:** Added `conn.on('error', ...)` in `_onSocketAccepted` that forwards to `this.emit('error', ...)` only when the server has listeners; otherwise silently swallows.
- **Files modified:** src/server/server.ts
- **Commit:** 1d61594

**3. [Rule 2 - Missing] `void` on `onMessage` return value**
- **Found during:** Task 1 GREEN ESLint check
- **Issue:** `this._opts.onMessage?.(payload, meta, conn)` can return `Promise<Buffer>` — ESLint `no-floating-promises` flagged this as an error.
- **Fix:** Added `void` prefix to suppress; return value is intentionally ignored in auto-ACK mode.
- **Files modified:** src/server/server.ts
- **Commit:** 1d61594

## Known Stubs

| Stub | File | Line | Reason |
|------|------|------|--------|
| `totalBytesIn: 0` | src/server/server.ts | ~372 | Plan 04 aggregates from `conn.getStats().bytesIn` |
| `totalBytesOut: 0` | src/server/server.ts | ~373 | Plan 04 aggregates from `conn.getStats().bytesOut` |
| `byteOffset: 0` | src/server/server.ts | ~540 | Plan 04 threads actual byte offsets from FrameReader |

These stubs don't prevent Plan 02's goal (auto-ACK synthesis). They are pre-existing from Plan 01.

## Threat Surface Scan

All 5 threats from the plan's `<threat_model>` were addressed:

| Threat | Status |
|--------|--------|
| T-04-02-01 (DoS: _buildAutoAck MSH parse) | Mitigated — all array accesses guarded with `?? ''`; catch block prevents any throw; fallback buffer on missing MSH |
| T-04-02-02 (EoP: autoAck fn callback) | Mitigated — dispatch wrapped in try/catch (D-04); errors emitted on connection, not re-thrown |
| T-04-02-03 (Info: ACK content) | Accepted — ACK contains only fields from inbound MSH; no new secrets |
| T-04-02-04 (DoS: async handler leak) | Mitigated — try/catch inside `_sendAutoAck`; void dispatch; conn error listener prevents unhandled rejection |
| T-04-02-05 (DoS: backpressure-dropped ACK) | Mitigated — `conn.send()` false return → `MllpConnectionError({ phase: 'send' })` emitted on connection |

## TDD Gate Compliance

- RED gate: `4fdd6e6` — `test(04-02): add failing tests for _buildAutoAck, auto-ACK dispatch, and backpressure`
- GREEN gate: `1d61594` — `feat(04-02): add _buildAutoAck private method, fix framing in auto-ACK send, handle backpressure`

Both gates present in git log. No REFACTOR commit needed (code clean after GREEN).

## Self-Check: PASSED

- `src/server/server.ts` exists: YES
- `test/server/auto-ack.test.ts` exists: YES
- RED commit `4fdd6e6` exists: YES
- GREEN commit `1d61594` exists: YES
- `pnpm typecheck` exits 0: YES
- `pnpm lint` exits 0: YES
- `pnpm test` exits 0: YES (259/259 tests pass)
- `_buildAutoAck` in src/server/server.ts: YES (line 406)
- `MSA|AA` in src/server/server.ts: YES (lines 413, 455)
- `fields[9]` extraction: YES (line 435)
- `autoAck === 'AA'` branch: YES (line 590)
- `phase: 'send'` backpressure: YES (line 614)
- No `.slice()` in live code: CONFIRMED
- No `console.*` in live code: CONFIRMED
