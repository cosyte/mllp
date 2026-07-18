/**
 * MLLP-ACK-UTF8 — the `ack-from-hl7` subpath must echo MSH-10 into MSA-2
 * **byte-verbatim** (HL7 v2.5.1 §2.9.2.2).
 *
 * The bug this locks out: `buildMllpAck` decoded the inbound through the peer
 * parser's charset machinery and re-encoded the ACK through a hardcoded `utf8`.
 * The two are not inverses. A control-ID byte `0x8B` (legal under an MSH-18 of
 * `8859/1`) came back out of MSA-2 as the TWO bytes `0xC2 0x8B` — a different
 * control ID. A `@cosyte/mllp` client, which keys its in-flight store on the raw
 * `latin1` bytes it sent, could not match that ACK: ACK timeout → resend →
 * **duplicate clinical message**.
 *
 * The end-to-end test in this file is the one that matters: a real `MllpClient`
 * in controlId mode talking to a server that ACKs with `buildAckAA`, over the
 * in-memory transport. That is the exact cosyte↔cosyte channel the bug broke.
 *
 * Fixtures are synthetic-only (DOE/SYNTH/TEST names, invented MRNs) — never PHI.
 */

import { describe, expect, it } from "vitest";
import { parseHL7 } from "@cosyte/hl7";

import {
  buildAckAA,
  buildAckAE,
  buildMllpAck,
  MLLP_ACK_CONTROL_ID_NOT_VERBATIM,
  MLLP_ACK_CONTROL_ID_UNVERIFIABLE,
  MLLP_ACK_INBOUND_UNPARSEABLE,
} from "../../src/ack-from-hl7/index.js";
import { createClient } from "../../src/client/client.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { Connection } from "../../src/connection/index.js";
import { FrameReader } from "../../src/framing/index.js";
import { buildRawAck } from "../../src/server/ack.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

/** MSH-10 = `A<0x8B>C` — a high-bit control ID, legal under MSH-18 = `8859/1`. */
const HIGH_BIT_ID = Buffer.from([0x41, 0x8b, 0x43]);

/** An inbound ADT whose MSH-10 is the given raw bytes and whose MSH-18 declares 8859/1. */
function inboundWithControlId(id: Buffer, fieldSep = "|", encChars = "^~\\&"): Buffer {
  const s = fieldSep;
  return Buffer.concat([
    Buffer.from(
      `MSH${s}${encChars}${s}SEND${s}FAC${s}RECV${s}RFAC${s}20260714120000${s}${s}ADT^A01${s}`,
      "latin1",
    ),
    id,
    Buffer.from(`${s}P${s}2.5.1${s}${s}${s}${s}${s}${s}${s}8859/1\r`, "latin1"),
  ]);
}

const hex = (s: string | null | undefined): string =>
  s === null || s === undefined ? "<none>" : Buffer.from(s, "latin1").toString("hex");

