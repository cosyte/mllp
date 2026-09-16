# Engineering guardrails: the three long sections

`CLAUDE.md` keeps `## Engineering Guardrails`, its short rules and the heading of each section below, and points here. The three moved out of that file whole when it went over its byte budget: unchanged and under their own headings. The narrative behind them stays in [`agent-notes.md`](agent-notes.md).

### Framing and ACK correlation (the clinical-safety core)

- **Tolerate terminator noise; NEVER skip DATA** (MLLP-ACK-UTF8). `buildMllpAck` strips *leading `CR`/`LF` only* before `parseHL7`; those bytes carry no data. **It must NOT re-base on the located
  `MSH`**, because that skips an `FHS`/`BHS` batch envelope (§2.10.3) and returns a positive `AA` correlated to message 1 with zero warnings while messages 2..N go unread. An `FHS`/`BHS` envelope
  **must keep** falling through to the warned, non-positive `AE` fallback. **Batch ACK is its own feature: do not arrive at it by accident, and do not "fix" the `AE` into an `AA`.**
  Why: `documentation/agent-notes.md#tolerate-terminator-noise-never-skip-data-mllp-ack-utf8`
- **The MSH is read ONCE, in one place** (MLLP-ACK-UTF8): `src/internal/control-id.ts` owns `readMshSegment` and every MSH-10 / MSA-2 scanner built on it. Three call sites (the client's
  correlator, `buildRawAck`, `buildMllpAck`) must agree byte-for-byte on what a control ID is, or you
  get timeout -> resend -> **duplicate clinical message**. All three call it; each re-derived it once and each got it wrong differently. **Do not re-implement a fourth.**
  Two rules inside it pull in opposite directions and the gate caught a violation of each: **bound the field scan at the segment terminator** (unbounded, it returned PID-3, the patient's
  MRN, as the "control ID" and put it in the correlation key, an error and a warning), **but locate the MSH and never demand it at byte 0** (demanding it made `buildRawAck` emit a silent positive
  `AA` with an empty MSA-2 for a leading-`CR` or batch payload: the duplicate-message failure, manufactured by the fix for it). **Agree at the TOLERANT fixed point.**
  Why: `documentation/agent-notes.md#the-msh-is-read-once-mllp-ack-utf8`
- **Stable warning codes are a public API.** Renaming or removing one is a breaking change. Codes: `MLLP_MISSING_LEADING_VT`, `MLLP_FS_WITHOUT_CR`, `MLLP_LF_AFTER_FS`, `MLLP_LEADING_WHITESPACE`,
  `MLLP_TRAILING_BYTES`, `MLLP_PAYLOAD_CONTAINS_VT`, `MLLP_PAYLOAD_CONTAINS_FS`, `MLLP_EMPTY_PAYLOAD`, `MLLP_FRAME_TOO_LARGE`, `MLLP_ACK_UNMATCHED_CONTROL_ID`,
  `MLLP_ACK_AFTER_TIMEOUT`, `MLLP_ACK_INBOUND_UNPARSEABLE`, `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`, `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` (14 total; the last **three** are `ack-from-hl7`-scoped, emitted
  in `MllpAck.warnings`, not through the framing registry). **`NOT_VERBATIM` and `UNVERIFIABLE` are deliberately distinct and must stay so: the text path must never claim a proof it cannot run.**
  Why: `documentation/agent-notes.md#stable-warning-codes-not_verbatim-and-unverifiable`
- **A warning message is a log line, so it carries no field content, EVER** (MLLP-ACK-UTF8, then `PHI-WARNING-MESSAGE-LEAK`). Report shape, not content: the caller already holds the bytes.
  "It's only a control ID, that's routing metadata" is exactly the reasoning that put an MRN in a log line. **The distinguishing property is not the wording, it is whether the factory takes a value
  parameter at all**: `src/client/ack-diagnostics.ts` is a frozen registry and `ackDiagnosticMessage(code)`
  takes only a code, and the `Correlator` hands out `controlIdBytes`, never the string. **Do not add a value parameter to either.** A truncated ID and a hex rendering are not middle grounds. **And the
  test has to reach the CLIENT** (`test/phi/diagnostic-phi-leak.test.ts` over a real client on `InMemoryTransport.pair()`); a `FrameReader`-only property test was green over this the whole time.
  **`@cosyte/test-utils` must stay pinned at `^0.0.2` or higher**: a caret on `0.0.x` resolves exactly, so `^0.0.1` installs a kit with no runner and the suite passes for the wrong reason.
  Why: `documentation/agent-notes.md#a-warning-message-is-a-log-line-phi-warning-message-leak`

### Connection, transport and TLS

- **No `emit()` reachable from a callback we do not own may go uncontained, in ANY class** (MLLP-10). `EventEmitter.emit()` is synchronous, so a throwing subscriber unwinds to a socket/server listener
  and kills the process, every other connection and every in-flight durable commit with it. Use `src/internal/safe-emit.ts` via `Connection._dispatchContained` / `MllpServer._emitContained` /
  `MllpClient._emitContained`: **every `this.emit(` in `src/` is inside a containment wrapper**, with exactly one disclosed exception, bounded: the `net.Server` error forwarder re-emits unguarded only
  when there is **no** `'error'` listener **and** the server is serving, because a silent accept outage on a healthcare listener must be impossible. **The hazard belongs to the CALL STACK, not to
  a class**: scoping it to `Connection` is what the gate refuted, across four rounds. Two corollaries are load-bearing beyond crash-safety: a throwing `'nack'` subscriber suppressed the fail-safe
  negative ACK, and a throwing `'message'` subscriber broke ACK correlation so `send()` hung forever. The structural tests attach a throwing subscriber to **every event of all three classes at once**,
  so a new uncontained event fails them. Why: `documentation/agent-notes.md#no-uncontained-emit-mllp-10`
