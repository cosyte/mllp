/**
 * `buildMllpAck` — a THIN transport adapter over `@cosyte/hl7`'s `buildAck`.
 *
 * `@cosyte/hl7` owns ACK **content** (MSH/MSA/ERR construction, the fail-safe
 * no-correlation downgrade); this module owns **transport policy**: accepting
 * raw inbound bytes (or an already-parsed message), tolerating an unparseable
 * inbound without ever fabricating a positive disposition, and framing the
 * result into a ready-to-write MLLP `Buffer` via `encodeFrame`.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const { frame } = buildAckAA(inboundBuffer);
 * socket.write(frame);
 * ```
 *
 * @packageDocumentation
 */

import type { AckCode, AckErrorDetail, AckMode, Hl7Message } from "@cosyte/hl7";

import { encodeFrame } from "../framing/encoder.js";

import { loadHl7Peer } from "./peer.js";
import type { Hl7Peer } from "./peer.js";

/**
 * A single ACK-generation warning, surfaced by {@link buildMllpAck}.
 *
 * `code` is either an upstream `@cosyte/hl7` warning code passed through
 * verbatim (e.g. `"ACK_NO_CORRELATION_ID"`) or the one `mllp`-owned code,
 * {@link MLLP_ACK_INBOUND_UNPARSEABLE}.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const { warnings } = buildAckAA(inbound);
 * for (const w of warnings) console.warn(w.code, w.message);
 * ```
 */
export interface MllpAckWarning {
  readonly code: string;
  readonly message: string;
}

/**
 * Warning code emitted when the inbound message could not be parsed at all
 * (a fatal `Hl7ParseError`) and {@link buildMllpAck} fell back to a minimal,
 * uncorrelated ACK rather than fabricating a positive disposition.
 *
 * @example
 * ```typescript
 * import { MLLP_ACK_INBOUND_UNPARSEABLE, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const { warnings } = buildAckAA("not hl7 at all");
 * warnings.some((w) => w.code === MLLP_ACK_INBOUND_UNPARSEABLE); // true
 * ```
 */
export const MLLP_ACK_INBOUND_UNPARSEABLE = "MLLP_ACK_INBOUND_UNPARSEABLE";

/**
 * Options for {@link buildMllpAck} and its six convenience wrappers.
 *
 * @example
 * ```typescript
 * import type { BuildMllpAckOptions } from '@cosyte/mllp/ack-from-hl7';
 * const opts: BuildMllpAckOptions = { code: "AE", error: { conditionCode: "101" } };
 * ```
 */
export interface BuildMllpAckOptions {
  /** Required acknowledgment disposition to emit in MSA-1 (HL7 Table 0008). */
  readonly code: AckCode;
  /** Optional error detail; one entry emits one ERR segment. */
  readonly error?: AckErrorDetail | readonly AckErrorDetail[];
  /**
   * Payload byte encoding for the serialized ACK. Defaults to `"utf8"`.
   *
   * **Caveat:** a single-byte encoding (`"ascii"`, `"latin1"`) silently maps
   * characters outside its repertoire — non-ASCII content echoed from the
   * inbound MSH-3..6 into the ACK header would be mangled with no warning.
   * Keep the default unless the receiving system genuinely requires a
   * single-byte encoding, and know your inbound header charset if you do
   * (payload charset discipline is the HL7 message's MSH-18 concern — see the
   * package known-limitations).
   */
  readonly encoding?: BufferEncoding;
  /**
   * Passthrough to `encodeFrame`'s `allowDelimiterBytesInPayload`. Defaults
   * to `false` (strict — throws if the serialized ACK somehow contains a
   * VT/FS byte, which a spec-clean `@cosyte/hl7` emit never does).
   */
  readonly allowDelimiterBytesInPayload?: boolean;
}

/**
 * Result of {@link buildMllpAck} — a ready-to-write MLLP frame plus the
 * metadata needed to log or assert on what was actually emitted. Frozen
 * (including the `warnings` array) so subscribers cannot mutate shared state.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const ack = buildAckAA(inbound);
 * socket.write(ack.frame);
 * console.log(ack.code, ack.correlationId);
 * ```
 */
