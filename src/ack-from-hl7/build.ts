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
  extractMsaControlId,
  extractMshControlId,
  stripLeadingSegmentTerminators,
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
 * scanners the `@cosyte/mllp` client uses to correlate (`src/internal/control-id.ts`).
 *
 * **The verification is meaningful for a `Buffer` inbound, and only for a `Buffer`.**
 * A `Buffer` *is* the wire bytes, so comparing the ACK to it is a real byte-level check
 * and a clean result means a `@cosyte/mllp` sender will match this ACK. A
 * `string`/`Hl7Message` inbound has **already been decoded** before this module sees it:
 * the only thing left to compare against is that same text, encoded with the same codec,
 * so the codec cancels on both sides and a codec-induced mismatch is **structurally
 * invisible** — it warns about nothing. See {@link BuildMllpAckOptions.encoding}. Pass a
 * `Buffer` if you want this guarantee to mean anything.
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
 * Warning code emitted when the inbound was handed in as **text** (a `string` or an
 * already-parsed `Hl7Message`) rather than as raw `Buffer` bytes, and the ACK's MSA-2
 * carries a **non-ASCII** control ID — a combination whose byte-verbatim echo
 * (HL7 v2.5.1 §2.9.2.2) `buildMllpAck` **cannot verify**, and may silently be breaking.
 *
 * ## Why a distinct code from {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM}
 *
 * `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` is a *proof of failure*: on a `Buffer` inbound the
 * wire bytes are in hand, the check compares MSA-2 against them, and it fires only when
 * they provably differ. This code is the opposite — a *confession that the proof cannot
 * be run*. A `string`/`Hl7Message` inbound was decoded from its wire bytes **before** this
 * module ever saw it, so the only thing left to compare the ACK against is that same text
 * re-encoded with the same codec: the codec cancels on both sides and the verbatim check
 * becomes a tautology that always passes (see {@link verifyVerbatimEcho}). It would report
 * clean even for `buildAckAA(payload.toString("latin1"))` on a high-bit control ID — where
 * a `latin1`-decoded `0x8B` is re-encoded as the two `utf8` bytes `0xC2 0x8B`, a *different*
 * control ID the sender cannot correlate (timeout → resend → **duplicate clinical message**).
 *
 * The guard cannot be grown to catch that; by the time text arrives the bytes are gone.
 * The API can, and does: rather than let the text path pass a codec-sensitive control ID
 * off as verified, `buildMllpAck` refuses to stay silent about it. Whenever the ACK's MSA-2
 * control ID holds a code unit outside `0x00`–`0x7F` on a text inbound — the range where the
 * codec choice is load-bearing — it emits this warning. An all-ASCII control ID round-trips
 * identically under every codec, so the common case stays quiet; a non-ASCII one is flagged as
 * *unverifiable*, not as *known-broken*, because from a decoded string the two are genuinely
 * indistinguishable.
 *
 * The check reads the **pre-encoding code units** of MSA-2, not the emitted bytes — so a lossy
 * `{ encoding: "ascii" }` override, which truncates a code unit to its low 8 bits (`str -> byte &
 * 0xFF`) and so masks a code unit above `0xFF` *into* the ASCII byte range on the way out (`U+0153`
 * -> `0x53`), cannot slip a corrupted control ID past it silently (MLLP-ACK-ASCII-OVERRIDE-BLEED).
 * The strongly-discouraged text-plus-override path is covered for the same reason the default `utf8`
 * text path is; the `Buffer` overload remains the answer.
 *
 * **The fix the warning points at is the `Buffer`-first API rule.** Pass the raw payload —
 * the bytes the server handed you — and you get the real byte-level check (and, if it breaks,
 * the definite {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM}) instead of this "cannot tell".
 *
 * Like its sibling, this warning carries byte **lengths** only — never the field bytes
 * (MSH-10 is inbound payload content and a warning goes to a log; see {@link verifyVerbatimEcho}).
 *
 * @example
 * ```typescript
 * import { MLLP_ACK_CONTROL_ID_UNVERIFIABLE, buildAckAA } from '@cosyte/mllp/ack-from-hl7';
 * const { warnings } = buildAckAA(payload.toString("latin1")); // text inbound, high-bit id
 * if (warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_UNVERIFIABLE)) {
 *   // pass the raw Buffer instead — the echo cannot be verified from decoded text
 * }
 * ```
 */
