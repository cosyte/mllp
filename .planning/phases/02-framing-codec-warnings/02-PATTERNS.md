# Phase 2: Framing Codec & Warnings — Pattern Map

**Mapped:** 2026-04-24
**Files analyzed:** 6 new/modified files
**Analogs found:** 3 / 6 (3 files have direct structural analogs; 3 have no in-codebase analog — use research patterns)

---

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/framing/registry.ts` | utility | transform | `src/index.ts` (export + JSDoc conventions only) | convention-only |
| `src/framing/error.ts` | utility | transform | `src/index.ts` (module file structure only) | convention-only |
| `src/framing/encoder.ts` | utility | transform | `src/index.ts` (module file structure only) | convention-only |
| `src/framing/decoder.ts` | utility | transform | `src/testing/index.ts` (module stub shape) | convention-only |
| `src/framing/index.ts` | barrel | — | `src/ack-from-hl7/index.ts` | role-match (barrel pattern) |
| `src/index.ts` *(modify)* | barrel | — | `src/index.ts` (itself) | exact |

**Note:** `src/framing/` is empty — all Phase 2 code is net-new. There are no existing service, class, or FSM files in this repo to use as code-level analogs. Patterns below are extracted from the three existing source files for structural conventions, supplemented by the research/architecture docs for the code-shape patterns.

---

## Pattern Assignments

### `src/framing/registry.ts` — warning codes union + MllpWarning frozen factory

**Closest structural analog:** None in codebase. Shape derived from REQUIREMENTS.md WARN-01/WARN-02 + ARCHITECTURE.md "Public API Shape" section.

**File structure convention** (from `src/index.ts` lines 1–17):
```typescript
/**
 * [module description — one line]
 *
 * @packageDocumentation  ← omit for internal modules; use for public-facing ones
 */

// Named exports only. No default exports anywhere in the project.
export const VERSION = '0.1.0';
```

**JSDoc convention** (from `src/ack-from-hl7/index.ts` lines 1–11):
```typescript
/**
 * [Public description]
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/hl7-mllp/ack-from-hl7';
 * ```
 *
 * @packageDocumentation
 */
```

**MllpWarning shape** (from REQUIREMENTS.md WARN-01, WARN-02):
```typescript
// WARN-01: frozen object shape
export interface MllpWarning {
  readonly code: WarningCode;
  readonly message: string;
  readonly byteOffset: number;
  readonly connectionId: string | undefined;  // D-07: undefined at framing layer; Phase 3 enriches
  readonly timestamp: Date;
}

// WARN-02: stable union — all 11 codes locked, renaming = breaking change (CLAUDE.md)
export type WarningCode =
  | 'MLLP_MISSING_LEADING_VT'
  | 'MLLP_FS_WITHOUT_CR'
  | 'MLLP_LF_AFTER_FS'
  | 'MLLP_LEADING_WHITESPACE'
  | 'MLLP_TRAILING_BYTES'
  | 'MLLP_PAYLOAD_CONTAINS_VT'
  | 'MLLP_PAYLOAD_CONTAINS_FS'
  | 'MLLP_EMPTY_PAYLOAD'
  | 'MLLP_FRAME_TOO_LARGE'
  | 'MLLP_ACK_UNMATCHED_CONTROL_ID'
  | 'MLLP_ACK_AFTER_TIMEOUT';
