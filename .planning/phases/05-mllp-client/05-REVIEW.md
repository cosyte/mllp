---
phase: 05-mllp-client
reviewed: 2026-05-01T00:00:00Z
status: severe
counts:
  critical: 1
  high: 4
  medium: 6
  low: 5
  nit: 6
---

# Phase 5 — MLLP Client Adversarial Code Review

**Scope reviewed**

- `src/client/client.ts` (1801 lines)
- `src/client/correlator.ts` (480 lines)
- `src/client/error.ts` (171 lines)
- `src/client/index.ts` (21 lines)
- `src/connection/error.ts` (`ConnectionErrorCause` extension)
- `src/connection/index.ts` (re-exports)
- `src/index.ts` (Phase 5 barrel)

**Headline:** one critical correctness bug that strands `send()` promises forever in
`correlateByControlId: true` mode when the disconnect classifier flags the cause as
`permanent`. Several MEDIUM issues cluster around timer / listener cleanup on edge
paths, plus a couple of HIGH observability + retry-state bugs that will silently
corrupt subsequent reconnect cycles. The codebase is otherwise tidy, type-strict,
and free of `Buffer.slice()` / `console.*` / unjustified `any` casts.

---

## CRITICAL

### CR-01 — Pending sends hang forever on a permanent disconnect in `correlateByControlId` mode

**File:** `src/client/client.ts:813-864`

**Issue.** Inside `_handleDisconnect()`, the FIFO branch (lines 820-850) explicitly
rejects in-flight (`'in-flight-orphan'`) and queued (`'fifo-unsafe'`) sends and
removes them from the correlator. The controlId branch is intentionally a no-op
(lines 814-818) because in-flight frames need to survive across reconnect for
re-transmission (D-08 / CLIENT-17).

Immediately after, the classifier check fires:

```ts
if (classifiedAs === 'permanent') {
  this._userClosed = true;
  this._connection?.destroy(err);
  return;
}
```

For controlId mode, that early return leaves every entry in `Correlator._pending`
**without ever calling `_teardownCorrelator()` or rejecting the entries**. The
subsequent `Connection.destroy()` transitions the FSM `DISCONNECTED → CLOSED`, but
inside `_onStateChange()` (lines 1196-1224):

- `isPostConnectedDrop` requires `e.from === 'CONNECTED'`. By the time `destroy()`
  fires, the FSM is already in `DISCONNECTED` (the original transition that
  triggered `_handleDisconnect`). So `e.from === 'DISCONNECTED'`, branch is `false`.
- `isReconnectAttemptFailure` requires `_reconnectCycleStartedAt !== null`. The
  permanent-path `return` runs **before** lines 875-880 set the cycle-start, so
  this is also `null`. Branch is `false`.

Result: in controlId mode, every `send()` promise that was pending at the moment
of a permanent disconnect (e.g. `ENOTFOUND` after DNS expires, or any `CERT_*`
failure) is leaked. The Promises never resolve and never reject — caller code that
does `await client.send(payload)` hangs indefinitely. Memory pressure and
stuck request queues at the application layer follow.

**Why it matters.** This is the failure mode the connection FSM exists to prevent
in the first place. CLOSED is supposed to be terminal-and-observable; right now
it is terminal-and-silent for half of the public modes.

**Suggested fix.** Tear down the correlator before returning on the permanent path,
mirroring the FIFO branch but using a `phase: 'reconnect'` `MllpConnectionError`
with `cause: err`:

```ts
if (classifiedAs === 'permanent') {
  this._userClosed = true;
  if (this._correlator !== null) {
    // Reject every pending entry — controlId branch did not, and the
    // permanent path means we will never reconnect to flush them.
    this._teardownCorrelator(
      new MllpConnectionError('permanent disconnect; pending sends rejected', {
        cause: err,
        phase: 'reconnect',
      }),
    );
  }
  this._connection?.destroy(err);
  return;
}
```

A regression test ought to drive `correlateByControlId: true`, enqueue 2-3 sends,
then trigger a permanent error (e.g. simulate `ENOTFOUND` via the test seam) and
assert all three send promises reject with `MllpConnectionError`.

