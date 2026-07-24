#!/usr/bin/env tsx
/**
 * `@cosyte/mllp` PHI scanner, the CI / pre-commit half of the PHI commit-gate.
 *
 * Pure Node. Zero runtime deps. Walks the synthetic HL7/MLLP data fixtures under
 * `test/` (and a conservative text pass over `src/`) and REFUSES anything that
 * looks like real PHI, so a developer cannot commit a real-looking fixture by
 * accident.
 *
 * mllp is a TRANSPORT / framing library: it wraps HL7 v2 messages in MLLP frames
 * (`VT 0x0B + payload + FS 0x1C + CR 0x0D`). Its data fixtures are therefore
 * MLLP-framed HL7 v2 messages (the `.frame.bin` fixtures), and HL7 v2 carries PHI by
 * design (patient names, dates of birth, SSNs, MRNs / account numbers,
 * addresses, phones / emails, and free-text observations). The PHI shapes inside
 * a framed message are IDENTICAL to `@cosyte/hl7`'s, so this scanner is a direct
 * port of hl7's segment/field-position-aware detector, with ONE transport-layer
 * addition: it **unwraps the MLLP frame** (strips the `VT` start-block and the
 * trailing `FS CR` end-block) BEFORE the HL7-aware scan, so the framing bytes
 * cannot defeat delimiter/segment detection. A framed fixture's HL7 payload gets
 * exactly the scan an un-framed `.hl7` file would (see `unwrapMllpFrame`).
 *
 * A framed binary fixture is byte-strict at the front (the VT start-block, then
 * the `MSH` / batch `FHS` / `BHS` segment), so an inline `# synthetic: true`
 * header is impossible, it would break every framing test. This is the same
 * constraint DICOM hits with binary `.dcm` files and X12 with `.edi`, and we
 * solve it the same proven way: a **synthetic allow-list**
 * (`scripts/phi-allow-list.txt`) is the positive declaration that a fixture's
 * identifiers are fake. Any realistic-PHI-shaped token not covered by the
 * allow-list is a hit. Adding a new synthetic fixture therefore means either
 * reusing known-synthetic tokens or consciously extending the allow-list, a
 * reviewed act, never silent.
 *
 * Detection is HL7-shape-aware, NOT a blind text regex: the scanner parses each
 * message's delimiters (from `MSH-1` / `MSH-2`), splits segments → fields →
 * repetitions → components, and inspects only the fields that actually carry
 * each PHI category. That is deliberate, a naive `Family^Given` text scan trips
 * on coded values like `CBC^Complete Blood Count^LN` or `Boston^MA`, giving
 * false confidence. See `phi-scan-overrides.md` for the category → field map and
 * the documented limitations.
 *
 * A non-HL7 binary fixture (a byte/buffer fixture that is not a framed HL7
 * message) is handled safely: it never matches the fixture-like + segment-line
 * gate, so it falls through to the conservative shape pass (dashed-SSN + email)
 * no crash (exit 2), no false positive from binary noise.
 *
 * SECURITY: every subprocess is `git`, invoked via `execFileSync` with array
 * args only. Never shell-form spawn.
 *
 * Modes:
 *   --staged                 - scan only files staged in `git diff --cached`
 *   --allow-fixture <path>   - bypass one path; rejected unless logged in
 *                              phi-scan-overrides.md
 *   <path> [<path>...]       - scan specific paths
 *   (no args)                - scan all in-scope working-tree files
 *
 * Exit codes: 0 (clean), 1 (hits found), 2 (invocation error).
 */

import { readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve, relative, sep, isAbsolute } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const REPO_ROOT = process.cwd();
const ALLOW_LIST_PATH = join(REPO_ROOT, "scripts", "phi-allow-list.txt");
const OVERRIDE_LOG_PATH = join(REPO_ROOT, "phi-scan-overrides.md");

// Roots walked in "all" mode. From `test/` we take EVERY data file except `.ts`
// sources (see `isScannableTestFile`); each is then dispatched by `looksLikeHl7`
// to the structured HL7 scan or the conservative pass. `src/` gets a conservative
// dashed-SSN + email text pass, it is hand-written code, and its JSDoc
// `@example` HL7 snippets carry synthetic names/MRNs that must not trip the
// segment-aware detectors. A committed real SSN/email in code is caught there.
const TEST_ROOT = join(REPO_ROOT, "test");
const SRC_ROOT = join(REPO_ROOT, "src");

