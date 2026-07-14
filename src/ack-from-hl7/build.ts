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
import {
  CONTROL_ID_ENCODING,
  extractMsaControlId,
  extractMshControlId,
} from "../internal/control-id.js";

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
 * Warning code emitted when the built ACK's MSA-2 bytes are **not** byte-identical
 * to the inbound MSH-10 bytes — i.e. the ACK does not echo the message control ID
 * verbatim, as HL7 v2.5.1 §2.9.2.2 requires.
 *
 * This is a **correlation failure**, and the reason it is a loud warning rather
 * than a silent success: the sender keys its in-flight store on the MSH-10 bytes
 * it put on the wire. An ACK whose MSA-2 differs by even one byte will not match
 * that key, so the send is never settled → ACK timeout → resend → **duplicate
 * clinical message**. Emitting the ACK anyway (rather than throwing) is the
 * fail-safe choice — a mismatched ACK still tells the peer *something* — but the
 * mismatch must never pass unremarked.
 *
 * `buildMllpAck` verifies this on every build, against the very same byte-level
 * scanners the `@cosyte/mllp` client uses to correlate (`src/internal/control-id.ts`),
 * so a green check means a `@cosyte/mllp` sender *will* match this ACK.
 *
 * Two known ways to provoke it, both documented in the package limitations:
 *
 *   1. Overriding {@link BuildMllpAckOptions.encoding} to a codec that cannot
 *      round-trip the inbound bytes (`"utf8"`/`"ascii"` against a high-bit,
 *      8859/1-charset control ID). The default never does this.
 *   2. An inbound that declares **non-default encoding characters** (MSH-1/MSH-2).
 *      `@cosyte/hl7`'s `buildMessage` always emits the HL7 default `|^~\&`, so an
 *      inbound MSH-10 of `ID#X` under a `#` component separator is re-delimited to
 *      `ID^X` in MSA-2 — different bytes, unmatchable key. Use `buildRawAck` (root
 *      export), which echoes the inbound's own MSH-1/MSH-2, if you must serve such
 *      a peer.
 *
 * @example
 * ```typescript
 * import { MLLP_ACK_CONTROL_ID_NOT_VERBATIM, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const { warnings } = buildAckAA(inbound, { encoding: "ascii" });
 * if (warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM)) {
 *   // this ACK will NOT correlate at the sender — investigate before shipping it
 * }
 * ```
 */
export const MLLP_ACK_CONTROL_ID_NOT_VERBATIM = "MLLP_ACK_CONTROL_ID_NOT_VERBATIM";

/**
 * Byte-faithful codec for raw-`Buffer` inbound — the default (HL7 v2.5.1 §2.9.2.2).
 *
 * `latin1` is Node's true ISO-8859-1: a 1:1 map between the 256 byte values and
 * U+0000–U+00FF, so `Buffer.from(buf.toString("latin1"), "latin1")` is the identity
 * for **every** byte string. It is the only codec for which that holds, which makes
 * it the only one under which MSA-2 can echo an arbitrary inbound MSH-10 verbatim.
 * See `src/internal/control-id.ts` for why `ascii`, `utf8`, and a charset-driven
 * `TextDecoder` each lose bytes in exactly the range a high-bit control ID lives in.
 * @internal
 */
const BYTES_INBOUND_ENCODING: BufferEncoding = "latin1";

/**
 * Codec for `string` / `Hl7Message` inbound — JS-native `utf8`.
 *
 * When the caller hands us text, **they** already chose the decode; we cannot know
 * which codec produced those code units, so we re-encode with the JS-native one and
 * let them override. (For raw bytes we own the decode, so we can guarantee the
 * round-trip — see {@link BYTES_INBOUND_ENCODING}.)
 * @internal
 */