export const MLLP_ACK_CONTROL_ID_UNVERIFIABLE = "MLLP_ACK_CONTROL_ID_UNVERIFIABLE";

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
 * The codecs {@link buildMllpAck} accepts as the ACK **serialization** codec — for a
 * `Buffer` inbound and a `string` / `Hl7Message` inbound alike. The character-faithful
 * single-byte / UTF-8 codecs, under which `Buffer.from(ackText, codec)` serializes the
 * ACK's characters to a byte stream a peer reads back as HL7: `utf8`/`utf-8` (the default
 * for text), `ascii`, and `latin1`/`binary` (the default for bytes).
 *
 * Every *other* `BufferEncoding` is a **non-text** codec that does not serialize
 * characters at all — `base64`/`base64url`/`hex` reinterpret the ACK **string** as
 * encoded data and decode it to unrelated bytes; `utf16le`/`ucs2` interleave a NUL after
 * every ASCII byte. Either way the emitted frame is wholesale garbage, so they are
 * rejected on **every** input shape (see {@link assertSerializableAckEncoding}).
 *
 * This set is exactly the legitimate "byte-level codec" escape hatch a `Buffer` inbound
 * offers: a receiving system that demands `ascii` or `latin1` bytes is served here; a
 * non-text codec never is, because it cannot serialize a readable HL7 ACK on any path.
 * @internal
 */