export interface MllpAck {
  /** `VT + payload + FS + CR`, ready to write to a socket. */
  readonly frame: Buffer;
  /** The serialized ACK, unframed. */
  readonly payload: Buffer;
  /** The built ACK `Hl7Message`. */
  readonly ack: Hl7Message;
  /** The disposition the caller asked for. */
  readonly requestedCode: AckCode;
  /** The disposition MSA-1 actually carries (post fail-safe downgrade). */
  readonly code: AckCode;
  /** Inbound MSH-10, echoed in MSA-2. `undefined` when unfindable. */
  readonly correlationId: string | undefined;
  /** Detected from inbound MSH-15/16. `undefined` when inbound unparseable. */
  readonly mode: AckMode | undefined;
  /** Warnings collected while building the ACK. */
  readonly warnings: readonly MllpAckWarning[];
}

/**
 * Validate that `code` is one of the six known HL7 Table 0008 acknowledgment
 * codes, using the peer's own `ACK_CODES` registry as the source of truth.
 * Mirrors `@cosyte/hl7`'s own `buildAck` runtime guard so JS callers (who
 * bypass the TypeScript union) get the same `TypeError` behavior.
 * @internal
 */
function assertKnownAckCode(peer: Hl7Peer, code: unknown): asserts code is AckCode {
  const known: readonly string[] = Object.values(peer.ACK_CODES);
  if (typeof code !== "string" || !known.includes(code)) {
    throw new TypeError(
      `buildMllpAck: \`code\` must be a known HL7 Table 0008 acknowledgment code ` +
        `(AA/AE/AR/CA/CE/CR). Received: ${JSON.stringify(code)}.`,
    );
  }
}

/**
 * Serialize a built ACK message into a framed `MllpAck` result.
 * @internal
 */
function toMllpAck(params: {
  readonly ack: Hl7Message;
  readonly requestedCode: AckCode;
  readonly code: AckCode;
  readonly correlationId: string | undefined;
  readonly mode: AckMode | undefined;
  readonly warnings: readonly MllpAckWarning[];
  readonly options: BuildMllpAckOptions;
}): MllpAck {
  const { ack, requestedCode, code, correlationId, mode, warnings, options } = params;
  const payload = Buffer.from(ack.toString(), options.encoding ?? "utf8");
  const frame = encodeFrame(payload, {
    allowDelimiterBytesInPayload: options.allowDelimiterBytesInPayload ?? false,
  });

  const result: MllpAck = {
    frame,
    payload,
    ack,
    requestedCode,
    code,
    correlationId,
    mode,
    warnings: Object.freeze([...warnings]),
  };
  return Object.freeze(result);
}

/**
 * Build the minimal fallback ACK for an inbound message that failed to parse
 * at all (a fatal `Hl7ParseError`). Never emits a positive disposition — a
 * requested `AA`/`CA` is downgraded to `AE`/`CE`; every other code passes
 * through unchanged. MSA-2 is left empty (no fabricated correlation) and no
 * ERR segment is added — table-level detail stays the caller's concern via
 * `options.error` on the normal path; this fallback only guarantees a
 * spec-shaped, framed, non-positive ACK when the inbound could not be read
 * at all.
 * @internal
 */
function buildUnparseableFallback(
  peer: Hl7Peer,
  requestedCode: AckCode,
  fatalCode: string,
  options: BuildMllpAckOptions,
): MllpAck {
  // The downgrade pair lives UPSTREAM (single source of truth) — this adapter
  // never carries its own AA→AE / CA→CE copy.
  const code = peer.downgradePositiveAck(requestedCode);
  const ack = peer.buildMessage({ type: "ACK" }).addSegment("MSA", [code, ""]);

  const warnings: readonly MllpAckWarning[] = [
    {
      code: MLLP_ACK_INBOUND_UNPARSEABLE,
      message: `Inbound message unparseable (${fatalCode}); emitted ${code} with no correlation id.`,
    },
  ];

  return toMllpAck({
    ack,
    requestedCode,
    code,
    correlationId: undefined,
    mode: undefined,
    warnings,
    options,
  });
}

