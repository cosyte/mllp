/**
 * Unit tests for scripts/phi-scan.ts — the MLLP/HL7 v2 PHI commit-gate.
 *
 * mllp is a transport library: it wraps HL7 v2 in MLLP frames
 * (`VT + payload + FS CR`). The scanner is a port of `@cosyte/hl7`'s
 * segment/field-aware detector plus an MLLP-frame unwrap. These tests prove BOTH
 * halves:
 *   - the HL7-aware detectors CATCH real-looking PHI (a weak scanner is worse
 *     than none) and PASS genuinely synthetic, allow-listed content; and
 *   - the MLLP unwrap works — a framed message's HL7 payload is scanned exactly
 *     as an un-framed one, and malformed frames (missing end-block, double
 *     framing) do NOT bypass detection.
 *
 * The committed differential golden frames (`test/differential/fixtures/*.frame.bin`)
 * are the real end-to-end negative case: the `all`-mode sweep must pass on them.
 *
 * Violator fixtures are written to a throwaway temp dir so they never pollute the
 * committed corpus. The scanner is invoked via spawnSync (array args, no shell)
 * so the full CLI path (argv parse, exit code, stderr) is exercised.
 *
 * SECURITY: every subprocess call here uses spawnSync with array args. No exec,
 * no shell-form. PHI-shaped literals (SSN etc.) are assembled from parts and the
 * assertion regexes are digit-group-anchored, so no literal identifier lives in
 * this source and no code-scanning tool reads one.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const SCANNER_PATH = join(REPO_ROOT, "scripts", "phi-scan.ts");
const OVERRIDES_PATH = join(REPO_ROOT, "phi-scan-overrides.md");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");

// MLLP Release 1 framing bytes.
const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** Assemble an HL7 v2 message from segments, joined by the wire `\r` separator. */
function msg(...segments: string[]): string {
  return segments.join("\r");
}

/** Wrap an HL7 payload in a single MLLP frame: `VT + payload + FS + CR`. */
function frame(payload: string): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(payload, "utf8"), Buffer.from([FS, CR])]);
}

const MSH = "MSH|^~\\&|SENDAPP|SENDFAC|RECVAPP|RECVFAC|20260101120000||ADT^A01|MSG1|P|2.5";

