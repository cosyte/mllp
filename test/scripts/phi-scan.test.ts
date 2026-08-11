/**
 * Unit tests for scripts/phi-scan.ts, the MLLP/HL7 v2 PHI commit-gate.
 *
 * mllp is a transport library: it wraps HL7 v2 in MLLP frames
 * (`VT + payload + FS CR`). The scanner is a port of `@cosyte/hl7`'s
 * segment/field-aware detector plus an MLLP-frame unwrap. These tests prove BOTH
 * halves:
 *   - the HL7-aware detectors CATCH real-looking PHI (a weak scanner is worse
 *     than none) and PASS genuinely synthetic, allow-listed content; and
 *   - the MLLP unwrap works, a framed message's HL7 payload is scanned exactly
 *     as an un-framed one, and malformed frames (missing end-block, double
 *     framing) do NOT bypass detection; and
 *   - the enumeration TOCTOU window: what a file that goes away between the walk
 *     and the read is allowed to do to a sweep (its own block below, with its own
 *     deterministic harness).
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
 *
 * RUNNER: the sweep spawns `node` directly on the `.ts` scanner and relies on
 * node's native type stripping, because this file is spawn-bound and a `tsx`
 * start costs several times a `node` start (see the CHANGELOG entry for the
 * measured figures on this suite). Two consequences, both deliberate:
 *   - `pnpm phi-scan` still runs `tsx scripts/phi-scan.ts`, so ONE test below
 *     spawns `tsx` and asserts the two runners agree byte for byte. Delete it
 *     and a tsx-only breakage ships green, with the cheap runner testing
 *     something the commit gate does not run.
 *   - node's type stripping is on by default from Node 22.18, while
 *     `engines.node` is `>=22.0.0`. CI's 22 + 24 matrix resolves above that; a
 *     developer on 22.0-22.17 needs a newer 22 to run this file. Stripping is
 *     erasure-only, and the scanner uses no construct that needs emit, which the
 *     tsx-pinned test reds if it ever stops being true.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import {
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  existsSync,
  rmSync,
  readFileSync,
  appendFileSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const SCANNER_PATH = join(REPO_ROOT, "scripts", "phi-scan.ts");
const OVERRIDES_PATH = join(REPO_ROOT, "phi-scan-overrides.md");
const ALLOW_LIST_REL = join("scripts", "phi-allow-list.txt");
const TSX_BIN = join(REPO_ROOT, "node_modules", ".bin", "tsx");
/** The cheap runner every case below uses. See the RUNNER note in the file header. */
const NODE_BIN = process.execPath;

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
  const r = spawnSync(NODE_BIN, [SCANNER_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    shell: false,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The `tsx` invocation `pnpm phi-scan` really uses, kept for the one test that pins it. */
function runScannerViaTsx(args: string[]): RunResult {
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
// The runner backstop: `pnpm phi-scan` uses tsx, this file uses node
// ---------------------------------------------------------------------------

describe("phi-scan: the `tsx` entry point `pnpm phi-scan` uses is the same scanner", () => {
  // THE ONE CASE THAT STILL PAYS A tsx COLD START, and it is what makes the cheap
  // runner trustworthy. `pnpm phi-scan` (the pre-commit hook and CI) runs
  // `tsx scripts/phi-scan.ts`; every other case here runs `node scripts/phi-scan.ts`.
  // Without this case a tsx-only breakage (a tsx upgrade, a loader difference, a
  // TypeScript construct node's erasure-only stripping rejects but tsx compiles)
  // would ship green.
  //
  // It asserts EQUIVALENCE, not merely that tsx works: both runners must agree on
  // exit code, stdout and stderr byte for byte.
  //
  // BOTH OUTCOMES RUN, because the scanner uses a different channel for each and
  // comparing two empty channels proves nothing. A violator writes hits to stderr
  // and nothing to stdout; a clean file writes the OK line to stdout and nothing to
  // stderr. The violator is MLLP-FRAMED, which is this scanner's own half: it is
  // the path where a runner difference in byte handling would show up first.
  //
  // WHY IT CARRIES A BUDGET when it runs in under 2 s on a quiet box: four
  // spawns, two of them the tsx cold start no other case here pays any more, are
  // load-proportional the same way a TLS handshake is. Measured under four
  // concurrent coverage suites this case PEAKED AT 9.20 s, 92 % of the shared
  // 10 s ceiling. Same argument as test/tls/**; see the CHANGELOG entry.
  //
  // What it does NOT cover, stated so nobody reads it as more than it is: single
  // -file mode only, one violator shape, two of this file's invocations. A
  // tsx-only CRASH or false positive still reds CI, which runs `pnpm phi-scan`
  // for real; a tsx-only FALSE NEGATIVE outside this path would not.
  it(
    "agrees with `node` byte for byte on a framed violator AND on a clean file",
    { timeout: 30_000 },
    () => {
      const violator = join(dir, "parity-violator.frame.bin");
      writeFileSync(
        violator,
        frame(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M")),
      );
      const vNode = runScanner([violator]);
      const vTsx = runScannerViaTsx([violator]);
      expect(vNode.code, `stderr: ${vNode.stderr}`).toBe(1);
      expect(vNode.stdout).toBe("");
      expect(vNode.stderr).not.toBe("");
      expect(vTsx).toEqual(vNode);

      const clean = join(dir, "parity-clean.hl7");
      writeFileSync(clean, msg(MSH, "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M"));
      const cNode = runScanner([clean]);
      const cTsx = runScannerViaTsx([clean]);
      expect(cNode.code, `stderr: ${cNode.stderr}`).toBe(0);
      expect(cNode.stdout).not.toBe("");
      expect(cNode.stderr).toBe("");
      expect(cTsx).toEqual(cNode);
    },
  );
});

// ---------------------------------------------------------------------------
// Negative tests, genuinely synthetic, allow-listed content PASSES
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
    expect(r.stdout).toMatch(/OK, no hits/);
  });
});

// ---------------------------------------------------------------------------
// MLLP-frame unwrap, the transport-layer addition
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
    expect(r.stdout).toMatch(/OK, no hits/);
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
// scan (conformance-refuter regression, a .txt/.json/extensionless live capture
// dropped in test/differential/fixtures/ must NOT bypass the scanner)
// ---------------------------------------------------------------------------