/**
 * Parse `inbound` if it is a `Buffer`/`string`; pass an already-parsed
 * `Hl7Message` through unchanged — UNLESS it was constructed by a different
 * loaded copy of `@cosyte/hl7` than the one this adapter lazily loaded (the
 * classic Node "dual package hazard": an ESM `import` and this loader's
 * `createRequire` can each resolve a distinct module instance with distinct
 * class identities, so the peer's own `inbound instanceof Hl7Message` guard
 * inside `buildAck` would otherwise reject a perfectly valid message). In
 * that case, re-derive an in-realm `Hl7Message` by round-tripping through
 * `.toString()` — cheap, and the wire format is the one true interchange
 * boundary between two copies of the same library.
 * @internal
 */
function resolveInbound(peer: Hl7Peer, inbound: Hl7Message | Buffer | string): Hl7Message {
  if (typeof inbound === "string" || Buffer.isBuffer(inbound)) {
    return peer.parseHL7(inbound);
  }
  const isPeerNative: boolean = inbound instanceof peer.Hl7Message;
  return isPeerNative ? inbound : peer.parseHL7(inbound.toString());
}

/**
 * Build a framed MLLP ACK from an inbound HL7 v2 message — the core
 * `ack-from-hl7` adapter. `inbound` may be an already-parsed `Hl7Message`, or
 * raw bytes/text to parse first.
 *
 * Behavior:
 * - **Fatally unparseable inbound** (`Hl7ParseError`) — never emits a
 *   positive code: `AA`→`AE`, `CA`→`CE`; other codes pass through. MSA-2 is
 *   empty, `correlationId` and `mode` are `undefined`, and `warnings`
 *   contains one {@link MLLP_ACK_INBOUND_UNPARSEABLE} entry naming the fatal
 *   code — never any inbound payload bytes.
 * - **Normal path** — detects the ack mode from inbound MSH-15/16, delegates
 *   to `@cosyte/hl7`'s `buildAck` (which applies its own no-correlation
 *   fail-safe), and forwards `buildAck`'s own warnings (mapped to
 *   `{ code, message }`). Inbound parse warnings are NOT forwarded — they are
 *   the caller's concern if they parsed the inbound themselves.
 *
 * @throws {MllpPeerMissingError} when `@cosyte/hl7` is not installed.
 * @throws {TypeError} when `options.code` is not a known HL7 Table 0008 code.
 *
 * @example
 * ```typescript
 * import { buildMllpAck } from '@cosyte/mllp/ack-from-hl7';
 * const ack = buildMllpAck(inboundBuffer, { code: "AA" });
 * socket.write(ack.frame);
 * ```
 */
export function buildMllpAck(
  inbound: Hl7Message | Buffer | string,
  options: BuildMllpAckOptions,
): MllpAck {
  const peer = loadHl7Peer();
  assertKnownAckCode(peer, options.code);

  let msg: Hl7Message;
  try {
    msg = resolveInbound(peer, inbound);
  } catch (err) {
    if (err instanceof peer.Hl7ParseError) {
      return buildUnparseableFallback(peer, options.code, err.code, options);
    }
    throw err;
  }

  const mode = peer.detectAckMode(msg);
  const ack = peer.buildAck(
    msg,
    options.error === undefined
      ? { code: options.code, mode }
      : { code: options.code, error: options.error, mode },
  );

  const emittedCode = ack.get("MSA.1");
  assertKnownAckCode(peer, emittedCode);

  // The correlation id is what MSA-2 ACTUALLY carries on the wire — the
  // verbatim field text (`Field.text`), never the component-1-only scalar.
  // A vendor-quirk inbound MSH-10 like `ID^X` surfaces here byte-for-byte,
  // matching what a raw-bytes-correlating sender (this package's own client
  // correlator) will compare against.
  const msa2 = ack.segments("MSA")[0]?.field(2).text ?? "";
  const correlationId = msa2 !== "" ? msa2 : undefined;

  const warnings: readonly MllpAckWarning[] = ack.warnings.map((w) => ({
    code: w.code,
    message: w.message,
  }));

  return toMllpAck({
    ack,
    requestedCode: options.code,
    code: emittedCode,
    correlationId,
    mode,
    warnings,
    options,
  });
}