describe("ack-from-hl7 — MSA-2 echoes MSH-10 verbatim (HL7 v2.5.1 §2.9.2.2)", () => {
  it("a high-bit control ID survives into MSA-2 byte-for-byte", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);

    // The bytes on the wire are the bytes that arrived.
    expect(hex(extractMsaControlId(ack.payload))).toBe(HIGH_BIT_ID.toString("hex"));
    expect(extractMsaControlId(ack.payload)).toBe(extractMshControlId(inbound));
  });

  it("the ACK payload does NOT contain the utf8 double-encoding of the control ID", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);

    // The exact regression: `latin1` in, `utf8` out turned 0x8B into 0xC2 0x8B.
    expect(ack.payload.includes(Buffer.from([0xc2, 0x8b]))).toBe(false);
    expect(ack.payload.includes(Buffer.from([0x8b]))).toBe(true);
    // And never the `U+FFFD` replacement char, which a utf8 DECODE of 0x8B produces.
    expect(ack.payload.includes(Buffer.from("�", "utf8"))).toBe(false);
  });

  it("MllpAck.correlationId is the same string the client correlator keys on", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe(extractMshControlId(inbound));
  });

  it("a verbatim echo emits NO warning", () => {
    const ack = buildAckAA(inboundWithControlId(HIGH_BIT_ID));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("negative ACKs echo the control ID verbatim too", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAE(inbound, { error: { conditionCode: "101" } });
    expect(ack.code).toBe("AE");
    expect(extractMsaControlId(ack.payload)).toBe(extractMshControlId(inbound));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("every byte value 0x21..0xFF works as a control-ID byte", () => {
    for (let b = 0x21; b <= 0xff; b++) {
      // Skip the delimiters the message itself uses — those are structure, not content.
      if ("|^~\\&\r\n".includes(String.fromCharCode(b))) continue;
      const id = Buffer.from([0x49, b, 0x44]); // "I<b>D"
      const inbound = inboundWithControlId(id);
      const ack = buildAckAA(inbound);
      expect(hex(extractMsaControlId(ack.payload)), `byte 0x${b.toString(16)}`).toBe(
        id.toString("hex"),
      );
      expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    }
  });

  it("a plain-ASCII control ID is unaffected (no regression)", () => {
    const inbound = inboundWithControlId(Buffer.from("MSG00001", "latin1"));
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe("MSG00001");
    expect(extractMsaControlId(ack.payload)).toBe("MSG00001");
  });

  it("a UTF-8 inbound still round-trips its control-ID bytes exactly", () => {
    // MSH-10 = "ID-é" as real UTF-8 (0xC3 0xA9), MSH-18 = UNICODE UTF-8.
    const id = Buffer.from("ID-é", "utf8");
    const inbound = Buffer.concat([
      Buffer.from("MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|", "latin1"),
      id,
      Buffer.from("|P|2.5.1|||||||UNICODE UTF-8\r", "latin1"),
    ]);
    const ack = buildAckAA(inbound);
    // Byte-faithful: the same two UTF-8 bytes come back, not a re-encoding of them.
    expect(hex(extractMsaControlId(ack.payload))).toBe(id.toString("hex"));
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — a non-verbatim echo is LOUD, never silent", () => {
  it("an `encoding` override that cannot round-trip the bytes warns", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    // `ascii` masks the high bit: 0x8B -> 0x0B. The caller asked for it; we must say so.
    const ack = buildMllpAck(inbound, { code: "AA", encoding: "ascii" });

    const warning = ack.warnings.find((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    expect(warning).toBeDefined();
    expect(warning?.message).toContain("§2.9.2.2");
    // It reports SHAPE, not content: byte lengths, never the field bytes.
    expect(warning?.message).toContain("3 bytes");
  });

  it("the warning carries NO inbound field content — not raw, not hex (PHI)", () => {
    // A warning goes to a log, and MSH-10 is inbound payload content. An earlier version of
    // this check hex-encoded the control ids into the message; paired with a scanner that ran
    // past the segment terminator, that rendered the patient's MRN into a log line. Both are
    // fixed, and this test holds the line: no field VALUE, in any encoding, ever.
    // The high-bit byte is what makes the `ascii` round-trip fail and the warning fire; the
    // identifier-shaped prefix is what must NOT come back out in it.
    const id = Buffer.concat([Buffer.from("MRN00042", "latin1"), Buffer.from([0x8b])]);
    const ack = buildMllpAck(inboundWithControlId(id), { code: "AA", encoding: "ascii" });
    const warning = ack.warnings.find((w) => w.code === MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    expect(warning).toBeDefined();

    const msg = warning?.message ?? "";
    expect(msg).not.toContain("MRN00042"); // raw
    expect(msg).not.toContain(id.toString("hex")); // hex — the exact old leak
    expect(msg).not.toContain(id.toString("base64")); // and no other rendering
    expect(msg).toContain("9 bytes"); // shape only
  });

  it("`utf8` on a high-bit inbound warns — this is the exact pre-fix default", () => {
    const inbound = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildMllpAck(inbound, { code: "AA", encoding: "utf8" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an inbound with NON-DEFAULT encoding characters warns (documented limitation)", () => {
    // MSH-1 = `!`, component separator `#`. `@cosyte/hl7`'s buildMessage always emits the
    // HL7 default `|^~\&`, so MSA-2 gets re-delimited: `ID#X` -> `ID^X`. Different bytes,
    // so the sender cannot match it. We cannot fix that from here (it is upstream's
    // DEFAULT_ENCODING_CHARACTERS), so we refuse to let it pass quietly.
    const inbound = inboundWithControlId(Buffer.from("ID#X", "latin1"), "!", "#~\\&");
    const ack = buildMllpAck(inbound, { code: "AA" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an unparseable inbound warns UNPARSEABLE, not NOT_VERBATIM", () => {
    // MSA-2 is deliberately empty here — we refuse to fabricate a correlation id.
    // Reporting that deliberate choice as a §2.9.2.2 violation would be noise.
    const ack = buildAckAA(Buffer.from("this is not hl7 at all", "latin1"));
    const codes = ack.warnings.map((w) => w.code);
    expect(codes).toContain(MLLP_ACK_INBOUND_UNPARSEABLE);
    expect(codes).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an inbound with an empty-but-present MSH-10 does not warn NOT_VERBATIM", () => {
    const inbound = Buffer.from("MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01||P|2.5.1\r", "latin1");
    const ack = buildAckAA(inbound);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("a TRUNCATED MSH followed by another segment does not warn NOT_VERBATIM", () => {
    // The case the empty-MSH-10 fixture above could never reach: the MSH stops *before*
    // MSH-10 and a real segment follows it. This is where the old scanner ran past the CR
    // and produced PID-3 as the "control id" — so the check compared against a field that
    // does not exist and warned that the ACK had failed to echo it. Its own contract says
    // it never warns on a comparison it could not perform.
    const inbound = Buffer.from(
      "MSH|^~\\&|EPIC|HOSP|MIRTH|LAB\rPID|1||MRN00042||DOE^SYNTH^Q||19850312|F\r",
      "latin1",
    );
    const ack = buildAckAA(inbound);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — text inbound keeps its utf8 default (back-compat)", () => {
  it("a string inbound is encoded utf8, as before", () => {
    const inbound = "MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|ID-é|P|2.5.1\r";
    const ack = buildAckAA(inbound);
    // The caller handed us text, so their code units are re-encoded utf8 — UNCHANGED.
    expect(hex(extractMsaControlId(ack.payload))).toBe(Buffer.from("ID-é", "utf8").toString("hex"));
    // The encoding did not change; the *honesty* did. A non-ASCII control ID from a string
    // cannot be byte-verified (the wire bytes are gone), so it is flagged UNVERIFIABLE — NOT
    // the proof-of-mismatch NOT_VERBATIM, which the text path structurally cannot produce.
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
  });

  it("a pure-ASCII string inbound stays quiet — ASCII round-trips under every codec", () => {
    const inbound = "MSH|^~\\&|S|F|R|F2|20260714120000||ADT^A01|MSG00001|P|2.5.1\r";
    const ack = buildAckAA(inbound);
    expect(ack.correlationId).toBe("MSG00001");
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an Hl7Message inbound with a non-ASCII control ID is UNVERIFIABLE too", () => {
    // The other half of the text overload: a pre-parsed message has no wire bytes either, so its
    // echo is just as unverifiable as a string's. Parsed from a latin1 decode so the control ID
    // keeps its high bit as a single code unit.
    const msg = parseHL7(inboundWithControlId(HIGH_BIT_ID).toString("latin1"));
    const ack = buildAckAA(msg);
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an Hl7Message inbound with a pure-ASCII control ID stays quiet", () => {
    const msg = parseHL7(
      inboundWithControlId(Buffer.from("MSG00001", "latin1")).toString("latin1"),
    );
    const ack = buildAckAA(msg);
    expect(ack.correlationId).toBe("MSG00001");
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
  });

  it("the UNVERIFIABLE warning carries NO field content — byte length only (PHI)", () => {
    // Same PHI discipline as NOT_VERBATIM: an id-shaped prefix + a high bit that trips the flag.
    const wire = inboundWithControlId(
      Buffer.concat([Buffer.from("MRN00042", "latin1"), Buffer.from([0x8b])]),
    );
    const ack = buildAckAA(wire.toString("latin1"));
    const warning = ack.warnings.find((w) => w.code === MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(warning).toBeDefined();
    const msg = warning?.message ?? "";
    expect(msg).not.toContain("MRN00042");
    expect(msg).toContain("§2.9.2.2");
    expect(msg).toContain("Buffer"); // it names the remedy
  });
});

describe("ack-from-hl7 — end-to-end cosyte client ↔ cosyte ack-from-hl7 server", () => {
  it("a client in controlId mode correlates an ACK for a HIGH-BIT control ID", async () => {
    // This is the failure the item describes, reproduced as a real channel: the client
    // keys on the MSH-10 bytes it wrote; the server ACKs with `buildAckAA`. Before the
    // fix the ACK's MSA-2 was `0xC2 0x8B`, the lookup missed, `send()` never settled,
    // and the sender would time out and resend a duplicate clinical message.
    const [a, b] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: "127.0.0.1", port: 0, correlateByControlId: true });
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);

    // The "server": decode the inbound frame, ACK it with the ack-from-hl7 subpath.
    const reader = new FrameReader({
      onFrame: (payload) => {
        b.write(buildAckAA(payload).frame);
      },
      onWarning: () => {},
    });
    b.onData((chunk) => {
      reader.push(chunk);
    });

    const inbound = inboundWithControlId(HIGH_BIT_ID);
    // Resolves iff the ACK correlated. A regression hangs here rather than failing fast,
    // so bound it — an un-settled send is precisely the bug.
    const ack = await Promise.race([
      client.send(inbound),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error("send() never settled — the ACK did not correlate"));
        }, 2_000),
      ),
    ]);

    expect(extractMsaControlId(ack)).toBe(extractMshControlId(inbound));
    await client.close();
  });
});

describe("ack-from-hl7 — the parser RE-SERIALIZES MSH-10; every case it cannot copy warns", () => {
  // buildMllpAck builds through @cosyte/hl7, which re-emits MSH-10 in canonical form rather
  // than copying its bytes. Four things that form does not preserve. Each is a DIFFERENT
  // control id on the wire, so each is an ACK the sender cannot match — and each must warn.
  // buildRawAck (parser-free, a byte copy) holds all four; the last assertion proves it.
  const cases: ReadonlyArray<readonly [string, string, string]> = [
    ["an escape sequence", "ID\\X", "ID\\E\\X"],
    ["trailing whitespace", "MSG42 ", "MSG42"],
    ["leading whitespace", " MSG42", "MSG42"],
    ["a trailing empty component", "ID^", "ID"],
    ["a trailing empty subcomponent", "ID&", "ID"],
  ];

  it.each(cases)("%s in MSH-10 is re-serialized — and warns", (_name, id, reserialized) => {
    const inbound = inboundWithControlId(Buffer.from(id, "latin1"));
    const ack = buildAckAA(inbound);

    expect(extractMsaControlId(ack.payload)).toBe(reserialized);
    expect(extractMsaControlId(ack.payload)).not.toBe(id); // NOT verbatim
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it.each(cases)("buildRawAck copies the bytes instead, so %s round-trips", (_name, id) => {
    const inbound = inboundWithControlId(Buffer.from(id, "latin1"));
    expect(extractMsaControlId(buildRawAck(inbound, "AA"))).toBe(id);
  });
});

describe("ack-from-hl7 — the verbatim guarantee is a BUFFER guarantee, and the string path says so", () => {
  /**
   * The byte-verbatim *proof* is a `Buffer` guarantee: only a `Buffer` inbound carries the
   * wire bytes to compare against, so only there can `verifyVerbatimEcho` fire the falsifiable
   * `MLLP_ACK_CONTROL_ID_NOT_VERBATIM`. On a `string`/`Hl7Message` the wire bytes are already
   * gone; `inboundBytes` can only re-encode the caller's text with the SAME codec the ACK used,
   * so that comparison is a tautology and the proof does not apply.
   *
   * What USED to be a silent hole here (`buildAckAA(payload.toString("latin1"))` double-encoding
   * a high-bit control ID and warning about nothing) is now handled by the API, not the guard:
   * the text path emits `MLLP_ACK_CONTROL_ID_UNVERIFIABLE` — an explicit "cannot verify, pass a
   * Buffer" — whenever the echoed id is non-ASCII. The encoding still happens the same way (we do
   * not silently re-interpret the caller's text); we simply refuse to imply it was verified.
   */
  it("a Buffer inbound echoes a high-bit control ID verbatim, with no warning", () => {
    const ack = buildAckAA(inboundWithControlId(HIGH_BIT_ID));
    expect(hex(extractMsaControlId(ack.payload))).toBe(HIGH_BIT_ID.toString("hex"));
    expect(ack.warnings).toHaveLength(0);
  });

  it("the SAME message as a string double-encodes it — and now warns UNVERIFIABLE", () => {
    const wire = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(wire.toString("latin1")); // the natural call if you hold decoded text

    // The encoding is unchanged: 0x8B still goes out as the two utf8 bytes 0xC2 0x8B — a
    // DIFFERENT control ID. This item does not (and cannot) make the string path byte-safe.
    expect(hex(extractMsaControlId(ack.payload))).toBe("41c28b43");
    expect(hex(extractMsaControlId(ack.payload))).not.toBe(HIGH_BIT_ID.toString("hex"));

    // What it DOES fix: the silence. The verbatim proof still cannot run (so NOT_VERBATIM stays
    // absent — claiming a proof we did not perform would be dishonest), but the text path is no
    // longer silent about being unverifiable.
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
  });

  it("passing the Buffer instead upgrades the same message to a verified, silent echo", () => {
    // The remedy the warning names, exercised: the exact same message as bytes is byte-safe.
    const wire = inboundWithControlId(HIGH_BIT_ID);
    const asString = buildAckAA(wire.toString("latin1"));
    const asBuffer = buildAckAA(wire);

    expect(asString.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(asBuffer.warnings).toHaveLength(0);
    expect(hex(extractMsaControlId(asBuffer.payload))).toBe(HIGH_BIT_ID.toString("hex"));
  });
});

describe("ack-from-hl7 — a lossy `ascii` override on a text inbound cannot corrupt silently (MLLP-ACK-ASCII-OVERRIDE-BLEED)", () => {
  /**
   * The residual path the STRING-DOUBLE-ENCODE fix (PR #19) did not close: a `string`/`Hl7Message`
   * inbound with an explicit `{ encoding: "ascii" }` override and a **non-ASCII control ID**.
   *
   * The prior fix flagged the text path by inspecting the EMITTED MSA-2 bytes for a non-ASCII
   * value — a proxy with a blind spot on a lossy override. Node's `ascii` codec truncates a code
   * unit to its low 8 bits (`str -> byte & 0xFF`), so a control-ID code unit **above `0xFF`** — e.g.
   * `U+0153` (`œ`, what a windows-1252 decode yields for a `0x9C` wire byte) — is truncated *into*
   * the ASCII byte range (`0x0153 & 0xFF = 0x53`, `'S'`). The emitted MSA-2 is then all-ASCII, so
   * the emitted-byte proxy stays silent — while the control ID on the wire (`MSGS`) is NOT the one
   * the sender keyed on (`MSGœ`): ACK timeout -> resend -> duplicate clinical message.
   *
   * The fix inspects the MSA-2's **pre-encode code units** instead of the emitted bytes, so a
   * non-ASCII code unit is seen whatever the codec did to the byte. Fixtures are synthetic-only
   * (see file header). (A high-bit *byte* like `0x8B` in a latin1-decoded string is a code unit
   * `<= 0xFF`, which `ascii` preserves verbatim — non-ASCII, and already flagged; the residual gap
   * is specifically the truncated `> 0xFF` code unit, exercised below.)
   */
  // A control ID whose text holds a > 0xFF code unit that `ascii` truncates into the ASCII range.
  const TRUNCATING_ID = "MSGœ"; // U+0153 -> ascii byte 0x53 ('S')
  const inboundStringWithId = (id: string): string =>
    `MSH|^~\\&|SEND|FAC|RECV|RFAC|20260714120000||ADT^A01|${id}|P|2.5.1\r`;

  it("the emitted MSA-2 is corrupted INTO the ASCII range — the byte-level proof of the bleed", () => {
    const ack = buildAckAA(inboundStringWithId(TRUNCATING_ID), { encoding: "ascii" });

    // `ascii` truncated U+0153 -> 0x53: the wire control ID is `MSGS`, a DIFFERENT id.
    expect(extractMsaControlId(ack.payload)).toBe("MSGS");
    // Every emitted MSA-2 byte is now <= 0x7F — which is precisely why the prior emitted-byte,
    // non-ASCII proxy could not see the corruption. This is the bleed, reproduced at byte level.
    const emitted = Buffer.from(extractMsaControlId(ack.payload) ?? "", "latin1");
    expect(emitted.every((b) => b <= 0x7f)).toBe(true);
  });

  it("it is no longer silent — the positive AA carries MLLP_ACK_CONTROL_ID_UNVERIFIABLE", () => {
    const ack = buildAckAA(inboundStringWithId(TRUNCATING_ID), { encoding: "ascii" });

    // The AA is emitted (fail-safe), but the corrupted, unmatchable control ID is surfaced —
    // NOT passed off as a clean, verified positive ACK.
    expect(ack.code).toBe("AA");
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    // The text path never claims the falsifiable proof it cannot run.
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("an Hl7Message inbound with the same override is flagged too", () => {
    const msg = parseHL7(inboundStringWithId(TRUNCATING_ID));
    const ack = buildAckAA(msg, { encoding: "ascii" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
  });

  it("a high-bit (<= 0xFF) code unit under ascii is still flagged (ascii preserves it verbatim)", () => {
    // 0x8B is a code unit <= 0xFF; `ascii` emits it as the non-ASCII byte 0x8B. Already caught
    // before this fix — asserted here so the fix does not regress the <= 0xFF range.
    const ack = buildAckAA(inboundWithControlId(HIGH_BIT_ID).toString("latin1"), {
      encoding: "ascii",
    });
    expect(hex(extractMsaControlId(ack.payload))).toBe(HIGH_BIT_ID.toString("hex"));
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
  });

  it("a pure-ASCII control ID with an ascii override stays quiet — no false positive", () => {
    const ack = buildAckAA(inboundStringWithId("MSG00001"), { encoding: "ascii" });
    expect(ack.correlationId).toBe("MSG00001");
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(ack.warnings.map((w) => w.code)).not.toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });

  it("the UNVERIFIABLE warning still carries NO field content on the override path (PHI)", () => {
    const ack = buildAckAA(inboundStringWithId("MRN00042œ"), { encoding: "ascii" });
    const warning = ack.warnings.find((w) => w.code === MLLP_ACK_CONTROL_ID_UNVERIFIABLE);
    expect(warning).toBeDefined();
    const msg = warning?.message ?? "";
    expect(msg).not.toContain("MRN00042");
    expect(msg).toContain("§2.9.2.2");
    expect(msg).toContain("Buffer"); // names the remedy
  });

  it("the Buffer overload is still the byte-safe path under the same ascii override", () => {
    // A Buffer inbound with the same lossy override is the falsifiable path: NOT_VERBATIM fires
    // (proof of mismatch), because a Buffer carries the wire bytes to compare against.
    const wire = inboundWithControlId(HIGH_BIT_ID);
    const ack = buildAckAA(wire, { encoding: "ascii" });
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_CONTROL_ID_NOT_VERBATIM);
  });
});

describe("ack-from-hl7 — a non-text codec on the text path is rejected at the boundary (MLLP-ACK-NONTEXT-CODEC-FRAME)", () => {
  /**
   * A `string` / `Hl7Message` inbound uses the resolved codec only to serialize the ACK back to
   * bytes (`Buffer.from(ack.toString(), codec)`). A **non-text** codec does not serialize
   * characters at all: `base64`/`base64url`/`hex` reinterpret the ACK *string* as encoded data and
   * decode it to unrelated bytes; `utf16le`/`ucs2` NUL-pad every byte. Either way the emitted frame
   * is wholesale garbage a receiver cannot parse — its `extractMsaControlId` returns `null` and the
   * ACK-FAILSAFE path downgrades to `AE` (so this class was always fail-safe, never silent
   * corruption). But a frame nothing can read is a caller mistake, so `buildMllpAck` throws a
   * `TypeError` at the boundary rather than hand back an unusable ACK. Text codecs (`utf8`/`ascii`/
   * `latin1`) are unaffected, and the `Buffer` overload is deliberately untouched.
   *
   * Fixtures are synthetic-only (SEND/FAC/RECV, invented control IDs) — never PHI.
   */
  const inboundStr = "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260714120000||ADT^A01|MSG00001|P|2.5.1\r";
  const NON_TEXT: readonly BufferEncoding[] = ["base64", "base64url", "hex", "utf16le", "ucs2"];

  for (const enc of NON_TEXT) {
    it(`a string inbound with { encoding: "${enc}" } throws a TypeError`, () => {
      expect(() => buildAckAA(inboundStr, { encoding: enc })).toThrow(TypeError);
      expect(() => buildAckAA(inboundStr, { encoding: enc })).toThrow(
        /not supported on the text path/,
      );
    });

    it(`an Hl7Message inbound with { encoding: "${enc}" } throws a TypeError too`, () => {
      const msg = parseHL7(inboundStr);
      expect(() => buildMllpAck(msg, { code: "AA", encoding: enc })).toThrow(TypeError);
    });
  }

  it("case-insensitive: an upper-case non-text codec label is rejected too", () => {
    expect(() => buildAckAA(inboundStr, { encoding: "UTF-16LE" as BufferEncoding })).toThrow(
      TypeError,
    );
  });

  it("the error names the remedy (a text codec or the Buffer overload) and carries no field content", () => {
    // MSG00001 is an ASCII control ID; assert the static message never echoes it (PHI discipline —
    // the guard throws before parsing, so no field can leak, but hold the line explicitly).
    const idBearing = "MSH|^~\\&|SEND|FAC|RECV|RFAC|20260714120000||ADT^A01|MRN00042|P|2.5.1\r";
    let caught: unknown;
    try {
      buildAckAA(idBearing, { encoding: "base64" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TypeError);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).not.toContain("MRN00042");
    expect(message).toContain("Buffer");
    expect(message).toMatch(/utf8|ascii|latin1/);
  });

  it("the supported text codecs still build a frame on the text path (no regression)", () => {
    for (const enc of ["utf8", "ascii", "latin1"] as const) {
      const ack = buildAckAA(inboundStr, { encoding: enc });
      expect(ack.correlationId).toBe("MSG00001");
      expect(extractMsaControlId(ack.payload)).toBe("MSG00001");
    }
  });

  it("the default text path (no override) is unaffected", () => {
    const ack = buildAckAA(inboundStr);
    expect(ack.correlationId).toBe("MSG00001");
  });

  it("a Buffer inbound with a non-text codec is NOT rejected — the escape hatch is preserved, and still fail-safe", () => {
    // The guard is text-path only: a Buffer override is the documented escape hatch, so it must NOT
    // throw. On a Buffer a `base64` codec garbles the *inbound decode* too, so this routes through
    // the unparseable fallback — a loud, non-positive `AE` (the AA is downgraded), never a silent
    // positive. The point of the test is that the Buffer path is untouched by the boundary guard and
    // remains fail-safe by its existing machinery.
    const wire = Buffer.from(inboundStr, "latin1");
    expect(() => buildAckAA(wire, { encoding: "base64" })).not.toThrow();
    const ack = buildAckAA(wire, { encoding: "base64" });
    expect(ack.code).toBe("AE"); // requested AA, fail-safe-downgraded — never a silent positive
    expect(ack.warnings.map((w) => w.code)).toContain(MLLP_ACK_INBOUND_UNPARSEABLE);
  });
});
