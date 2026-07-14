/**
 * Property test for the ACK correlation invariant (MLLP-ACK-UTF8).
 *
 * The invariant, stated once and enforced over both ACK builders:
 *
 *   > For **any** control-ID bytes and **any** field separator the message
 *   > declares in MSH-1, the control ID the ACK's MSA-2 carries is byte-identical
 *   > to the one the inbound's MSH-10 carried — as read by the very scanners the
 *   > `@cosyte/mllp` client uses to correlate.
 *
 * This is the property a sender's ACK correlation depends on (HL7 v2.5.1
 * §2.9.2.2). Break it by one byte and the sender cannot match the ACK: it times
 * out, resends, and the receiver commits the clinical message twice.
 *
 * The two builders reach it by different routes and both are swept here:
 *   * `buildRawAck` (root export) — parser-free, echoes the inbound's own MSH-1/2.
 *   * `buildMllpAck` (`/ack-from-hl7`) — over `@cosyte/hl7`'s `buildAck`. It can
 *     only hold the property under the HL7 default delimiters, because upstream's
 *     `buildMessage` always emits `|^~\&`; where it cannot, it must say so with
 *     `MLLP_ACK_CONTROL_ID_NOT_VERBATIM` rather than emit a silently unmatchable
 *     ACK. Both halves of that are asserted.
 */

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { buildAckAA, MLLP_ACK_CONTROL_ID_NOT_VERBATIM } from "../../src/ack-from-hl7/index.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { buildRawAck } from "../../src/server/ack.js";

/**
 * Bytes that may appear inside a control ID for this property: anything except the
 * delimiters the message itself uses for structure (segment terminators, the field
 * separator, and the HL7 encoding characters) and the MLLP framing bytes. Those are
 * *structure*, not content — a control ID containing its own field separator is not
 * a control ID, it is two fields.
 */
const STRUCTURAL = new Set([
  0x0d, // CR  — segment terminator
  0x0a, // LF  — tolerated segment terminator
  0x0b, // VT  — MLLP start block
  0x1c, // FS  — MLLP end block
  0x5e, // ^   — component separator
  0x7e, // ~   — repetition separator
  0x5c, // \   — escape character
  0x26, // &   — subcomponent separator
]);

/** Field separators to sweep. `|` is the convention; MSH-1 permits others (§2.5.4). */
const SEPARATORS = ["|", "!", "#", "$", "*", "+"] as const;

/**
 * Any non-structural byte. `buildRawAck` is parser-free — it copies the MSH-10 bytes
 * across as bytes — so it holds the verbatim invariant over this whole range.
 */
function controlIdBytes(): fc.Arbitrary<Buffer> {
  return fc
    .array(
      fc.integer({ min: 0x01, max: 0xff }).filter((b) => !STRUCTURAL.has(b)),
      { minLength: 1, maxLength: 20 },
    )
    .map((bytes) => Buffer.from(bytes));
}

/**
 * Non-structural, non-whitespace bytes — the realistic repertoire of an HL7 `ST`
 * control ID.
 *
 * `buildMllpAck` goes through `@cosyte/hl7`, whose tokenizer **trims field
 * whitespace** (`trimFields`). A control ID with whitespace at either edge therefore
 * cannot survive that parser verbatim: `\tID` is echoed into MSA-2 as `ID`, which is
 * a different control ID and an unmatchable ACK. That is a real (and now *loud* —
 * see the third property) limitation of the parser-backed subpath, not something
 * this builder can fix from below, so it is excluded from the generator that asserts
 * the strict invariant rather than papered over. `buildRawAck`, which never parses,
 * has no such limit.
 *
 * JS `String.trim()` — which is what the peer applies — treats `U+00A0` (NBSP, byte
 * `0xA0` in latin1) as whitespace, so it is excluded too. It is easy to miss: it is
 * the one *high-bit* byte in the trimmed set.
 */
const TRIMMABLE = new Set([0x09, 0x0c, 0x20, 0xa0]); // TAB, FF, SP, NBSP (CR/LF/VT are structural)

function printableControlIdBytes(): fc.Arbitrary<Buffer> {
  return fc
    .array(
      fc.integer({ min: 0x01, max: 0xff }).filter((b) => !STRUCTURAL.has(b) && !TRIMMABLE.has(b)),
      { minLength: 1, maxLength: 20 },
    )
    .map((bytes) => Buffer.from(bytes));
}

/** An inbound ADT carrying `id` as MSH-10, delimited by `sep`. */
function inbound(id: Buffer, sep: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `MSH${sep}^~\\&${sep}SEND${sep}FAC${sep}RECV${sep}RFAC${sep}20260714120000${sep}${sep}ADT^A01${sep}`,
      "latin1",
    ),
    id,
    Buffer.from(`${sep}P${sep}2.5.1\r`, "latin1"),
  ]);
}

describe("property: MSA-2 echoes MSH-10 byte-for-byte (HL7 v2.5.1 §2.9.2.2)", () => {
  it("buildRawAck holds the invariant for any control ID and any MSH-1 separator", () => {
    fc.assert(
      fc.property(controlIdBytes(), fc.constantFrom(...SEPARATORS), (id, sep) => {
        // Guard the generator, not the code: an id containing the separator is
        // structurally not one field.
        fc.pre(!id.includes(Buffer.from(sep, "latin1")));

        const msg = inbound(id, sep);
        const sentKey = extractMshControlId(msg);
        const ackedKey = extractMsaControlId(buildRawAck(msg, "AA"));

        // The key the sender enqueued is the key the ACK returns.
        expect(ackedKey).toBe(sentKey);
        expect(Buffer.from(ackedKey ?? "", "latin1").equals(id)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("buildMllpAck holds the invariant for any control ID under the default delimiters", () => {
    fc.assert(
      fc.property(printableControlIdBytes(), (id) => {
        fc.pre(!id.includes(0x7c)); // `|` — the separator this message declares

        const msg = inbound(id, "|");
        const ack = buildAckAA(msg);

        expect(extractMsaControlId(ack.payload)).toBe(extractMshControlId(msg));
        expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
      }),
      { numRuns: 500 },
    );
  });

  it("buildMllpAck is never SILENTLY wrong — a broken echo always carries its warning", () => {
    // Upstream `buildMessage` always emits the HL7 default `|^~\&`, so a non-default
    // MSH-1 gets re-delimited in MSA-2. That is a real limitation of this subpath, and
    // the contract is: hold the invariant, or warn. Never neither.
    fc.assert(
      fc.property(controlIdBytes(), fc.constantFrom(...SEPARATORS), (id, sep) => {
        fc.pre(!id.includes(Buffer.from(sep, "latin1")));

        const msg = inbound(id, sep);
        const ack = buildAckAA(msg);
        const verbatim = extractMsaControlId(ack.payload) === extractMshControlId(msg);
        const warned = ack.warnings.some((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM);

        expect(verbatim || warned).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});
