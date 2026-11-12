import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { readPrintConfig, samplePrintFindings } from "@cosyte/script-utils/docs-content";
import { describe, expect, it } from "vitest";

/**
 * No example prints a value that identifies a person, or a whole message, frame or payload.
 *
 * The rule, from our docs-content standard: an example shows
 * counts, byte lengths, control ids the example itself made, codes and structure. This package's
 * docs teach what to log from live connections (an `onMessage` handler, an error event, the
 * shutdown report, a debug hook), so what they show is what a reader logs.
 *
 * `pnpm check:docs-content` holds the README and the pages at the top of `docs-content/` to the
 * shared print rule, with this package's names in `cosyte-docs-content.config.json`. This suite
 * holds the rest to it: the runnable scripts in `examples/` and the samples in the TSDoc comments
 * the API reference is generated from. It also reads what the pages show (`// =>` annotations,
 * trailing comments that show a value, and output blocks) for the identifying values the
 * synthetic data carries and for a whole segment, and it holds the "What is safe to log" section
 * of the options page to the fields `src/` declares.
 */
const root = join(import.meta.dirname, "..", "..");
const docsDir = join(root, "docs-content");
const { accessors, wholeValues, printers } = readPrintConfig(root);
const extra = { accessors, wholeValues, printers };

/** The README, the hand-written pages and the examples' README, as `[label, text]`. */
function pages(): [string, string][] {
  const out: [string, string][] = [["README.md", readFileSync(join(root, "README.md"), "utf8")]];
  for (const name of readdirSync(docsDir).sort()) {
    if (name.endsWith(".md")) out.push([name, readFileSync(join(docsDir, name), "utf8")]);
  }
  out.push(["examples/README.md", readFileSync(join(root, "examples", "README.md"), "utf8")]);
  return out;
}

/** Every file under `dir` whose name passes `keep`, recursively, sorted. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((d) => d.isFile() && keep(d.name))
    .map((d) => join(d.parentPath, d.name))
    .sort();
}

/** The `.ts` files of `src/`, tests aside. */
function sourceFiles(): string[] {
  return filesUnder(
    join(root, "src"),
    (name) => name.endsWith(".ts") && !name.endsWith(".test.ts"),
  );
}

/** The runnable scripts at the top of `examples/`. */
function exampleScripts(): string[] {
  const dir = join(root, "examples");
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".ts"))
    .map((d) => join(dir, d.name))
    .sort();
}

interface Sample {
  readonly where: string;
  readonly code: string;
}