```

**Object.freeze pattern** (from CLAUDE.md "Frozen event payloads"):
```typescript
// Every MllpWarning emitted publicly must be Object.freeze()'d before leaving the library.
// Factory function pattern — callers never construct MllpWarning directly.
export function createWarning(
  code: WarningCode,
  byteOffset: number,
  message: string,
): MllpWarning {
  return Object.freeze({
    code,
    message,
    byteOffset,
    connectionId: undefined,
    timestamp: new Date(),
  });
}
```

**TypeScript compiler flags to respect** (from `tsconfig.json` lines 8–19):
- `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`
- No `any` — use `unknown` and narrow (CLAUDE.md)
- No `as` casts without justification

---

### `src/framing/error.ts` — MllpFramingError typed error class

**Closest structural analog:** None in codebase. Shape derived from REQUIREMENTS.md ERR-01 + ARCHITECTURE.md component table.

**Error class pattern** (from ARCHITECTURE.md "Component Responsibilities" — `errors/` section):
```typescript
// ERR-01: MllpFramingError carries code + byteOffset + snippet (≤64 bytes)
// snippet must be a copied Buffer, not a subarray view (CONTEXT.md Claude's Discretion)
export class MllpFramingError extends Error {
  readonly code: WarningCode;
  readonly byteOffset: number;
  readonly snippet: Buffer;

  constructor(
    code: WarningCode,
    byteOffset: number,
    snippet: Buffer,      // pass Buffer.from(source.subarray(start, end)) — copied, not a view
    message?: string,
  ) {
    super(message ?? `MLLP framing error: ${code} at byte offset ${byteOffset}`);
    this.name = 'MllpFramingError';
    this.code = code;
    this.byteOffset = byteOffset;
    this.snippet = snippet;
  }
}
```

**snippet copy pattern** (from CONTEXT.md "Claude's Discretion"):
```typescript
// Safe: copied bytes so error remains valid after source buffer is reused.
// Use Buffer.from(source.subarray(start, end)) — subarray() is zero-copy view,
// Buffer.from() then copies only the slice range.
const snippetStart = Math.max(0, byteOffset - 32);
const snippetEnd = Math.min(source.length, byteOffset + 32);
const snippet = Buffer.from(source.subarray(snippetStart, snippetEnd));
```

**No console.* constraint** (CLAUDE.md "Engineering Guardrails"):
```typescript
// NEVER: console.error('framing error', err)
// DO: throw new MllpFramingError(code, byteOffset, snippet)
// DO: call onWarning callback — never console.*
```

**`.slice()` is forbidden** (CLAUDE.md + eslint.config.js lines 24–38):
```typescript
// FORBIDDEN in src/framing/**:
buffer.slice(start, end)  // ← ESLint error SETUP-07

// CORRECT:
buffer.subarray(start, end)  // zero-copy in modern Node
```

---

### `src/framing/encoder.ts` — encodeFrame() pure function

**Closest structural analog:** None in codebase. Shape derived from REQUIREMENTS.md FRAME-01..03 + D-04/D-05 decisions.

**Function signature** (from CONTEXT.md D-04, D-05 + REQUIREMENTS.md FRAME-01/FRAME-02):
```typescript
// D-04: always returns plain Buffer (not Uint8Array) — Buffer-first contract
// D-05: throws MllpFramingError on delimiter bytes unless allowDelimiterBytesInPayload: true
export interface EncoderOptions {
  allowDelimiterBytesInPayload?: boolean;
  onWarning?: (w: MllpWarning) => void;
}

/**
 * Wraps `payload` in canonical MLLP framing: VT (0x0B) + payload + FS (0x1C) + CR (0x0D).
 *
 * @example
 * ```typescript
 * const frame = encodeFrame(Buffer.from('MSH|...'));
 * // frame[0] === 0x0B (VT), frame[frame.length - 2] === 0x1C (FS), frame[frame.length - 1] === 0x0D (CR)
 * ```
 */