// Which `test/` files get swept: EVERY data file under `test/` EXCEPT `.ts`
// sources (and `.md` docs). `.ts` sources are excluded because, like this
// scanner's own `test/scripts/phi-scan.test.ts`, they carry intentional
// violator literals for the positive tests, so sweeping them is self-defeating.
// Everything else (a framed `.frame.bin`, a bare `.hl7`, a `.txt` / `.json` /
// extensionless live-adapter capture, a byte/buffer fixture) is KEPT and then
// dispatched by `looksLikeHl7`: an HL7 payload (framed or not) gets the full
// structured scan, a non-HL7 blob gets the conservative dashed-SSN + email pass.
// The filter must EXCLUDE .ts, never RESTRICT to a fixed extension allow-list,
// restricting silently dropped `.txt` / extensionless captures from any scan at
// all (the directory `test/differential/fixtures/README.md` tells developers to
// drop real captures into), which is precisely the false negative this gate
// exists to stop.
function isScannableTestFile(relPath: string): boolean {
  return relPath.startsWith("test/") && !relPath.endsWith(".ts") && !relPath.endsWith(".md");
}

// Person-name fields keyed by segment id. XPN fields carry family in component 1
// (`Doe^John`); XCN fields carry an id in component 1 and the family/given in
// components 2/3 (`ATTEND^Smith^Jane`). The distinction is load-bearing, read
// the wrong components and every provider name slips through.
const XPN_NAME_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [5, 6, 9], // patient name / mother's maiden name / alias
  NK1: [2, 30], // next-of-kin name / contact person name
  GT1: [3], // guarantor name
  IN1: [16], // insured's name
  MRG: [7], // prior patient name
  STF: [3], // staff name
};
const XCN_NAME_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PV1: [7, 8, 9, 17, 52], // attending / referring / consulting / admitting / other provider
  PD1: [4], // patient primary care provider
  ORC: [10, 11, 12, 19], // entered by / verified by / ordering provider / action by
  OBR: [10, 16, 28, 32, 33, 34, 35], // collector / ordering provider / copies-to / interpreters
  OBX: [16, 25], // responsible observer / performing org medical director
  DG1: [16], // diagnosing clinician
  PR1: [11], // procedure practitioner
  AIP: [3], // scheduled personnel
  TXA: [9, 10, 11], // originator / assigned authenticator / transcriptionist
  ROL: [4], // role person
};

const DOB_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [7], // patient date of birth
  NK1: [16], // next-of-kin date of birth
};
const ADDRESS_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [11], // patient address
  NK1: [4], // next-of-kin address
  GT1: [5], // guarantor address
  IN1: [19], // insured's address
};
const PHONE_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [13, 14], // home / business phone
  NK1: [5, 6, 7], // phone / business phone / contact phone
  GT1: [6, 7], // guarantor phone
};
// CX identifier lists (MRN / account / SSN-typed). Component 1 is the id, the
// 5th component is the CX identifier-type-code (`MR` / `AN` / `SS` / `SSN`).
const CX_ID_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [3, 18], // patient identifier list / account number
};
// Plain SSN fields (HL7 type ST, a bare number, not a CX list).
const SSN_ST_FIELDS: Readonly<Record<string, readonly number[]>> = {
  PID: [19], // SSN number - patient
};

// Name tokens that are HL7 name-type / degree / suffix / prefix codes, never a
// person's identifying name, extracted alongside real name tokens and skipped.
const NAME_NOISE_TOKENS = new Set<string>([
  "MD",
  "DO",
  "DR",
  "MR",
  "MRS",
  "MS",
  "JR",
  "SR",
  "II",
  "III",
  "IV",
  "RN",
  "NP",
  "PA",
  "PHD",
  "DDS",
  "DMD",
  "ESQ",
  "PROF",
  "FNP",
  "APRN",
]);

