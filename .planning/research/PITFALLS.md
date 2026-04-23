# Pitfalls Research — `@cosyte/hl7-mllp`

**Domain:** HL7 v2 MLLP transport library (TypeScript / Node.js)
**Researched:** 2026-04-22
**Confidence:** HIGH on framing, ACK, backpressure, reconnect pitfalls (corroborated by multiple real-world bugs and specs); MEDIUM on TLS edge cases (inferred from Node TLS behavior — vendor-specific MLLP+TLS post-mortems are sparse); MEDIUM on NAK/"wire weirdness" (widely reported anecdotally, spec text is thin).

This document enumerates specific, named mistakes that real MLLP implementations ship with. Each pitfall names the failure mode, a real example, a warning-sign surface, a concrete prevention strategy mapped to code in our planned library, the REQ-ID (existing or proposed) that guards against it, and the test fixture that will prove we are immune.

**REQ-ID coverage audit result:** 73 existing v1 REQ-IDs cover most of the critical surface. This research proposes **11 new REQ-IDs** to close specific gaps: OBS-01..05 (observability surfaces), CLIENT-10..12 (ACK-correlation robustness, reconnect classification, in-flight drain contract), FRAME-11 (byte-fidelity guarantee), TLS-05 (SNI default), SERVER-08 (framing tolerance on server ingress). See "Proposed new REQ-IDs" at the end.

---

## Critical Pitfalls

### Pitfall 1: Delimiter split across chunk boundary — the #1 naive-implementation bug

**What goes wrong:**
A peer sends `…<payload>0x1C 0x0D<VT><payload>…` in one logical write, but TCP delivers it as two chunks split between `0x1C` and `0x0D` (or between the trailing `0x0D` and the next `0x0B`). A naive reader scans the current chunk for `0x1C 0x0D`, doesn't find the pair, and either drops the frame, stalls waiting for more `0x1C` bytes, or (worse) emits the payload truncated before the FS.

**Why it happens:**
Implementers treat `'data'` events as message-sized packets instead of arbitrary byte runs. The delimiter pair is two bytes, so any partition with one boundary in the middle of it breaks. This fails roughly 1-in-65k of the time in lab testing against a local peer, and ~5–20% of the time over a real WAN — exactly the rate at which MLLP integrations mysteriously "work in dev, flake in prod."