---

## HIGH

### HI-01 — `_lastError` is never cleared, so a stale error becomes the cause of the next disconnect

**File:** `src/client/client.ts:721-741, 1210, 1029`

`_lastError` is captured by the Connection `'error'` re-emitter and used at line 1210
as the disconnect cause (`const cause = this._lastError ?? new Error(e.reason ?? 'disconnect');`).
After a reconnect cycle succeeds, `_afterReconnectArmed()` clears
`_reconnectCycleStartedAt` but **does not clear `_lastError`**. On the next clean
disconnect (peer closes politely with no socket error), `this._lastError` is still
the stale error from cycle N−1, which becomes the `cause` of cycle N's
`_handleDisconnect()`.

Downstream effects:

- `RetryContext.lastError` reports the wrong error.
- `isTransientConnectionError(err)` could classify a CLEAN remote-close as
  permanent if the prior cycle errored with `CERT_*` — the next disconnect will
  halt auto-reconnect inappropriately.
- The 'error' event emitted by the strategy-throw branch (line 905-912) carries
  a stale `error` payload.

**Suggested fix.** Clear `_lastError = null` in `_afterReconnectArmed()` and at the
top of `connect()` so each cycle starts with a fresh slate. Re-read at the
`_handleDisconnect` entry into a local `const` to avoid TOCTOU.

### HI-02 — `_attempt` and `_lastDelayMs` survive across cycles whenever the prior cycle reconnected without a successful ACK

**File:** `src/client/client.ts:870-880, 1040-1050`

W-01 backoff-reset only triggers when `_lastSuccessAt !== null`. If a reconnect
cycle succeeds at the socket level but the application never receives an ACK
before the next disconnect (e.g. the peer accepts the TCP handshake then RSTs
before any traffic), `_lastSuccessAt` stays `null`, the W-01 reset is skipped, and
the next cycle inherits `_attempt` from the old one — backoff jumps straight to
near-max delay. For a flapping peer this masks the fact that fresh cycles are
starting and silently degrades reconnect responsiveness.

Independently, `_lastDelayMs` is stamped in `_handleDisconnect` (line 938) and
never reset, so on cycle N the `RetryContext.lastDelayMs` reported to the
strategy on the FIRST attempt (`_attempt === 0`) is the LAST delay used by cycle
N−1 — surprising semantics. The JSDoc on `RetryContext.lastDelayMs` says "0 on
the first attempt" which is no longer true.

**Suggested fix.** In `_afterReconnectArmed()`, reset `_attempt = 0` and
`_lastDelayMs = 0` unconditionally — a successful reconnect (CONNECTED state
attained) is the strongest possible "this cycle ended" signal, with or without an
ACK on the new session. If you want to keep the W-01 distinction (only reset
after a *fully* successful exchange), at minimum reset `_lastDelayMs = 0` so the
JSDoc contract is preserved.

### HI-03 — `MllpFramingError` for unmatched-ACK is built with `byteOffset: 0`, masking observability

**File:** `src/client/client.ts:629-650`

The `onUnmatchedAck` callback fires with the controlId that failed to match. The
correlator already has the inbound ACK's stream offset (passed in as
`byteOffsetFromAck` and forwarded to `onWarning` for the `MLLP_ACK_AFTER_TIMEOUT`
case). For the unmatched path it is **dropped** — `MllpClient` constructs the
framing error with hard-coded `0`:

```ts
const err = new MllpFramingError(
  'MLLP_ACK_UNMATCHED_CONTROL_ID',
  0,                       // ← lost — should be the inbound ACK's byteOffset
  Buffer.alloc(0),
  ...
);
```

`byteOffset` is part of the public surface of `MllpFramingError` — operators
correlating an error against tcpdump output expect a real offset. CLAUDE.md
guardrail: warning codes carry "stable codes and positional context" — this
code emits stable codes with positional zero, defeating half the contract.

**Suggested fix.** Plumb the byteOffset through the `onUnmatchedAck` callback:
extend its signature to `(controlId: string, byteOffset: number) => void`,
forward `byteOffsetFromAck` from `correlator.matchAck`, and use it in the
`MllpFramingError` ctor.