describe("phi-scan: extension-agnostic test/ capture scanning (refuter regression)", () => {
  it("gives a framed HL7 capture saved as .txt under test/ the full STRUCTURED scan", () => {
    // A real capture dropped under test/ as .txt (not .bin/.hl7) must earn the
    // structured name/DOB/MRN scan, not just the conservative shape pass. Written
    // inside the repo test/ tree (so its repo-relative path starts with "test/")
    // in a self-cleaning temp dir, and scanned individually, never during the
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
// Positive tests, real-looking PHI is CAUGHT (un-framed HL7)
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
  it("scans a header-less message (no MSH, starts with EVN)", () => {
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

  it("keeps a header-only .ts example clean (MSH carries no PHI field)", () => {
    // This file is NOT under `src/`, so it does reach the embedded recogniser.
    // It stays clean because `scanHl7` skips MSH/FHS/BHS: those segments carry
    // routing metadata and delimiters, never a PHI field. The `src/`-specific
    // guarantee (conservative pass only, whatever the content) is pinned
    // separately, below.
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

  it("RECORDS then REFUSES --allow-fixture WITH an override-log entry (exit 2)", () => {
    // ▶ THIS CASE ASSERTED exit 0 UNTIL THE COMPLETENESS RULE LANDED, and the
    // flip is the whole point of that rule rather than a regression: the run
    // enumerated the file, declined to open it, and a scan that did not open a
    // file has no clean verdict to give about it. The override gate itself is
    // UNCHANGED and still the thing being tested here: the path gets past
    // `validateAllowFixtures` (the unlogged case above is refused with a
    // different message), and is then refused for incompleteness instead.
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
      expect(r.code, `stderr: ${r.stderr}`).toBe(2);
      expect(r.stderr).toMatch(/enumerated and never read/);
      expect(r.stderr).toContain(rel);
      // It got PAST the override gate: the unlogged refusal has other wording.
      expect(r.stderr).not.toMatch(/--allow-fixture rejected/);
    } finally {
      writeFileSync(OVERRIDES_PATH, original);
    }
  });
});

// ---------------------------------------------------------------------------
// Enumeration TOCTOU
// ---------------------------------------------------------------------------

/**
 * `all` mode lists `test/` + `src/`, then reads each file. Anything created and
 * removed inside that window makes a read throw `ENOENT`, and the scanner used
 * to refuse the entire sweep over it (exit 2).
 *
 * This repo reaches that window through its OWN suite, unlike its sibling
 * parsers: the two capture tests above `mkdtemp` a directory INSIDE `test/`,
 * which is a walk root, write a fixture into it and remove it again. Measured on
 * this checkout, those two directories exist for about 510 ms each per suite
 * run. They cannot simply be moved elsewhere, because what they exist to prove
 * is that a capture whose repo-relative path starts with `test/` earns the
 * structured scan, so the path IS the fixture.
 *
 * These tests hit the window WITHOUT a sleep and WITHOUT a real build. The
 * scanner runs `git check-ignore` and `git ls-files` after the walk and before
 * the first read, so a `git` shim placed first on `PATH` is a deterministic hook
 * into exactly that gap: it removes the decoy, then execs the real git. The shim
 * is a file exec'd through PATH, not a shell-form spawn from this suite.
 *
 * Everything runs against a throwaway git repo (`cwd`, which is the scanner's
 * `REPO_ROOT`), so no decoy is ever written into this repo and a parallel worker
 * cannot see one.
 *
 * Two branches are NOT pinned here, deliberately rather than by oversight:
 *   - a tolerated file written BACK before the post-sweep re-check. Nothing in
 *     the scanner calls git after the reads, so there is no second deterministic
 *     hook, and reaching it needs a timed re-create against a deliberately
 *     slowed sweep. A load-sensitive sleep guarding a load-dependent race is the
 *     failure mode this defect itself teaches. That branch can only turn a
 *     tolerated skip back into the refusal these tests already pin, so losing it
 *     loses the re-check, never the tolerance's bounds.
 *   - `walk()`'s own `existsSync` -> `readdirSync` race, one phase earlier. It
 *     has no hook at all (no subprocess runs before the walk), and it matters
 *     more here than in the siblings because this repo's transient is a
 *     DIRECTORY, removed wholesale. See the CHANGELOG entry for the disclosure.
 */

const tempRoots: string[] = [];

function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(d);
  return d;
}

/** Absolute path of the real `git`, resolved from PATH without a subprocess. */
function realGit(): string {
  for (const entry of (process.env["PATH"] ?? "").split(":")) {
    if (entry.length === 0) continue;
    const candidate = join(entry, "git");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("git not found on PATH");
}

function gitIn(cwd: string, args: string[]): void {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  expect(r.status, r.stderr).toBe(0);
}

/** `gitIn`, but hands back stdout so a test can assert the git premise it rests on. */
function gitOut(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", shell: false });
  expect(r.status, r.stderr).toBe(0);
  return r.stdout;
}

/**
 * A throwaway repo the scanner can treat as REPO_ROOT (git init is optional).
 * It carries the allow-list the scanner loads, plus one CLEAN synthetic fixture
 * under `test/` (the walk root), so a sweep here always observes at least one
 * file and "observed nothing" cannot fire by accident.
 */
function makeScanRepo(opts: { git: boolean; track?: boolean }): string {
  const d = tempDir("mllp-phi-toctou-");
  if (opts.git) {
    const init = spawnSync("git", ["init", "-q"], { cwd: d, encoding: "utf8", shell: false });
    expect(init.status, init.stderr).toBe(0);
  }
  mkdirSync(join(d, "scripts"), { recursive: true });
  mkdirSync(join(d, "test"), { recursive: true });
  copyFileSync(join(REPO_ROOT, ALLOW_LIST_REL), join(d, ALLOW_LIST_REL));
  copyFileSync(OVERRIDES_PATH, join(d, "phi-scan-overrides.md"));
  writeFileSync(
    join(d, "test", "corpus.hl7"),
    msg(MSH, "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M"),
  );
  if (opts.git && opts.track !== false) gitIn(d, ["add", "test/corpus.hl7"]);
  return d;
}

/**
 * A `git` that runs `pre` (a line of `sh`) before delegating to the real git,
 * but ONLY on the invocation whose argv contains `on`.
 *
 * ▶ THE SUBCOMMAND FILTER IS LOAD-BEARING, NOT TIDINESS. These tests need a hook
 * in one specific gap: after the walk has ENUMERATED a root and before the first
 * file is READ. An unconditional shim used to land there by accident, because
 * `git check-ignore` was the first git call `all` mode made. It no longer is:
 * the sweep now reads the git index BEFORE it walks, so an unconditional shim
 * fires one whole phase early, removes the decoy before the walk can enumerate
 * it, and every one of these cases silently starts proving something else (a
 * file that was never enumerated cannot be tolerated, so the tolerance goes
 * untested while the test still passes on the exit code alone).
 *
 * `check-ignore` is still exactly the call that sits in the gap, so naming it
 * keeps each case pinned to the window it was written for.
 */
function gitShim(pre: string, on = "check-ignore"): string {
  const shimDir = tempDir("mllp-phi-shim-");
  writeFileSync(
    join(shimDir, "git"),
    `#!/bin/sh\ncase " $* " in *' ${on} '*|*"${on}"*) ${pre} ;; esac\nexec '${realGit()}' "$@"\n`,
    { mode: 0o755 },
  );
  return shimDir;
}

function runScannerIn(
  cwd: string,
  shimDir: string | null,
  extraEnv?: NodeJS.ProcessEnv,
  args: string[] = [],
): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (shimDir !== null) env["PATH"] = `${shimDir}:${process.env["PATH"] ?? ""}`;
  const r = spawnSync(NODE_BIN, [SCANNER_PATH, ...args], {
    cwd,
    encoding: "utf8",
    shell: false,
    env,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

// The decoy is shaped like THIS repo's real transient, the mkdtemp'd capture
// directory the two tests above create inside `test/`, not like a repo-root
// build artifact (neither walk root is the repo root, so one would never be
// enumerated here).
const TRANSIENT_DIR = "phi-scan-cap-1a2b3c";
const TRANSIENT_REL = `test/${TRANSIENT_DIR}/capture.txt`;

function writeTransient(repo: string): string {
  mkdirSync(join(repo, "test", TRANSIENT_DIR), { recursive: true });
  const abs = join(repo, "test", TRANSIENT_DIR, "capture.txt");
  writeFileSync(abs, "adapter capture, removed by the suite that wrote it\n");
  return abs;
}

afterAll(() => {
  for (const d of tempRoots) rmSync(d, { recursive: true, force: true });
});

describe("phi-scan: enumeration TOCTOU", () => {
  it("tolerates an UNTRACKED file gone between enumeration and read, and reports it", () => {
    const repo = makeScanRepo({ git: true });
    const decoy = writeTransient(repo);
    const r = runScannerIn(repo, gitShim(`rm -rf '${join(repo, "test", TRANSIENT_DIR)}'`));
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
    // Never silent: the skip is named, with the file that went away.
    expect(r.stderr).toMatch(/skipped 1 untracked file\(s\) gone between enumeration and read/);
    expect(r.stderr).toContain(TRANSIENT_REL);
    expect(existsSync(decoy)).toBe(false);
  });

  it("still REFUSES when a TRACKED file vanishes in the same window", () => {
    // The committed corpus is what the gate promises to have observed, so a
    // tracked file that cannot be read is an incomplete scan, not a transient.
    const repo = makeScanRepo({ git: true });
    const doomed = join(repo, "test", "corpus.hl7");
    const r = runScannerIn(repo, gitShim(`rm -f '${doomed}'`));
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/could not read test\/corpus\.hl7/);
    expect(r.stderr).toMatch(/ENOENT/);
  });

  it("still REFUSES a non-ENOENT read failure on an untracked file", () => {
    // Replaced by a directory rather than removed: EISDIR is a scan that failed,
    // not a file that went away, so the tolerance must not swallow it.
    const repo = makeScanRepo({ git: true });
    const decoy = writeTransient(repo);
    const r = runScannerIn(repo, gitShim(`rm -f '${decoy}'\nmkdir -p '${decoy}'`));
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/could not read/);
    expect(r.stderr).toMatch(/EISDIR/);
  });

  it("REFUSES OUTRIGHT when git cannot answer at all", () => {
    // MECHANISM RESTATED, NOT LOOSENED. This used to reach the vanish tolerance
    // and fail closed there: with no tracked set there was no way to tell a
    // transient from committed content, so nothing was tolerated and the READ
    // refused. `all` mode now reads the bytes git carries, so a git that cannot
    // answer refuses at `readIndex()` BEFORE the walk, and the shim below never
    // fires because `check-ignore` is never reached. The assertion is pinned to
    // the new message so this case cannot pass on the old wording by accident.
    const repo = makeScanRepo({ git: false });
    const decoy = writeTransient(repo);
    const r = runScannerIn(repo, gitShim(`rm -f '${decoy}'`), {
      GIT_CEILING_DIRECTORIES: tmpdir(),
    });
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/could not read the git index/);
    // The tolerance itself is still pinned, by the two cases above this one.
    expect(existsSync(decoy)).toBe(true);
  });

  it("REFUSES OUTRIGHT when git answers with an EMPTY index", () => {
    // WHAT THIS PINS CHANGED MECHANISM, AND THE CLAIM IS REWRITTEN RATHER THAN
    // THE ASSERTION LOOSENED. A removed `.git/index` makes `git ls-files` exit 0
    // with NO output. That used to be handled as "no answer" by switching the
    // vanish tolerance off, which fixed the narrow half (an empty tracked set
    // makes EVERY file untracked, the one state in which the tracked-file bound
    // stops existing) and still let the sweep publish a verdict.
    //
    // `all` mode now reads the bytes git carries, so an empty index is not a
    // corpus to reconcile against at all and the whole sweep refuses. That is
    // strictly stronger, and it fires BEFORE the walk, which is why no transient
    // is needed to reach it. (A CORRUPT index exits 128 and is caught by
    // `readIndex`'s own `catch`.)
    const repo = makeScanRepo({ git: true, track: false });
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/index holds no entries/);
    expect(r.stderr).toMatch(/vacuously/);
  });

  it("REFUSES an all-mode sweep that observed no files under a walked root", () => {
    // The refuse-a-scan-that-observes-nothing rule: tolerating a vanished file
    // must never be able to decay into a clean report of nothing. Everything
    // under `test/` is ignored, so the walk enters the root and the filters
    // leave zero targets there.
    //
    // THE INDEX IS DELIBERATELY NON-EMPTY, and that is the point of the extra
    // `git add`: the empty-index refusal above now fires first and would mask
    // this rule entirely if the repo had nothing staged. It also makes the case
    // sharper than it was, because the index route DOES read a file on this run
    // and the per-root rule refuses anyway. That rule is a statement about the
    // WALK, and reading a root's files out of the index does not discharge it.
    // (`git check-ignore` never reports a TRACKED path as ignored, which is why
    // the corpus fixture itself is left unstaged.)
    const repo = makeScanRepo({ git: true, track: false });
    writeFileSync(join(repo, ".gitignore"), "test/\n");
    gitIn(repo, ["add", "-f", ".gitignore"]);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/observed no files under test\//);
  });

  it("still CATCHES a violator in an untracked file that does not vanish", () => {
    // The tolerance is about a file that is GONE, never about untracked files.
    const repo = makeScanRepo({ git: true });
    writeFileSync(
      join(repo, "test", "leak.hl7"),
      msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M"),
    );
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/Anderson/);
  });

  it("still CATCHES a violator inside a transient that is NOT removed", () => {
    // The mllp-shaped case: the capture directory this repo's own suite creates
    // is scanned in full whenever it is still there when the read arrives.
    const repo = makeScanRepo({ git: true });
    mkdirSync(join(repo, "test", TRANSIENT_DIR), { recursive: true });
    writeFileSync(
      join(repo, "test", TRANSIENT_DIR, "capture.txt"),
      frame(msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M")),
    );
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/Anderson/);
  });
});

// ---------------------------------------------------------------------------
// Non-regular entries under a scan root
// ---------------------------------------------------------------------------

/**
 * A symbolic link under a scan root read CLEAN on BOTH enumerating routes, so a
 * link pointing at a PHI-bearing file passed the gate twice over. Measured on
 * the base commit `d854e81`, in this repo, with a synthetic name-bearing payload
 * kept outside both walk roots: a link to it under `test/` gave `all` mode exit
 * 0 "OK, no hits"; a link to its DIRECTORY did the same and took the whole
 * subtree with it; `--staged` (this repo's pre-commit gate) exited 0 after
 * `git add`; and naming the target explicitly exited 1 with every hit. The
 * payload was always detectable, the two routes never looked at it.
 *
 * Two mechanisms, two fixes, and neither follows the link:
 *   - `walk()` enumerates `Dirent.isFile()`, an lstat answer, so a link is
 *     neither a file nor a directory. A non-regular entry is now collected and
 *     REFUSES the sweep (exit 2) instead of falling out of the loop.
 *   - `--staged` reads `git diff --cached --raw -z` so the DESTINATION MODE is
 *     visible, and refuses mode `120000`/`160000` rather than handing
 *     `git show :<path>` a link and scanning the target path text it returns.
 *
 * `--diff-filter` admits `T` (typechange). That is not cosmetic: replacing a
 * TRACKED regular file with a link is neither an add nor a modify, so under the
 * old `AM` the record died before any mode could be read. The premise is
 * asserted in the test rather than trusted.
 *
 * The payload's own FILENAME carries a synthetic surname, given name and date of
 * birth, which is what makes "the refusal never reports the link target"
 * non-vacuous rather than a claim about an empty string.
 *
 * Everything runs in throwaway repos. No link is ever created inside this repo,
 * so a parallel worker cannot see one and the committed corpus is untouched.
 */

/** A synthetic name-bearing HL7 payload plus a link to it, both outside the walk roots. */
function plantPayload(repo: string): { dir: string; file: string; rel: string } {
  const dir = join(repo, "hidden");
  mkdirSync(dir, { recursive: true });
  // The filename is itself name-bearing, on purpose: see the block comment.
  const rel = "Kowalczyk-Bronislawa-19511103.hl7";
  const file = join(dir, rel);
  writeFileSync(file, msg(MSH, "PID|1||987654^^^HOSP^MR||Kowalczyk^Bronislawa||19511103|F"));
  return { dir, file, rel };
}

/** `makeScanRepo` creates `scripts/` and `test/`; the second walk root is made on demand. */
function srcRoot(repo: string): string {
  const p = join(repo, "src");
  mkdirSync(p, { recursive: true });
  // A synthetic repo whose `src/` exists but holds nothing SCANNABLE is not a
  // shape the real repo can be in, and the per-root "observed nothing" guard
  // refuses it (correctly: a root the walk entered and read nothing under proves
  // nothing about that corpus). Plant one benign, hit-free source so these
  // fixtures test what they claim to and not the guard.
  //
  // Written UNCONDITIONALLY, and the `existsSync` guard that used to sit here is
  // gone rather than refined: check-then-write is a file-system race (CodeQL
  // `js/file-system-race`, and this suite is the one that races itself on
  // purpose elsewhere). The content is a constant, so a second call rewrites the
  // same bytes and the guard bought nothing but the race.
  writeFileSync(join(p, "index.ts"), "export const ok = true;\n");
  return p;
}

/** Every PHI token the planted payload carries, for a leak assertion. */
const PLANTED_TOKENS = ["Kowalczyk", "Bronislawa", "19511103", "987654"];

describe("phi-scan: a non-regular entry under a scan root refuses the scan", () => {
  it("REFUSES a symlink to a PHI-bearing file under test/ (all mode)", () => {
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "capture.frame.bin"));

    // Control: the payload IS detectable, so a clean sweep is blindness, not
    // an absence of PHI.
    const named = runScannerIn(repo, null, undefined, [file]);
    expect(named.code, `stderr: ${named.stderr}`).toBe(1);
    expect(named.stderr).toMatch(/PID-5/);

    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/refusing the scan/);
    expect(r.stderr).toContain("test/capture.frame.bin");
    expect(r.stderr).toContain("a symbolic link");
  });

  it("REFUSES a linked DIRECTORY, which used to take its whole subtree silently", () => {
    const repo = makeScanRepo({ git: true });
    const { dir } = plantPayload(repo);
    symlinkSync(dir, join(repo, "test", "captures"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("test/captures");
    expect(r.stderr).toContain("a symbolic link");
  });

  it("NEVER reports the link target, which is working-tree text that can carry PHI", () => {
    // The target path here holds a synthetic surname, given name and DOB, so an
    // implementation that echoed it would fail this and not merely look untidy.
    const repo = makeScanRepo({ git: true });
    const { file, rel } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "capture.frame.bin"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).not.toContain(rel);
    expect(r.stderr).not.toContain("hidden/");
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("REFUSES a non-regular entry whose NAME carries an exempt extension", () => {
    // `.md` anywhere is excluded from the READ set because of what such a file's
    // bytes are, and the per-path violator exemption is the same kind of
    // judgement. A link's name is no evidence at all about the other side, so
    // neither exemption may carry over. The `.ts` arm stays deliberately: it is
    // now a name with NO exemption behind it, which is the case that proves the
    // refusal is about the entry's KIND and not about its extension.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "fixture.ts"));
    symlinkSync(file, join(srcRoot(repo), "notes.md"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("test/fixture.ts");
    expect(r.stderr).toContain("src/notes.md");
  });

  it("names EVERY offender, not just the first", () => {
    // A developer who has to re-run the gate once per link learns to distrust it.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "one.frame.bin"));
    symlinkSync(file, join(repo, "test", "two.frame.bin"));
    symlinkSync(file, join(srcRoot(repo), "three.ts"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/3 entries are not regular files/);
    expect(r.stderr).toContain("test/one.frame.bin");
    expect(r.stderr).toContain("test/two.frame.bin");
    expect(r.stderr).toContain("src/three.ts");
  });

  it("describes a FIFO by its own kind, from the engine's closed set", () => {
    const repo = makeScanRepo({ git: true });
    const r = spawnSync("mkfifo", [join(srcRoot(repo), "pipe")], {
      encoding: "utf8",
      shell: false,
    });
    expect(r.status, r.stderr).toBe(0);
    const out = runScannerIn(repo, null);
    expect(out.code, `stderr: ${out.stderr}`).toBe(2);
    expect(out.stderr).toContain("src/pipe");
    expect(out.stderr).toContain("a FIFO");
  });

  it("EXEMPTS a gitignored non-regular entry, keeping one boundary rather than two", () => {
    // A gitignored file is already out of scope for the file route, so a link
    // does not get a second, stricter boundary of its own.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(srcRoot(repo), "scratch.log"));
    writeFileSync(join(repo, ".gitignore"), "*.log\n");
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("leaves the committed corpus passing (the refusal is not just always-red)", () => {
    const repo = makeScanRepo({ git: true });
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });
});

describe("phi-scan: --staged refuses a non-regular staged entry", () => {
  it("REFUSES a staged symlink, and the git premise it rests on holds", () => {
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "capture.frame.bin"));
    gitIn(repo, ["add", "test/capture.frame.bin"]);

    // PREMISE: git stores a symlink as its TARGET PATH under mode 120000, so
    // `git show :<path>` hands back path text, never the target's bytes.
    const raw = gitOut(repo, ["diff", "--cached", "--raw", "--", "test/capture.frame.bin"]);
    expect(raw).toMatch(/^:000000 120000 /);
    expect(gitOut(repo, ["show", ":test/capture.frame.bin"])).toContain("hidden");

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/refusing the scan/);
    expect(r.stderr).toContain("test/capture.frame.bin");
    expect(r.stderr).toContain("a symbolic link");
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("REFUSES a TYPECHANGE, which the old AM filter dropped before any mode was read", () => {
    // Replacing a TRACKED regular file with a link is neither an add nor a
    // modify. Under `--diff-filter=AM` the record simply did not exist, so the
    // mode check below was unreachable and the hook passed a mode-120000 blob
    // green. The premise is asserted, not assumed.
    const repo = makeScanRepo({ git: true });
    gitIn(repo, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "base"]);
    const { file } = plantPayload(repo);
    unlinkSync(join(repo, "test", "corpus.hl7"));
    symlinkSync(file, join(repo, "test", "corpus.hl7"));
    gitIn(repo, ["add", "test/corpus.hl7"]);

    expect(gitOut(repo, ["diff", "--cached", "--raw", "--diff-filter=AM"]).trim()).toBe("");
    expect(gitOut(repo, ["diff", "--cached", "--raw", "--diff-filter=AMT"])).toMatch(
      /^:100644 120000 .* T\t/m,
    );

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("test/corpus.hl7");
    expect(r.stderr).toContain("a symbolic link");
  });

  it("SCANS the reverse typechange, a link replaced by a real file bearing PHI", () => {
    // Admitting `T` closes both directions. Under `AM` this record was dropped
    // too, so a PHI-bearing file that replaced a link was never read.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    unlinkSync(join(repo, "test", "corpus.hl7"));
    symlinkSync(file, join(repo, "test", "corpus.hl7"));
    gitIn(repo, ["add", "test/corpus.hl7"]);
    gitIn(repo, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "base"]);
    unlinkSync(join(repo, "test", "corpus.hl7"));
    copyFileSync(file, join(repo, "test", "corpus.hl7"));
    gitIn(repo, ["add", "test/corpus.hl7"]);

    expect(gitOut(repo, ["diff", "--cached", "--raw", "--diff-filter=AM"]).trim()).toBe("");

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/Kowalczyk/);
  });

  it("names a staged GITLINK by its kind (the arm the base commit refused by accident)", () => {
    // Not a hole this closes: `git show :<path>` on a gitlink fails with `bad
    // object`, so the base commit already refused, as an incidental read
    // failure. What changes is that the diagnostic says what the entry IS.
    // `--staged`'s scope reaches a staged submodule under BOTH roots here.
    const repo = makeScanRepo({ git: true });
    const nested = join(repo, "test", "nested");
    mkdirSync(nested, { recursive: true });
    gitIn(nested, ["init", "-q"]);
    writeFileSync(join(nested, "f"), "x\n");
    gitIn(nested, ["add", "f"]);
    gitIn(nested, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "i"]);
    gitIn(repo, ["add", "test/nested"]);

    expect(gitOut(repo, ["diff", "--cached", "--raw", "--", "test/nested"])).toMatch(
      /^:000000 160000 /,
    );

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("test/nested");
    expect(r.stderr).toContain("a gitlink");
  });

  it("REFUSES a staged entry named exactly `test` or `src`, which REPLACES a walk root", () => {
    // A prefix test alone lets this one through: it is not "under" a root, it
    // IS one. Measured before the root's own name was matched: `--staged` exited
    // 0 "OK, no hits" over a staged mode-120000 blob named `test`.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    symlinkSync(file, join(repo, "test"));
    gitIn(repo, ["add", "-A", "test"]);
    expect(gitOut(repo, ["diff", "--cached", "--raw", "--", "test"])).toMatch(/ 120000 /);

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/refusing the scan/);
    expect(r.stderr).toContain("a symbolic link");
    // The refused path IS the root here, while the target's filename is
    // name-bearing, so this is the case where echoing the target would be
    // easiest to miss.
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("does NOT refuse a non-regular entry OUTSIDE both roots (the scope is not widened)", () => {
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "elsewhere.frame.bin"));
    gitIn(repo, ["add", "elsewhere.frame.bin"]);
    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });

  it("still scans a staged regular file (negative control)", () => {
    // A gate that only ever refuses is not a gate.
    const repo = makeScanRepo({ git: true });
    writeFileSync(
      join(repo, "test", "leak.hl7"),
      msg(MSH, "PID|1||MRN1^^^HOSP^MR||Anderson^Michael||19770707|M"),
    );
    gitIn(repo, ["add", "test/leak.hl7"]);
    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/Anderson/);
  });
});