export function encodeFrame(payload: Buffer, opts?: EncoderOptions): Buffer {
  // strict path (default): throw on delimiter bytes in payload
  // tolerant path (opts.allowDelimiterBytesInPayload: true): preserve bytes + call onWarning
  // Return: Buffer.allocUnsafe(payload.length + 3) — VT + payload + FS + CR
  // NEVER Buffer.prototype.slice() — use subarray()
}
```

**MLLP byte constants** (from ARCHITECTURE.md "Recommended Project Structure"):
```typescript
// Should live in src/framing/constants.ts (planner's discretion) or inline in encoder/decoder
export const VT = 0x0b;   // Vertical Tab — frame start
export const FS = 0x1c;   // File Separator — frame end marker
export const CR = 0x0d;   // Carriage Return — terminates FS
export const LF = 0x0a;   // Line Feed — tolerance FRAME-08
export const DEFAULT_MAX_FRAME_SIZE = 16 * 1024 * 1024; // 16 MB — FRAME-11
```

**Buffer allocation pattern** (zero-copy discipline from CLAUDE.md):
```typescript
// Allocate output buffer directly — do not use string intermediates (Pitfall 2)
const frame = Buffer.allocUnsafe(payload.length + 3);
frame[0] = VT;
payload.copy(frame, 1);       // or: frame.set(payload, 1)
frame[payload.length + 1] = FS;
frame[payload.length + 2] = CR;
return frame;
```

---

### `src/framing/decoder.ts` — FrameReader class (3-state FSM)

**Closest structural analog:** None in codebase. Shape derived from REQUIREMENTS.md FRAME-04..11 + D-01..D-03 decisions + PITFALLS.md Pitfall 1 + ARCHITECTURE.md FSM section.

**Constructor/callback pattern** (from CONTEXT.md D-01, D-02, D-03):
```typescript
// D-01: callback-per-frame model — no EventEmitter, no Transform stream
// D-06: all-strict by default — every framing deviation throws unless tolerance is explicitly enabled
export interface FrameReaderOptions {
  onFrame: (payload: Buffer) => void;
  onWarning?: (w: MllpWarning) => void;
  maxFrameSizeBytes?: number;           // default: DEFAULT_MAX_FRAME_SIZE (16 MB) — FRAME-11
  // Tolerance opt-ins (all false by default — D-06, WARN-04):
  allowFsOnly?: boolean;                // FRAME-07: FS without CR → MLLP_FS_WITHOUT_CR
  allowLfAfterFs?: boolean;             // FRAME-08: FS+LF instead of FS+CR → MLLP_LF_AFTER_FS
  allowMissingLeadingVt?: boolean;      // FRAME-09: no leading VT → MLLP_MISSING_LEADING_VT
  allowLeadingWhitespace?: boolean;     // FRAME-10: SP/TAB/LF/CR before VT → MLLP_LEADING_WHITESPACE
}

// 3-state FSM (ARCHITECTURE.md, PITFALLS.md Pitfall 1)
type ReaderState = 'SCANNING_FOR_VT' | 'READING_PAYLOAD' | 'EXPECTING_CR';
```

**push() method pattern** (from CONTEXT.md D-02 + PITFALLS.md Pitfall 1):
```typescript
export class FrameReader {
  /**
   * Feed a chunk of raw TCP bytes into the reader. Frames fire synchronously
   * via `onFrame` callback during this call. May throw `MllpFramingError` if
   * a tolerance is not enabled and the byte stream violates the framing contract.
   *
   * @example
   * ```typescript
   * const reader = new FrameReader({ onFrame: (payload) => console.log(payload) });
   * socket.on('data', (chunk) => reader.push(chunk));
   * ```
   */
  push(chunk: Buffer): void { /* ... */ }

  /**
   * Clears internal accumulator state for connection reuse / reconnect cycles.
   * D-03: reset() is in Phase 2 deliverables — Phase 3 calls this on reconnect.
   */
  reset(): void { /* ... */ }
}
```

**Accumulator / subarray discipline** (from CLAUDE.md SETUP-07):
```typescript
// FORBIDDEN in src/framing/**:
this._accumulator.slice(0, this._writePos)

// CORRECT: use subarray() for zero-copy reads within the accumulator
this._accumulator.subarray(0, this._writePos)