const TEXT_INBOUND_ENCODING: BufferEncoding = "utf8";

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
   * The codec used to move the ACK between bytes and text — **both** directions,
   * as a single symmetric choice. It decodes a raw-`Buffer` `inbound` on the way in
   * and encodes the serialized ACK on the way out, so the ACK is emitted in the same
   * codec the inbound was read in.
   *
   * That symmetry is the whole point, and it is what makes MSA-2 echo MSH-10
   * **verbatim** (HL7 v2.5.1 §2.9.2.2). Decoding in one codec and encoding in another
   * corrupts every non-ASCII byte it round-trips: a `latin1`-decoded `0x8B` re-encoded
   * as `utf8` goes out as the two bytes `0xC2 0x8B`, which is a *different control ID*
   * — and the sender, which keyed its in-flight store on `0x8B`, cannot match the ACK.
   *
   * **Defaults, by inbound type:**
   *
   * - `Buffer` → **`"latin1"`**. We own the decode, and `latin1` is the only codec
   *   that round-trips arbitrary bytes losslessly, so MSA-2 is byte-verbatim for any
   *   charset — including an MSH-18 of `8859/1` with high-bit bytes in the control ID.
   * - `string` / `Hl7Message` → **`"utf8"`**. The caller already decoded; we re-encode
   *   with the JS-native codec.
   *
   * **Override with care.** Any value other than `"latin1"` on a raw-`Buffer` inbound
   * gives up the verbatim guarantee for non-ASCII bytes (`"ascii"` masks the high bit;
   * `"utf8"` folds invalid sequences onto `U+FFFD`). `buildMllpAck` checks the result
   * either way and emits {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM} if the echo did not
   * survive, so a bad override is loud rather than silent — but it is still a broken
   * ACK. Set this only when the receiving system genuinely demands a specific codec.
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
 * Resolve the single codec used for BOTH the inbound decode and the outbound
 * encode. An explicit `options.encoding` always wins; otherwise raw bytes get
 * the byte-faithful `latin1` and caller-supplied text gets JS-native `utf8`.
 * @internal
 */
function resolveEncoding(
  inbound: Hl7Message | Buffer | string,
  options: BuildMllpAckOptions,
): BufferEncoding {
  if (options.encoding !== undefined) return options.encoding;
  return Buffer.isBuffer(inbound) ? BYTES_INBOUND_ENCODING : TEXT_INBOUND_ENCODING;
}

/**
 * The inbound as bytes, for the verbatim-echo check — or `undefined` when the
 * inbound has no bytes to name.
 *
 * A `Buffer` *is* its bytes. A `string`'s bytes are that string under the
 * resolved codec. A pre-parsed `Hl7Message` has none: the caller already consumed
 * whatever bytes it came from, so there is nothing to compare MSA-2 against and
 * the check is skipped rather than invented.
 * @internal
 */
function inboundBytes(
  inbound: Hl7Message | Buffer | string,
  encoding: BufferEncoding,
): Buffer | undefined {
  if (Buffer.isBuffer(inbound)) return inbound;
  if (typeof inbound === "string") return Buffer.from(inbound, encoding);
  return undefined;
}

/**
 * Verify HL7 v2.5.1 §2.9.2.2 on the bytes we are about to put on the wire: the
 * ACK's MSA-2 must be byte-identical to the inbound's MSH-10.
 *
 * Deliberately checked against `src/internal/control-id.ts` — the very scanners
 * the `@cosyte/mllp` client uses to key its in-flight store and to look an ACK
 * back up. This is therefore not only a spec assertion but an end-to-end
 * correlation assertion: if it passes, a `@cosyte/mllp` sender will match this
 * ACK to its send.
 *
 * Returns `null` when the check passes, or cannot be made at all — MSH-10 is
 * absent (the peer's own no-correlation fail-safe already warns), or the inbound's
 * MSH cannot be located byte-wise (it does not lead with `MSH`, e.g. it is still
 * MLLP-framed). We never warn on a comparison we could not actually perform.
 * @internal
 */
function verifyVerbatimEcho(
  ackPayload: Buffer,
  inboundRaw: Buffer | undefined,
): MllpAckWarning | null {
  if (inboundRaw === undefined) return null;
  const inboundId = extractMshControlId(inboundRaw);
  if (inboundId === null) return null;
  const echoedId = extractMsaControlId(ackPayload);
  if (echoedId === inboundId) return null;

  // The ids are `latin1` — 1:1 with bytes — so hex is a faithful, PHI-free rendering
  // of exactly what differs. A control id is routing metadata, not clinical content,
  // and the operator tracing a lost message needs to see the bytes.
  const inboundHex = Buffer.from(inboundId, CONTROL_ID_ENCODING).toString("hex");
  const echoedHex =
    echoedId === null ? "<absent>" : Buffer.from(echoedId, CONTROL_ID_ENCODING).toString("hex");
  return {
    code: MLLP_ACK_CONTROL_ID_NOT_VERBATIM,
    message:
      `ACK does not echo the inbound MSH-10 verbatim (HL7 v2.5.1 §2.9.2.2): ` +
      `inbound MSH-10 = 0x${inboundHex}, emitted MSA-2 = ${echoedId === null ? echoedHex : `0x${echoedHex}`}. ` +
      `The sender keys its in-flight store on the inbound bytes, so it will NOT match this ACK ` +
      `(ACK timeout -> resend -> duplicate message).`,
  };
}