/**
 * Build an `AA` (Application Accept) MLLP ACK.
 *
 * @example
 * ```typescript
 * import { buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckAA(inboundBuffer).frame);
 * ```
 */
export function buildAckAA(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "AA" });
}

/**
 * Build an `AE` (Application Error) MLLP ACK.
 *
 * @example
 * ```typescript
 * import { buildAckAE } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckAE(inboundBuffer, { error: { conditionCode: "101" } }).frame);
 * ```
 */
export function buildAckAE(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "AE" });
}

/**
 * Build an `AR` (Application Reject) MLLP ACK.
 *
 * @example
 * ```typescript
 * import { buildAckAR } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckAR(inboundBuffer, { error: { conditionCode: "200" } }).frame);
 * ```
 */
export function buildAckAR(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "AR" });
}

/**
 * Build a `CA` (Commit Accept) MLLP ACK (enhanced mode).
 *
 * @example
 * ```typescript
 * import { buildAckCA } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckCA(inboundBuffer).frame);
 * ```
 */
export function buildAckCA(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "CA" });
}

/**
 * Build a `CE` (Commit Error) MLLP ACK (enhanced mode).
 *
 * @example
 * ```typescript
 * import { buildAckCE } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckCE(inboundBuffer, { error: { conditionCode: "101" } }).frame);
 * ```
 */
export function buildAckCE(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "CE" });
}

/**
 * Build a `CR` (Commit Reject) MLLP ACK (enhanced mode).
 *
 * @example
 * ```typescript
 * import { buildAckCR } from '@cosyte/mllp/ack-from-hl7';
 * socket.write(buildAckCR(inboundBuffer, { error: { conditionCode: "200" } }).frame);
 * ```
 */
export function buildAckCR(
  inbound: Hl7Message | Buffer | string,
  options?: Omit<BuildMllpAckOptions, "code">,
): MllpAck {
  return buildMllpAck(inbound, { ...options, code: "CR" });
}

/**
 * Detect the HL7 acknowledgment mode (`"original"` vs `"enhanced"`) of an
 * inbound message, from MSH-15/16. Named `detectMode` (not `detectAckMode`)
 * to avoid colliding with the peer's own `detectAckMode` export for callers
 * who import both from `@cosyte/hl7` and `@cosyte/mllp/ack-from-hl7`.
 *
 * `inbound` may be an already-parsed `Hl7Message`, or raw bytes/text to parse
 * first. A fatal parse failure rethrows the `Hl7ParseError` as-is — unlike
 * {@link buildMllpAck}, there is no ACK to build here, so there is no
 * fallback to construct.
 *
 * **Module-realm note:** this adapter loads `@cosyte/hl7` lazily via
 * `createRequire` (see `peer.ts`). If your code ALSO does
 * `import { Hl7ParseError } from "@cosyte/hl7"` directly, Node's module
 * resolution can — depending on your bundler/runtime — hand you a distinct
 * module instance than the one this adapter loaded, in which case
 * `caught instanceof Hl7ParseError` (your import) may be `false` even though
 * `caught.name === "Hl7ParseError"` and `caught.code` is a valid HL7 fatal
 * code (`NO_MSH_SEGMENT` / `MSH_TOO_SHORT` / `INVALID_ENCODING_CHARACTERS` /
 * `EMPTY_INPUT`). Prefer narrowing on `.code`/`.name`, or obtain the exact
 * class via this subpath's own `loadHl7Peer().Hl7ParseError`.
 *
 * @throws {MllpPeerMissingError} when `@cosyte/hl7` is not installed.
 * @throws {Hl7ParseError} when `inbound` is raw bytes/text that fails to parse.
 *
 * @example
 * ```typescript
 * import { detectMode } from '@cosyte/mllp/ack-from-hl7';
 * detectMode(inboundBuffer); // "original" | "enhanced"
 * ```
 */
export function detectMode(inbound: Hl7Message | Buffer | string): AckMode {
  const peer = loadHl7Peer();
  const msg = resolveInbound(peer, inbound);
  return peer.detectAckMode(msg);
}
