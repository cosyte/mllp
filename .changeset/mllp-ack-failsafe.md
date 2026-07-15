---
"@cosyte/mllp": patch
---

`buildRawAck` and the server's auto-ACK path now **refuse to answer `AA` for a message they could
not correlate** (MLLP-ACK-FAILSAFE). A positive acknowledgement is a promise the sender may forget
the message; when it names a control ID the sender cannot match — or names one of several messages
it never read — the sender times out and resends, committing a **duplicate clinical message** (or,
worse, believes a destroyed message was delivered). `buildMllpAck` (the `ack-from-hl7` subpath)
already downgraded and warned on an unparseable inbound; the raw builder and the server's default
`autoAck: 'AA'` path did not, and that divergence was the bug.

A requested positive code (`AA`/`CA`) is now **downgraded** to its non-positive counterpart
(`AE`/`CE`) whenever the payload cannot carry a correlatable positive ACK. Four peer-reachable
inputs, all pre-existing, previously produced a positive `MSA|AA|`:

1. **An inbound with no MSH-10** — a readable `MSH` but an empty message control ID: `MSA|AA|` with
   an empty MSA-2, correlating to nothing.
2. **Two concatenated `MSH` messages in one frame** (a documented real-world quirk) — one `AA`
   naming only the first control ID, message 2 silently unacknowledged. A single MSA-2 can echo only
   one MSH-10, so a batch or concatenation is refused rather than partially correlated.
3. **A `BOM`/`SP`/`TAB` before `MSH`** — the junk shares the `MSH`'s segment line, so `MSH` heads no
   `CR`/`LF`-delimited segment and the message is unreadable: previously `MSA|AA|` with an empty
   MSA-2 and no warning.
4. **A raw `VT` inside a payload** (verified over a real socket) — the decoder discards the
   accumulated bytes (`MLLP_TRAILING_BYTES`) and delivers only the *fragment* after it. The clinical
   message is destroyed in transit; the server used to auto-ACK the fragment `MSA|AA|`. The auto-ACK
   path now downgrades any frame the decoder flagged with discarded bytes, even when the surviving
   fragment parses cleanly — a condition `buildRawAck` cannot see (it receives only the fragment),
   so it lives in the server path.

The fix is a **refusal**, not a widened reader: it never makes an unreadable message readable, never
re-bases on a located `MSH`, and never parses a batch. Batch ACK stays its own unbuilt feature
(`MLLP-BATCH`) — an `FHS`/`BHS`/`BTS`/`FTS` envelope and concatenated `MSH` segments both remain a
**loud, non-positive** answer.

The wire downgrade in `buildRawAck` protects any direct caller of the public export (defense in
depth). The server's auto-ACK path re-checks the same condition so the downgrade is **observable**:
it emits a PHI-safe `'nack'` event carrying a new `reason` field
(`NackReason = 'handler-rejected' | 'uncorrelatable-inbound' | 'discarded-bytes'`), never the
payload or control ID. New exports: `rawAckUncorrelatable(payload)` and the `NackReason` type.

Decoder: `MLLP_TRAILING_BYTES` is now **reserved for a mid-payload `VT` discard** (the delivered
payload is the remnant after accumulated bytes were dropped) — the frame-scoped signal the auto-ACK
downgrade keys on. It is no longer *also* emitted for an inter-frame stray byte under the default
`allowFsOnly` path, where it was both an overload of that meaning and **mis-attributed to the next
frame** (emitted after the frame was delivered, so it bled into the following frame's warnings). A
stray byte after `FS` is now reported by `MLLP_FS_WITHOUT_CR` alone. Without this, a perfectly good
message pipelined after `… FS <stray> VT …` would have been wrongly downgraded to `AE` — a
duplicate-message bug the conformance gate caught in the first cut of this fix.
