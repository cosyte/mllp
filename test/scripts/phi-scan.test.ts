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
} from "node:fs";
import { join, relative, sep } from "node:path";
import { tmpdir } from "node:os";

const REPO_ROOT = process.cwd();
const SCANNER_PATH = join(REPO_ROOT, "scripts", "phi-scan.ts");
const OVERRIDES_PATH = join(REPO_ROOT, "phi-scan-overrides.md");
const ALLOW_LIST_REL = join("scripts", "phi-allow-list.txt");
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
): RunResult {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extraEnv };
  if (shimDir !== null) env["PATH"] = `${shimDir}:${process.env["PATH"] ?? ""}`;
  const r = spawnSync(TSX_BIN, [SCANNER_PATH], { cwd, encoding: "utf8", shell: false, env });
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