let dir: string;

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runScanner(args: string[]): RunResult {
  const r = spawnSync(TSX_BIN, [SCANNER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** Write a text message to the temp dir (default `.hl7`) and scan it. */
function scan(name: string, content: string): RunResult {
  const path = join(dir, name);
  writeFileSync(path, content);
  return runScanner([path]);
}

/** Write a binary Buffer fixture to the temp dir and scan it. */
function scanBin(name: string, content: Buffer): RunResult {
  const path = join(dir, name);
  writeFileSync(path, content);
  return runScanner([path]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "mllp-phi-scan-"));
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Negative tests — genuinely synthetic, allow-listed content PASSES
// ---------------------------------------------------------------------------

describe("phi-scan: synthetic / allow-listed content passes (exit 0)", () => {
  it("a clean synthetic message exits 0", () => {
    const r = scan(
      "clean.hl7",
      msg(
        MSH,
        "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M|||123 Main St^^Boston^MA^02101||^PRN^PH^^^617^5551212",
      ),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });

  it("a clean synthetic message wrapped in an MLLP frame exits 0", () => {
    // Same payload, but as the actual wire bytes (VT + payload + FS CR). The
    // frame bytes must not defeat the delimiter/segment detection.
    const r = scanBin(
      "clean.frame.bin",
      frame(msg(MSH, "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M")),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });

  it("the committed corpus (all-mode) is clean", () => {
    const r = runScanner([]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK — no hits/);
  });
});

// ---------------------------------------------------------------------------
// MLLP-frame unwrap — the transport-layer addition
// ---------------------------------------------------------------------------

describe("phi-scan: MLLP frame unwrap catches PHI inside the frame", () => {
  it("catches a real patient name inside a well-formed MLLP frame", () => {
    const r = scanBin(
      "framed.frame.bin",
      frame(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19800115|M")),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/Anderson/);
    expect(r.stderr).toMatch(/Michael/);
  });

  it("does NOT bypass when the end-block (FS CR) is missing", () => {
    // A frame with the VT start-block but no FS CR end-block must still be
    // unwrapped (VT stripped) and its payload scanned.
    const noEnd = Buffer.concat([
      Buffer.from([VT]),
      Buffer.from(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19800115|M"), "utf8"),
    ]);
    const r = scanBin("no-end.frame.bin", noEnd);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/Anderson/);
  });

  it("does NOT bypass a double-framed message", () => {
    // Two VT start-blocks and two FS CR end-blocks (outer frame wrapping a full
    // inner frame). All leading VTs are stripped and the payload still scanned.
    const inner = frame(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19800115|M"));
    const doubled = Buffer.concat([Buffer.from([VT]), inner, Buffer.from([FS, CR])]);
    const r = scanBin("double.frame.bin", doubled);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/Anderson/);
  });

  it("catches a bare-numeric MRN inside an MLLP frame (CX MRN detector)", () => {
    const r = scanBin(
      "mrn.frame.bin",
      frame(msg(MSH, "PID|1||48291043^^^HOSP^MR||Doe^John||19800115|M")),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-3/);
    expect(r.stderr).toMatch(/48291043/);
  });
});

// ---------------------------------------------------------------------------
// Non-HL7 binary fixtures are handled safely (no crash, no false positive)
// ---------------------------------------------------------------------------

describe("phi-scan: non-HL7 binary fixtures", () => {
  it("skips a non-HL7 binary .bin fixture without crashing or false-positiving", () => {
    // Random-ish bytes including the framing bytes but no HL7 segment line.
    const junk = Buffer.from([
      VT,
      0x00,
      0xff,
      0x01,
      0x7f,
      0x1c,
      0x0d,
      0xde,
      0xad,
      0xbe,
      0xef,
      FS,
      CR,
    ]);
    const r = scanBin("binary.frame.bin", junk);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK — no hits/);
  });

  it("still catches a dashed-SSN shape in an otherwise non-HL7 binary blob", () => {
    // Assemble the SSN shape from parts so no literal identifier lives in source.
    const ssn = ["900", "55", "0000"].join("-");
    const blob = Buffer.concat([
      Buffer.from([0x00, 0xff, 0x01]),
      Buffer.from(`x ${ssn} y`, "utf8"),
    ]);
    const r = scanBin("blob.bin", blob);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/dashed SSN pattern/);
  });
});

// ---------------------------------------------------------------------------
// Scope: any test/ capture (any extension, .ts excepted) earns the structured
// scan (conformance-refuter regression — a .txt/.json/extensionless live capture
// dropped in test/differential/fixtures/ must NOT bypass the scanner)
// ---------------------------------------------------------------------------

describe("phi-scan: extension-agnostic test/ capture scanning (refuter regression)", () => {
  it("gives a framed HL7 capture saved as .txt under test/ the full STRUCTURED scan", () => {
    // A real capture dropped under test/ as .txt (not .bin/.hl7) must earn the
    // structured name/DOB/MRN scan, not just the conservative shape pass. Written
    // inside the repo test/ tree (so its repo-relative path starts with "test/")
    // in a self-cleaning temp dir, and scanned individually — never during the
    // all-mode "corpus is clean" run above.
    const tmpDir = mkdtempSync(join(REPO_ROOT, "test", "phi-scan-cap-"));
    try {
      const p = join(tmpDir, "capture.txt");
      writeFileSync(p, frame(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M")));
      const r = runScanner([p]);
      expect(r.code, `stderr: ${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/PID-5/);
      expect(r.stderr).toMatch(/Anderson/);
      expect(r.stderr).toMatch(/PID-7/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("catches a dashed SSN in an extensionless capture under test/", () => {
    const tmpDir = mkdtempSync(join(REPO_ROOT, "test", "phi-scan-cap-"));
    try {
      const ssn = ["900", "55", "0000"].join("-");
      const p = join(tmpDir, "wirelog");
      writeFileSync(p, `random adapter log ${ssn} tail`);
      const r = runScanner([p]);
      expect(r.code, `stderr: ${r.stderr}`).toBe(1);
      expect(r.stderr).toMatch(/dashed SSN pattern/);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Positive tests — real-looking PHI is CAUGHT (un-framed HL7)
// ---------------------------------------------------------------------------

describe("phi-scan: names", () => {
  it("catches a real patient name in PID-5", () => {
    const r = scan("name.hl7", msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19800115|M"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/Anderson/);
    expect(r.stderr).toMatch(/Michael/);
  });

  it("skips a single-letter middle initial (not identifying)", () => {
    const r = scan("initial.hl7", msg(MSH, "PID|1||MRN1^^^HOSP^MR||Doe^John^Q||19800115|M"));
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });

  it("catches a real provider name in PV1-7 (XCN comp2/3)", () => {
    const r = scan(
      "provider.hl7",
      msg(
        MSH,
        "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M",
        "PV1|1|I|W^1^A||||ATTEND^Kowalski^Ewa^^^^MD",
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PV1-7/);
    expect(r.stderr).toMatch(/Kowalski/);
  });

  it("catches a name hidden in a site-defined Z-segment", () => {
    const r = scan(
      "zseg.hl7",
      msg(
        MSH,
        "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M",
        "ZCA|1|1|PRIMARY|PROV-9|Okafor^Chidi^MD",
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/ZCA-5/);
    expect(r.stderr).toMatch(/Okafor/);
  });
});

describe("phi-scan: date of birth (PID-7)", () => {
  it("catches a DOB not in the allow-list", () => {
    const r = scan("dob.hl7", msg(MSH, "PID|1||MRN1^^^HOSP^MR||Doe^John||19770707|M"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/19770707/);
  });

  it("catches a 6-digit YYYYMM date of birth", () => {
    const r = scan("dob6.hl7", msg(MSH, "PID|1||MRN1^^^HOSP^MR||Doe^John||197711|M"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/197711/);
  });
});

describe("phi-scan: address (PID-11)", () => {
  it("catches a real street address", () => {
    const r = scan(
      "addr.hl7",
      msg(
        MSH,
        "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M|||742 Evergreen Terrace^^Springfield^IL^62704",
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-11/);
    expect(r.stderr).toMatch(/Evergreen/);
  });
});

describe("phi-scan: phone (PID-13)", () => {
  it("catches a phone without the 555 fake-exchange convention", () => {
    const r = scan(
      "phone.hl7",
      msg(MSH, "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M|||||^PRN^PH^^^312^8675309"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-13/);
  });
});

describe("phi-scan: identifiers", () => {
  it("catches a bare-numeric MRN in PID-3", () => {
    const r = scan("mrn.hl7", msg(MSH, "PID|1||48291043^^^HOSP^MR||Doe^John||19800115|M"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-3/);
    expect(r.stderr).toMatch(/48291043/);
  });

  it("catches an SSN-typed CX identifier (PID-3 type SS)", () => {
    // Build the 9-digit value from parts; assertion is digit-group-anchored.
    const ssn = ["123", "456", "789"].join("");
    const r = scan(
      "ssn-cx.hl7",
      msg(MSH, `PID|1||MRN1^^^HOSP^MR~${ssn}^^^USA^SS||Doe^John||19800115|M`),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-3/);
    expect(r.stderr).toMatch(/\b\d{9}\b/);
  });

  it("passes an SSN CX rep whose id is a placeholder, not a 9-digit number", () => {
    const r = scan(
      "ssn-placeholder.hl7",
      msg(MSH, "PID|1||MRN12345^^^HOSP^MR~SSN^^^USA^SS||Doe^John||19800115|M"),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe("phi-scan: free-text shape checks (OBX-5 / NTE)", () => {
  it("catches a dashed SSN in OBX-5 free text", () => {
    // A 9xx area + all-zero serial is never a real SSN; assembled from parts.
    const fakeSsn = ["900", "55", "0000"].join("-");
    const r = scan(
      "obx-ssn.hl7",
      msg(
        MSH,
        "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M",
        `OBX|1|TX|N^Note^L||SSN on file ${fakeSsn}||||||F`,
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/dashed SSN pattern/);
  });

  it("catches a non-test email in OBX-5 free text", () => {
    const r = scan(
      "obx-email.hl7",
      msg(
        MSH,
        "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M",
        "OBX|1|TX|N^Note^L||reach jane@realhospital.org||||||F",
      ),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/email with non-test domain/);
  });
});

describe("phi-scan: delimiter handling", () => {
  it("reads custom delimiters from MSH-1/MSH-2 and still catches PHI", () => {
    // Field sep `@`, component sep `~`.
    const r = scan(
      "custom.hl7",
      "MSH@~&#\\@A@B@C@D@20260101@@ADT~A01@M1@P@2.5\rPID@1@@MRN1~~~HOSP~MR@@Anderson~Michael@@19800115@M",
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Anderson/);
  });
});

describe("phi-scan: structured scan is not silently bypassed (refuter regressions)", () => {
  it("scans a header-less message (no MSH — starts with EVN)", () => {
    const r = scan(
      "no-msh.hl7",
      msg("EVN|A01|20260419100000", "PID|1||48291043^^^HOSP^MR||Anderson^Michael||19770707|M"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/PID-3/);
  });

  it("scans a header-less message even inside an MLLP frame", () => {
    const r = scanBin(
      "no-msh.frame.bin",
      frame(msg("EVN|A01|20260419100000", "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M")),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
  });

  it("matches segment ids case-insensitively (lowercase `pid`)", () => {
    const r = scan("lower.hl7", msg(MSH, "pid|1||48291043^^^HOSP^MR||Doe^John||19770707|M"));
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/PID-3/);
  });

  it("catches a provider name in an expanded field-map segment (PD1-4)", () => {
    const r = scan(
      "pd1.hl7",
      msg(MSH, "PID|1||MRN1^^^HOSP^MR||Doe^John||19800115|M", "PD1||||1234^Fitzgerald^Ronan^^^^MD"),
    );
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/PD1-4/);
    expect(r.stderr).toMatch(/Fitzgerald/);
  });

  it("keeps src-style .ts content (embedded MSH example) on the text-only pass", () => {
    const path = join(dir, "example.ts");
    writeFileSync(path, 'const example = "MSH|^~\\\\&|A|B|C|D|20260101||ADT^A01|1|P|2.5";\n');
    const r = runScanner([path]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// --allow-fixture override gate
// ---------------------------------------------------------------------------

describe("phi-scan: --allow-fixture override gate", () => {
  it("rejects --allow-fixture without an override-log entry (exit 2)", () => {
    const r = scan("gated.hl7", msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M"));
    expect(r.code).toBe(1); // sanity: it is a violator
    const path = join(dir, "gated.hl7");
    const r2 = runScanner(["--allow-fixture", path]);
    expect(r2.code).toBe(2);
    expect(r2.stderr).toMatch(/phi-scan-overrides\.md/);
  });

  it("honors --allow-fixture WITH an override-log entry (exit 0)", () => {
    const path = join(dir, "override-me.hl7");
    writeFileSync(path, msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M"));
    const rel = relative(REPO_ROOT, path).split(sep).join("/");
    expect(runScanner([path]).code).toBe(1);

    const original = readFileSync(OVERRIDES_PATH, "utf8");
    try {
      appendFileSync(
        OVERRIDES_PATH,
        `\n### ${rel}\n\n- **Date:** 2026-07-18\n- **Reason:** unit test\n- **Approved by:** vitest\n- **Expires:** permanent\n`,
      );
      const r = runScanner(["--allow-fixture", path]);
      expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    } finally {
      writeFileSync(OVERRIDES_PATH, original);
    }
  });
});