### HI-04 — `MllpClient` extends `EventEmitter` with no `setMaxListeners` raise; `'wait'` mode + concurrent waiters trigger `MaxListenersExceededWarning` and possibly miss aborts

**File:** `src/client/client.ts:331, 1381-1429`

In `_waitThenSend`, every waiter calls `this.on('drain', onDrain)`. Default Node
EventEmitter cap is 10. With `onBackpressure: 'wait'` and `highWaterMark: 64`,
realistic deployments will queue more than 10 simultaneous waiters as soon as
the high-water mark trips, producing the `MaxListenersExceededWarning` to stderr
(violating the no-`console`-in-library rule indirectly — Node prints it). Worse,
the warning is emitted from inside the EE machinery, not via a stable warning
code, so callers can't subscribe.

The same pattern in the `pipeline:false` `key === null` branch (line 1342) adds
yet another long-lived `'drain'` listener per send.

**Suggested fix.** In the `MllpClient` constructor, call
`this.setMaxListeners(0)` (unlimited) or compute a sane bound from the
high-water mark + a slack factor. Both `'drain'` registration sites already
self-deregister via `this.off('drain', onDrain)` before re-entering `send()`,
so unlimited is safe. Document the choice.

---

## MEDIUM

### ME-01 — `connect()`'s AbortSignal listener is never removed on graceful close, leaking listener references on shared signals

**File:** `src/client/client.ts:1064-1087, 1483-1553, 1564-1581`

`_captureConnectSignal()` registers an `'abort'` listener on the user-supplied
signal and stores the binding in `this._abortListener`. The listener is
`{ once: true }` so it self-removes when fired, but neither `close()` nor
`destroy()` removes the listener proactively when the client shuts down without
the signal aborting. A long-lived caller signal (e.g. a process-wide
`AbortController`) accumulates one listener per
client-construct-then-discard cycle. The listener also keeps a strong reference
to the `MllpClient` instance via `this._connection?.destroy(...)`, so the client
itself stays GC-pinned to the signal.

**Suggested fix.** Add to both `close()` and `destroy()`:

```ts
if (this._abortListener !== null) {
  this._abortListener.signal.removeEventListener(
    'abort',
    this._abortListener.handler,
  );
  this._abortListener = null;
}
```

### ME-02 — Connection-level `'warning'` and `'message'` listeners are never detached from old `Connection` instances after reconnect

**File:** `src/client/client.ts:684-742, 974-1032`

`_attachConnection` calls `conn.on(...)` eight times for each new Connection.
On reconnect, `_beginReconnectAttempt` builds a NEW Connection and calls
`_attachConnection(conn)` again. The OLD Connection is destroyed but the
listener registrations are never removed. In the typical case the old
Connection is unreachable and gets GC'd — fine. But:

- The closures inside the listeners reference `this` (the MllpClient) and
  `conn` (the OLD Connection). As long as anything still holds a reference to
  the old Connection (e.g. an in-flight microtask resolving its frozen `'message'`
  payload, or user code that captured `event.connectionId` before the swap),
  the old Connection is live, its EventEmitter is live, and the listener is
  live, which keeps a back-edge into MllpClient.
- The closures ALSO call `this._armDeadPeerTimer()` — if a stray late event
  fires from the old Connection (e.g. a buffered `'message'` event that was
  queued before destroy), it will rearm the dead-peer timer on the NEW
  Connection's behalf, possibly extending the timeout window incorrectly.

**Suggested fix.** Track listener references per Connection in a small struct,
and on the next `_attachConnection` (or in `_handleDisconnect` permanent path),
call `conn.removeAllListeners()` on the old Connection before swapping
`this._connection`. Equivalent: swap `conn.on(...)` for a single
`AbortController`-driven listener bag scoped to that Connection.

### ME-03 — `_lastError` capture path swallows errors that aren't `Error` instances

**File:** `src/client/client.ts:721-741`

