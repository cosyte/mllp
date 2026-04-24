# Phase 2: Framing Codec & Warnings - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Pure byte-level codec layer — zero network, zero sockets. Delivers:
- `encodeFrame(payload, opts?)` — canonical VT+payload+FS+CR encoder with strict-by-default behavior
- `FrameReader` — stateful 3-state FSM (SCANNING_FOR_VT / READING_PAYLOAD / EXPECTING_CR) with chunked accumulator, tolerance opt-ins, and `maxFrameSizeBytes` DoS cap
- `MllpWarning` frozen factory — 11-code union registry with stable codes as a public API
- `MllpFramingError` typed error — `{ code, byteOffset, snippet }` where snippet ≤64 bytes

Everything in `src/framing/`. No dependencies on Phase 3+ modules. Exports are the public API surface for Phase 3 (Transport/Connection) and Phase 4/5 (Server/Client) to compose.

</domain>

<decisions>
## Implementation Decisions

### FrameReader API style
- **D-01:** `FrameReader` uses a **callback-per-frame** delivery model. Constructor accepts `{ onFrame(payload: Buffer), onWarning(w: MllpWarning), maxFrameSizeBytes?, ...toleranceOpts }`. Caller drives the reader by pushing chunks: `reader.push(chunk: Buffer)`. Frames fire synchronously during `push()`. No EventEmitter, no Transform stream coupling.
- **D-02:** Phase 3 wires it as: `socket.on('data', chunk => reader.push(chunk))`. The callback receives the same `Buffer` reference the reader yielded — Phase 3 can `Object.freeze` the warning before emitting it upstream (WARN-01 frozen requirement).
- **D-03:** `reader.reset()` clears internal accumulator state (for connection reuse / reconnect cycles without allocating a new reader). Included in Phase 2's deliverables.

### encodeFrame options shape
- **D-04:** `encodeFrame(payload: Buffer, opts?: EncoderOptions): Buffer` — always returns a plain `Buffer`. The `allowDelimiterBytesInPayload` tolerance is expressed via an `onWarning` callback in the options bag: `encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning: fn })`. Consistent with the FrameReader `onWarning` channel — no return-type branching. Callers who omit `onWarning` with the flag set still get the frame (bytes preserved), just no warning callback fired.
- **D-05:** When `allowDelimiterBytesInPayload` is NOT set (default), `encodeFrame` throws `MllpFramingError('MLLP_PAYLOAD_CONTAINS_VT')` or `MllpFramingError('MLLP_PAYLOAD_CONTAINS_FS')` on detection. No options needed for the strict path.

### Standalone FrameReader defaults
- **D-06:** A bare `new FrameReader({ onFrame })` defaults to **all-strict** — every framing deviation throws `MllpFramingError`. No tolerances are on by default. This matches WARN-04's contract and Postel's Law applied to the decoder (tolerance is explicit, not silent). Phase 4 SERVER-12 will apply its permissive-with-warnings defaults (`allowFsOnly: true`, `allowLfAfterFs: true`, `allowLeadingWhitespace: true`) when constructing readers for server connections. The codec layer itself stays honest.

### connectionId in framing-layer warnings
- **D-07:** `MllpWarning.connectionId` is **`string | undefined`** at the type level. When emitted by a standalone `FrameReader` (Phase 2), it is `undefined`. Phase 3 `Connection` enriches warnings to include its own real `connectionId` (UUIDv4) before forwarding them upstream. This keeps the type honest and avoids phantom IDs or magic empty-string sentinels.
- **D-08:** Downstream (Phase 3+): when Phase 3 wires `onWarning: (w) => emit('warning', { ...w, connectionId: this.connectionId })`, the spread pattern is the canonical enrichment path. The warning is re-frozen after enrichment.

### Claude's Discretion
- Internal file structure within `src/framing/` — planner decides (e.g., `encoder.ts`, `decoder.ts`, `registry.ts`, `error.ts` or consolidated). All are Phase 2 internals.
- `snippet` buffer in `MllpFramingError` — copied bytes (not a subarray view) so the error remains valid after the source buffer is reused. `Buffer.from(source.subarray(start, end))` is the safe pattern here.
- `MllpWarning.timestamp` as `Date` (WARN-01 specifies this — not discretionary, just confirming).
- `reader.reset()` exact semantics (whether it resets byte offset counter or keeps it for stream continuity).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Project requirements and decisions
- `.planning/PROJECT.md` — Vision, Postel's Law, Buffer-first API, zero runtime deps, no console.* in library code
- `.planning/REQUIREMENTS.md` §"Framing Codec (FRAME)" — FRAME-01..12 with acceptance criteria
- `.planning/REQUIREMENTS.md` §"Warnings & Tolerance (WARN)" — WARN-01..10 (11 warning codes, frozen MllpWarning shape, onWarning contract)
- `.planning/REQUIREMENTS.md` §"Typed Errors (ERR)" — ERR-01 (MllpFramingError with code + byteOffset + snippet ≤64 bytes)
- `.planning/ROADMAP.md` §"Phase 2: Framing Codec & Warnings" — 4-plan breakdown, success criteria (5 items), plan objectives
- `CLAUDE.md` §"Engineering Guardrails" — Buffer.prototype.slice() forbidden in src/framing/** (use .subarray()); stable warning codes are public API

### Research and prior art
- `.planning/research/PITFALLS.md` — Pitfall 1 (delimiter split across chunk boundary — the #1 naive bug); Pitfall 2 (string corruption of non-ASCII); buffer-first rationale with real bug citations
- `.planning/research/ARCHITECTURE.md` — FSM state names, module layering (framing/ is the lowest layer)
- `.planning/phases/01-project-foundation/01-CONTEXT.md` — Established patterns (D-01..D-14 carry forward)

### Phase 2 specific
- `src/framing/` — currently empty (.gitkeep). All Phase 2 code lands here.
- `src/index.ts` — stub barrel that Phase 2 plan-04 will update to export public types

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- None — `src/framing/` is empty. Phase 2 creates everything from scratch.
- `src/index.ts` stub barrel (VERSION export only) — plan-04 will add public re-exports from `src/framing/`.

### Established Patterns
- `.subarray()` enforced by SETUP-07 ESLint rule (already active from Phase 1) — will catch any `.slice()` calls in `src/framing/**` at lint time.
- `tsup` dual-ESM+CJS build already configured — Phase 2 exports will be tree-shaken correctly.
- 90% coverage gate on `src/framing/` already configured in `vitest.config.ts`.

### Integration Points
- `src/index.ts` — Phase 2's plan-04 populates the main barrel with framing exports.
- Phase 3 will `import { FrameReader, MllpWarning, MllpFramingError }` from `src/framing/` to compose Transport and Connection.
- Phase 4/5 will use `encodeFrame` and import warning codes from `src/framing/` for server/client-level `onWarning` callbacks.

</code_context>

<specifics>
## Specific Ideas

- The `reader.reset()` method (D-03) should exist to support connection reuse and reconnect cycles — planner should include it even if the Phase 2 plans don't mention it explicitly.
- Warning codes union (WARN-02) is fully specified in REQUIREMENTS.md — the 11 codes are locked and must not be renamed or reordered. They are a stable public API per CLAUDE.md.
- `encodeFrame` returning plain `Buffer` (not `Uint8Array`) preserves the Buffer-first contract for downstream consumers who may call `.readUInt8()`, `.subarray()`, etc.

</specifics>

<deferred>
## Deferred Ideas

- None — discussion stayed within Phase 2 scope.

</deferred>

---

*Phase: 02-framing-codec-warnings*
*Context gathered: 2026-04-24*