const SERIALIZABLE_ACK_ENCODINGS: ReadonlySet<string> = new Set([
  "utf8",
  "utf-8",
  "ascii",
  "latin1",
  "binary",
]);

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
   * **Override with care, and only on a `Buffer`.** Any value other than `"latin1"` on a
   * raw-`Buffer` inbound gives up the verbatim guarantee for non-ASCII bytes (`"ascii"`
   * masks the high bit; `"utf8"` folds invalid sequences onto `U+FFFD`). On a `Buffer`,
   * `buildMllpAck` **checks** the result and emits {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM}
   * if the echo did not survive, so a bad override there is loud rather than silent — but
   * it is still a broken ACK. Set this only when the receiving system genuinely demands a
   * specific codec.
   *
   * **On a `string` / `Hl7Message` inbound the verbatim check cannot see a codec problem —
   * so a *different* warning does the honest thing instead.** The wire bytes were decoded to
   * text *before* this function saw them, so there is nothing left to compare the ACK against
   * except that same text: the codec cancels on both sides and {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM}
   * can never fire. Concretely, `buildAckAA(payload.toString("latin1"))` on a high-bit control ID
   * (`0x8B`, legal under an `MSH-18` of `8859/1`) re-encodes it as the two `utf8` bytes `0xC2 0x8B`,
   * emitting a **different** control ID the sender cannot correlate. The verbatim check is blind to
   * that — but the byte-safety of a text inbound cannot be *proven*, so `buildMllpAck` refuses to
   * pass it off as verified: whenever the emitted MSA-2 holds a non-ASCII byte on a text inbound it
   * emits {@link MLLP_ACK_CONTROL_ID_UNVERIFIABLE}, an explicit "cannot verify — pass a `Buffer`".
   * The guard is not grown to *catch* the mismatch (the bytes are gone by then); the API stops
   * being silent about the fact that it can't.
   *
   * **`Buffer` is the byte-safe path.** Pass the raw payload. It is what the server hands
   * you, it is what the `Buffer`-first API rule exists for, and it is the only input for
   * which the verbatim guarantee — or a proof that it broke — actually means anything.
   *
   * **Only a *text* codec is accepted — on every input shape.** This codec serializes the ACK
   * back to bytes, so it must be one that writes characters as a byte stream the peer can read as
   * HL7: `"utf8"`, `"ascii"`, `"latin1"`, or `"binary"`. A **non-text** codec —
   * `"base64"`/`"base64url"`/`"hex"` (which reinterpret the ACK *string* as encoded data) or
   * `"utf16le"`/`"ucs2"` (which NUL-pad every byte) — emits a wholesale-garbage frame the receiver
   * cannot parse, so `buildMllpAck` **throws a `TypeError`** for it here rather than hand back an
   * unusable ACK. This applies to a `Buffer` inbound too (MLLP-ACK-NONTEXT-CODEC-BUFFER): a
   * non-text codec there garbles the *inbound* decode into the unparseable fallback (empty MSA-2,
   * so the {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM} check never runs) and then serializes the
   * fallback ACK to garbage bytes that intermittently trip the strict frame encoder — it is never
   * the "loud AE" it was once documented to be. The legitimate byte-level escape hatch is
   * unchanged: a lossy **charset** override on a `Buffer` (`"ascii"` masking a high bit) is still
   * accepted and still caught loudly by {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM}; only the
   * categorically-non-serializing codecs are refused.
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
 * Reject a **non-text** codec as the ACK serialization codec — on **every** input shape,
 * `Buffer` and `string`/`Hl7Message` alike — loudly and before anything is emitted.
 *
 * The resolved codec serializes the built ACK back to bytes (`Buffer.from(ack.toString(),
 * codec)`). A *text* codec ({@link SERIALIZABLE_ACK_ENCODINGS} — `utf8`/`ascii`/`latin1`)
 * writes the ACK's characters as a byte stream the peer reads back as HL7. A *non-text* codec
 * does not: `base64`/`base64url`/`hex` reinterpret the ACK **string** as encoded data and
 * decode it to unrelated bytes, and `utf16le`/`ucs2` interleave a NUL after every byte — so the
 * emitted frame is wholesale garbage the receiver cannot parse. A frame nothing can read is a
 * **caller mistake**, not a runtime condition, and the honest place to report a caller mistake
 * is the boundary — not a garbage `Buffer` handed back for the caller to write to a socket and
 * discover broken a round trip later. So this throws a `TypeError` here, exactly as
 * {@link assertKnownAckCode} does for a bad `code`.
 *
 * ## Why this applies to the `Buffer` path too (MLLP-ACK-NONTEXT-CODEC-BUFFER)
 *
 * An earlier iteration (MLLP-ACK-NONTEXT-CODEC-FRAME) scoped this to the text path, reasoning
 * that a lossy override on a `Buffer` was *already* caught loudly by the byte-level
 * {@link verifyVerbatimEcho} → {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM} check. That is true for
 * a lossy **charset** codec (`ascii` masking a high bit) — but **not** for a genuinely non-text
 * one. A non-text codec garbles the *inbound* decode too: `stripLeadingSegmentTerminators(buf)
 * .toString("base64" | "hex" | "utf16le" | "ucs2")` never yields a string that begins with
 * `MSH`, so it **always** routes to the unparseable fallback, whose MSA-2 is intentionally empty
 * — {@link verifyVerbatimEcho} short-circuits on `inboundId === null` and the NOT_VERBATIM proof
 * *never runs*. The supposed safety net is not reachable. Worse, the fallback ACK is then
 * serialized with that same non-text codec: `Buffer.from(ackText, "base64")` decodes the ACK
 * text to random bytes that, roughly 3–4 % of the time (identically on Node 22 and Node 24 —
 * this was never a runtime divergence, only a flaky draw of the fallback's generated MSH-10),
 * contain a `VT`/`FS` delimiter byte and make the strict {@link encodeFrame} throw a
 * nondeterministic `MllpFramingError`. So the non-text-codec-on-`Buffer` path is neither the
 * "loud AE" it was documented to be nor caught by any falsifiable check — it is an unreadable
 * frame that sometimes crashes.
 *
 * The legitimate `Buffer` escape hatch is **untouched**: every codec that can actually serialize
 * an HL7 ACK — `latin1` (the byte-verbatim default), `ascii`, `utf8`, `binary` — is in
 * {@link SERIALIZABLE_ACK_ENCODINGS} and still accepted, and a lossy charset override there is
 * still caught by {@link MLLP_ACK_CONTROL_ID_NOT_VERBATIM} exactly as before. What is rejected is
 * only the categorically-non-serializing codec, which had no valid use on any path.
 * @internal
 */
function assertSerializableAckEncoding(encoding: BufferEncoding): void {
  if (SERIALIZABLE_ACK_ENCODINGS.has(encoding.toLowerCase())) return;
  throw new TypeError(
    `buildMllpAck: encoding ${JSON.stringify(encoding)} is not a serializable ACK codec. ` +
      `Serializing an ACK to a non-text codec (base64/base64url/hex/utf16le/ucs2) produces a ` +
      `wholesale-garbage frame the receiver cannot parse — on a Buffer inbound it also garbles ` +
      `the inbound decode, so it can never correlate. Use a text codec ("utf8", "ascii", or ` +
      `"latin1"); on a Buffer, "latin1" is byte-verbatim and is the default.`,
  );
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
 * ## Its reach is bounded by what the caller gave us, and that bound is REAL
 *
 * `inboundBytes` re-encodes a `string`/`Hl7Message` inbound with the *same* codec the
 * ACK is encoded with, so on that path the codec **cancels on both sides** and this
 * check is a **tautology**: it cannot, even in principle, catch a codec-induced
 * non-verbatim echo. `buildAckAA(wire.toString("latin1"))` on a `0x8B` control ID emits
 * `0xC2 0x8B` and this function returns `null` — this proof simply does not apply there.
 *
 * Do **not** try to grow *this* guard to cover the text path: by the time a `string` reaches
 * us the wire bytes are already gone, and there is nothing left to compare against. The check
 * is honest and complete for a `Buffer` inbound — the `Buffer`-first path the API rule points
 * at — and it claims nothing beyond that. The text path is not left silent, though: it is
 * handled by a *separate* signal, {@link verifyTextInboundEcho} /
 * {@link MLLP_ACK_CONTROL_ID_UNVERIFIABLE}, which does not attempt the impossible comparison —
 * it flags a non-ASCII echo on a text inbound as *unverifiable* and points the caller at the
 * `Buffer` overload. Two inputs, two checks; neither pretends to the other's certainty.
 *
 * Returns `null` when the check passes, or cannot be made at all — the inbound has no
 * readable MSH (it does not lead with `MSH`, e.g. it is still MLLP-framed), or it
 * carries no MSH-10 (the peer's own no-correlation fail-safe already warns about that).
 * We never warn on a comparison we could not actually perform.
 *
 * ## The message names NO field content — deliberately
 *
 * An earlier version hex-encoded both control IDs into the warning text, reasoning that
 * a control ID is routing metadata rather than clinical content and that an operator
 * tracing a lost message needs the bytes. That reasoning was wrong twice:
 *
 *   1. **It is not this function's call to make.** MSH-10 is inbound payload content,
 *      this module's contract is that its warnings carry *never any inbound payload
 *      bytes*, and a warning goes to a log — which in this domain is a place PHI must
 *      not reach. A field is not safe to log merely because it is *usually* an opaque id.
 *   2. **It was demonstrably PHI.** Paired with a scanner that ran past the segment
 *      terminator (since fixed — see `readMshSegment`), a truncated MSH made "MSH-10"
 *      resolve to PID-3, and this warning rendered the patient's **MRN** in hex. The
 *      scanner bug is fixed; withholding the bytes stays, as defence in depth: the next
 *      such bug must not have a paved road into a log line.
 *
 * The warning says *that* the echo broke and what to compare. Nothing is lost — the
 * caller already holds both byte strings (the inbound is their own `payload`; the ACK is
 * the `MllpAck.payload` this call returns).
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

  // Byte LENGTHS only — never the bytes themselves. The ids are `latin1`, which is 1:1
  // with bytes, so `.length` is a byte count. A length is a shape, not content.
  const inboundLen = String(inboundId.length);
  const echoed = echoedId === null ? "absent" : `${String(echoedId.length)} bytes`;
  return {
    code: MLLP_ACK_CONTROL_ID_NOT_VERBATIM,
    message:
      `ACK does not echo the inbound MSH-10 verbatim (HL7 v2.5.1 §2.9.2.2): ` +
      `inbound MSH-10 is ${inboundLen} bytes, emitted MSA-2 is ${echoed}, and they differ. ` +
      `The sender keys its in-flight store on the inbound bytes, so it will NOT match this ACK ` +
      `(ACK timeout -> resend -> duplicate message). ` +
      `Field values are withheld — MSH-10 is inbound payload content and this warning goes to a log; ` +
      `compare your inbound payload against MllpAck.payload to see the bytes.`,
  };
}

/**
 * The counterpart to {@link verifyVerbatimEcho} for the path that check cannot reach:
 * a **text** inbound (`string` / `Hl7Message`), whose wire bytes are gone before this
 * module sees them.
 *
 * `verifyVerbatimEcho` is a tautology on the text path (it re-derives "the inbound bytes"
 * from the same text, with the same codec, that produced the ACK). So instead of comparing
 * — which cannot fail — this looks at the one property that actually signals danger: does the
 * control ID hold a code unit the codec choice could have corrupted? It reads the ACK's MSA-2
 * as its **pre-encoding code units** (`Field.text`), so any code unit `> 0x7F` is a non-ASCII,
 * codec-sensitive control ID. ASCII code units round-trip identically under `latin1`/`utf8`/`ascii`
 * alike, so an all-ASCII control ID is provably safe from any text input and stays quiet; a
 * non-ASCII one cannot be certified from decoded text and is flagged.
 *
 * It reads the pre-encode **code units**, not the emitted **bytes**, on purpose. A lossy
 * `{ encoding: "ascii" }` override truncates a code unit to its low 8 bits (`str -> byte & 0xFF`),
 * masking a code unit above `0xFF` *into* the ASCII byte range on the way out (`U+0153` -> `0x53`),
 * so an emitted-byte proxy would fall silent on exactly the corruption that matters
 * (MLLP-ACK-ASCII-OVERRIDE-BLEED). The code units still carry the high bit whatever
 * the codec did to the bytes, and — since encoding ASCII code units can never yield a non-ASCII
 * byte — this is a strict superset of the emitted-non-ASCII test, so the default `utf8` text path
 * is unchanged.
 *
 * This is deliberately *unverifiable*, not *not-verbatim*: from a `string` we cannot know
 * whether the caller's decode matched our encode, so we do not claim the echo broke — only
 * that we cannot prove it held. The remedy is structural, and the message says so: pass the
 * raw `Buffer`.
 *
 * Returns `null` on a `Buffer` inbound (the verified path — {@link verifyVerbatimEcho} owns
 * it), on an inbound with no readable MSA-2 to inspect, or when that MSA-2 is pure ASCII.
 *
 * Byte **lengths** only in the message, never the bytes — same PHI discipline as its sibling.
 * @internal
 */
function verifyTextInboundEcho(
  controlId: string,
  inbound: Hl7Message | Buffer | string,
): MllpAckWarning | null {
  if (Buffer.isBuffer(inbound)) return null;
  if (controlId === "") return null;
  // Inspect the control ID's **pre-encoding code units** — the decoded-text form the caller
  // handed us, read straight off the built ACK's MSA-2 (`Field.text`), BEFORE it is serialized
  // to bytes. Any code unit > 0x7F is a non-ASCII, codec-sensitive control ID: on a text inbound
  // we cannot know whether the caller's decode matched our encode, so the byte-verbatim echo
  // cannot be verified.
  //
  // We check the CODE UNITS, not the emitted bytes, on purpose. A lossy `encoding` override
  // (`{ encoding: "ascii" }`) truncates a code unit to its low 8 bits (`str -> byte & 0xFF`), so a
  // code unit above `0xFF` is masked *into* the ASCII byte range on the way out (`U+0153` -> `0x53`),
  // and an emitted-byte proxy would go quiet on exactly the corruption that matters
  // (MLLP-ACK-ASCII-OVERRIDE-BLEED). The pre-encode code units still hold the high bit, so they see
  // it regardless of the codec — and this is a strict superset of the emitted non-ASCII case
  // (encoding ASCII code units can never produce a non-ASCII byte), so the default `utf8` text path
  // is unchanged.
  let hasNonAscii = false;
  for (let i = 0; i < controlId.length; i++) {
    if (controlId.charCodeAt(i) > 0x7f) {
      hasNonAscii = true;
      break;
    }
  }
  if (!hasNonAscii) return null;

  // LENGTH (code-unit count) only — never the field content itself (PHI; see `verifyVerbatimEcho`).
  return {
    code: MLLP_ACK_CONTROL_ID_UNVERIFIABLE,
    message:
      `ACK's byte-verbatim echo of MSH-10 (HL7 v2.5.1 §2.9.2.2) cannot be verified: the inbound ` +
      `was decoded text (a string or Hl7Message), not raw bytes, so its wire bytes are gone and ` +
      `the ${String(controlId.length)}-code-unit MSA-2 control ID holds a non-ASCII code unit the ` +
      `decode/encode codec could have altered (a lossy override such as ascii can even mask it into ` +
      `the ASCII byte range). It may not correlate at the sender (ACK timeout -> resend -> ` +
      `duplicate message). Pass the raw payload Buffer to get the byte-level guarantee. ` +
      `Field values are withheld — MSH-10 is inbound payload content and this warning goes to a log.`,
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
  /**
   * The original inbound, to classify the echo's byte-safety. A `Buffer` is verified
   * against its own bytes ({@link verifyVerbatimEcho}); a `string`/`Hl7Message` gets the
   * "cannot verify" flag ({@link verifyTextInboundEcho}). `undefined` on the unparseable
   * fallback path, which has no correlated MSA-2 to classify.
   */
  readonly inbound: Hl7Message | Buffer | string | undefined;
}): MllpAck {
  const { ack, requestedCode, code, correlationId, mode, warnings, options, encoding } = params;
  const payload = Buffer.from(ack.toString(), encoding);
  const frame = encodeFrame(payload, {
    allowDelimiterBytesInPayload: options.allowDelimiterBytesInPayload ?? false,
  });

  // Two mutually exclusive echo checks, one per input shape. A `Buffer` inbound is checked
  // against its own wire bytes (a real, falsifiable comparison). A `string`/`Hl7Message` cannot
  // be — the bytes are gone — so it is flagged as unverifiable when the echoed control ID holds a
  // non-ASCII code unit. The text check reads the MSA-2 as PRE-ENCODE code units (not the emitted
  // bytes), so a lossy `ascii` override masking a high bit into the ASCII range cannot hide it.
  const echoWarning = verifyVerbatimEcho(payload, params.verifyAgainst);
  const echoedControlId = ack.segments("MSA")[0]?.field(2).text ?? "";
  const unverifiableWarning =
    params.inbound === undefined ? null : verifyTextInboundEcho(echoedControlId, params.inbound);
  const allWarnings = [
    ...warnings,
    ...(echoWarning === null ? [] : [echoWarning]),
    ...(unverifiableWarning === null ? [] : [unverifiableWarning]),
  ];

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
    // control id to echo and we refuse to fabricate one. Running either echo check would
    // report that deliberate choice as a problem; `MLLP_ACK_INBOUND_UNPARSEABLE` (above)
    // is the accurate warning for this case, and it is already attached.
    verifyAgainst: undefined,
    inbound: undefined,
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
  // Strip LEADING SEGMENT TERMINATORS ONLY, and do it for bytes and text alike so the two
  // give the same answer for the same message. `parseHL7` requires MSH to be the FIRST
  // segment and throws `NO_MSH_SEGMENT` otherwise; a leading `CR` (which the MLLP decoder
  // passes straight through) carries no data, so dropping it cannot hide anything.
  //
  // It deliberately stops there. It does NOT skip an `FHS`/`BHS` batch envelope — doing so
  // would hand `parseHL7` only the batch's FIRST message and yield a positive `AA` for
  // messages 2..N that were never read. A batch falls through to `NO_MSH_SEGMENT` and out
  // into the warned, non-positive `AE` fallback: a loud refusal to ACK what we did not
  // read. See `stripLeadingSegmentTerminators`.
  if (Buffer.isBuffer(inbound)) {
    return peer.parseHL7(stripLeadingSegmentTerminators(inbound).toString(encoding));
  }
  if (typeof inbound === "string") {
    return peer.parseHL7(inbound.replace(/^[\r\n]+/, ""));
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
 * @throws {TypeError} when `options.code` is not a known HL7 Table 0008 code, or when
 *   `options.encoding` is a **non-text** codec (`base64`/`base64url`/`hex`/`utf16le`/`ucs2`)
 *   on **any** inbound — it would serialize a garbage frame the receiver cannot parse
 *   (MLLP-ACK-NONTEXT-CODEC-FRAME / MLLP-ACK-NONTEXT-CODEC-BUFFER). See
 *   {@link BuildMllpAckOptions.encoding}.
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

  // Fail loud at the boundary on a non-text codec (`base64`/`hex`/`utf16le`/…), on every input
  // shape: it would serialize the ACK to a wholesale-garbage frame the receiver cannot parse, and
  // on a `Buffer` it also garbles the inbound decode into the unparseable fallback (so the
  // byte-level NOT_VERBATIM check never runs) while intermittently throwing a framing error from
  // the garbage outbound bytes. See {@link assertSerializableAckEncoding}. The legitimate charset
  // escape hatch (`latin1`/`ascii`/`utf8`/`binary`) is untouched.
  assertSerializableAckEncoding(encoding);

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
    inbound,
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
