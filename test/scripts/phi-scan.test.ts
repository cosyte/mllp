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

/** A `git` that runs `pre` (a line of `sh`) before delegating to the real git. */
function gitShim(pre: string): string {
  const shimDir = tempDir("mllp-phi-shim-");
  writeFileSync(join(shimDir, "git"), `#!/bin/sh\n${pre}\nexec '${realGit()}' "$@"\n`, {
    mode: 0o755,
  });
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

  it("REFUSES the tolerance outright when git cannot say what is tracked", () => {
    // Fail closed: with no tracked set there is no way to tell a transient from
    // committed content, so nothing is tolerated.
    const repo = makeScanRepo({ git: false });
    const decoy = writeTransient(repo);
    const r = runScannerIn(repo, gitShim(`rm -f '${decoy}'`), {
      GIT_CEILING_DIRECTORIES: tmpdir(),
    });
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/could not read/);
  });

  it("REFUSES the tolerance when git answers with an EMPTY tracked set", () => {
    // A removed `.git/index` makes `git ls-files` exit 0 with NO output, which
    // would make every file untracked, the one state in which the tracked-file
    // bound stops existing. An empty answer therefore counts as no answer. (A
    // CORRUPT index exits 128 and was always caught by the `catch`.)
    const repo = makeScanRepo({ git: true, track: false });
    const decoy = writeTransient(repo);
    const r = runScannerIn(repo, gitShim(`rm -f '${decoy}'`));
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/could not read/);
  });

  it("REFUSES an all-mode sweep that observed no files", () => {
    // The refuse-a-scan-that-observes-nothing rule, now explicit: tolerating a
    // vanished file must never be able to decay into a clean report of nothing.
    // Nothing tracked and everything ignored, so the walk finds files and the
    // filters leave zero targets. (`git check-ignore` never reports a TRACKED
    // path as ignored, which is why the corpus fixture is left unstaged here.)
    const repo = makeScanRepo({ git: true, track: false });
    writeFileSync(join(repo, ".gitignore"), "*\n");
    const r = runScannerIn(repo, null);
    expect(r.code, `stderr: ${r.stderr}`).toBe(2);
    expect(r.stderr).toMatch(/observed no files/);
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
    // `.ts` under test/ and `.md` anywhere are excluded from the READ set,
    // because of what such a file's bytes are. A link's name is no evidence at
    // all about the other side, so the name exemptions must not carry over.
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
 *     staged as `R051` and exited 0 over live PID-5 / PID-7 / PID-3;
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
