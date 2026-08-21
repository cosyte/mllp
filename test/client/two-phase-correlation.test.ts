/**
 * Two-phase acknowledgement correlation on the client, driven end to end over the in-memory
 * transport with a peer that plays the responding system.
 *
 * The property under test is the one this package could not deliver before: a message that
 * asks for the enhanced protocol of HL7 v2.5.1 §2.9 draws TWO acknowledgements, and the
 * client must report the first without settling the send and settle on the second, instead
 * of settling on the first and dropping the second as an unmatched control ID.
 *
 * Timeouts have their own file (`two-phase-timeouts.test.ts`) because they need a faked
 * clock; everything here settles or fails on bytes alone.
 *
 * Fixtures are synthetic MSH/MSA headers only. No patient data appears anywhere here.
 */

import { describe, it, expect, vi } from "vitest";

import { createClient, type MllpClient } from "../../src/client/client.js";
import { Connection } from "../../src/connection/index.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";
import { encodeFrame, type MllpFramingError } from "../../src/framing/index.js";
import { MllpCommitRejectedError } from "../../src/client/error.js";
import { ackModeDiagnosticMessage } from "../../src/internal/ack-mode-diagnostics.js";

interface Warning {
  code: string;
  message: string;
  msa1Bytes?: number | null;
  ackCode?: string | null;
  controlIdBytes?: number | null;
  byteOffset?: number;
}

interface Harness {
  client: MllpClient;
  conn: Connection;
  /** Write one already-built acknowledgement payload back to the client, framed. */
  peerAck: (payload: Buffer) => void;
  /** Every `'warning'` payload the client emitted, in order. */
  warnings: Warning[];
  /** Every `'error'` payload the client emitted, in order. */
  errors: Array<{ error: MllpFramingError }>;
}

function harness(opts?: {
  correlateByControlId?: boolean;
  ackTimeoutMs?: number;
  applicationAckTimeoutMs?: number;
}): Harness {
  const [local, peer] = InMemoryTransport.pair();
  const conn = new Connection({ transport: local });
  const client = createClient({
    host: "127.0.0.1",
    port: 0,
    ackTimeoutMs: opts?.ackTimeoutMs ?? 30_000,
    correlateByControlId: opts?.correlateByControlId ?? true,
    ...(opts?.applicationAckTimeoutMs !== undefined
      ? { applicationAckTimeoutMs: opts.applicationAckTimeoutMs }
      : {}),
  });
  const warnings: Warning[] = [];
  const errors: Array<{ error: MllpFramingError }> = [];
  client.on("warning", (w: Warning) => warnings.push(w));
  client.on("error", (e: { error: MllpFramingError }) => errors.push(e));
  client._attachExistingConnection(conn);
  conn.notifyConnect("127.0.0.1", 2575);
  return {
    client,
    conn,
    peerAck: (payload) => peer.write(encodeFrame(payload)),
    warnings,
    errors,
  };
}

/**
 * An outbound message asking for the acknowledgement conditions given.
 *
 * `MSH`(name) `^~\&`(2) `S`(3) `F`(4) `R`(5) `F2`(6) time(7) ``(8) `ADT^A01`(9)
 * controlId(10) `P`(11) `2.5.1`(12) ``(13) ``(14) msh15(15) msh16(16).
 */