// ---------------------------------------------------------------------------
// The three holes the block above left open
// ---------------------------------------------------------------------------

/**
 * `--staged` IS the pre-commit gate here, so a record it never enumerates is a
 * payload that reaches a commit. Three shapes reached neither route, all
 * measured on `2252d33` before anything was touched, all with the same
 * name-bearing synthetic payload `plantPayload` writes:
 *
 *   - a RENAME or COPY record. Both carry two paths and `--diff-filter=AMT`
 *     deletes them outright, so `git mv <link> test/<name>` staged as `R100` at
 *     mode `120000` and exited 0, and a rename that also substituted a real name
 *     staged as a scored rename and exited 0 over live PID-5 / PID-7 / PID-3;
 *   - a REGULAR blob staged at exactly `test`, in scope for the refusal and out
 *     of scope for the read, so nothing looked at it: exit 0 over the same
 *     values;
 *   - a walk ROOT that is not a directory, which threw `ENOTDIR` out of
 *     `readdirSync` uncaught. An uncaught throw exits 1, the code reserved for
 *     "hits found", so the gate published a finding it had not made.
 *
 * Each case asserts the git premise it rests on rather than trusting it, and the
 * link cases assert that no token off the other side of the link is printed.
 */

/** The base commit `makeScanRepo` stops short of, needed before a rename exists. */
function commitBase(repo: string): void {
  gitIn(repo, ["-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "base"]);
}

/**
 * A fixture with enough unchanged bulk that git's rename detection fires on a
 * one-segment substitution. The similarity score is what decides whether the
 * record is an `R` at all, so the premise this test rests on is built rather
 * than hoped for.
 */
function bulkyFixture(pidLine: string): string {
  const filler = Array.from({ length: 8 }, (_, i) => `NTE|${String(i + 1)}||routine filler text`);
  return msg(MSH, ...filler, pidLine);
}

const CLEAN_PID = "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M";
const DIRTY_PID = "PID|1||987654^^^HOSP^MR||Kowalczyk^Bronislawa||19511103|F";

describe("phi-scan: --staged enumerates a rename, which detection used to delete", () => {
  it("REFUSES a link `git mv`d into a scan root, staged as R100 at mode 120000", () => {
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "elsewhere.frame.bin"));
    gitIn(repo, ["add", "elsewhere.frame.bin"]);
    commitBase(repo);
    gitIn(repo, ["mv", "elsewhere.frame.bin", "test/capture.frame.bin"]);

    // PREMISE, both halves. With detection on this is a two-path R100 record at
    // mode 120000, and `--diff-filter=AMT` then deletes it, so the route saw an
    // EMPTY stage over a link sitting under a scan root.
    expect(gitOut(repo, ["diff", "--cached", "--raw"])).toMatch(/^:120000 120000 \S+ \S+ R100\t/m);
    expect(gitOut(repo, ["diff", "--cached", "--raw", "--diff-filter=AMT"]).trim()).toBe("");

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/refusing the scan/);
    expect(r.stderr).toContain("test/capture.frame.bin");
    expect(r.stderr).toContain("a symbolic link");
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("SCANS a rename that also substitutes a real name, and reports every field", () => {
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "test", "corpus.hl7"), bulkyFixture(CLEAN_PID));
    gitIn(repo, ["add", "test/corpus.hl7"]);
    commitBase(repo);
    writeFileSync(join(repo, "test", "renamed.hl7"), bulkyFixture(DIRTY_PID));
    rmSync(join(repo, "test", "corpus.hl7"));
    gitIn(repo, ["add", "-A", "test"]);

    // PREMISE: a scored rename, deleted by the filter before any blob was read.
    expect(gitOut(repo, ["diff", "--cached", "--raw"])).toMatch(
      /^:100644 100644 \S+ \S+ R\d+\ttest\/corpus\.hl7\ttest\/renamed\.hl7$/m,
    );
    expect(gitOut(repo, ["diff", "--cached", "--raw", "--diff-filter=AMT"]).trim()).toBe("");

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("test/renamed.hl7");
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/PID-3/);
  });

  it("cannot be reopened by the caller's own rename / copy configuration", () => {
    // `--no-renames` is what makes the two-field stride STRUCTURAL: with
    // detection off git cannot emit an `R` or a `C` whatever these are set to.
    // Every value is checked against the same rename, not argued about.
    for (const [key, value] of [
      ["diff.renames", "true"],
      ["diff.renames", "copies"],
      ["diff.renames", "false"],
      ["diff.renames", "1"],
      ["diff.renameLimit", "1"],
    ] as const) {
      const repo = makeScanRepo({ git: true });
      gitIn(repo, ["config", key, value]);
      writeFileSync(join(repo, "test", "corpus.hl7"), bulkyFixture(CLEAN_PID));
      gitIn(repo, ["add", "test/corpus.hl7"]);
      commitBase(repo);
      writeFileSync(join(repo, "test", "renamed.hl7"), bulkyFixture(DIRTY_PID));
      rmSync(join(repo, "test", "corpus.hl7"));
      gitIn(repo, ["add", "-A", "test"]);

      const r = runScannerIn(repo, null, undefined, ["--staged"]);
      expect(r.code, `${key}=${value} stderr: ${r.stderr}`).toBe(1);
      expect(r.stderr, `${key}=${value}`).toContain("test/renamed.hl7");
    }
  });

  it("leaves an ordinary stage exactly as it was (negative control)", () => {
    // Turning detection off must ADD records, never move one. A stage with no
    // rename in it enumerates the same single add it always did.
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "test", "clean.hl7"), bulkyFixture(CLEAN_PID));
    gitIn(repo, ["add", "test/clean.hl7"]);
    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("changes the RECORDS themselves only by addition (the superset, pinned)", () => {
    // The claim is that the enumeration is a strict SUPERSET, and the control
    // above only pins the exit code, which a scan could reach for other reasons.
    // This compares the two raw stages git actually hands the scanner: identical
    // on a stage with no rename in it, and gaining exactly the record that used
    // to vanish on one with a rename.
    const flat = makeScanRepo({ git: true });
    writeFileSync(join(flat, "test", "one.hl7"), bulkyFixture(CLEAN_PID));
    gitIn(flat, ["add", "test/one.hl7"]);
    commitBase(flat);
    writeFileSync(join(flat, "test", "one.hl7"), bulkyFixture(CLEAN_PID).replace("NTE|1", "NTE|9"));
    writeFileSync(join(flat, "test", "two.hl7"), bulkyFixture(CLEAN_PID));
    gitIn(flat, ["add", "-A", "test"]);
    const args = ["diff", "--cached", "--raw", "--diff-filter=AMT"];
    // Non-vacuity first: an equality between two empty strings would pass while
    // proving nothing, which is what a future fixture change could quietly make
    // of this.
    const flatRaw = gitOut(flat, args);
    expect(flatRaw).toMatch(/^:100644 100644 \S+ \S+ M\ttest\/one\.hl7$/m);
    expect(flatRaw).toMatch(/^:000000 100644 \S+ \S+ A\ttest\/two\.hl7$/m);
    expect(gitOut(flat, [...args, "--no-renames"])).toBe(flatRaw);

    const renamed = makeScanRepo({ git: true });
    writeFileSync(join(renamed, "test", "corpus.hl7"), bulkyFixture(CLEAN_PID));
    gitIn(renamed, ["add", "test/corpus.hl7"]);
    commitBase(renamed);
    writeFileSync(join(renamed, "test", "renamed.hl7"), bulkyFixture(DIRTY_PID));
    rmSync(join(renamed, "test", "corpus.hl7"));
    gitIn(renamed, ["add", "-A", "test"]);
    const before = gitOut(renamed, args);
    const after = gitOut(renamed, [...args, "--no-renames"]);
    expect(before.trim()).toBe("");
    expect(after).toMatch(/^:000000 100644 \S+ \S+ A\ttest\/renamed\.hl7$/m);
  });
});