- **`MllpConnectionError.connectionCause` is a public union** whose members are classified **permanent** or transient for the reconnect classifier, and misclassifying one is a reconnect
  storm. `'tls-verify'` and `'tls-handshake'` (TLS-protocol-shaped pre-`secureConnect` only, per the exported `isTlsProtocolError`; pure TCP failures on a TLS connection carry no `connectionCause`)
  are permanent. `'framing-fatal'` (a fatal decoder throw) is permanent, and `isTransientConnectionError` now treats **every** `MLLP_*` code as permanent, because the old
  `default:` branch returned transient and an HTTP probe or wrong-port misconfiguration produced an unbounded reconnect storm under the `autoReconnect: true` default. Plain network blips stay
  transient. Existing values: `'fifo-unsafe'`, `'in-flight-orphan'`. **TLS 1.3 caveat (RFC 8446 §4.4.2): `connect()` resolving does NOT guarantee a `clientAuth: 'MUST'` server accepted the client
  cert; ACK correlation is the delivery guarantee.** Why: `documentation/agent-notes.md#mllpconnectionerrorconnectioncause`
- **Stable security-warning codes** (Phase 8, separate from the framing `WarningCode` union above) are also a public
  API: `MLLP_TLS_VERIFY_DISABLED` (client, every `secureConnect` while `tls.allowUnverified: true`) and `MLLP_BIND_ALL_INTERFACES` (server, once at `listen()` when a wildcard host is bound via
  `allowWildcardBind: true`). Both emit as a frozen `'securityWarning'` event AND via `process.emitWarning`.
- **Server bind-safety: the default host is `'127.0.0.1'`, and a wildcard bind requires `ServerOptions.allowWildcardBind: true` enforced against the OS-NORMALIZED bound address.** Literal
  spellings reject pre-bind; resolver-only shorthands (`'0'`, `'0.0'`, `'0x0.0.0.0'`, ...) are caught post-bind via `server.address()`, closing the just-bound server with no listening state and no
  `'listening'` event. `listen()` is **single-flight**, so concurrent calls reject rather than race the post-bind checks. Full spelling list and behaviour:
  `documentation/agent-notes.md#server-bind-safety`
- **Explicit 6-state connection machine**, never socket flags. `.state` is one of exactly `'CONNECTING' | 'CONNECTED' | 'DRAINING' | 'RECONNECTING' | 'DISCONNECTED' | 'CLOSED'`; transitions emit `'stateChange'` with `{ from, to, reason }`. `RECONNECTING` hosts auto-reconnect backoff; `CLOSED` is terminal.
- **Bounded accumulators.** `FrameReader.maxFrameSizeBytes` defaults to 16 MB; overflow throws `MLLP_FRAME_TOO_LARGE`. Never grow buffers unbounded.
- **`AbortSignal` on every awaitable, `Symbol.asyncDispose` on every closeable.** 2026 Node baseline; not retrofittable without breaking change.

### General

- **Frozen event payloads.** Every event object emitted publicly is `Object.freeze`'d. Subscribers cannot mutate shared state.
- **`getStats()` returns JSON-serializable plain objects.** No Buffers, no class instances: log-pipeline friendly.
- No `console.*` in library code. Throw typed errors (`MllpFramingError`, `MllpTimeoutError`, `MllpConnectionError`, `MllpBackpressureError`) or emit warning events.
- Short, testable functions over big state-machine blobs.
- Coverage target: ≥ 90 % per-directory on `src/framing/`, `src/client/`, `src/connection/`, `src/server/`, `src/transport/` (enforced by `pnpm test:coverage`).
- **In-memory transport is a first-class deliverable** (`@cosyte/mllp/testing`). Every test that can run over it must run over it; sockets are reserved for integration smoke tests.
- **▶ `attw` SAYS "does not contain types" AND EXITS 0, SO THE `attw` SCRIPT IS A WRAPPER, NOT THE BARE CLI.** `getExitCode.js` in `@arethetypeswrong/cli@0.18.4` opens with `if (!analysis.types)
  return 0`, so the problem list is never consulted and no flag or config reaches it: a broken publish reported as a pass. **The race only supplies the condition**, so the answer is **not** a
  lock, a lease or a build queue: the gate must be able to say its own inputs were missing, whatever removed them.
  **▶ NEVER RESTATE THE BOUNDARY AS "MISSING DECLARATIONS EXIT 0".** It needs the tarball to carry **no declaration at all**, shared `tsup` type chunk included; removing only the six entry
  declarations reds honestly at exit 1. A draft claimed otherwise and was wrong, and `test/scripts/attw-gate.test.ts` reds if the promise is restored. **Do not write a single figure
  down as the build window**: the stable claim is seconds, not milliseconds. `scripts/attw.mjs` carries **two nets that catch different things** (a `package.json` path
  preflight over this package's **twelve** artifact paths, and a post-check on the untyped sentence); **keep both**, keep `--profile node16` forwarded, and keep refusing by option name and wholesale
  anything that would hide the sentence (`--quiet`, `--format json`, `.attw.json`, `--config-path`). The disclosed hole in net 1 is the shared type chunk `package.json` names nowhere.
  Why: `documentation/agent-notes.md#the-attw-wrapper-and-why-the-bare-cli-is-not-a-gate`