```ts
const wrapper = e instanceof Error ? e : (e as { error?: unknown })?.error;
if (wrapper instanceof Error) {
  const inner = (wrapper as { cause?: unknown }).cause;
  this._lastError = inner instanceof Error ? inner : wrapper;
}
```

If `e` is a frozen `{ connectionId, error }` payload but `error` is somehow
missing (defensive coding), `wrapper` is `undefined` and `_lastError` is left
unchanged. Next disconnect will use whatever stale `_lastError` is laying
around (see HI-01). The fallback should at minimum stamp a synthetic
`new Error(JSON.stringify(e))` or similar so the cycle has a fresh witness.

Less risky alternative: re-emit `'error'` first (even when not `Error`) and
clear `_lastError` only at cycle-end. Pair this with HI-01's fix.

### ME-04 — `extractMshControlId` and `extractMsaControlId` use `.toString('ascii')`; non-ASCII MSH-10 returns mangled bytes that may falsely match across messages

**File:** `src/client/correlator.ts:76, 141`

HL7 v2 MSH-10 is *technically* ASCII per the spec, but real-world traffic
sometimes carries bytes ≥ 0x80 in MSH-10 (composite IDs from non-conformant
sources). `Buffer.subarray(...).toString('ascii')` masks the high bit, mapping
bytes 0x80-0xFF to 0x00-0x7F. Two distinct MSH-10 values could collapse to the
same ASCII string and falsely match each other in controlId mode.

CLAUDE.md guardrail: "HL7 v2 payloads are raw bytes with caller-managed charset
decoding." The correlator IS itself caller-managed in some sense, but a silent
collision is a worse failure than a missed match.

**Suggested fix.** Use `'latin1'` (1:1 byte-to-codepoint) so two distinct byte
sequences never collide in the string representation:

```ts
return buf.subarray(fieldStart, i).toString('latin1');
```

Both sides (MSH-10 and MSA-2) need the same encoding for keys to match — flip
both extractors atomically.

### ME-05 — `_attachConnection` re-arms the periodic ACK sweep timer only on first attach; if the timer is `unref`'d and the test process clock advances oddly, drift can accumulate across reconnects

**File:** `src/client/client.ts:670-681`

`if (this._ackSweepTimer === null)` is correct for normal flow — the sweep
should keep running across reconnects. But the sweep interval is computed from
`this._ackTimeoutMs` ONCE at first attach. If a future plan ever exposes
`ackTimeoutMs` as a per-`send()` override (already partially supported via
`opts?.ackTimeoutMs` on the send path), entries with a SHORTER per-send timeout
will be expired late on the slow sweep. This is a latent invariant violation
masquerading as latent code.

**Suggested fix.** Either pin the sweep cadence to a constant (e.g. 250 ms) or
recompute it at every `send()` to match the smallest active timeout. At
minimum, document the limitation in `send()`'s JSDoc that per-call
`ackTimeoutMs` is bounded above by the global cadence.

### ME-06 — `_onAckPayload` consumes the FIFO head on every inbound `'message'`, including non-ACK messages on bidirectional channels

**File:** `src/client/client.ts:684-702, 1101-1115`

In FIFO mode, every framed inbound payload is fed to `matchAck`, which removes
the head of the live store. On a bidirectional MLLP channel where the peer
sends an unsolicited query message that the client is not awaiting, this
incorrectly consumes the next pending send's correlator entry, resolves its
promise with the WRONG payload, and leaves the actual ACK to either un-match
(silent drop in FIFO) or match the next pending send (cascading misalignment).

`StarterClientOptions.onMessage` JSDoc explicitly mentions "non-ACK messages on
bidirectional channels" as a supported input — but the FIFO correlator has no
way to distinguish.

**Why it matters.** Most production clients are unidirectional, but the README
quickstart and the `onMessage` API both invite bidirectional use. The first
unsolicited inbound from the peer silently corrupts every in-flight send's
correlation.

**Suggested fix.** In FIFO mode, sniff the inbound payload for `MSA|`
(byte-level prefix at segment boundary). If absent, route the payload to a
non-ACK callback / `'message'` event and DO NOT consume the correlator head.
Document the heuristic. Alternatively, gate `_onAckPayload` behind a
`fifoConsumeUnsolicited` opt-in (default off — current behavior is so
surprising that flipping it is the correct default).