/** The fenced samples inside the `/** *\/` comments of a TypeScript text, comment stars removed. */
function commentSamples(label: string, source: string): Sample[] {
  const out: Sample[] = [];
  let body: string[] | undefined;
  let start = 0;
  source.split("\n").forEach((line, i) => {
    const text = /^\s*\*\s?(.*)$/u.exec(line)?.[1];
    if (text === undefined) {
      body = undefined;
      return;
    }
    if (/^\s*```/u.test(text)) {
      if (body === undefined) {
        body = [];
        start = i + 2;
      } else {
        out.push({ where: `${label}:${String(start)}`, code: body.join("\n") });
        body = undefined;
      }
      return;
    }
    body?.push(text);
  });
  return out;
}

function findings(samples: readonly Sample[]): string[] {
  return samples.flatMap((s) =>
    samplePrintFindings(s.code, extra).map(
      (f) => `${s.where} (sample line ${String(f.line)}): ${f.message}`,
    ),
  );
}

describe("no example prints an identifying value or a whole message", () => {
  it("in the runnable scripts in examples/", () => {
    const samples = exampleScripts().map((file) => ({
      where: relative(root, file),
      code: readFileSync(file, "utf8"),
    }));
    expect(samples.length).toBeGreaterThanOrEqual(4);
    const found = findings(samples);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("in the TSDoc samples the API reference is generated from", () => {
    const samples = sourceFiles().flatMap((file) =>
      commentSamples(relative(root, file), readFileSync(file, "utf8")),
    );
    expect(samples.length).toBeGreaterThan(100);
    const found = findings(samples);
    expect(found, found.join("\n")).toEqual([]);
  });

  it("reads a doc-comment sample, so a payload printed in one is found", () => {
    const planted = [
      "/**",
      " * @example",
      " * ```ts",
      " * server.on('message', ({ payload }) => {",
      " *   console.log(payload.toString('latin1'));",
      " * });",
      " * ```",
      " */",
    ].join("\n");
    const samples = commentSamples("planted.ts", planted);
    expect(samples).toEqual([
      {
        where: "planted.ts:4",
        code: "server.on('message', ({ payload }) => {\n  console.log(payload.toString('latin1'));\n});",
      },
    ]);
    expect(findings(samples)).toEqual([expect.stringContaining("planted.ts:4 (sample line 2)")]);
  });

  it.each([
    ["the whole acknowledgment", "logger.info({ ack: ack.toString('utf8') });"],
    ["a raw chunk", "transport.onData((chunk) => console.log('received:', chunk));"],
    ["a control id read off a live event", "client.on('ack', (e) => logger.info(e.controlId));"],
    ["the control id an ACK echoes", "console.log(ack.code, ack.correlationId);"],
    ["a framing error's snippet", "logger.error({ bytes: err.snippet });"],
    ["MSA-2 read off a split MSA segment", "console.log(`MSA-2 ${String(msa?.[2])}`);"],
  ])("holds this package's own names, so %s printed is found", (_what, code) => {
    expect(findings([{ where: "own.ts", code }])).toHaveLength(1);
  });

  it("lets a count, a length and a code through", () => {
    const code = [
      "console.log('received', payload.length, 'bytes from', meta.connectionId);",
      "logger.info({ code: ack.code, latencyMs: e.latencyMs });",
      "logger.warn({ idBytes: err.messageControlIdBytes });",
      'console.log("MSA-2 echoes it:", msa?.[2] === "CTRL0001");',
    ].join("\n");
    expect(findings([{ where: "own.ts", code }])).toEqual([]);
  });
});

/** The text of a `## heading` section of a page, up to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return "";
  const end = text.indexOf("\n## ", start + 4);
  return text.slice(start, end === -1 ? undefined : end);
}

/** The table rows of a text as cells, each cell trimmed, the separator rows left out. */
function rows(text: string): string[][] {
  return text
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[\s|:-]+\|$/u.test(line))
    .map((line) =>
      line
        .slice(1, -1)
        .split(/(?<!\\)\|/u)
        .map((cell) => cell.trim()),
    );
}

/** The row whose first cell names `name` in backticks. */
function rowFor(table: string[][], name: string): string[] | undefined {
  return table.find((cells) => (cells[0] ?? "").includes(`\`${name}\``));
}

