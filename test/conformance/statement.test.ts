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
 *   1. THE TOLERANCE SET, ON BOTH HALVES OF THE CODEC. The `allow*` opt-ins the decoder actually
 *      accepts, read off `FrameReaderOptions` in `src/framing/decoder.ts`, must equal the set the
 *      page declares, and the same for `EncoderOptions` in `src/framing/encoder.ts`. Adding a
 *      tolerance and forgetting the page reds, and the message names the opt-in. THE ENCODER HALF IS
 *      NOT A COMPLETENESS FLOURISH: the encoder is strict BY DEFAULT and not structurally, and the
 *      guides said otherwise until this gate was written. An opt-in that emits a block a conformant
 *      peer will mis-split is the most consequential thing on the page, so it is declared and
 *      exercised rather than left in a type signature.
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
 * All byte fixtures below are synthetic single ASCII letters. There is no HL7 message here, real or
 * realistic, deliberately: this file sits under a PHI-scan walk root.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { FrameReader } from "../../src/framing/decoder.js";
import { encodeFrame } from "../../src/framing/encoder.js";
import { MllpFramingError } from "../../src/framing/error.js";
import type { FrameReaderOptions, WarningCode } from "../../src/index.js";

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

/** The tolerance opt-ins `FrameReaderOptions` actually accepts, read off the decoder. */
function shippedToleranceOptions(): string[] {
  const block = declarationBlock(
    readSource("framing", "decoder.ts"),
    "export interface FrameReaderOptions {",
    "src/framing/decoder.ts",
  );
  const found = [...block.matchAll(/^ {2}(allow[A-Za-z0-9]*)\??:/gm)].map((m) => m[1] ?? "");
  return [...new Set(found)].sort();
}

/** The encoder-side opt-ins `EncoderOptions` accepts. */
function shippedEncoderOptions(): string[] {
  const block = declarationBlock(
    readSource("framing", "encoder.ts"),
    "export interface EncoderOptions {",
    "src/framing/encoder.ts",
  );
  const found = [...block.matchAll(/^ {2}(allow[A-Za-z0-9]*)\??:/gm)].map((m) => m[1] ?? "");
  return [...new Set(found)].sort();
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
