/**
 * The conformance-statement gate: `docs-content/conformance.md` versus the shipped code.
 *
 * WHY THIS IS A GATE AND NOT A REVIEW CHECKLIST. A conformance statement that drifts from the code
 * is strictly worse than no statement at all, because it is a claim someone else relies on: an
 * integrator reads it, enters its content in a self-declared Product Registry entry, or takes it to
 * a Connectathon, and neither of those is retracted by a later commit here. Every other page in
 * `docs-content/` describes behaviour; that one DECLARES it. So the declaration is checked against
 * the code on every test run, and a conformance behaviour that moves without the page moving in the
 * same change reds here, naming what drifted.
 *
 * WHAT IS CHECKED AGAINST THE CODE, rather than against another document:
 *
 *   1. THE TOLERANCE SET, ON BOTH HALVES OF THE CODEC. The opt-ins the decoder actually accepts,
 *      read off `FrameReaderOptions` in `src/framing/decoder.ts`, must equal the set the page
 *      declares, and the same for `EncoderOptions` in `src/framing/encoder.ts`. Adding a tolerance
 *      and forgetting the page reds, and the message names the opt-in. THE SET IS DERIVED BY
 *      SUBTRACTING A PINNED LIST OF NON-TOLERANCE MEMBERS, NOT BY MATCHING AN `allow*` PREFIX: a
 *      prefix match keys this gate on a naming convention rather than on the option set, and
 *      `strict` is already a member of that interface such a match cannot see. Subtraction fails
 *      closed, because a new member is neither excluded below nor declared on the page. THE ENCODER
 *      HALF IS NOT A COMPLETENESS FLOURISH: the encoder is strict BY DEFAULT and not structurally,
 *      and the guides said otherwise until this gate was written. An opt-in that emits a block a
 *      conformant peer will mis-split is the most consequential thing on the page, so it is declared
 *      and exercised rather than left in a type signature.
 *   2. THE WARNING CODES, twice over. Every code the page names must be a member of the shipped
 *      `WarningCode` union (a code the package CANNOT emit is caught), and each declared tolerance
 *      is then EXERCISED against the real decoder so the code the page pairs with it is the code the
 *      decoder emits. A textual check alone would pass a page that pairs the right code with the
 *      wrong flag.
 *   3. THE PER-ROLE DEFAULTS, read off `SERVER_DEFAULT_FRAMING` in `src/server/server.ts`. That
 *      column is what lets a reviewer tell a deviation the package ships ON from one a deployment
 *      opted into, so it is the column most worth catching a lie in.
 *   4. THE DECLARED OPTION NAMES. Every `@cosyte/mllp` option the page names in its IHE table must
 *      exist as a declared property in `src/`. A renamed option reds and is named.
 *   5. THE VERSION. The release the page declares must be `package.json`'s. `scripts/sync-version.mjs`
 *      rewrites the line during `pnpm run version`, exactly as it already rewrites the `VERSION`
 *      export, so a release does not red here and a hand-edit does.
 *   6. THE MULTI-MESSAGE REFUSALS, ROUTE BY ROUTE. Both acknowledgement-building routes are run
 *      against a batch envelope and against two concatenated messages, and the disposition each one
 *      actually returns must be the disposition the page declares for that cell. THIS IS THE MOST
 *      LOAD-BEARING CHECK ON THE PAGE and it is the one that was missing: the two routes do NOT
 *      agree (the raw builder detects both shapes, the parser-backed builder detects only the batch
 *      envelope), and a single sentence covering both roles asserted a refusal one of them does not
 *      perform. A reviewer who reads a refusal does not add a guard above the library, so an
 *      overstatement here is the one on this page with a clinical failure mode.
 *
 * WHAT IS CHECKED AS SHAPE, because it has no code to check against: the verdict vocabulary is
 * closed at three mutually exclusive words, every acknowledgement mode carries a separate client and
 * server verdict, every IHE option carries an actor and a transaction and appears in the
 * supplied-versus-actor split, no option is recorded as claimed, and every `Unverified` verdict
 * anywhere on the page is listed with its reason. Those are the properties that keep the page from
 * quietly becoming an overstatement, and none of them is expressible as a comparison against `src/`.
 *
 * ITI TF-2 OPTION SPELLINGS ARE PINNED AS CONSTANTS HERE, transcribed from the published text, and
 * asserted CASE-EXACT across the whole of `docs-content/`. A Product Registry entry is recorded
 * against the published wording, so "TLS 1.2 Floor" and "TLS 1.2 floor" are not interchangeable, and
 * the documentation set must not carry two spellings of one option name. The scan normalizes
 * whitespace first, because the guides wrap the name across lines.
 *
 * FIXTURES ARE SYNTHETIC AND CARRY NO PATIENT DATA, real or realistic, deliberately: this file sits
 * under a PHI-scan walk root. The framing fixtures are single ASCII letters. The two multi-message
 * fixtures needed by check 6 are bare `MSH` header lines with single-letter application and facility
 * names and no `PID` segment at all, because the shapes being detected are "a batch envelope" and "a
 * second `MSH`", and neither needs a message body to exist.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildMllpAck } from "../../src/ack-from-hl7/build.js";
import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { FrameReaderOptions, WarningCode } from "../../src/index.js";
import { buildRawAck } from "../../src/server/ack.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS_DIR = join(ROOT, "docs-content");
const STATEMENT_PATH = join(DOCS_DIR, "conformance.md");

const STATEMENT = readFileSync(STATEMENT_PATH, "utf8");

/** The three verdict words the statement is allowed to use, and nothing else. */
const VERDICTS = ["Supported", "Not supported", "Unverified"] as const;
type Verdict = (typeof VERDICTS)[number];