**Real example:**
[amida-tech/mllp issue #2 "MLLP Does not support Multiple Messages"](https://github.com/amida-tech/mllp/issues/2) (open since 2015) — the library mis-handles concatenated frames. The upstream reporter theorises the parser assumes one `data` event == one message. [crs4/hl7apy issue #37 "MLLP server can't handle smartHL7 message sender when multiple messages are sent one after next"](https://github.com/crs4/hl7apy/issues/37) documents the same class of bug in Python. The MLLP v1 transport spec itself calls out that implementations must tolerate fragmentation: the HL7 v2 delimiter sequence is `<FS><CR>` and splitting mid-delimiter is protocol-legal (see [Rene Spronk's Transport Specification: MLLP, Release 1](https://www.hl7.org/documentcenter/public/wg/inm/mllp_transport_specification.PDF)).

**Warning signs:**
- Silent message loss under load (hard to diagnose — no error, just missing messages).
- Intermittent `MllpTimeoutError` on the *sender* because the receiver never ACK'd a message that was split across chunks.
- Unit tests pass on localhost loopback but integration fails on real networks.

**Prevention strategy:**
A stateful three-state reader FSM (`SCANNING_FOR_VT` / `READING_PAYLOAD` / `EXPECTING_CR`) with a rolling accumulator that never assumes a chunk contains a complete delimiter. Any FS byte advances to `EXPECTING_CR`; if the chunk ends there, state is preserved across the next chunk. Byte-level tests drive the reader with every possible partition.

**Phase / REQ-ID:** Phase 2. Guarded by **FRAME-04, FRAME-05, TEST-03** (chunked-read fuzz suite with 1-byte chunks). HIGH confidence in prevention — the FSM design in the roadmap is explicit about this.

**Test fixture that proves immunity:**
`test/framing/chunked-read.test.ts`: for each canonical fixture, enumerate partitions where the split falls at every byte offset (including the FS/CR boundary, inside the FS, and between CR and the next VT). Assert N-frames-in-yields-N-payloads-with-identical-bytes. Covered by TEST-03.

---

### Pitfall 2: Treating incoming bytes as a string and corrupting non-ASCII payloads

**What goes wrong:**
A reader does `chunk.toString('utf8')` or accumulates into a `string` buffer, then slices around the delimiters. This corrupts any payload whose MSH-18 declares CP1252, ISO-8859-1, Shift_JIS, or any other non-UTF-8 single-byte encoding — specifically when a byte sequence happens to be an invalid UTF-8 continuation. The payload is silently mangled (or surrogate-escaped) and any downstream parser sees garbage where characters like `é`, `ö`, `±`, `μ` used to be. Multibyte encodings like Shift_JIS can also generate bytes that collide with framing (this is why MSH-18 excludes UTF-16/UTF-32 from MLLP use).

**Why it happens:**
Node's `'data'` events default to `Buffer`, but many tutorials show `socket.setEncoding('utf8')`. HL7 v2 is *nominally* ASCII, so the mistake looks harmless in dev. Also: `Buffer.concat` followed by `.toString('utf8')` is idiomatic for HTTP, and developers carry the pattern over.

**Real example:**
The HL7 spec is explicit that MLLP supports all single-byte encodings and UTF-8/Shift_JIS (see [MLLP Transport Specification](https://hl7.skyware-group.com/lib/exe/fetch.php?media=wiki:mllp.pdf)). The InterSystems community post [HL7 Encoding issue](https://community.intersystems.com/post/hl7-encoding-issue) documents exactly this failure mode: a German site sending CP1252 → accented characters become `?`. [Node issue #61744](https://github.com/nodejs/node/issues/61744) (Feb 2026) documents that even Node's internal UTF-8 handling silently drops bytes when multi-byte characters split across chunk boundaries. [Node issue #23280](https://github.com/nodejs/node/issues/23280) documents `Buffer.toString('utf8')` returning WTF-8 instead of erroring on invalid surrogates.

**Warning signs:**
- Characters like `é`, `ö`, `ü` appear as `?` or U+FFFD in downstream consumers.
- Round-trip bytes-in / bytes-out differ (easy automated test).
- MSH-18 declares `8859/1` or `UNICODE UTF-8` and the parser emits errors the sender doesn't see.

**Prevention strategy:**
Buffer-first API — public API signatures are `Buffer` everywhere. The reader accumulator is `Buffer[]` + `Buffer.concat` (not `string`). The payload between VT and FS is emitted as a `Buffer` slice with zero encoding touches. Charset interpretation is *the caller's job* — a non-goal explicitly enshrined in PROJECT.md's "Key Decisions."

**Phase / REQ-ID:** Phase 2. Guarded by the buffer-first decision in `Key Decisions` and by **SERVER-03** / **CLIENT-02** payload-type contracts. HIGH confidence — no REQ today says "payload is bytes-identical end-to-end," though. **Propose new REQ-ID FRAME-11** to make this an explicit test:

> **FRAME-11** — For any input byte sequence `B` of any length ≥ 0 containing no VT/FS bytes, `FrameReader.yield(encodeFrame(B))` emits a single payload `Buffer` exactly byte-identical to `B` (including all 256 possible byte values, verified over a randomized corpus).

**Test fixture:** Round-trip every byte value 0x00–0xFF, a CP1252 fixture (`À Á Â Ã Ä`), a UTF-8 fixture with 4-byte codepoints, a binary blob, and a pseudo-random 1 MB buffer.

---

### Pitfall 3: Stripping leading VT then re-adding without trailing CR on emit

**What goes wrong:**
On receive, the library strips `VT` and the terminator to yield a payload. On emit (for an ACK or a pass-through), it re-wraps with `VT + payload + FS` but forgets the terminating `CR` — or emits `FS\n` (LF) instead of `FS\r`. The peer interprets the missing CR as a "still reading payload" signal, buffers indefinitely, and eventually times out. Alternatively, the peer accepts it (liberal decoder) and it works 99% of the time until the 1% peer that enforces `FS+CR` strictly rejects it.

**Why it happens:**
`\n` vs `\r\n` confusion is a universal classic, exacerbated by template literals and string concatenation. `Buffer.from("...\n")` is one keystroke shorter than `Buffer.from("...\r")`.

**Real example:**
[amida-tech/mllp](https://github.com/amida-tech/mllp)'s source has shipped encoder variants that differ in exact byte output across versions. The [keeps/mllp](https://github.com/keeps/mllp) fork was created because of "issues fixed, namely to create a clone of the input data array prior to swapping elements" — a related mutation-on-emit bug. The MuleSoft connector docs explicitly call out: [verify ACKs have proper framing](https://docs.mulesoft.com/hl7-mllp-connector/latest/hl7-mllp-connector-examples), because mismatched framing is common enough to warrant documentation.

**Warning signs:**
- Peer logs show "malformed frame" or "incomplete MLLP block."
- ACKs appear to be accepted by some peers but rejected by others, same bytes.
- Captured with Wireshark / `tcpdump -x`: last byte is `0x0A` or absent, not `0x0D`.

**Prevention strategy:**
Single-path encoder: `encodeFrame(buf: Buffer): Buffer` is the *only* way any code in the library serializes to wire. `client.send()`, `conn.send()`, and any ACK helper route through it. Encoder is strict (Postel's Law) — there is no option to emit anything other than `VT + payload + FS + CR`.

**Phase / REQ-ID:** Phase 2. Guarded by **FRAME-01** and **FRAME-03** ("Encoder never emits any variant of framing other than canonical `VT…FS+CR`; there is no option to loosen the emit path"). HIGH confidence.

**Test fixture:** Asserts every emit path (client send, server reply, auto-ACK, raw pass-through) ends with exact bytes `0x1C 0x0D`. Covered by TEST-02 + TEST-04.

---

### Pitfall 4: Decoder-leniency violates Postel by also loosening the encoder

**What goes wrong:**
A library accepts FS-only terminators on ingress (reasonable), and also emits FS-only terminators when talking to peers that "seem to accept it" (unreasonable). Downstream peers that strictly enforce `FS+CR` silently drop the message. The bug is invisible from the sending library's perspective — its `send()` resolves on flush — and only surfaces as an ACK timeout that the dev attributes to "network flakiness."

**Why it happens:**
Symmetry feels natural ("if I accept X, I emit X"). It's actively wrong. Postel's Law explicitly demands asymmetric behavior — liberal ingress, conservative egress.

**Real example:**
Multiple of the small MLLP npm packages derive their encoder from their decoder's terminator detection, which means a permissive decoder default produces a permissive encoder. The MLLP v1 spec mandates `VT + content + FS + CR` on emit; accepting variants on ingress is a field practice, not spec.

**Warning signs:**
- Wireshark shows `FS` alone.
- Some peers NAK with "malformed frame" while others accept it — inconsistent behaviour across peers is the tell.

**Prevention strategy:**
Separate the `encodeFrame()` and `FrameReader` modules physically — no shared "framingOptions" type. Encoder takes only `{ allowDelimiterBytesInPayload?: boolean }`; decoder takes `allowFsOnly`, `allowLfAfterFs`, etc. Code-review rule: no PR adds an option to the encoder that changes terminator bytes.

**Phase / REQ-ID:** Phase 2. Guarded explicitly by **FRAME-03** ("there is no option to loosen the emit path"). HIGH confidence.

**Test fixture:** TEST-04's tolerance suite asserts each tolerance codepath is reachable only from the reader, never from the encoder.

---

### Pitfall 5: Treating leading-VT tolerance as "ignore any byte before FS," swallowing embedded FS

**What goes wrong:**
A reader implements `allowMissingLeadingVt` by skipping bytes until it sees an FS, then emitting the payload. But if the payload legitimately contains an embedded FS byte (e.g., a binary blob, which is legal if the caller opts into `allowDelimiterBytesInPayload` on emit), the reader cuts the message short at the embedded FS and re-syncs mid-payload.

**Why it happens:**
Resync-by-terminator is cheaper than resync-by-start-delimiter, so implementers take a shortcut.

**Real example:**
Not a single famous bug URL — this is the class of bug the MLLP spec's "SHOULD not contain framing bytes" warning exists to prevent. It shows up in implementations that try to "resync" after a framing error by scanning forward to the next FS rather than the next VT.

**Warning signs:**
- Truncated messages when embedded binary data exists.
- Decoder and encoder disagree on whether the same bytes are legal — encoder throws `MLLP_PAYLOAD_CONTAINS_FS`, decoder silently accepts.

**Prevention strategy:**
The `allowMissingLeadingVt` codepath must still scan *forward to the next byte that looks like a payload start*, not the next terminator. A missing VT only applies at the very start of the stream (or immediately after a known terminator) — not in the middle of a corrupted frame. Recovery after a protocol error is to `MLLP_TRAILING_BYTES` until the next VT.

**Phase / REQ-ID:** Phase 2. Guarded by **FRAME-09** (leading-VT tolerance is scoped to stream-start / post-terminator) and **WARN-05** (trailing bytes between CR and VT emit a warning, are discarded). MEDIUM confidence — the REQ-IDs as written don't *forbid* re-sync-by-FS explicitly. Acceptance criterion for FRAME-09 should read "treats the first byte of the stream *or the first byte after a terminator*" — which is already the current wording. HIGH confidence once TEST-03's fuzz suite includes an "embedded FS with leading-VT missing" case.

**Test fixture:** A fixture that opens with no VT, contains an embedded FS in the payload, and a real FS+CR at the end. Assert the reader treats the embedded FS as payload bytes (not a frame boundary) when `allowMissingLeadingVt: false`, and emits `MLLP_MISSING_LEADING_VT` + truncates when `true`. Covered by an addition to TEST-04.

---

### Pitfall 6: Two messages in one TCP chunk — reader stops after the first

**What goes wrong:**
Kernel coalescing delivers two (or ten) `VT…FS+CR` frames in a single `'data'` event. A reader that assumes one event = one message emits the first payload and discards the tail.

**Why it happens:**
Same root cause as Pitfall 1 — assuming `'data'` packet boundaries correspond to message boundaries.

**Real example:**
[amida-tech/mllp issue #2](https://github.com/amida-tech/mllp/issues/2) and [crs4/hl7apy issue #37](https://github.com/crs4/hl7apy/issues/37) both include the "concatenated messages" variant. Any batch-send test against a naive receiver surfaces it within seconds.

**Warning signs:**
- Under load, for every N messages sent, fewer than N ACKs received.
- Receiver queue depth flat, sender queue depth climbing.

**Prevention strategy:**
FrameReader is a generator that yields zero-or-more complete payloads per `push(chunk)` call. Loop until `SCANNING_FOR_VT` runs out of bytes.

**Phase / REQ-ID:** Phase 2. Guarded by **FRAME-05** ("N complete frames concatenated in a single chunk"). HIGH confidence.

**Test fixture:** TEST-02 1 MB payload + TEST-03 fuzz where a single `push()` contains 1..N complete frames plus a partial tail.

---

### Pitfall 7: ACK correlation by byte-equality of payload instead of MSA-2

**What goes wrong:**
A client's ACK matcher stores the outbound payload buffer and compares inbound ACK bytes for equality (or checks if the ACK payload "contains" the outbound controlId). First breaks on payload normalization (trailing whitespace, segment terminator differences); second breaks when two controlIds are substrings of each other (`MSG001` vs `MSG001A`).

**Why it happens:**
MSH-10 parsing requires a mini-parser. Byte-match is easier to ship. Developers think "ACKs come back in order so I don't need correlation at all" and then a Mirth channel with parallel threads surprises them.

**Real example:**
Mirth Connect's Source/Destination channel configurations allow parallel processing → out-of-order ACKs ([nextgenhealthcare/connect discussion #5946](https://github.com/nextgenhealthcare/connect/discussions/5946)). The BizTalk known-issues page documents that [two-way MLLP may not detect ACK problems](https://learn.microsoft.com/en-us/biztalk/adapters-and-accelerators/accelerator-hl7/mllp-adapter-known-issues) because validation is "lightweight" — a euphemism for "we don't properly correlate to the outbound message."

**Warning signs:**
- ACKs occasionally resolve the wrong outbound `send()` promise.
- `send()` returns an ACK whose MSA-2 doesn't match the MSH-10 you sent.
- Under stress, `send()` promises resolve in wrong order → downstream logic sees "ADT^A01 acked with an ACK for a previous ADT^A08."

**Prevention strategy:**
When `correlateByControlId: true`, a minimal MSH-10 extractor (split on `\r`, find the MSH segment, split on the MSH-1 field separator, take field 10) runs on outbound. Inbound ACKs run the same extractor on MSA-2. FIFO mode is available but documented as "only safe when the peer is known to ACK strictly in order." An ACK whose MSA-2 matches no pending outbound emits `MllpFramingError` via `onError` and the inbound is discarded without resolving any promise — the orphan send awaits its own timeout.

**Phase / REQ-ID:** Phase 5. Guarded by **CLIENT-03**. HIGH confidence that CLIENT-03 as written captures the intent. **Propose tightening: CLIENT-10** to make the orphan-ACK semantics explicit:

> **CLIENT-10** — When `correlateByControlId: true` and an inbound ACK's MSA-2 matches no pending `send()`, the ACK is discarded with `onError(MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID'))`; no `send()` resolves or rejects as a result. Pending sends continue to await their own `ackTimeoutMs`. The unmatched ACK bytes are included in the error's `snippet`.

Also **propose CLIENT-11** for late-arriving ACKs after timeout:

> **CLIENT-11** — An ACK arriving after the outbound `send()` has already rejected with `MllpTimeoutError` is treated as an unmatched ACK under the `correlateByControlId` policy above. The client never resolves a promise that has already settled. Emits `MLLP_ACK_AFTER_TIMEOUT` warning with the elapsed-since-send duration.

**Test fixture:** ACKs delivered out of order, with duplicate MSA-2, with prefix-overlap controlIds, and with late arrival after timeout. Covered by a TEST-06 addition.

---

### Pitfall 8: Treating AE/AR as "not an ACK" and waiting for AA

**What goes wrong:**
A client treats `MSA-1=AA` as the "ACK received" signal and anything else as a timeout. `AE` (Application Error) and `AR` (Application Reject) are *also ACKs* that indicate the peer processed the message and rejected it — the send should resolve (with the error payload), not time out.

**Why it happens:**
"ACK = AA" is the intuitive model. Subtlety of HL7 v2 ACK codes is buried in Chapter 2.

**Real example:**
The HAPI javadocs for [MinLowerLayerProtocol](https://hapifhir.github.io/hapi-hl7v2/base/apidocs/ca/uhn/hl7v2/llp/MinLowerLayerProtocol.html) distinguish transport-layer ACK (received the bytes) from application-layer ACK (AA/AE/AR). Many small libraries conflate them and treat AE as a send failure. The [Medplum Agent docs](https://www.medplum.com/docs/agent/acknowledgement-modes) document enhanced ack modes explicitly because the original mode is frequently mis-handled.

**Warning signs:**
- `send()` times out when the peer actually responded with AE in < 100 ms.
- Peer logs "ACK sent" at the same moment our logs say "ACK timeout."

**Prevention strategy:**
Our library operates at the MLLP layer, not the HL7 application layer — so `send()` resolves with *the ACK Buffer*, whatever MSA-1 it contains. Parsing MSA-1 is the caller's job. Critically, the docs must say this plainly. Helper `buildAckAE` / `buildAckAR` exist only for server-side ACK construction; we never "interpret" inbound ACKs on the client side beyond MSA-2 correlation.

**Phase / REQ-ID:** Phase 5 (client) + Phase 6 (ACK helpers) + Phase 8 (docs). Guarded by **CLIENT-02** ("resolves with the inbound ACK's payload (framing stripped)") + **DOCS-04** ("cookbook section"). HIGH confidence that the behavior is correct. Gap: README does not *explicitly* say "AE/AR are ACKs too." Proposed DOCS-04 cookbook addendum — not a new REQ-ID, just a documentation requirement.

**Test fixture:** TEST-02 canonical fixtures include an AE response; assert `send()` resolves (not rejects) with an AE ACK payload.

---

### Pitfall 9: Orphaned pending ACKs on connection reset

**What goes wrong:**
Client has 12 sends pending ACK. Socket `error` + `close` fire. The library transitions to `DISCONNECTED` but never settles the 12 `Promise`s — they hang forever, leaking timers, memory, and downstream state machines. On auto-reconnect, the new connection's ACKs may match old pending controlIds by chance, resolving promises with wildly wrong data.

**Why it happens:**
Reconnect logic lives in a different module from promise bookkeeping. Error handlers focus on the socket, not the promise pool. Timer cleanup is a separate concern from promise rejection.

**Real example:**
[wso2/product-ei issue #4582 "HL7TransportSender closing outgoing connection"](https://github.com/wso2/product-ei/issues/4582) documents send handles hanging after connection close. Generally: any long-lived WebSocket/TCP Node library's test suite includes a "does pending promises reject on disconnect" case because everyone gets this wrong once.

**Warning signs:**
- Heap grows unbounded after connection flaps.
- `queueDepth` metric climbs across reconnect boundaries.
- Pending promise count > 0 after connection enters `DISCONNECTED`.

**Prevention strategy:**
`Connection` → `DISCONNECTED` transition drains the pending-ACK registry: with `autoReconnect: false`, reject every pending `send()` with `MllpConnectionError({ phase: 'send' })`. With `autoReconnect: true`, pending sends *stay queued and are retried on reconnect only up to `highWaterMark`* — the caller opted into this semantic. Every pending send has a monotonic `ackTimeoutMs` timer that fires independent of connection state.

**Phase / REQ-ID:** Phase 5. Guarded by **CLIENT-06** ("Setting `{ autoReconnect: false }` causes pending sends to reject with `MllpConnectionError` on disconnect"). HIGH confidence for the `autoReconnect: false` path. Gap: **CLIENT-06 does not specify what happens to queued sends whose ACKs arrive on a *different* connection after reconnect.** Propose:

> **CLIENT-12** — Outbound sends queued during a reconnect are re-transmitted on the new connection only when `correlateByControlId: true` is set (MSH-10 disambiguates them); under FIFO mode (`correlateByControlId: false`), queued sends are rejected with `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })` to avoid silent cross-connection correlation. Documented in the cookbook.

**Test fixture:** Send 10 messages, destroy socket mid-flight, assert all 10 promises settle (not resolve-with-garbage) — either reject (fifo mode) or resolve-with-correct-ACK-on-reconnect (controlId mode). Addition to TEST-06.

---

### Pitfall 10: Reconnect tight loop against a permanent error (auth, bad cert, bad port)

**What goes wrong:**
Client's `autoReconnect: true` treats every disconnect as transient. TLS certificate rejected? Retry forever. DNS NXDOMAIN? Retry forever. Peer returning RST to TCP SYN because the port is firewalled? Retry forever, hammering an operator's alerting system. Exponential backoff caps at 30s, so we're still at 2 retries/min permanently — not a crash, just a log-and-metric nightmare.

**Why it happens:**
Distinguishing transient from permanent requires knowing which underlying `errno` values / TLS error codes are retryable. Nobody implements this taxonomy correctly the first time.

**Real example:**
[nodejs/node issue #55330](https://github.com/nodejs/node/issues/55330) documents the classic `ECONNREFUSED`/`ECONNRESET` retry loop. The [Node retry-exponential-backoff guide](https://oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff/view) explicitly calls out that auth errors should *not* be retried indefinitely. Integration engineers on Mirth forums regularly report channels in an "always-reconnecting" state against decommissioned endpoints.

**Warning signs:**
- `reconnecting` event fires thousands of times/hour to the same host.
- No successful `CONNECTED` transition for > 5 minutes.
- Log noise overwhelms real errors.

**Prevention strategy:**
Classify errors into *transient* (ECONNRESET, ECONNREFUSED, ETIMEDOUT, EPIPE, EHOSTUNREACH, ENETUNREACH) and *permanent* (ENOTFOUND for DNS, CERT_HAS_EXPIRED, CERT_UNTRUSTED, UNABLE_TO_VERIFY_LEAF_SIGNATURE, ERR_TLS_CERT_ALTNAME_INVALID, EACCES). Permanent errors transition to `DISCONNECTED` and stop auto-reconnect; the `onError` handler gets `MllpConnectionError({ phase: 'connect', permanent: true })`. Caller must explicitly re-enable via `client.reconnect()`.

**Phase / REQ-ID:** Phase 5. Gap in REQ-IDs as written — CLIENT-05 says "auto-reconnect with exponential backoff" without distinguishing error classes. **Propose new REQ-ID:**

> **CLIENT-13** — Auto-reconnect distinguishes transient from permanent errors. Transient errors (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`) trigger exponential backoff retries as per CLIENT-05. Permanent errors (`ENOTFOUND`, TLS handshake failures with cert-validation root causes, `EACCES`) transition to `DISCONNECTED` with `MllpConnectionError({ phase: 'connect', permanent: true, cause })` and halt auto-reconnect; caller opts in via `client.reconnect()` to retry. The classifier is exported from `@cosyte/hl7-mllp` as `isTransientConnectionError(err): boolean` for customization.

MEDIUM confidence — no existing REQ addresses this. HIGH after CLIENT-13.

**Test fixture:** Mock a `ENOTFOUND` on connect (e.g., `host: 'this-host-does-not-exist.invalid'`) and assert reconnect fires once, then halts with `permanent: true`. Addition to TEST-06.

---

### Pitfall 11: Double-reconnect race between `error` and `close` events

**What goes wrong:**
Node's `net.Socket` fires `error` then `close` on most failures. A naive reconnect handler attached to both events schedules two reconnect attempts — then two in-flight connect attempts race, one wins and the other's success callback fires against a now-stale closure. Connection state desyncs from actual socket state.

**Why it happens:**
Event-handler-per-event is the natural way to write Node code. Deduping across the two events requires a state machine, which people add in v2.

**Real example:**
Common enough that the `ws` library, `net` library wrappers, and every MQTT client have explicit tests for it. The symptom in amida-tech-style MLLP libraries is "double connect events after a network blip."

**Warning signs:**
- Two `CONNECTED` state transitions without an intervening `DISCONNECTED`.
- `connectionId` changes twice per failure.
- ACK promises from before the blip resolve against ACKs from after (data integrity nightmare).

**Prevention strategy:**
Connection FSM is the single source of truth. `error` and `close` both route into a single `disconnect(reason)` handler, which is idempotent — if already `DISCONNECTED`, no-op. Reconnect is triggered *only* on the FSM's `DISCONNECTED` entry callback, not on raw socket events.

**Phase / REQ-ID:** Phase 3. Guarded by **LIFE-01**, **LIFE-02**, **LIFE-05** (FSM as source of truth). HIGH confidence.

**Test fixture:** Simulate `error` + `close` in the same tick via `InMemoryTransport.destroy(reason)`; assert exactly one `DISCONNECTED` transition and exactly one reconnect attempt. Addition to TEST-06.

---

### Pitfall 12: Half-open connection — TCP says writable, peer is gone

**What goes wrong:**
Flaky VPN drops packets silently, no FIN/RST reaches our side. `socket.writable === true`, `send()` resolves on flush, ACKs never arrive. Exponential ACK-timeouts pile up. User sees "my integration is broken but nothing is erroring."

**Why it happens:**
TCP is designed to tolerate packet loss. Half-open detection requires either application-level heartbeats or OS-level keepalives tuned aggressively. Default Linux TCP keepalive is 2 hours idle + 9 probes × 75s = ~4 hours to detect a dead peer. Unusable for HL7.

**Real example:**
[health-samurai.io MLLP+VPN guide](https://www.health-samurai.io/articles/getting-started-with-hl7-messaging-over-mllp-using-a-vpn) explicitly recommends application-level dead-peer detection for MLLP-over-VPN. The [ConnectReport Node keep-alive tuning post](https://connectreport.com/blog/tuning-http-keep-alive-in-node-js/) documents that Node's default `setKeepAlive` doesn't actually configure the aggressive intervals needed. Integration engineers universally report "the connection looked fine but no messages were flowing" on stale VPN tunnels.

**Warning signs:**
- No `error` event, no `close` event, but `ackTimeoutMs` fires 3+ times in a row.
- Bytes-received metric is flat for > keepalive interval.
- RTT metric (time from send to ACK) suddenly → timeout.

**Prevention strategy:**
Two independent mechanisms, both configurable:
1. **`keepaliveIntervalMs`** → sets `socket.setKeepAlive(true, keepaliveIntervalMs)` for OS-level probes.
2. **`deadPeerTimeoutMs`** → application-level watchdog: if no bytes received for this interval, forcibly destroy the socket with `MllpConnectionError({ phase: 'receive', cause: 'idle-timeout' })`. Triggers auto-reconnect if enabled.

Both are **off by default** (HL7 integrations vary wildly in expected idle time — a lab vs an ED are worlds apart), but the README cookbook shows typical production values (e.g., `deadPeerTimeoutMs: 90_000`).

**Phase / REQ-ID:** Phase 5 (client) + Phase 4 (server-side equivalent). Guarded by **CLIENT-08** and **SERVER-07**. HIGH confidence.

**Test fixture:** `InMemoryTransport.destroy(reason: 'silent')` simulates a half-open (no event fired, but peer never reads/writes). With `deadPeerTimeoutMs: 100`, assert forced disconnect + reconnect within bounded time. Addition to TEST-06.

---

### Pitfall 13: Ignoring `socket.write()` return value → unbounded buffer growth

**What goes wrong:**
`write()` returns `false` when the kernel send buffer is full. A naive implementation keeps calling `write()` anyway; Node buffers in userspace; memory grows unbounded. A slow peer or a saturated link produces OOM within minutes under realistic load (10 MB messages × 100 msg/s × 10 min = 60 GB).

**Why it happens:**
`write()` returning `false` is advisory, not an error. Developers ignore advisory returns all the time.

**Real example:**
The Node docs explicitly warn: ["Since TCP sockets may never drain if the remote peer does not read the data, writing a socket that is not draining may lead to a remotely exploitable vulnerability"](https://nodejs.org/api/stream.html). Node's backpressure doc commit [032d73841d](https://github.com/nodejs/node/commit/032d73841d) was specifically written to educate against this anti-pattern. Memory benchmarks show ~20× difference (87 MB vs 1.52 GB) between respecting vs ignoring the return value.

**Warning signs:**
- RSS climbs without bound under load.
- `queueDepth` rises faster than `ackRate`.
- Eventually, OOM kill.

**Prevention strategy:**
Client has a strict queue: `send()` enqueues, an internal drainer calls `socket.write()` and listens for the `'drain'` event before issuing the next. When queue depth ≥ `highWaterMark` (default 64 messages), `send()` either rejects immediately (`onBackpressure: 'reject'`) or blocks (`onBackpressure: 'wait'`). Configurable high-water mark can be tuned to bytes-in-flight for 10 MB+ payload workloads.

**Phase / REQ-ID:** Phase 5. Guarded by **CLIENT-07** + **ERR-04**. HIGH confidence.

**Test fixture:** `InMemoryTransport.pause()` to simulate saturation, queue 100 sends, assert the 65th rejects with `MllpBackpressureError` (in reject mode) and queue depth never exceeds 64. Covered by TEST-06.

---

### Pitfall 14: Measuring in-flight by count when payloads are huge

**What goes wrong:**
`highWaterMark: 64` means 64 messages. Each message is 10 MB (radiology ORU). 640 MB in-flight → OOM. The count-based high-water mark was sized for typical 10 KB ADT messages.

**Why it happens:**
Message-count is the intuitive unit. Byte-count requires knowing the payload size before enqueue, which most APIs do.

**Real example:**
Not a famous bug — this is a workload-mismatch failure. It shows up in any radiology / imaging integration where ORU^R01 carries embedded OBX^5 Base64 blobs.

**Warning signs:**
- Memory use proportional to `queueDepth × averageMsgSize`.
- Works fine for ADT/SIU/MDM but OOM on ORU.

**Prevention strategy:**
`highWaterMark` accepts either a message count (number) or a byte budget (`{ bytes: 10_000_000 }`). Internal accounting tracks both. Default stays at 64 messages for backward compat and because "typical" HL7 is small.

**Phase / REQ-ID:** Phase 5. CLIENT-07 as written specifies "in-flight messages (default: 64)" — count-based. **Propose tightening of CLIENT-07** (not a new REQ — amend existing):

> CLIENT-07 amendment: `highWaterMark` accepts `number` (message count, default 64) or `{ bytes: number }` (byte budget). Both units are honored simultaneously when both are specified — the stricter of the two triggers backpressure.

MEDIUM confidence. Either the amendment lands or TEST-06 includes an "ORU 10 MB × 100" fixture that forces the feature.

**Test fixture:** 100 × 1 MB sends with `highWaterMark: { bytes: 10_000_000 }`; assert the 11th rejects.

---

### Pitfall 15: Timeout clock starts at `send()` call, not at bytes-on-wire

**What goes wrong:**
User sets `ackTimeoutMs: 5000`. Calls `send(buf)`. The send is queued behind 30 others due to backpressure. 10 seconds later, the bytes finally hit the wire. The timer fired 5 seconds ago; the send already rejected with `MllpTimeoutError` even though the peer is perfectly healthy and ACK-latency is 50ms.

**Why it happens:**
`setTimeout(cb, ms)` at enqueue is the obvious implementation. Timer-on-wire-write requires threading the timer through the drain machinery.

**Real example:**
The MLLP spec is synchronous (source system shall not send new HL7 content until an ACK for the previous content is received — see [MuleSoft docs](https://docs.mulesoft.com/hl7-mllp-connector/latest/hl7-mllp-connector-examples)), so in the strict case, queue-wait + wire-time + peer-processing + return-time all count against a single timeout. But many integrations pipeline (unsafe but common), and the spec-correct interpretation is "timeout starts when the last byte of the outbound message is flushed."

**Warning signs:**
- `MllpTimeoutError` rate scales with `queueDepth`, not with peer latency.
- `elapsedMs` in the error exceeds peer's actual ACK latency by ~queue-wait time.

**Prevention strategy:**
Timer starts at `socket.write(frame, cb)` callback completion (bytes flushed to kernel), not at `send()` call. `MllpTimeoutError`'s `elapsedMs` field measures from this point. Document explicitly in `ERR-02`.

**Phase / REQ-ID:** Phase 5. Guarded by **CLIENT-04** and **ERR-02** (elapsedMs field). MEDIUM confidence as written — the REQ says "per-message `ackTimeoutMs`" but doesn't specify the clock start. **Propose tightening of CLIENT-04** (amendment, not new REQ):

> CLIENT-04 amendment: `ackTimeoutMs` is measured from the moment the frame is flushed to the kernel (the write callback fires), not from the `send()` call. Time spent in the backpressure queue does not count against the timeout.

**Test fixture:** `InMemoryTransport.pause()` for 3s, then resume; a `send()` with `ackTimeoutMs: 1000` should succeed (ACK arrives within 1s of actual transmission). Addition to TEST-06.

---

### Pitfall 16: TLS — `onConnect` fires after TCP but before handshake

**What goes wrong:**
`net.Socket` fires `connect` after the TCP handshake. For TLS, `tls.TLSSocket` fires `connect` at the same point, then `secureConnect` after the TLS handshake. A library that wires its own `CONNECTING → CONNECTED` transition to `connect` instead of `secureConnect` will flip to `CONNECTED` too early. `send()` in that window enqueues bytes on an un-encrypted connection → the peer drops them → silent loss.

**Why it happens:**
Node TLS re-uses event names with different semantics. [nodejs/node#10644](https://github.com/nodejs/node/issues/10644) documents the historical `secure` vs `secureConnect` confusion. [nodejs/node#32958 "http2: wait for secureConnect before initializing"](https://github.com/nodejs/node/pull/32958) is exactly this bug in the Node HTTP/2 code.

**Warning signs:**
- First message after TLS connect is sometimes lost.
- Works on localhost (handshake is instant), flakes over WAN.

**Prevention strategy:**
`TlsTransport` subscribes to `secureConnect` (or `secure` on server), not `connect`, for the `CONNECTED` transition. TLS handshake errors map to `MllpConnectionError({ phase: 'connect', cause })`.

**Phase / REQ-ID:** Phase 6 (TLS wiring) + Phase 3 (lifecycle). Guarded by **TLS-03** ("CONNECTING → CONNECTED fires after the TLS handshake completes, not merely after TCP handshake"). HIGH confidence. This is already explicit in the REQ.

**Test fixture:** TLS round-trip with an instrumented transport that records the exact event that triggered the state transition. TEST-06 TLS failure case plus a success case.

---

### Pitfall 17: TLS — missing SNI → wrong vhost → wrong cert

**What goes wrong:**
Peer hosts multiple HL7 endpoints behind one IP via SNI (common in cloud-hosted integration engines like Redox, Particle). Client connects without `servername`; peer picks a default cert; cert validation fails or (worse) succeeds against a different SAN and lands on the wrong tenant's MLLP endpoint.

**Why it happens:**
[Node's `tls.connect()` does not set SNI by default](https://nodejs.org/api/tls.html) — unlike `https`, which does. Developers assume parity.

**Real example:**
Every cloud-hosted HL7 vendor documentation page that uses SNI calls it out. [Node TLS docs](https://nodejs.org/api/tls.html) explicitly warn: *"tls.connect() does not enable the SNI extension by default, which may cause some servers to return an incorrect certificate or reject the connection altogether."*

**Warning signs:**
- Cert validation error mentions an unexpected CN/SAN.
- Works against an on-prem peer with a single cert, fails against a cloud peer.

**Prevention strategy:**
When `tls.servername` is not explicitly set, default it to `tls.host`. Document this behavior. Refuse to connect if neither is set.

**Phase / REQ-ID:** Phase 6. **TLS-02** lists `servername` as an accepted option but doesn't make it a default. **Propose new REQ-ID:**

> **TLS-05** — When `createClient({ tls })` is used and `tls.servername` is not explicitly provided, the library defaults it to `tls.host` (or the top-level `host` if `tls.host` is not set). When neither `servername` nor a host is resolvable, `connect()` rejects with `MllpConnectionError({ phase: 'connect', cause: 'tls-sni-required' })` rather than silently connecting without SNI.

MEDIUM confidence as written; HIGH after TLS-05.

**Test fixture:** Two server contexts on one TLS listener via `SNICallback`; client without servername lands on default context; client with correct servername lands on tenant context. Addition to TEST-06.

---

### Pitfall 18: TLS — `rejectUnauthorized: false` as default

**What goes wrong:**
Library defaults to `rejectUnauthorized: false` to make "it works out of the box" with self-signed certs. Users ship to production with this default → MITM vulnerability → HIPAA violation.

**Why it happens:**
Development ergonomics. Self-signed certs are common in HL7 labs. Defaulting to "fail loudly" is user-hostile — unless the domain is healthcare.

**Real example:**
Every security audit of healthcare integrations finds this one. No specific Node MLLP library shipped known-insecure defaults (Node's own `tls` module defaults to `rejectUnauthorized: true`), but wrapper libraries have been known to "helpfully" override it.

**Warning signs:**
- `rejectUnauthorized: false` in example code in the README.
- No warning emitted at connect time when validation is disabled.

**Prevention strategy:**
Default to `rejectUnauthorized: true` (Node's default). If the caller explicitly sets `rejectUnauthorized: false`, emit a one-time warning at `CONNECTED`: `MLLP_TLS_VALIDATION_DISABLED` with a note. Example code uses a bundled `ca` in `examples/tls/` rather than disabling validation.

**Phase / REQ-ID:** Phase 6. **TLS-01** / **TLS-02** accept the http-compatible options but don't mandate a default. Gap: no explicit statement. **Existing behavior is correct** because the library passes options through to Node's tls, which defaults correctly. No new REQ needed — but **DOCS-04** must include the "never set `rejectUnauthorized: false` in production" note. HIGH confidence with the doc note.

**Test fixture:** `examples/tls/` uses a bundled CA, never `rejectUnauthorized: false`.

---

### Pitfall 19: TLS — cert rotation on long-lived connections

**What goes wrong:**
Connection opens with cert-A, stays open for 14 hours across a midnight cert rotation to cert-B. No re-handshake happens. Next day, peer closes the connection (its cert-A expired) — our side reconnects, re-handshakes, pulls cert-B (from disk) — *only if the TLS options are re-read on each connect*. If they were captured once at `createClient()` and pinned, the library continues to present cert-A forever.

**Why it happens:**
Passing `{ cert, key }` as Buffers once seems idiomatic. People forget `tls.createSecureContext()` happens at connection time in Node, so re-reading from disk is a per-connect action.

**Real example:**
Implicit in any long-lived TLS client. [Node TLS docs on `server.addContext`](https://nodejs.org/api/tls.html) documents dynamic context loading; clients are symmetric.

**Warning signs:**
- Cert expires overnight, connection stays up (it's cached), then reconnect cycles start failing 24h later.
- TLS handshake fails only after a business-hours network blip.

**Prevention strategy:**
`createClient({ tls: { getCertificate?: () => ({ cert, key, ca }) } })` callback form — invoked on every connect attempt, enabling the caller to re-read files. Static `{ cert, key, ca }` Buffers remain supported (and pinned, by design).

**Phase / REQ-ID:** Phase 6. **Propose extension to TLS-02 or new TLS-06** — LOW priority for v1 (the static-config pattern works for 95% of deployments; rotation is a v2 feature).

> **TLS-06 (v2 candidate)** — `createClient({ tls: { getTlsOptions: () => TlsOptions | Promise<TlsOptions> } })` invokes the callback on each connect attempt for cert rotation use cases. Static `tls` object remains the default.

Defer to v2. MEDIUM confidence — acceptable to ship v1 without, document the pattern.

**Test fixture:** None for v1.

---

### Pitfall 20: Graceful shutdown — `server.close()` resolves before in-flight ACKs

**What goes wrong:**
`server.close()` in raw Node resolves when the listener stops accepting new connections, *not* when existing connections drain. A SIGTERM handler that awaits `server.close()` then `process.exit(0)` kills the process while a half-sent ACK is mid-wire → sender sees timeout → retries → duplicate HL7 message delivered.

**Why it happens:**
`server.close()`'s semantics are subtle. Most HTTP servers compound the problem by not tracking per-request lifecycle.

**Real example:**
The [Kubernetes graceful-shutdown](https://learnkube.com/graceful-shutdown) community has extensive documentation on this exact failure. [BizTalk MLLP Adapter Known Issues](https://learn.microsoft.com/en-us/biztalk/adapters-and-accelerators/accelerator-hl7/mllp-adapter-known-issues) documents similar batch-message ACK ordering bugs on shutdown.

**Warning signs:**
- Rolling k8s deploys correlate with duplicate messages at the peer.
- Sender logs show `ackTimeoutMs` spikes at deploy times.
- `kill -TERM` in shell while messages in-flight → lost ACKs.

**Prevention strategy:**
`server.close({ drainTimeoutMs })` stops `accept()`, then awaits every `Connection` transition to `DISCONNECTED`. Each `Connection.close()` during `CONNECTED` transitions to `DRAINING`; resolves only after all in-flight-message handlers (and their ACKs) finish. A `drainTimeoutMs` (default 30s) forcibly closes connections that refuse to drain, with a logged warning per connection.

**Phase / REQ-ID:** Phase 4. Guarded by **SERVER-06** ("stops accepting new connections immediately, in-flight messages and their ACKs complete, and any connection that has not drained within 5s is forcibly closed"). HIGH confidence.

**Test fixture:** Server handling a message that takes 2s to process; `server.close({ drainTimeoutMs: 5000 })` during processing → assert ACK is sent and then connection closes. Addition to TEST-06.

---

### Pitfall 21: Client `close()` hangs forever waiting for an ACK that never comes

**What goes wrong:**
`client.close()` semantics say "drain then disconnect." If a peer is slow to ACK (or hung), `close()` never resolves. Caller's graceful-shutdown awaits forever; k8s force-kills the pod at `terminationGracePeriodSeconds`.

**Why it happens:**
Drain semantics need a timeout bound, same as the server side.

**Prevention strategy:**
`client.close({ drainTimeoutMs })` mirrors the server API. Default 30s. After timeout, forcibly destroys in-flight sends with `MllpConnectionError({ phase: 'close' })` and transitions to `DISCONNECTED`.

**Phase / REQ-ID:** Phase 5. Guarded by **CLIENT-09** (`destroy()` as the abrupt variant) + **LIFE-05** (drain timeout). HIGH confidence, but the precise `drainTimeoutMs` parameter on `client.close()` is not explicit in the REQ wording. Existing REQ says "the drain timeout elapses" — leave as-is, LIFE-05 covers it.

**Test fixture:** Client with a peer that never ACKs; `client.close({ drainTimeoutMs: 500 })` resolves within ~500ms with pending sends rejected. Addition to TEST-06.

---

### Pitfall 22: SIGTERM handler missing from examples → process crash-exits

**What goes wrong:**
Examples don't show `process.on('SIGTERM', () => server.close())`. Users copy-paste the example into production, Kubernetes sends SIGTERM on rolling deploy, Node's default SIGTERM handler terminates the process immediately → lost messages.

**Why it happens:**
Signal handling is boilerplate that doesn't look like "the interesting part of MLLP."

**Prevention strategy:**
Every example in `examples/` wires `SIGTERM` and `SIGINT` to graceful shutdown. README cookbook section explicitly covers k8s-readiness.

**Phase / REQ-ID:** Phase 8. Guarded by **DOCS-01** / **DOCS-02** / **DOCS-03** + **DOCS-04** cookbook. HIGH confidence with explicit example content.

**Test fixture:** Manual check; no automated fixture. Document in CONTRIBUTING that examples must include signal handling.

---

### Pitfall 23: `.slice()` in framing path quietly perf-traps under Node.js future deprecation

**What goes wrong:**
Hot-path code uses `buffer.slice()`. In modern Node, `Buffer.prototype.slice()` is [soft-deprecated in favor of `.subarray()`](https://github.com/nodejs/node/commit/2e7bf00359). They currently behave identically (both return a view), but a future removal — or a switch to TypedArray semantics (which *copies*) — silently doubles memory allocation in the hot path.

**Why it happens:**
`.slice()` is what everyone types first.

**Prevention strategy:**
Library-wide lint rule: `no-buffer-slice`. Use `.subarray()` exclusively in framing code. Eslint custom rule in Phase 1's tooling.

**Phase / REQ-ID:** Phase 1. Gap — **SETUP-06** says "`pnpm lint` passes with zero warnings" but doesn't specify a rule against `.slice()`. **Propose new REQ-ID (minor):**

> **SETUP-07** — ESLint config includes a custom rule that rejects `Buffer.prototype.slice()` in `src/framing/`, `src/server/`, and `src/client/` in favor of `.subarray()`, preventing a future Node deprecation from silently doubling memory allocations.

LOW priority — acceptable to ship v1 without if we just audit at PR time. HIGH confidence with SETUP-07.

**Test fixture:** Lint rule in CI.

---

### Pitfall 24: `Buffer.concat` when one input is a string

**What goes wrong:**
`Buffer.concat([chunk1, chunk2])` where `chunk2` is accidentally a string (from a typed-as-`unknown` socket wrapper) throws `TypeError` at runtime, but only when that codepath is hit. The same code may pass unit tests where both are Buffers.

**Why it happens:**
TypeScript `unknown` + `as Buffer` cast lets strings slip through. ArrayBuffer vs Buffer distinction in Node 20+.

**Prevention strategy:**
Strict TypeScript config (`strict: true`, `noUncheckedIndexedAccess: true` already in constraints). Explicit `Buffer.isBuffer(chunk)` runtime check on any externally-received data. Reader's `push(chunk: Buffer): void` signature rejects anything else at compile time.

**Phase / REQ-ID:** Phase 1 + Phase 2. Guarded by **SETUP-05** (strict TS) + the Buffer-first API decision. HIGH confidence.

**Test fixture:** TypeScript compilation itself rejects non-Buffer input to `reader.push()`.

---

### Pitfall 25: Observability gap — operator can't inspect state at 3 AM without adding code

**What goes wrong:**
Something breaks in production. Operator SSHes into the pod. They cannot answer basic questions:
- What's the queue depth right now?
- What connectionIds are active, and what state is each in?
- When did each connection last receive a byte?
- How many warnings (and which codes) has each connection emitted?
- What's the in-flight ACK map (pending controlIds + elapsed wait time)?

Without these, the only debug path is "add code, redeploy, reproduce" — hours of downtime.

**Why it happens:**
"Observability is the caller's concern" (enshrined in our PROJECT.md — "no built-in metrics backend") is the *right* principle, but it leaves a gap: exposing enough *state* for the caller to wire any backend.

**Real example:**
Every post-mortem from every HL7 integration engine includes "we couldn't see what was happening." The Mirth Connect admin UI exists precisely because an MLLP integration without live state visibility is unoperatable.

**Warning signs:**
- First production incident; operator on Slack asking "how do I see the queue?"
- Code grep for `console.log` in user code as they instrument manually.

**Prevention strategy:**
Every public surface exposes pull-style inspection methods. No push-style metrics (that's the caller's concern). Specifically:

- `client.getStats() → { state, connectionId, queueDepth, inFlight: { controlId, elapsedMs }[], warnings: MllpWarning[], bytesIn, bytesOut, lastByteReceivedAt, lastByteSentAt, reconnectAttempts }`
- `server.getStats() → { listening: boolean, connections: ConnectionStats[] }`
- `Connection.getStats() → { state, connectionId, remoteAddress, warnings, bytesIn, bytesOut, lastByteReceivedAt }`

All pull-style, synchronous, cheap. Caller wires to Prometheus / OTEL / logs.

**Phase / REQ-ID:** Gap — no existing REQ covers this. **Propose a new section:**

> ### Observability (OBS)
>
> - **OBS-01** — `client.getStats()` returns a synchronous, serializable snapshot: `{ state, connectionId, queueDepth, inFlight: { controlId?: string, elapsedMs: number }[], warningsByCode: Record<WarningCode, number>, bytesIn: number, bytesOut: number, lastByteReceivedAt: Date | null, lastByteSentAt: Date | null, reconnectAttempts: number }`. Method is cheap (O(n) over in-flight, no I/O).
> - **OBS-02** — `server.getStats()` returns `{ listening: boolean, connections: ConnectionStats[], totalBytesIn, totalBytesOut, activeConnectionCount }`.
> - **OBS-03** — `Connection.getStats()` returns `{ state, connectionId, remoteAddress, remotePort, warningsByCode, bytesIn, bytesOut, lastByteReceivedAt, lastByteSentAt, connectedAt }`.
> - **OBS-04** — All `getStats()` returns are plain JSON-serializable objects (no class instances, no Buffers) so `JSON.stringify(stats)` works directly for log emission.
> - **OBS-05** — `MllpWarning` aggregates are available as `warningsByCode: Record<WarningCode, number>` counts; the full array of warnings is capped at the most recent 100 per connection with a `warningsTruncated: boolean` flag to prevent unbounded memory.

Phase mapping: OBS-01 → Phase 5, OBS-02 → Phase 4, OBS-03 → Phase 3, OBS-04/05 → Phase 3–5 (cross-cutting).

HIGH confidence that these mitigate operator-debug pain; MEDIUM confidence that users will adopt them without a README cookbook entry (address in DOCS-04).

**Test fixture:** Integration test that drives a full cycle and snapshots `getStats()` at key points. Addition to TEST-05.

---

### Pitfall 26: Legacy sender uses `\n` (LF) between messages instead of `\r` (CR)

**What goes wrong:**
Some old vendors send `<VT>...<FS>\n<VT>...<FS>\n` — LF instead of CR between frames. A strict reader stalls; a reader that accepts FS-only (our `allowFsOnly: true`) succeeds because the LF is just trailing bytes between frames. But a reader that requires FS+CR specifically rejects the second frame.

**Why it happens:**
CR vs LF is the universal text-file pun. Old HL7 stacks (MUMPS-era) are particularly sloppy.

**Real example:**
[amida-tech/mllp issue #2](https://github.com/amida-tech/mllp/issues/2) comment explicitly: *"CRLF (\\0x0D\\0x0A) is a message separator for a multi message feed."* Some older HL7 interfaces send LF between messages.

**Warning signs:**
- Receiver processes the first message of a batch, then silently stalls.
- Wireshark shows `0x1C 0x0A` between frames.

**Prevention strategy:**
Tolerance `allowLfAfterFs` is already in the REQ set — FRAME-08. It handles LF *instead of* CR. For LF *after* FS+CR (trailing LF between frames), the `allowLeadingWhitespace` tolerance (FRAME-10) covers it (LF is in the whitespace set). Stack both in compatibility mode.

**Phase / REQ-ID:** Phase 2. Guarded by **FRAME-08** + **FRAME-10**. HIGH confidence.

**Test fixture:** Multi-frame fixture with LF between frames; with `allowLfAfterFs` or `allowLeadingWhitespace`, decodes cleanly with matching warning. TEST-04.

---

### Pitfall 27: Peer expects strict send-ACK-send sequence; pipelining corrupts

**What goes wrong:**
Our client pipelines aggressively by default — sends 30 messages back-to-back, matches ACKs as they arrive. Some peers (BizTalk 2-way MLLP is famously this way) require strict "send, await ACK, send next" serialization. Pipelining against them causes the peer to drop or garble subsequent messages.

**Why it happens:**
The HL7 v2 transport spec says ["the source system shall not send new HL7 content until an ACK for the previous HL7 content has been received"](https://docs.mulesoft.com/hl7-mllp-connector/latest/hl7-mllp-connector-examples) — strict spec-correct behavior is serialized. Pipelining works with permissive peers but violates the letter of the spec.

**Warning signs:**
- Messages are received in the correct order, but every Nth ACK's MSA-2 matches a later message's MSH-10.
- BizTalk peer logs show "multiple concurrent messages" errors.

**Prevention strategy:**
`{ pipeline: boolean }` option on `createClient`. Default `true` (most peers tolerate), but `false` makes `send()` await the ACK of the previous send before writing. With `pipeline: false`, the client internally is send→await-ACK→send, even if the caller `await`s `Promise.all([send, send])`.

**Phase / REQ-ID:** Phase 5. Gap — CLIENT-02/03 as written allow pipelining but don't mention strict serialization. **Propose CLIENT-14:**

> **CLIENT-14** — `createClient({ pipeline: false })` enforces strict MLLP v1 serialization: each `send()` only writes to the wire after the previous `send()`'s ACK has been received (or its `ackTimeoutMs` has fired). Default is `{ pipeline: true }` (the previous behavior). Pipelined mode is documented as "works with most peers; set `pipeline: false` for BizTalk-style strict MLLP v2 peers."

MEDIUM confidence — acceptable to ship v1 with pipelining default and add serialized mode later. Propose shipping with `pipeline` option in v1 since the cost is small.

**Test fixture:** Serialized mode asserts bytes of send[N+1] do not appear on the wire until ACK of send[N] is received. Addition to TEST-06.

---

### Pitfall 28: Some peers send `MSA-1=NAK` (legacy, non-spec)

**What goes wrong:**
Rare but real: a legacy system sends `NAK` where the current spec says `AE` or `AR`. Our library passes it through unchanged (we don't interpret MSA-1), so this should be a non-issue — but *only if* the MSA-2 correlator doesn't choke on non-standard MSA-1 values during parsing.

**Why it happens:**
HL7 v2.1/v2.2 era systems used `NAK`; it was removed in v2.3+. Some systems never updated.

**Real example:**
BizTalk docs reference "NAK generated by two-way MLLP adapter" ([known issues](https://learn.microsoft.com/en-us/biztalk/adapters-and-accelerators/accelerator-hl7/mllp-adapter-known-issues)) but in the sending direction, not receiving. The [Immunization Registry HL7 ACK guidance PDF](https://repository.immregistries.org/files/resources/5835adc2add61/guidance_for_hl7_acknowledgement_messages_to_support_interoperability_.pdf) references the transition from NAK to AE/AR. It shows up in production when integrating with any pre-2.3 lab system.

**Warning signs:**
- ACK correlation fails because MSA-1 parser assumes enum of {AA, AE, AR}.
- Tests against a real legacy peer reveal the unexpected value.

**Prevention strategy:**
MSA-2 extractor does not validate MSA-1. It splits on the MSA segment's field separator and returns field 2 as a string. Any MSA-1 value (including NAK, empty, mixed case) is accepted. Correlation uses only MSA-2.

**Phase / REQ-ID:** Phase 5. Guarded implicitly by CLIENT-03's MSA-2 extraction — does NOT depend on MSA-1 content. HIGH confidence.

**Test fixture:** Fixture ACK with `MSA-1=NAK`; assert `send()` resolves with the ACK Buffer unchanged and MSA-2 correlation works. Addition to TEST-06.

---

### Pitfall 29: Peer closes the connection after every message (old systems)

**What goes wrong:**
Some legacy senders open TCP, send one message, wait for ACK, close TCP. Our server must handle this gracefully — not log an error per connection, not fire `MllpConnectionError`. Our client, if talking to such a peer, must reconnect cheaply — auto-reconnect must not apply backoff aggressively when the disconnect was preceded by a successful ACK round-trip.

**Why it happens:**
Pre-persistent-connection HL7 sent one-shot messages. Some legacy systems (e.g., older lab analyzers) still do.

**Real example:**
[intersystems.com post on TCPOperation connection reset](https://community.intersystems.com/post/connection-reset-while-transferring-hl7-through-tcpoperation) documents this pattern. [nextgenhealthcare/connect discussion #5238 "Keeping connections open"](https://github.com/nextgenhealthcare/connect/discussions/5238) debates the client side of the same issue.

**Warning signs:**
- Server logs one `onDisconnect` per message received — but nothing is wrong.
- Client's reconnect counter climbs rapidly against a working peer.

**Prevention strategy:**
Server: `onDisconnect` after a clean FIN is a `state: 'CONNECTED' → 'DISCONNECTED'` transition with `reason: 'peer-closed'`; not an error. Log it at debug level, not error.
Client: auto-reconnect's exponential backoff *resets to initialDelayMs* after every successful ACK round-trip. This way, a peer that does send-ack-close-reconnect-send-ack-close is not pushed into backoff.

**Phase / REQ-ID:** Phase 3 + Phase 5. Guarded by **LIFE-02** (transition semantics) + **CLIENT-05** (backoff). **Propose amendment to CLIENT-05** (not a new REQ):

> CLIENT-05 amendment: Exponential backoff resets to `initialDelayMs` after any successful `CONNECTED → DISCONNECTED` transition that was preceded by at least one successful ACK. Only transitions where no ACK was received apply compounding backoff.

HIGH confidence with the amendment.

**Test fixture:** Send 10 messages each on a fresh connection (peer closes after every ACK). Assert reconnect attempts use `initialDelayMs` every time, not compounding. Addition to TEST-06.

---

### Pitfall 30: Server accepts strict frames only — real-world peers fail

**What goes wrong:**
Server mirrors the client's strict encoder stance — rejects any non-canonical frame. A real-world sender with `FS` alone (no CR) is rejected → sender logs "peer rejected" → integration dead. The Postel's-Law rule is that the *encoder* is strict; the *decoder* should be liberal (opt-in). Symmetric behavior on the server would be wrong.

**Why it happens:**
Symmetry feels right. Also: "our spec-compliance is tight" sounds like a feature.

**Prevention strategy:**
Server's `createServer({ framing: { allowFsOnly, allowLfAfterFs, allowMissingLeadingVt, allowLeadingWhitespace } })` defaults to *permissive* (all `true`) because real-world peers are messy, but every tolerance still emits a warning. Strict mode (`framing: { strict: true }`) is opt-in for compliance-testing scenarios.

**Phase / REQ-ID:** Phase 4. Gap — SERVER-01..07 don't mention framing tolerance defaults at the server level. **Propose new REQ-ID:**

> **SERVER-08** — `createServer()` exposes `framing: FrameReaderOptions` matching the FrameReader API (FRAME-07..10). Default is permissive (`allowFsOnly: true, allowLfAfterFs: true, allowMissingLeadingVt: true, allowLeadingWhitespace: true`) with all deviations emitting warnings. The caller can opt into `strict: true` to reject non-canonical frames with `MllpFramingError`.

HIGH confidence with SERVER-08.

**Test fixture:** Server receives a non-canonical frame with each tolerance individually; asserts the frame yields a payload + warning with permissive defaults, asserts `MllpFramingError` under `strict: true`. Addition to TEST-04.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| String-based framing (`data.toString().split('\x1c')`) | 10 lines of code instead of 150 | Silent corruption of non-ASCII payloads; chunk-boundary bugs | **Never** — violates core buffer-first promise |
| Shared encoder/decoder options module | DRY | Decoder leniency leaks into encoder, breaking Postel's Law | **Never** |
| `'data'` event → emit one payload | Simple mental model | Multi-message-in-chunk and split-delimiter bugs | **Never** — must use stateful reader |
| Pipeline all outbound sends | High throughput | Breaks with strict-spec peers (BizTalk, some labs) | Default yes, but expose `pipeline: false` |
| Count-based high-water mark | Simple to reason about | OOM under large-payload workloads | Default, with `{ bytes: N }` override |
| `rejectUnauthorized: false` in examples | "It just works" with self-signed | Users ship to prod with MITM vulnerability | **Never** — ship real test certs instead |
| One giant module `mllp.ts` | Simple import | Impossible to audit in an afternoon — violates core positioning | **Never** — split by concern (framing / transport / server / client / ack) |
| Ignore `socket.write()` return value | Simpler send path | Unbounded memory growth; remote DoS exposure | **Never** |
| Single timer per send (starts on `send()` call) | Obvious impl | Queue-wait false-positives on timeout | **Never** — timer starts on flush callback |
| Same `CONNECTED` event for TCP + TLS handshake | Event-name reuse | Silent data loss in the handshake window | **Never** — wait for `secureConnect` on TLS |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Mirth Connect 2-way channel | Assuming strict FIFO ACK | Enable `correlateByControlId: true` |
| BizTalk 2-way MLLP | Pipelining sends | `pipeline: false` — serial send/ACK/send/ACK |
| Epic (Chronicles) MLLP | Assuming persistent connection | Accept that Epic often closes per message; reset backoff on successful ACK |
| Cerner Millennium | UTF-8 assumption | Honor MSH-18 — Cerner ships CP1252 in some locales |
| Cloud-hosted MLLP (Redox, Particle, Zus) | Missing SNI | Always set `servername` on TLS connect |
| On-prem HL7 behind VPN (IPSec) | Default TCP keepalive (2 hour) | Set `deadPeerTimeoutMs: 90_000` and `keepaliveIntervalMs: 30_000` |
| Lab analyzers (legacy, pre-2.3) | Treating MSA-1=NAK as an error | Treat any MSA-1 value as ACK bytes; don't interpret |
| Mirth with persistent-queue retry | Not expecting duplicate messages | Document that peers may resend after timeouts; idempotency is the consumer's concern |
| Imaging systems (radiology ORU^R01) | 64-message count-based high-water mark | Use `highWaterMark: { bytes: 50_000_000 }` |
| k8s rolling deploy | No SIGTERM handler | Wire `SIGTERM` → `server.close({ drainTimeoutMs: 25_000 })` in every example |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Count-only high-water mark | OOM on large-payload workloads | Byte-budget option | 10 MB × 100 msgs/s (~6 min to OOM on a 4 GB pod) |
| `Buffer.prototype.slice()` in hot path | Future perf regression on Node upgrade | Lint rule enforces `.subarray()` | Hypothetical — Node deprecation pending |
| Unbounded pending-ACK map | Memory growth across reconnects | `highWaterMark` bounds + drain on DISCONNECTED | Any long-lived flap-prone connection |
| `Buffer.concat` on every chunk | O(n²) copy growth | Single rolling accumulator, concat only on frame-complete | 1-byte chunks over a 10 MB message → 100M concat cost |
| Sync JSON.stringify on every warning | CPU spike under framing-error storm | Warnings are frozen plain objects; stringify only at log emission | 1000 msg/s × all with warnings |
| Parsing MSH-10 via full HL7 parse | 10–100× slower than substring | Minimal field extractor: split on `\r`, find MSH, split on field-sep, take 10 | High-throughput controlId correlation |
| New `Date()` per event | 1μs × N events | Optional; off unless explicitly subscribed to | 10k msg/s |

## Security Mistakes

| Mistake | Risk | Prevention |
|---------|------|------------|
| `rejectUnauthorized: false` default | MITM; HIPAA violation | Default to Node's `true`; emit warning if caller overrides |
| Missing SNI → wrong-tenant routing | Data exfiltration / mis-delivery | Default `servername` to `host` |
| Logging payload bytes in warnings | PHI in logs | Warnings carry only positional metadata, never payload |
| Using `Buffer.from(chunkSize)` without zero-fill | Information leak in reused buffers | Always `Buffer.alloc` (zero-fills) |
| Accepting any TLS version | Downgrade attack | Pass-through to Node's tls; document minimum is TLSv1.2 |
| Unbounded warning memory per connection | DoS via malformed-frame flood | Cap warnings array at 100, expose `warningsTruncated` flag (OBS-05) |
| `process.env.NODE_TLS_REJECT_UNAUTHORIZED=0` in docs | Normalizing the footgun | Never show in docs; explicit `ca` in examples instead |
| Untrusted peer address in error messages | Log injection | Use `util.format` with explicit placeholders, never concatenate |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Error message without byte offset | "Something broke somewhere in 10 MB" | Every framing error carries `byteOffset` + `snippet` (ERR-01) |
| Warning without stable code | "Can't programmatically react" | Stable exported `WarningCode` union (WARN-02) |
| `CONNECTED` doesn't mean ready for TLS | First send lost | `CONNECTED` fires after `secureConnect`, not `connect` (TLS-03) |
| Silent drop on `autoReconnect: true` | Caller thinks `send()` succeeded | Queued sends either complete on reconnect (controlId mode) or reject (FIFO mode, CLIENT-12) |
| No way to see "what's the queue" | Operator adds code and redeploys | `client.getStats()` (OBS-01) |
| Example shows `rejectUnauthorized: false` | Users ship it to prod | Examples use bundled test CA |
| README doesn't explain AE/AR are ACKs | Users reject valid ACKs | Cookbook section on ACK codes (DOCS-04) |

## "Looks Done But Isn't" Checklist

- [ ] **Framing codec:** passes 1-byte-chunk fuzz across every canonical fixture — verify TEST-03 includes delimiter-split partitions
- [ ] **ACK correlation:** controlId extraction handles MSH-10 with escaped field-separators inside (uncommon but legal) — add fixture
- [ ] **Reconnect:** distinguishes transient vs permanent errors — verify CLIENT-13 lands or explicitly deferred
- [ ] **Backpressure:** byte-budget option, not just count — verify CLIENT-07 amendment or fixture forces it
- [ ] **TLS:** `CONNECTED` fires on `secureConnect`, never on `connect` — verify TLS-03 and a test asserts event source
- [ ] **TLS:** SNI defaults to `host` when `servername` not set — verify TLS-05 lands
- [ ] **Observability:** `client.getStats()` returns queue depth + in-flight map + bytes + lastByteAt — verify OBS-01..05 land
- [ ] **Graceful shutdown:** `server.close({ drainTimeoutMs })` resolves only after in-flight ACKs complete or timeout — verify SERVER-06 test
- [ ] **Graceful shutdown:** examples include `SIGTERM` handler — verify DOCS-01..03
- [ ] **Character set:** round-trip any byte value 0x00–0xFF — verify FRAME-11 lands
- [ ] **Postel's Law:** no shared options type between encoder and decoder — code-review guideline documented
- [ ] **Legacy tolerance:** `allowFsOnly` + `allowLeadingWhitespace` stack for LF-between-frames case — verify TEST-04
- [ ] **Timeout clock:** starts on write-flush callback, not `send()` call — verify CLIENT-04 amendment
- [ ] **AE/AR handling:** `send()` resolves with AE/AR ACK bytes (not rejects) — verify TEST-02 includes AE
- [ ] **Pipeline off:** `pipeline: false` actually serializes writes — verify CLIENT-14 lands
- [ ] **Half-open peer:** `deadPeerTimeoutMs` triggers forced disconnect — verify CLIENT-08 test

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Split-delimiter silent loss | HIGH | Audit all consumers; resend via backfill since last confirmed controlId (consumer's job — we don't store) |
| CP1252 payload corrupted by UTF-8 | HIGH | Identify affected messages by MSH-18; manually re-source from sender |
| Pipelining against strict peer | MEDIUM | Set `pipeline: false`, let sender's queue drain, resume |
| Orphaned pending ACKs on flap | LOW | Restart client; `autoReconnect` false → explicit reject of queued sends |
| Tight-loop reconnect against dead host | LOW | `client.close()`, fix DNS/cert/port, `client.connect()` |
| Half-open silent hang | LOW | `client.destroy()`, backoff-driven reconnect finds the hang, resumes |
| SIGTERM without graceful shutdown | MEDIUM | Kubernetes `terminationGracePeriodSeconds` extension; peer retries if idempotent |
| Missing SNI → wrong cert | MEDIUM | Add `servername`, restart client; peer-side might have logged rejected connections |
| OOM from count-based high-water mark on large payloads | HIGH | Restart pod; add `{ bytes: N }` option; re-source lost messages from sender |
| Observability gap during incident | LOW with `getStats()`, HIGH without | Add `setInterval(() => console.log(client.getStats()), 5000)` as a temporary live probe |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | REQ-ID(s) | Verification |
|---------|------------------|-----------|--------------|
| 1. Delimiter split across chunks | Phase 2 | FRAME-04, FRAME-05, TEST-03 | 1-byte fuzz suite yields N payloads for N frames across all partitions |
| 2. String-corrupts-non-ASCII | Phase 2 | buffer-first decision + **FRAME-11 (new)** | Round-trip every 0x00–0xFF byte |
| 3. Missing CR on emit | Phase 2 | FRAME-01, FRAME-03 | Every emit path ends with `0x1C 0x0D` |
| 4. Encoder inherits decoder leniency | Phase 2 | FRAME-03 | Code-review + test: encoder accepts no terminator-shape option |
| 5. Leading-VT tolerance swallows embedded FS | Phase 2 | FRAME-09 + TEST-03 | Embedded-FS fixture + leading-VT-missing |
| 6. Two messages in one chunk | Phase 2 | FRAME-05 | TEST-02 + TEST-03 batch-in-chunk |
| 7. Byte-equality ACK correlation | Phase 5 | CLIENT-03 + **CLIENT-10 (new)** + **CLIENT-11 (new)** | Out-of-order + duplicate controlId + late-arriving ACK tests |
| 8. AE/AR treated as non-ACK | Phase 5 + Phase 8 | CLIENT-02 + DOCS-04 | TEST-02 AE fixture resolves send() |
| 9. Orphan promises on reset | Phase 5 | CLIENT-06 + **CLIENT-12 (new)** | TEST-06 destroy-with-pending test |
| 10. Reconnect tight loop | Phase 5 | **CLIENT-13 (new)** | TEST-06 ENOTFOUND halts reconnect |
| 11. Double-reconnect race | Phase 3 | LIFE-01, LIFE-02, LIFE-05 | Single DISCONNECTED per failure |
| 12. Half-open connection | Phase 5 | CLIENT-08 | `InMemoryTransport.destroy('silent')` test |
| 13. Unbounded write queue | Phase 5 | CLIENT-07 + ERR-04 | `pause()` + 100 sends rejects at 65th |
| 14. Count-HWM + 10 MB payloads | Phase 5 | CLIENT-07 amendment (byte budget) | 100 × 1 MB with byte budget rejects correctly |
| 15. Timeout starts at send() | Phase 5 | CLIENT-04 amendment | `pause()` 3s → send succeeds with 1s timeout |
| 16. TLS CONNECTED before handshake | Phase 6 | TLS-03 | Event-source assertion |
| 17. TLS missing SNI | Phase 6 | **TLS-05 (new)** | SNI default test |
| 18. `rejectUnauthorized: false` default | Phase 6 + Phase 8 | DOCS-04 cookbook note; existing defaults inherited from Node | Code-review of examples |
| 19. Cert rotation | v2 | deferred | N/A v1 |
| 20. `server.close()` premature resolve | Phase 4 | SERVER-06 | Drain-timeout test |
| 21. `client.close()` hangs | Phase 5 | CLIENT-09 + LIFE-05 | Never-ACK peer + 500ms drain test |
| 22. Missing SIGTERM in examples | Phase 8 | DOCS-01, DOCS-02, DOCS-03 | Example review |
| 23. `.slice()` perf trap | Phase 1 | **SETUP-07 (new, LOW pri)** | Lint rule in CI |
| 24. `Buffer.concat` with string | Phase 1 + 2 | SETUP-05 + buffer-first decision | TS compile error |
| 25. Observability gap | Phases 3/4/5 | **OBS-01..05 (new)** | `getStats()` snapshot in TEST-05 |
| 26. LF between frames (legacy) | Phase 2 | FRAME-08 + FRAME-10 | Multi-frame LF fixture |
| 27. Pipelining against strict peer | Phase 5 | **CLIENT-14 (new)** | Serialized-send assertion |
| 28. MSA-1=NAK (legacy) | Phase 5 | CLIENT-03 (MSA-2 only) | NAK fixture resolves send() |
| 29. Peer closes per message | Phase 3 + Phase 5 | LIFE-02 + CLIENT-05 amendment (backoff reset) | 10-connections-per-10-messages test |
| 30. Server strict by default | Phase 4 | **SERVER-08 (new)** | Server receives non-canonical frame, emits warning + yields payload |

---

## Proposed new REQ-IDs (summary)

Numbered so they drop into REQUIREMENTS.md's existing sections directly. All match the REQ format.

### Framing Codec (FRAME)
- **FRAME-11** — Bytes-in / bytes-out round-trip guarantee over every possible byte value (0x00–0xFF) and a 1 MB random corpus. Proves the buffer-first API never corrupts payload bytes.

### Project Setup (SETUP)
- **SETUP-07** *(LOW priority)* — ESLint rule forbids `Buffer.prototype.slice()` in `src/framing/`, `src/server/`, `src/client/` in favor of `.subarray()`.

### MLLP Server (SERVER)
- **SERVER-08** — `createServer({ framing: FrameReaderOptions })` exposes framing tolerance opt-ins at the server level; defaults to permissive (all tolerances enabled) with warnings emitted; `strict: true` rejects non-canonical frames.

### MLLP Client (CLIENT)
- **CLIENT-10** — Unmatched-ACK semantics under `correlateByControlId`: unknown MSA-2 triggers `onError(MllpFramingError('MLLP_ACK_UNMATCHED_CONTROL_ID'))`; no `send()` resolves/rejects; pending sends wait their own timeout.
- **CLIENT-11** — Late-arriving ACK after its `send()` has timed out: treated as unmatched per CLIENT-10; emits `MLLP_ACK_AFTER_TIMEOUT` warning with elapsed-since-send.
- **CLIENT-12** — Queued-sends-across-reconnect: re-transmitted on the new connection only in `correlateByControlId` mode; rejected with `MllpConnectionError({ phase: 'reconnect', cause: 'fifo-unsafe' })` in FIFO mode.
- **CLIENT-13** — Transient vs permanent error classification in auto-reconnect. Transient (`ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`, `EPIPE`, `EHOSTUNREACH`, `ENETUNREACH`) retries with backoff; permanent (`ENOTFOUND`, TLS cert errors, `EACCES`) halts auto-reconnect; `isTransientConnectionError(err)` exported for customization.
- **CLIENT-14** — `{ pipeline: false }` enforces strict send→await-ACK→send serialization for spec-strict (BizTalk-style) peers; default `pipeline: true`.

### TLS (TLS)
- **TLS-05** — `tls.servername` defaults to `tls.host` when not explicitly set, preventing wrong-tenant-cert bugs against SNI-multiplexed peers; refuses to connect if neither is resolvable.

### Observability (OBS) — new category
- **OBS-01** — `client.getStats()` synchronous snapshot: `{ state, connectionId, queueDepth, inFlight, warningsByCode, bytesIn, bytesOut, lastByteReceivedAt, lastByteSentAt, reconnectAttempts }`.
- **OBS-02** — `server.getStats()` snapshot: `{ listening, connections, totalBytesIn, totalBytesOut, activeConnectionCount }`.
- **OBS-03** — `Connection.getStats()` snapshot: `{ state, connectionId, remoteAddress, remotePort, warningsByCode, bytesIn, bytesOut, lastByteReceivedAt, lastByteSentAt, connectedAt }`.
- **OBS-04** — All stats are plain JSON-serializable objects (no Buffers, no class instances) so `JSON.stringify(stats)` works directly.
- **OBS-05** — Per-connection warning array capped at 100 most-recent with `warningsTruncated: boolean`; `warningsByCode` retains full counts.

### REQ amendments (not new, tightening wording)
- **CLIENT-04 amendment** — `ackTimeoutMs` clock starts on write-flush callback, not `send()` call.
- **CLIENT-05 amendment** — Exponential backoff resets to `initialDelayMs` after any disconnect preceded by a successful ACK.
- **CLIENT-07 amendment** — `highWaterMark` accepts either a message count (`number`) or a byte budget (`{ bytes: number }`); stricter of the two triggers backpressure.

### Documentation (DOCS)
- **DOCS-04 addendum** — Cookbook explicitly covers: (a) AE/AR are ACKs, `send()` resolves with them; (b) k8s SIGTERM wiring pattern; (c) never `rejectUnauthorized: false` in production; (d) pipeline vs serialized mode; (e) half-open VPN tuning (`deadPeerTimeoutMs` + `keepaliveIntervalMs`).

**Total new REQ-IDs:** 11 (FRAME-11, SETUP-07, SERVER-08, CLIENT-10..14, TLS-05, OBS-01..05). Three amendments to existing REQs. One DOCS-04 content expansion.

---

## Sources

**Real bugs in Node MLLP libraries:**
- [amida-tech/mllp issue #2 "MLLP Does not support Multiple Messages"](https://github.com/amida-tech/mllp/issues/2) — multi-frame-per-chunk bug, unresolved since 2015
- [amida-tech/mllp issue #13 "TypeScript Support"](https://github.com/amida-tech/mllp/issues) — signals API-surface rigidity
- [amida-tech/mllp issue #7 "Support Various ACK Types"](https://github.com/amida-tech/mllp/issues) — AE/AR/NAK handling gap
- [keeps/mllp](https://github.com/keeps/mllp) — fork created specifically to fix amida-tech bugs (input array mutation on ACK swap)
- [PantelisGeorgiadis/hl7-mllp](https://github.com/PantelisGeorgiadis/hl7-mllp) — README self-describes as "work-in-progress, not for production or clinical purposes"; no TLS, no chunked-read docs
- [mllp-node on npm](https://www.npmjs.com/package/mllp-node), [@keepsolutions/mllp-node](https://www.npmjs.com/package/@keepsolutions/mllp-node), [@caremesh/mllp](https://www.npmjs.com/package/@caremesh/mllp) — landscape survey

**Real bugs in related MLLP implementations:**
- [python-hl7 issue #44 "MLLP client doesn't receive full ack response when expected"](https://github.com/johnpaulett/python-hl7/issues/44) — early connection close before full ACK bytes arrive
- [crs4/hl7apy issue #37 "MLLP server can't handle smartHL7 message sender when multiple messages are sent one after next"](https://github.com/crs4/hl7apy/issues/37) — multi-frame-per-chunk, Python version
- [nextgenhealthcare/connect issue #1227 "Simple LLP listener -Receive Timeout Bug"](https://github.com/nextgenhealthcare/connect/issues/1227) — Mirth delays ACK by timeout instead of sending immediately
- [nextgenhealthcare/connect issue #1456 "Mirth doesn't send any ack back for non-entirely valid XML/HL7 messages"](https://github.com/nextgenhealthcare/connect/issues/1456) — silent drop on malformed message; sender retries indefinitely
- [nextgenhealthcare/connect issue #734 "When Mirth times out waiting for an HL7 ack it should always retry"](https://github.com/nextgenhealthcare/connect/issues/734) — ACK timeout + persistent-queue bug
- [nextgenhealthcare/connect discussion #5946 "TCP Listener ack response not always sent"](https://github.com/nextgenhealthcare/connect/discussions/5946) — out-of-order ACK in 2-way channels
- [nextgenhealthcare/connect discussion #5238 "Keeping connections open to TCP listener"](https://github.com/nextgenhealthcare/connect/discussions/5238) — persistent connection vs. one-shot legacy senders
- [wso2/product-ei issue #4582 "HL7TransportSender closing outgoing connection"](https://github.com/wso2/product-ei/issues/4582) — pending send handles on close

**Node.js primitives with known traps:**
- [nodejs/node issue #61744 "UTF-8 character corruption in fast-utf8-stream.js via releaseWritingBuf()"](https://github.com/nodejs/node/issues/61744) — February 2026 silent UTF-8 corruption bug
- [nodejs/node issue #23280 "Buffer.toString('utf8') appears to use wtf-8"](https://github.com/nodejs/node/issues/23280)
- [nodejs/node issue #4942 "Buffer.toString('utf8') seems to change the output"](https://github.com/nodejs/node/issues/4942)
- [nodejs/node issue #55330 "Socket Hang Up / ECONNRESET / ECONNREFUSED on consecutive http requests"](https://github.com/nodejs/node/issues/55330) — retry-loop against flaky peer
- [nodejs/node issue #10644 "when SSL handshake is done 'secure' instead of 'secureConnect' event is emitted"](https://github.com/nodejs/node/issues/10644)
- [nodejs/node PR #32958 "http2: wait for secureConnect before initializing"](https://github.com/nodejs/node/pull/32958) — TLS handshake timing
- [nodejs/node commit 2e7bf00359 "doc: deprecate buffer.slice"](https://github.com/nodejs/node/commit/2e7bf00359)
- [nodejs/node commit 032d73841d "doc: handle backpressure when write() return false"](https://github.com/nodejs/node/commit/032d73841d)

**Specifications and vendor documentation:**
- [HL7 MLLP Transport Specification, Release 1 (Rene Spronk)](https://www.hl7.org/documentcenter/public/wg/inm/mllp_transport_specification.PDF) — framing, character sets, ACK timing
- [MLLP Transport Specification (Skyware mirror)](https://hl7.skyware-group.com/lib/exe/fetch.php?media=wiki:mllp.pdf)
- [HL7 v2.7 MSH.18 - Character Set Field](https://hl7-definition.caristix.com/v2/HL7v2.7/Fields/MSH.18)
- [HL7 Alternate Character Sets (THO v7.1)](https://terminology.hl7.org/CodeSystem-v2-0211.html)
- [HL7 MSA - Message Acknowledgment Segment (HL7 v2.8)](https://hl7-definition.caristix.com/v2/HL7v2.8/Segments/MSA)
- [HL7 ACK Guidance (Immunization Registry)](https://repository.immregistries.org/files/resources/5835adc2add61/guidance_for_hl7_acknowledgement_messages_to_support_interoperability_.pdf)
- [HL7 V2 ACK Guidance (HL7 Confluence)](https://confluence.hl7.org/spaces/CONF/pages/256183953/HL7+V2+ACK+Guidance)
- [Interfaceware LLP – Lower Layer Protocol](https://www.interfaceware.com/hl7-transport-llp)
- [HAPI Java MinLowerLayerProtocol](https://hapifhir.github.io/hapi-hl7v2/base/apidocs/ca/uhn/hl7v2/llp/MinLowerLayerProtocol.html) — reference implementation semantics

**Vendor & integrator perspectives:**
- [Redox Engine blog — HL7v2 Hurdles](https://redoxengine.com/blog/hl7v2-hurdles/)
- [Medplum Agent Acknowledgement Modes](https://www.medplum.com/docs/agent/acknowledgement-modes)
- [InterSystems — HL7 Encoding Issue](https://community.intersystems.com/post/hl7-encoding-issue)
- [InterSystems — Connection reset while transferring HL7 through TCPOperation](https://community.intersystems.com/post/connection-reset-while-transferring-hl7-through-tcpoperation)
- [Health Samurai — HL7 messaging over MLLP using a VPN](https://www.health-samurai.io/articles/getting-started-with-hl7-messaging-over-mllp-using-a-vpn)
- [MuleSoft HL7 MLLP Connector Examples](https://docs.mulesoft.com/hl7-mllp-connector/latest/hl7-mllp-connector-examples)
- [MuleSoft MLLP connector outbound connectivity issues](https://help.mulesoft.com/s/article/MLLP-CONNECTIVITY-issues-with-MLLP-connector-when-sending-HL7-messages-Outbound)
- [BizTalk MLLP Adapter Known Issues](https://learn.microsoft.com/en-us/biztalk/adapters-and-accelerators/accelerator-hl7/mllp-adapter-known-issues)
- [BizTalk MLLP Send Adapter Processing](https://learn.microsoft.com/en-us/biztalk/adapters-and-accelerators/accelerator-hl7/mllp-send-adapter-processing)
- [InterSystems HealthShare HL7 Business Operations settings (StayConnected)](https://docs.intersystems.com/healthconnectlatest/csp/docbook/DocBook.UI.Page.cls?KEY=EHL72_settings_bo)
- [Google Cloud MLLP Adapter](https://github.com/GoogleCloudPlatform/mllp/) — production reference

**Node.js and general technique references:**
- [Node.js TLS documentation](https://nodejs.org/api/tls.html) — SNI, secureConnect, rejectUnauthorized
- [Node.js Backpressuring in Streams](https://nodejs.org/learn/modules/backpressuring-in-streams)
- [ConnectReport — Tuning HTTP Keep-Alive in Node.js](https://connectreport.com/blog/tuning-http-keep-alive-in-node-js/)
- [Kubernetes Graceful Shutdown guide](https://learnkube.com/graceful-shutdown)
- [OneUptime — Retry Logic with Exponential Backoff in Node.js](https://oneuptime.com/blog/post/2026-01-06-nodejs-retry-exponential-backoff/view)
- [Sindre Sorhus — Goodbye, Node.js Buffer](https://sindresorhus.com/blog/goodbye-nodejs-buffer) — `.slice()` vs `.subarray()` direction

---

*Pitfalls research for: `@cosyte/hl7-mllp`*
*Researched: 2026-04-22*
*Confidence: HIGH (framing, ACK correlation, backpressure, reconnect, graceful shutdown, legacy peer behavior); MEDIUM (TLS edge cases, observability API shape, NAK legacy MSA-1 handling — inferred from related sources rather than MLLP-specific post-mortems)*