---

## LOW

### LO-01 — `MllpFramingError` snippet is `Buffer.alloc(0)` for unmatched-ACK; dump is empty

**File:** `src/client/client.ts:638`

`Buffer.alloc(0)` ships zero context bytes. For an unmatched-ACK error, ten or
so bytes around the controlId would help operators diagnose mis-formatted ACKs.
Pair this with HI-03 (forwarding `byteOffset` and a real snippet from the
inbound ACK payload).

### LO-02 — `_handleDisconnect`'s `_userClosed = true` on permanent classification means a subsequent `connect()` call is silently a no-op for auto-reconnect (auto-reconnect cannot be re-armed by re-calling `connect()`)

**File:** `src/client/client.ts:858-864, 479-586`

`_userClosed` is sticky for the lifetime of the `MllpClient`. Setting it on
permanent classification means a `try { connect } catch { connect again }`
loop in caller code (a reasonable pattern after a `CERT_*` config fix) bypasses
auto-reconnect on the second connection. Either (a) reset `_userClosed = false`
at the top of `connect()` (with a doc note that this opts you back in) or (b)
distinguish "user-initiated close" from "permanent-error halt" with a separate
flag. Today the two are conflated.

### LO-03 — `_onUnmatchedAck` callback fired with `''` for null controlId silently turns a malformed ACK into a string-keyed lookup miss

**File:** `src/client/correlator.ts:367-369`

When MSA-2 extraction returns `null`, the correlator calls
`this._opts.onUnmatchedAck('')`. The empty string then propagates into the
`MllpFramingError` message. From an observability standpoint, "no controlId
extracted" is a categorically different failure from "controlId X did not
match" and should arguably map to a different warning code
(`MLLP_ACK_NO_CONTROL_ID` or similar). Today both surface as
`MLLP_ACK_UNMATCHED_CONTROL_ID`.

### LO-04 — `getStats().warningsByCode` cast `k as WarningCode` on an arbitrary `Record<string, number>` source

**File:** `src/client/client.ts:1606-1611`

`Connection.warningsByCode` is typed `Record<string, number>` (intentional
because the underlying Map can hold any string). The cast in
`getStats()` widens the merged record to `Partial<Record<WarningCode, number>>`
while in fact the runtime object may contain non-`WarningCode` keys. The TS
type lies. Practically, the only writes into `Connection._warningsByCode` come
from `FrameReader` warnings which ARE `WarningCode`-typed, so it's safe today —
but the type contract is fictional. Consider tightening
`ConnectionStats.warningsByCode` to `Partial<Record<WarningCode, number>>` to
push the constraint to the source.

### LO-05 — `_correlator?.expireDue()` runs every sweep tick regardless of FSM state, including DISCONNECTED / RECONNECTING / DRAINING

**File:** `src/client/client.ts:677-681`