// For emitting payload to caller — copy to isolate from internal accumulator reuse:
const payload = Buffer.from(this._accumulator.subarray(start, end));
this._options.onFrame(payload);
```

**onWarning safe-call pattern** (from REQUIREMENTS.md WARN-06):
```typescript
// WARN-06: onWarning handler invocation wrapped in try/catch — throwing handler must not
// corrupt stream state. Apply wherever onWarning is called.
if (this._options.onWarning) {
  try {
    this._options.onWarning(warning);
  } catch {
    // swallow — handler errors must not interrupt the framing FSM
  }
}
```

**FSM byte-offset tracking** (from REQUIREMENTS.md FRAME-06):
```typescript
// Monotonic stream byte offset — every warning and error carries this value
// Reset in reset() only — not per-frame (CONTEXT.md D-03 "stream continuity" note)
private _byteOffset = 0;

push(chunk: Buffer): void {
  for (let i = 0; i < chunk.length; i++, this._byteOffset++) {
    const byte = chunk[i];   // noUncheckedIndexedAccess: chunk[i] is number | undefined
    if (byte === undefined) break;  // ← required by noUncheckedIndexedAccess
    this._processByte(byte);
  }
}
```

---

### `src/framing/index.ts` — framing barrel export

**Closest analog:** `src/ack-from-hl7/index.ts` (lines 1–14) — same barrel pattern with package-level JSDoc.

**Barrel pattern** (from `src/ack-from-hl7/index.ts` lines 1–14):
```typescript
/**
 * [Module description]
 *
 * @example
 * ```typescript
 * import { FrameReader, encodeFrame } from '@cosyte/hl7-mllp';
 * ```
 *
 * @packageDocumentation
 */

export { WarningCode, MllpWarning, createWarning } from './registry.js';
export { MllpFramingError } from './error.js';
export { encodeFrame } from './encoder.js';
export { FrameReader } from './decoder.js';
export type { FrameReaderOptions, EncoderOptions } from './decoder.js';
```

**Important: `.js` extension on relative imports** — required by `"module": "NodeNext"` in `tsconfig.json` (line 5). TypeScript with `NodeNext` module resolution requires explicit `.js` extensions on relative imports even for `.ts` source files. All three existing source files use the file-stub pattern and have no imports to reference, but this is the project convention.

---

### `src/index.ts` (modify) — add framing re-exports

**Analog:** `src/index.ts` itself (lines 1–17). Plan 04 adds framing re-exports to the stub barrel.

**Current state** (`src/index.ts` lines 1–17):
```typescript
/**
 * @cosyte/hl7-mllp — Production-grade MLLP client and server for Node.js.
 * ...
 * @packageDocumentation
 */

// Populated in Phase 2+. Stub barrel — do not remove this file.
export const VERSION = '0.1.0';
```

**Target state after Phase 2 plan-04** — add framing public exports below the existing stub comment:
```typescript
// Phase 2: framing codec public surface
export type { WarningCode, MllpWarning } from './framing/index.js';
export { MllpFramingError, encodeFrame, FrameReader } from './framing/index.js';
export type { FrameReaderOptions, EncoderOptions } from './framing/index.js';
```

**Re-export style** — matches the named-export-only convention: no default exports, re-export from barrel. Use `export type` for type-only exports (required by `isolatedModules`-compatible builds; consistent with project strict TS mode).

---

## Shared Patterns

### Buffer-first API
**Source:** CLAUDE.md "Engineering Guardrails", PITFALLS.md Pitfall 2
**Apply to:** All `src/framing/**` files — every public function parameter and return type

```typescript
// CORRECT: all public surface uses Buffer, never string, never Uint8Array
encodeFrame(payload: Buffer): Buffer
onFrame: (payload: Buffer) => void
snippet: Buffer   // in MllpFramingError

// WRONG — forbidden:
encodeFrame(payload: string): string
onFrame: (payload: Uint8Array) => void
```

### No `Buffer.prototype.slice()` — use `.subarray()`
**Source:** `eslint.config.js` lines 21–38, CLAUDE.md SETUP-07
**Apply to:** All files under `src/framing/` — enforced by ESLint as an `error`

```typescript
// FORBIDDEN (ESLint error in src/framing/**):
buf.slice(start, end)

// CORRECT (zero-copy in modern Node):
buf.subarray(start, end)
```

### Stable warning code public API
**Source:** CLAUDE.md "Stable warning codes are a public API", REQUIREMENTS.md WARN-02
**Apply to:** `src/framing/registry.ts`, `src/framing/index.ts`, `src/index.ts`

The `WarningCode` union type and all 11 string literal values are a **breaking-change boundary**. Do not rename, reorder, or remove any code. Adding new codes is a minor version bump. The 11 locked codes are listed in the registry.ts pattern above.

### JSDoc with `@example` on every public export
**Source:** CLAUDE.md "SETUP-04 — JSDoc (with @example) on every public export"
**Apply to:** `encodeFrame`, `FrameReader`, `MllpFramingError`, `WarningCode`, `MllpWarning`, all exported types

Pattern from `src/index.ts` lines 6–13:
```typescript
/**
 * [One-line description].
 *
 * [Optional longer description.]
 *
 * @example
 * ```typescript
 * // Minimal working example that a developer can paste and run
 * const frame = encodeFrame(Buffer.from('MSH|...'));
 * ```
 */
