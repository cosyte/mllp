/**
 * MLLP-ACK-UTF8 (sibling) — `buildRawAck` must read the message's delimiters,
 * not assume them.
 *
 * MSH-1 **is** the field separator (HL7 v2.5.1 §2.5.4) — the byte at offset 3 of
 * the MSH segment defines it for the whole message. `buildRawAck` used to split
 * on a hardcoded `|`, so a `!`-delimited message yielded ONE field and every
 * echoed field came back empty: the ACK went out as `MSA|AA|` with **no
 * correlation id at all**. The sender cannot match that, times out, and resends →
 * duplicate clinical message. The client-side scanners have always read MSH-1
 * dynamically; this is the builder catching up to them.
 */

import { describe, expect, it } from "vitest";

import { createClient } from "../../src/client/client.js";
import { extractMsaControlId, extractMshControlId } from "../../src/client/correlator.js";
import { Connection } from "../../src/connection/index.js";
import { encodeFrame, FrameReader } from "../../src/framing/index.js";
import { buildRawAck } from "../../src/server/ack.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

/** An inbound ADT using the given delimiters. */
function inbound(opts: {
  sep?: string;
  enc?: string;
  id?: string;
  term?: string;
  trailing?: string;
}): Buffer {
  const s = opts.sep ?? "|";
  const e = opts.enc ?? "^~\\&";
  const id = opts.id ?? "MSG001";
  const term = opts.term ?? "\r";
  const tail = opts.trailing ?? "";
  return Buffer.from(
    `MSH${s}${e}${s}SEND${s}FAC${s}RECV${s}RFAC${s}20260714120000${s}${s}ADT^A01${s}${id}${s}P${s}2.5.1${term}${tail}`,
    "latin1",
  );
}

describe("buildRawAck — reads MSH-1 (field separator) dynamically", () => {
  it("echoes the control ID under a custom field separator `!`", () => {
    const msg = inbound({ sep: "!" });
    const ack = buildRawAck(msg, "AA");

    // The regression: this used to be `MSA|AA|` — an ACK with an EMPTY control id.
    expect(ack.toString("latin1")).not.toMatch(/MSA.AA.(\r|$)/);
    // The sender's own scanner reads MSA-2 back out as the id it keyed on.
    expect(extractMsaControlId(ack)).toBe("MSG001");
    expect(extractMsaControlId(ack)).toBe(extractMshControlId(msg));
  });

  it("emits the ACK using the inbound's own field separator", () => {
    const ack = buildRawAck(inbound({ sep: "!" }), "AA").toString("latin1");
    expect(ack.startsWith("MSH!")).toBe(true);
    expect(ack).toContain("MSA!AA!MSG001");
  });

  it("echoes the inbound's encoding characters (MSH-2)", () => {
    // A different component separator. Echoing MSH-2 keeps the echoed field CONTENT
    // and the delimiters that define it together — re-emitting `ID#X` under `^~\&`
    // would silently turn two components into one.
    const ack = buildRawAck(inbound({ sep: "!", enc: "#~\\&", id: "ID#X" }), "AA");
    expect(ack.toString("latin1").startsWith("MSH!#~\\&!")).toBe(true);
    expect(extractMsaControlId(ack)).toBe("ID#X");
  });

  it("swaps sender/receiver under a custom separator", () => {
    const ack = buildRawAck(inbound({ sep: "!" }), "AA").toString("latin1");
    const fields = ack.split("\r")[0]?.split("!") ?? [];
    expect(fields[2]).toBe("RECV"); // inbound receivingApp -> ACK sendingApp
    expect(fields[3]).toBe("RFAC");
    expect(fields[4]).toBe("SEND");
    expect(fields[5]).toBe("FAC");
  });

  it("uses the custom separator for the MSA-3 nack text too", () => {
    const ack = buildRawAck(inbound({ sep: "!" }), "AE").toString("latin1");
    expect(ack).toContain("MSA!AE!MSG001!message could not be processed");
  });

  it("a high-bit control ID under a custom separator round-trips byte-exact", () => {
    // Both halves of the bug at once: MSH-1 = `!` AND a 0x8B control-ID byte.
    const id = "A\u008bC";
    const msg = inbound({ sep: "!", id });
    const ack = buildRawAck(msg, "AA");
    expect(extractMsaControlId(ack)).toBe(extractMshControlId(msg));
    expect(Buffer.from(extractMsaControlId(ack) ?? "", "latin1").toString("hex")).toBe("418b43");
  });

  it("the default `|` separator is unchanged (no regression)", () => {
    const msg = inbound({});
    const ack = buildRawAck(msg, "AA").toString("latin1");
    expect(ack.startsWith("MSH|^~\\&|RECV|RFAC|SEND|FAC|")).toBe(true);
    expect(ack).toContain("MSA|AA|MSG001");
  });
});