The sweep is `unref()`'d, so no process-keep-alive concern. But during a long
reconnect cycle (controlId mode preserves entries across cycles), `expireDue()`
will start expiring entries based on their PRE-disconnect `sentAt` timestamps —
a 30-second backoff round-trip then expires every entry instantly on
re-connect. Whether this is intended or not, it interacts with HI-02 in
unpleasant ways. Suggested behavior: pause the sweep while not in CONNECTED, or
re-stamp `sentAt` to `null` on disconnect for controlId-preserved entries
(then `_afterReconnectArmed`'s `markFlushed` re-stamps them).

---

## NIT

### NI-01 — `extractMshControlId` returns `null` when `buf[3]` is itself CR/LF; could log a warning instead

**File:** `src/client/correlator.ts:52`

A field separator of `\r` (0x0D) or `\n` (0x0A) is malformed but currently
indistinguishable from "MSH-10 not present." A warning code
(`MLLP_INVALID_FIELD_SEP`) would help debug peer misbehavior; not blocking.

### NI-02 — `MllpClient` does not call `this.setMaxListeners(...)` even though it self-listens for `'ack'` and `'drain'`

**File:** `src/client/client.ts:749-754, 1342`

Pairs with HI-04. Even without 'wait' mode, the `'ack'` self-listener is wired
on every `_attachConnection` invocation when `_ackResetWired` is true... oh
wait, the `_ackResetWired` flag prevents that. Good. NIT level — just signal
intent at construction.

### NI-03 — `_setReconnectFactory` and `_attachExistingConnection` are public methods with `_` prefix marked `@internal` — fine for now, but ESLint `no-underscore-dangle` is not enforced; consider TypeScript `@internal` + `tsdoc` strict to prevent accidental public consumption

### NI-04 — `_handleDisconnect` controlId branch is empty (lines 815-818) with only a comment; consider extracting a named no-op like `_holdInFlightForResend()` for symmetry with the FIFO branch

### NI-05 — Documented JSDoc says `'reconnecting'` event payload is `{ connectionId, attempt?, delayMs? }` (lines 314-315) but `_handleDisconnect` always populates both fields (line 927-934). Either tighten the type or drop the `?`s.

### NI-06 — `_afterReconnectArmed` re-flushes via `conn.send(entry.frame)` then calls `markFlushed(entry.key, now)` for ALL entries, including those whose `sentAt` was already non-null; `markFlushed` is idempotent for `_inFlight` (line 325) but still re-stamps `sentAt`, restarting the ACK timer for entries that were already in-flight. That's CLIENT-17's intent (D-08), but worth a comment in the code rather than only in the file header.

---

## Cross-cutting observations

- **No `Buffer.slice()` usage detected** in any reviewed file. ✓ CLAUDE guardrail clean.
- **No `console.*`** in `src/client/`. ✓
- **No `any`** in client/correlator/error. The `as` casts present are all
  justified (event payload destructuring with frozen unknowns, MSH/MSA byte
  reads guarded by length checks at the top of each extractor, error-cause
  unwrap with `instanceof` re-check). ✓
- **`Object.freeze` on every public emit.** Verified: `'message'`, `'connect'`,
  `'disconnect'`, `'reconnecting'`, `'close'`, `'stateChange'`, `'warning'`,
  `'ack'`, `'drain'`, `'error'`. ✓
- **AbortSignal cleanup** verified at six sites (`connect`, `send`,
  `_waitThenSend`, `pipeline:false` drain wait, `close`,
  `_captureConnectSignal`). All paired except ME-01 (no removal at
  `close()`/`destroy()` time). ✓ except ME-01.
- **`Symbol.asyncDispose`** present and delegates to `close()`. ✓
- **Frozen `RetryContext`** at line 883. ✓
- **Stable error `code` fields**: `MllpTimeoutError`, `MllpBackpressureError`
  expose appropriate fields; `MllpFramingError` reused for ACK-correlation
  errors (HI-03 / LO-01 caveats).
- **Correlator `_inFlight` accounting**: traced through `enqueue`,
  `markFlushed`, `matchAck` (FIFO and controlId), `expireDue`, `clear`,
  `remove`. Increments only in `markFlushed` (guarded by `sentAt === null`),
  decrements only when removing flushed entries. **No overflow / underflow
  paths found.** ✓ Notable: `clear()` resets unconditionally to 0 (line 438) —
  correct by inspection.
- **Bounded accumulators**: highWaterMark gate is in front of `enqueue` (line
  1284-1311); 16 MB `maxFrameSizeBytes` lives in `FrameReader`. ✓
- **Test-only seams** (`_setReconnectFactory`, `_attachExistingConnection`,
  `_captureConnectSignal`) are clearly marked `@internal` and prefixed `_`. ✓

---

## Recommendation

Block phase-close on **CR-01**. HI-01, HI-02, HI-03, HI-04 should be addressed
in the same fix-up pass — they are all small and self-contained. The MEDIUM
items can fold into a Plan-08 hardening pass before Phase 6 (TLS) starts
introducing more code paths.

_Reviewer: Claude (gsd-code-reviewer)_
_Depth: deep_
_Reviewed: 2026-05-01_