export function encodeFrame(...): Buffer { ... }
```

### No `console.*` in library code
**Source:** CLAUDE.md "Engineering Guardrails"
**Apply to:** All `src/framing/**` files

```typescript
// FORBIDDEN:
console.warn('unexpected byte', byte);
console.error('framing error', err);

// CORRECT: throw typed error or call onWarning callback
throw new MllpFramingError(code, byteOffset, snippet);
// or:
this._options.onWarning?.(createWarning(code, byteOffset, message));
```

### `noUncheckedIndexedAccess` narrowing
**Source:** `tsconfig.json` line 10 — `"noUncheckedIndexedAccess": true`
**Apply to:** Any indexed access in decoder byte loop — `chunk[i]` is `number | undefined`

```typescript
// REQUIRED — compiler enforces this:
const byte = chunk[i];       // type: number | undefined
if (byte === undefined) break;
// Now byte: number — safe to use
```

### `exactOptionalPropertyTypes` for option bags
**Source:** `tsconfig.json` line 12 — `"exactOptionalPropertyTypes": true`
**Apply to:** `FrameReaderOptions`, `EncoderOptions`

```typescript
// With exactOptionalPropertyTypes, optional properties must not be explicitly set to undefined.
// Use presence check, not undefined assignment:
if (opts?.onWarning !== undefined) {        // CORRECT
  opts.onWarning(warning);
}

// NOT:
const cb: ((w: MllpWarning) => void) | undefined = opts?.onWarning ?? undefined;  // redundant
```

---

## No Analog Found

| File | Role | Data Flow | Reason |
|---|---|---|---|
| `src/framing/registry.ts` | utility | transform | No warning registry pattern exists in this codebase — first utility module |
| `src/framing/error.ts` | utility | transform | No typed error classes exist yet — first error module |
| `src/framing/encoder.ts` | utility | transform | No codec functions exist — first pure function module |
| `src/framing/decoder.ts` | utility | transform | No stateful FSM class exists — first class module |

For these four files, the planner should use the research patterns from `.planning/research/ARCHITECTURE.md` ("Recommended Project Structure", "Public API Shape", "Pattern 4: Pure-function byte codec") and `.planning/research/PITFALLS.md` (Pitfall 1 — FSM design; Pitfall 2 — buffer-first) in place of codebase analogs.

---

## Metadata

**Analog search scope:** `src/` (all 4 non-gitkeep TypeScript files), `.planning/research/ARCHITECTURE.md`, `.planning/REQUIREMENTS.md`
**Files scanned:** 4 source files + tsconfig.json + eslint.config.js + tsup.config.ts + vitest.config.ts + package.json
**Files with structural analog (barrel pattern):** 2 (`src/framing/index.ts`, `src/index.ts` modification)
**Files with convention-only analog:** 4 (all new framing module files — no code-level analog, only structural/naming conventions extracted)
**Pattern extraction date:** 2026-04-24