/**
 * The acknowledgement modes the statement must cover, each with a client verdict and a server
 * verdict. Original mode, both halves of the enhanced-mode exchange, the MLLP Release 2 commit
 * acknowledgement and the batch acknowledgement: the five a reviewer asks about.
 */
const REQUIRED_ACK_MODES = [
  "Original mode",
  "Enhanced mode, accept acknowledgement",
  "Enhanced mode, application acknowledgement",
  "MLLP Release 2 commit acknowledgement",
  "Batch acknowledgement",
] as const;

/**
 * IHE option names transcribed from the published text, case-exact.
 *
 * ITI-19 sections 3.19.6.2.3, 3.19.8 and 3.19.6.1.4; ITI-30 section 3.30.4.4. Note the lowercase
 * "floor" in the first: the published heading reads "STX: TLS 1.2 floor using BCP195 Option".
 */
const ITI_OPTION_SPELLINGS = [
  "STX: TLS 1.2 floor using BCP195 Option",
  "STX: No Secure Transport",
  "FQDN Validation of Server Certificate Option",
  "Acknowledgement Support Option",
] as const;

// ---------------------------------------------------------------------------
// Markdown reading
// ---------------------------------------------------------------------------

/** Split one markdown table row into trimmed cells, dropping the leading and trailing pipes. */
function splitRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutLead = trimmed.startsWith("|") ? trimmed.slice(1) : trimmed;
  const body = withoutLead.endsWith("|") ? withoutLead.slice(0, -1) : withoutLead;
  return body.split("|").map((cell) => cell.trim());
}

interface Table {
  readonly header: string[];
  readonly rows: string[][];
}

/**
 * The first markdown table under the given heading.
 *
 * Throws rather than returning empty when the heading or the table is missing: a gate that silently
 * finds nothing to check is the failure mode this whole file exists to avoid.
 */
