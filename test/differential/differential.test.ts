/**
 * Differential conformance harness (MLLP-9, roadmap §6 tier "differential testing").
 *
 * The interop bar for mllp is byte-parity with the two dominant open-source R1 MLLP
 * implementations named in the roadmap:
 *   - the **Google Cloud Healthcare MLLP adapter** (Go, Apache-2.0) —
 *     https://github.com/GoogleCloudPlatform/mllp
 *   - **Mirth / NextGen Connect** (Java, MPL) —
 *     https://github.com/nextgenhealthcare/connect
 *
 * Both frame HL7 v2 the same, spec-mandated way: `VT (0x0B) + payload + FS (0x1C) +
 * CR (0x0D)` (MLLP Release 1). This suite has two tiers, mirroring `@cosyte/hl7`'s
 * Phase-J differential harness:
 *
 *   **Tier 1 — golden frames (always on).** `fixtures/*.frame.bin` are canonical R1
 *   frames — the exact wire bytes both adapters emit for the synthetic messages, per
 *   their documented framing. We assert (a) the golden has R1 structure, (b) mllp's
 *   `FrameReader` decodes it to the exact payload, and (c) mllp's `encodeFrame`
 *   reproduces it byte-for-byte. A framing regression shows up as a byte diff here.
 *   See `fixtures/README.md` for provenance and how to regenerate / replace with live
 *   captures.
 *
 *   **Tier 2 — live adapter (opt-in, skips when absent).** If `MLLP_DIFF_ADAPTER` is
 *   set to `host:port` of a running R1 adapter (e.g. a locally-run Google adapter or
 *   Mirth listener), the suite sends a frame and asserts the ACK correlates
 *   (MSA-2 echoes MSH-10). With the env var unset — CI and most dev machines, where no
 *   Java/Go adapter or Docker is available — every Tier-2 test `skip`s, so `verify.sh`
 *   stays green. This matches hl7's oracle-gated pattern (no oracle ⇒ skip, never fail).
 *
 * All fixtures are synthetic (no real PHI).
 */

import { readFileSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { beforeAll, describe, expect, it } from "vitest";

import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { VT, FS, CR } from "../../src/framing/constants.js";

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

const GOLDENS = ["r1-adt-a01.frame.bin", "r1-oru-r01.frame.bin", "r1-ack-aa.frame.bin"] as const;

describe("differential Tier 1: byte-parity with R1 adapter framing (Google / Mirth)", () => {
  for (const name of GOLDENS) {
    describe(name, () => {
      const framed = readFileSync(path.join(FIXTURE_DIR, name));

      it("golden has canonical R1 structure (VT … FS CR)", () => {
        expect(framed.length).toBeGreaterThan(3);
        expect(framed[0]).toBe(VT);
        expect(framed[framed.length - 2]).toBe(FS);
        expect(framed[framed.length - 1]).toBe(CR);
      });

      it("mllp FrameReader decodes the adapter's frame to the exact payload", () => {
        const payload = decodeOne(framed);
        expect(payload).toEqual(stripR1(framed));
      });

      it("mllp encodeFrame reproduces the adapter's bytes exactly (emit parity)", () => {
        const payload = stripR1(framed);
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
  });
});

/** Parse `MLLP_DIFF_ADAPTER=host:port`; undefined when unset/malformed → Tier 2 skips. */
function liveAdapter(): { host: string; port: number } | undefined {
  const raw = process.env["MLLP_DIFF_ADAPTER"];
  if (raw === undefined || raw.trim() === "") return undefined;
  const [host, portStr] = raw.split(":");
  const port = Number(portStr);
  if (host === undefined || host === "" || !Number.isInteger(port) || port <= 0) return undefined;
  return { host, port };
}

describe("differential Tier 2: live R1 adapter (opt-in via MLLP_DIFF_ADAPTER)", () => {
  let adapter: { host: string; port: number } | undefined;

  beforeAll(() => {
    adapter = liveAdapter();
    if (adapter === undefined) {
      // eslint-disable-next-line no-console
      console.log(
        "[differential] MLLP_DIFF_ADAPTER not set — skipping live-adapter tier (verify stays green)",
      );
    }
  });

  it("sends a frame to the live adapter and the ACK correlates on MSH-10", async (ctx) => {
    if (adapter === undefined) {
      ctx.skip();
      return;
    }
    const { host, port } = adapter;
    const adtFramed = readFileSync(path.join(FIXTURE_DIR, "r1-adt-a01.frame.bin"));
    const adt = decodeOne(adtFramed).toString("ascii");
    const msh10 = adt.split("\r")[0]?.split("|")[9];

    const ackBytes = await new Promise<Buffer>((resolve, reject) => {
      const sock = net.createConnection({ host, port }, () => {
        sock.write(adtFramed);
      });
      const reader = new FrameReader({
        onFrame: (p) => {
          sock.end();
          resolve(p);
        },
        allowFsOnly: true,
        allowLfAfterFs: true,
      });
      sock.on("data", (d) => {
        reader.push(d);
      });
      sock.on("error", reject);
      sock.setTimeout(10_000, () => {
        sock.destroy();
        reject(new Error("live adapter did not ACK within 10s"));
      });
    });

    const msa2 = ackBytes.toString("ascii").split("\r")[1]?.split("|")[2];
    expect(msa2).toBe(msh10);
  });
});