// Standard HL7 v2 segment ids. A segment id NOT in this set (a `Z…` site-defined
// segment, or anything unrecognized) has no known field schema, so it gets the
// unknown-segment name backstop rather than the precise field map. Mirrors
// `@cosyte/hl7`'s parser source of truth.
const KNOWN_SEGMENTS = new Set<string>([
  "MSH",
  "MSA",
  "EVN",
  "ERR",
  "SFT",
  "PID",
  "PD1",
  "MRG",
  "PV1",
  "PV2",
  "PDA",
  "PDC",
  "PEO",
  "DB1",
  "NK1",
  "GT1",
  "IN1",
  "IN2",
  "IN3",
  "ACC",
  "AL1",
  "DG1",
  "PRB",
  "IAM",
  "FAM",
  "GOL",
  "PR1",
  "OBR",
  "OBX",
  "ORC",
  "SPM",
  "TQ1",
  "TQ2",
  "NTE",
  "UB1",
  "UB2",
  "FT1",
  "RXA",
  "RXC",
  "RXD",
  "RXE",
  "RXG",
  "RXO",
  "RXR",
  "RXV",
  "SCH",
  "AIG",
  "AIL",
  "AIP",
  "AIS",
  "ARQ",
  "APR",
  "RGS",
  "TXA",
  "MFE",
  "MFI",
  "MFA",
  "MCP",
  "LDP",
  "LCH",
  "LOC",
  "LRL",
  "LCC",
  "ROL",
  "STF",
  "PRA",
  "EDU",
  "CER",
  "CTD",
  "CTI",
  "ORG",
  "PRC",
  "PRD",
  "QAK",
  "QPD",
  "QRF",
  "QRI",
  "QID",
  "RDF",
  "RDT",
  "DSC",
  "DSP",
  "EQL",
  "OMC",
  "FHS",
  "BHS",
  "BTS",
  "FTS",
  "CSR",
  "CSP",
  "CSS",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Hit {
  path: string;
  segment: string; // segment id + field (e.g. "PID-5") or "(text)"
  value: string;
  reason: string;
}

interface AllowList {
  /** Uppercase synthetic person-name tokens (XPN / XCN name components). */
  names: Set<string>;
  /** Synthetic dates of birth, normalized (YYYYMMDD or a bare YYYY year). */
  dobs: Set<string>;
  /** Synthetic street-address lines (XAD component 1), lower-cased. */
  addresses: Set<string>;
  /** Synthetic id values that legitimately match an SSN / bare-MRN shape. */
  ids: Set<string>;
  /** Allowed email domains (anything else is a hit). */
  emailDomains: Set<string>;
}

interface Delimiters {
  field: string;
  component: string;
  repetition: string;
  escape: string;
}

interface Args {
  mode: "all" | "staged" | "paths";
  paths: string[];
  allowFixtures: string[];
}

class InvocationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvocationError";
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): Args {
  let staged = false;
  const paths: string[] = [];
  const allowFixtures: string[] = [];
  let i = 0;
  while (i < argv.length) {
    const a = argv[i];
    if (a === "--") {
      for (let j = i + 1; j < argv.length; j += 1) {
        const v = argv[j];
        if (v !== undefined) paths.push(v);
      }
      break;
    } else if (a === "--staged") {
      staged = true;
      i += 1;
    } else if (a === "--allow-fixture") {
      const next = argv[i + 1];
      if (next === undefined) {
        throw new InvocationError("--allow-fixture requires a path argument");
      }
      allowFixtures.push(next);
      i += 2;
    } else if (a !== undefined && a.startsWith("--")) {
      throw new InvocationError(`Unknown flag: ${a}`);
    } else if (a !== undefined) {
      paths.push(a);
      i += 1;
    } else {
      i += 1;
    }
  }

  if (staged && paths.length > 0) {
    throw new InvocationError("--staged cannot be combined with positional paths");
  }

  // An `--allow-fixture` path is a *subtractive* acknowledgement on a broader
  // scan, never a scan target on its own, so it also seeds the positional path
  // set. That makes `--allow-fixture X` mean "scan X, but allow it" (proving the
  // override gate actually subtracts a scanned target) instead of a silent no-op.
  const scanPaths = paths.length > 0 ? paths : [...allowFixtures];

  let mode: Args["mode"];
  if (staged) {
    mode = "staged";
  } else if (scanPaths.length > 0) {
    mode = "paths";
  } else {
    mode = "all";
  }
  return { mode, paths: scanPaths, allowFixtures };
}

// ---------------------------------------------------------------------------
// Allow-list + override log
// ---------------------------------------------------------------------------

function loadAllowList(): AllowList {
  if (!existsSync(ALLOW_LIST_PATH)) {
    throw new InvocationError(`allow-list not found at ${ALLOW_LIST_PATH}`);
  }
  const raw = readFileSync(ALLOW_LIST_PATH, "utf8");
  const names = new Set<string>();
  const dobs = new Set<string>();
  const addresses = new Set<string>();
  const ids = new Set<string>();
  const emailDomains = new Set<string>();
  for (const lineRaw of raw.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const sp = line.indexOf(" ");
    if (sp < 0) continue;
    const tag = line.slice(0, sp);
    const value = line.slice(sp + 1).trim();
    if (value.length === 0) continue;
    switch (tag) {
      case "NAME":
        names.add(value.toUpperCase());
        break;
      case "DOB":
        dobs.add(value);
        break;
      case "ADDR":
        addresses.add(value.toLowerCase());
        break;
      case "ID":
        ids.add(value.toUpperCase());
        break;
      case "EMAILDOMAIN":
        emailDomains.add(value.toLowerCase());
        break;
      default:
        break;
    }
  }
  return { names, dobs, addresses, ids, emailDomains };
}

function normalizePath(p: string): string {
  const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
  const rel = relative(REPO_ROOT, abs);
  return rel.split(sep).join("/");
}

function loadOverrideLog(): Set<string> {
  if (!existsSync(OVERRIDE_LOG_PATH)) return new Set();
  const raw = readFileSync(OVERRIDE_LOG_PATH, "utf8");
  const out = new Set<string>();
  // Skip fenced code blocks, the doc's own "Format" example shows a literal
  // `### <path>` template that is NOT a real entry. Only `###` headings in prose
  // are override entries.
  let inFence = false;
  for (const lineRaw of raw.split(/\r?\n/)) {
    if (/^\s*```/.test(lineRaw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = /^###\s+(.+?)\s*$/.exec(lineRaw);
    if (m && m[1] !== undefined) out.add(normalizePath(m[1]));
  }
  return out;
}

function validateAllowFixtures(allowFixtures: string[]): void {
  if (allowFixtures.length === 0) return;
  const overrides = loadOverrideLog();
  const missing = allowFixtures.map(normalizePath).filter((p) => !overrides.has(p));
  if (missing.length > 0) {
    const lines = missing.map((p) => `  - ${p}`).join("\n");
    throw new InvocationError(
      `--allow-fixture rejected: no matching entry in phi-scan-overrides.md for:\n${lines}\n` +
        `Add a "### <path>" subsection to phi-scan-overrides.md and commit it.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Target enumeration
// ---------------------------------------------------------------------------

interface Target {
  path: string; // forward-slash repo-relative path for reporting
  read: () => Buffer;
}

function walk(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile()) {
      // README/markdown docs may legitimately describe violator values; they
      // are documentation, not fixtures.
      if (e.name.toLowerCase().endsWith(".md")) continue;
      out.push(full);
    }
  }
}

function gitIgnored(paths: string[]): Set<string> {
  const ignored = new Set<string>();
  if (paths.length === 0) return ignored;
  try {
    // SECURITY: array-form execFileSync, no shell. Default (Buffer) encoding,
    // `encoding: "buffer"` with `input` is rejected by Node.
    const out = execFileSync("git", ["check-ignore", "--stdin", "-z"], {
      input: paths.map(normalizePath).join("\0"),
      stdio: ["pipe", "pipe", "ignore"],
    });
    for (const p of out.toString("utf8").split("\0")) {
      if (p.length > 0) ignored.add(p);
    }
  } catch {
    // `git check-ignore` exits 1 when nothing matches, treat as none ignored.
  }
  return ignored;
}

function buildTargetsForAll(): Target[] {
  const testFiles: string[] = [];
  walk(TEST_ROOT, testFiles);
  const srcFiles: string[] = [];
  walk(SRC_ROOT, srcFiles);
  // From test/, keep every data file except .ts sources (dispatched to
  // structured-or-conservative by looksLikeHl7). From src/, keep everything
  // walk() surfaced (hand-written code → conservative pass).
  const files = [
    ...testFiles.filter((abs) => isScannableTestFile(normalizePath(abs))),
    ...srcFiles,
  ];
  const ignored = gitIgnored(files);
  return files
    .filter((abs) => !ignored.has(normalizePath(abs)))
    .map((abs) => ({ path: normalizePath(abs), read: () => readFileSync(abs) }));
}

function buildTargetsForPaths(paths: string[]): Target[] {
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
    if (!existsSync(abs)) throw new InvocationError(`File not found: ${p}`);
    if (!statSync(abs).isFile()) throw new InvocationError(`Not a regular file: ${p}`);
    return { path: normalizePath(abs), read: () => readFileSync(abs) };
  });
}