function tableUnder(heading: string): Table {
  const lines = STATEMENT.split("\n");
  const headingAt = lines.findIndex(
    (line) => line.startsWith("#") && line.replace(/^#+\s*/, "").trim() === heading,
  );
  if (headingAt === -1) {
    throw new Error(
      `docs-content/conformance.md has no heading "${heading}". The gate reads its tables by ` +
        `heading, so renaming one silently removes a check; rename it here in the same change.`,
    );
  }

  let i = headingAt + 1;
  while (i < lines.length) {
    const line = (lines[i] ?? "").trim();
    if (line.startsWith("|")) break;
    if (line.startsWith("#")) {
      throw new Error(`docs-content/conformance.md has no table under the heading "${heading}".`);
    }
    i += 1;
  }

  const block: string[] = [];
  while (i < lines.length && (lines[i] ?? "").trim().startsWith("|")) {
    block.push(lines[i] ?? "");
    i += 1;
  }
  const header = block[0];
  if (header === undefined || block.length < 3) {
    throw new Error(`docs-content/conformance.md table under "${heading}" has no data rows.`);
  }
  return { header: splitRow(header), rows: block.slice(2).map(splitRow) };
}

/** Cell text with markdown emphasis and backticks stripped, for comparing against a plain name. */
function plain(cell: string): string {
  return cell.replace(/[`*]/g, "").trim();
}

/** The single backticked token in a cell, or `null` when the cell declares no identifier. */
function backticked(cell: string): string | null {
  const match = /`([^`]+)`/.exec(cell);
  return match?.[1] ?? null;
}

/** Every backticked token in a cell, for a column that may declare more than one code. */
function allBackticked(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

/** Every `.md` file in the published documentation set, keyed by filename. */
function docsContentFiles(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(DOCS_DIR).sort()) {
    if (!entry.endsWith(".md")) continue;
    out.set(entry, readFileSync(join(DOCS_DIR, entry), "utf8"));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the shipped code
// ---------------------------------------------------------------------------

function readSource(...parts: string[]): string {
  return readFileSync(join(ROOT, "src", ...parts), "utf8");
}

/**
 * The text of a top-level declaration, from its opener to the first `}` in column zero.
 *
 * Brace counting is deliberately not used: the doc comments inside these declarations carry fenced
 * TypeScript examples full of braces, but never one in column zero, and prettier guarantees the
 * closing brace of a top-level declaration is there.
 */
function declarationBlock(source: string, opener: string, where: string): string {
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(
      `${where} no longer contains \`${opener}\`. The conformance statement is derived from it, ` +
        `so update this gate and the statement in the same change as the rename.`,
    );
  }
  const rest = source.slice(start);
  const end = rest.search(/^\}/m);
  if (end === -1) throw new Error(`${where}: \`${opener}\` has no closing brace in column zero.`);
  return rest.slice(0, end);
}

/**
 * Members of `FrameReaderOptions` that are NOT framing tolerances, each with the reason.
 *
 * The tolerance set is derived by SUBTRACTING this list from the interface's members. Matching an
 * `allow*` prefix instead would key this gate on a naming convention rather than on the option set:
 * `strict` is already a member of that interface a prefix match cannot see, and a future framing
 * option not spelled `allow*` would move what the decoder tolerates without reddening anything.
 * Subtraction fails closed, because a new member is neither named here nor declared on the page, and
 * the check below refuses if a member named here stops existing, so this list cannot rot quietly.
 */
const NON_TOLERANCE_DECODER_MEMBERS: Readonly<Record<string, string>> = {
  onFrame: "a delivery callback, not a framing behaviour",
  onWarning: "a diagnostic callback, not a framing behaviour",
  maxFrameSizeBytes: "a bound that always throws MLLP_FRAME_TOO_LARGE; it tolerates nothing",
  strict: "the escalation rather than a tolerance: it takes every opt-in back to a throw",
};

/** The same partition for the encoder half. */
const NON_TOLERANCE_ENCODER_MEMBERS: Readonly<Record<string, string>> = {
  onWarning: "a diagnostic callback, not a framing behaviour",
};

/** Every member the given options interface declares, tolerance or not. */
function declaredMembers(file: string, opener: string, where: string): string[] {
  const parts = file.split("/");
  const block = declarationBlock(readSource(...parts), opener, where);
  const found = [...block.matchAll(/^ {2}([A-Za-z][A-Za-z0-9]*)\??:/gm)].map((m) => m[1] ?? "");
  const members = [...new Set(found)].sort();
  if (members.length === 0) {
    throw new Error(
      `${where}: \`${opener}\` parsed to zero members. The conformance statement's tolerance set ` +
        `is derived from it, so a gate that found nothing here would check nothing.`,
    );
  }
  return members;
}

const DECODER_OPTIONS = {
  file: "framing/decoder.ts",
  opener: "export interface FrameReaderOptions {",
  excluded: NON_TOLERANCE_DECODER_MEMBERS,
} as const;

const ENCODER_OPTIONS = {
  file: "framing/encoder.ts",
  opener: "export interface EncoderOptions {",
  excluded: NON_TOLERANCE_ENCODER_MEMBERS,
} as const;

type OptionsInterface = typeof DECODER_OPTIONS | typeof ENCODER_OPTIONS;

/** Every member of an options interface that is not on its pinned non-tolerance list. */
function shippedTolerances(iface: OptionsInterface): string[] {
  const where = `src/${iface.file}`;
  const excluded = new Set(Object.keys(iface.excluded));
  return declaredMembers(iface.file, iface.opener, where).filter((m) => !excluded.has(m));
}

/** The tolerance opt-ins `FrameReaderOptions` actually accepts, read off the decoder. */
function shippedToleranceOptions(): string[] {
  return shippedTolerances(DECODER_OPTIONS);
}

/** The encoder-side opt-ins `EncoderOptions` accepts. */
function shippedEncoderOptions(): string[] {
  return shippedTolerances(ENCODER_OPTIONS);
}

/** The stable warning codes the shipped `WarningCode` union declares. */
function shippedWarningCodes(): string[] {
  const source = readSource("framing", "registry.ts");
  const start = source.indexOf("export type WarningCode =");
  if (start === -1) {
    throw new Error("src/framing/registry.ts no longer declares `export type WarningCode =`.");
  }
  const end = source.indexOf(";", start);
  const block = source.slice(start, end === -1 ? undefined : end);
  return [...block.matchAll(/"(MLLP_[A-Z0-9_]+)"/g)].map((m) => m[1] ?? "").sort();
}

/** The framing defaults `MllpServer` applies to every accepted connection. */
function shippedServerFramingDefaults(): Map<string, boolean> {
  const block = declarationBlock(
    readSource("server", "server.ts"),
    "const SERVER_DEFAULT_FRAMING",
    "src/server/server.ts",
  );
  const out = new Map<string, boolean>();
  for (const m of block.matchAll(/^ {2}(allow[A-Za-z0-9]*): (true|false),/gm)) {
    out.set(m[1] ?? "", m[2] === "true");
  }
  return out;
}

/** Every property name declared anywhere under `src/`, for checking a named package option exists. */
function shippedPropertyNames(): Set<string> {
  const out = new Set<string>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.endsWith(".ts")) continue;
      const source = readFileSync(full, "utf8");
      for (const m of source.matchAll(/^ {2,6}(?:readonly )?([A-Za-z_$][\w$]*)\??: /gm)) {
        out.add(m[1] ?? "");
      }
    }
  };
  walk(join(ROOT, "src"));
  return out;
}

function packageVersion(): string {
  const raw: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  if (typeof raw !== "object" || raw === null || !("version" in raw)) {
    throw new Error("package.json did not parse to an object with a `version` field");
  }
  const { version } = raw;
  if (typeof version !== "string") throw new Error("package.json `version` is not a string");
  return version;
}

// ---------------------------------------------------------------------------
// Exercising a declared tolerance against the real decoder
// ---------------------------------------------------------------------------

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;
const LF = 0x0a;
const SP = 0x20;
const A = 0x41; // a payload byte that is not a framing byte and not part of any HL7 segment id

/**
 * One synthetic byte stream per tolerance opt-in, chosen to exercise exactly that deviation.
 *
 * The map's keys are asserted equal to the shipped tolerance set below, so a new opt-in cannot be
 * added to the decoder and quietly skipped here.
 */
const TOLERANCE_FIXTURES: Record<string, readonly number[]> = {
  // <FS> followed by the next frame's <VT>, with no <CR> closing the first frame.
  allowFsOnly: [VT, A, FS, VT, A, FS, CR],
  // <FS> followed by <LF> where a <CR> is required.
  allowLfAfterFs: [VT, A, FS, LF],
  // padding before the frame-opening <VT>.
  allowLeadingWhitespace: [SP, VT, A, FS, CR],
  // content where the frame-opening <VT> should be.
  allowMissingLeadingVt: [A, FS, CR],
};

interface DecodeOutcome {
  readonly warningCodes: string[];
  readonly threw: MllpFramingError | null;
}

/** Push one fixture through a `FrameReader` built with the given tolerance setting. */
function decodeWith(bytes: readonly number[], options: Partial<FrameReaderOptions>): DecodeOutcome {
  const warningCodes: string[] = [];
  const reader = new FrameReader({
    onFrame: () => {},
    onWarning: (w: { code: WarningCode }) => warningCodes.push(w.code),
    ...options,
  });
  try {
    reader.push(Buffer.from(bytes));
  } catch (err) {
    if (err instanceof MllpFramingError) return { warningCodes, threw: err };
    throw err;
  }
  return { warningCodes, threw: null };
}

// ---------------------------------------------------------------------------
// Exercising both acknowledgement-building routes against a multi-message frame
// ---------------------------------------------------------------------------

/**
 * An `FHS`/`BHS` batch envelope wrapping one message (HL7 v2.5.1 section 2.10.3).
 *
 * Synthetic: single-letter application and facility names, a fixed timestamp, and no `PID` segment.
 * The shape being detected is the envelope itself, so the fixture needs no message body.
 */
const BATCH_ENVELOPE =
  "FHS|^~\\&|A|B\rBHS|^~\\&|A|B\r" +
  "MSH|^~\\&|A|B|C|D|20260424120000||ADT^A01|MSG001|P|2.5\r" +
  "BTS|1\rFTS|1\r";

/** Two complete messages concatenated into one frame, the other multi-message shape. Synthetic. */
const CONCATENATED_TWO_MSH =
  "MSH|^~\\&|A|B|C|D|20260424120000||ADT^A01|MSG001|P|2.5\r" +
  "MSH|^~\\&|A|B|C|D|20260424120000||ADT^A01|MSG002|P|2.5\r";

/** The two multi-message shapes, in the column order the page's route table declares them. */
const MULTI_MESSAGE_SHAPES = [BATCH_ENVELOPE, CONCATENATED_TWO_MSH] as const;

/** What one acknowledgement-building route did with a requested positive `AA`. */
interface AckOutcome {
  /** The disposition MSA-1 actually carries. */
  readonly code: string;
  /** Warning codes the route reported, if it has a warning channel at all. */
  readonly warningCodes: readonly string[];
}

/** The two positive dispositions of HL7 Table 0008: the ones a multi-message frame must not draw. */
const POSITIVE_DISPOSITIONS = new Set(["AA", "CA"]);

/**
 * The page's declared word for an outcome, derived from the outcome itself.
 *
 * A non-positive answer is a refusal however it is spelled; a positive one is the route failing to
 * detect the shape, which is the honest word for it and the one the page has to use.
 */
function classifyOutcome(outcome: AckOutcome): string {
  return POSITIVE_DISPOSITIONS.has(outcome.code) ? "Not detected" : "Refused";
}

/**
 * One probe per acknowledgement-building route, keyed by the identifier the page's route table
 * names it with, so a route the page adds or renames without a probe here reds.
 */
const ROUTE_PROBES: Readonly<Record<string, (payload: Buffer) => AckOutcome>> = {
  // The raw builder behind `autoAck`. It has no warning channel of its own: the server reports a
  // downgrade through its `'nack'` event, not through the returned bytes.
  autoAck: (payload) => {
    const wire = buildRawAck(payload, "AA").toString("latin1");
    const msa = /MSA\|([A-Z]{2})/.exec(wire);
    return { code: msa?.[1] ?? "", warningCodes: [] };
  },
  "@cosyte/mllp/ack-from-hl7": (payload) => {
    const ack = buildMllpAck(payload, { code: "AA" });
    return { code: ack.code, warningCodes: ack.warnings.map((w) => w.code) };
  },
};

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

describe("conformance statement", () => {
  describe("framing tolerances", () => {
    const table = tableUnder("Framing tolerances");
    const declared = table.rows.map((row) => ({
      option: backticked(row[0] ?? "") ?? "",
      deviation: row[1] ?? "",
      code: backticked(row[2] ?? "") ?? "",
      readerDefault: row[3] ?? "",
      serverDefault: row[4] ?? "",
    }));

    it("declares exactly the tolerance opt-ins the decoder accepts", () => {
      const shipped = shippedToleranceOptions();
      const stated = declared.map((d) => d.option).sort();

      const undeclared = shipped.filter((o) => !stated.includes(o));
      const stale = stated.filter((o) => !shipped.includes(o));
      expect(
        undeclared,
        `the decoder accepts tolerance opt-in(s) the conformance statement does not declare: ` +
          `${undeclared.join(", ")}. Add a row to "Framing tolerances" in ` +
          `docs-content/conformance.md in this change.`,
      ).toStrictEqual([]);
      expect(
        stale,
        `the conformance statement declares tolerance opt-in(s) the decoder no longer accepts: ` +
          `${stale.join(", ")}. Remove the stale row from "Framing tolerances" in ` +
          `docs-content/conformance.md in this change.`,
      ).toStrictEqual([]);
      expect(stated).toStrictEqual(shipped);
    });

    it("derives the tolerance set from the option set, not from a naming convention", () => {
      // The pinned non-tolerance list is the whole of what keeps this gate off an `allow*` prefix
      // match. If a member named there is renamed or removed, the subtraction starts reporting it
      // as an undeclared tolerance (or, worse, stops excluding something it should); either way the
      // list has to be re-judged against the interface rather than silently carried.
      for (const iface of [DECODER_OPTIONS, ENCODER_OPTIONS]) {
        const where = `src/${iface.file}`;
        const members = declaredMembers(iface.file, iface.opener, where);
        const excluded = Object.keys(iface.excluded).sort();
        const gone = excluded.filter((m) => !members.includes(m));
        expect(
          gone,
          `${where} no longer declares ${gone.join(", ")}, which this gate excludes from the ` +
            `tolerance set. Re-judge the exclusion against the interface and update the ` +
            `conformance statement in the same change.`,
        ).toStrictEqual([]);
      }
    });

    it("names only warning codes the shipped package can emit", () => {
      const shipped = shippedWarningCodes();
      for (const { option, code } of declared) {
        expect(
          shipped.includes(code),
          `the conformance statement pairs \`${option}\` with the warning code \`${code}\`, which ` +
            `is not a member of the shipped WarningCode union in src/framing/registry.ts. The ` +
            `package cannot emit it.`,
        ).toBe(true);
      }
    });

    it("has a fixture for every declared tolerance", () => {
      // Without this the two behavioural cases below would silently skip a new opt-in.
      expect(Object.keys(TOLERANCE_FIXTURES).sort()).toStrictEqual(
        declared.map((d) => d.option).sort(),
      );
    });

    it("emits, for each declared tolerance, the code the statement declares for it", () => {
      for (const { option, code } of declared) {
        const fixture = TOLERANCE_FIXTURES[option] ?? [];
        const { warningCodes, threw } = decodeWith(fixture, { [option]: true });
        expect(
          threw,
          `with \`${option}\` enabled the decoder threw ${threw?.code ?? ""} instead of ` +
            `tolerating the deviation the conformance statement declares.`,
        ).toBeNull();
        expect(
          warningCodes,
          `the conformance statement declares \`${code}\` for \`${option}\`, but exercising that ` +
            `tolerance emitted [${warningCodes.join(", ")}]. One of the two drifted.`,
        ).toStrictEqual([code]);
      }
    });

    it("throws, for each declared tolerance, when the opt-in is off", () => {
      // This is what makes each row a DEVIATION FROM THE STRICT BLOCK rather than a preference: with
      // the opt-in off the deviation is not tolerated at all.
      for (const { option } of declared) {
        const fixture = TOLERANCE_FIXTURES[option] ?? [];
        const { threw } = decodeWith(fixture, { [option]: false });
        expect(
          threw,
          `the conformance statement declares \`${option}\` as a deviation from the strict block, ` +
            `but with the opt-in off the decoder accepted the deviation without throwing.`,
        ).not.toBeNull();
      }
    });

    it("throws for every declared tolerance when `strict` is on, whatever the opt-in says", () => {
      // The page claims `strict: true` overrides every opt-in above it and that there is no
      // configuration in which these are tolerated more widely than the table says. That is the one
      // sentence on the page that bounds the whole table from above, and it had no assertion behind
      // it, so it could have gone stale without anything noticing.
      for (const { option } of declared) {
        const fixture = TOLERANCE_FIXTURES[option] ?? [];
        const options: Partial<FrameReaderOptions> = { [option]: true, strict: true };
        const { threw } = decodeWith(fixture, options);
        expect(
          threw,
          `the conformance statement says \`strict: true\` overrides every opt-in, but with ` +
            `\`${option}\` enabled AND \`strict\` on the decoder tolerated the deviation. One of ` +
            `the two drifted, and the page is the one a reviewer reads.`,
        ).not.toBeNull();
      }
      expect(
        STATEMENT,
        "the strict-override sentence this case grades is no longer on the page.",
      ).toContain("`strict: true` overrides every opt-in above");
    });

    it("declares the per-role defaults the code applies", () => {
      const serverDefaults = shippedServerFramingDefaults();
      for (const { option, readerDefault, serverDefault } of declared) {
        expect(
          readerDefault,
          `every FrameReaderOptions tolerance defaults to \`false\` (src/framing/decoder.ts), so ` +
            `the standalone-reader default for \`${option}\` must read "off".`,
        ).toBe("off");

        const shippedServer = serverDefaults.get(option) === true;
        expect(
          serverDefault,
          `SERVER_DEFAULT_FRAMING in src/server/server.ts has \`${option}\` ` +
            `${shippedServer ? "on" : "off"}, but the conformance statement declares it ` +
            `"${serverDefault}". A reviewer reads that column to tell a deviation this package ` +
            `ships on from one a deployment opted into.`,
        ).toBe(shippedServer ? "on" : "off");
      }
    });
  });

  describe("encoder deviations", () => {
    const table = tableUnder("Encoder deviations");
    const declared = table.rows.map((row) => ({
      option: backticked(row[0] ?? "") ?? "",
      codes: allBackticked(row[2] ?? ""),
      byDefault: row[3] ?? "",
    }));

    it("declares exactly the encoder opt-ins the encoder accepts", () => {
      // The encoder is strict BY DEFAULT, not structurally. An opt-in that makes it emit a block a
      // conformant peer will mis-split is the single most consequential deviation on this page, so
      // it is declared and gated rather than left in the type signature.
      const shipped = shippedEncoderOptions();
      const stated = declared.map((d) => d.option).sort();
      const undeclared = shipped.filter((o) => !stated.includes(o));
      expect(
        undeclared,
        `the encoder accepts opt-in(s) the conformance statement does not declare: ` +
          `${undeclared.join(", ")}. Add a row to "Encoder deviations" in ` +
          `docs-content/conformance.md in this change.`,
      ).toStrictEqual([]);
      expect(stated).toStrictEqual(shipped);
    });

    it("names only warning codes the shipped package can emit, and declares them off", () => {
      const shipped = shippedWarningCodes();
      for (const { option, codes, byDefault } of declared) {
        expect(codes.length, `no warning code declared for \`${option}\``).toBeGreaterThan(0);
        for (const code of codes) {
          expect(
            shipped.includes(code),
            `the conformance statement pairs \`${option}\` with \`${code}\`, which is not a ` +
              `member of the shipped WarningCode union in src/framing/registry.ts.`,
          ).toBe(true);
        }
        expect(byDefault, `default for \`${option}\``).toBe("off");
      }
    });

    it("exercises the encoder opt-in in both directions", () => {
      // Off: a payload carrying a framing byte is refused. On: it is passed through with a warning,
      // which is the deviation the statement declares.
      const payload = Buffer.from([A, FS, A]);
      expect(() => encodeFrame(payload)).toThrow(MllpFramingError);

      const codes: string[] = [];
      const frame = encodeFrame(payload, {
        allowDelimiterBytesInPayload: true,
        onWarning: (w: { code: WarningCode }) => codes.push(w.code),
      });
      expect(frame[0]).toBe(VT);
      expect(codes).toStrictEqual(["MLLP_PAYLOAD_CONTAINS_FS"]);

      const declaredCodes = declared.flatMap((d) => d.codes);
      for (const code of codes) {
        expect(
          declaredCodes,
          `exercising the encoder opt-in emitted \`${code}\`, which the conformance statement ` +
            `does not declare for it.`,
        ).toContain(code);
      }
    });
  });

  describe("acknowledgement modes", () => {
    const table = tableUnder("Acknowledgement modes");

    it("records a separate client and server verdict for each mode", () => {
      expect(table.header).toStrictEqual(["Acknowledgement mode", "Client role", "Server role"]);
      for (const row of table.rows) {
        const [mode, client, server] = row;
        expect(VERDICTS, `client verdict for "${mode ?? ""}"`).toContain(client);
        expect(VERDICTS, `server verdict for "${mode ?? ""}"`).toContain(server);
      }
    });

    it("covers every acknowledgement mode a reviewer asks about", () => {
      const covered = table.rows.map((row) => plain(row[0] ?? ""));
      for (const mode of REQUIRED_ACK_MODES) {
        expect(
          covered,
          `the conformance statement does not record a verdict for "${mode}".`,
        ).toContain(mode);
      }
    });

    it("records the enhanced-mode application acknowledgement asymmetrically", () => {
      const row = table.rows.find(
        (r) => plain(r[0] ?? "") === "Enhanced mode, application acknowledgement",
      );
      expect(row).toBeDefined();
      // The client waits for and settles on the second acknowledgement; this package's server emits
      // exactly one acknowledgement per inbound message, so the second exchange is the consumer's.
      expect(row?.[1]).toBe("Supported");
      expect(row?.[2]).toBe("Not supported");
      expect(
        STATEMENT,
        "the statement must say that the server emits exactly one acknowledgement per inbound " +
          "message, which is why the application acknowledgement is the consumer's to orchestrate.",
      ).toContain("exactly one acknowledgement per inbound message");
    });

    it("keeps MLLP Release 2 and batch acknowledgement recorded as not supported on both roles", () => {
      for (const mode of ["MLLP Release 2 commit acknowledgement", "Batch acknowledgement"]) {
        const row = table.rows.find((r) => plain(r[0] ?? "") === mode);
        expect(row, `no row for "${mode}"`).toBeDefined();
        expect(row?.[1], `client verdict for "${mode}"`).toBe("Not supported");
        expect(row?.[2], `server verdict for "${mode}"`).toBe("Not supported");
      }
    });

    it("declares the automatic acknowledgement as opt-in, with the starter default the code sets", () => {
      // "The server answers every inbound message" is true only where `autoAck` is set. With it
      // unset the server sends nothing of its own and the handler owns the response, and only the
      // starter server supplies a default. An unqualified sentence here tells a reviewer the
      // package answers when the deployment may have configured it not to.
      const source = readSource("server", "server.ts");
      const starterDefault = /autoAck: opts\.autoAck \?\? "([A-Z]{2})"/.exec(source)?.[1];
      expect(
        starterDefault,
        "src/server/server.ts no longer defaults the starter server's `autoAck`, so the sentence " +
          "the conformance statement carries about it is stale. Update both in this change.",
      ).toBeDefined();
      expect(
        source,
        "src/server/server.ts no longer carries the manual-mode branch the conformance statement " +
          "describes (no `autoAck`, so the handler owns the response).",
      ).toContain("Manual mode: onMessage owns the response via conn.send()");
      expect(
        STATEMENT,
        "the conformance statement must say that with `autoAck` unset the server sends nothing of " +
          "its own, because that is what the code does.",
      ).toContain("with `autoAck` left unset the server sends nothing of its own");
      expect(
        STATEMENT,
        `the starter server defaults \`autoAck\` to \`${starterDefault ?? ""}\`, which is what the ` +
          `conformance statement must declare.`,
      ).toContain(`The starter server sets \`autoAck\` to \`${starterDefault ?? ""}\` for you`);
    });
  });

  describe("batch and concatenated frames", () => {
    const table = tableUnder("Batch and concatenated frames, route by route");

    it("records an outcome for every acknowledgement-building route, on both shapes", () => {
      expect(table.header.map(plain)).toStrictEqual([
        "Acknowledgement route",
        "An FHS/BHS batch envelope",
        "A second MSH in the same frame",
      ]);
      const routes = table.rows.map((row) => backticked(row[0] ?? "") ?? "").sort();
      expect(
        routes,
        "the route table must name exactly the acknowledgement-building routes this gate can " +
          "exercise. A route added to the page with no probe here is a declaration nothing checks, " +
          "and a route dropped from the page is a route a reviewer is never told about.",
      ).toStrictEqual(Object.keys(ROUTE_PROBES).sort());

      // The two route identifiers are real: one is a declared option, one a declared subpath.
      expect(shippedPropertyNames().has("autoAck")).toBe(true);
      const manifest: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
      const exports =
        typeof manifest === "object" && manifest !== null && "exports" in manifest
          ? manifest.exports
          : {};
      expect(
        Object.keys(exports as Record<string, unknown>),
        "the conformance statement names `./ack-from-hl7` as a route a consumer can take, so it " +
          "must still be a declared export of this package.",
      ).toContain("./ack-from-hl7");
    });

    it("declares, for each route and shape, the disposition the shipped package returns", () => {
      // THE CHECK THIS WHOLE SUBSECTION EXISTS FOR. The two routes do not agree, and the page said
      // they did. A reviewer who reads "refused" does not add a concatenation guard above the
      // library, so a refusal claimed for a route that does not perform one is the overstatement on
      // this page with a clinical failure mode: a positive acknowledgement for messages nobody read.
      for (const row of table.rows) {
        const route = backticked(row[0] ?? "") ?? "";
        const probe = ROUTE_PROBES[route];
        if (probe === undefined) throw new Error(`no probe for the route "${route}"`);

        MULTI_MESSAGE_SHAPES.forEach((fixture, index) => {
          const cell = row[index + 1] ?? "";
          const shape = plain(table.header[index + 1] ?? "");
          const stated = plain((cell.split(":")[0] ?? "").trim());
          const observed = probe(Buffer.from(fixture, "latin1"));

          expect(
            classifyOutcome(observed),
            `for "${shape}" the conformance statement declares "${stated}" on the \`${route}\` ` +
              `route, but that route answered \`${observed.code}\`. The statement and the shipped ` +
              `package disagree, and the statement is the one an integrator hands to a reviewer.`,
          ).toBe(stated);

          for (const code of allBackticked(cell).filter((t) => t.startsWith("MLLP_"))) {
            expect(
              observed.warningCodes,
              `the conformance statement says the \`${route}\` route reports \`${code}\` for ` +
                `"${shape}", but exercising it reported [${observed.warningCodes.join(", ")}].`,
            ).toContain(code);
          }

          if (cell.includes("with no warning")) {
            expect(
              observed.warningCodes,
              `the conformance statement says the \`${route}\` route reports no warning for ` +
                `"${shape}". It reported [${observed.warningCodes.join(", ")}], which is better ` +
                `news than the page carries: correct the page in this change.`,
            ).toStrictEqual([]);
          }
        });
      }
    });

    it("points a consumer on the undetected route at the detector the package exports", () => {
      // A named limitation with no remedy beside it is a warning a reader cannot act on. The
      // detector the server's own route applies is exported, so the remedy is one call.
      expect(STATEMENT).toContain("rawAckUncorrelatable");
      expect(
        shippedPropertyNames().has("rawAckUncorrelatable") ||
          readSource("server", "ack.ts").includes("export function rawAckUncorrelatable"),
        "the conformance statement tells a consumer to detect the multi-message shape with " +
          "`rawAckUncorrelatable`, which src/server/ack.ts no longer exports.",
      ).toBe(true);
      expect(
        readSource("index.ts"),
        "`rawAckUncorrelatable` is the remedy the conformance statement names, so it must stay on " +
          "the package's public surface.",
      ).toContain("rawAckUncorrelatable");
    });
  });

  describe("IHE options", () => {
    const options = tableUnder("IHE options");
    const split = tableUnder("What this package supplies, and what stays yours");

    it("records an actor, a transaction and a package option for every option", () => {
      expect(options.header).toStrictEqual([
        "IHE actor",
        "Transaction",
        "Option, as ITI TF-2 spells it",
        "Package option",
        "Client role",
        "Server role",
      ]);
      for (const row of options.rows) {
        const name = row[2] ?? "";
        expect(row[0] ?? "", `IHE actor for "${name}"`).not.toBe("");
        expect(row[1] ?? "", `transaction for "${name}"`).not.toBe("");
        expect(VERDICTS, `client verdict for "${name}"`).toContain(row[4]);
        expect(VERDICTS, `server verdict for "${name}"`).toContain(row[5]);
      }
    });

    it("names only package options the shipped code declares", () => {
      const declaredInSrc = shippedPropertyNames();
      for (const row of options.rows) {
        const option = backticked(row[3] ?? "");
        if (option === null) {
          // `none` is the honest entry for an option no package setting turns on.
          expect(row[3] ?? "", `package option cell for "${row[2] ?? ""}"`).toBe("none");
          continue;
        }
        expect(
          declaredInSrc.has(option),
          `the conformance statement names \`${option}\` as the package option for ` +
            `"${row[2] ?? ""}", but no property of that name is declared under src/. Either the ` +
            `option was renamed and the statement is stale, or the statement names an option that ` +
            `never existed.`,
        ).toBe(true);
      }
    });

    it("splits every option into what this package supplies and what stays the actor's", () => {
      expect(split.header).toStrictEqual([
        "Option",
        "What this package supplies",
        "What the deploying actor must still do",
        "Claimed here",
      ]);
      const listed = options.rows.map((row) => row[2] ?? "").sort();
      const explained = split.rows.map((row) => row[0] ?? "").sort();
      expect(
        explained,
        "every IHE option must appear in the supplied-versus-actor split, and the split must not " +
          "carry an option the options table does not list.",
      ).toStrictEqual(listed);

      for (const row of split.rows) {
        expect(row[1] ?? "", `"what this package supplies" for "${row[0] ?? ""}"`).not.toBe("");
        expect(row[2] ?? "", `"what the actor must still do" for "${row[0] ?? ""}"`).not.toBe("");
      }
    });

    it("names the switch that turns node authentication off, and the code it announces with", () => {
      // D7 asks what a deploying actor must still do before entering an option in a Product
      // Registry statement. "Do not ship with the switch that disables certificate verification" is
      // the sharpest item on that list for a transport-security option, and the reviewer this page
      // is written for is precisely the reader who will not open the TLS guide to find it.
      const actorColumn = split.rows.map((row) => row[2] ?? "").join("\n");
      expect(
        actorColumn,
        "the supplied-versus-actor split must name the client's verification opt-out in the " +
          "column that says what stays the deploying actor's.",
      ).toContain("allowUnverified");
      expect(
        actorColumn,
        "the split must name the security-warning code the opt-out announces itself with, so a " +
          "deployment can evidence its absence from its own logs.",
      ).toContain("MLLP_TLS_VERIFY_DISABLED");
      expect(
        shippedPropertyNames().has("allowUnverified"),
        "the conformance statement names `allowUnverified` as the switch a deploying actor must " +
          "leave off, but no property of that name is declared under src/.",
      ).toBe(true);
      expect(
        readSource("transport", "security-warnings.ts"),
        "the conformance statement names `MLLP_TLS_VERIFY_DISABLED`, which src/transport/" +
          "security-warnings.ts no longer declares.",
      ).toContain('export const MLLP_TLS_VERIFY_DISABLED = "MLLP_TLS_VERIFY_DISABLED"');
    });

    it("records no option as claimed", () => {
      // An IHE option is claimed by an actor about itself. A library supplies a mechanism and
      // produces evidence; it cannot claim on a deployer's behalf, and must not read as if it had.
      for (const row of split.rows) {
        expect(row[3] ?? "", `"claimed here" for "${row[0] ?? ""}"`).toBe("No");
      }
      expect(STATEMENT).toContain("no option below is recorded as claimed");
    });

    it("spells every IHE option exactly as the published text spells it, across the whole set", () => {
      for (const [filename, markdown] of docsContentFiles()) {
        const flat = markdown.replace(/\s+/g, " ");
        for (const spelling of ITI_OPTION_SPELLINGS) {
          const pattern = new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
          for (const match of flat.matchAll(pattern)) {
            expect(
              match[0],
              `docs-content/${filename} spells an IHE option "${match[0]}". A Product Registry ` +
                `entry is recorded against the published wording, so it must read "${spelling}".`,
            ).toBe(spelling);
          }
        }
      }
    });
  });

  describe("unverified behaviours", () => {
    const unverified = tableUnder("Behaviours recorded as unverified");

    it("records each one as unverified, with a reason", () => {
      expect(unverified.header).toStrictEqual([
        "Behaviour",
        "Verdict",
        "Why it is unverified rather than absent",
      ]);
      for (const row of unverified.rows) {
        expect(row[1] ?? "", `verdict for "${row[0] ?? ""}"`).toBe("Unverified");
        expect(row[2] ?? "", `reason for "${row[0] ?? ""}"`).not.toBe("");
      }
      expect(unverified.rows.length).toBeGreaterThan(0);
    });

    it("explains every Unverified verdict the statement carries anywhere", () => {
      // An `Unverified` verdict in the options table with no entry here would hand a reviewer a
      // hedge with no reason attached, which is the shape of an inference passed off as a finding.
      const reasons = unverified.rows.map((row) => plain(row[0] ?? ""));
      for (const row of tableUnder("IHE options").rows) {
        const name = row[2] ?? "";
        if (row[4] !== "Unverified" && row[5] !== "Unverified") continue;
        expect(
          reasons.some((behaviour) => behaviour.includes(name)),
          `"${name}" is recorded Unverified in the IHE options table but has no entry under ` +
            `"Behaviours recorded as unverified", so the reason is nowhere.`,
        ).toBe(true);
      }
    });

    it("uses a closed, mutually exclusive verdict vocabulary", () => {
      const legend = tableUnder("How to read the verdicts");
      expect(legend.rows.map((row) => plain(row[0] ?? ""))).toStrictEqual([...VERDICTS]);
      const words: Verdict[] = [...VERDICTS];
      expect(new Set(words).size).toBe(words.length);
    });
  });

  describe("publication", () => {
    it("declares the version of the package whose behaviour it describes", () => {
      const matches = [...STATEMENT.matchAll(/^\*\*Version declared:\*\* `([^`\n]+)`$/gm)];
      expect(
        matches.length,
        "docs-content/conformance.md must carry exactly one `**Version declared:** `x.y.z`` line. " +
          "scripts/sync-version.mjs rewrites it during `pnpm run version`, so a second one would " +
          "leave a stale release number on a published claim.",
      ).toBe(1);
      expect(
        matches[0]?.[1],
        "the conformance statement declares a different release from package.json. Run " +
          "`node scripts/sync-version.mjs`, which the `version` script already does on release.",
      ).toBe(packageVersion());
    });

    it("is reachable from the documentation navigation", () => {
      // A conformance statement nobody can navigate to is a file in a tree, not a published page.
      const sidebars = readFileSync(join(DOCS_DIR, "sidebars.json"), "utf8");
      expect(
        sidebars,
        'docs-content/sidebars.json does not carry the "conformance" doc id, so the statement ' +
          "would ship unlinked.",
      ).toContain('"conformance"');
    });

    it("identifies itself as a self-declaration and names both published claim routes", () => {
      expect(STATEMENT).toContain("self-declaration");
      expect(STATEMENT).toContain("not** a third-party");
      expect(STATEMENT).toContain("Product Registry");
      expect(STATEMENT).toContain("Connectathon");
      expect(
        STATEMENT,
        "the two claim routes must be distinguished by who did the checking.",
      ).toContain("who did the checking");
    });
  });
});
