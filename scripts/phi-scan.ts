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
 * ENUMERATION: `all` mode lists `test/` + `src/` first and reads each file
 * afterwards, so a file created and removed inside that window makes a read
 * throw `ENOENT` and would refuse a scan the walk could not complete. The
 * REFUSAL was never the problem, the ENUMERATION was, so exactly one case is
 * tolerated, documented on `Target.tolerateVanish`: a file the walk enumerated
 * ITSELF, that git does not track, failing with `ENOENT`. It is reported on
 * stderr as skipped, never silently. Everything else still refuses.
 *
 * Modes:
 *   --staged                 - scan only files staged in `git diff --cached`
 *   --allow-fixture <path>   - bypass one path; rejected unless logged in
 *                              phi-scan-overrides.md
 *   <path> [<path>...]       - scan specific paths
 *   (no args)                - scan all in-scope working-tree files
 *
 * Exit codes: 0 (clean), 1 (hits found), 2 (invocation error).
 *
 * ---------------------------------------------------------------------------
 * AN IN-SCOPE ENTRY THAT IS NOT A REGULAR FILE REFUSES THE SCAN (exit 2). It is
 * never silently skipped, because both enumerating routes were blind to it in a
 * way that read as clean. Measured on `d854e81` with a synthetic name-bearing
 * payload kept outside both walk roots:
 *
 *   - the walk enumerates `Dirent.isFile()`, an lstat answer, so a symbolic
 *     link is neither a file nor a directory and fell out of the loop whatever
 *     it pointed at. `isDirectory()` is an lstat answer too, so a LINKED
 *     DIRECTORY took its whole subtree with it, silently;
 *   - `--staged` read content with `git show :<path>`, and git stores a symbolic
 *     link as its TARGET PATH under mode `120000`, so that route was handed the
 *     path text and never the target's bytes. That route is this repo's
 *     pre-commit gate.
 *
 * A link to that payload under `test/` scanned CLEAN on both (exit 0, "OK, no
 * hits"), and so did a link to its DIRECTORY, while naming the target
 * explicitly exited 1 with every hit. The payload was always detectable; the
 * two routes never looked at it.
 *
 * Neither route follows a link it finds INSIDE a scan root: following would read
 * bytes the enumeration does not control (outside the repo, a loop, a device, a
 * FIFO that blocks the gate forever), and git does not carry those bytes anyway,
 * so a hit on them would be a claim about something no commit contains. Refusing
 * states the only true thing available: there is an entry here the scan cannot
 * account for, so the scan is not clean.
 *
 * ▶ THE ROOT ITSELF IS THE EXCEPTION, AND WRITING "NEITHER ROUTE FOLLOWS A LINK"
 * FLAT WAS FALSE. `walk()` opens `TEST_ROOT` / `SRC_ROOT` with `existsSync` +
 * `readdirSync`, and both FOLLOW, so replacing `test/` or `src/` itself with a
 * link to a directory outside the repo makes the walk read straight through it.
 * PRE-EXISTING. The precise reading, which is NOT "its PHI is reported": the
 * tree beyond the link is scanned exactly as the root it replaced would have
 * been, WITH THAT ROOT'S OWN LIMITS. So a fixture-like payload behind a linked
 * `test/` is reported (measured, exit 1), while the same payload behind a linked
 * `src/` gets only the conservative pass and can read clean, exactly as it would
 * through a real `src/`. It is link-NEUTRAL, which is why it is disclosed here
 * instead of closed: refusing a linked root is a different decision about repo
 * layout, not this defect. Do not restore the flat claim, and do not upgrade
 * this one into a promise that a linked root is always caught.
 *
 * "In scope" is each route's own existing ROOT, not a new boundary: the walk
 * still excludes a gitignored entry (the same rule that already excludes a
 * gitignored file, so links do not get a second, stricter boundary of their
 * own), and `--staged` still only looks under `test/` and `src/`. What is NOT
 * carried over to a non-regular entry is the `.ts` / `.md` NAME exemptions.
 * Those are judgements about a file whose bytes the route could have read (a
 * test `.ts` source carries deliberate violator literals, a `.md` is
 * documentation), and a link's name is no evidence at all about what is on the
 * other side. Dropping them also keeps the two routes agreeing on what they
 * refuse. This narrows what those roots ADMIT; it does not widen the roots.
 *
 * A refusal names the entry's own repo-relative path and an engine-owned token
 * for its kind. IT NEVER REPORTS THE LINK TARGET, which is text off the working
 * tree and can itself carry PHI: a target path of the shape
 * `../captures/<surname>-<given>-<dob>.hl7` is the whole reason. The shape is
 * written out rather than an example, because a diagnostic ABOUT a PHI leak is
 * itself a PHI surface, and that applies to the prose explaining it too.
 *
 * ▶ THREE MORE WAYS AN IN-SCOPE ENTRY REACHED NEITHER ROUTE, ALL MEASURED ON
 * `2252d33` BEFORE ANYTHING WAS TOUCHED, AND THE FIRST TWO ARE AT PRE-COMMIT:
 *
 *   - RENAME AND COPY RECORDS WERE NOT ENUMERATED AT ALL. `R`/`C` carry two
 *     paths and `--diff-filter=AMT` deletes them, so `git mv <link> test/<name>`
 *     staged as `R100` at mode `120000` and `--staged` exited 0 over it, and a
 *     rename that also substituted a real name staged as `R051` and exited 0
 *     over live PID-5 / PID-7 / PID-3. `--no-renames` closes both: the
 *     destination arrives as an ordinary single-path `A`, the source as a `D`
 *     the filter drops. The enumeration is a strict SUPERSET of the previous
 *     one and no record shape changed;
 *   - A REGULAR BLOB STAGED AT EXACTLY `test` OR `src` was in scope for the
 *     REFUSAL above and out of scope for the READ, so nothing looked at it:
 *     exit 0 over the same live values. Both roots' read predicates now admit
 *     the root's own path, and `test` earns the structured scan, because an
 *     entry that REPLACES a root is judged with that root's own limits;
 *   - A WALK ROOT THAT IS NOT A DIRECTORY threw `ENOTDIR` out of `readdirSync`
 *     uncaught, and an uncaught throw exits **1**, the code this contract
 *     reserves for "hits found". A false finding is not the same failure as a
 *     crash and is worse than one, because it is actionable-looking. A dangling
 *     link at a root was the silent half of the same shape: `existsSync`
 *     follows, so the walk returned and the sweep reported OK over the entire
 *     corpus that root stands for. Both refuse now (exit 2); see `walkRoot`.
 *
 * The gitlink (mode `160000`) arm is NOT a hole this closes, and saying so would
 * be false here: `--staged`'s scope already reaches a staged submodule under
 * BOTH roots, and `git show :<path>` on one fails with `bad object`, so the base
 * commit already refused it. What changes is the diagnostic, from an incidental
 * read failure to a named kind. The `.gitignore` note about orphan agent-worktree
 * gitlinks is why the arm is worth keeping legible.
 * ---------------------------------------------------------------------------
 */

import { readFileSync, statSync, lstatSync, existsSync, readdirSync, type Dirent } from "node:fs";
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
// The ROOT'S OWN PATH is admitted as well as the prefix, and it is the one entry
// this filter used to drop while `isUnderScanRoot` below already claimed it. An
// index entry at exactly `test` is never a directory (git records none), so it is
// the corpus root REPLACED by a blob: in scope for the refusal, out of scope for
// the read, and therefore scanned by nothing. Measured on `2252d33`, `--staged`
// exited 0 "OK, no hits" over a staged mode-100644 `test` carrying live PID-5 /
// PID-7 / PID-3 values that the same bytes report under any other name.
function isScannableTestFile(relPath: string): boolean {
  return (
    (relPath === "test" || relPath.startsWith("test/")) &&
    !relPath.endsWith(".ts") &&
    !relPath.endsWith(".md")
  );
}

/** The `src/` half of the same rule, root's own path included for the same reason. */
function isScannableSrcFile(relPath: string): boolean {
  return (relPath === "src" || relPath.startsWith("src/")) && !relPath.endsWith(".md");
}

// The two scan ROOTS. This is the boundary a NON-REGULAR entry is judged against
// on both routes: the extension rules above and in `buildTargetsForStaged` are
// judgements about bytes the route could have read, and a link's name says
// nothing about the other side. See the banner.
//
// The ROOT'S OWN NAME is matched as well as the prefix, and that is not
// symmetry for its own sake: a prefix test alone lets a staged entry named
// exactly `test` or `src` through, which is the one path that REPLACES a walk
// root rather than sitting inside it.
function isUnderScanRoot(relPath: string): boolean {
  return (
    relPath === "test" ||
    relPath === "src" ||
    relPath.startsWith("test/") ||
    relPath.startsWith("src/")
  );
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

/**
 * The `errno` string of a Node system error (`ENOENT`, `EACCES`, ...), or
 * `undefined` for anything else. Narrowed with `in` rather than cast, so a
 * thrown non-error cannot masquerade as a system error.
 */
function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const { code } = err;
  return typeof code === "string" ? code : undefined;
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
  /**
   * Absolute path, set only for a target the walk enumerated itself, so a
   * vanished file can be re-checked once the sweep has finished.
   */
  absPath?: string;
  /**
   * TOCTOU: true only for a file the scanner ENUMERATED ITSELF in `all` mode
   * AND that git does not track. `all` mode lists `test/` + `src/` first and
   * reads each file afterwards, so anything created and removed inside that
   * window makes the read throw `ENOENT`.
   *
   * This repo reaches that window through its OWN suite, which is what makes it
   * different from its sibling parsers. `test/scripts/phi-scan.test.ts` writes
   * live-capture fixtures into `mkdtemp`'d directories under `test/`, which IS
   * a walk root, and removes them again; measured, two such directories exist
   * for about 510 ms each per suite run. A sweep running beside that suite can
   * enumerate one and then fail to read it. (A repo-root build transient such as
   * `tsup.config.bundled_<hash>.mjs` is NOT enumerated here, because neither
   * walk root is the repo root, which is the accident that spared the siblings.
   * Widening a walk root removes it.)
   *
   * Only the ENUMERATION was unsound, never the refusal, so the fix is scoped
   * hard rather than by relaxing what a failed read means:
   *   - a TRACKED file is never tolerated. The committed corpus is what the
   *     gate promises to have observed, so if a tracked file cannot be read
   *     the scan is incomplete and still refuses (exit 2);
   *   - only `ENOENT` is tolerated. `EACCES`, `EISDIR` and friends are not a
   *     file that went away, they are a scan that failed;
   *   - a tolerated file is re-checked after the sweep and reported. If it is
   *     back on disk, the sweep did not observe a file that exists now, so the
   *     run refuses;
   *   - `paths` mode reads what the caller named, and `staged` mode reads blobs
   *     out of the git index (`git show :path`), so neither the CLI nor the
   *     pre-commit gate depends on this at all.
   *
   * RESIDUAL, stated rather than hidden: the re-check is keyed on the PATH the
   * walk enumerated, not on content. An untracked file RENAMED inside the window
   * is `ENOENT` at the old path and was never enumerated under the new one, so
   * its bytes go unscanned under a clean report. It is bounded: the file has to
   * be untracked, so committing it means `git add`, after which it is tracked
   * and untolerable, and pre-commit reads the index either way. Closing it needs
   * a content-addressed sweep, which is a different design, not a wider bound.
   */
  tolerateVanish?: boolean;
}

/**
 * An entry the enumeration reached but cannot scan. Both fields are safe to
 * print: `path` is the entry's own repo-relative path (the same locus every hit
 * already carries) and `kind` is a token from the closed set below. Nothing off
 * the other side of a link is ever recorded here.
 */
interface Unscannable {
  path: string;
  kind: string;
}

/**
 * The predicates a `Dirent` and a `Stats` both answer. Typed structurally so one
 * closed-set describer serves both, without either being cast to the other.
 */
interface EntryKind {
  isSymbolicLink: () => boolean;
  isFIFO: () => boolean;
  isSocket: () => boolean;
  isBlockDevice: () => boolean;
  isCharacterDevice: () => boolean;
}

/**
 * Closed-set, engine-owned description of an entry's kind, or `null` when NONE
 * of the predicates answered. `null` is not "a regular file", it is NO ANSWER,
 * and the caller must resolve it rather than report it. See `walk`.
 */
function nonRegularKind(e: EntryKind): string | null {
  if (e.isSymbolicLink()) return "a symbolic link";
  if (e.isFIFO()) return "a FIFO";
  if (e.isSocket()) return "a socket";
  if (e.isBlockDevice()) return "a block device";
  if (e.isCharacterDevice()) return "a character device";
  return null;
}

/**
 * Describe a path's OWN kind for a refusal, from an `lstat`, so a link is named
 * as a link and nothing on the other side of it is read or reported.
 */
function pathKind(p: string): string {
  let st;
  try {
    st = lstatSync(p);
  } catch {
    return "not a directory";
  }
  if (st.isDirectory()) return "a directory";
  if (st.isFile()) return "a regular file";
  return nonRegularKind(st) ?? "not a directory";
}

/** `true` only when `p` is itself a symbolic link, whatever it resolves to. */
function isSymbolicLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * A scan ROOT that is not a walkable directory REFUSES the scan (exit 2).
 *
 * The root is the one path the walk opens by name rather than reaching through a
 * typed `Dirent`, so it is the one path that can fail to be a directory at all,
 * and both ways of doing that read as clean or worse:
 *
 *   - a root that resolves to a FILE (a regular file at `test`, or a link to
 *     one) threw `ENOTDIR` out of `readdirSync` UNCAUGHT. Node exits **1** on an
 *     uncaught throw, which is the code this contract reserves for "hits found",
 *     so the gate reported a finding it had not made. Measured on `2252d33`;
 *   - a root that is a DANGLING link fails `existsSync`, which follows, so the
 *     walk returned silently and the sweep reported OK over the whole corpus
 *     that root stands for. `observed === 0` does not catch it while the other
 *     root still has files.
 *
 * Reading whatever sits there instead is refused as the remedy: what is missing
 * is a TREE, and one file read in its place would be evidence about that file
 * and not about the corpus it replaced. `staged` mode is a different matter and
 * does read such a blob, because the index has no directories in it to lose: see
 * `isScannableTestFile`.
 *
 * A root that is a link to a DIRECTORY is still followed, exactly as before.
 * That is pre-existing and link-NEUTRAL (the tree beyond it is scanned as the
 * root it replaced would have been, with that root's own limits), it is
 * disclosed in the banner, and re-deciding it is a question about repo layout
 * rather than about this defect.
 */
function walkRoot(root: string, out: string[], unscannable: Unscannable[]): void {
  let st;
  try {
    // statSync FOLLOWS, which is what keeps a linked directory root behaving as
    // it always has. The refusals below are decided on what it resolves TO.
    st = statSync(root);
  } catch (err) {
    if (errorCode(err) !== "ENOENT") {
      throw new InvocationError(
        `could not read the scan root ${normalizePath(root)}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // ENOENT is two different things. An ABSENT root is legitimate (a repo need
    // not have both), and a DANGLING link is a root that IS there and stands for
    // nothing. One lstat tells them apart.
    if (isSymbolicLink(root)) refuseRoot(root);
    return;
  }
  if (!st.isDirectory()) refuseRoot(root);
  walk(root, out, unscannable);
}

function refuseRoot(root: string): never {
  throw new InvocationError(
    `refusing the scan: the scan root ${normalizePath(root)} is ${pathKind(root)}, not a ` +
      `directory, so the walk has no tree to enumerate there. Anything read in its place would ` +
      `be evidence about one entry rather than about the corpus that root stands for. ` +
      `Restore it as a directory, or remove it.`,
  );
}

/**
 * Enumerate a scan root. `Dirent`'s predicates are lstat answers and are not
 * exhaustive: an entry that is neither a directory nor a regular file is
 * collected into `unscannable` rather than dropped, so the caller can refuse
 * instead of reporting clean over it.
 */
function walk(dir: string, out: string[], unscannable: Unscannable[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    // ENOENT: a directory gone between its parent's `readdir` and this one, one
    // phase before the read window `Target.tolerateVanish` documents. It narrows
    // the ENUMERATION, exactly as the `lstat` branch below does, and softens
    // nothing about what a failed READ means.
    if (errorCode(err) === "ENOENT") return;
    // Everything else is a walk that FAILED, and it used to leave the process
    // rather than the function: an uncaught throw exits 1, the code reserved for
    // "hits found". A refusal is exit 2 and names the directory.
    throw new InvocationError(
      `could not enumerate ${normalizePath(dir)}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out, unscannable);
    } else if (e.isFile()) {
      // README/markdown docs may legitimately describe violator values; they
      // are documentation, not fixtures.
      if (e.name.toLowerCase().endsWith(".md")) continue;
      out.push(full);
    } else {
      // Deliberately NOT subject to the `.md` exemption above, nor to the `.ts`
      // exclusion `isScannableTestFile` applies to walked test files. Both are
      // judgements about a file whose bytes the walk could have read; a link's
      // name is no evidence at all about what is on the other side.
      const kind = nonRegularKind(e);
      if (kind !== null) {
        unscannable.push({ path: normalizePath(full), kind });
        continue;
      }
      // EVERY predicate answered false, which is what a `Dirent` looks like when
      // `readdir` returned no type for the entry (`DT_UNKNOWN`, which some
      // filesystems do). That is an ABSENT answer, not evidence of a non-regular
      // entry, and refusing on it would red every sweep on such a filesystem: a
      // gate that refuses with no fix available is a gate someone turns off. One
      // `lstat` turns the guess into an answer. Not reachable on the filesystem
      // this repo is developed and tested on, so it is unpinned, and stated here
      // rather than hidden.
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        // Gone between `readdir` and `lstat`, one phase before the read window
        // `Target.tolerateVanish` documents. An entry that no longer exists was
        // never part of the corpus, so this narrows the ENUMERATION and does not
        // soften what a failed READ means. Anything else is a walk that failed.
        if (errorCode(err) === "ENOENT") continue;
        unscannable.push({ path: normalizePath(full), kind: "not a regular file" });
        continue;
      }
      if (st.isDirectory()) {
        walk(full, out, unscannable);
      } else if (st.isFile()) {
        if (e.name.toLowerCase().endsWith(".md")) continue;
        out.push(full);
      } else {
        unscannable.push({
          path: normalizePath(full),
          kind: nonRegularKind(st) ?? "not a regular file",
        });
      }
    }
  }
}

/**
 * Refuse (exit 2) over entries the enumeration reached and cannot scan. EVERY
 * offender is named, not just the first: a developer who has to re-run the gate
 * once per link learns to distrust it.
 */
function refuseUnscannable(entries: Unscannable[], why: string, remedy: string): void {
  if (entries.length === 0) return;
  const lines = entries.map((u) => `  - ${u.path} (${u.kind})`).join("\n");
  const noun =
    entries.length === 1 ? "entry is not a regular file" : "entries are not regular files";
  throw new InvocationError(
    `refusing the scan: ${String(entries.length)} ${noun}:\n${lines}\n${why} ${remedy}`,
  );
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

/**
 * Every path git tracks, or `null` when git could not answer. `null` means the
 * tolerance above is switched off entirely (fail closed): without the tracked
 * set we cannot tell a transient from committed content.
 *
 * An EMPTY answer counts as no answer for the same reason. `git ls-files` exits
 * 0 with no output for a repo whose index is empty (or removed, which does not
 * raise), and an empty set would make EVERY file untracked, which is the one
 * state in which the tracked-file bound silently stops existing. This repo
 * always tracks files, so there is no legitimate empty case here.
 */
function gitTracked(): Set<string> | null {
  try {
    // SECURITY: array-form execFileSync, no shell. `-z` is NUL-separated and
    // unquoted, so it matches the walk's forward-slash relative paths exactly.
    const out = execFileSync("git", ["ls-files", "-z"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    const tracked = new Set<string>();
    for (const p of out.toString("utf8").split("\0")) {
      if (p.length > 0) tracked.add(p);
    }
    return tracked.size > 0 ? tracked : null;
  } catch {
    return null;
  }
}

function buildTargetsForAll(): Target[] {
  const unscannable: Unscannable[] = [];
  const testFiles: string[] = [];
  walkRoot(TEST_ROOT, testFiles, unscannable);
  const srcFiles: string[] = [];
  walkRoot(SRC_ROOT, srcFiles, unscannable);
  // From test/, keep every data file except .ts sources (dispatched to
  // structured-or-conservative by looksLikeHl7). From src/, keep everything
  // walk() surfaced (hand-written code → conservative pass).
  const files = [
    ...testFiles.filter((abs) => isScannableTestFile(normalizePath(abs))),
    ...srcFiles,
  ];
  // One `git check-ignore` over both lists. An ignored entry is already out of
  // scope for the file route, so applying the same rule to a non-regular entry
  // keeps a single boundary rather than inventing a second, stricter one for
  // links alone.
  const ignored = gitIgnored([...files, ...unscannable.map((u) => u.path)]);

  refuseUnscannable(
    unscannable.filter((u) => !ignored.has(u.path)),
    "The walk can neither read such an entry nor vouch for what is on the other side of it.",
    "Remove it, replace it with a regular file, or (if it is genuinely not part of the " +
      "corpus) untrack it and add it to .gitignore.",
  );

  const tracked = gitTracked();
  return files
    .map((abs) => ({ abs, rel: normalizePath(abs) }))
    .filter(({ rel }) => !ignored.has(rel))
    .map(({ abs, rel }) => ({
      path: rel,
      read: () => readFileSync(abs),
      absPath: abs,
      tolerateVanish: tracked !== null && !tracked.has(rel),
    }));
}

function buildTargetsForPaths(paths: string[]): Target[] {
  return paths.map((p) => {
    const abs = isAbsolute(p) ? p : resolve(REPO_ROOT, p);
    if (!existsSync(abs)) throw new InvocationError(`File not found: ${p}`);
    if (!statSync(abs).isFile()) throw new InvocationError(`Not a regular file: ${p}`);
    return { path: normalizePath(abs), read: () => readFileSync(abs) };
  });
}

/** git's file modes for a regular blob. Every other mode is not a file to read. */
const REGULAR_BLOB_MODES = new Set(["100644", "100755"]);

/** Closed-set, engine-owned description of a git file mode. */
function gitModeKind(mode: string): string {
  if (mode === "120000") return "a symbolic link";
  if (mode === "160000") return "a gitlink (a nested repository)";
  return `a git mode-${mode} entry`;
}

/** `:<srcmode> <dstmode> <srcsha> <dstsha> <status>`, the info half of a `--raw -z` record. */
const RAW_RECORD = /^:(?:\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]\d*$/;

function buildTargetsForStaged(): Target[] {
  let listBuf: Buffer;
  try {
    // SECURITY: array-form execFileSync, no shell. `--raw` rather than
    // `--name-only` because the DESTINATION MODE is the only thing that
    // distinguishes a staged regular file from a staged symbolic link, and
    // `git show :<path>` answers both without complaint.
    //
    // `T` (TYPECHANGE) IS IN THE FILTER, AND LEAVING IT OUT MADE THE MODE CHECK
    // BELOW UNREACHABLE WHENEVER THE FILE BEING REPLACED WAS ALREADY TRACKED.
    // Replacing a TRACKED regular file with a link is not an add and not a
    // modify; git raises it as `T` (`:100644 120000 <sha> <sha> T`), so
    // `--diff-filter=AM` deleted the record before any mode could be read and
    // the hook passed the link green. Measured on git 2.39.5 against a tracked
    // `test/differential/fixtures/*.frame.bin` replaced by a link: with `AM` the
    // raw output for that stage is EMPTY. Typechange carries a single path,
    // exactly like `A` and `M`, so admitting it costs the two-field stride below
    // nothing, and it also scans the reverse typechange (a link replaced by a
    // real file bearing PHI) as the file it became.
    //
    // `--no-renames` FOR THE SAME REASON, AND THE FILTER ALONE WAS NOT ENOUGH.
    // Rename detection is on by default, and `diff.renames` can turn copy
    // detection on as well, so `git mv <link> test/<name>` staged as
    // `:120000 120000 <sha> <sha> R100` with TWO paths, which `--diff-filter=AMT`
    // then deleted outright: an ordinary `git mv` put a mode-120000 entry under a
    // scan root and this route printed "OK, no hits" (measured on `2252d33`, exit
    // 0). A rename that ALSO substitutes a real name staged as `R051` and went the
    // same way, with live PID-5 / PID-7 / PID-3 values in the destination blob.
    // Turning detection off makes the destination arrive as an ordinary
    // single-path `A` (`:000000 120000 0000000 <sha> A`) and the source a `D` the
    // filter drops. It needs NO two-path record shape and no scope decision, and
    // it makes the two-field stride below STRUCTURAL rather than conditional: with
    // detection off git cannot emit an `R` or a `C` whatever the caller's
    // `diff.renames` is set to. Verified here under `diff.renames` = `true`,
    // `copies`, `false` and `1`, and under `diff.renameLimit=1`: every stage
    // yields single-path records and the enumeration is a strict superset of the
    // previous one.
    listBuf = execFileSync(
      "git",
      ["diff", "--cached", "--raw", "-z", "--no-renames", "--diff-filter=AMT"],
      {
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (err) {
    throw new InvocationError(
      `git diff --cached failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // `--raw -z` emits `<info>\0<path>\0` per record. `R` (rename) and `C` (copy)
  // are the only statuses carrying a SECOND path, and `--no-renames` above means
  // git cannot emit either, so the stride is two fields. The regex still admits a
  // score-suffixed status: if one ever reached here the stride would desync and
  // the next record would fail to parse, which REFUSES, the same outcome as any
  // other unparseable record and the safe one. A record that does not parse
  // REFUSES rather than being skipped: a silently shortened list is exactly the
  // shape this scan must never report clean over.
  //
  // What this route still does NOT enumerate, stated because the boundary is
  // narrower than the path prefix alone: `--diff-filter=AMT` also drops `D` (a
  // deletion has no staged blob to scan) and `U` (an unmerged path has no single
  // one). Both are PRE-EXISTING.
  const fields = listBuf.toString("utf8").split("\0");
  const staged: { path: string; mode: string }[] = [];
  let i = 0;
  while (i < fields.length) {
    const info = fields[i];
    if (info === undefined || info.length === 0) {
      i += 1;
      continue;
    }
    const m = RAW_RECORD.exec(info);
    const mode = m?.[1];
    const path = fields[i + 1];
    if (mode === undefined || path === undefined || path.length === 0) {
      throw new InvocationError(
        "could not read the output of `git diff --cached --raw -z`: unrecognized record. " +
          "Refusing rather than scanning a list that may be short.",
      );
    }
    staged.push({ path, mode });
    i += 2;
  }

  // A NON-REGULAR entry is judged against the route's ROOTS only. The extension
  // rules in the read filter below are judgements about bytes; see the banner.
  refuseUnscannable(
    staged
      .filter((s) => isUnderScanRoot(s.path) && !REGULAR_BLOB_MODES.has(s.mode))
      .map((s) => ({ path: s.path, kind: gitModeKind(s.mode) })),
    "For such an entry `git show :<path>` hands back its target path rather than any content " +
      "(or fails outright), so scanning it would prove nothing about what it points at.",
    "Unstage it, or replace it with a regular file.",
  );

  return (
    staged
      .filter((s) => REGULAR_BLOB_MODES.has(s.mode))
      // Scan the same in-scope set all-mode walks: every test/ data file except
      // .ts sources (they carry deliberate violator literals), plus src/ code.
      // Both predicates admit the ROOT'S OWN PATH, which is the entry the walk
      // cannot have and the index can: see `isScannableTestFile`.
      .filter((s) => isScannableTestFile(s.path) || isScannableSrcFile(s.path))
      .map(({ path: relPath }) => ({
        path: relPath,
        // SECURITY: array-form execFileSync, no shell. `:<path>` is a git pathspec.
        read: (): Buffer =>
          execFileSync("git", ["show", `:${relPath}`], {
            encoding: "buffer",
            stdio: ["ignore", "pipe", "pipe"],
          }),
      }))
  );
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
  // The `test/` disjunct is `isScannableTestFile` itself rather than a second
  // copy of it, so the set that EARNS the structured scan cannot drift from the
  // set that is READ. It carries the root's own name with it: a blob staged at
  // exactly `test` replaced the fixture root, so it is judged with that root's
  // limits, and those include the structured scan. Without this the blob is read
  // and still reports clean, because the conservative pass models no fields (a
  // draft measured exactly that: exit 0 over PID-5 / PID-7 / PID-3).
  const isFixtureLike = path.endsWith(".hl7") || path.endsWith(".bin") || isScannableTestFile(path);
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

/**
 * Scan one target. Returns whether the target's bytes were OBSERVED: `false`
 * means the file was tolerated as gone (see `Target.tolerateVanish`), which the
 * caller reports and counts, never silently discards.
 */
function scanTarget(target: Target, allow: AllowList, hits: Hit[]): boolean {
  let buf: Buffer;
  try {
    buf = target.read();
  } catch (err) {
    // TOCTOU, see `Target.tolerateVanish`: an untracked file the walk enumerated
    // itself may be a transient that was removed before we reached it. Report it
    // as unobserved instead of refusing; every other failure, and any tracked
    // file, still refuses the whole scan.
    if (target.tolerateVanish === true && errorCode(err) === "ENOENT") return false;
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
  return true;
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
  const vanished: Target[] = [];
  let observed = 0;
  for (const t of targets) {
    try {
      if (scanTarget(t, allow, hits)) observed += 1;
      else vanished.push(t);
    } catch (err) {
      if (err instanceof InvocationError) {
        process.stderr.write(`[phi-scan] ${err.message}\n`);
        return 2;
      }
      throw err;
    }
  }

  // A tolerated file is never silent, and the tolerance is only good while the
  // file is still gone: if it is back on disk the sweep skipped something that
  // exists, which is an incomplete scan and refuses like any other.
  if (vanished.length > 0) {
    const back = vanished.filter((t) => t.absPath !== undefined && existsSync(t.absPath));
    if (back.length > 0) {
      process.stderr.write(
        `[phi-scan] could not read ${back.map((t) => t.path).join(", ")}: vanished mid-scan and is ` +
          `present again, so the sweep did not observe it. Re-run with the tree at rest.\n`,
      );
      return 2;
    }
    process.stderr.write(
      // "gone" rather than "deleted": a rename leaves the enumerated path just
      // as absent, and the residual on `Target.tolerateVanish` is about exactly
      // that case, so the line must not assert the file was removed.
      `[phi-scan] skipped ${String(vanished.length)} untracked file(s) gone between ` +
        `enumeration and read: ${vanished.map((t) => t.path).join(", ")}\n`,
    );
  }

  // Refuse a sweep that observed nothing. `all` mode always reaches the committed
  // fixture corpus under `test/`, so zero reads means the enumeration or the tree
  // is wrong, never a clean repo. (`staged` legitimately has nothing to scan when
  // a commit touches only `.ts`/`.md`, and `paths` is bounded by the caller's argv.)
  if (args.mode === "all" && observed === 0) {
    process.stderr.write(
      "[phi-scan] refusing: the all-mode sweep observed no files, so it proves nothing.\n",
    );
    return 2;
  }

  report(hits);
  return hits.length === 0 ? 0 : 1;
}

process.exit(main());
