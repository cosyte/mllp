/**
 * Differential conformance harness.
 *
 * The interop bar for mllp is byte-parity with the two dominant open-source R1 MLLP
 * implementations named in the roadmap:
 *   - the **Google Cloud Healthcare MLLP adapter** (Go, Apache-2.0),
 *     https://github.com/GoogleCloudPlatform/mllp
 *   - **Mirth / NextGen Connect** (Java, MPL),
 *     https://github.com/nextgenhealthcare/connect
 *
 * Both frame HL7 v2 the same, spec-mandated way: `VT (0x0B) + payload + FS (0x1C) +
 * CR (0x0D)` (MLLP Release 1). This suite has two tiers:
 *
 *   **Tier 1, golden frames (always on).** `fixtures/*.frame.bin` are canonical R1
 *   frames, the exact wire bytes both adapters emit for the synthetic messages, per
 *   their documented framing. We assert (a) the golden has R1 structure, (b) mllp's
 *   `FrameReader` decodes it to the exact payload, and (c) mllp's `encodeFrame`
 *   reproduces it byte-for-byte. A framing regression shows up as a byte diff here.
 *   See `fixtures/README.md` for provenance and how to regenerate / replace with live
 *   captures.
 *
 *   Tier 1 is now RE-POINTED at the SHIPPED corpus (`src/differential/corpus.ts`): each
 *   golden is asserted byte-identical to the corpus entry of the same name, so what a
 *   consumer's installed package sends at their engine is the same bytes these
 *   assertions pin. The assertions themselves are unchanged in meaning.
 *
 *   **Tier 2, live peer (opt-in, skips when absent).** If `MLLP_DIFF_ADAPTER` is set to
 *   `host:port` of a running R1 adapter (e.g. a locally-run Google adapter or Mirth
 *   listener), the suite runs the shipped harness against it and asserts a report came
 *   back. With the env var unset, CI and most dev machines, where no Java/Go adapter or
 *   Docker is available, the run SKIPS cleanly (`result === 'skipped'`) so `pnpm test`
 *   stays green. The harness's own behaviour, over an in-process peer, is pinned in
 *   `harness.test.ts`; this tier exists only to exercise a real engine when one is there.
 *
 * All fixtures are synthetic (no real PHI).
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { VT, FS, CR } from "../../src/framing/constants.js";
import { canonicalAcknowledgement, canonicalExchanges } from "../../src/differential/corpus.js";
import { runDifferential } from "../../src/differential/run.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, "fixtures");

/** Decode exactly one R1 frame's payload from framed bytes (no tolerance needed for goldens). */
function decodeOne(framed: Buffer): Buffer {
  const frames: Buffer[] = [];
  const reader = new FrameReader({ onFrame: (p) => frames.push(p) });
  reader.push(framed);
  if (frames.length !== 1) throw new Error(`expected exactly 1 frame, got ${frames.length}`);
  return frames[0] as Buffer;
}

/** Strip the R1 envelope (VT … FS CR) to recover the payload the adapter framed. */
function stripR1(framed: Buffer): Buffer {
  expect(framed[0]).toBe(VT);
  expect(framed[framed.length - 2]).toBe(FS);
  expect(framed[framed.length - 1]).toBe(CR);
  return framed.subarray(1, framed.length - 2);
}

/**
 * The goldens, paired with the SHIPPED corpus entry each one pins. The third golden is the
 * canonical positive acknowledgement, which the corpus ships as the reference ANSWER
 * rather than as a message the harness sends.
 */
const GOLDENS: readonly { readonly file: string; readonly payload: Buffer }[] = [
  { file: "r1-adt-a01.frame.bin", payload: canonicalExchanges()[0]?.payload as Buffer },
  { file: "r1-oru-r01.frame.bin", payload: canonicalExchanges()[1]?.payload as Buffer },
  { file: "r1-ack-aa.frame.bin", payload: canonicalAcknowledgement() },
];

// Tier 1 pins mllp against the *canonical R1 wire shape* (VT … FS CR), the framing both the
// Google Cloud MLLP adapter and Mirth/NextGen emit, since R1 framing is byte-identical across
// conformant implementations. The goldens are spec-derived (see fixtures/README), NOT live
// captures, so this tier is a self-consistency + regression guard on the canonical shape; true
// per-binary parity against a running adapter is the opt-in Tier 2 below.
describe("differential Tier 1: parity with the canonical R1 wire shape (spec-derived golden)", () => {
  for (const { file, payload } of GOLDENS) {
    describe(file, () => {
      const framed = readFileSync(path.join(FIXTURE_DIR, file));

      it("golden has canonical R1 structure (VT … FS CR)", () => {
        expect(framed.length).toBeGreaterThan(3);
        expect(framed[0]).toBe(VT);
        expect(framed[framed.length - 2]).toBe(FS);
        expect(framed[framed.length - 1]).toBe(CR);
      });

      it("mllp FrameReader decodes the adapter's frame to the exact payload", () => {
        const decoded = decodeOne(framed);
        expect(decoded).toEqual(stripR1(framed));
      });

      it("mllp encodeFrame reproduces the canonical R1 golden bytes exactly (emit parity)", () => {
        expect(encodeFrame(stripR1(framed))).toEqual(framed);
      });

      it("the SHIPPED corpus entry is byte-identical to this golden", () => {
        // The corpus is what a consumer's installed package sends; the golden is what this
        // repository's framing assertions pin. If they ever diverge, the two are testing
        // different messages and Tier 1 stops standing for the shipped harness.
        expect(payload).toEqual(stripR1(framed));
        expect(encodeFrame(payload)).toEqual(framed);
      });
    });
  }

  it("ACK correlation: the R1 ACK's MSA-2 echoes the ADT's MSH-10 (interop contract)", () => {
    const adt = decodeOne(readFileSync(path.join(FIXTURE_DIR, "r1-adt-a01.frame.bin"))).toString(
      "ascii",
    );
    const ack = decodeOne(readFileSync(path.join(FIXTURE_DIR, "r1-ack-aa.frame.bin"))).toString(
      "ascii",
    );
    const msh10 = adt.split("\r")[0]?.split("|")[9]; // MSH-10 message control ID
    const msa2 = ack.split("\r")[1]?.split("|")[2]; // MSA-2 control ID
    expect(msh10).toBe("MSG00001");
    expect(msa2).toBe(msh10);
    // And the corpus declares the same control ID, so the harness correlates on it.
    expect(canonicalExchanges()[0]?.controlId).toBe(msh10);
  });
});

describe("differential Tier 2: live R1 peer (opt-in via MLLP_DIFF_ADAPTER)", () => {
  it("with no peer configured the run skips cleanly and the default verify stays green", async () => {
    const configured = process.env["MLLP_DIFF_ADAPTER"]?.trim();
    if (configured !== undefined && configured !== "") {
      // A peer IS configured: run the shipped harness against it and report. No assertion
      // is made about the peer's conformance, only that a report came back.
      const report = await runDifferential({ peer: configured, deadlineMs: 10_000 });
      expect(report.result).not.toBe("skipped");
      expect(report.exchangesAttempted).toBe(canonicalExchanges().length);
      expect(report.exchanges).toHaveLength(canonicalExchanges().length);
      return;
    }
    const report = await runDifferential({ peer: configured });
    expect(report.result).toBe("skipped");
    expect(report.skipReason).toBe("no-peer-configured");
    expect(report.exchanges).toEqual([]);
    expect(report.peer).toBeUndefined();
  });
});