function buildTargetsForStaged(): Target[] {
  let listBuf: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell.
    listBuf = execFileSync("git", ["diff", "--cached", "--name-only", "--diff-filter=AM", "-z"], {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    throw new InvocationError(
      `git diff --cached failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const list = listBuf
    .toString("utf8")
    .split("\0")
    .filter((p) => p.length > 0)
    // Scan the same in-scope set all-mode walks: every test/ data file except
    // .ts sources (they carry deliberate violator literals), plus src/ code.
    .filter((p) => isScannableTestFile(p) || (p.startsWith("src/") && !p.endsWith(".md")));
  return list.map((relPath) => ({
    path: relPath,
    // SECURITY: array-form execFileSync, no shell. `:<path>` is a git pathspec.
    read: (): Buffer =>
      execFileSync("git", ["show", `:${relPath}`], {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      }),
  }));
}

// ---------------------------------------------------------------------------
// MLLP frame + HL7 v2 structural helpers
// ---------------------------------------------------------------------------

/**
 * Unwrap an MLLP frame so the HL7 header segment is at the front of the payload.
 *
 * MLLP Release 1 framing is `VT (0x0B) + payload + FS (0x1C) + CR (0x0D)`. The
 * scanner strips a BOM, then ALL leading `VT` start-block bytes (double-framing
 * probe: two leading `VT`s), then a trailing `FS` end-block (optionally followed
 * by `CR` and/or `LF`). A frame with a MISSING end-block (`VT + payload`, no
 * `FS CR`) still has its `VT` removed and its payload scanned, the unwrap only
 * ever REMOVES framing bytes, never gates the scan on their presence, so no
 * malformed frame can bypass detection. Any residual mid-payload `FS`/`VT` byte
 * is harmless: `splitSegments` splits on `CR`/`LF`, so it can only cling to one
 * field of one segment while every other field is still scanned. Un-framed
 * fixtures (a bare `.hl7` file) pass through unchanged.
 */
function unwrapMllpFrame(text: string): string {
  return text
    .replace(/^\uFEFF/, "") // BOM
    .replace(/^\u000b+/, "") // MLLP VT start-block(s)
    .replace(/\u001c\r?\n?$/, ""); // MLLP FS end-block (+ optional CR/LF)
}

// A line is a segment when it starts with a 3-char id (letters+digits, HL7
// allows a leading letter) followed by a delimiter, not a letter/digit/space.
// Case-insensitive: the parser is lenient about segment case (lowercase `pid`),
// so the scanner must be too, or a mixed-case feed silently bypasses detection.
const SEGMENT_LINE_RE = /^([A-Za-z][A-Za-z0-9]{2})([^A-Za-z0-9\s])/;

/** The header segment line (MSH / FHS / BHS), if the message has one. */
function findHeaderLine(text: string): string | undefined {
  for (const raw of unwrapMllpFrame(text).split(/\r\n|\r|\n/)) {
    const line = raw.replace(/^[\s]*/, "");
    const m = SEGMENT_LINE_RE.exec(line);
    if (m && m[1] !== undefined) {
      const id = m[1].toUpperCase();
      if (id === "MSH" || id === "FHS" || id === "BHS") return line;
    }
  }
  return undefined;
}

/**
 * A file gets the full structured HL7 scan only when it is fixture-like AND
 * contains at least one recognizable segment line after MLLP unwrap. Fixture-like
 * means: a `.hl7` file, a `.bin` frame, OR ANY data file under `test/` (which is
 * exactly the set `isScannableTestFile` admits, minus `.ts` sources, a live
 * capture the differential README says to drop here may arrive as `.txt` /
 * `.json` / extensionless, and must still earn the structured scan, not just the
 * conservative shape pass). The gate is load-bearing in BOTH directions:
 *   - it lets a header-less message still get the full structured scan rather
 *     than the text-only pass (a fixture whose first segment is not MSH); and
 *   - it keeps hand-written `src/` code (and any `.ts` file passed explicitly) on
 *     the conservative pass even when it embeds an `MSH|…` example string,
 *     parsing a `.ts` file as HL7 segments produces only noise.
 * A fixture-like file with NO recognizable segment line (a genuinely non-HL7
 * binary blob) falls through to the conservative dashed-SSN + email pass; so does
 * anything not fixture-like (src code, plain text outside test/).
 */
function looksLikeHl7(text: string, path: string): boolean {
  const isFixtureLike =
    path.endsWith(".hl7") ||
    path.endsWith(".bin") ||
    (path.startsWith("test/") && !path.endsWith(".ts") && !path.endsWith(".md"));
  if (!isFixtureLike) return false;
  if (findHeaderLine(text) !== undefined) return true;
  return unwrapMllpFrame(text)
    .split(/\r\n|\r|\n/)
    .some((raw) => SEGMENT_LINE_RE.test(raw.replace(/^[\s]*/, "")));
}

/**
 * Resolve the message delimiters from the header segment. `MSH-1` is the
 * character immediately after the 3-char id; `MSH-2` (the encoding characters)
 * supplies component / repetition / escape. A header-less message has no
 * encoding declaration, so the HL7 defaults (`|^~\&`) apply.
 */
function detectDelimiters(text: string): Delimiters {
  const header = findHeaderLine(text);
  if (header === undefined) {
    return { field: "|", component: "^", repetition: "~", escape: "\\" };
  }
  const field = header.charAt(3) || "|";
  // Encoding chars run from index 4 up to the next field separator.
  let enc = "";
  for (let i = 4; i < header.length && header.charAt(i) !== field; i += 1) enc += header.charAt(i);
  return {
    field,
    component: enc.charAt(0) || "^",
    repetition: enc.charAt(1) || "~",
    escape: enc.charAt(2) || "\\",
  };
}

/** Split a raw message into segment field-arrays (index 0 = segment id). */
function splitSegments(text: string, d: Delimiters): string[][] {
  return unwrapMllpFrame(text)
    .split(/\r\n|\r|\n/)
    .map((s) => s.trimEnd())
    .filter((s) => s.length > 0)
    .map((s) => s.split(d.field));
}

/** Field N of a segment (1-indexed HL7 field position, non-MSH offset). */
function fieldAt(elems: string[], n: number): string {
  return elems[n] ?? "";
}

/** Escape-aware, unicode-aware name tokenizer. */
function nameTokens(value: string, d: Delimiters): string[] {
  // Drop HL7 escape sequences (\F\ \S\ \T\ \R\ \E\ \Xhh\ \Zxx\ …), they are
  // delimiter placeholders, not name characters.
  const esc = d.escape.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const noEsc = value.replace(new RegExp(`${esc}[^${esc}]*${esc}`, "g"), " ");
  const out: string[] = [];
  for (const raw of noEsc.split(/[^\p{L}]+/u)) {
    if (raw.length === 0) continue;
    if (!/\p{L}/u.test(raw)) continue;
    // A single Latin letter is a middle initial, not identifying. A single CJK
    // ideograph / kana / hangul IS a name (Chinese/Korean surnames are 1 char),
    // so keep those.
    const isCjk = /[぀-ヿ㐀-鿿가-힯]/u.test(raw);
    if (raw.length < 2 && !isCjk) continue;
    out.push(raw);
  }
  return out;
}

function isNameToken(tok: string): boolean {
  if (NAME_NOISE_TOKENS.has(tok.toUpperCase())) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Category detectors (segment + field-position aware)
// ---------------------------------------------------------------------------

function checkNameField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  familyIdx: number,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  if (value.length === 0) return;
  for (const rep of value.split(d.repetition)) {
    const comps = rep.split(d.component);
    // Inspect family / given / middle relative to the type's family index.
    for (const off of [0, 1, 2]) {
      const comp = comps[familyIdx + off];
      if (comp === undefined || comp.length === 0) continue;
      for (const tok of nameTokens(comp, d)) {
        if (!isNameToken(tok)) continue;
        if (!allow.names.has(tok.toUpperCase())) {
          hits.push({
            path,
            segment: `${segId}-${String(fieldNo)}`,
            value: tok,
            reason: "person-name token not in synthetic allow-list",
          });
        }
      }
    }
  }
}

function normalizeDob(value: string): string | null {
  const digits = value.replace(/\D/g, "");
  if (digits.length >= 8) {
    const d = digits.slice(0, 8);
    const month = Number(d.slice(4, 6));
    const day = Number(d.slice(6, 8));
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return d;
  }
  if (/^\d{6}$/.test(digits)) {
    // YYYYMM month-precision DTM (a valid HL7 partial DOB).
    const month = Number(digits.slice(4, 6));
    if (month < 1 || month > 12) return null;
    return digits;
  }
  if (/^\d{4}$/.test(digits)) return digits; // year-only precision
  return null;
}

function checkDobField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const dob = normalizeDob(rep.split(d.component)[0] ?? rep);
    if (dob === null) continue;
    if (!allow.dobs.has(dob)) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: dob,
        reason: "date of birth not in synthetic allow-list",
      });
    }
  }
}

function checkAddressField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const street = (rep.split(d.component)[0] ?? "").trim();
    // A street line: house number + at least one word (`123 Main St`).
    if (!/^\d+\s+\p{L}/u.test(street)) continue;
    if (!allow.addresses.has(street.toLowerCase())) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: street,
        reason: "street address not in synthetic allow-list",
      });
    }
  }
}

function checkPhoneField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const digits = rep.replace(/\D/g, "");
    // A real dialable number is >= 10 digits. The `555` fake-exchange
    // convention (555-01xx is reserved for fiction) marks a synthetic number.
    if (digits.length >= 10 && !digits.includes("555")) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: rep,
        reason: "phone number without the 555 fake-exchange convention",
      });
    }
  }
}

function checkCxField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (const rep of value.split(d.repetition)) {
    const comps = rep.split(d.component);
    const id = (comps[0] ?? "").trim();
    const typeCode = (comps[4] ?? "").trim().toUpperCase();
    if (id.length === 0) continue;
    const idUpper = id.toUpperCase();
    const isSsnType = typeCode === "SS" || typeCode === "SSN";
    if (isSsnType) {
      if (/^\d{9}$/.test(id) && !allow.ids.has(idUpper)) {
        hits.push({
          path,
          segment: `${segId}-${String(fieldNo)}`,
          value: id,
          reason: "SSN-typed identifier (CX type SS) not in synthetic allow-list",
        });
      }
      continue;
    }
    // A bare 6-9 digit identifier is a real-looking MRN / account number (or a
    // 9-digit SSN dropped in the wrong slot). Synthetic fixtures use prefixed
    // shapes (MRN…, ACCT…, FAKE…), so a bare numeric id is suspect.
    if (/^\d{6,9}$/.test(id) && !allow.ids.has(idUpper)) {
      hits.push({
        path,
        segment: `${segId}-${String(fieldNo)}`,
        value: id,
        reason: "bare-numeric MRN / account identifier not in synthetic allow-list",
      });
    }
  }
}

function checkSsnStField(
  path: string,
  segId: string,
  fieldNo: number,
  value: string,
  allow: AllowList,
  hits: Hit[],
): void {
  const digits = value.replace(/\D/g, "");
  if (/^\d{9}$/.test(digits) && !allow.ids.has(digits.toUpperCase())) {
    hits.push({
      path,
      segment: `${segId}-${String(fieldNo)}`,
      value,
      reason: "SSN (9-digit) not in synthetic allow-list",
    });
  }
}

/**
 * Unknown / `Z…` site-defined segments have no known field schema, so a name
 * could hide in any field. Backstop: within each field, flag an adjacent pair of
 * single-token name-shaped components (`Johnson^Maya`) whose tokens are not
 * allow-listed. Only runs on unknown segments, known code-bearing segments
 * (`OBX`, `OBR`, …) carry `CODE^Description^System` triples that this would
 * misread as names.
 */
function checkUnknownSegment(
  path: string,
  segId: string,
  elems: string[],
  d: Delimiters,
  allow: AllowList,
  hits: Hit[],
): void {
  for (let f = 1; f < elems.length; f += 1) {
    const field = elems[f] ?? "";
    for (const rep of field.split(d.repetition)) {
      const comps = rep.split(d.component);
      const singleToken: (string | null)[] = comps.map((c) => {
        const toks = nameTokens(c, d).filter(isNameToken);
        // A name component is exactly one significant token (family or given).
        return toks.length === 1 && toks[0] !== undefined ? toks[0] : null;
      });
      for (let c = 0; c + 1 < singleToken.length; c += 1) {
        const a = singleToken[c];
        const b = singleToken[c + 1];
        if (a === null || a === undefined || b === null || b === undefined) continue;
        for (const tok of [a, b]) {
          if (!allow.names.has(tok.toUpperCase())) {
            hits.push({
              path,
              segment: `${segId}-${String(f)}`,
              value: tok,
              reason: "person-name token in site-defined segment not in synthetic allow-list",
            });
          }
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shape checks shared by HL7 and plain-text targets
// ---------------------------------------------------------------------------

function scanCommonShapes(path: string, content: string, allow: AllowList, hits: Hit[]): void {
  // Dashed SSN anywhere (covers OBX-5 / NTE free text and non-HL7 targets). The
  // regex is deliberately anchored on \b digit groups so it does not read as a
  // literal SSN to code-scanning tools.
  for (const m of content.matchAll(/\b\d{3}-\d{2}-\d{4}\b/g)) {
    hits.push({ path, segment: "(ssn)", value: m[0], reason: "dashed SSN pattern" });
  }
  // Emails whose domain is not an allow-listed reserved / test domain.
  for (const m of content.matchAll(/\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g)) {
    const domain = (m[1] ?? "").toLowerCase();
    if (!allow.emailDomains.has(domain)) {
      hits.push({ path, segment: "(email)", value: m[0], reason: "email with non-test domain" });
    }
  }
}

// ---------------------------------------------------------------------------
// HL7 message scanner
// ---------------------------------------------------------------------------

function scanHl7(target: Target, text: string, allow: AllowList, hits: Hit[]): void {
  const d = detectDelimiters(text);
  for (const elems of splitSegments(text, d)) {
    // Segment ids are matched case-insensitively, the lenient parser accepts a
    // lowercase `pid`, so the scanner must normalize before every lookup or a
    // mixed-case feed silently escapes the per-field detectors.
    const segId = (elems[0] ?? "").toUpperCase();
    if (segId.length === 0) continue;
    // MSH-style header segments carry only routing metadata + delimiters; the
    // field offset differs and none of the PHI fields live there. Skip them.
    if (segId === "MSH" || segId === "FHS" || segId === "BHS") continue;

    if (!KNOWN_SEGMENTS.has(segId)) {
      checkUnknownSegment(target.path, segId, elems, d, allow, hits);
      continue;
    }

    for (const f of XPN_NAME_FIELDS[segId] ?? []) {
      checkNameField(target.path, segId, f, fieldAt(elems, f), 0, d, allow, hits);
    }
    for (const f of XCN_NAME_FIELDS[segId] ?? []) {
      checkNameField(target.path, segId, f, fieldAt(elems, f), 1, d, allow, hits);
    }
    for (const f of DOB_FIELDS[segId] ?? []) {
      checkDobField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of ADDRESS_FIELDS[segId] ?? []) {
      checkAddressField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of PHONE_FIELDS[segId] ?? []) {
      checkPhoneField(target.path, segId, f, fieldAt(elems, f), d, hits);
    }
    for (const f of CX_ID_FIELDS[segId] ?? []) {
      checkCxField(target.path, segId, f, fieldAt(elems, f), d, allow, hits);
    }
    for (const f of SSN_ST_FIELDS[segId] ?? []) {
      checkSsnStField(target.path, segId, f, fieldAt(elems, f), allow, hits);
    }
  }
  // Cross-cutting shape checks over the whole payload (catches free-text PHI in
  // OBX-5 / NTE that the field map does not model). Runs on the UNWRAPPED payload
  // so an MLLP FS/VT byte can never mask an adjacent dashed-SSN / email match.
  scanCommonShapes(target.path, unwrapMllpFrame(text), allow, hits);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

function scanTarget(target: Target, allow: AllowList, hits: Hit[]): void {
  let buf: Buffer;
  try {
    buf = target.read();
  } catch (err) {
    throw new InvocationError(
      `could not read ${target.path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = buf.toString("utf8");
  if (looksLikeHl7(text, target.path)) {
    scanHl7(target, text, allow, hits);
  } else {
    // Non-HL7 target (hand-written src / test, plain-text notes, non-HL7 binary
    // byte/buffer fixture): conservative shape pass only, no segment model to
    // lean on. Binary noise decoded as utf8 cannot crash this; at worst it emits
    // no hits.
    scanCommonShapes(target.path, text, allow, hits);
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function report(hits: Hit[]): void {
  if (hits.length === 0) {
    process.stdout.write("[phi-scan] OK, no hits\n");
    return;
  }
  const byPath = new Map<string, Hit[]>();
  for (const h of hits) {
    const arr = byPath.get(h.path);
    if (arr) arr.push(h);
    else byPath.set(h.path, [h]);
  }
  for (const [path, group] of byPath) {
    process.stderr.write(`[phi-scan] HIT: ${path}\n`);
    for (const h of group) {
      process.stderr.write(
        `  segment=${h.segment} value=${JSON.stringify(h.value)} (${h.reason})\n`,
      );
    }
  }
  process.stderr.write(
    `[phi-scan] ${String(hits.length)} hit(s) across ${String(byPath.size)} file(s). ` +
      `If a value is genuinely synthetic, declare it in scripts/phi-allow-list.txt OR ` +
      `run with --allow-fixture <path> AND log it in phi-scan-overrides.md.\n`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): number {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
    validateAllowFixtures(args.allowFixtures);
  } catch (err) {
    if (err instanceof InvocationError) {
      process.stderr.write(`[phi-scan] ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  const allow = loadAllowList();
  const allowed = new Set<string>(args.allowFixtures.map(normalizePath));

  let targets: Target[];
  try {
    if (args.mode === "staged") targets = buildTargetsForStaged();
    else if (args.mode === "paths") targets = buildTargetsForPaths(args.paths);
    else targets = buildTargetsForAll();
  } catch (err) {
    if (err instanceof InvocationError) {
      process.stderr.write(`[phi-scan] ${err.message}\n`);
      return 2;
    }
    throw err;
  }

  targets = targets.filter((t) => !allowed.has(t.path));

  const hits: Hit[] = [];
  for (const t of targets) {
    try {
      scanTarget(t, allow, hits);
    } catch (err) {
      if (err instanceof InvocationError) {
        process.stderr.write(`[phi-scan] ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  report(hits);
  return hits.length === 0 ? 0 : 1;
}

process.exit(main());