/**
 * Serialize a built ACK message into a framed `MllpAck` result, encoding it with
 * the same codec the inbound was decoded with, and verifying the MSA-2 echo.
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
  readonly encoding: BufferEncoding;
  /** Inbound bytes to verify the MSA-2 echo against; `undefined` skips the check. */
  readonly verifyAgainst: Buffer | undefined;
}): MllpAck {
  const { ack, requestedCode, code, correlationId, mode, warnings, options, encoding } = params;
  const payload = Buffer.from(ack.toString(), encoding);
  const frame = encodeFrame(payload, {
    allowDelimiterBytesInPayload: options.allowDelimiterBytesInPayload ?? false,
  });

  const echoWarning = verifyVerbatimEcho(payload, params.verifyAgainst);
  const allWarnings = echoWarning === null ? warnings : [...warnings, echoWarning];

  const result: MllpAck = {
    frame,
    payload,
    ack,
    requestedCode,
    code,
    correlationId,
    mode,
    warnings: Object.freeze([...allWarnings]),
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
  encoding: BufferEncoding,
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
    encoding,
    // MSA-2 is INTENTIONALLY empty here — the inbound could not be parsed, so there is no
    // control id to echo and we refuse to fabricate one. Running the verbatim check would
    // report that deliberate choice as a violation; `MLLP_ACK_INBOUND_UNPARSEABLE` (above)
    // is the accurate warning for this case, and it is already attached.
    verifyAgainst: undefined,
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
 *
 * ## Why a `Buffer` is decoded here rather than handed to `parseHL7`
 *
 * `parseHL7(buffer)` does its own charset resolution (MSH-18 discovery, or an
 * `options.charset` override) and decodes through a WHATWG `TextDecoder`. That is
 * the right behaviour for reading *clinical text* — and the wrong one for an ACK
 * builder, which needs the control ID to survive as **bytes**:
 *
 *   * `TextDecoder` has no byte-faithful codec. Its `iso-8859-1` label is aliased
 *     by the WHATWG Encoding Standard to **windows-1252**, which maps `0x8B` to
 *     `U+2039` and `0x9C` to `U+0153` — re-encoding those does not give back the
 *     bytes that arrived. `utf8` (the default when MSH-18 is absent) folds every
 *     invalid sequence onto `U+FFFD`, collapsing all high-bit bytes onto one value.
 *   * Node's `Buffer` `latin1` codec, by contrast, IS a 1:1 byte↔code-unit map, so
 *     `Buffer.from(buf.toString("latin1"), "latin1")` is the identity for every
 *     byte string.
 *
 * So we decode the bytes ourselves with the resolved `encoding` and hand `parseHL7`
 * a `string`, which it takes verbatim. Charset is the *caller's* concern (MSH-18,
 * and the `Buffer`-first API rule) — this adapter's concern is that the control ID
 * it echoes is the one that arrived.
 * @internal
 */
function resolveInbound(
  peer: Hl7Peer,
  inbound: Hl7Message | Buffer | string,
  encoding: BufferEncoding,
): Hl7Message {
  if (Buffer.isBuffer(inbound)) {
    return peer.parseHL7(inbound.toString(encoding));
  }
  if (typeof inbound === "string") {
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

  // ONE codec for the whole build — the inbound decode and the outbound encode are
  // the same choice, because an asymmetric pair is exactly what breaks the verbatim
  // MSA-2 echo (§2.9.2.2) and with it the sender's ACK correlation.
  const encoding = resolveEncoding(inbound, options);

  let msg: Hl7Message;
  try {
    msg = resolveInbound(peer, inbound, encoding);
  } catch (err) {
    if (err instanceof peer.Hl7ParseError) {
      return buildUnparseableFallback(peer, options.code, err.code, options, encoding);
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
    encoding,
    verifyAgainst: inboundBytes(inbound, encoding),
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
  // Same byte-faithful decode as `buildMllpAck` (see `resolveInbound`), so a
  // high-bit byte anywhere in the message cannot make the two disagree about
  // which message they are looking at. MSH-15/16 are ASCII either way, so this
  // is about consistency, not about the mode itself.
  const msg = resolveInbound(peer, inbound, BYTES_INBOUND_ENCODING);
  return peer.detectAckMode(msg);
}