/** Every event name `src/` emits, read off the emit calls. */
function emittedEvents(): string[] {
  const names = new Set<string>();
  const emit = /(?:\.emit|_emitContained|safeEmit\(this,|emitSubscriberSafe)\(\s*"(\w+)"/gu;
  for (const file of sourceFiles()) {
    for (const m of readFileSync(file, "utf8").matchAll(emit)) names.add(m[1] ?? "");
  }
  return [...names].sort();
}

/** A TypeScript text with its comments blanked to spaces, strings and templates kept. */
function withoutComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i] ?? "";
    const next = text[i + 1] ?? "";
    if (c === "/" && (next === "/" || next === "*")) {
      const end = next === "/" ? text.indexOf("\n", i) : text.indexOf("*/", i + 2) + 2;
      const stop = end <= 1 || end === -1 ? text.length : end;
      out += text.slice(i, stop).replace(/[^\n]/gu, " ");
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** The keys at the top level of the object literal whose `{` is at `open`. */
function literalKeys(text: string, open: number): string[] {
  const keys: string[] = [];
  let depth = 0;
  let piece = "";
  for (let i = open; i < text.length; i++) {
    const c = text[i] ?? "";
    if ("({[".includes(c)) depth += 1;
    if (")}]".includes(c)) depth -= 1;
    if (depth === 0 || (depth === 1 && c === ",")) {
      const key = /^\s*(\w+)\s*(?::|$)/u.exec(piece)?.[1];
      if (key !== undefined) keys.push(key);
      piece = "";
      if (depth === 0) break;
      continue;
    }
    if (depth === 1 && i !== open) piece += c;
  }
  return keys;
}

/**
 * Every field of every event payload `src/` builds inline where it emits it, as event name to
 * field names: the `error` event's `{ connectionId, error, controlIdBytes }` among them.
 */
function emittedFields(): Map<string, Set<string>> {
  const emit =
    /(?:(?:\.emit|_emitContained|emitSubscriberSafe)\(\s*"(\w+)",|safeEmit\(\s*\w+,\s*"(\w+)",|(?:safeEmitError\(\s*\w+,|_emitErrorIfListened\())\s*Object\.freeze\(\{/gu;
  const out = new Map<string, Set<string>>();
  for (const file of sourceFiles()) {
    const text = withoutComments(readFileSync(file, "utf8"));
    for (const m of text.matchAll(emit)) {
      const event = m[1] ?? m[2] ?? "error";
      const fields = out.get(event) ?? new Set<string>();
      for (const key of literalKeys(text, m.index + m[0].length - 1)) fields.add(key);
      out.set(event, fields);
    }
  }
  return out;
}

/** Every error class the published entry points export. */
function exportedErrors(): string[] {
  const names = new Set<string>();
  for (const entry of ["index.ts", join("ack-from-hl7", "index.ts")]) {
    const text = readFileSync(join(root, "src", entry), "utf8");
    for (const m of text.matchAll(/\b(Mllp\w*Error)\b/gu)) names.add(m[1] ?? "");
  }
  return [...names].sort();
}

/** The public fields of a class or an interface declared in `src/`, `name` aside. */
function declaredFields(kind: "class" | "interface", name: string): string[] {
  const head = new RegExp(`export ${kind} ${name}\\b[^{]*\\{\\n`, "u");
  for (const file of sourceFiles()) {
    const text = readFileSync(file, "utf8");
    const m = head.exec(text);
    if (!m) continue;
    const start = m.index + m[0].length;
    const body = text.slice(start, text.indexOf("\n}", start));
    const fields = [...body.matchAll(/^ {2}(?:override )?readonly (\w+)\??[:=]/gmu)]
      .map((f) => f[1] ?? "")
      .filter((f) => f !== "name");
    return fields;
  }
  throw new Error(`no ${kind} ${name} in src/`);
}

describe("What is safe to log", () => {
  const text = section(
    readFileSync(join(docsDir, "options-and-events.md"), "utf8"),
    "What is safe to log",
  );
  const table = rows(text);

  it("exists, with a table", () => {
    expect(text).not.toBe("");
    expect(table.length).toBeGreaterThan(20);
  });

  it("names every event the source emits", () => {
    const events = emittedEvents();
    expect(events).toContain("message");
    expect(events).toContain("ack");
    expect(
      events.filter((event) => !table.some((cells) => (cells[0] ?? "").includes(`\`${event}\``))),
    ).toEqual([]);
  });

  it("names every field of every event payload the source builds where it emits it", () => {
    const fields = emittedFields();
    expect([...(fields.get("error") ?? [])].sort()).toEqual([
      "connectionId",
      "controlIdBytes",
      "error",
    ]);
    const events = rows(text.slice(text.indexOf("### Events"), text.indexOf("### Hooks")));
    const missing: string[] = [];
    for (const [event, keys] of fields) {
      const row = rowFor(events, event);
      const said = (row ?? []).slice(1).join(" ");
      if (said.includes("every field")) continue;
      for (const key of keys) if (!said.includes(`\`${key}\``)) missing.push(`${event}.${key}`);
    }
    expect(missing).toEqual([]);
  });

  it("names every exported error with every field it declares", () => {
    const errors = exportedErrors();
    expect(errors.length).toBeGreaterThanOrEqual(13);
    const missing: string[] = [];
    for (const error of errors) {
      const row = rowFor(table, error);
      if (row === undefined) {
        missing.push(error);
        continue;
      }
      const said = row.slice(1).join(" ");
      for (const field of [...declaredFields("class", error), "message"]) {
        if (!said.includes(`\`${field}\``)) missing.push(`${error}.${field}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it.each([
    "MessageMeta",
    "NackEvent",
    "MllpWarning",
    "AckCorrelationWarning",
    "AckModeWarning",
    "CommitAckReport",
    "DifferentialReport",
    "DifferentialExchangeReport",
    "MllpAck",
  ])("names every field of %s", (name) => {
    const row = rowFor(table, name);
    expect(row).toBeDefined();
    const said = (row ?? []).slice(1).join(" ");
    const missing = declaredFields("interface", name).filter((f) => !said.includes(`\`${f}\``));
    expect(missing).toEqual([]);
  });

  it.each([
    ["message", "payload"],
    ["ack", "payload"],
    ["ack", "controlId"],
    ["CommitAckReport", "payload"],
    ["MllpFramingError", "snippet"],
    ["MllpAck", "payload"],
    ["MllpAck", "frame"],
    ["MllpAck", "correlationId"],
  ])("says %s can hold message bytes in %s", (name, field) => {
    const row = rowFor(table, name);
    expect(row?.[1]).toContain(`\`${field}\``);
  });

  it("is not contradicted by a page saying no event payload carries message content", () => {
    const hits: string[] = [];
    for (const [label, page] of pages()) {
      const flat = page.replace(/\s+/gu, " ");
      for (const m of flat.matchAll(/[^.]*\bevent payloads?\b[^.]*/giu)) {
        const sentence = m[0];
        if (!/message content|byte of the payload/iu.test(sentence)) continue;
        if (!sentence.includes("`message`")) hits.push(`${label}: ${sentence.trim()}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

/**
 * The identifying values this repository's synthetic data carries, read from the data and not from
 * the expression that shows them: a shown value is caught however it was reached.
 *
 * The sources are the PHI allow list (`scripts/phi-allow-list.txt`, which declares every synthetic
 * name, birth date, address and bare id), the HL7 and framed fixtures under `test/`, and every HL7
 * segment literal in the pages, the example scripts, `src/`, `bench/` and the test helpers (the
 * differential corpus among them). From a segment it takes the fields that carry a person: ids,
 * names, birth dates, addresses, phones, and the free text of a note or a text observation.
 */
interface Identifying {
  /** Whole words matched case-insensitively: names. */
  words: Set<string>;
  /** Substrings matched exactly: ids, addresses, phones, free text. */
  literals: Set<string>;
  /** Birth dates as `YYYYMMDD`, matched in every written form `datePatterns` builds. */
  dates: Set<string>;
}

/** Which fields of which segment carry a person, by kind, as 1-based field numbers. */
const PERSON_FIELDS: Record<
  string,
  {
    ids?: number[];
    names?: number[];
    xcn?: number[];
    dob?: number[];
    addr?: number[];
    phone?: number[];
  }
> = {
  PID: { ids: [2, 3, 4, 18, 19, 20], names: [5, 6, 9], dob: [7], addr: [11], phone: [13, 14] },
  NK1: { names: [2], addr: [4], phone: [5, 6], dob: [16] },
  MRG: { ids: [1, 2, 3, 4, 5, 6], names: [7] },
  GT1: { ids: [2], names: [3], addr: [5], phone: [6, 7], dob: [8] },
  IN1: { ids: [36], names: [16], dob: [18], addr: [19] },
  PV1: { ids: [19, 50], xcn: [7, 8, 9, 17] },
  ORC: { xcn: [10, 11, 12] },
  OBR: { xcn: [10, 16, 28] },
};

/** HL7 escape sequences, which break a free-text field into the plain runs between them. */
const ESCAPE = /\\[^\\]*\\/gu;

/** The plain runs of a free-text value worth matching: two words or more. */
function freeTextRuns(value: string): string[] {
  const whole = value.replace(ESCAPE, "").replace(/\s+/gu, " ").trim();
  return [...value.split(ESCAPE), whole]
    .map((run) => run.trim())
    .filter((run) => run.length >= 6 && /\S\s+\S/u.test(run));
}

/** Add what one HL7 segment line carries about a person. */
function readSegment(line: string, into: Identifying): void {
  const fields = line.split("|");
  const id = fields[0] ?? "";
  const at = (n: number): string[] => (fields[n] ?? "").split("~").filter((v) => v !== "");
  const addName = (part: string): void => {
    for (const word of part.split(/[&\s]/u)) {
      if (word.length >= 3) into.words.add(word.toLowerCase());
    }
  };
  const spec = PERSON_FIELDS[id];
  if (spec) {
    for (const n of spec.ids ?? []) {
      for (const rep of at(n)) {
        const value = rep.split("^")[0] ?? "";
        if (value.length >= 4) into.literals.add(value);
      }
    }
    for (const n of spec.names ?? []) {
      for (const rep of at(n)) rep.split("^").slice(0, 3).forEach(addName);
    }
    for (const n of spec.xcn ?? []) {
      for (const rep of at(n)) {
        const parts = rep.split("^");
        if ((parts[0] ?? "").length >= 4) into.literals.add(parts[0] ?? "");
        parts.slice(1, 4).forEach(addName);
      }
    }
    for (const n of spec.dob ?? []) {
      for (const rep of at(n)) {
        const digits = /^\d{8}/u.exec(rep);
        if (digits) into.dates.add(digits[0]);
      }
    }
    for (const n of spec.addr ?? []) {
      for (const rep of at(n)) {
        const street = rep.split("^")[0] ?? "";
        if (street.length >= 4) into.literals.add(street);
      }
    }
    for (const n of spec.phone ?? []) {
      for (const rep of at(n)) {
        const parts = rep.split("^");
        for (const part of [parts[0], parts[3], `${parts[5] ?? ""}${parts[6] ?? ""}`]) {
          if (part !== undefined && part.replace(/\D/gu, "").length >= 7) into.literals.add(part);
          else if (part?.includes("@")) into.literals.add(part);
        }
      }
    }
  }
  if (id === "NTE") for (const rep of at(3)) freeTextRuns(rep).forEach((r) => into.literals.add(r));
  if (id === "OBX" && ["ST", "TX", "FT"].includes(fields[2] ?? "")) {
    for (const rep of at(5)) freeTextRuns(rep).forEach((r) => into.literals.add(r));
  }
}

/** A segment line inside source text: a person-bearing or free-text segment id and its fields. */
const SEGMENT_IN_SOURCE = new RegExp(
  `\\b(?:${[...Object.keys(PERSON_FIELDS), "NTE", "OBX"].join("|")})\\|[^"'\`\\r\\n]*`,
  "gu",
);

/** Every identifying value the synthetic data carries. */
function identifying(): Identifying {
  const out: Identifying = { words: new Set(), literals: new Set(), dates: new Set() };
  const allowList = readFileSync(join(root, "scripts", "phi-allow-list.txt"), "utf8");
  for (const line of allowList.split("\n")) {
    const m = /^(NAME|DOB|ADDR|ID) (.+)$/u.exec(line.trim());
    if (!m) continue;
    const [, tag, value = ""] = m;
    if (tag === "NAME" && value.length >= 3) out.words.add(value.toLowerCase());
    if (tag === "DOB" && /^\d{8}$/u.test(value)) out.dates.add(value);
    if (tag === "ADDR" || tag === "ID") out.literals.add(value);
  }
  // Fixtures are bytes: a framed one opens with VT and closes with FS CR, and segments end in CR.
  for (const file of filesUnder(join(root, "test"), (name) => /\.(?:hl7|bin)$/u.test(name))) {
    for (const line of readFileSync(file, "latin1").split(/[\r\n\x0b\x1c]+/u))
      readSegment(line, out);
  }
  const sources = [
    ...pages().map(([, page]) => page),
    ...exampleScripts().map((file) => readFileSync(file, "utf8")),
    ...sourceFiles().map((file) => readFileSync(file, "utf8")),
    ...filesUnder(join(root, "bench"), (name) => name.endsWith(".mjs")).map((file) =>
      readFileSync(file, "utf8"),
    ),
    ...filesUnder(join(root, "test", "_helpers"), (name) => name.endsWith(".ts")).map((file) =>
      readFileSync(file, "utf8"),
    ),
  ];
  for (const source of sources) {
    // Source text, read in one pass: `\\` is one backslash and `\r` ends a segment.
    const code = source.replace(/\\([\\r])/gu, (_, c: string) => (c === "r" ? "\n" : "\\"));
    for (const m of code.matchAll(SEGMENT_IN_SOURCE)) readSegment(m[0], out);
  }
  return out;
}

/** A birth date in the forms a page can show it: HL7, ISO, both slash orders, and its parts. */
function datePatterns(yyyymmdd: string): RegExp[] {
  const [y, mm, dd] = [yyyymmdd.slice(0, 4), yyyymmdd.slice(4, 6), yyyymmdd.slice(6, 8)];
  const [m, d] = [String(Number(mm)), String(Number(dd))];
  return [
    new RegExp(`(?<!\\d)${yyyymmdd}`, "u"),
    new RegExp(`(?<!\\d)${y}-${mm}-${dd}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)0?${m}/0?${d}/${y}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)0?${d}/0?${m}/${y}(?!\\d)`, "u"),
    new RegExp(`(?<!\\d)${y}\\s*,\\s*0?${m}\\s*,\\s*0?${d}(?!\\d)`, "u"),
  ];
}

/**
 * Synthetic names that are also ordinary words a page uses in another sense: "test" a test, "source"
 * a source, "patient" a patient in prose. A shown value holding one of these as a name is still
 * caught by the record number beside it, or by the segment check below.
 */
const ORDINARY_WORDS = new Set([
  "test",
  "patient",
  "source",
  "target",
  "prior",
  "public",
  "child",
  "attend",
  "synth",
]);

/** Whether `value` holds `token` with no word character either side. */
function holdsToken(value: string, token: string): boolean {
  for (let i = value.indexOf(token); i !== -1; i = value.indexOf(token, i + 1)) {
    const before = value[i - 1] ?? "";
    const after = value[i + token.length] ?? "";
    if (!/\w/u.test(before) && !/\w/u.test(after)) return true;
  }
  return false;
}

/** What in a shown value identifies a person, or `[]` when nothing does. */
function findIdentifying(value: string, ids: Identifying, patterns: RegExp[]): string[] {
  const found: string[] = [];
  // A word is a run of letters; `MLLP_FRAME_TOO_LARGE`, a code, is one word.
  for (const word of value.toLowerCase().match(/[\p{L}_]+/gu) ?? []) {
    if (ids.words.has(word) && !ORDINARY_WORDS.has(word)) found.push(word);
  }
  for (const literal of ids.literals) {
    if (holdsToken(value, literal)) found.push(literal);
  }
  for (const p of patterns) if (p.test(value)) found.push(p.source);
  if (/[\w.+-]+@[\w-]+\.[\w.]+/u.test(value)) found.push("email");
  return found;
}

/** A whole segment in a shown value: a segment id and its field separator. */
const SHOWN_SEGMENT = /(?:^|[^A-Za-z0-9])[A-Z][A-Z0-9]{2}\|/u;

/** Info strings of a fence that shows output rather than code. */
const OUTPUT_FENCE = /^(?:|text|console|output)$/u;

/** A plain trailing comment that shows a value after code: `read(x); // "CTRL0001"`. */
const TRAILING_VALUE = /\S\s+\/\/\s+(["[{].*)$/u;

/** Any trailing comment after code: `send(m); // prints MSA|AA|CTRL0001`. */
const TRAILING_COMMENT = /\S\s+\/\/\s?(.*)$/u;

/**
 * Every shown value on the pages, as `[where, value]`: `// =>` annotations, plain trailing comments
 * that show a value, any other trailing comment that holds a whole segment, and output blocks.
 */
function shownValues(from: readonly [string, string][] = pages()): [string, string][] {
  const out: [string, string][] = [];
  for (const [label, text] of from) {
    let fence: string | undefined;
    text.split("\n").forEach((line, i) => {
      const where = `${label}:${String(i + 1)}`;
      const open = /^\s*```(.*)$/u.exec(line);
      if (open) {
        fence = fence === undefined ? ((open[1] ?? "").trim().split(/\s/u)[0] ?? "") : undefined;
        return;
      }
      if (fence === undefined) return;
      const at = line.indexOf("// =>");
      const trailing = TRAILING_VALUE.exec(line);
      if (OUTPUT_FENCE.test(fence)) {
        if (line.trim() !== "") out.push([where, line.trim()]);
      } else if (at !== -1) {
        out.push([where, line.slice(at + "// =>".length).trim()]);
      } else if (trailing) {
        out.push([where, (trailing[1] ?? "").trim()]);
      } else {
        const comment = (TRAILING_COMMENT.exec(line)?.[1] ?? "").trim();
        if (SHOWN_SEGMENT.test(comment)) out.push([where, comment]);
      }
    });
  }
  return out;
}

describe("a shown value", () => {
  const ids = identifying();
  const patterns = [...ids.dates].flatMap(datePatterns);
  const shown = shownValues();

  it("is read from the data and the pages, so the checks cannot pass on nothing", () => {
    expect(ids.words.has("doe")).toBe(true);
    expect(ids.words.has("jane")).toBe(true);
    expect(ids.literals.has("900000001")).toBe(true);
    expect(ids.dates.has("19700101")).toBe(true);
    expect(shown.length).toBeGreaterThan(100);
    expect(shown.some(([where]) => where === "README.md:124")).toBe(true);
  });

  it("is caught holding a planted name, record number, birth date or segment", () => {
    const dob = datePatterns("19700101");
    for (const form of ['"DOE"', '"900000001"', '"19700101"', '"1970-01-01"', "[1970, 1, 1]"]) {
      expect(findIdentifying(form, ids, dob)).not.toEqual([]);
    }
    expect(findIdentifying('"MLLP_FRAME_TOO_LARGE"', ids, dob)).toEqual([]);
    expect(findIdentifying('"CTRL0001"', ids, dob)).toEqual([]);
    expect(SHOWN_SEGMENT.test('"PID|1||900000001^^^FAC^MR"')).toBe(true);
    expect(SHOWN_SEGMENT.test('"MSA|AA|CTRL0001"')).toBe(true);
    expect(SHOWN_SEGMENT.test('"ADT^A01"')).toBe(false);
    expect(SHOWN_SEGMENT.test('"MLLP_ACK_FIFO_MSA1_UNREADABLE"')).toBe(false);
  });

  it("is read from any trailing comment that holds a whole segment", () => {
    const planted = [
      "```ts",
      "await client.send(message); // prints MSA|AA|CTRL0001",
      "await client.close(); // the link drains first",
      "```",
    ].join("\n");
    expect(shownValues([["planted.md", planted]])).toEqual([
      ["planted.md:2", "prints MSA|AA|CTRL0001"],
    ]);
  });

  it("never holds an identifying value from the synthetic data", () => {
    const hits = shown
      .filter(([, value]) => findIdentifying(value, ids, patterns).length > 0)
      .map(([where, value]) => `${where} ${value}`);
    expect(hits).toEqual([]);
  });

  it("is never a whole segment: a page shows a field, a code or a comparison instead", () => {
    const hits = shown
      .filter(([, value]) => SHOWN_SEGMENT.test(value))
      .map(([where, value]) => `${where} ${value}`);
    expect(hits).toEqual([]);
  });
});