describe("phi-scan: a REGULAR blob staged at exactly a walk root is read", () => {
  it("SCANS a PHI-bearing blob staged as `test`, which replaces the fixture root", () => {
    // In scope for the refusal (the root's own name is matched) and out of scope
    // for the read (the read predicate wanted the `test/` PREFIX), so this blob
    // was scanned by nothing at all: measured exit 0 over all three fields.
    const repo = makeScanRepo({ git: true, track: false });
    rmSync(join(repo, "test"), { recursive: true, force: true });
    writeFileSync(join(repo, "test"), msg(MSH, DIRTY_PID));
    gitIn(repo, ["add", "test"]);

    // PREMISE: a plain single-path ADD at mode 100644, path exactly `test`. Not
    // a rename, so this is the read set's own hole and not the one above.
    expect(gitOut(repo, ["diff", "--cached", "--raw"])).toMatch(
      /^:000000 100644 \S+ \S+ A\ttest$/m,
    );

    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toMatch(/PID-3/);
  });

  it("gives it the STRUCTURED scan, which reading it alone would not have", () => {
    // Admitting the path to the read set is only half of it. `looksLikeHl7`
    // decides what scan it earns, and `test` matches none of the fixture-like
    // shapes by extension, so a blob that is read but not judged fixture-like
    // gets the conservative pass, models no fields, and reports clean over a
    // PID. This asserts the field-aware detectors really ran on it.
    const repo = makeScanRepo({ git: true, track: false });
    rmSync(join(repo, "test"), { recursive: true, force: true });
    writeFileSync(join(repo, "test"), msg(MSH, DIRTY_PID));
    gitIn(repo, ["add", "test"]);
    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.stderr).toContain("person-name token not in synthetic allow-list");
    expect(r.stderr).toContain("date of birth not in synthetic allow-list");
  });

  it("gives a blob staged as `src` the SRC root's own limits, not the test root's", () => {
    // An entry that replaces a root is judged with that root's limits, and
    // `src/` gets the conservative dashed-SSN + email pass because it is
    // hand-written code whose examples carry synthetic identifiers. So the same
    // shape catches a committed SSN and does NOT model PID fields. That second
    // half is the disclosed limit of the `src` root itself, unchanged here.
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "src"), `const note = "ssn ${["123", "45", "6789"].join("-")}";\n`);
    gitIn(repo, ["add", "src"]);
    const caught = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(caught.code, `stderr: ${caught.stderr}`).toBe(1);
    expect(caught.stderr).toContain("(ssn)");

    const repo2 = makeScanRepo({ git: true });
    writeFileSync(join(repo2, "src"), msg(MSH, DIRTY_PID));
    gitIn(repo2, ["add", "src"]);
    const missed = runScannerIn(repo2, null, undefined, ["--staged"]);
    expect(missed.code, `stderr: ${missed.stderr}`).toBe(0);
  });
});