describe("buildRawAck — tolerates LF/CRLF segment terminators (Postel's Law)", () => {
  it("an LF-terminated inbound does not bleed the next segment into the ACK", () => {
    // Splitting on CR alone left the whole message as ONE 'MSH' segment, so the ACK's
    // MSH-12 (version) was emitted as `2.5.1\nPID` — a raw LF and a stray segment id
    // inside the ACK. The control-ID scanners have always accepted CR *or* LF.
    const msg = inbound({ term: "\n", trailing: "PID|1||MRN999||DOE^JANE\n" });
    const ack = buildRawAck(msg, "AA").toString("latin1");

    expect(ack).not.toContain("\n");
    expect(ack).not.toContain("PID");
    expect(ack).toContain("|2.5.1\r");
    expect(extractMsaControlId(Buffer.from(ack, "latin1"))).toBe("MSG001");
  });

  it("never copies payload content beyond the routing/control metadata", () => {
    const msg = inbound({ term: "\n", trailing: "PID|1||MRN999||DOE^JANE\n" });
    const ack = buildRawAck(msg, "AA").toString("latin1");
    expect(ack).not.toContain("MRN999");
    expect(ack).not.toContain("DOE");
  });

  it("a CRLF-terminated inbound is handled", () => {
    const msg = inbound({ term: "\r\n", trailing: "PID|1||MRN999\r\n" });
    const ack = buildRawAck(msg, "AA").toString("latin1");
    expect(ack).not.toContain("\n");
    expect(ack).not.toContain("MRN999");
    expect(extractMsaControlId(Buffer.from(ack, "latin1"))).toBe("MSG001");
  });
});

describe("buildRawAck — refuses an unusable MSH-1, and always stays framable", () => {
  it("a framing byte (VT) as the field separator falls back to a minimal ACK", () => {
    // A payload CAN carry VT/FS (the decoder tolerates it behind MLLP_PAYLOAD_CONTAINS_VT).
    // Adopting one as the ACK's field separator would make the ACK unframeable — strict
    // `encodeFrame` would throw, the message would go un-ACKed, and the peer would resend.
    const msg = Buffer.from("MSH\v^~\\&\vS\vF\vR\vF2\vts\v\vADT\vID1\vP\v2.5\r", "latin1");
    const ack = buildRawAck(msg, "AA");
    expect(ack.includes(0x0b)).toBe(false);
    expect(() => encodeFrame(ack)).not.toThrow();
  });

  it("an FS as the field separator falls back to a minimal ACK", () => {
    const msg = Buffer.from(
      "MSH\x1c^~\\&\x1cS\x1cF\x1cR\x1cF2\x1cts\x1c\x1cADT\x1cID1\x1cP\x1c2.5\r",
      "latin1",
    );
    const ack = buildRawAck(msg, "AA");
    expect(ack.includes(0x1c)).toBe(false);
    expect(() => encodeFrame(ack)).not.toThrow();
  });

  it("a bare `MSH` with no separator yields a minimal ACK", () => {
    const ack = buildRawAck(Buffer.from("MSH\r", "latin1"), "AE").toString("latin1");
    expect(ack.startsWith("MSH|^~\\&|")).toBe(true);
    expect(ack).toContain("MSA|AE||message could not be processed");
  });

  it("a missing MSH still yields a minimal ACK (no regression)", () => {
    const ack = buildRawAck(Buffer.from("garbage", "latin1"), "AE").toString("latin1");
    expect(ack).toContain("MSA|AE||message could not be processed");
  });

  it("never throws, whatever the delimiters", () => {
    for (const sep of ["|", "!", "^", "\v", "\x1c", "\r", "\n", "\\", "\u008b"]) {
      expect(() => buildRawAck(inbound({ sep }), "AA")).not.toThrow();
    }
  });
});

describe("buildRawAck — end-to-end correlation under a custom separator", () => {
  it("a cosyte client matches a buildRawAck ACK for a `!`-delimited message", async () => {
    const [a, b] = InMemoryTransport.pair();
    const conn = new Connection({ transport: a });
    const client = createClient({ host: "127.0.0.1", port: 0, correlateByControlId: true });
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);

    // The "server" auto-ACK path: exactly what MllpServer does for `autoAck: 'AA'`.
    const reader = new FrameReader({
      onFrame: (payload) => {
        b.write(encodeFrame(buildRawAck(payload, "AA")));
      },
      onWarning: () => {},
    });
    b.onData((chunk) => {
      reader.push(chunk);
    });

    const msg = inbound({ sep: "!", id: "A\u008bC" });
    const ack = await Promise.race([
      client.send(msg),
      new Promise<never>((_, reject) =>
        setTimeout(() => {
          reject(new Error("send() never settled — the ACK did not correlate"));
        }, 2_000),
      ),
    ]);

    expect(extractMsaControlId(ack)).toBe(extractMshControlId(msg));
    await client.close();
  });
});