function message(controlId: string, msh15: string, msh16: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|${controlId}|P|2.5.1|||${msh15}|${msh16}\r`,
    "latin1",
  );
}

/** An original-mode message: MSH-15 and MSH-16 both absent. */
function originalMessage(controlId: string): Buffer {
  return Buffer.from(`MSH|^~\\&|S|F|R|F2|20260101000000||ADT^A01|${controlId}|P|2.5.1\r`, "latin1");
}

/** An acknowledgement carrying `msa1` and echoing `acked` in MSA-2. */
function ack(msa1: string, acked: string): Buffer {
  return Buffer.from(
    `MSH|^~\\&|R|F2|S|F|20260101000000||ACK^A01|ACK_${acked}|P|2.5.1\r` + `MSA|${msa1}|${acked}\r`,
    "latin1",
  );
}

/**
 * Whether a promise is still pending, drained across enough microtask turns that a promise
 * which HAS settled is never mistaken for one that has not. Attaching both handlers also
 * keeps a rejection from surfacing as unhandled while the test goes on to assert on it.
 */
async function isPending(p: Promise<unknown>): Promise<boolean> {
  let settled = false;
  const mark = (): void => {
    settled = true;
  };
  p.then(mark, mark);
  for (let i = 0; i < 4; i++) await Promise.resolve();
  return !settled;
}

describe("the paired exchange: commit reported, application acknowledgement settles", () => {
  it("a CA reports the commit disposition and leaves the send pending; the AA settles it", async () => {
    const h = harness();
    const commits: Array<{ code: string; latencyMs: number }> = [];
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (report) => commits.push({ code: report.code, latencyMs: report.latencyMs }),
    });

    h.peerAck(ack("CA", "M1"));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.code).toBe("CA");
    expect(typeof commits[0]?.latencyMs).toBe("number");
    // The commit is reported at a point where the send has NOT settled.
    expect(await isPending(sent)).toBe(true);

    h.peerAck(ack("AA", "M1"));
    const resolved = await sent;
    expect(resolved.toString("latin1")).toContain("MSA|AA|M1");
    // The second acknowledgement settled the send; it was never dropped as unmatched.
    expect(h.errors.filter((e) => e.error.code === "MLLP_ACK_UNMATCHED_CONTROL_ID")).toHaveLength(
      0,
    );
    h.client.destroy();
  });

  it("the commit report carries the accept acknowledgement's own bytes", async () => {
    const h = harness();
    let seen: Buffer | null = null;
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (report) => {
        seen = report.payload;
      },
    });
    h.peerAck(ack("CA", "M1"));
    expect(seen).not.toBeNull();
    expect((seen as unknown as Buffer).toString("latin1")).toContain("MSA|CA|M1");
    h.peerAck(ack("AA", "M1"));
    await sent;
    h.client.destroy();
  });

  it("a send with no onCommitAck hook still stays pending and still settles on the second", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("CA", "M1"));
    expect(await isPending(sent)).toBe(true);
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("a throwing onCommitAck hook does not stop the send from settling", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: () => {
        throw new Error("consumer bug in the commit hook");
      },
    });
    h.peerAck(ack("CA", "M1"));
    expect(await isPending(sent)).toBe(true);
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });
});

describe("what each MSA-1 classification does to a two-phase send", () => {
  // Every row of the classification table, as behaviour rather than as a reading. Each is
  // one acknowledgement matched to an enhanced-mode send that awaits an application
  // acknowledgement.
  const SETTLING: readonly string[] = ["AA", "AA~AA", "AE", "AR "];
  it.each(SETTLING)("MSA-1 %s settles the send successfully", async (msa1) => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack(msa1, "M1"));
    const resolved = await sent;
    expect(resolved.toString("latin1")).toContain(`MSA|${msa1}|M1`);
    h.client.destroy();
  });

  it("AE and AR resolve rather than fail: judging the application's verdict is out of scope", async () => {
    for (const code of ["AE", "AR"]) {
      const h = harness();
      const sent = h.client.send(message("M1", "AL", "AL"));
      h.peerAck(ack(code, "M1"));
      // The caller reads MSA-1 off the acknowledgement it is handed.
      const resolved = await sent;
      expect(resolved.toString("latin1")).toContain(`MSA|${code}|M1`);
      h.client.destroy();
    }
  });

  const REPORTING: readonly string[] = ["CA", "CA ", " CA", "CA^HL70008"];
  it.each(REPORTING)("MSA-1 %s reports and leaves the send pending", async (msa1) => {
    const h = harness();
    const commits: string[] = [];
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (r) => commits.push(r.code),
    });
    h.peerAck(ack(msa1, "M1"));
    expect(commits).toEqual(["CA"]);
    expect(await isPending(sent)).toBe(true);
    h.peerAck(ack("AA", "M1"));
    await sent;
    h.client.destroy();
  });

  const FAILING: ReadonlyArray<readonly [string, "CE" | "CR"]> = [
    ["CE", "CE"],
    ["CR^HL70008", "CR"],
  ];
  it.each(FAILING)("MSA-1 %s fails the send with that code", async (msa1, code) => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack(msa1, "M1"));
    await expect(sent).rejects.toBeInstanceOf(MllpCommitRejectedError);
    await sent.catch((err: MllpCommitRejectedError) => {
      expect(err.commitCode).toBe(code);
      expect(err.name).toBe("MllpCommitRejectedError");
    });
    h.client.destroy();
  });

  it("a negative commit fails the send even after a CA was reported", async () => {
    const h = harness();
    const commits: string[] = [];
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (r) => commits.push(r.code),
    });
    h.peerAck(ack("CA", "M1"));
    expect(commits).toEqual(["CA"]);
    h.peerAck(ack("CE", "M1"));
    await expect(sent).rejects.toBeInstanceOf(MllpCommitRejectedError);
    h.client.destroy();
  });

  it("a negative commit does not wait for an application acknowledgement", async () => {
    const h = harness({ ackTimeoutMs: 60_000 });
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("CR", "M1"));
    // Settled now, not at some later window.
    expect(await isPending(sent)).toBe(false);
    await expect(sent).rejects.toBeInstanceOf(MllpCommitRejectedError);
    h.client.destroy();
  });

  const PENDING: ReadonlyArray<readonly [string, string]> = [
    ["", "MLLP_ACK_MSA1_ABSENT"],
    ['""', "MLLP_ACK_MSA1_ABSENT"],
    ["ca", "MLLP_ACK_MSA1_UNCLASSIFIABLE"],
    ["CAX", "MLLP_ACK_MSA1_UNCLASSIFIABLE"],
    ["C", "MLLP_ACK_MSA1_UNCLASSIFIABLE"],
    ["A", "MLLP_ACK_MSA1_UNCLASSIFIABLE"],
    ["OK", "MLLP_ACK_MSA1_UNCLASSIFIABLE"],
  ];
  it.each(PENDING)("MSA-1 %s leaves the send pending under %s", async (msa1, code) => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack(msa1, "M1"));
    expect(await isPending(sent)).toBe(true);
    expect(h.warnings.map((w) => w.code)).toContain(code);
    // Still settleable by a proper application acknowledgement afterwards.
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("an acknowledgement with no MSA segment leaves the send pending", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    // No MSA at all, so no MSA-2 either: it never correlates to the send in the first
    // place and is reported as an unmatched control ID rather than classified.
    h.peerAck(Buffer.from("MSH|^~\\&|R|F2|S|F|20260101000000||ACK|A1|P|2.5.1\r"));
    expect(await isPending(sent)).toBe(true);
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("a payload with no readable MSH leaves the send pending", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(Buffer.from("not hl7 at all"));
    expect(await isPending(sent)).toBe(true);
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("the three pending cases carry codes that distinguish them from one another", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"), { onCommitAck: () => undefined });
    h.peerAck(ack("", "M1")); // null
    h.peerAck(ack("ZZ", "M1")); // unclassifiable
    h.peerAck(ack("CA", "M1")); // the first commit: reported
    h.peerAck(ack("CA", "M1")); // a repeat commit
    const codes = h.warnings.map((w) => w.code);
    expect(codes).toContain("MLLP_ACK_MSA1_ABSENT");
    expect(codes).toContain("MLLP_ACK_MSA1_UNCLASSIFIABLE");
    expect(codes).toContain("MLLP_ACK_COMMIT_ALREADY_REPORTED");
    expect(new Set(codes).size).toBe(3);
    expect(await isPending(sent)).toBe(true);
    h.client.destroy();
  });
});

describe("a send that awaits no application acknowledgement", () => {
  it("MSH-15 AL with MSH-16 NE settles on the single CA", async () => {
    const h = harness();
    const commits: string[] = [];
    const sent = h.client.send(message("M1", "AL", "NE"), {
      onCommitAck: (r) => commits.push(r.code),
    });
    h.peerAck(ack("CA", "M1"));
    const resolved = await sent;
    expect(resolved.toString("latin1")).toContain("MSA|CA|M1");
    // It settled, so there was nothing to report ahead of settling.
    expect(commits).toEqual([]);
    h.client.destroy();
  });
});

describe("at most one commit is reported per send", () => {
  it("a second CA is surfaced and neither re-reported nor allowed to settle the send", async () => {
    const h = harness();
    const commits: string[] = [];
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (r) => commits.push(r.code),
    });
    h.peerAck(ack("CA", "M1"));
    h.peerAck(ack("CA", "M1"));
    h.peerAck(ack("CA", "M1"));
    expect(commits).toEqual(["CA"]);
    expect(await isPending(sent)).toBe(true);
    const repeats = h.warnings.filter((w) => w.code === "MLLP_ACK_COMMIT_ALREADY_REPORTED");
    expect(repeats).toHaveLength(2);
    expect(repeats[0]?.ackCode).toBe("CA");
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });
});

describe("acknowledgements are applied to the send whose control ID they echo", () => {
  it("two interleaved conversations never touch each other", async () => {
    const h = harness();
    const commitsA: string[] = [];
    const commitsB: string[] = [];
    const a = h.client.send(message("A", "AL", "AL"), { onCommitAck: () => commitsA.push("CA") });
    const b = h.client.send(message("B", "AL", "AL"), { onCommitAck: () => commitsB.push("CA") });

    h.peerAck(ack("CA", "B"));
    expect(commitsA).toEqual([]);
    expect(commitsB).toEqual(["CA"]);
    expect(await isPending(a)).toBe(true);
    expect(await isPending(b)).toBe(true);

    h.peerAck(ack("CA", "A"));
    h.peerAck(ack("AA", "B"));
    expect(await isPending(a)).toBe(true);
    expect((await b).toString("latin1")).toContain("MSA|AA|B");

    h.peerAck(ack("AE", "A"));
    expect((await a).toString("latin1")).toContain("MSA|AE|A");
    h.client.destroy();
  });

  it("a negative commit for one send does not disturb the other", async () => {
    const h = harness();
    const a = h.client.send(message("A", "AL", "AL"));
    const b = h.client.send(message("B", "AL", "AL"));
    h.peerAck(ack("CR", "A"));
    await expect(a).rejects.toBeInstanceOf(MllpCommitRejectedError);
    expect(await isPending(b)).toBe(true);
    h.peerAck(ack("AA", "B"));
    await expect(b).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });
});

describe("a send that has already been disposed of", () => {
  it("every further acknowledgement inside the window draws the already-disposed code", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("AA", "M1"));
    await sent;

    h.peerAck(ack("AA", "M1"));
    h.peerAck(ack("AA", "M1"));
    h.peerAck(ack("CA", "M1"));
    const disposed = h.warnings.filter((w) => w.code === "MLLP_ACK_SEND_ALREADY_DISPOSED");
    // Three repeats, three answers. An eviction on the first would have made the second
    // read as "no such send", which is a different and wrong statement.
    expect(disposed).toHaveLength(3);
    expect(h.errors.filter((e) => e.error.code === "MLLP_ACK_UNMATCHED_CONTROL_ID")).toHaveLength(
      0,
    );
    h.client.destroy();
  });

  it("a send failed by a negative commit is remembered the same way", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("CE", "M1"));
    await expect(sent).rejects.toBeInstanceOf(MllpCommitRejectedError);
    h.peerAck(ack("AA", "M1"));
    h.peerAck(ack("AA", "M1"));
    expect(h.warnings.filter((w) => w.code === "MLLP_ACK_SEND_ALREADY_DISPOSED")).toHaveLength(2);
    h.client.destroy();
  });

  it("the memory is bounded: past the window the same acknowledgement is unmatched", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({ ackTimeoutMs: 100 });
      const sent = h.client.send(message("M1", "AL", "AL"));
      h.peerAck(ack("AA", "M1"));
      await sent;
      h.peerAck(ack("AA", "M1"));
      expect(h.warnings.filter((w) => w.code === "MLLP_ACK_SEND_ALREADY_DISPOSED")).toHaveLength(1);

      // Past `2 * ackTimeoutMs` from the disposal, the send is forgotten and "no such
      // send" becomes the correct answer.
      await vi.advanceTimersByTimeAsync(500);
      h.peerAck(ack("AA", "M1"));
      expect(h.warnings.filter((w) => w.code === "MLLP_ACK_SEND_ALREADY_DISPOSED")).toHaveLength(1);
      expect(
        h.errors.filter((e) => e.error.code === "MLLP_ACK_UNMATCHED_CONTROL_ID").length,
      ).toBeGreaterThan(0);
      h.client.destroy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("an acknowledgement for a send that never existed is still 'no such send'", async () => {
    const h = harness();
    h.peerAck(ack("AA", "GHOST"));
    expect(h.warnings.filter((w) => w.code === "MLLP_ACK_SEND_ALREADY_DISPOSED")).toHaveLength(0);
    expect(h.errors.filter((e) => e.error.code === "MLLP_ACK_UNMATCHED_CONTROL_ID")).toHaveLength(
      1,
    );
    h.client.destroy();
    await Promise.resolve();
  });
});

describe("a client that does not correlate by control ID", () => {
  it("keeps its own behaviour for an enhanced-mode send, and says so", async () => {
    const h = harness({ correlateByControlId: false });
    const commits: string[] = [];
    const sent = h.client.send(message("M1", "AL", "AL"), {
      onCommitAck: (r) => commits.push(r.code),
    });
    // The first acknowledgement matched to the send settles it, whatever its MSA-1 says:
    // exactly what this client did before, because MSA-2 is the only thing that could
    // attribute a second acknowledgement to a send and this client is not reading it.
    h.peerAck(ack("CA", "M1"));
    const resolved = await sent;
    expect(resolved.toString("latin1")).toContain("MSA|CA|M1");
    expect(commits).toEqual([]);
    expect(h.warnings.map((w) => w.code)).toContain("MLLP_ACK_TWO_PHASE_UNAVAILABLE");
    h.client.destroy();
  });

  it("does not leave such a send pending on an acknowledgement it would have settled", async () => {
    const h = harness({ correlateByControlId: false });
    // An MSA-1 that a two-phase send would have left pending settles this one.
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("ZZ", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });
});

describe("an unrecognised Table 0155 value is warned and defaulted, never fatal", () => {
  it("MSH-15 outside the table warns, names that field, and the message still goes out", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "VENDOR", ""));
    expect(h.warnings.map((w) => w.code)).toContain("MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED");
    expect(h.warnings.map((w) => w.code)).not.toContain("MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED");
    // Defaulted to NE for the accept condition and AL for the application condition, so
    // this send awaits an application acknowledgement and an AA settles it.
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("MSH-16 outside the table warns and names that field", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "", "VENDOR"));
    expect(h.warnings.map((w) => w.code)).toContain("MLLP_ACK_APPLICATION_TYPE_UNRECOGNISED");
    expect(h.warnings.map((w) => w.code)).not.toContain("MLLP_ACK_ACCEPT_TYPE_UNRECOGNISED");
    h.peerAck(ack("AA", "M1"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });

  it("the bytes on the wire are the caller's own, unaltered", async () => {
    const [local, peer] = InMemoryTransport.pair();
    const conn = new Connection({ transport: local });
    const client = createClient({
      host: "127.0.0.1",
      port: 0,
      correlateByControlId: true,
    });
    const seen: Buffer[] = [];
    peer.onData((chunk) => seen.push(Buffer.from(chunk)));
    client._attachExistingConnection(conn);
    conn.notifyConnect("127.0.0.1", 2575);
    const payload = message("M1", "VENDOR", "ALSO-VENDOR");
    const sent = client.send(payload);
    const written = Buffer.concat(seen);
    expect(written).toEqual(encodeFrame(payload));
    peer.write(encodeFrame(ack("AA", "M1")));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    client.destroy();
  });
});

describe("an original-mode send is untouched", () => {
  it("both fields absent: the first acknowledgement settles it, whatever its MSA-1 says", async () => {
    for (const msa1 of ["CA", "CE", "ZZ", ""]) {
      const h = harness();
      const sent = h.client.send(originalMessage("M1"));
      h.peerAck(ack(msa1, "M1"));
      await expect(sent).resolves.toBeInstanceOf(Buffer);
      // No acknowledgement-mode diagnostic is raised for it either.
      expect(h.warnings).toEqual([]);
      h.client.destroy();
    }
  });

  it("a send whose header cannot be scanned is treated as original mode, not failed", async () => {
    const h = harness({ correlateByControlId: false });
    const sent = h.client.send(Buffer.from("not hl7 at all"));
    expect(h.warnings).toEqual([]);
    h.peerAck(ack("ZZ", "ANY"));
    await expect(sent).resolves.toBeInstanceOf(Buffer);
    h.client.destroy();
  });
});

describe("no diagnostic introduced here carries payload content", () => {
  it("holds across every acknowledgement-mode code, in both correlation modes", async () => {
    const marker = "SECRETCONTROLID";
    for (const correlateByControlId of [true, false]) {
      const h = harness({ correlateByControlId });
      const sent = h.client.send(message(marker, "VENDOR", "VENDOR"), {
        onCommitAck: () => undefined,
      });
      h.peerAck(ack("", marker));
      h.peerAck(ack("SECRETVALUE", marker));
      h.peerAck(ack("CA", marker));
      h.peerAck(ack("CA", marker));
      h.peerAck(ack("AA", marker));
      await sent.catch(() => undefined);
      h.peerAck(ack("AA", marker));

      expect(h.warnings.length).toBeGreaterThan(0);
      for (const w of h.warnings) {
        const rendered = JSON.stringify(w);
        expect(rendered).not.toContain(marker);
        expect(rendered).not.toContain("SECRETVALUE");
        // The text is the frozen registry entry, byte for byte.
        expect(w.message).toBe(ackModeDiagnosticMessage(w.code as never));
        // Everything else it carries is a number or a closed-set acknowledgement code.
        for (const [key, value] of Object.entries(w)) {
          if (key === "code" || key === "message" || key === "timestamp") continue;
          if (key === "connectionId") {
            expect(typeof value === "string" || value === undefined).toBe(true);
            continue;
          }
          if (key === "ackCode") {
            expect(
              value === null || ["AA", "AE", "AR", "CA", "CE", "CR"].includes(value as string),
            ).toBe(true);
            continue;
          }
          expect(value === null || typeof value === "number").toBe(true);
        }
      }
      h.client.destroy();
    }
  });

  it("an unclassifiable MSA-1 is reported by its byte length only", async () => {
    const h = harness();
    const sent = h.client.send(message("M1", "AL", "AL"));
    h.peerAck(ack("VENDORSPECIFIC", "M1"));
    const w = h.warnings.find((x) => x.code === "MLLP_ACK_MSA1_UNCLASSIFIABLE");
    expect(w?.msa1Bytes).toBe("VENDORSPECIFIC".length);
    expect(JSON.stringify(w)).not.toContain("VENDORSPECIFIC");
    expect(await isPending(sent)).toBe(true);
    h.client.destroy();
  });

  it("the typed errors carry a control-ID byte length, never the control ID", async () => {
    const marker = "ANOTHERSECRETID";
    const h = harness();
    const sent = h.client.send(message(marker, "AL", "AL"));
    h.peerAck(ack("CE", marker));
    const err = await sent.catch((e: MllpCommitRejectedError) => e);
    expect(err).toBeInstanceOf(MllpCommitRejectedError);
    const rejected = err as MllpCommitRejectedError;
    expect(rejected.messageControlIdBytes).toBe(marker.length);
    expect(rejected.message).not.toContain(marker);
    expect(JSON.stringify({ ...rejected, message: rejected.message })).not.toContain(marker);
    h.client.destroy();
  });
});