describe("phi-scan: a walk root that is not a directory refuses the scan", () => {
  it("REFUSES a root that LINKS TO A FILE, which used to exit 1 uncaught", () => {
    // `readdirSync` threw ENOTDIR straight out of the process. Node exits 1 on
    // an uncaught throw, and 1 is this contract's "hits found", so the gate
    // reported a finding it never made. A refusal is exit 2 and says why.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    symlinkSync(file, join(repo, "test"));

    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/refusing the scan/);
    expect(r.stderr).toContain("test");
    expect(r.stderr).toContain("a symbolic link");
    expect(r.stderr).toContain("not a directory");
    expect(r.stderr).not.toMatch(/ENOTDIR/);
    // The root IS the link here, so the target is the easiest thing to echo.
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("REFUSES a root that is a REGULAR FILE, and says which kind it found", () => {
    const repo = makeScanRepo({ git: true });
    rmSync(join(repo, "test"), { recursive: true, force: true });
    writeFileSync(join(repo, "test"), msg(MSH, DIRTY_PID));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("a regular file");
    expect(r.stderr).toContain("not a directory");
  });

  it("REFUSES a DANGLING link at a root, the silent half of the same shape", () => {
    // `existsSync` follows, so a dangling link answered false, the walk returned,
    // and the sweep reported OK over the whole corpus that root stands for. The
    // `observed === 0` backstop cannot see it while the other root has files.
    const repo = makeScanRepo({ git: true });
    // The OTHER root keeps files, so the sweep observes something and the
    // observed-nothing refusal cannot be what turns this red.
    writeFileSync(join(repo, "test", "extra.hl7"), msg(MSH, CLEAN_PID));
    symlinkSync(join(repo, "no-such-directory"), join(repo, "src"));
    expect(existsSync(join(repo, "src"))).toBe(false);

    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("src");
    expect(r.stderr).toContain("not a directory");
  });

  it("does NOT refuse a root that is simply ABSENT (the control that isolates it)", () => {
    // Absent and dangling are the same ENOENT and are not the same thing: a repo
    // need not have both roots, while a dangling link is a root that IS there
    // and stands for nothing. This repo has no `src/` at all and passes.
    const repo = makeScanRepo({ git: true });
    expect(existsSync(join(repo, "src"))).toBe(false);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("names EVERY bad root, not just the first, and the entries under a healthy one", () => {
    // Same rule the non-regular refusal already states: a developer who has to
    // re-run the gate once per offender learns to distrust it. A version that
    // threw on the first root named `test` and left `src` for a second run.
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    writeFileSync(join(repo, "test"), msg(MSH, DIRTY_PID));
    symlinkSync(join(repo, "no-such-directory"), join(repo, "src"));

    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/2 scan roots are not directories/);
    expect(r.stderr).toContain("test (a regular file)");
    expect(r.stderr).toContain("src (a symbolic link)");
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
    expect(existsSync(file)).toBe(true);
  });

  it("reports a bad root AND a link under the healthy one in a single refusal", () => {
    const repo = makeScanRepo({ git: true });
    const { file } = plantPayload(repo);
    symlinkSync(file, join(repo, "test", "capture.frame.bin"));
    symlinkSync(join(repo, "no-such-directory"), join(repo, "src"));

    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("src (a symbolic link)");
    expect(r.stderr).toContain("test/capture.frame.bin (a symbolic link)");
    for (const token of PLANTED_TOKENS) expect(r.stderr).not.toContain(token);
  });

  it("REFUSES with exit 2, never 1, when the allow-list itself is missing", () => {
    // The same false-finding class one layer up: `loadAllowList` threw past every
    // catch in `main`, so a missing allow-list exited 1, which means "hits
    // found". Nothing ever got past the gate, but the code said the wrong thing.
    const repo = makeScanRepo({ git: true });
    rmSync(join(repo, ALLOW_LIST_REL));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("allow-list not found");
    expect(r.stderr).not.toMatch(/at loadAllowList/);
  });

  it("still FOLLOWS a root that links to a DIRECTORY, unchanged and deliberately", () => {
    // Pre-existing and link-NEUTRAL: the tree beyond it is scanned exactly as
    // the root it replaced would have been. Pinned so that changing it is a
    // decision about repo layout, taken on purpose, and not a side effect.
    const repo = makeScanRepo({ git: true });
    const { dir: hidden } = plantPayload(repo);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    symlinkSync(hidden, join(repo, "test"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/PID-5/);
  });
});

// ---------------------------------------------------------------------------
// HL7 embedded in a TypeScript source
// ---------------------------------------------------------------------------

describe("phi-scan: HL7 embedded in a TypeScript source", () => {
  // `scan()` names the file EXPLICITLY, which bypasses the enumeration entirely.
  // That is deliberate here: it isolates the RECOGNISER half, so these tests
  // still fail if someone widens the walk and drops the extractor (or the other
  // way round), which is exactly the pair that has to move together.
  it("REPORTS a PID written into a string literal", () => {
    const r = scan(
      "embedded-pid.test.ts",
      [
        "const inbound = [",
        '  "PID|1||998877^^^HOSP^MR||MERKELSON^GWENDOLYN^Q||19571103|F|||18 Cranbrook Ter^^ALB^NY^12203",',
        '].join("\\r");',
      ].join("\n"),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("MERKELSON");
    expect(r.stderr).toContain("GWENDOLYN");
    expect(r.stderr).toMatch(/PID-7/);
    expect(r.stderr).toContain("18 Cranbrook Ter");
    expect(r.stderr).toContain("998877");
  });

  it("finds a SECOND segment behind an \\r escape inside the same literal", () => {
    const r = scan(
      "embedded-two.test.ts",
      'const raw = "MSH|^~\\\\&|S|F|R|F2|20240101||ADT^A01|1|P|2.5.1\\rPID|1||||NDIAYE^AMINATA||19640518|F\\r";\n',
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("NDIAYE");
    expect(r.stderr).toContain("AMINATA");
    expect(r.stderr).toMatch(/PID-7/);
  });

  it("resolves the \\\\& escape so MSH-2 declares the real component separator", () => {
    // Written `MSH|^~\\&|` in TS, the message HL7 sees is `MSH|^~\&|`. If the
    // extractor left the doubled backslash in, MSH-2 would read as `^~\\` and
    // the ESCAPE character would be wrong, which changes how `nameTokens`
    // strips escape sequences out of a name field.
    const r = scan(
      "embedded-msh2.test.ts",
      'const raw = "MSH|^~\\\\&|S|F|R|F2|20240101||ADT^A01|1|P|2.5.1\\rPID|1||||OKONKWO^ADAEZE\\r";\n',
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    // Componentised on `^`, so family and given come out as separate tokens.
    expect(r.stderr).toContain("OKONKWO");
    expect(r.stderr).toContain("ADAEZE");
  });

  it("does NOT read prose or identifiers as segments", () => {
    // The regression this pins: anchoring on "any non-alphanumeric delimiter"
    // matched `ack-from-hl7`, `ERR_MODULE_NOT_FOUND` and `net.createConnection`
    // and drove the unknown-segment NAME backstop over English words.
    const r = scan(
      "embedded-prose.test.ts",
      [
        'import { createConnection } from "node:net";',
        'const a = "ack-from-hl7";',
        'const b = "not-an-error-object";',
        'const c = "ERR_MODULE_NOT_FOUND";',
        'const d = "net.createConnection";',
        'const e = "Pre-aborted signal short-circuits every method";',
        'const f = "MSH-10 is echoed into MSA-2 verbatim";',
        "export const all = [a, b, c, d, e, f];",
      ].join("\n"),
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("neither guesses nor drops a ${} interpolation", () => {
    // The runtime value is unknowable, so it becomes `_`: not a letter, so no
    // name token; not a digit, so no id or DOB. A hit here would be invented and
    // a crash would be worse.
    const r = scan(
      "embedded-interp.test.ts",
      "const raw = `PID|1||${MRN}^^^HOSP^MR||${FAMILY}^${GIVEN}||${DOB}|F\\r`;\n",
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("gives a .ts source the conservative floor as well as the segment scan", () => {
    const r = scan(
      "embedded-floor.test.ts",
      'const note = "contact clinician@northgate-clinic.invalid";\n',
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/\(email\)/);
  });

  it("finds a segment on its OWN LINE of a multi-line template literal", () => {
    // The idiomatic multi-segment spelling. Without a real-newline anchor only
    // the MSH run is recovered, and `scanHl7` SKIPS header segments, so a full
    // patient identity on the following lines reported clean.
    const r = scan(
      "embedded-multiline.test.ts",
      "const inbound = `MSH|^~\\&|EPIC|HOSP|MIRTH|LAB|20240101||ADT^A01|1|P|2.5.1\n" +
        "PID|1||447281^^^HOSP^MR||HALVORSEN^INGRID^M||19620914|F|||42 Larkspur Way^^ALB^NY^12203`;\n",
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("HALVORSEN");
    expect(r.stderr).toContain("447281");
    expect(r.stderr).toContain("42 Larkspur Way");
  });

  it("does not truncate a name at an APOSTROPHE inside a double-quoted literal", () => {
    // A quote-anchored run ends only on its OWN quote. Ending on any quote cut
    // the run at the apostrophe and silently dropped every field after it.
    const r = scan(
      "embedded-apostrophe.test.ts",
      `const raw = "PID|1||||O'HALLORAN^SIOBHAN||19620914|F";\n`,
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("HALLORAN");
    expect(r.stderr).toContain("SIOBHAN");
    expect(r.stderr).toMatch(/PID-7/);
  });

  it("DOCUMENTED LIMIT: a segment written in a COMMENT is scanned like a fixture", () => {
    // The `|` narrows the ANCHOR; it does not make a recovered run trustworthy.
    // On today's corpus every recovered id happens to be a real segment id, but
    // that is an observation about the tree, not a property of the rule, and the
    // recogniser cannot tell a comment from a literal. Pinned so nobody writes
    // down the stronger claim.
    const r = scan(
      "embedded-comment-zseg.test.ts",
      'const s = "x";\n// worked example: \\rZDS|1|Kowalczyk^Bronislawa\\r\n',
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toMatch(/ZDS/);
    expect(r.stderr).toContain("Kowalczyk");
  });

  it("but ordinary English after a pipe is NOT read as a name", () => {
    // The unknown-segment backstop needs ADJACENT components each holding
    // exactly one name token, so a sentence does not trip it. This is why the
    // recovered-prose limit above is a bounded annoyance and not a gate that
    // reds on documentation.
    const r = scan(
      "embedded-prose.two.test.ts",
      'const note = "see \\rZDS|1|Kowalczyk^Bronislawa for the trailer";\n',
    );
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
  });

  it("EXEMPTS this suite, the one deliberate-violator corpus, by explicit path", () => {
    // This file carries unallowed names, DOBs, MRNs and a non-test-domain email
    // ON PURPOSE, because its positive tests assert the detectors fire on them.
    // The exemption is per-path, never per-extension: every OTHER `.ts` source
    // under `test/` is scanned, which is what the tests above rest on.
    const r = runScanner([join(REPO_ROOT, "test", "scripts", "phi-scan.test.ts")]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });
});

// ---------------------------------------------------------------------------
// The ENUMERATION half: a `.ts` source under `test/` reaches both routes
// ---------------------------------------------------------------------------

describe("phi-scan: a .ts source under test/ is enumerated by both routes", () => {
  // These are the cases that pin the ENUMERATION, not the recogniser. Every
  // other embedded-HL7 test names its file on argv, which bypasses enumeration
  // entirely, so without these two, deleting the `.ts` admission from
  // `isScannableTestFile` would leave the whole suite green.
  const LEAK = "PID|1||447281^^^HOSP^MR||HALVORSEN^INGRID^M||19620914|F";

  it("all mode REPORTS a .ts test source the walk enumerated", () => {
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "test", "leak.test.ts"), `const inbound = "${LEAK}\\r";\n`);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("test/leak.test.ts");
    expect(r.stderr).toContain("HALVORSEN");
    expect(r.stderr).toContain("447281");
  });

  it("--staged REPORTS a staged .ts test source, which is the pre-commit gate", () => {
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "test", "leak.test.ts"), `const inbound = "${LEAK}\\r";\n`);
    gitIn(repo, ["add", "test/leak.test.ts"]);
    const r = runScannerIn(repo, null, undefined, ["--staged"]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("test/leak.test.ts");
    expect(r.stderr).toContain("HALVORSEN");
  });

  it("keeps src/ on the conservative pass, which this work does not reverse", () => {
    // The same literal under `src/` must NOT earn the segment-aware scan: the
    // `@example` snippets there are illustrative and are deliberately not held
    // to it. If this ever goes red, that is a scope decision being made by
    // accident.
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(srcRoot(repo), "example.ts"), `const example = "${LEAK}\\r";\n`);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });
});

// ---------------------------------------------------------------------------
// The observed-nothing check is PER WALK ROOT
// ---------------------------------------------------------------------------

describe("phi-scan: one healthy walk root cannot vouch for an empty one", () => {
  it("REFUSES when test/ is empty and src/ is intact, naming the empty root", () => {
    // The defect: the counter was GLOBAL, so it fired only when EVERY root came
    // back empty and a healthy root masked an empty one indefinitely. A
    // denominator would not catch this, because a count counts the roots that
    // DID exist.
    const repo = makeScanRepo({ git: true });
    rmSync(join(repo, "test", "corpus.hl7"), { force: true });
    srcRoot(repo); // present, and holding a scannable file
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/observed no files under test\//);
  });

  it("REFUSES when src/ is present but holds nothing scannable", () => {
    const repo = makeScanRepo({ git: true });
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "README.md"), "# notes\n");
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/observed no files under src\//);
  });

  it("does NOT refuse for an ABSENT root, which stays legitimate", () => {
    // A repo need not have both, so the check is keyed on the roots the walk
    // actually ENTERED. `makeScanRepo` creates no `src/` at all.
    const repo = makeScanRepo({ git: true });
    expect(existsSync(join(repo, "src"))).toBe(false);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });
});

// ---------------------------------------------------------------------------
// The index corpus: the bytes git carries
// ---------------------------------------------------------------------------

/**
 * `all` mode walked `test/` and `src/` on disk and reported what it found there,
 * and NOTHING reconciled that against what git actually carries. Every state in
 * which the working tree stopped standing for the committed corpus therefore
 * printed `[phi-scan] OK, no hits` and exited 0.
 *
 * ▶ EIGHT SUCH STATES WERE MEASURED ON `6eb1615`, THE BASE COMMIT, AND ALL EIGHT
 * EXITED 0 over a payload carrying a live-shaped PID-3 / PID-5 / PID-7 / PID-11.
 * Seven are pinned below; the eighth (an EMPTY index) is pinned in the TOCTOU
 * block above, where the rule it replaced already lived.
 *
 * ▶ A PATH-SET RECONCILIATION WOULD NOT HAVE CLOSED THESE, which is why the
 * remedy reads BYTES. The first case below mirrors the tracked NAMES exactly and
 * differs only in content: every root still yields, every path still matches,
 * and only a byte comparison can tell the decoy from the corpus.
 *
 * The sweep is DETECTIVE, not preventive, on every route pinned here: it runs
 * after the write has landed in the index, and it is not a hook.
 */

/** Not in the allow-list: surname, given name, DOB, street and a bare-numeric MRN. */
const INDEX_PHI = msg(
  MSH,
  "PID|1||778899^^^HOSP^MR||Anderson^Michael||19770707|M|||42 Rowan Way^^Boston^MA^02101",
);
/** Allow-listed synthetic, byte-for-byte what `makeScanRepo` stages. */
const INDEX_CLEAN = msg(MSH, "PID|1||MRN12345^^^HOSP^MR||Doe^John^Q||19800115|M");

/** Write a file and stage it, so the INDEX carries these bytes. */
function stage(repo: string, rel: string, content: string): void {
  const abs = join(repo, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  gitIn(repo, ["add", "-f", rel]);
}

describe("phi-scan: the index corpus (the bytes git carries)", () => {
  it("REPORTS a walk root swapped for a directory MIRRORING the tracked names", () => {
    // The sharpest case, and the one a path-set reconciliation is satisfied by:
    // the decoy carries the same NAME as the tracked fixture over clean content,
    // so the root still yields and every path still matches.
    const repo = makeScanRepo({ git: true });
    stage(repo, "test/corpus.hl7", INDEX_PHI);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    mkdirSync(join(repo, "test"), { recursive: true });
    writeFileSync(join(repo, "test", "corpus.hl7"), INDEX_CLEAN);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("Anderson");
    expect(r.stderr).toContain("the working tree differs");
  });

  it("REPORTS one tracked fixture replaced on disk by a clean decoy", () => {
    const repo = makeScanRepo({ git: true });
    stage(repo, "test/phi.hl7", INDEX_PHI);
    writeFileSync(join(repo, "test", "phi.hl7"), INDEX_CLEAN);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("test/phi.hl7");
    expect(r.stderr).toContain("19770707");
  });

  it("REPORTS a tracked message under an UNDECLARED top-level directory", () => {
    // Invisible to the walk (not under a root) and to `--staged` alike (not
    // under `isUnderScanRoot`). Nothing about it is exotic: it is simply a
    // directory nobody declared.
    const repo = makeScanRepo({ git: true });
    stage(repo, "examples/data/adt.hl7", INDEX_PHI);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("examples/data/adt.hl7");
    expect(r.stderr).toContain("(git index)");
  });

  it("REPORTS a tracked file ABSENT from the working tree", () => {
    // EXISTENCE IS NOT OBSERVATION: the root still yields (corpus.hl7 is there),
    // so no starvation rule fires, and the absent file was simply never read.
    const repo = makeScanRepo({ git: true });
    stage(repo, "test/phi.hl7", INDEX_PHI);
    rmSync(join(repo, "test", "phi.hl7"), { force: true });
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("test/phi.hl7");
    expect(r.stderr).toContain("Anderson");
  });

  it("REPORTS PHI when the walk root ITSELF is a symlink to a directory of decoys", () => {
    // `statSync` and `readdirSync` both FOLLOW, so the walk reads the decoys and
    // calls the root perfectly healthy. Never restate this as "a linked root is
    // refused": it is followed, and what catches the PHI is the index corpus.
    const repo = makeScanRepo({ git: true });
    stage(repo, "test/phi.hl7", INDEX_PHI);
    mkdirSync(join(repo, "decoy"), { recursive: true });
    writeFileSync(join(repo, "decoy", "phi.hl7"), INDEX_CLEAN);
    rmSync(join(repo, "test"), { recursive: true, force: true });
    symlinkSync("decoy", join(repo, "test"));
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("Anderson");
  });

  it("REFUSES a tracked SYMLINK outside every walk root, without printing its target", () => {
    // git stores a link as its TARGET PATH under mode 120000, so there is no
    // content to scan. The target is working-tree text that can itself carry
    // PHI, which is why the refusal names the entry and its KIND only.
    const repo = makeScanRepo({ git: true });
    mkdirSync(join(repo, "hidden"), { recursive: true });
    symlinkSync("../Kowalczyk-Bronislawa-19511103.hl7", join(repo, "hidden", "capture.hl7"));
    gitIn(repo, ["add", "-f", "hidden/capture.hl7"]);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hidden/capture.hl7");
    expect(r.stderr).toContain("a symbolic link");
    expect(r.stderr).not.toContain("Kowalczyk");
  });

  it("REFUSES an UNMERGED index entry outside every walk root", () => {
    // `refuseUnmergedPaths` is scoped to `isUnderScanRoot`, so the pre-commit
    // route never saw this one. Scanning a stage is refused as the remedy:
    // neither side of a conflict is what a commit would contain.
    const repo = makeScanRepo({ git: true });
    stage(repo, "examples/m.hl7", INDEX_CLEAN);
    const write = spawnSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: repo,
      input: INDEX_PHI,
      encoding: "utf8",
      shell: false,
    });
    expect(write.status, write.stderr).toBe(0);
    const phi = write.stdout.trim();
    const clean = gitOut(repo, ["rev-parse", ":examples/m.hl7"]).trim();
    gitIn(repo, ["rm", "-q", "--cached", "examples/m.hl7"]);
    const info = spawnSync("git", ["update-index", "--index-info"], {
      cwd: repo,
      input: `100644 ${phi} 2\texamples/m.hl7\n100644 ${clean} 3\texamples/m.hl7\n`,
      encoding: "utf8",
      shell: false,
    });
    expect(info.status, info.stderr).toBe(0);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/unmerged/);
    expect(r.stderr).toContain("examples/m.hl7");
  });

  // -- Controls. Each is proved able to FAIL by mutating the route; the mutants
  // -- and which control each one kills are recorded in the changeset and the PR.

  it("REFUSES a tracked symlink named `.md`, because a NAME is no evidence about a target", () => {
    // REGRESSION, FOUND BY THE GATE. The `.md` exemption was applied before the
    // mode refusal, so a link named `.md` slipped past it: measured exit 0 "OK,
    // no hits" where the same link named `.hl7` refused at exit 2. A name
    // exemption is a judgement about bytes the route could have read, and git
    // carries a link's TARGET PATH, which is itself a PHI surface.
    const repo = makeScanRepo({ git: true });
    mkdirSync(join(repo, "hidden"), { recursive: true });
    symlinkSync("../Kowalczyk-Bronislawa-19511103.hl7", join(repo, "hidden", "notes.md"));
    gitIn(repo, ["add", "-f", "hidden/notes.md"]);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain("hidden/notes.md");
    expect(r.stderr).toContain("a symbolic link");
    expect(r.stderr).not.toContain("Kowalczyk");
  });

  it("CHARACTERIZES the tier boundary: reading an index entry is not tiering it", () => {
    // NOT A CLOSURE, A DISCLOSURE. Every index entry is READ, but which
    // detectors it earns is still `looksLikeHl7`'s decision. Outside `test/`
    // that gate wants a `.hl7`/`.bin` name, so the SAME BYTES report five
    // segment-aware hits under one name and only the SSN/email floor under
    // another. This case exists so the boundary is visible. IF IT TRIPS, IT
    // TRIPS RED ON THE SECOND HALF: `rPlain` becoming exit 1 means the tier rule
    // was WIDENED, which is a decision needing its own argument (see the
    // residual list in `phi-scan-overrides.md`), not a regression to revert on
    // sight. An earlier draft of this comment said "if it ever goes green both
    // ways", which describes a trip that cannot happen and would send the next
    // reader looking for the wrong change.
    //
    // 🛑 DO NOT COPY THIS CASE TO A SIBLING. It asserts exit 0 and "OK, no hits"
    // over live-shaped PID-3 / PID-5 / PID-7 / PID-11 bytes, which is only
    // correct where the tier rule is THIS repo's. Ported into a repo whose
    // `looksLikeHl7` admits more, it would pin a false clean.
    const named = makeScanRepo({ git: true });
    stage(named, "examples/data/capture.hl7", INDEX_PHI);
    const rNamed = runScannerIn(named, null);
    expect(rNamed.code, `stderr: ${rNamed.stderr}`).toBe(1);
    expect(rNamed.stderr).toContain("PID-5");

    const plain = makeScanRepo({ git: true });
    stage(plain, "examples/data/capture.txt", INDEX_PHI);
    const rPlain = runScannerIn(plain, null);
    expect(rPlain.code, `stderr: ${rPlain.stderr}`).toBe(0);
    expect(rPlain.stdout).toMatch(/OK, no hits/);
  });

  it("CONTROL: a clean repo whose tree and index agree exits 0", () => {
    const repo = makeScanRepo({ git: true });
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("CONTROL: a CLEAN working-tree divergence is not a finding", () => {
    // Divergence alone is not evidence. The index bytes are scanned on their own
    // merits and found clean, so the run stays green.
    const repo = makeScanRepo({ git: true });
    writeFileSync(join(repo, "test", "corpus.hl7"), `${INDEX_CLEAN}\r\n`);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(0);
    expect(r.stdout).toMatch(/OK, no hits/);
  });

  it("CONTROL: a violator in BOTH tree and index at identical bytes is reported ONCE", () => {
    // This is what proves the skip is a BYTE comparison and not a second scan.
    // Mutating it to never skip doubles this file's hits from 4 to 8.
    const repo = makeScanRepo({ git: true });
    stage(repo, "test/phi.hl7", INDEX_PHI);
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr.match(/HIT: test\/phi\.hl7/g)?.length).toBe(1);
    // Read off disk, so it carries no origin label at all.
    expect(r.stderr).not.toContain("test/phi.hl7 (git index");
  });

  it("CONTROL: an EMPTIED walk root still refuses though the index holds its files", () => {
    // The per-root rule is a statement about the WALK. Reading a root's files
    // out of the index does not discharge it.
    const repo = makeScanRepo({ git: true });
    stage(repo, "src/index.ts", "export const ok = true;\n");
    rmSync(join(repo, "src", "index.ts"), { force: true });
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/observed no files under src\//);
  });
});

// ---------------------------------------------------------------------------
// THE COMPLETENESS RULE
// ---------------------------------------------------------------------------

/**
 * A target this run ENUMERATED and never READ refuses (exit 2), in every mode,
 * naming the paths.
 *
 * WHAT THESE CASES REPRODUCE, and it is a measurement rather than a story:
 * `cosyte/config`'s drift probe invokes each sibling's scanner as
 * `phi-scan <violator> <decoy> --allow-fixture <decoy>` over a throwaway repo.
 * Both paths are ENUMERATED and the decoy is then withdrawn by a LOGGED bypass.
 * On `fd04f57` this scanner answered with its HITS code alone, which means the
 * SAME argv over a corpus whose only violator is the withdrawn file reported
 * `OK, no hits` at exit 0: a withdrawn target and a target read clean were the
 * same state by the time anything counted.
 *
 * ▶ THE MUTATION CONTROL AT THE BOTTOM IS NOT OPTIONAL. An assertion nobody has
 * seen fail is indistinguishable from one that cannot, and this whole class of
 * defect is gates that could not go red. It removes the ONE line the rule is,
 * asserts the removal landed (so it cannot go vacuous if the line is reworded),
 * and proves the graded run falls back to exit 1.
 */

/** The override-log shape `loadOverrideLog` honours, for paths in a temp repo. */
function overrideLog(rels: string[]): string {
  const entries = rels
    .map(
      (p) =>
        `\n### ${p}\n\n- **Date:** 2026-08-11\n- **Reason:** unit test\n` +
        `- **Approved by:** vitest\n- **Expires:** permanent\n`,
    )
    .join("");
  return `# PHI scan overrides\n\n## Entries\n${entries}`;
}

const VIOLATOR_REL = "test/probe-violator.hl7";
const DECOY_REL = "test/probe-decoy.hl7";

/**
 * `makeScanRepo`, plus a violator and a clean decoy under `test/`, and an
 * override log that logs both. Everything is TRACKED, so no case here can be
 * answered by the tolerated-vanish exemption by accident.
 */
function makeCompletenessRepo(): string {
  const repo = makeScanRepo({ git: true });
  stage(repo, VIOLATOR_REL, INDEX_PHI);
  stage(repo, DECOY_REL, INDEX_CLEAN);
  writeFileSync(join(repo, "phi-scan-overrides.md"), overrideLog([VIOLATOR_REL, DECOY_REL]));
  return repo;
}

describe("phi-scan: the completeness rule", () => {
  it("REFUSES the drift probe's graded run, and still prints the violator's hits", () => {
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, [
      VIOLATOR_REL,
      DECOY_REL,
      "--allow-fixture",
      DECOY_REL,
    ]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/1 target was enumerated and never read/);
    expect(r.stderr).toContain(DECOY_REL);
    // A REFUSAL MUST NOT SWALLOW A REAL HIT: the violator WAS read, and what it
    // carried is work a human still has to act on.
    expect(r.stderr).toContain("PID-5");
    // ...and the clean line can never appear beside a refusal.
    expect(r.stdout).not.toMatch(/OK, no hits/);
  });

  it("REFUSES the corpus whose ONLY violator is withdrawn (was exit 0)", () => {
    // The headline defect. Under the old shape this argv printed `OK, no hits`
    // and exited 0 over a tracked file carrying live-shaped PID values.
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, [
      DECOY_REL,
      VIOLATOR_REL,
      "--allow-fixture",
      VIOLATOR_REL,
    ]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/enumerated and never read/);
    expect(r.stderr).toContain(VIOLATOR_REL);
    expect(r.stdout).not.toMatch(/OK, no hits/);
  });

  it("ADMITS a bypass named beside a positional path, which used to be a silent no-op", () => {
    // The seed read `paths.length > 0 ? paths : [...allowFixtures]`, so the flag
    // became a target ONLY when no positional was given. With one present the
    // violator was neither read nor mentioned and the run exited 0 on the decoy
    // alone. The union admits it, and the rule then refuses over it.
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, [DECOY_REL, "--allow-fixture", VIOLATOR_REL]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toContain(VIOLATOR_REL);
    // The decoy was genuinely READ, so it is not in the unread list.
    expect(r.stderr).not.toContain(DECOY_REL);
  });

  it("REFUSES a lone bypass, which reads to a caller like a full-corpus sweep", () => {
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, ["--allow-fixture", VIOLATOR_REL]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/enumerated and never read/);
    expect(r.stderr).toContain(VIOLATOR_REL);
  });

  it("NAMES EVERY withdrawn target in one refusal, never just the first", () => {
    // A developer who has to re-run a gate to be told the second finding learns
    // to distrust it, which is the same reason `unscannableBlock` names them
    // all. It is also what a SIZE comparison could not do.
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, [
      "test/corpus.hl7",
      "--allow-fixture",
      VIOLATOR_REL,
      "--allow-fixture",
      DECOY_REL,
    ]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/2 targets were enumerated and never read/);
    expect(r.stderr).toContain(VIOLATOR_REL);
    expect(r.stderr).toContain(DECOY_REL);
  });

  it("REFUSES a bypass naming a path this run does not enumerate", () => {
    // The other half of the same claim, and a DIFFERENT one: such a flag
    // subtracts nothing, so honouring it silently lets a developer believe a
    // file was acknowledged when the run never had it in scope. `--staged` is
    // the sharp mode for it, because a committed file is not staged.
    const repo = makeCompletenessRepo();
    gitIn(repo, ["-c", "user.email=t@e.com", "-c", "user.name=t", "commit", "-qm", "corpus"]);
    const r = runScannerIn(repo, null, undefined, ["--staged", "--allow-fixture", VIOLATOR_REL]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/does not enumerate, so the flag subtracts nothing/);
    expect(r.stderr).toContain(VIOLATOR_REL);
  });

  it("CONTROL: the same corpus with no bypass at all reports honestly", () => {
    // Anti-vacuity. Without the flag nothing is withdrawn, so the run reaches a
    // verdict rather than a refusal, and the verdict is the violator's hits.
    const repo = makeCompletenessRepo();
    const r = runScannerIn(repo, null, undefined, [VIOLATOR_REL, DECOY_REL]);
    expect(r.code, `stderr: ${r.stderr}`).toBe(1);
    expect(r.stderr).not.toMatch(/enumerated and never read/);
    const clean = runScannerIn(repo, null, undefined, [DECOY_REL]);
    expect(clean.code, `stderr: ${clean.stderr}`).toBe(0);
    expect(clean.stdout).toMatch(/OK, no hits/);
  });

  it("MUTATION CONTROL: removing the rule's one line drops the graded run back to exit 1", () => {
    // AN ASSERTION NOBODY HAS SEEN FAIL IS INDISTINGUISHABLE FROM ONE THAT
    // CANNOT. This is the positive control for every case above: with the set
    // difference replaced by an empty list, the graded run answers with the
    // HITS code, which is exactly the state `cosyte/config`'s drift probe
    // reports as drift.
    const RULE_LINE =
      "const unread = [...enumerated].filter((p) => !read.has(p) && !tolerated.has(p)).sort();";
    const source = readFileSync(SCANNER_PATH, "utf8");
    // The control cannot go vacuous if the line is reworded: assert it is there,
    // and assert the substitution landed, before trusting the run below.
    expect(source).toContain(RULE_LINE);
    const mutated = source.replace(RULE_LINE, "const unread: string[] = [];");
    expect(mutated).not.toContain(RULE_LINE);

    const mutantDir = tempDir("mllp-phi-mutant-");
    const mutantPath = join(mutantDir, "phi-scan.ts");
    writeFileSync(mutantPath, mutated);

    const repo = makeCompletenessRepo();
    const r = spawnSync(
      NODE_BIN,
      [mutantPath, VIOLATOR_REL, DECOY_REL, "--allow-fixture", DECOY_REL],
      { cwd: repo, encoding: "utf8", shell: false },
    );
    expect(r.status, `stderr: ${r.stderr ?? ""}`).toBe(1);
    expect(r.stderr ?? "").not.toMatch(/enumerated and never read/);
  });
});
