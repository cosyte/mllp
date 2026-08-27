/**
 * PHI discipline on the differential report.
 *
 * A peer this harness is aimed at may be a live engine holding real patients, and a report
 * is a diagnostic surface: it gets written to a file, pasted into a ticket and mailed to a
 * vendor. So the promise is narrow and absolute. A deviation is described by its stable
 * warning code, a byte offset and structural counts. **No run of the peer's payload bytes
 * reaches the report**, in any shape: not a field, not the acknowledged control ID, not a
 * truncation, not a hex rendering of one.
 *
 * Every case here answers with a DISTINCTIVE TOKEN and then proves the token is nowhere in
 * the serialized report. The token is placed where each of the leak routes would carry it:
 *
 *   - inside an ordinary field of a conformant acknowledgement;
 *   - as the FIRST payload byte of a block with no leading `VT`, which is the one position
 *     the decoder's own warning message renders as hex (`MLLP_MISSING_LEADING_VT` and
 *     `MLLP_FS_WITHOUT_CR` both do). This is why the harness records a warning's CODE and
 *     OFFSET and drops its message;
 *   - as the acknowledged control ID of a mis-correlated answer, which is the value the
 *     obvious implementation of a correlation report would print;
 *   - as the content of an oversized response.
 *
 * The last block is the general one: every string anywhere in the report must come from a
 * closed set this package owns. That is what catches a leak route nobody thought of.
 */

import { describe, expect, it } from "vitest";

import { CR, FS, VT } from "../../src/framing/constants.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { canonicalExchanges } from "../../src/differential/corpus.js";
import { runDifferential, type DifferentialConnect } from "../../src/differential/run.js";
import type { DifferentialReport } from "../../src/differential/report.js";
import { InMemoryTransport } from "../../src/testing/in-memory-transport.js";

/**
 * The canary. Deliberate nonsense, chosen to be greppable and to appear nowhere else in
 * this repository, so a hit is unambiguous. It stands in for a patient identifier.
 */
const CANARY = "ZQ7XVKPTW";

/** Hex renderings a warning message would produce for the canary's leading byte. */
const CANARY_FIRST_BYTE_HEX = ["0x5a", "0X5A", "5a", "5A"];

function peerThat(answer: (framed: Buffer) => Buffer | null): DifferentialConnect {
  return () => {
    const [clientEnd, peerEnd] = InMemoryTransport.pair();
    peerEnd.onData((chunk) => {
      const reply = answer(chunk);
      if (reply !== null) peerEnd.write(reply);
    });
    setTimeout(() => {
      clientEnd.simulateConnect();
    }, 0);
    return clientEnd;
  };
}

async function run(
  connect: DifferentialConnect,
  extra: { maxFrameSizeBytes?: number } = {},
): Promise<DifferentialReport> {
  return runDifferential({
    peer: "127.0.0.1:2575",
    connect,
    deadlineMs: 60,
    ...(extra.maxFrameSizeBytes === undefined
      ? {}
      : { maxFrameSizeBytes: extra.maxFrameSizeBytes }),
  });
}

/** Assert the canary, and every substring of it three characters or longer, is absent. */
function expectNoCanary(report: DifferentialReport): void {
  const json = JSON.stringify(report);
  expect(json).not.toContain(CANARY);
  for (let start = 0; start + 3 <= CANARY.length; start += 1) {
    for (let end = start + 3; end <= CANARY.length; end += 1) {
      expect(json).not.toContain(CANARY.slice(start, end));
    }
  }
  for (const hex of CANARY_FIRST_BYTE_HEX) expect(json).not.toContain(hex);
}

describe("differential report: no run of peer payload bytes reaches it", () => {
  it("keeps a canary carried in an ordinary acknowledgement field out of the report", async () => {
    const report = await run(
      peerThat(() =>
        encodeFrame(
          Buffer.from(
            [
              "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
              "MSA|AA|MSG00001",
              `NTE|1||${CANARY}`,
            ].join("\r"),
            "latin1",
          ),
        ),
      ),
    );
    expect(report.exchanges[0]?.outcome).toBe("answered");
    expectNoCanary(report);
  });

  it("keeps the canary out when it is the first payload byte of a block with no leading VT", async () => {
    // This is the sharp one. With the leading `VT` missing, the decoder's own warning
    // message renders the hex of the byte it found where the framing byte was expected,
    // and that byte is the first byte of the peer's unframed content. The harness records
    // the code and the offset and never the message, which is what this pins.
    const report = await run(
      peerThat(() =>
        Buffer.concat([
          Buffer.from(`${CANARY}|^~\\&|R|F|S|F|20260709120001||ACK^A01|A1|P|2.5`, "latin1"),
          Buffer.from([FS, CR]),
        ]),
      ),
    );
    const first = report.exchanges[0];
    expect(first?.warningCodes).toContain("MLLP_MISSING_LEADING_VT");
    expectNoCanary(report);
  });

  it("keeps a mis-correlated acknowledged control ID out of the report", async () => {
    const report = await run(
      peerThat(() =>
        encodeFrame(
          Buffer.from(
            [
              "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
              `MSA|AE|${CANARY}`,
            ].join("\r"),
            "latin1",
          ),
        ),
      ),
    );
    const first = report.exchanges[0];
    expect(first?.correlation).toBe("mismatch");
    expect(first?.warningCodes).toContain("MLLP_ACK_UNMATCHED_CONTROL_ID");
    expectNoCanary(report);
  });

  it("keeps the content of an oversized response out of the report", async () => {
    const report = await run(
      peerThat(() => Buffer.concat([Buffer.from([VT]), Buffer.from(CANARY.repeat(64), "latin1")])),
      { maxFrameSizeBytes: 64 },
    );
    expect(report.exchanges[0]?.warningCodes).toContain("MLLP_FRAME_TOO_LARGE");
    expectNoCanary(report);
  });
});

describe("differential report: every string in it comes from a closed set", () => {
  it("carries no string this package did not put there itself", async () => {
    const report = await run(
      peerThat(() =>
        encodeFrame(
          Buffer.from(
            [
              "MSH|^~\\&|RECV_APP|RECV_FAC|SENDING_APP|SENDING_FAC|20260709120001||ACK^A01|ACK00001|P|2.5",
              `MSA|AA|${CANARY}`,
              `NTE|1||${CANARY}`,
            ].join("\r"),
            "latin1",
          ),
        ),
      ),
    );

    const allowedLiterals = new Set<string>([
      ...canonicalExchanges().map((e) => e.id),
      "answered",
      "unanswered",
      "undecodable-response",
      "connection-refused",
      "connection-failed",
      "connection-dropped",
      "match",
      "mismatch",
      "absent",
      "deviation",
      "not-observed",
      "parity-observed",
      "deviations-observed",
      "no-observation",
      "skipped",
      "no-peer-configured",
      "127.0.0.1",
    ]);
    const warningCode = /^MLLP_[A-Z0-9_]+$/;
    const iso8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

    const strings: string[] = [];
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        strings.push(node);
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      if (typeof node === "object" && node !== null) {
        for (const value of Object.values(node)) walk(value);
      }
    };
    walk(JSON.parse(JSON.stringify(report)));

    expect(strings.length).toBeGreaterThan(0);
    for (const value of strings) {
      const known = allowedLiterals.has(value) || warningCode.test(value) || iso8601.test(value);
      expect(known, `unexpected string in the report: ${JSON.stringify(value)}`).toBe(true);
    }
  });
});
