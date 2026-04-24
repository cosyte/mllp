# Phase 2: Framing Codec & Warnings - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-24
**Phase:** 02-framing-codec-warnings
**Areas discussed:** FrameReader API style, encodeFrame options shape, Standalone FrameReader defaults, connectionId in framing warnings

---

## FrameReader API style

| Option | Description | Selected |
|--------|-------------|----------|
| Callback-per-frame | `new FrameReader({ onFrame, onWarning })` — push chunks via `reader.push(chunk)`. Synchronous, zero overhead, no EventEmitter dependency. | ✓ |
| EventEmitter subclass | `class FrameReader extends EventEmitter` — emits `'frame'` and `'warning'` events. More idiomatic Node but adds async listener edge cases. | |
| Node Transform stream | `FrameReader extends Transform` — integrates with `pipe()`. Handles backpressure natively but couples codec to Node stream internals. | |

**User's choice:** Callback-per-frame
**Notes:** User selected the recommended option after reviewing code previews for all three. Callback pattern is consistent with the planned `onWarning` API across encoder and reader.

---

## encodeFrame options shape

| Option | Description | Selected |
|--------|-------------|----------|
| onWarning callback in options | `encodeFrame(payload, { allowDelimiterBytesInPayload: true, onWarning: fn })` — consistent channel with FrameReader. | ✓ |
| `{ frame, warnings }` return type | Always returns an object with `warnings: MllpWarning[]`. Explicit but adds allocation on every call even with zero warnings. | |

**User's choice:** onWarning callback in options
**Notes:** Preferred consistency — same `onWarning` pattern across encoder and decoder. No return-type branching keeps `encodeFrame` signature clean.

---

## Standalone FrameReader defaults

| Option | Description | Selected |
|--------|-------------|----------|
| All-strict (no tolerances) | Bare `new FrameReader()` throws on any deviation. Tolerances are explicit opt-ins. Matches WARN-04. | ✓ |
| Permissive-with-warnings | `allowFsOnly + allowLfAfterFs + allowLeadingWhitespace` on by default. Mirrors SERVER-12 defaults. | |

**User's choice:** All-strict
**Notes:** Postel's Law applied to the codec: tolerance is explicit, never silent. The server layer (Phase 4, SERVER-12) adds permissive defaults when constructing readers for production use.

---

## connectionId in framing-layer warnings

| Option | Description | Selected |
|--------|-------------|----------|
| Optional at framing layer | `connectionId?: string` — `undefined` from FrameReader; Phase 3 enriches to real UUID. Honest type. | ✓ |
| FrameReader generates its own ID | Each FrameReader gets a UUID as `framerId`. Always a string but semantically ambiguous. | |
| Empty string sentinel | `connectionId` is always `string`, defaulting to `''`. Magic value. | |

**User's choice:** Optional at framing layer
**Notes:** Prefers type honesty over fake IDs. Phase 3 Connection spreads and re-freezes warnings with real connectionId.

---

## Claude's Discretion

- Internal file structure within `src/framing/` (encoder.ts, decoder.ts, registry.ts, error.ts vs consolidated)
- `snippet` buffer handling in `MllpFramingError` — copied bytes for safety
- `reader.reset()` exact semantics (byte offset continuity vs reset)

## Deferred Ideas

None — discussion stayed within Phase 2 scope.
